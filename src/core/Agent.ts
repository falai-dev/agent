/**
 * Core Agent implementation
 */

import type { AgentOptions, Term, Guideline, Capability } from "../types/agent";
import type { Event, StateRef } from "../types/index";
import type { RouteOptions } from "../types/route";

import type { SessionState } from "../types/session";
import type { AgentStructuredResponse } from "../types/ai";
import { createSession, enterState, mergeExtracted } from "../types/session";
import { PromptComposer } from "./PromptComposer";

import { Route } from "./Route";
import { State } from "./State";
import { DomainRegistry } from "./DomainRegistry";
import { PersistenceManager } from "./PersistenceManager";
import { RoutingEngine } from "./RoutingEngine";
import { ResponseEngine } from "./ResponseEngine";
import { ToolExecutor } from "./ToolExecutor";
import { getLastMessageFromHistory } from "../utils/event";

/**
 * Main Agent class with generic context support
 */
export class Agent<TContext = unknown> {
  private terms: Term[] = [];
  private guidelines: Guideline[] = [];
  private capabilities: Capability[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private routes: Route<TContext, any>[] = [];
  private domainRegistry = new DomainRegistry();
  private context: TContext | undefined;
  private persistenceManager: PersistenceManager | undefined;
  private routingEngine: RoutingEngine<TContext>;
  private responseEngine: ResponseEngine<TContext>;

  /**
   * Dynamic domain property - populated via addDomain
   */
  public readonly domain: Record<string, Record<string, unknown>> = {};

  constructor(private readonly options: AgentOptions<TContext>) {
    // Validate context configuration
    if (options.context !== undefined && options.contextProvider) {
      throw new Error(
        "Cannot provide both 'context' and 'contextProvider'. Choose one."
      );
    }

    // Initialize context if provided
    this.context = options.context;

    // Initialize routing and response engines
    this.routingEngine = new RoutingEngine<TContext>({
      maxCandidates: 5,
      allowRouteSwitch: true,
      switchThreshold: 70,
    });
    this.responseEngine = new ResponseEngine<TContext>();

    // Initialize persistence if configured
    if (options.persistence) {
      this.persistenceManager = new PersistenceManager(options.persistence);

      // Initialize the adapter if it has an initialize method
      if (options.persistence.adapter.initialize) {
        options.persistence.adapter.initialize().catch((error) => {
          console.error(
            "[Agent] Persistence adapter initialization failed:",
            error
          );
        });
      }
    }

    // Initialize from options
    if (options.terms) {
      this.terms = [...options.terms];
    }

    if (options.guidelines) {
      options.guidelines.forEach((guideline) => {
        this.createGuideline(guideline);
      });
    }

    if (options.capabilities) {
      options.capabilities.forEach((capability) => {
        this.createCapability(capability);
      });
    }

    if (options.routes) {
      options.routes.forEach((routeOptions) => {
        this.createRoute<unknown>(routeOptions);
      });
    }
  }

  /**
   * Get agent name
   */
  get name(): string {
    return this.options.name;
  }

  /**
   * Get agent description
   */
  get description(): string | undefined {
    return this.options.description;
  }

  /**
   * Get agent goal
   */
  get goal(): string | undefined {
    return this.options.goal;
  }

  /**
   * Create a new route (journey)
   * @template TExtracted - Type of data extracted throughout the route
   */
  createRoute<TExtracted = unknown>(
    options: RouteOptions<TExtracted>
  ): Route<TContext, TExtracted> {
    const route = new Route<TContext, TExtracted>(options);
    this.routes.push(route);
    return route;
  }

  /**
   * Create a domain term for the glossary
   */
  createTerm(term: Term): this {
    this.terms.push(term);
    return this;
  }

  /**
   * Create a behavioral guideline
   */
  createGuideline(guideline: Guideline): this {
    const guidelineWithId = {
      ...guideline,
      id: guideline.id || `guideline_${this.guidelines.length}`,
      enabled: guideline.enabled !== false, // Default to true
    };
    this.guidelines.push(guidelineWithId);
    return this;
  }

  /**
   * Add a capability
   */
  createCapability(capability: Capability): this {
    const capabilityWithId = {
      ...capability,
      id: capability.id || `capability_${this.capabilities.length}`,
    };
    this.capabilities.push(capabilityWithId);
    return this;
  }

  /**
   * Add a domain with its tools/methods
   * Automatically tags all ToolRef objects with their domain name for security enforcement
   */
  addDomain<TName extends string, TDomain extends Record<string, unknown>>(
    name: TName,
    domainObject: TDomain
  ): void {
    // Tag all tools in this domain with the domain name for security enforcement
    const taggedDomain = { ...domainObject };
    for (const key in taggedDomain) {
      const value = taggedDomain[key];
      // Check if value is a ToolRef (has handler, id, name properties)
      if (
        value &&
        typeof value === "object" &&
        "handler" in value &&
        "id" in value &&
        "name" in value
      ) {
        // Tag the tool with its domain name
        (value as Record<string, unknown>).domainName = name;
      }
    }

    this.domainRegistry.register(name, taggedDomain);
    // Attach to the domain property for easy access
    this.domain[name] = taggedDomain;
  }

  /**
   * Update the agent's context
   * Triggers the onContextUpdate lifecycle hook if configured
   */
  async updateContext(updates: Partial<TContext>): Promise<void> {
    const previousContext = this.context;

    // Merge updates with current context
    this.context = {
      ...(this.context as Record<string, unknown>),
      ...(updates as Record<string, unknown>),
    } as TContext;

    // Trigger lifecycle hook if configured
    if (this.options.hooks?.onContextUpdate && previousContext !== undefined) {
      await this.options.hooks.onContextUpdate(this.context, previousContext);
    }
  }

  /**
   * Update extracted data in session with lifecycle hook support
   * Triggers the onExtractedUpdate lifecycle hook if configured
   * @internal
   */
  private async updateExtracted<TExtracted = unknown>(
    session: SessionState<TExtracted>,
    extractedUpdate: Partial<TExtracted>
  ): Promise<SessionState<TExtracted>> {
    const previousExtracted = { ...session.extracted };

    // Merge new extracted data
    let newExtracted = {
      ...session.extracted,
      ...extractedUpdate,
    };

    // Trigger lifecycle hook if configured
    if (this.options.hooks?.onExtractedUpdate) {
      const updatedExtracted = (await this.options.hooks.onExtractedUpdate(
        newExtracted,
        previousExtracted
      )) as Partial<TExtracted>;
      newExtracted = updatedExtracted;
    }

    // Return updated session
    return mergeExtracted(session, newExtracted);
  }

  /**
   * Get current context (fetches from provider if configured)
   * @internal
   */
  private async getContext(): Promise<TContext | undefined> {
    // If context provider is configured, use it to fetch fresh context
    if (this.options.contextProvider) {
      return await this.options.contextProvider();
    }

    // Otherwise return the stored context
    return this.context;
  }

  /**
   * Generate a response based on history and context as a stream
   */
  async *respondStream(params: {
    history: Event[];
    state?: StateRef;
    session?: SessionState;
    contextOverride?: Partial<TContext>;
    signal?: AbortSignal;
  }): AsyncGenerator<{
    delta: string;
    accumulated: string;
    done: boolean;
    session?: SessionState;
    toolCalls?: Array<{ toolName: string; arguments: Record<string, unknown> }>;
  }> {
    const { history, contextOverride, signal } = params;

    // Get current context (may fetch from provider)
    let currentContext = await this.getContext();

    // Call beforeRespond hook if configured
    if (this.options.hooks?.beforeRespond && currentContext !== undefined) {
      currentContext = await this.options.hooks.beforeRespond(currentContext);
      // Update stored context with the result from beforeRespond
      this.context = currentContext;
    }

    // Merge context with override
    const effectiveContext = {
      ...(currentContext as Record<string, unknown>),
      ...(contextOverride as Record<string, unknown>),
    } as TContext;

    // Initialize or get session
    let session = params.session || createSession();

    // PHASE 1: TOOL EXECUTION - Execute tools if current state has toolState
    if (session.currentRoute && session.currentState) {
      const currentRoute = this.routes.find(
        (r) => r.id === session.currentRoute?.id
      );
      if (currentRoute) {
        const currentState = currentRoute.getState(session.currentState.id);
        if (currentState) {
          const transitions = currentState.getTransitions();
          const toolTransition = transitions.find((t) => t.spec.toolState);

          if (toolTransition?.spec.toolState) {
            const toolExecutor = new ToolExecutor<TContext, unknown>();
            // Get allowed domains from current route for security enforcement
            const allowedDomains = currentRoute.getDomains();
            const result = await toolExecutor.executeTool(
              toolTransition.spec.toolState,
              effectiveContext,
              this.updateContext.bind(this),
              history,
              session.extracted,
              allowedDomains
            );

            // Update context with tool results
            if (result.contextUpdate) {
              await this.updateContext(
                result.contextUpdate as Partial<TContext>
              );
            }

            // Update extracted data with tool results
            if (result.extractedUpdate) {
              session = await this.updateExtracted(
                session,
                result.extractedUpdate
              );
              console.log(
                `[Agent] Tool updated extracted data:`,
                result.extractedUpdate
              );
            }

            console.log(
              `[Agent] Executed tool: ${result.toolName} (success: ${result.success})`
            );
          }
        }
      }
    }

    // PHASE 2: ROUTING + STATE SELECTION - Determine which route and state to use (combined)
    let selectedRoute: Route<TContext> | undefined;
    let responseDirectives: string[] | undefined;
    let selectedState: State<TContext> | undefined;

    if (this.routes.length > 0) {
      const orchestration = await this.routingEngine.decideRouteAndState({
        routes: this.routes,
        session,
        history,
        agentMeta: {
          name: this.options.name,
          goal: this.options.goal,
          description: this.options.description,
          personality: this.options.personality,
        },
        ai: this.options.ai,
        context: effectiveContext,
        signal,
      });

      selectedRoute = orchestration.selectedRoute;
      selectedState = orchestration.selectedState;
      responseDirectives = orchestration.responseDirectives;
      session = orchestration.session;
    }

    // PHASE 3: DETERMINE NEXT STATE - Use state from combined decision or get initial state
    if (selectedRoute) {
      let nextState: State<TContext>;

      // If we have a selected state from the combined routing decision, use it
      if (selectedState) {
        nextState = selectedState;
      } else {
        // New route or no state selected - get initial state or first valid state
        const candidates = this.routingEngine.getCandidateStates(
          selectedRoute,
          undefined,
          session.extracted
        );
        if (candidates.length > 0) {
          nextState = candidates[0].state;
          console.log(
            `[Agent] Using first valid state: ${nextState.id} for new route`
          );
        } else {
          // Fallback to initial state even if it should be skipped
          nextState = selectedRoute.initialState;
          console.warn(
            `[Agent] No valid states found, using initial state: ${nextState.id}`
          );
        }
      }

      // Update session with next state
      session = enterState(session, nextState.id, nextState.description);
      console.log(`[Agent] Entered state: ${nextState.id}`);

      // PHASE 4: RESPONSE GENERATION - Stream message using selected route and state
      // Get last user message
      const lastUserMessage = getLastMessageFromHistory(history);

      // Build response schema for this route (with gather fields from state)
      const responseSchema = this.responseEngine.responseSchemaForRoute(
        selectedRoute,
        nextState
      );

      // Build response prompt
      const responsePrompt = this.responseEngine.buildResponsePrompt(
        selectedRoute,
        selectedRoute.getRules(),
        selectedRoute.getProhibitions(),
        responseDirectives,
        history,
        lastUserMessage,
        {
          name: this.options.name,
          goal: this.options.goal,
          description: this.options.description,
          personality: this.options.personality,
        }
      );

      // Generate message stream using AI provider
      const stream = this.options.ai.generateMessageStream({
        prompt: responsePrompt,
        history,
        context: effectiveContext,
        signal,
        parameters: {
          jsonSchema: responseSchema,
          schemaName: "response_stream_output",
        },
      });

      // Stream chunks to caller
      for await (const chunk of stream) {
        const toolCalls:
          | Array<{ toolName: string; arguments: Record<string, unknown> }>
          | undefined = undefined;

        // Extract gathered data on final chunk
        if (chunk.done && chunk.structured && nextState.gatherFields) {
          const gatheredData: Record<string, unknown> = {};
          // The structured response includes both base fields and gathered extraction fields
          const structuredData = chunk.structured as AgentStructuredResponse &
            Record<string, unknown>;

          for (const field of nextState.gatherFields) {
            if (field in structuredData) {
              gatheredData[field] = structuredData[field];
            }
          }

          // Merge gathered data into session
          if (Object.keys(gatheredData).length > 0) {
            session = await this.updateExtracted(session, gatheredData);
            console.log(`[Agent] Extracted data:`, gatheredData);
          }
        }

        // Extract any additional data from structured response on final chunk
        if (
          chunk.done &&
          chunk.structured &&
          typeof chunk.structured === "object" &&
          "contextUpdate" in chunk.structured
        ) {
          await this.updateContext(
            (chunk.structured as { contextUpdate?: Partial<TContext> })
              .contextUpdate as Partial<TContext>
          );
        }

        // Auto-save session state on final chunk
        if (
          chunk.done &&
          this.persistenceManager &&
          session.id &&
          this.options.persistence?.autoSave !== false
        ) {
          await this.persistenceManager.saveSessionState(session.id, session);
          console.log(
            `[Agent] Auto-saved session state to persistence: ${session.id}`
          );
        }

        yield {
          delta: chunk.delta,
          accumulated: chunk.accumulated,
          done: chunk.done,
          session, // Return updated session
          toolCalls,
        };
      }
    } else {
      // Fallback: No routes defined, stream a simple response
      const fallbackPrompt = new PromptComposer<TContext>()
        .addAgentMeta({
          name: this.options.name,
          goal: this.options.goal,
          description: this.options.description,
        })
        .addPersonality(this.options.personality)
        .addInteractionHistory(history)
        .addGlossary(this.terms)
        .addGuidelines(this.guidelines)
        .addCapabilities(this.capabilities)
        .build();

      const stream = this.options.ai.generateMessageStream({
        prompt: fallbackPrompt,
        history,
        context: effectiveContext,
        signal,
        parameters: {
          jsonSchema: {
            type: "object",
            properties: {
              message: { type: "string" },
            },
            required: ["message"],
            additionalProperties: false,
          },
          schemaName: "fallback_stream_response",
        },
      });

      for await (const chunk of stream) {
        yield {
          delta: chunk.delta,
          accumulated: chunk.accumulated,
          done: chunk.done,
          session, // Return updated session
          toolCalls: undefined,
        };
      }
    }
  }

  /**
   * Generate a response based on history and context
   */
  async respond(params: {
    history: Event[];
    state?: StateRef;
    session?: SessionState;
    contextOverride?: Partial<TContext>;
    signal?: AbortSignal;
  }): Promise<{
    message: string;
    session?: SessionState;
    toolCalls?: Array<{ toolName: string; arguments: Record<string, unknown> }>;
  }> {
    const { history, contextOverride, signal } = params;

    // Get current context (may fetch from provider)
    let currentContext = await this.getContext();

    // Call beforeRespond hook if configured
    if (this.options.hooks?.beforeRespond && currentContext !== undefined) {
      currentContext = await this.options.hooks.beforeRespond(currentContext);
      // Update stored context with the result from beforeRespond
      this.context = currentContext;
    }

    // Merge context with override
    const effectiveContext = {
      ...(currentContext as Record<string, unknown>),
      ...(contextOverride as Record<string, unknown>),
    } as TContext;

    // Initialize or get session
    let session = params.session || createSession();

    // PHASE 1: TOOL EXECUTION - Execute tools if current state has toolState
    if (session.currentRoute && session.currentState) {
      const currentRoute = this.routes.find(
        (r) => r.id === session.currentRoute?.id
      );
      if (currentRoute) {
        const currentState = currentRoute.getState(session.currentState.id);
        if (currentState) {
          const transitions = currentState.getTransitions();
          const toolTransition = transitions.find((t) => t.spec.toolState);

          if (toolTransition?.spec.toolState) {
            const toolExecutor = new ToolExecutor<TContext, unknown>();
            // Get allowed domains from current route for security enforcement
            const allowedDomains = currentRoute.getDomains();
            const result = await toolExecutor.executeTool(
              toolTransition.spec.toolState,
              effectiveContext,
              this.updateContext.bind(this),
              history,
              session.extracted,
              allowedDomains
            );

            // Update context with tool results
            if (result.contextUpdate) {
              await this.updateContext(
                result.contextUpdate as Partial<TContext>
              );
            }

            // Update extracted data with tool results
            if (result.extractedUpdate) {
              session = await this.updateExtracted(
                session,
                result.extractedUpdate
              );
              console.log(
                `[Agent] Tool updated extracted data:`,
                result.extractedUpdate
              );
            }

            console.log(
              `[Agent] Executed tool: ${result.toolName} (success: ${result.success})`
            );
          }
        }
      }
    }

    // PHASE 2: ROUTING + STATE SELECTION - Determine which route and state to use (combined)
    let selectedRoute: Route<TContext> | undefined;
    let responseDirectives: string[] | undefined;
    let selectedState: State<TContext> | undefined;

    if (this.routes.length > 0) {
      const orchestration = await this.routingEngine.decideRouteAndState({
        routes: this.routes,
        session,
        history,
        agentMeta: {
          name: this.options.name,
          goal: this.options.goal,
          description: this.options.description,
          personality: this.options.personality,
        },
        ai: this.options.ai,
        context: effectiveContext,
        signal,
      });

      selectedRoute = orchestration.selectedRoute;
      selectedState = orchestration.selectedState;
      responseDirectives = orchestration.responseDirectives;
      session = orchestration.session;
    }

    // PHASE 3: DETERMINE NEXT STATE - Use state from combined decision or get initial state
    let message: string;
    const toolCalls:
      | Array<{ toolName: string; arguments: Record<string, unknown> }>
      | undefined = undefined;

    if (selectedRoute) {
      let nextState: State<TContext>;

      // If we have a selected state from the combined routing decision, use it
      if (selectedState) {
        nextState = selectedState;
      } else {
        // New route or no state selected - get initial state or first valid state
        const candidates = this.routingEngine.getCandidateStates(
          selectedRoute,
          undefined,
          session.extracted
        );
        if (candidates.length > 0) {
          nextState = candidates[0].state;
          console.log(
            `[Agent] Using first valid state: ${nextState.id} for new route`
          );
        } else {
          // Fallback to initial state even if it should be skipped
          nextState = selectedRoute.initialState;
          console.warn(
            `[Agent] No valid states found, using initial state: ${nextState.id}`
          );
        }
      }

      // Update session with next state
      session = enterState(session, nextState.id, nextState.description);
      console.log(`[Agent] Entered state: ${nextState.id}`);

      // PHASE 4: RESPONSE GENERATION - Generate message using selected route and state
      // Get last user message
      const lastUserMessage = getLastMessageFromHistory(history);

      // Build response schema for this route (with gather fields from state)
      const responseSchema = this.responseEngine.responseSchemaForRoute(
        selectedRoute,
        nextState
      );

      // Build response prompt
      const responsePrompt = this.responseEngine.buildResponsePrompt(
        selectedRoute,
        selectedRoute.getRules(),
        selectedRoute.getProhibitions(),
        responseDirectives,
        history,
        lastUserMessage,
        {
          name: this.options.name,
          goal: this.options.goal,
          description: this.options.description,
          personality: this.options.personality,
        }
      );

      // Generate message using AI provider
      const result = await this.options.ai.generateMessage({
        prompt: responsePrompt,
        history,
        context: effectiveContext,
        signal,
        parameters: {
          jsonSchema: responseSchema,
          schemaName: "response_output",
        },
      });

      message = result.structured?.message || result.message;

      // Extract gathered data from response
      if (result.structured && nextState.gatherFields) {
        const gatheredData: Record<string, unknown> = {};
        // The structured response includes both base fields and gathered extraction fields
        const structuredData = result.structured as AgentStructuredResponse &
          Record<string, unknown>;

        for (const field of nextState.gatherFields) {
          if (field in structuredData) {
            gatheredData[field] = structuredData[field];
          }
        }

        // Merge gathered data into session
        if (Object.keys(gatheredData).length > 0) {
          session = mergeExtracted(session, gatheredData);
          console.log(`[Agent] Extracted data:`, gatheredData);
        }
      }

      // Extract any additional data from structured response
      if (
        result.structured &&
        typeof result.structured === "object" &&
        "contextUpdate" in result.structured
      ) {
        await this.updateContext(
          (result.structured as { contextUpdate?: Partial<TContext> })
            .contextUpdate as Partial<TContext>
        );
      }
    } else {
      // Fallback: No routes defined, generate a simple response
      const fallbackPrompt = new PromptComposer<TContext>()
        .addAgentMeta({
          name: this.options.name,
          goal: this.options.goal,
          description: this.options.description,
        })
        .addPersonality(this.options.personality)
        .addInteractionHistory(history)
        .addGlossary(this.terms)
        .addGuidelines(this.guidelines)
        .addCapabilities(this.capabilities)
        .build();

      const result = await this.options.ai.generateMessage({
        prompt: fallbackPrompt,
        history,
        context: effectiveContext,
        signal,
        parameters: {
          jsonSchema: {
            type: "object",
            properties: {
              message: { type: "string" },
            },
            required: ["message"],
            additionalProperties: false,
          },
          schemaName: "fallback_response",
        },
      });

      message = result.structured?.message || result.message;
    }

    // Auto-save session state to persistence if configured
    if (
      this.persistenceManager &&
      session.id &&
      this.options.persistence?.autoSave !== false
    ) {
      await this.persistenceManager.saveSessionState(session.id, session);
      console.log(
        `[Agent] Auto-saved session state to persistence: ${session.id}`
      );
    }

    return {
      message,
      session, // Return updated session with route/state info
      toolCalls,
    };
  }

  /**
   * Get all routes
   */
  getRoutes(): Route<TContext, unknown>[] {
    return [...this.routes];
  }

  /**
   * Get all terms
   */
  getTerms(): Term[] {
    return [...this.terms];
  }

  /**
   * Get all guidelines
   */
  getGuidelines(): Guideline[] {
    return [...this.guidelines];
  }

  /**
   * Get all capabilities
   */
  getCapabilities(): Capability[] {
    return [...this.capabilities];
  }

  /**
   * Get the domain registry
   */
  getDomainRegistry(): DomainRegistry {
    return this.domainRegistry;
  }

  /**
   * Get the persistence manager (if configured)
   */
  getPersistenceManager(): PersistenceManager | undefined {
    return this.persistenceManager;
  }

  /**
   * Check if persistence is enabled
   */
  hasPersistence(): boolean {
    return this.persistenceManager !== undefined;
  }

  /**
   * Get allowed domains for a specific route
   * @param routeId - Route ID to check
   * @returns Filtered domains object, or all domains if route has no restrictions
   */
  getDomainsForRoute(routeId: string): Record<string, Record<string, unknown>> {
    const route = this.routes.find((r) => r.id === routeId);

    if (!route) {
      // Route not found, return all domains
      return this.domainRegistry.all();
    }

    const allowedDomains = route.getDomains();
    return this.domainRegistry.getFiltered(allowedDomains);
  }

  /**
   * Get allowed domains for a specific route by title
   * @param routeTitle - Route title to check
   * @returns Filtered domains object, or all domains if route has no restrictions
   */
  getDomainsForRouteByTitle(
    routeTitle: string
  ): Record<string, Record<string, unknown>> {
    const route = this.routes.find((r) => r.title === routeTitle);

    if (!route) {
      // Route not found, return all domains
      return this.domainRegistry.all();
    }

    const allowedDomains = route.getDomains();
    return this.domainRegistry.getFiltered(allowedDomains);
  }
}
