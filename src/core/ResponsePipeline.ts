/**
 * Response processing utilities shared between respond() and respondStream() methods
 */

import type {
  AgentOptions,
  Event,
  SessionState,
  AgentStructuredResponse,
  Tool,
} from "../types";
import { EventKind, EventSource } from "../types/history";
import {
  createSession,
  enterRoute,
  enterStep,
  mergeCollected,
  logger,
  render,
} from "../utils";
import { Route } from "../core/Route";
import { Step } from "../core/Step";
import { RoutingEngine } from "../core/RoutingEngine";
import { ToolExecutor } from "../core/ToolExecutor";
import { END_ROUTE_ID } from "../constants";

export interface ResponsePreparationResult<TContext> {
  effectiveContext: TContext;
  session: SessionState;
}

export interface RoutingResult<TContext> {
  selectedRoute: Route<TContext, unknown> | undefined;
  selectedStep: Step<TContext, unknown> | undefined;
  responseDirectives: string[] | undefined;
  session: SessionState;
  isRouteComplete: boolean;
}

export interface ToolExecutionResult {
  session: SessionState;
  toolCalls:
    | Array<{ toolName: string; arguments: Record<string, unknown> }>
    | undefined;
}

export interface DataCollectionResult {
  session: SessionState;
  collectedData?: Record<string, unknown>;
}

/**
 * Shared response processing logic between respond() and respondStream() methods
 */
export class ResponsePipeline<TContext = unknown> {
  constructor(
    private readonly options: AgentOptions<TContext>,
    private readonly routes: Route<TContext, unknown>[],
    private readonly tools: Tool<TContext, unknown[], unknown, unknown>[],
    private readonly routingEngine: RoutingEngine<TContext>,
    private readonly updateContext: (
      updates: Partial<TContext>
    ) => Promise<void>,
    private readonly updateData: (
      session: SessionState,
      collectedUpdate: Partial<unknown>
    ) => Promise<SessionState>
  ) {}

  /**
   * Prepare context and session for response generation
   */
  async prepareResponseContext(params: {
    contextOverride?: Partial<TContext>;
    session?: SessionState;
  }): Promise<ResponsePreparationResult<TContext>> {
    const { contextOverride, session } = params;

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
    const targetSession = session || this.currentSession || createSession();

    return {
      effectiveContext,
      session: targetSession,
    };
  }

  /**
   * Handle routing and step selection logic
   */
  async handleRoutingAndStepSelection(params: {
    session: SessionState;
    history: Event[];
    context: TContext;
    signal?: AbortSignal;
  }): Promise<RoutingResult<TContext>> {
    const { session, history, context, signal } = params;

    // PHASE 2: ROUTING + STEP SELECTION - Determine which route and step to use (combined)
    let selectedRoute: Route<TContext, unknown> | undefined;
    let responseDirectives: string[] | undefined;
    let selectedStep: Step<TContext, unknown> | undefined;
    let isRouteComplete = false;
    let targetSession = session;

    // Check for pending transition from previous route completion
    if (targetSession.pendingTransition) {
      const targetRoute = this.routes.find(
        (r) => r.id === targetSession.pendingTransition?.targetRouteId
      );

      if (targetRoute) {
        logger.debug(
          `[ResponseHandler] Auto-transitioning from pending transition to route: ${targetRoute.title}`
        );
        // Clear pending transition and enter new route
        targetSession = {
          ...targetSession,
          pendingTransition: undefined,
        };
        targetSession = enterRoute(
          targetSession,
          targetRoute.id,
          targetRoute.title
        );

        // Merge initial data if available
        if (targetRoute.initialData) {
          targetSession = mergeCollected(
            targetSession,
            targetRoute.initialData
          );
        }

        selectedRoute = targetRoute;
      } else {
        logger.warn(
          `[ResponseHandler] Pending transition target route not found: ${targetSession.pendingTransition.targetRouteId}`
        );
        // Clear invalid transition
        targetSession = {
          ...targetSession,
          pendingTransition: undefined,
        };
      }
    }

    // If no pending transition or transition handled, do normal routing
    if (this.routes.length > 0 && !selectedRoute) {
      const orchestration = await this.routingEngine.decideRouteAndStep({
        routes: this.routes,
        session: targetSession,
        history,
        agentOptions: this.options,
        provider: this.options.provider,
        context,
        signal,
      });

      selectedRoute = orchestration.selectedRoute;
      selectedStep = orchestration.selectedStep;
      responseDirectives = orchestration.responseDirectives;
      targetSession = orchestration.session;
      isRouteComplete = orchestration.isRouteComplete || false;

      // Log if route is complete
      if (isRouteComplete) {
        logger.debug(
          `[ResponseHandler] Route complete: all required data collected, END_ROUTE reached`
        );
      }
    }

    return {
      selectedRoute,
      selectedStep,
      responseDirectives,
      session: targetSession,
      isRouteComplete,
    };
  }

  /**
   * Determine next step and update session
   */
  determineNextStep(params: {
    selectedRoute: Route<TContext, unknown> | undefined;
    selectedStep: Step<TContext, unknown> | undefined;
    session: SessionState;
    isRouteComplete: boolean;
  }): { nextStep: Step<TContext, unknown> | undefined; session: SessionState } {
    const { selectedRoute, selectedStep, session, isRouteComplete } = params;

    if (!selectedRoute || isRouteComplete) {
      return { nextStep: undefined, session };
    }

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
          `[ResponseHandler] Using first valid step: ${nextStep.id} for new route`
        );
      } else {
        // Fallback to initial step even if it should be skipped
        nextStep = selectedRoute.initialStep;
        logger.warn(
          `[ResponseHandler] No valid steps found, using initial step: ${nextStep.id}`
        );
      }
    }

    // Update session with next step
    const updatedSession = enterStep(
      session,
      nextStep.id,
      nextStep.description
    );
    logger.debug(`[ResponseHandler] Entered step: ${nextStep.id}`);

    return { nextStep, session: updatedSession };
  }

  /**
   * Execute tool calls and handle results
   */
  async executeToolCalls(params: {
    toolCalls: Array<{ toolName: string; arguments: Record<string, unknown> }>;
    selectedRoute?: Route<TContext, unknown>;
    context: TContext;
    session: SessionState;
    history: Event[];
    isStreaming?: boolean;
  }): Promise<ToolExecutionResult> {
    const {
      toolCalls,
      selectedRoute,
      context,
      session,
      history,
      isStreaming = false,
    } = params;

    if (toolCalls.length === 0) {
      return { session, toolCalls: undefined };
    }

    logger.debug(
      `[ResponseHandler] Executing ${toolCalls.length} ${
        isStreaming ? "streaming " : ""
      }tool calls`
    );

    let updatedSession = session;
    const executedToolCalls: Array<{
      toolName: string;
      arguments: Record<string, unknown>;
    }> = [];

    for (const toolCall of toolCalls) {
      const tool = this.findAvailableTool(toolCall.toolName, selectedRoute);
      if (!tool) {
        logger.warn(`[ResponseHandler] Tool not found: ${toolCall.toolName}`);
        continue;
      }

      const toolExecutor = new ToolExecutor<TContext, unknown>();
      const result = await toolExecutor.executeTool({
        tool,
        context,
        updateContext: this.updateContext,
        history,
        data: updatedSession.data,
      });

      executedToolCalls.push(toolCall);

      // Update context with tool results
      if (result.contextUpdate) {
        await this.updateContext(result.contextUpdate as Partial<TContext>);
      }

      // Update collected data with tool results
      if (result.collectedUpdate) {
        updatedSession = await this.updateData(
          updatedSession,
          result.collectedUpdate
        );
        logger.debug(
          `[ResponseHandler] ${
            isStreaming ? "Streaming " : ""
          }Tool updated collected data:`,
          result.collectedUpdate
        );
      }

      logger.debug(
        `[ResponseHandler] Executed ${isStreaming ? "streaming " : ""}tool: ${
          result.toolName
        } (success: ${result.success})`
      );
    }

    return {
      session: updatedSession,
      toolCalls: executedToolCalls.length > 0 ? executedToolCalls : undefined,
    };
  }

  /**
   * Execute tool loop for follow-up tool calls
   */
  async executeToolLoop(params: {
    initialToolCalls:
      | Array<{ toolName: string; arguments: Record<string, unknown> }>
      | undefined;
    selectedRoute?: Route<TContext, unknown>;
    nextStep: Step<TContext, unknown>;
    responsePrompt: string;
    history: Event[];
    context: TContext;
    session: SessionState;
    responseSchema: Record<string, unknown>;
    isStreaming?: boolean;
  }): Promise<ToolExecutionResult> {
    const {
      initialToolCalls,
      selectedRoute,
      nextStep,
      responsePrompt,
      history,
      context,
      session,
      responseSchema,
      isStreaming = false,
    } = params;

    const MAX_TOOL_LOOPS = 5;
    let toolLoopCount = 0;
    let currentToolCalls = initialToolCalls;
    let hasToolCalls = currentToolCalls && currentToolCalls.length > 0;
    let currentSession = session;

    while (hasToolCalls && toolLoopCount < MAX_TOOL_LOOPS) {
      toolLoopCount++;
      logger.debug(
        `[ResponseHandler] Starting ${
          isStreaming ? "streaming " : ""
        }tool loop ${toolLoopCount}/${MAX_TOOL_LOOPS}`
      );

      // Add tool execution results to history so AI knows what happened
      const toolResultsEvents: Event[] = [];
      for (const toolCall of currentToolCalls || []) {
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
        context,
        tools: this.collectAvailableTools(selectedRoute, nextStep),
        parameters: {
          jsonSchema: responseSchema,
          schemaName: isStreaming ? "tool_followup_streaming" : "tool_followup",
        },
      });

      // Check if follow-up call has more tool calls
      const followUpToolCalls = followUpResult.structured?.toolCalls;
      hasToolCalls = followUpToolCalls && followUpToolCalls.length > 0;

      if (hasToolCalls) {
        logger.debug(
          `[ResponseHandler] Follow-up call produced ${
            followUpToolCalls!.length
          } additional tool calls`
        );

        // Execute the follow-up tool calls
        const toolResult = await this.executeToolCalls({
          toolCalls: followUpToolCalls!,
          selectedRoute,
          context,
          session: currentSession,
          history: updatedHistory,
          isStreaming,
        });

        currentSession = toolResult.session;
        currentToolCalls = followUpToolCalls;
      } else {
        logger.debug(
          `[ResponseHandler] ${
            isStreaming ? "Streaming " : ""
          }Tool loop completed after ${toolLoopCount} iterations`
        );
        // Update final toolCalls from follow-up result if no more tools
        currentToolCalls = followUpToolCalls || [];
        break;
      }
    }

    if (toolLoopCount >= MAX_TOOL_LOOPS) {
      logger.warn(
        `[ResponseHandler] ${
          isStreaming ? "Streaming " : ""
        }Tool loop limit reached (${MAX_TOOL_LOOPS}), stopping`
      );
    }

    return {
      session: currentSession,
      toolCalls: currentToolCalls,
    };
  }

  /**
   * Handle data collection from structured response
   */
  async handleDataCollection(params: {
    structured: AgentStructuredResponse | undefined;
    nextStep: Step<TContext, unknown>;
    session: SessionState;
  }): Promise<DataCollectionResult> {
    const { structured, nextStep, session } = params;

    if (!structured || !nextStep.collect) {
      return { session };
    }

    const collectedData: Record<string, unknown> = {};
    // The structured response includes both base fields and collected extraction fields
    const structuredData = structured as AgentStructuredResponse &
      Record<string, unknown>;

    for (const field of nextStep.collect) {
      if (field in structuredData) {
        collectedData[field] = structuredData[field];
      }
    }

    let updatedSession = session;
    if (Object.keys(collectedData).length > 0) {
      updatedSession = await this.updateData(session, collectedData);
      logger.debug(`[ResponseHandler] Collected data:`, collectedData);
    }

    return {
      session: updatedSession,
      collectedData,
    };
  }

  /**
   * Handle context updates from structured response
   */
  async handleContextUpdate(
    structured: AgentStructuredResponse | undefined
  ): Promise<void> {
    if (
      structured &&
      typeof structured === "object" &&
      "contextUpdate" in structured
    ) {
      await this.updateContext(
        (structured as { contextUpdate?: Partial<TContext> })
          .contextUpdate as Partial<TContext>
      );
    }
  }

  /**
   * Handle route completion logic
   */
  async handleRouteCompletion(params: {
    selectedRoute: Route<TContext, unknown>;
    session: SessionState;
    context: TContext;
    history: Event[];
  }): Promise<{ session: SessionState; hasTransition: boolean }> {
    const { selectedRoute, session, context, history } = params;

    // Check for onComplete transition
    const transitionConfig = await selectedRoute.evaluateOnComplete(
      { data: session.data },
      context
    );

    if (transitionConfig) {
      // Find target route by ID or title
      const targetRoute = this.routes.find(
        (r) =>
          r.id === transitionConfig.nextStep ||
          r.title === transitionConfig.nextStep
      );

      if (targetRoute) {
        const templateContext = {
          context,
          session,
          history,
        };
        const renderedCondition: string =
          (await render(transitionConfig.condition, templateContext)) ||
          (typeof transitionConfig.condition === "string"
            ? transitionConfig.condition
            : "");

        // Set pending transition in session
        const updatedSession = {
          ...session,
          pendingTransition: {
            targetRouteId: targetRoute.id,
            condition: renderedCondition,
            reason: "route_complete" as const,
          },
        };
        logger.debug(
          `[ResponseHandler] Route ${selectedRoute.title} completed with pending transition to: ${targetRoute.title}`
        );
        return { session: updatedSession, hasTransition: true };
      } else {
        logger.warn(
          `[ResponseHandler] Route ${selectedRoute.title} completed but target route not found: ${transitionConfig.nextStep}`
        );
      }
    }

    // Set step to END_ROUTE marker
    const updatedSession = enterStep(session, END_ROUTE_ID, "Route completed");
    logger.debug(
      `[ResponseHandler] Route ${selectedRoute.title} completed. Entered END_ROUTE step.`
    );

    return { session: updatedSession, hasTransition: false };
  }

  /**
   * Find an available tool by name for the given route
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
   * Get current context (fetches from provider if configured)
   */
  private async getContext(): Promise<TContext | undefined> {
    // If context provider is configured, use it to fetch fresh context
    if (this.options.contextProvider) {
      return await this.options.contextProvider();
    }

    // Otherwise return the stored context
    return this.context;
  }

  // These need to be passed in or accessed differently since ResponseHandler is not part of Agent
  private context?: TContext;
  private currentSession?: SessionState;

  // Setters for context and current session (needed for beforeRespond hook)
  setContext(context: TContext | undefined): void {
    this.context = context;
  }

  setCurrentSession(session: SessionState | undefined): void {
    this.currentSession = session;
  }

  public getStoredContext(): TContext | undefined {
    return this.context;
  }

  public getCurrentSession(): SessionState | undefined {
    return this.currentSession;
  }
}
