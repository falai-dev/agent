/**
 * Response processing utilities shared between respond() and respondStream() methods
 */

import type {
  AgentOptions,
  Event,
  SessionState,
  AgentStructuredResponse,
  Tool,
  RouteTransitionConfig,
} from "../types";
import { EventKind, MessageRole } from "../types/history";
import {
  createSession,
  enterRoute,
  enterStep,
  mergeCollected,
  logger,
  render,
} from "../utils";
import { createTemplateContext } from "../utils/template";
import { Route } from "../core/Route";
import { Step } from "../core/Step";
import { RoutingEngine } from "../core/RoutingEngine";
import type { ToolManager } from "../core/ToolManager";
import { END_ROUTE_ID } from "../constants";

export interface ResponsePreparationResult<TContext, TData = unknown> {
  effectiveContext: TContext;
  session: SessionState<TData>;
}

export interface RoutingResult<TContext, TData = unknown> {
  selectedRoute: Route<TContext, TData> | undefined;
  selectedStep: Step<TContext, TData> | undefined;
  responseDirectives: string[] | undefined;
  session: SessionState<TData>;
  isRouteComplete: boolean;
  completedRoutes?: Route<TContext, TData>[];
}

export interface ToolExecutionResult<TData = unknown> {
  session: SessionState<TData>;
  toolCalls:
  | Array<{ toolName: string; arguments: Record<string, unknown> }>
  | undefined;
}

export interface DataCollectionResult<TData = unknown> {
  session: SessionState<TData>;
  collectedData?: Partial<TData>;
}

/**
 * Shared response processing logic between respond() and respondStream() methods
 */
export class ResponsePipeline<TContext = unknown, TData = unknown> {
  constructor(
    private readonly options: AgentOptions<TContext, TData>,
    private readonly getRoutes: () => Route<TContext, TData>[],
    private readonly tools: Tool<TContext, TData>[],
    private readonly routingEngine: RoutingEngine<TContext, TData>,
    private readonly updateContext: (
      updates: Partial<TContext>
    ) => Promise<void>,
    private readonly updateData: (
      session: SessionState<TData>,
      dataUpdate: Partial<TData>
    ) => Promise<SessionState<TData>>,
    private readonly updateCollectedData?: (
      updates: Partial<TData>
    ) => Promise<void>,
    private readonly toolManager?: ToolManager<TContext, TData>
  ) { }

  /**
   * Prepare context and session for response generation
   */
  async prepareResponseContext(params: {
    contextOverride?: Partial<TContext>;
    session?: SessionState<TData>;
  }): Promise<ResponsePreparationResult<TContext, TData>> {
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
    const targetSession = session || this.currentSession || createSession<TData>();

    return {
      effectiveContext,
      session: targetSession,
    };
  }

  /**
   * Handle routing and step selection logic
   */
  async handleRoutingAndStepSelection(params: {
    session: SessionState<TData>;
    history: Event[];
    context: TContext;
    signal?: AbortSignal;
  }): Promise<RoutingResult<TContext, TData>> {
    const { session, history, context, signal } = params;

    // PHASE 2: ROUTING + STEP SELECTION - Determine which route and step to use (combined)
    let selectedRoute: Route<TContext, TData> | undefined;
    let responseDirectives: string[] | undefined;
    let selectedStep: Step<TContext, TData> | undefined;
    let isRouteComplete = false;
    let completedRoutes: Route<TContext, TData>[] = [];
    let targetSession = session;

    // Get routes early since we need them for pending transitions
    const routes = this.getRoutes();

    // Check for pending transition from previous route completion
    if (targetSession.pendingTransition) {
      const targetRoute = routes.find(
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
    if (routes.length > 0 && !selectedRoute) {
      const orchestration = await this.routingEngine.decideRouteAndStep({
        routes: routes,
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
      completedRoutes = orchestration.completedRoutes || [];

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
      completedRoutes,
    };
  }

  /**
   * Determine next step and update session
   */
  async determineNextStep(params: {
    selectedRoute: Route<TContext, TData> | undefined;
    selectedStep: Step<TContext, TData> | undefined;
    session: SessionState<TData>;
    isRouteComplete: boolean;
  }): Promise<{ nextStep: Step<TContext, TData> | undefined; session: SessionState<TData> }> {
    const { selectedRoute, selectedStep, session, isRouteComplete } = params;

    if (!selectedRoute || isRouteComplete) {
      return { nextStep: undefined, session };
    }

    let nextStep: Step<TContext, TData>;

    // If we have a selected step from the combined routing decision, use it
    if (selectedStep) {
      nextStep = selectedStep;
    } else {
      // Determine current step from session if we're already in this route
      const currentStep = session.currentRoute?.id === selectedRoute.id && session.currentStep
        ? selectedRoute.getStep(session.currentStep.id)
        : undefined;

      const contextToUse = this.getStoredContext();
      // Get candidate steps based on current position in the route
      const candidates = await this.routingEngine.getCandidateStepsWithConditions(
        selectedRoute,
        currentStep, // Pass current step instead of undefined to maintain progression
        createTemplateContext({ data: session.data, session, context: contextToUse })
      );
      
      if (candidates.length > 0) {
        nextStep = candidates[0].step;
        logger.debug(
          `[ResponseHandler] Using first valid step: ${nextStep.id}${currentStep ? ' (progressing from ' + currentStep.id + ')' : ' for new route'}`
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
    selectedRoute?: Route<TContext, TData>;
    context: TContext;
    session: SessionState<TData>;
    history: Event[];
    isStreaming?: boolean;
  }): Promise<ToolExecutionResult<TData>> {
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
      `[ResponseHandler] Executing ${toolCalls.length} ${isStreaming ? "streaming " : ""
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

      // Use ToolManager for unified tool execution
      let result;
      if (this.toolManager) {
        result = await this.toolManager.executeTool({
          tool,
          context,
          updateContext: this.updateContext,
          updateData: this.updateCollectedData || (async () => { }),
          history,
          data: updatedSession.data,
        });
      } else {
        // Fallback: execute tool directly if ToolManager not available
        throw new Error(`ToolManager not available for tool execution: ${toolCall.toolName}`);
      }

      executedToolCalls.push(toolCall);

      // Update context with tool results
      if (result.contextUpdate) {
        await this.updateContext(result.contextUpdate as Partial<TContext>);
      }

      // Update collected data with tool results
      if (result.dataUpdate) {
        updatedSession = await this.updateData(
          updatedSession,
          result.dataUpdate as Partial<TData>
        );
        logger.debug(
          `[ResponseHandler] ${isStreaming ? "Streaming " : ""
          }Tool updated collected data:`,
          result.dataUpdate
        );
      }

      logger.debug(
        `[ResponseHandler] Executed ${isStreaming ? "streaming " : ""}tool: ${String(tool.id || tool.name || 'unknown')
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
    selectedRoute?: Route<TContext, TData>;
    nextStep: Step<TContext, TData>;
    responsePrompt: string;
    history: Event[];
    context: TContext;
    session: SessionState<TData>;
    responseSchema: Record<string, unknown>;
    isStreaming?: boolean;
  }): Promise<ToolExecutionResult<TData>> {
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
        `[ResponseHandler] Starting ${isStreaming ? "streaming " : ""
        }tool loop ${toolLoopCount}/${MAX_TOOL_LOOPS}`
      );

      // Add tool execution results to history so AI knows what happened
      const toolResultsEvents: Event[] = [];
      for (const toolCall of currentToolCalls || []) {
        const tool = this.findAvailableTool(toolCall.toolName, selectedRoute);
        if (tool) {
          toolResultsEvents.push({
            kind: EventKind.TOOL,
            source: MessageRole.AGENT,
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
          `[ResponseHandler] Follow-up call produced ${followUpToolCalls!.length
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
          `[ResponseHandler] ${isStreaming ? "Streaming " : ""
          }Tool loop completed after ${toolLoopCount} iterations`
        );
        // Update final toolCalls from follow-up result if no more tools
        currentToolCalls = followUpToolCalls || [];
        break;
      }
    }

    if (toolLoopCount >= MAX_TOOL_LOOPS) {
      logger.warn(
        `[ResponseHandler] ${isStreaming ? "Streaming " : ""
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
    nextStep: Step<TContext, TData>;
    session: SessionState<TData>;
  }): Promise<DataCollectionResult<TData>> {
    const { structured, nextStep, session } = params;

    if (!structured || !nextStep.collect) {
      return { session };
    }

    const collectedData: Partial<TData> = {};
    // The structured response includes both base fields and collected extraction fields
    const structuredData = structured as AgentStructuredResponse &
      Record<string, unknown>;

    for (const field of nextStep.collect) {
      const fieldKey = field as string;
      if (fieldKey in structuredData) {
        (collectedData as Record<string, unknown>)[fieldKey] = structuredData[fieldKey];
      }
    }

    let updatedSession = session;
    if (Object.keys(collectedData).length > 0) {
      // Update agent-level collected data with validation if available
      if (this.updateCollectedData) {
        await this.updateCollectedData(collectedData);
      }

      // Update session with validated data
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
    selectedRoute: Route<TContext, TData>;
    session: SessionState<TData>;
    context: TContext;
    history: Event[];
  }): Promise<{ session: SessionState<TData>; hasTransition: boolean }> {
    const { selectedRoute, session, context, history } = params;

    // Check for onComplete transition
    const transitionConfig = await selectedRoute.evaluateOnComplete(
      { data: session.data },
      context
    );

    if (transitionConfig) {
      // Find target route by ID or title
      const targetRoute = this.getRoutes().find(
        (r) =>
          r.id === transitionConfig.nextStep ||
          r.title === transitionConfig.nextStep
      );

      if (targetRoute) {
        const templateContext = createTemplateContext({
          context,
          session,
          history,
        });
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
   * Find an available tool by name for the given route using ToolManager
   * Delegates to ToolManager for unified tool resolution
   */
  private findAvailableTool(
    toolName: string,
    route?: Route<TContext, TData>
  ): Tool<TContext, TData> | undefined {
    // Use ToolManager for unified tool resolution if available
    if (this.toolManager) {
      return this.toolManager.find(toolName, undefined, undefined, route);
    }

    // Fallback to legacy resolution if ToolManager not available
    logger.warn(`[ResponsePipeline] ToolManager not available, using legacy tool resolution for: ${toolName}`);

    // Check route-level tools first (if route provided)
    if (route) {
      const routeTool = route
        .getTools()
        .find((tool) => tool.id === toolName || tool.name === toolName);
      if (routeTool) return routeTool;
    }

    // Fall back to agent-level tools
    return this.tools.find(
      (tool) => tool.id === toolName || tool.name === toolName
    );
  }

  /**
   * Collect all available tools for the given route and step context using ToolManager
   * Delegates to ToolManager for unified tool resolution and deduplication
   */
  private collectAvailableTools(
    route?: Route<TContext, TData>,
    step?: Step<TContext, TData>
  ): Array<{ id: string; description?: string; parameters?: unknown }> {
    // Use ToolManager for unified tool collection if available
    if (this.toolManager) {
      const availableTools = this.toolManager.getAvailable(undefined, step, route);
      return availableTools.map((tool) => ({
        id: tool.id,
        description: tool.description,
        parameters: tool.parameters,
      }));
    }

    // Fallback to legacy collection logic if ToolManager not available
    logger.warn(`[ResponsePipeline] ToolManager not available, using legacy tool collection`);

    const availableTools = new Map<
      string,
      Tool<TContext, TData>
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
      const stepTools: Tool<TContext, TData>[] = [];

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
          Tool<TContext, TData>
        >();
        for (const toolId of Array.from(allowedToolIds)) {
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
  private currentSession?: SessionState<TData>;

  // Setters for context and current session (needed for beforeRespond hook)
  setContext(context: TContext | undefined): void {
    this.context = context;
  }

  setCurrentSession(session: SessionState<TData> | undefined): void {
    this.currentSession = session;
  }

  public getStoredContext(): TContext | undefined {
    return this.context;
  }

  public getCurrentSession(): SessionState<TData> | undefined {
    return this.currentSession;
  }

  /**
   * Handle cross-route completion evaluation and notifications
   * This method evaluates all routes for completion and can trigger completion handlers
   */
  async handleCrossRouteCompletion(params: {
    routes: Route<TContext, TData>[];
    session: SessionState<TData>;
    context: TContext;
    history: Event[];
  }): Promise<{
    session: SessionState<TData>;
    completedRoutes: Route<TContext, TData>[];
    pendingTransitions: Array<{
      route: Route<TContext, TData>;
      transitionConfig: RouteTransitionConfig<TContext, TData>;
    }>;
  }> {
    const { routes, session, context } = params;

    // Evaluate all routes for completion
    const completedRoutes: Route<TContext, TData>[] = [];
    const pendingTransitions: Array<{
      route: Route<TContext, TData>;
      transitionConfig: RouteTransitionConfig<TContext, TData>;
    }> = [];

    for (const route of routes) {
      if (route.isComplete(session.data || {})) {
        completedRoutes.push(route);

        // Check for onComplete transitions
        const transitionConfig = await route.evaluateOnComplete(
          { data: session.data },
          context
        );

        if (transitionConfig) {
          pendingTransitions.push({ route, transitionConfig });
        }

        logger.debug(
          `[ResponsePipeline] Route completed: ${route.title} ` +
          `(${Math.round(route.getCompletionProgress(session.data || {}) * 100)}%)`
        );
      }
    }

    // Log completion status for all routes
    if (completedRoutes.length > 0) {
      logger.debug(
        `[ResponsePipeline] Cross-route completion evaluation: ` +
        `${completedRoutes.length}/${routes.length} routes complete`
      );
    }

    return {
      session,
      completedRoutes,
      pendingTransitions,
    };
  }

  /**
   * Update data flow to ensure agent-level data consistency
   * This method ensures that data updates are properly validated and propagated
   */
  async updateDataFlow(params: {
    session: SessionState<TData>;
    dataUpdate: Partial<TData>;
    routes: Route<TContext, TData>[];
  }): Promise<SessionState<TData>> {
    const { session, dataUpdate, routes } = params;

    // Update session data
    const updatedSession = await this.updateData(session, dataUpdate);

    // Update agent-level data if handler is available
    if (this.updateCollectedData) {
      await this.updateCollectedData(dataUpdate);
    }

    // Evaluate route completions after data update
    const completionResults = await this.handleCrossRouteCompletion({
      routes,
      session: updatedSession,
      context: this.context!,
      history: [],
    });

    // Log any newly completed routes
    if (completionResults.completedRoutes.length > 0) {
      logger.debug(
        `[ResponsePipeline] Data update resulted in ${completionResults.completedRoutes.length} completed routes`
      );
    }

    return completionResults.session;
  }
}
