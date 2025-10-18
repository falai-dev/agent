/**
 * Core Agent implementation
 */

import type {
  AgentOptions,
  Term,
  Guideline,
  Tool,
  Event,
  RouteOptions,
  SessionState,
  AgentStructuredResponse,
  Template,
  StepRef,
} from "../types";
import { EventKind, EventSource } from "../types/history";
import {
  createSession,
  enterRoute,
  enterStep,
  mergeCollected,
  logger,
  LoggerLevel,
  render,
  getLastMessageFromHistory,
} from "../utils";

import { Route } from "./Route";
import { Step } from "./Step";
import { PersistenceManager } from "./PersistenceManager";
import { RoutingEngine } from "./RoutingEngine";
import { ResponseEngine } from "./ResponseEngine";
import { ToolExecutor } from "./ToolExecutor";
import { ResponsePipeline } from "./ResponsePipeline";
import { END_ROUTE_ID } from "../constants";

/**
 * Main Agent class with generic context support
 */
export class Agent<TContext = unknown> {
  private terms: Term<TContext>[] = [];
  private guidelines: Guideline<TContext>[] = [];
  private tools: Tool<TContext, unknown[], unknown, unknown>[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private routes: Route<TContext, any>[] = [];
  private context: TContext | undefined;
  private persistenceManager: PersistenceManager | undefined;
  private routingEngine: RoutingEngine<TContext>;
  private responseEngine: ResponseEngine<TContext>;
  private responsePipeline: ResponsePipeline<TContext>;
  private currentSession?: SessionState;
  private knowledgeBase: Record<string, unknown> = {};

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
    this.responsePipeline = new ResponsePipeline<TContext>(
      options,
      this.routes,
      this.tools,
      this.routingEngine,
      this.updateContext.bind(this),
      this.updateData.bind(this)
    );

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

    if (options.tools) {
      options.tools.forEach((tool) => {
        this.createTool(tool);
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
   * Register a tool at the agent level
   */
  createTool(tool: Tool<TContext, unknown[], unknown, unknown>): this {
    this.tools.push(tool);
    return this;
  }

  /**
   * Register multiple tools at the agent level
   */
  registerTools(tools: Tool<TContext, unknown[], unknown, unknown>[]): this {
    tools.forEach((tool) => this.createTool(tool));
    return this;
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
    const { history, signal } = params;

    // Prepare context and session using the response pipeline
    this.responsePipeline.setContext(this.context);
    this.responsePipeline.setCurrentSession(this.currentSession);
    let session: SessionState;
    const responseContext = await this.responsePipeline.prepareResponseContext({
      contextOverride: params.contextOverride,
      session: params.session,
    });
    const { effectiveContext } = responseContext;
    session = responseContext.session;
    // Update our stored context if it was modified by beforeRespond hook
    this.context = this.responsePipeline.getStoredContext();

    // PHASE 1: PREPARE - Execute prepare function if current step has one
    if (session.currentRoute && session.currentStep) {
      const currentRoute = this.routes.find(
        (r) => r.id === session.currentRoute?.id
      );
      if (currentRoute) {
        const currentStep = currentRoute.getStep(session.currentStep.id);
        if (currentStep?.prepare) {
          logger.debug(
            `[Agent] Executing prepare function for step: ${currentStep.id}`
          );
          await currentStep.prepare(effectiveContext, session.data);
        }
      }
    }

    // PHASE 2: ROUTING + STEP SELECTION - Use response pipeline
    const routingResult =
      await this.responsePipeline.handleRoutingAndStepSelection({
        session,
        history,
        context: effectiveContext,
        signal,
      });
    const selectedRoute = routingResult.selectedRoute;
    const selectedStep = routingResult.selectedStep;
    const responseDirectives = routingResult.responseDirectives;
    const isRouteComplete = routingResult.isRouteComplete;
    session = routingResult.session;

    // PHASE 3: DETERMINE NEXT STEP - Use pipeline method
    const stepResult = this.responsePipeline.determineNextStep({
      selectedRoute,
      selectedStep,
      session,
      isRouteComplete,
    });
    const nextStep = stepResult.nextStep;
    session = stepResult.session;

    if (selectedRoute && !isRouteComplete) {
      // PHASE 4: RESPONSE GENERATION - Stream message using selected route and step
      // Get last user message
      const lastUserMessage = getLastMessageFromHistory(history);

      // Build response schema for this route (with collect fields from step)
      const responseSchema = this.responseEngine.responseSchemaForRoute(
        selectedRoute,
        nextStep
      );

      // Check if selected route and next step are defined
      if (!selectedRoute || !nextStep) {
        logger.error("[Agent] Selected route or next step is not defined", {
          selectedRoute,
          nextStep,
        });
        throw new Error("Selected route or next step is not defined");
      }

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
        context: effectiveContext,
        session,
      });

      // Collect available tools for AI
      const availableTools = this.collectAvailableTools(
        selectedRoute,
        nextStep
      );

      // Generate message stream using AI provider
      const stream = this.options.provider.generateMessageStream({
        prompt: responsePrompt,
        history,
        context: effectiveContext,
        tools: availableTools,
        signal,
        parameters: {
          jsonSchema: responseSchema,
          schemaName: "response_stream_output",
        },
      });

      // Stream chunks to caller
      for await (const chunk of stream) {
        let toolCalls:
          | Array<{ toolName: string; arguments: Record<string, unknown> }>
          | undefined = undefined;

        // Extract tool calls from AI response on final chunk
        if (chunk.done && chunk.structured?.toolCalls) {
          toolCalls = chunk.structured.toolCalls;

          // Execute dynamic tool calls
          if (toolCalls.length > 0) {
            logger.debug(
              `[Agent] Executing ${toolCalls.length} dynamic tool calls`
            );

            for (const toolCall of toolCalls) {
              const tool = this.findAvailableTool(
                toolCall.toolName,
                selectedRoute
              );
              if (!tool) {
                logger.warn(`[Agent] Tool not found: ${toolCall.toolName}`);
                continue;
              }

              const toolExecutor = new ToolExecutor<TContext, unknown>();
              const result = await toolExecutor.executeTool({
                tool: tool,
                context: effectiveContext,
                updateContext: this.updateContext.bind(this),
                history,
                data: session.data,
              });

              // Update context with tool results
              if (result.contextUpdate) {
                await this.updateContext(
                  result.contextUpdate as Partial<TContext>
                );
              }

              // Update collected data with tool results
              if (result.collectedUpdate) {
                session = await this.updateData(
                  session,
                  result.collectedUpdate
                );
                logger.debug(
                  `[Agent] Tool updated collected data:`,
                  result.collectedUpdate
                );
              }

              logger.debug(
                `[Agent] Executed dynamic tool: ${result.toolName} (success: ${result.success})`
              );
            }
          }
        }

        // TOOL LOOP: Allow AI to make follow-up tool calls after initial tool execution (streaming)
        const MAX_TOOL_LOOPS = 5;
        let toolLoopCount = 0;
        let hasToolCalls = toolCalls && toolCalls.length > 0;

        while (hasToolCalls && toolLoopCount < MAX_TOOL_LOOPS) {
          toolLoopCount++;
          logger.debug(
            `[Agent] Starting streaming tool loop ${toolLoopCount}/${MAX_TOOL_LOOPS}`
          );

          // Add tool execution results to history so AI knows what happened
          const toolResultsEvents: Event[] = [];
          for (const toolCall of toolCalls || []) {
            const tool = this.findAvailableTool(
              toolCall.toolName,
              selectedRoute
            );
            if (tool) {
              toolResultsEvents.push({
                kind: EventKind.TOOL,
                source: EventSource.AI_AGENT,
                timestamp: new Date().toISOString(),
                data: {
                  tool_calls: [
                    {
                      tool_id: toolCall.toolName,
                      arguments: toolCall.arguments,
                      result: {
                        data: "Tool executed successfully",
                      },
                    },
                  ],
                },
              });
            }
          }

          // Create updated history with tool results
          const updatedHistory = [...history, ...toolResultsEvents];

          // Make follow-up streaming AI call to see if more tools are needed
          const followUpStream = this.options.provider.generateMessageStream({
            prompt: responsePrompt,
            history: updatedHistory,
            context: effectiveContext,
            tools: availableTools,
            parameters: {
              jsonSchema: responseSchema,
              schemaName: "tool_followup",
            },
            signal,
          });

          let followUpToolCalls:
            | Array<{ toolName: string; arguments: Record<string, unknown> }>
            | undefined;

          for await (const followUpChunk of followUpStream) {
            // Extract tool calls from follow-up stream
            if (followUpChunk.done && followUpChunk.structured?.toolCalls) {
              followUpToolCalls = followUpChunk.structured.toolCalls;
            }
          }

          hasToolCalls = followUpToolCalls && followUpToolCalls.length > 0;

          if (hasToolCalls) {
            logger.debug(
              `[Agent] Follow-up streaming call produced ${
                followUpToolCalls!.length
              } additional tool calls`
            );

            // Execute the follow-up tool calls
            for (const toolCall of followUpToolCalls!) {
              const tool = this.findAvailableTool(
                toolCall.toolName,
                selectedRoute
              );
              if (!tool) {
                logger.warn(
                  `[Agent] Tool not found in streaming follow-up: ${toolCall.toolName}`
                );
                continue;
              }

              const toolExecutor = new ToolExecutor<TContext, unknown>();
              const result = await toolExecutor.executeTool({
                tool: tool,
                context: effectiveContext,
                updateContext: this.updateContext.bind(this),
                history: updatedHistory,
                data: session.data,
              });

              // Update context with follow-up tool results
              if (result.contextUpdate) {
                await this.updateContext(
                  result.contextUpdate as Partial<TContext>
                );
              }

              if (result.collectedUpdate) {
                session = await this.updateData(
                  session,
                  result.collectedUpdate
                );
                logger.debug(
                  `[Agent] Streaming follow-up tool updated collected data:`,
                  result.collectedUpdate
                );
              }

              logger.debug(
                `[Agent] Executed streaming follow-up tool: ${result.toolName} (success: ${result.success})`
              );
            }

            // Update toolCalls for next iteration
            toolCalls = followUpToolCalls;
          } else {
            logger.debug(
              `[Agent] Streaming tool loop completed after ${toolLoopCount} iterations`
            );
            // Update toolCalls for final response
            toolCalls = followUpToolCalls || [];
            break;
          }
        }

        if (toolLoopCount >= MAX_TOOL_LOOPS) {
          logger.warn(
            `[Agent] Streaming tool loop limit reached (${MAX_TOOL_LOOPS}), stopping`
          );
        }

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

        // Execute finalize function on final chunk
        if (chunk.done && session.currentRoute && session.currentStep) {
          const currentRoute = this.routes.find(
            (r) => r.id === session.currentRoute?.id
          );
          if (currentRoute) {
            const currentStep = currentRoute.getStep(session.currentStep.id);
            if (currentStep?.finalize) {
              logger.debug(
                `[Agent] Executing finalize function for step: ${currentStep.id}`
              );
              await currentStep.finalize(effectiveContext, session.data);
            }
          }
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

    // PHASE 1: PREPARE - Execute prepare function if current step has one
    if (session.currentRoute && session.currentStep) {
      const currentRoute = this.routes.find(
        (r) => r.id === session.currentRoute?.id
      );
      if (currentRoute) {
        const currentStep = currentRoute.getStep(session.currentStep.id);
        if (currentStep?.prepare) {
          logger.debug(
            `[Agent] Executing prepare function for step: ${currentStep.id}`
          );
          await currentStep.prepare(effectiveContext, session.data);
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
    let toolCalls:
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
        context: effectiveContext,
        session,
      });

      // Collect available tools for AI
      const availableTools = this.collectAvailableTools(
        selectedRoute,
        nextStep
      );

      // Generate message using AI provider
      const result = await this.options.provider.generateMessage({
        prompt: responsePrompt,
        history,
        context: effectiveContext,
        tools: availableTools,
        signal,
        parameters: {
          jsonSchema: responseSchema,
          schemaName: "response_output",
        },
      });

      message = result.structured?.message || result.message;

      // Process dynamic tool calls from AI response
      if (result.structured?.toolCalls) {
        toolCalls = result.structured.toolCalls;

        // Execute dynamic tool calls
        if (toolCalls.length > 0) {
          logger.debug(
            `[Agent] Executing ${toolCalls.length} dynamic tool calls`
          );

          for (const toolCall of toolCalls) {
            const tool = this.findAvailableTool(
              toolCall.toolName,
              selectedRoute
            );
            if (!tool) {
              logger.warn(`[Agent] Tool not found: ${toolCall.toolName}`);
              continue;
            }

            const toolExecutor = new ToolExecutor<TContext, unknown>();
            const toolResult = await toolExecutor.executeTool({
              tool: tool,
              context: effectiveContext,
              updateContext: this.updateContext.bind(this),
              history,
              data: session.data,
            });

            // Update context with tool results
            if (toolResult.contextUpdate) {
              await this.updateContext(
                toolResult.contextUpdate as Partial<TContext>
              );
            }

            // Update collected data with tool results
            if (toolResult.collectedUpdate) {
              session = await this.updateData(
                session,
                toolResult.collectedUpdate
              );
              logger.debug(
                `[Agent] Tool updated collected data:`,
                toolResult.collectedUpdate
              );
            }

            logger.debug(
              `[Agent] Executed dynamic tool: ${toolResult.toolName} (success: ${toolResult.success})`
            );
          }
        }
      }

      // TOOL LOOP: Allow AI to make follow-up tool calls after initial tool execution
      const MAX_TOOL_LOOPS = 5;
      let toolLoopCount = 0;
      let hasToolCalls = toolCalls && toolCalls.length > 0;

      while (hasToolCalls && toolLoopCount < MAX_TOOL_LOOPS) {
        toolLoopCount++;
        logger.debug(
          `[Agent] Starting tool loop ${toolLoopCount}/${MAX_TOOL_LOOPS}`
        );

        // Add tool execution results to history so AI knows what happened
        const toolResultsEvents: Event[] = [];
        for (const toolCall of toolCalls || []) {
          const tool = this.findAvailableTool(toolCall.toolName, selectedRoute);
          if (tool) {
            toolResultsEvents.push({
              kind: EventKind.TOOL,
              source: EventSource.AI_AGENT,
              timestamp: new Date().toISOString(),
              data: {
                tool_calls: [
                  {
                    tool_id: toolCall.toolName,
                    arguments: toolCall.arguments,
                    result: {
                      data: "Tool executed successfully",
                    },
                  },
                ],
              },
            });
          }
        }

        // Create updated history with tool results
        const updatedHistory = [...history, ...toolResultsEvents];

        // Make follow-up AI call to see if more tools are needed
        const followUpResult = await this.options.provider.generateMessage({
          prompt: responsePrompt,
          history: updatedHistory,
          context: effectiveContext,
          tools: availableTools,
          parameters: {
            jsonSchema: responseSchema,
            schemaName: "tool_followup",
          },
          signal,
        });

        // Check if follow-up call has more tool calls
        const followUpToolCalls = followUpResult.structured?.toolCalls;
        hasToolCalls = followUpToolCalls && followUpToolCalls.length > 0;

        if (hasToolCalls) {
          logger.debug(
            `[Agent] Follow-up call produced ${
              followUpToolCalls!.length
            } additional tool calls`
          );

          // Execute the follow-up tool calls
          for (const toolCall of followUpToolCalls!) {
            const tool = this.findAvailableTool(
              toolCall.toolName,
              selectedRoute
            );
            if (!tool) {
              logger.warn(
                `[Agent] Tool not found in follow-up: ${toolCall.toolName}`
              );
              continue;
            }

            const toolExecutor = new ToolExecutor<TContext, unknown>();
            const toolResult = await toolExecutor.executeTool({
              tool: tool,
              context: effectiveContext,
              updateContext: this.updateContext.bind(this),
              history: updatedHistory,
              data: session.data,
            });

            // Update context with follow-up tool results
            if (toolResult.contextUpdate) {
              await this.updateContext(
                toolResult.contextUpdate as Partial<TContext>
              );
            }

            if (toolResult.collectedUpdate) {
              session = await this.updateData(
                session,
                toolResult.collectedUpdate
              );
              logger.debug(
                `[Agent] Follow-up tool updated collected data:`,
                toolResult.collectedUpdate
              );
            }

            logger.debug(
              `[Agent] Executed follow-up tool: ${toolResult.toolName} (success: ${toolResult.success})`
            );
          }

          // Update toolCalls for next iteration or final response
          toolCalls = followUpToolCalls;
        } else {
          logger.debug(
            `[Agent] Tool loop completed after ${toolLoopCount} iterations`
          );
          // Update final message and toolCalls from follow-up result if no more tools
          message =
            followUpResult.structured?.message || followUpResult.message;
          toolCalls = followUpToolCalls || [];
          break;
        }
      }

      if (toolLoopCount >= MAX_TOOL_LOOPS) {
        logger.warn(
          `[Agent] Tool loop limit reached (${MAX_TOOL_LOOPS}), stopping`
        );
      }

      // Extract collected data from final response
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

    // Execute finalize function
    if (session.currentRoute && session.currentStep) {
      const currentRoute = this.routes.find(
        (r) => r.id === session.currentRoute?.id
      );
      if (currentRoute) {
        const currentStep = currentRoute.getStep(session.currentStep.id);
        if (currentStep?.finalize) {
          logger.debug(
            `[Agent] Executing finalize function for step: ${currentStep.id}`
          );
          await currentStep.finalize(effectiveContext, session.data);
        }
      }
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
   * Get all tools
   */
  getTools(): Tool<TContext, unknown[], unknown, unknown>[] {
    return [...this.tools];
  }

  /**
   * Find an available tool by name for the given route
   * Route-level tools take precedence over agent-level tools
   * @private
   */
  private findAvailableTool(
    toolName: string,
    route?: Route<TContext, unknown>
  ): Tool<TContext, unknown[], unknown, unknown> | undefined {
    // Check route-level tools first (if route provided)
    if (route) {
      const routeTool = route.getTools().find((tool) => tool.id === toolName);
      if (routeTool) return routeTool;
    }

    // Fall back to agent-level tools
    return this.tools.find((tool) => tool.id === toolName);
  }

  /**
   * Collect all available tools for the given route and step context
   * @private
   */
  private collectAvailableTools(
    route?: Route<TContext, unknown>,
    step?: Step<TContext, unknown>
  ): Array<{ id: string; description?: string; parameters?: unknown }> {
    const availableTools = new Map<
      string,
      Tool<TContext, unknown[], unknown, unknown>
    >();

    // Add agent-level tools
    this.tools.forEach((tool) => {
      availableTools.set(tool.id, tool);
    });

    // Add route-level tools (these take precedence)
    if (route) {
      route.getTools().forEach((tool) => {
        availableTools.set(tool.id, tool);
      });
    }

    // Filter by step-level allowed tools if specified
    if (step?.tools) {
      const allowedToolIds = new Set<string>();
      const stepTools: Tool<TContext, unknown[], unknown, unknown>[] = [];

      for (const toolRef of step.tools) {
        if (typeof toolRef === "string") {
          // Reference to registered tool
          allowedToolIds.add(toolRef);
        } else {
          // Inline tool definition
          if (toolRef.id) {
            allowedToolIds.add(toolRef.id);
            stepTools.push(toolRef);
          }
        }
      }

      // If step specifies tools, only include those
      if (allowedToolIds.size > 0) {
        const filteredTools = new Map<
          string,
          Tool<TContext, unknown[], unknown, unknown>
        >();
        for (const toolId of allowedToolIds) {
          const tool = availableTools.get(toolId);
          if (tool) {
            filteredTools.set(toolId, tool);
          }
        }
        // Add inline tools
        stepTools.forEach((tool) => {
          if (tool.id) {
            filteredTools.set(tool.id, tool);
          }
        });
        availableTools.clear();
        filteredTools.forEach((tool, id) => availableTools.set(id, tool));
      }
    }

    // Convert to the format expected by AI providers
    return Array.from(availableTools.values()).map((tool) => ({
      id: tool.id,
      description: tool.description,
      parameters: tool.parameters,
    }));
  }

  /**
   * Get all guidelines
   */
  getGuidelines(): Guideline<TContext>[] {
    return [...this.guidelines];
  }

  /**
   * Get the agent's knowledge base
   */
  getKnowledgeBase(): Record<string, unknown> {
    return { ...this.knowledgeBase };
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
