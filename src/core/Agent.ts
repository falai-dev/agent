/**
 * Core Agent implementation
 */

import type { AgentOptions, Term, Guideline, Capability } from "../types/agent";
import type { Event } from "../types/history";
import type { RouteOptions } from "../types/route";
import type { SessionState } from "../types/session";
import type { AgentStructuredResponse } from "../types/ai";
import {
  createSession,
  enterRoute,
  enterStep,
  mergeCollected,
} from "../types/session";
import { logger, LoggerLevel } from "../utils/logger";

import { Route } from "./Route";
import { Step } from "./Step";
import { DomainRegistry } from "./DomainRegistry";
import { PersistenceManager } from "./PersistenceManager";
import { RoutingEngine } from "./RoutingEngine";
import { ResponseEngine } from "./ResponseEngine";
import { ToolExecutor } from "./ToolExecutor";
import { getLastMessageFromHistory } from "../utils/event";
import { END_ROUTE_ID } from "../constants";
import { ToolRef } from "../types/tool";
import { Template } from "../types/template";
import { StepRef } from "../types";
import { render } from "../utils/template";

/**
 * Main Agent class with generic context support
 */
export class Agent<TContext = unknown> {
  private terms: Term<TContext>[] = [];
  private guidelines: Guideline<TContext>[] = [];
  private capabilities: Capability[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private routes: Route<TContext, any>[] = [];
  private domainRegistry = new DomainRegistry();
  private context: TContext | undefined;
  private persistenceManager: PersistenceManager | undefined;
  private routingEngine: RoutingEngine<TContext>;
  private responseEngine: ResponseEngine<TContext>;
  private currentSession?: SessionState;
  private knowledgeBase: Record<string, unknown> = {};

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

    // Initialize from options - use create methods for consistency
    if (options.terms) {
      options.terms.forEach((term) => {
        this.createTerm(term);
      });
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

    // Initialize knowledge base
    if (options.knowledgeBase) {
      this.knowledgeBase = { ...options.knowledgeBase };
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
   * Get agent identity
   */
  get identity(): Template<TContext> | undefined {
    return this.options.identity;
  }

  /**
   * Create a new route (journey)
   * @template TData - Type of data collected throughout the route
   */
  createRoute<TData = unknown>(
    options: RouteOptions<TContext, TData>
  ): Route<TContext, TData> {
    const route = new Route<TContext, TData>(options);
    this.routes.push(route);
    return route;
  }

  /**
   * Create a domain term for the glossary
   */
  createTerm(term: Term<TContext>): this {
    this.terms.push(term);
    return this;
  }

  /**
   * Create a behavioral guideline
   */
  createGuideline(guideline: Guideline<TContext>): this {
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
   * Triggers both agent-level and route-specific onContextUpdate lifecycle hooks if configured
   */
  async updateContext(updates: Partial<TContext>): Promise<void> {
    const previousContext = this.context;

    // Merge updates with current context
    this.context = {
      ...(this.context as Record<string, unknown>),
      ...(updates as Record<string, unknown>),
    } as TContext;

    // Trigger route-specific lifecycle hook if configured and session has current route
    if (this.currentSession?.currentRoute) {
      const currentRoute = this.routes.find(
        (r) => r.id === this.currentSession!.currentRoute?.id
      );
      if (
        currentRoute?.hooks?.onContextUpdate &&
        previousContext !== undefined
      ) {
        await currentRoute.handleContextUpdate(this.context, previousContext);
      }
    }

    // Trigger agent-level lifecycle hook if configured
    if (this.options.hooks?.onContextUpdate && previousContext !== undefined) {
      await this.options.hooks.onContextUpdate(this.context, previousContext);
    }
  }

  /**
   * Update collected data in session with lifecycle hook support
   * Triggers both agent-level and route-specific onDataUpdate lifecycle hooks if configured
   * @internal
   */
  private async updateData<TData = unknown>(
    session: SessionState<TData>,
    collectedUpdate: Partial<TData>
  ): Promise<SessionState<TData>> {
    const previousCollected = { ...session.data };

    // Merge new collected data
    let newCollected = {
      ...session.data,
      ...collectedUpdate,
    };

    // Trigger route-specific lifecycle hook if configured and session has a current route
    if (session.currentRoute) {
      const currentRoute = this.routes.find(
        (r) => r.id === session.currentRoute?.id
      );
      if (currentRoute?.hooks?.onDataUpdate) {
        newCollected = await currentRoute.handleDataUpdate(
          newCollected,
          previousCollected
        );
      }
    }

    // Trigger agent-level lifecycle hook if configured
    if (this.options.hooks?.onDataUpdate) {
      newCollected = (await this.options.hooks.onDataUpdate(
        newCollected,
        previousCollected
      )) as Partial<TData>;
    }

    // Return updated session
    return mergeCollected(session, newCollected);
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
    step?: StepRef;
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

    // PHASE 1: TOOL EXECUTION - Execute tools if current step has tool
    if (session.currentRoute && session.currentStep) {
      const currentRoute = this.routes.find(
        (r) => r.id === session.currentRoute?.id
      );
      if (currentRoute) {
        const currentStep = currentRoute.getStep(session.currentStep.id);
        if (currentStep) {
          const transitions = currentStep.getTransitions();
          const toolStep = transitions.find((s) => s.tool);

          if (toolStep?.tool) {
            const toolExecutor = new ToolExecutor<TContext, unknown>();
            // Get allowed domains from current route for security enforcement
            const allowedDomains = currentRoute.getDomains();
            const result = await toolExecutor.executeTool({
              tool: toolStep.tool as ToolRef<TContext, unknown[], unknown>,
              context: effectiveContext,
              updateContext: this.updateContext.bind(this),
              history,
              data: session.data,
              allowedDomains,
            });

            // Update context with tool results
            if (result.contextUpdate) {
              await this.updateContext(
                result.contextUpdate as Partial<TContext>
              );
            }

            // Update collected data with tool results
            if (result.collectedUpdate) {
              session = await this.updateData(session, result.collectedUpdate);
              logger.debug(
                `[Agent] Tool updated collected data:`,
                result.collectedUpdate
              );
            }

            logger.debug(
              `[Agent] Executed tool: ${result.toolName} (success: ${result.success})`
            );
          }
        }
      }
    }

    // PHASE 2: ROUTING + STEP SELECTION - Determine which route and step to use (combined)
    let selectedRoute: Route<TContext, unknown> | undefined;
    let responseDirectives: string[] | undefined;
    let selectedStep: Step<TContext, unknown> | undefined;
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
          session = mergeCollected(session, targetRoute.initialData);
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
      const orchestration = await this.routingEngine.decideRouteAndStep({
        routes: this.routes,
        session,
        history,
        agentOptions: this.options,
        provider: this.options.provider,
        context: effectiveContext,
        signal,
      });

      selectedRoute = orchestration.selectedRoute;
      selectedStep = orchestration.selectedStep;
      responseDirectives = orchestration.responseDirectives;
      session = orchestration.session;
      isRouteComplete = orchestration.isRouteComplete || false;

      // Log if route is complete
      if (isRouteComplete) {
        logger.debug(
          `[Agent] Route complete: all required data collected, END_ROUTE reached`
        );
      }
    }

    // PHASE 3: DETERMINE NEXT STEP - Use step from combined decision or get initial step
    if (selectedRoute && !isRouteComplete) {
      let nextStep: Step<TContext, unknown>;

      // If we have a selected step from the combined routing decision, use it
      if (selectedStep) {
        nextStep = selectedStep;
      } else {
        // New route or no step selected - get initial step or first valid step
        const candidates = this.routingEngine.getCandidateSteps(
          selectedRoute,
          undefined,
          session.data || {}
        );
        if (candidates.length > 0) {
          nextStep = candidates[0].step;
          logger.debug(
            `[Agent] Using first valid step: ${nextStep.id} for new route`
          );
        } else {
          // Fallback to initial step even if it should be skipped
          nextStep = selectedRoute.initialStep;
          logger.warn(
            `[Agent] No valid steps found, using initial step: ${nextStep.id}`
          );
        }
      }

      // Update session with next step
      session = enterStep(session, nextStep.id, nextStep.description);
      logger.debug(`[Agent] Entered step: ${nextStep.id}`);

      // PHASE 4: RESPONSE GENERATION - Stream message using selected route and step
      // Get last user message
      const lastUserMessage = getLastMessageFromHistory(history);

      // Build response schema for this route (with collect fields from step)
      const responseSchema = this.responseEngine.responseSchemaForRoute(
        selectedRoute,
        nextStep
      );

      // Build response prompt
      const responsePrompt = await this.responseEngine.buildResponsePrompt({
        route: selectedRoute,
        currentStep: nextStep,
        rules: selectedRoute.getRules(),
        prohibitions: selectedRoute.getProhibitions(),
        directives: responseDirectives,
        history,
        lastMessage: lastUserMessage,
        agentOptions: this.options,
        // Combine agent and route properties according to the specified logic
        combinedGuidelines: [
          ...this.getGuidelines(),
          ...selectedRoute.getGuidelines(),
        ],
        combinedTerms: this.mergeTerms(
          this.getTerms(),
          selectedRoute.getTerms()
        ),
        combinedCapabilities: [
          ...this.getCapabilities(),
          ...selectedRoute.getCapabilities(),
        ],
        context: effectiveContext,
        session,
      });

      // Generate message stream using AI provider
      const stream = this.options.provider.generateMessageStream({
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

        // Extract collected data on final chunk
        if (chunk.done && chunk.structured && nextStep.collect) {
          const collectedData: Record<string, unknown> = {};
          // The structured response includes both base fields and collected extraction fields
          const structuredData = chunk.structured as AgentStructuredResponse &
            Record<string, unknown>;

          for (const field of nextStep.collect) {
            if (field in structuredData) {
              collectedData[field] = structuredData[field];
            }
          }

          // Merge collected data into session
          if (Object.keys(collectedData).length > 0) {
            session = await this.updateData(session, collectedData);
            logger.debug(`[Agent] Collected data:`, collectedData);
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

        // Auto-save session step on final chunk
        if (
          chunk.done &&
          this.persistenceManager &&
          session.id &&
          this.options.persistence?.autoSave !== false
        ) {
          await this.persistenceManager.saveSessionState(session.id, session);
          logger.debug(
            `[Agent] Auto-saved session step to persistence: ${session.id}`
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

      // Get endStep spec from route
      const endStepSpec = selectedRoute.endStepSpec;

      // Create a temporary step for completion message generation using endStep configuration
      const completionStep = new Step<TContext, unknown>(selectedRoute.id, {
        description: endStepSpec.description,
        id: endStepSpec.id || END_ROUTE_ID,
        collect: endStepSpec.collect,
        requires: endStepSpec.requires,
        prompt:
          endStepSpec.prompt ||
          "Summarize what was accomplished and confirm completion based on the conversation history and collected data",
      });

      // Build response schema for completion
      const responseSchema = this.responseEngine.responseSchemaForRoute(
        selectedRoute,
        completionStep
      );
      const templateContext = {
        context: effectiveContext,
        session,
        history,
      };

      // Build completion response prompt
      const completionPrompt = await this.responseEngine.buildResponsePrompt({
        route: selectedRoute,
        currentStep: completionStep,
        rules: selectedRoute.getRules(),
        prohibitions: selectedRoute.getProhibitions(),
        directives: undefined, // No directives for completion
        history,
        lastMessage: lastUserMessage,
        agentOptions: this.options,
        // Combine agent and route properties according to the specified logic
        combinedGuidelines: [
          ...this.getGuidelines(),
          ...selectedRoute.getGuidelines(),
        ],
        combinedTerms: this.mergeTerms(
          this.getTerms(),
          selectedRoute.getTerms()
        ),
        combinedCapabilities: [
          ...this.getCapabilities(),
          ...selectedRoute.getCapabilities(),
        ],
        context: effectiveContext,
        session,
      });

      // Stream completion message using AI provider
      const stream = this.options.provider.generateMessageStream({
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
        { data: session.data },
        effectiveContext
      );

      if (transitionConfig) {
        // Find target route by ID or title
        const targetRoute = this.routes.find(
          (r) =>
            r.id === transitionConfig.nextStep ||
            r.title === transitionConfig.nextStep
        );

        if (targetRoute) {
          const renderedCondition = await render(
            transitionConfig.condition,
            templateContext
          );
          // Set pending transition in session
          session = {
            ...session,
            pendingTransition: {
              targetRouteId: targetRoute.id,
              condition: renderedCondition,
              reason: "route_complete",
            },
          };
          logger.debug(
            `[Agent] Route ${selectedRoute.title} completed with pending transition to: ${targetRoute.title}`
          );
        } else {
          logger.warn(
            `[Agent] Route ${selectedRoute.title} completed but target route not found: ${transitionConfig.nextStep}`
          );
        }
      }

      // Set step to END_ROUTE marker
      session = enterStep(session, END_ROUTE_ID, "Route completed");
      logger.debug(
        `[Agent] Route ${selectedRoute.title} completed. Entered END_ROUTE step.`
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
      const fallbackPrompt = await this.responseEngine.buildFallbackPrompt({
        history,
        agentOptions: this.options,
        terms: this.terms,
        guidelines: this.guidelines,
        capabilities: this.capabilities,
        context: effectiveContext,
        session,
      });

      const stream = this.options.provider.generateMessageStream({
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
    step?: StepRef;
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

    // PHASE 1: TOOL EXECUTION - Execute tools if current step has tool
    if (session.currentRoute && session.currentStep) {
      const currentRoute = this.routes.find(
        (r) => r.id === session.currentRoute?.id
      );
      if (currentRoute) {
        const currentStep = currentRoute.getStep(session.currentStep.id);
        if (currentStep) {
          const transitions = currentStep.getTransitions();
          const toolStep = transitions.find((s) => s.tool);

          if (toolStep?.tool) {
            const toolExecutor = new ToolExecutor<TContext, unknown>();
            // Get allowed domains from current route for security enforcement
            const allowedDomains = currentRoute.getDomains();
            const result = await toolExecutor.executeTool({
              tool: toolStep.tool as ToolRef<TContext, unknown[], unknown>,
              context: effectiveContext,
              updateContext: this.updateContext.bind(this),
              history,
              data: session.data,
              allowedDomains,
            });

            // Update context with tool results
            if (result.contextUpdate) {
              await this.updateContext(
                result.contextUpdate as Partial<TContext>
              );
            }

            // Update collected data with tool results
            if (result.collectedUpdate) {
              session = await this.updateData(session, result.collectedUpdate);
              logger.debug(
                `[Agent] Tool updated collected data:`,
                result.collectedUpdate
              );
            }

            logger.debug(
              `[Agent] Executed tool: ${result.toolName} (success: ${result.success})`
            );
          }
        }
      }
    }

    // PHASE 2: ROUTING + STEP SELECTION - Determine which route and step to use (combined)
    let selectedRoute: Route<TContext, unknown> | undefined;
    let responseDirectives: string[] | undefined;
    let selectedStep: Step<TContext, unknown> | undefined;
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
          session = mergeCollected(session, targetRoute.initialData);
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
      const orchestration = await this.routingEngine.decideRouteAndStep({
        routes: this.routes,
        session,
        history,
        agentOptions: this.options,
        provider: this.options.provider,
        context: effectiveContext,
        signal,
      });

      selectedRoute = orchestration.selectedRoute;
      selectedStep = orchestration.selectedStep;
      responseDirectives = orchestration.responseDirectives;
      session = orchestration.session;
      isRouteComplete = orchestration.isRouteComplete || false;

      // Log if route is complete
      if (isRouteComplete) {
        logger.debug(
          `[Agent] Route complete: all required data collected, END_ROUTE reached`
        );
      }
    }

    // PHASE 3: DETERMINE NEXT STEP - Use step from combined decision or get initial step
    let message: string;
    const toolCalls:
      | Array<{ toolName: string; arguments: Record<string, unknown> }>
      | undefined = undefined;

    if (selectedRoute && !isRouteComplete) {
      let nextStep: Step<TContext, unknown>;

      // If we have a selected step from the combined routing decision, use it
      if (selectedStep) {
        nextStep = selectedStep;
      } else {
        // New route or no step selected - get initial step or first valid step
        const candidates = this.routingEngine.getCandidateSteps(
          selectedRoute,
          undefined,
          session.data || {}
        );
        if (candidates.length > 0) {
          nextStep = candidates[0].step;
          logger.debug(
            `[Agent] Using first valid step: ${nextStep.id} for new route`
          );
        } else {
          // Fallback to initial step even if it should be skipped
          nextStep = selectedRoute.initialStep;
          logger.warn(
            `[Agent] No valid steps found, using initial step: ${nextStep.id}`
          );
        }
      }

      // Update session with next step
      session = enterStep(session, nextStep.id, nextStep.description);
      logger.debug(`[Agent] Entered step: ${nextStep.id}`);

      // PHASE 4: RESPONSE GENERATION - Generate message using selected route and step
      // Get last user message
      const lastUserMessage = getLastMessageFromHistory(history);

      // Build response schema for this route (with collect fields from step)
      const responseSchema = this.responseEngine.responseSchemaForRoute(
        selectedRoute,
        nextStep
      );

      // Build response prompt
      const responsePrompt = await this.responseEngine.buildResponsePrompt({
        route: selectedRoute,
        currentStep: nextStep,
        rules: selectedRoute.getRules(),
        prohibitions: selectedRoute.getProhibitions(),
        directives: responseDirectives,
        history,
        lastMessage: lastUserMessage,
        agentOptions: this.options,
        // Combine agent and route properties according to the specified logic
        combinedGuidelines: [
          ...this.getGuidelines(),
          ...selectedRoute.getGuidelines(),
        ],
        combinedTerms: this.mergeTerms(
          this.getTerms(),
          selectedRoute.getTerms()
        ),
        combinedCapabilities: [
          ...this.getCapabilities(),
          ...selectedRoute.getCapabilities(),
        ],
        context: effectiveContext,
        session,
      });

      // Generate message using AI provider
      const result = await this.options.provider.generateMessage({
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

      // Extract collected data from response
      if (result.structured && nextStep.collect) {
        const collectedData: Record<string, unknown> = {};
        // The structured response includes both base fields and collected extraction fields
        const structuredData = result.structured as AgentStructuredResponse &
          Record<string, unknown>;

        for (const field of nextStep.collect) {
          if (field in structuredData) {
            collectedData[field] = structuredData[field];
          }
        }

        // Merge collected data into session
        if (Object.keys(collectedData).length > 0) {
          session = await this.updateData(session, collectedData);
          logger.debug(`[Agent] Collected data:`, collectedData);
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

      // Get endStep spec from route
      const endStepSpec = selectedRoute.endStepSpec;

      // Create a temporary step for completion message generation using endStep configuration
      const completionStep = new Step<TContext, unknown>(selectedRoute.id, {
        description: endStepSpec.description,
        id: endStepSpec.id || END_ROUTE_ID,
        collect: endStepSpec.collect,
        requires: endStepSpec.requires,
        prompt:
          endStepSpec.prompt ||
          "Summarize what was accomplished and confirm completion based on the conversation history and collected data",
      });

      // Build response schema for completion
      const responseSchema = this.responseEngine.responseSchemaForRoute(
        selectedRoute,
        completionStep
      );
      const templateContext = {
        context: effectiveContext,
        session,
        history,
      };

      // Build completion response prompt
      const completionPrompt = await this.responseEngine.buildResponsePrompt({
        route: selectedRoute,
        currentStep: completionStep,
        rules: selectedRoute.getRules(),
        prohibitions: selectedRoute.getProhibitions(),
        directives: undefined, // No directives for completion
        history,
        lastMessage: lastUserMessage,
        agentOptions: this.options,
        // Combine agent and route properties according to the specified logic
        combinedGuidelines: [
          ...this.getGuidelines(),
          ...selectedRoute.getGuidelines(),
        ],
        combinedTerms: this.mergeTerms(
          this.getTerms(),
          selectedRoute.getTerms()
        ),
        combinedCapabilities: [
          ...this.getCapabilities(),
          ...selectedRoute.getCapabilities(),
        ],
        context: effectiveContext,
        session,
      });

      // Generate completion message using AI provider
      const completionResult = await this.options.provider.generateMessage({
        prompt: completionPrompt,
        history,
        context: effectiveContext,
        signal,
        parameters: {
          jsonSchema: responseSchema,
          schemaName: "completion_message",
        },
      });

      message =
        completionResult.structured?.message || completionResult.message;
      logger.debug(
        `[Agent] Generated completion message for route: ${selectedRoute.title}`
      );

      // Check for onComplete transition
      const transitionConfig = await selectedRoute.evaluateOnComplete(
        { data: session.data },
        effectiveContext
      );

      if (transitionConfig) {
        // Find target route by ID or title
        const targetRoute = this.routes.find(
          (r) =>
            r.id === transitionConfig.nextStep ||
            r.title === transitionConfig.nextStep
        );

        if (targetRoute) {
          const renderedCondition = await render(
            transitionConfig.condition,
            templateContext
          );
          // Set pending transition in session
          session = {
            ...session,
            pendingTransition: {
              targetRouteId: targetRoute.id,
              condition: renderedCondition,
              reason: "route_complete",
            },
          };
          logger.debug(
            `[Agent] Route ${selectedRoute.title} completed with pending transition to: ${targetRoute.title}`
          );
        } else {
          logger.warn(
            `[Agent] Route ${selectedRoute.title} completed but target route not found: ${transitionConfig.nextStep}`
          );
        }
      }

      // Set step to END_ROUTE marker
      session = enterStep(session, END_ROUTE_ID, "Route completed");
      logger.debug(
        `[Agent] Route ${selectedRoute.title} completed. Entered END_ROUTE step.`
      );
    } else {
      // Fallback: No routes defined, generate a simple response
      const fallbackPrompt = await this.responseEngine.buildFallbackPrompt({
        history,
        agentOptions: this.options,
        terms: this.terms,
        guidelines: this.guidelines,
        capabilities: this.capabilities,
        context: effectiveContext,
        session,
      });

      const result = await this.options.provider.generateMessage({
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

    // Auto-save session step to persistence if configured
    if (
      this.persistenceManager &&
      session.id &&
      this.options.persistence?.autoSave !== false
    ) {
      await this.persistenceManager.saveSessionState(session.id, session);
      logger.debug(
        `[Agent] Auto-saved session step to persistence: ${session.id}`
      );
    }

    // Update current session if we have one
    if (this.currentSession) {
      this.currentSession = session;
    }

    return {
      message,
      session, // Return updated session with route/step info
      toolCalls,
      isRouteComplete, // Indicates if the route has reached END_ROUTE with all data collected
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
  getTerms(): Term<TContext>[] {
    return [...this.terms];
  }

  /**
   * Get all guidelines
   */
  getGuidelines(): Guideline<TContext>[] {
    return [...this.guidelines];
  }

  /**
   * Get all capabilities
   */
  getCapabilities(): Capability[] {
    return [...this.capabilities];
  }

  /**
   * Get the agent's knowledge base
   */
  getKnowledgeBase(): Record<string, unknown> {
    return { ...this.knowledgeBase };
  }

  /**
   * Get the domain registry
   */
  getDomainRegistry(): DomainRegistry {
    return this.domainRegistry;
  }

  /**
   * Merge terms with route-specific taking precedence on conflicts
   * @private
   */
  private mergeTerms(
    agentTerms: Term<TContext>[],
    routeTerms: Term<TContext>[]
  ): Term<TContext>[] {
    const merged = new Map<string, Term<TContext>>();

    // Add agent terms first
    agentTerms.forEach((term) => {
      const name =
        typeof term.name === "string" ? term.name : term.name.toString();
      merged.set(name, term);
    });

    // Add route terms (these take precedence)
    routeTerms.forEach((term) => {
      const name =
        typeof term.name === "string" ? term.name : term.name.toString();
      merged.set(name, term);
    });

    return Array.from(merged.values());
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
   * @param session - Session step to use for subsequent calls
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
   * Get collected data from current session
   * @param routeId - Optional route ID to get data for (uses current route if not provided)
   * @returns The collected data from the current session
   */
  getData<TData = unknown>(routeId?: string): Partial<TData> {
    if (!this.currentSession) {
      return {} as Partial<TData>;
    }
    if (routeId) {
      return (
        (this.currentSession.dataByRoute?.[routeId] as Partial<TData>) ||
        ({} as Partial<TData>)
      );
    }
    return (this.currentSession.data as Partial<TData>) || {};
  }

  /**
   * Manually transition to a different route
   * Sets a pending transition that will be executed on the next respond() call
   *
   * @param routeIdOrTitle - Route ID or title to transition to
   * @param session - Session step to update (uses current session if not provided)
   * @param condition - Optional AI-evaluated condition for the transition
   * @returns Updated session with pending transition
   *
   * @example
   * // After route completes
   * if (response.isRouteComplete && response.session) {
   *   const updatedSession = agent.nextStepRoute("feedback-collection", response.session);
   *   // Next respond() call will automatically transition to feedback route
   *   const nextResponse = await agent.respond({ history, session: updatedSession });
   * }
   */
  async nextStepRoute(
    routeIdOrTitle: string,
    session?: SessionState,
    condition?: Template<TContext, unknown>,
    history?: Event[]
  ): Promise<SessionState> {
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
        `Route not found: ${routeIdOrTitle}. Available routes: ${this.routes
          .map((r) => r.title)
          .join(", ")}`
      );
    }
    const templateContext = {
      context: this.context,
      session,
      history,
      data: this.currentSession?.data,
    };
    const renderedCondition = await render(condition, templateContext);

    const updatedSession: SessionState = {
      ...targetSession,
      pendingTransition: {
        targetRouteId: targetRoute.id,
        condition: renderedCondition,
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
