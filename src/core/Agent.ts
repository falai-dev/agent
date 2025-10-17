/**
 * Core Agent implementation
 */

import type { AgentOptions, Term, Guideline, Capability } from "../types/agent";
import type { Event, StateRef } from "../types/index";
import type { RouteOptions } from "../types/route";

import type { SessionState } from "../types/session";
import type { AgentStructuredResponse } from "../types/ai";
import { createSession, enterRoute, enterState, mergeExtracted } from "../types/session";
import { PromptComposer } from "./PromptComposer";
import { logger, LoggerLevel } from "../utils/logger";

import { Route } from "./Route";
import { State } from "./State";
import { DomainRegistry } from "./DomainRegistry";
import { PersistenceManager } from "./PersistenceManager";
import { RoutingEngine } from "./RoutingEngine";
import { ResponseEngine } from "./ResponseEngine";
import { ToolExecutor } from "./ToolExecutor";
import { getLastMessageFromHistory } from "../utils/event";
import { END_STATE_ID } from "../constants";

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
  private currentSession?: SessionState;

  /**
   * Dynamic domain property - populated via addDomain
   */
  public readonly domain: Record<string, Record<string, unknown>> = {};

  constructor(private readonly options: AgentOptions<TContext>) {
    // Set log level based on debug option
    if (options.debug) {
      logger.setLevel(LoggerLevel.DEBUG);
    }

    // Validate context configuration
    if (options.context !== undefined && options.contextProvider) {
      throw new Error(
        "Cannot provide both 'context' and 'contextProvider'. Choose one."
      );
    }

    // Initialize context if provided
    this.context = options.context;

    // Initialize current session if provided
    this.currentSession = options.session;

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
          logger.error(
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
        newExtracted = (await this.options.hooks.onExtractedUpdate(
        newExtracted,
        previousExtracted
      )) as Partial<TExtracted>;
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
    isRouteComplete?: boolean;
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

    // Initialize or get session (use current session if available)
    let session = params.session || this.currentSession || createSession();

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
              logger.debug(
                `[Agent] Tool updated extracted data:`,
                result.extractedUpdate
              );
            }

            logger.debug(
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
    let isRouteComplete = false;

    // Check for pending transition from previous route completion
    if (session.pendingTransition) {
      const targetRoute = this.routes.find(
        (r) => r.id === session.pendingTransition?.targetRouteId
      );

      if (targetRoute) {
        logger.debug(
          `[Agent] Auto-transitioning from pending transition to route: ${targetRoute.title}`
        );
        // Clear pending transition and enter new route
        session = {
          ...session,
          pendingTransition: undefined,
        };
        session = enterRoute(session, targetRoute.id, targetRoute.title);

        // Merge initial data if available
        if (targetRoute.initialData) {
          session = mergeExtracted(session, targetRoute.initialData);
        }

        selectedRoute = targetRoute;
      } else {
        logger.warn(
          `[Agent] Pending transition target route not found: ${session.pendingTransition.targetRouteId}`
        );
        // Clear invalid transition
        session = {
          ...session,
          pendingTransition: undefined,
        };
      }
    }

    // If no pending transition or transition handled, do normal routing
    if (this.routes.length > 0 && !selectedRoute) {
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
      isRouteComplete = orchestration.isRouteComplete || false;

      // Log if route is complete
      if (isRouteComplete) {
        logger.debug(
          `[Agent] Route complete: all required data collected, END_STATE reached`
        );
      }
    }

    // PHASE 3: DETERMINE NEXT STATE - Use state from combined decision or get initial state
    if (selectedRoute && !isRouteComplete) {
      let nextState: State<TContext>;

      // If we have a selected state from the combined routing decision, use it
      if (selectedState) {
        nextState = selectedState;
      } else {
        // New route or no state selected - get initial state or first valid state
        const candidates = this.routingEngine.getCandidateStates(
          selectedRoute,
          undefined,
          session.extracted || {}
        );
        if (candidates.length > 0) {
          nextState = candidates[0].state;
          logger.debug(
            `[Agent] Using first valid state: ${nextState.id} for new route`
          );
        } else {
          // Fallback to initial state even if it should be skipped
          nextState = selectedRoute.initialState;
          logger.warn(
            `[Agent] No valid states found, using initial state: ${nextState.id}`
          );
        }
      }

      // Update session with next state
      session = enterState(session, nextState.id, nextState.description);
      logger.debug(`[Agent] Entered state: ${nextState.id}`);

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
        nextState,
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
            logger.debug(`[Agent] Extracted data:`, gatheredData);
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
          logger.debug(
            `[Agent] Auto-saved session state to persistence: ${session.id}`
          );
        }

        // Update current session if we have one
        if (chunk.done && this.currentSession) {
          this.currentSession = session;
        }

        yield {
          delta: chunk.delta,
          accumulated: chunk.accumulated,
          done: chunk.done,
          session, // Return updated session
          toolCalls,
          isRouteComplete,
        };
      }
    } else if (isRouteComplete && selectedRoute) {
      // Route is complete - generate completion message then check for onComplete transition
      const lastUserMessage = getLastMessageFromHistory(history);

      // Get endState spec from route
      const endStateSpec = selectedRoute.endStateSpec;

      // Create a temporary state for completion message generation using endState configuration
      const completionState = new State<TContext>(
        selectedRoute.id,
        endStateSpec.chatState || "Summarize what was accomplished and confirm completion",
        endStateSpec.id || END_STATE_ID,
        endStateSpec.gather,
        undefined,
        endStateSpec.requiredData,
        endStateSpec.chatState || "Summarize what was accomplished and confirm completion based on the conversation history and collected data"
      );

      // Build response schema for completion
      const responseSchema = this.responseEngine.responseSchemaForRoute(
        selectedRoute,
        completionState
      );

      // Build completion response prompt
      const completionPrompt = this.responseEngine.buildResponsePrompt(
        selectedRoute,
        completionState,
        selectedRoute.getRules(),
        selectedRoute.getProhibitions(),
        undefined, // No directives for completion
        history,
        lastUserMessage,
        {
          name: this.options.name,
          goal: this.options.goal,
          description: this.options.description,
          personality: this.options.personality,
        }
      );

      // Stream completion message using AI provider
      const stream = this.options.ai.generateMessageStream({
        prompt: completionPrompt,
        history,
        context: effectiveContext,
        signal,
        parameters: {
          jsonSchema: responseSchema,
          schemaName: "completion_message_stream",
        },
      });

      logger.debug(
        `[Agent] Streaming completion message for route: ${selectedRoute.title}`
      );

      // Check for onComplete transition
      const transitionConfig = await selectedRoute.evaluateOnComplete(
        { extracted: session.extracted },
        effectiveContext
      );

      if (transitionConfig) {
        // Find target route by ID or title
        const targetRoute = this.routes.find(
          (r) =>
            r.id === transitionConfig.transitionTo ||
            r.title === transitionConfig.transitionTo
        );

        if (targetRoute) {
          // Set pending transition in session
          session = {
            ...session,
            pendingTransition: {
              targetRouteId: targetRoute.id,
              condition: transitionConfig.condition,
              reason: "route_complete",
            },
          };
          logger.debug(
            `[Agent] Route ${selectedRoute.title} completed with pending transition to: ${targetRoute.title}`
          );
        } else {
          logger.warn(
            `[Agent] Route ${selectedRoute.title} completed but target route not found: ${transitionConfig.transitionTo}`
          );
        }
      }

      // Set state to END_STATE marker
      session = enterState(session, END_STATE_ID, "Route completed");
      logger.debug(
        `[Agent] Route ${selectedRoute.title} completed. Entered END_STATE state.`
      );

      // Stream completion chunks
      for await (const chunk of stream) {
        // Update current session if we have one
        if (chunk.done && this.currentSession) {
          this.currentSession = session;
        }

        yield {
          delta: chunk.delta,
          accumulated: chunk.accumulated,
          done: chunk.done,
          session,
          toolCalls: undefined,
          isRouteComplete: true,
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
        // Update current session if we have one
        if (chunk.done && this.currentSession) {
          this.currentSession = session;
        }

        yield {
          delta: chunk.delta,
          accumulated: chunk.accumulated,
          done: chunk.done,
          session, // Return updated session
          toolCalls: undefined,
          isRouteComplete: false,
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
    isRouteComplete?: boolean;
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

    // Initialize or get session (use current session if available)
    let session =
      params.session || this.currentSession || createSession<TContext>();

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
              logger.debug(
                `[Agent] Tool updated extracted data:`,
                result.extractedUpdate
              );
            }

            logger.debug(
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
    let isRouteComplete = false;

    // Check for pending transition from previous route completion
    if (session.pendingTransition) {
      const targetRoute = this.routes.find(
        (r) => r.id === session.pendingTransition?.targetRouteId
      );

      if (targetRoute) {
        logger.debug(
          `[Agent] Auto-transitioning from pending transition to route: ${targetRoute.title}`
        );
        // Clear pending transition and enter new route
        session = {
          ...session,
          pendingTransition: undefined,
        };
        session = enterRoute(session, targetRoute.id, targetRoute.title);

        // Merge initial data if available
        if (targetRoute.initialData) {
          session = mergeExtracted(session, targetRoute.initialData);
        }

        selectedRoute = targetRoute;
      } else {
        logger.warn(
          `[Agent] Pending transition target route not found: ${session.pendingTransition.targetRouteId}`
        );
        // Clear invalid transition
        session = {
          ...session,
          pendingTransition: undefined,
        };
      }
    }

    // If no pending transition or transition handled, do normal routing
    if (this.routes.length > 0 && !selectedRoute) {
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
      isRouteComplete = orchestration.isRouteComplete || false;

      // Log if route is complete
      if (isRouteComplete) {
        logger.debug(
          `[Agent] Route complete: all required data collected, END_STATE reached`
        );
      }
    }

    // PHASE 3: DETERMINE NEXT STATE - Use state from combined decision or get initial state
    let message: string;
    const toolCalls:
      | Array<{ toolName: string; arguments: Record<string, unknown> }>
      | undefined = undefined;

    if (selectedRoute && !isRouteComplete) {
      let nextState: State<TContext>;

      // If we have a selected state from the combined routing decision, use it
      if (selectedState) {
        nextState = selectedState;
      } else {
        // New route or no state selected - get initial state or first valid state
        const candidates = this.routingEngine.getCandidateStates(
          selectedRoute,
          undefined,
          session.extracted || {}
        );
        if (candidates.length > 0) {
          nextState = candidates[0].state;
          logger.debug(
            `[Agent] Using first valid state: ${nextState.id} for new route`
          );
        } else {
          // Fallback to initial state even if it should be skipped
          nextState = selectedRoute.initialState;
          logger.warn(
            `[Agent] No valid states found, using initial state: ${nextState.id}`
          );
        }
      }

      // Update session with next state
      session = enterState(session, nextState.id, nextState.description);
      logger.debug(`[Agent] Entered state: ${nextState.id}`);

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
        nextState,
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
          session = await this.updateExtracted(session, gatheredData);
          logger.debug(`[Agent] Extracted data:`, gatheredData);
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
    } else if (isRouteComplete && selectedRoute) {
      // Route is complete - generate completion message then check for onComplete transition
      const lastUserMessage = getLastMessageFromHistory(history);

      // Get endState spec from route
      const endStateSpec = selectedRoute.endStateSpec;

      // Create a temporary state for completion message generation using endState configuration
      const completionState = new State<TContext>(
        selectedRoute.id,
        endStateSpec.chatState || "Summarize what was accomplished and confirm completion",
        endStateSpec.id || END_STATE_ID,
        endStateSpec.gather,
        undefined,
        endStateSpec.requiredData,
        endStateSpec.chatState || "Summarize what was accomplished and confirm completion based on the conversation history and collected data"
      );

      // Build response schema for completion
      const responseSchema = this.responseEngine.responseSchemaForRoute(
        selectedRoute,
        completionState
      );

      // Build completion response prompt
      const completionPrompt = this.responseEngine.buildResponsePrompt(
        selectedRoute,
        completionState,
        selectedRoute.getRules(),
        selectedRoute.getProhibitions(),
        undefined, // No directives for completion
        history,
        lastUserMessage,
        {
          name: this.options.name,
          goal: this.options.goal,
          description: this.options.description,
          personality: this.options.personality,
        }
      );

      // Generate completion message using AI provider
      const completionResult = await this.options.ai.generateMessage({
        prompt: completionPrompt,
        history,
        context: effectiveContext,
        signal,
        parameters: {
          jsonSchema: responseSchema,
          schemaName: "completion_message",
        },
      });

      message = completionResult.structured?.message || completionResult.message;
      logger.debug(
        `[Agent] Generated completion message for route: ${selectedRoute.title}`
      );

      // Check for onComplete transition
      const transitionConfig = await selectedRoute.evaluateOnComplete(
        { extracted: session.extracted },
        effectiveContext
      );

      if (transitionConfig) {
        // Find target route by ID or title
        const targetRoute = this.routes.find(
          (r) =>
            r.id === transitionConfig.transitionTo ||
            r.title === transitionConfig.transitionTo
        );

        if (targetRoute) {
          // Set pending transition in session
          session = {
            ...session,
            pendingTransition: {
              targetRouteId: targetRoute.id,
              condition: transitionConfig.condition,
              reason: "route_complete",
            },
          };
          logger.debug(
            `[Agent] Route ${selectedRoute.title} completed with pending transition to: ${targetRoute.title}`
          );
        } else {
          logger.warn(
            `[Agent] Route ${selectedRoute.title} completed but target route not found: ${transitionConfig.transitionTo}`
          );
        }
      }

      // Set state to END_STATE marker
      session = enterState(session, END_STATE_ID, "Route completed");
      logger.debug(
        `[Agent] Route ${selectedRoute.title} completed. Entered END_STATE state.`
      );
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
      logger.debug(
        `[Agent] Auto-saved session state to persistence: ${session.id}`
      );
    }

    // Update current session if we have one
    if (this.currentSession) {
      this.currentSession = session;
    }

    return {
      message,
      session, // Return updated session with route/state info
      toolCalls,
      isRouteComplete, // Indicates if the route has reached END_STATE with all data collected
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

  /**
   * Set the current session for convenience methods
   * @param session - Session state to use for subsequent calls
   */
  setCurrentSession(session: SessionState): void {
    this.currentSession = session;
  }

  /**
   * Get the current session (if set)
   */
  getCurrentSession(): SessionState | undefined {
    return this.currentSession;
  }

  /**
   * Clear the current session
   */
  clearCurrentSession(): void {
    this.currentSession = undefined;
  }

  /**
   * Get extracted data from current session
   * @param routeId - Optional route ID to get data for (uses current route if not provided)
   * @returns The extracted data from the current session
   */
  getExtractedData<TExtracted = unknown>(
    routeId?: string
  ): Partial<TExtracted> {
    if (!this.currentSession) {
      return {} as Partial<TExtracted>;
    }
    if (routeId) {
      return (
        (this.currentSession.extractedByRoute?.[
          routeId
        ] as Partial<TExtracted>) || ({} as Partial<TExtracted>)
      );
    }
    return (this.currentSession.extracted as Partial<TExtracted>) || {};
  }

  /**
   * Manually transition to a different route
   * Sets a pending transition that will be executed on the next respond() call
   *
   * @param routeIdOrTitle - Route ID or title to transition to
   * @param session - Session state to update (uses current session if not provided)
   * @param condition - Optional AI-evaluated condition for the transition
   * @returns Updated session with pending transition
   *
   * @example
   * // After route completes
   * if (response.isRouteComplete && response.session) {
   *   const updatedSession = agent.transitionToRoute("feedback-collection", response.session);
   *   // Next respond() call will automatically transition to feedback route
   *   const nextResponse = await agent.respond({ history, session: updatedSession });
   * }
   */
  transitionToRoute(
    routeIdOrTitle: string,
    session?: SessionState,
    condition?: string
  ): SessionState {
    const targetSession = session || this.currentSession;

    if (!targetSession) {
      throw new Error(
        "No session provided and no current session available. Please provide a session to transition."
      );
    }

    // Find target route by ID or title
    const targetRoute = this.routes.find(
      (r) => r.id === routeIdOrTitle || r.title === routeIdOrTitle
    );

    if (!targetRoute) {
      throw new Error(
        `Route not found: ${routeIdOrTitle}. Available routes: ${this.routes.map((r) => r.title).join(", ")}`
      );
    }

    const updatedSession: SessionState = {
      ...targetSession,
      pendingTransition: {
        targetRouteId: targetRoute.id,
        condition,
        reason: "manual",
      },
    };

    // Update current session if using it
    if (!session && this.currentSession) {
      this.currentSession = updatedSession;
    }

    logger.debug(
      `[Agent] Set pending manual transition to route: ${targetRoute.title}`
    );

    return updatedSession;
  }
}
