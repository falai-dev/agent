import type {
  Event,
  AgentOptions,
  StructuredSchema,
  RoutingDecision,
  SessionState,
  AiProvider,
  TemplateContext,
} from "../types";
import { enterRoute, mergeCollected } from "../utils";
import type { Route } from "./Route";
import type { Step } from "./Step";
import { PromptComposer } from "./PromptComposer";
import { END_ROUTE_ID } from "../constants";
import { createTemplateContext, getLastMessageFromHistory, logger } from "../utils";

export interface CandidateStep<TContext = unknown, TData = unknown> {
  step: Step<TContext, TData>;
  isRouteComplete?: boolean;
}

export interface RoutingDecisionOutput {
  context: string;
  routes: Record<string, number>;
  selectedStepId?: string; // For active route, which step to transition to
  stepReasoning?: string; // Why this step was selected
  responseDirectives?: string[];
  extractions?: Array<{
    name: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    value: any;
    confidence?: number;
    source?: "message" | "history";
  }>;
  contextUpdate?: Record<string, unknown>;
}

export interface RoutingEngineOptions {
  allowRouteSwitch?: boolean;
  switchThreshold?: number; // 0-100
  maxCandidates?: number;
}

export interface BuildStepSelectionPromptParams<
  TContext = unknown,
  TData = unknown
> {
  route: Route<TContext, TData>;
  currentStep: Step<TContext, TData> | undefined;
  candidates: CandidateStep<TContext, TData>[];
  data: Partial<TData>;
  history: Event[];
  lastMessage: string;
  agentOptions?: AgentOptions<TContext, TData>;
  context?: TContext;
  session?: SessionState<TData>;
  stepConditionContext?: string[]; // AI context strings from step conditions
}

export interface BuildRoutingPromptParams<TContext = unknown, TData = unknown> {
  history: Event[];
  routes: Route<TContext, TData>[];
  lastMessage: string;
  agentOptions?: AgentOptions<TContext, TData>;
  session?: SessionState<TData>;
  activeRouteSteps?: Step<TContext, TData>[];
  context?: TContext;
  routeConditionContext?: string[]; // AI context strings from route conditions
}

export class RoutingEngine<TContext = unknown, TData = unknown> {
  constructor(private readonly options?: RoutingEngineOptions) { }

  /**
   * Enter a route if not already in it, merging initial data
   * @private
   */
  private enterRouteIfNeeded(
    session: SessionState<TData>,
    route: Route<TContext, TData>
  ): SessionState<TData> {
    if (!session.currentRoute || session.currentRoute.id !== route.id) {
      let updatedSession = enterRoute(session, route.id, route.title);
      if (route.initialData) {
        updatedSession = mergeCollected(updatedSession, route.initialData);
        logger.debug(
          `[RoutingEngine] Merged initial data for route ${route.title}:`,
          route.initialData
        );
      }
      logger.debug(`[RoutingEngine] Entered route: ${route.title}`);
      return updatedSession;
    }
    return session;
  }

  /**
   * Optimized decision for single-route scenarios
   * Skips route scoring and only does step selection
   * @private
   */
  private async decideSingleRouteStep(params: {
    route: Route<TContext, TData>;
    session: SessionState<TData>;
    history: Event[];
    agentOptions?: AgentOptions<TContext, TData>;
    provider: AiProvider;
    context: TContext;
    signal?: AbortSignal;
  }): Promise<{
    selectedRoute?: Route<TContext, TData>;
    selectedStep?: Step<TContext, TData>;
    responseDirectives?: string[];
    session: SessionState<TData>;
    isRouteComplete?: boolean;
    completedRoutes?: Route<TContext, TData>[];
  }> {
    const { route, session, history, agentOptions, provider, context, signal } =
      params;

    const selectedRoute = route;

    // Enter route if not already in it (this may merge initial data)
    const updatedSession = this.enterRouteIfNeeded(session, route);

    // Check if this single route is complete (use updated session data)
    const completedRoutes = route.isComplete(updatedSession.data || {}) ? [route] : [];

    // Get candidate steps using new condition evaluation
    const templateContext = createTemplateContext({ 
      context, 
      session: updatedSession, 
      history,
      data: updatedSession.data 
    });
    const currentStep = updatedSession.currentStep
      ? route.getStep(updatedSession.currentStep.id)
      : undefined;
    const candidates = await this.getCandidateStepsWithConditions(
      route,
      currentStep,
      templateContext
    );

    if (candidates.length === 0) {
      logger.warn(`[RoutingEngine] Single-route: No valid steps found`);
      return { selectedRoute, session: updatedSession };
    }

    // If only one candidate, check if it's a completion marker
    if (candidates.length === 1) {
      const candidate = candidates[0];
      
      if (candidate.isRouteComplete) {
        logger.debug(
          `[RoutingEngine] Single-route: Route complete - all required fields collected or END_ROUTE reached`
        );
        // Don't return a selectedStep when route is complete - there's no step to enter
        return {
          selectedRoute,
          selectedStep: undefined,
          session: updatedSession,
          isRouteComplete: true,
          completedRoutes,
        };
      } else {
        logger.debug(
          `[RoutingEngine] Single-route: Only one valid step: ${candidate.step.id}`
        );
        return {
          selectedRoute,
          selectedStep: candidate.step,
          session: updatedSession,
          isRouteComplete: false,
          completedRoutes,
        };
      }
    }

    // No candidates means route is likely complete or has no valid next steps
    if (candidates.length === 0) {
      const dataComplete = route.isComplete(updatedSession.data || {});
      logger.debug(
        `[RoutingEngine] Single-route: No valid steps found - ` +
        `(data: ${dataComplete ? 'complete' : 'incomplete'}, marking as ${dataComplete ? 'complete' : 'incomplete'})`
      );
      return {
        selectedRoute,
        selectedStep: undefined,
        session: updatedSession,
        isRouteComplete: dataComplete,
        completedRoutes,
      };
    }

    // Multiple candidates - use AI to select best step
    const lastUserMessage = getLastMessageFromHistory(history);
    
    // Collect AI context strings from step conditions
    const stepConditionContext: string[] = [];
    for (const candidate of candidates) {
      const whenResult = await candidate.step.evaluateWhen(templateContext);
      stepConditionContext.push(...whenResult.aiContextStrings);
    }
    
    // Check if any candidate is a completion marker (isRouteComplete = true)
    const hasCompletionOption = candidates.some(c => c.isRouteComplete);
    
    const stepPrompt = await this.buildStepSelectionPrompt({
      route,
      currentStep,
      candidates,
      data: updatedSession.data || {},
      history,
      lastMessage: lastUserMessage,
      agentOptions,
      context,
      session: updatedSession,
      stepConditionContext,
      includeEndRoute: hasCompletionOption,
    });

    const stepSchema = this.buildStepSelectionSchema(
      candidates.filter(c => !c.isRouteComplete).map((c) => c.step),
      hasCompletionOption
    );

    const stepResult = await provider.generateMessage<
      TContext,
      {
        reasoning: string;
        selectedStepId: string;
        responseDirectives?: string[];
      }
    >({
      prompt: stepPrompt,
      history,
      context,
      signal,
      parameters: {
        jsonSchema: stepSchema,
        schemaName: "step_selection",
      },
    });

    const selectedStepId = stepResult.structured?.selectedStepId;
    
    // Check if AI selected END_ROUTE
    if (selectedStepId === END_ROUTE_ID) {
      logger.debug(
        `[RoutingEngine] Single-route: AI selected END_ROUTE - completing route`
      );
      logger.debug(
        `[RoutingEngine] Single-route: Reasoning: ${stepResult.structured?.reasoning}`
      );
      return {
        selectedRoute,
        selectedStep: undefined,
        responseDirectives: stepResult.structured?.responseDirectives,
        session: updatedSession,
        isRouteComplete: true,
        completedRoutes,
      };
    }

    const selectedStep = candidates.find((c) => c.step.id === selectedStepId);

    if (selectedStep) {
      logger.debug(
        `[RoutingEngine] Single-route: AI selected step: ${selectedStep.step.id}`
      );
      logger.debug(
        `[RoutingEngine] Single-route: Reasoning: ${stepResult.structured?.reasoning}`
      );
    } else {
      logger.warn(
        `[RoutingEngine] Single-route: Invalid step ID returned, using first candidate`
      );
    }

    return {
      selectedRoute,
      selectedStep: selectedStep?.step || candidates[0].step,
      responseDirectives: stepResult.structured?.responseDirectives,
      session: updatedSession,
      completedRoutes,
    };
  }

  /**
   * Recursively traverse step chain to find first non-skipped step or END_ROUTE using new condition evaluation
   * @private
   */
  private async findFirstValidStepRecursiveWithConditions(
    currentStep: Step<TContext, TData>,
    templateContext: TemplateContext<TContext, TData>,
    visited: Set<string>
  ): Promise<{
    step?: Step<TContext, TData>;
    isRouteComplete?: boolean;
    aiContextStrings?: string[];
  }> {
    // Prevent infinite loops
    if (visited.has(currentStep.id)) {
      return { aiContextStrings: [] };
    }
    visited.add(currentStep.id);

    const transitions = currentStep.getTransitions();
    const allAiContextStrings: string[] = [];

    for (const transition of transitions) {
      const target = transition;

      // Check for END_ROUTE transition
      if (target && target.id === END_ROUTE_ID) {
        // Found END_ROUTE - route is complete
        return {
          isRouteComplete: true,
          aiContextStrings: allAiContextStrings,
        };
      }

      if (!target) continue;

      // Evaluate skipIf condition using new system
      const skipResult = await target.evaluateSkipIf(templateContext);
      allAiContextStrings.push(...skipResult.aiContextStrings);

      // If target should NOT be skipped, we found our step
      if (!skipResult.shouldSkip) {
        logger.debug(
          `[RoutingEngine] Found valid step after skipping: ${target.id}`
        );
        return {
          step: target,
          isRouteComplete: false,
          aiContextStrings: allAiContextStrings,
        };
      }

      // Target should be skipped too - recurse deeper
      logger.debug(
        `[RoutingEngine] Skipping step ${target.id} (skipIf condition met), continuing traversal...`
      );
      const result = await this.findFirstValidStepRecursiveWithConditions(target, templateContext, visited);

      // Collect AI context from recursive call
      if (result.aiContextStrings) {
        allAiContextStrings.push(...result.aiContextStrings);
      }

      // If we found something (a valid step or END_ROUTE), return it
      if (result.step || result.isRouteComplete) {
        return {
          ...result,
          aiContextStrings: allAiContextStrings,
        };
      }
    }

    // No valid steps or END_ROUTE found in this branch
    return { aiContextStrings: allAiContextStrings };
  }



  /**
   * Identify valid next candidate steps using new condition evaluation system
   * Returns step with isRouteComplete flag if route is complete (all steps skipped + has END_ROUTE transition)
   * 
   * NEW: Automatically completes route when all required fields are collected
   */
  async getCandidateStepsWithConditions(
    route: Route<TContext, TData>,
    currentStep: Step<TContext, TData> | undefined,
    templateContext: TemplateContext<TContext, TData>
  ): Promise<CandidateStep<TContext, TData>[]> {
    const candidates: CandidateStep<TContext, TData>[] = [];
    const data = templateContext.data || {};

    // Check if all required fields are collected
    const allRequiredFieldsCollected = route.isComplete(data);

    if (!currentStep) {
      // Entering route for the first time
      
      // If all required fields already collected, route is immediately complete
      if (allRequiredFieldsCollected) {
        logger.debug(
          `[RoutingEngine] Route ${route.title} complete on entry: all required fields already collected`
        );
        // Return a completion marker - use initial step with completion flag
        candidates.push({
          step: route.initialStep,
          isRouteComplete: true,
        });
        return candidates;
      }

      const initialStep = route.initialStep;
      const skipResult = await initialStep.evaluateSkipIf(templateContext);
      
      if (skipResult.shouldSkip) {
        // Initial step should be skipped - recursively traverse to find first non-skipped step or END_ROUTE
        const result = await this.findFirstValidStepRecursiveWithConditions(
          initialStep,
          templateContext,
          new Set<string>()
        );

        if (result.isRouteComplete) {
          // All steps are skipped and we reached END_ROUTE
          logger.debug(
            `[RoutingEngine] Route complete on entry: all steps skipped, END_ROUTE reached`
          );
          candidates.push({
            step: initialStep,
            isRouteComplete: true,
          });
        } else if (result.step) {
          // Found a non-skipped step
          candidates.push({
            step: result.step,
            isRouteComplete: result.isRouteComplete || false,
          });
        }
        // If no step found and not complete, fall through to return empty candidates
      } else {
        candidates.push({
          step: initialStep,
          isRouteComplete: false,
        });
      }
      return candidates;
    }

    // Check if all required fields are now collected (may have been collected during this step)
    if (allRequiredFieldsCollected) {
      // Required fields are complete - check if we should continue for optional fields
      const transitions = currentStep.getTransitions();
      const optionalFieldCandidates: CandidateStep<TContext, TData>[] = [];

      for (const transition of transitions) {
        const target = transition;

        // Check for END_ROUTE transition
        if (target && target.id === END_ROUTE_ID) {
          continue;
        }

        if (!target) continue;

        // Check if this step collects only optional fields
        const collectsOnlyOptional = target.collect && target.collect.length > 0 &&
          target.collect.every(field => 
            route.optionalFields?.includes(field)
          );

        if (collectsOnlyOptional) {
          // This step collects optional fields - it's a candidate
          const skipResult = await target.evaluateSkipIf(templateContext);
          if (!skipResult.shouldSkip) {
            optionalFieldCandidates.push({
              step: target,
              isRouteComplete: false,
            });
          }
        }
      }

      // If we have optional field candidates, include them along with END_ROUTE option
      if (optionalFieldCandidates.length > 0) {
        logger.debug(
          `[RoutingEngine] Required fields complete, but ${optionalFieldCandidates.length} optional field steps available`
        );
        // Add optional field steps as candidates
        candidates.push(...optionalFieldCandidates);
        // Also add END_ROUTE as a candidate (AI can choose to skip optional fields)
        candidates.push({
          step: currentStep,
          isRouteComplete: true,
        });
        return candidates;
      }

      // No optional fields to collect - route is complete
      logger.debug(
        `[RoutingEngine] Route ${route.title} complete: all required fields collected, no optional fields remain`
      );
      return [
        {
          step: currentStep,
          isRouteComplete: true,
        },
      ];
    }

    // Required fields not yet complete - continue normal step progression
    const transitions = currentStep.getTransitions();
    let hasEndRoute = false;

    for (const transition of transitions) {
      const target = transition;

      // Check for END_ROUTE transition (no target step)
      if (target && target.id === END_ROUTE_ID) {
        hasEndRoute = true;
        continue;
      }

      if (!target) continue;

      const skipResult = await target.evaluateSkipIf(templateContext);
      
      if (skipResult.shouldSkip) {
        logger.debug(
          `[RoutingEngine] Skipping step ${target.id} (skipIf condition met)`
        );

        // Recursively traverse to find next valid step or END_ROUTE
        const result = await this.findFirstValidStepRecursiveWithConditions(
          target,
          templateContext,
          new Set<string>([currentStep.id]) // Already visited current step
        );

        if (result.isRouteComplete) {
          hasEndRoute = true;
        } else if (result.step) {
          // Found a non-skipped step deeper in the chain
          candidates.push({
            step: result.step,
            isRouteComplete: result.isRouteComplete || false,
          });
        }
        continue;
      }

      candidates.push({
        step: target,
        isRouteComplete: hasEndRoute || false,
      });
    }

    // If no valid candidates found
    if (candidates.length === 0) {
      // If current step has END_ROUTE transition, the route is complete
      if (hasEndRoute) {
        logger.debug(
          `[RoutingEngine] Route complete: all steps processed, END_ROUTE reached`
        );
        // Return current step with completion flag
        return [
          {
            step: currentStep,
            isRouteComplete: true,
          },
        ];
      }

      // Otherwise, stay in current step if it's still valid
      const currentSkipResult = await currentStep.evaluateSkipIf(templateContext);
      if (!currentSkipResult.shouldSkip) {
        candidates.push({
          step: currentStep,
          isRouteComplete: hasEndRoute || false,
        });
      }
    }

    return candidates;
  }

  /**
   * Full routing orchestration: builds prompt and schema, calls AI, selects route/step,
   * and updates the session (including initialData merge when entering a new route).
   *
   * OPTIMIZATION: If there's only 1 route, skips route scoring and only does step selection.
   * CROSS-ROUTE COMPLETION: Evaluates all routes for completion based on collected data.
   */
  async decideRouteAndStep(params: {
    routes: Route<TContext, TData>[];
    session: SessionState<TData>;
    history: Event[];
    agentOptions?: AgentOptions<TContext, TData>;
    provider: AiProvider;
    context: TContext;
    signal?: AbortSignal;
  }): Promise<{
    selectedRoute?: Route<TContext, TData>;
    selectedStep?: Step<TContext, TData>;
    responseDirectives?: string[];
    session: SessionState<TData>;
    isRouteComplete?: boolean;
    completedRoutes?: Route<TContext, TData>[];
  }> {
    const {
      routes,
      session,
      history,
      agentOptions,
      provider,
      context,
      signal,
    } = params;

    if (routes.length === 0) {
      return { session };
    }

    // CROSS-ROUTE COMPLETION EVALUATION: Check all routes for completion
    const completedRoutes = this.evaluateRouteCompletions(routes, session.data || {});

    // Log completed routes
    if (completedRoutes.length > 0) {
      logger.debug(
        `[RoutingEngine] Found ${completedRoutes.length} completed routes: ${completedRoutes.map(r => r.title).join(', ')}`
      );
    }

    // OPTIMIZATION: Single route - skip route scoring, only do step selection
    if (routes.length === 1) {
      const result = await this.decideSingleRouteStep({
        route: routes[0],
        session,
        history,
        agentOptions,
        provider,
        context,
        signal,
      });
      return {
        ...result,
        completedRoutes,
      };
    }

    const lastUserMessage = getLastMessageFromHistory(history);
    const templateContext = createTemplateContext({ 
      context, 
      session, 
      history,
      data: session.data 
    });

    // Apply route filtering with new condition evaluation system
    const skipIfResult = await this.filterRoutesBySkipIf(routes, templateContext);
    const whenResult = await this.filterRoutesByWhen(skipIfResult.eligibleRoutes, templateContext);
    
    // Collect all AI context strings from route conditions
    const routeConditionContext = [...skipIfResult.aiContextStrings, ...whenResult.aiContextStrings];
    
    // Use filtered routes for further processing
    const eligibleRoutes = whenResult.eligibleRoutes;
    
    logger.debug(`[RoutingEngine] Route filtering: ${routes.length} total → ${skipIfResult.eligibleRoutes.length} after skipIf → ${eligibleRoutes.length} after when`);

    let activeRouteSteps: Step<TContext, TData>[] | undefined;
    let activeRoute: Route<TContext, TData> | undefined;
    let isRouteComplete = false;
    let updatedSession = session;

    if (session.currentRoute) {
      activeRoute = eligibleRoutes.find((r) => r.id === session.currentRoute?.id);
      if (activeRoute) {
        const currentStep = session.currentStep
          ? activeRoute.getStep(session.currentStep.id)
          : undefined;
        const activeTemplateContext = createTemplateContext({
          ...templateContext,
          session: updatedSession,
          data: updatedSession.data
        });
        const candidates = await this.getCandidateStepsWithConditions(
          activeRoute,
          currentStep,
          activeTemplateContext
        );

        // Check if route is complete
        // getCandidateStepsWithConditions now automatically handles completion when required fields are collected
        if (candidates.length === 1 && candidates[0].isRouteComplete) {
          isRouteComplete = true;
          logger.debug(
            `[RoutingEngine] Route ${activeRoute.title} is complete - all required fields collected or END_ROUTE reached`
          );
          // Don't include steps in routing if route is complete
          activeRouteSteps = undefined;
        } else if (candidates.length === 0) {
          // No candidates - check if data is complete
          const dataComplete = activeRoute.isComplete(updatedSession.data || {});
          isRouteComplete = dataComplete;
          logger.debug(
            `[RoutingEngine] Route ${activeRoute.title} has no valid steps - ` +
            `marking as ${isRouteComplete ? 'complete' : 'incomplete'}`
          );
          activeRouteSteps = undefined;
        } else {
          // Multiple candidates or single non-complete candidate
          activeRouteSteps = candidates.map((c) => c.step);
          logger.debug(
            `[RoutingEngine] Found ${activeRouteSteps.length} candidate steps for active route`
          );
        }
      }
    }

    const routingSchema = this.buildDynamicRoutingSchema(
      eligibleRoutes,
      undefined,
      activeRouteSteps
    );

    const routingPrompt = await this.buildRoutingPrompt({
      history,
      routes: eligibleRoutes,
      lastMessage: lastUserMessage,
      agentOptions,
      session,
      activeRouteSteps,
      context,
      routeConditionContext, // Pass AI context strings from route conditions
    });

    const routingResult = await provider.generateMessage<
      TContext,
      RoutingDecisionOutput
    >({
      prompt: routingPrompt,
      history,
      context,
      signal,
      parameters: {
        jsonSchema: routingSchema,
        schemaName: "routing_output",
      },
    });

    let selectedRoute: Route<TContext, TData> | undefined;
    let selectedStep: Step<TContext, TData> | undefined;
    let responseDirectives: string[] | undefined;

    if (routingResult.structured?.routes) {
      // Use cross-route completion evaluation to select optimal route
      const optimalRoute = this.selectOptimalRoute(
        eligibleRoutes,
        updatedSession.data || {},
        routingResult.structured.routes
      );

      // If no optimal route found (all routes completed), don't select any route
      if (!optimalRoute) {
        logger.debug(
          `[RoutingEngine] No eligible routes available - all routes are complete or filtered out`
        );
        selectedRoute = undefined;
      } else {
        selectedRoute = optimalRoute;
      }

      responseDirectives = routingResult.structured.responseDirectives;

      if (
        selectedRoute === activeRoute &&
        routingResult.structured.selectedStepId &&
        activeRoute
      ) {
        selectedStep = activeRoute.getStep(
          routingResult.structured.selectedStepId
        );
        if (selectedStep) {
          logger.debug(
            `[RoutingEngine] AI selected step: ${selectedStep.id} in active route`
          );
          logger.debug(
            `[RoutingEngine] Step reasoning: ${routingResult.structured.stepReasoning}`
          );
        }
      }

      if (selectedRoute) {
        logger.debug(`[RoutingEngine] Selected route: ${selectedRoute.title}`);
        updatedSession = this.enterRouteIfNeeded(updatedSession, selectedRoute);
      }
    }

    return {
      selectedRoute,
      selectedStep,
      responseDirectives,
      session: updatedSession,
      isRouteComplete,
      completedRoutes,
    };
  }

  /**
   * Filter routes based on skipIf conditions
   * @param routes - All available routes
   * @param templateContext - Context for condition evaluation
   * @returns Object with eligible routes and collected AI context strings
   */
  async filterRoutesBySkipIf(
    routes: Route<TContext, TData>[],
    templateContext: TemplateContext<TContext, TData>
  ): Promise<{
    eligibleRoutes: Route<TContext, TData>[];
    aiContextStrings: string[];
  }> {
    const eligibleRoutes: Route<TContext, TData>[] = [];
    const aiContextStrings: string[] = [];

    for (const route of routes) {
      const skipResult = await route.evaluateSkipIf(templateContext);
      
      // Collect AI context strings from skipIf conditions
      aiContextStrings.push(...skipResult.aiContextStrings);
      
      // If route should not be skipped, it's eligible
      if (!skipResult.programmaticResult) {
        eligibleRoutes.push(route);
      } else {
        logger.debug(`[RoutingEngine] Skipping route ${route.title} (skipIf condition met)`);
      }
    }

    return { eligibleRoutes, aiContextStrings };
  }

  /**
   * Filter routes based on when conditions
   * @param routes - Routes that passed skipIf filtering
   * @param templateContext - Context for condition evaluation
   * @returns Object with eligible routes and collected AI context strings
   */
  async filterRoutesByWhen(
    routes: Route<TContext, TData>[],
    templateContext: TemplateContext<TContext, TData>
  ): Promise<{
    eligibleRoutes: Route<TContext, TData>[];
    aiContextStrings: string[];
  }> {
    const eligibleRoutes: Route<TContext, TData>[] = [];
    const aiContextStrings: string[] = [];

    for (const route of routes) {
      const whenResult = await route.evaluateWhen(templateContext);
      
      // Collect AI context strings from when conditions
      aiContextStrings.push(...whenResult.aiContextStrings);
      
      // If route has no programmatic conditions or they evaluate to true, it's eligible
      if (!whenResult.hasProgrammaticConditions || whenResult.programmaticResult) {
        eligibleRoutes.push(route);
      } else {
        logger.debug(`[RoutingEngine] Route ${route.title} not eligible (when condition not met)`);
      }
    }

    return { eligibleRoutes, aiContextStrings };
  }

  /**
   * Evaluate all routes for completion based on collected data
   * @param routes - All available routes
   * @param data - Currently collected agent-level data
   * @returns Array of routes that are complete
   */
  evaluateRouteCompletions(routes: Route<TContext, TData>[], data: Partial<TData>): Route<TContext, TData>[] {
    return routes.filter(route => route.isComplete(data));
  }

  /**
   * Get completion status for all routes
   * @param routes - All available routes
   * @param data - Currently collected agent-level data
   * @returns Map of route ID to completion progress (0-1)
   */
  getRouteCompletionStatus(routes: Route<TContext, TData>[], data: Partial<TData>): Map<string, number> {
    const completionStatus = new Map<string, number>();

    for (const route of routes) {
      const progress = route.getCompletionProgress(data);
      completionStatus.set(route.id, progress);
    }

    return completionStatus;
  }

  /**
   * Find the best route to continue based on completion status and user intent
   * Prioritizes routes that are partially complete but not finished
   * IMPORTANT: Completed routes are excluded to prevent re-entering finished tasks
   * @param routes - All available routes
   * @param data - Currently collected agent-level data
   * @param routeScores - AI-generated route scores from routing decision
   * @returns Route that should be prioritized for continuation
   */
  selectOptimalRoute(
    routes: Route<TContext, TData>[],
    data: Partial<TData>,
    routeScores: Record<string, number>
  ): Route<TContext, TData> | undefined {
    const completionStatus = this.getRouteCompletionStatus(routes, data);

    // Create weighted scores combining AI intent scores with completion progress
    const weightedScores: Array<{ route: Route<TContext, TData>; score: number }> = [];

    for (const route of routes) {
      const aiScore = routeScores[route.id] || 0;
      const completionProgress = completionStatus.get(route.id) || 0;

      // ALWAYS skip fully completed routes to prevent re-entering finished tasks
      // Users should not be forced back into completed routes
      if (completionProgress >= 1.0) {
        logger.debug(
          `[RoutingEngine] Excluding completed route: ${route.title} (100% complete)`
        );
        continue;
      }

      // Boost partially complete routes that match user intent
      let weightedScore = aiScore;
      if (completionProgress > 0 && completionProgress < 1.0) {
        // Boost score for partially complete routes
        weightedScore += (completionProgress * 20); // Up to 20 point boost
      }

      weightedScores.push({ route, score: weightedScore });
    }

    // Sort by weighted score and return the best option
    weightedScores.sort((a, b) => b.score - a.score);

    if (weightedScores.length > 0) {
      logger.debug(
        `[RoutingEngine] Selected optimal route: ${weightedScores[0].route.title} ` +
        `(AI: ${routeScores[weightedScores[0].route.id]}, ` +
        `Completion: ${(completionStatus.get(weightedScores[0].route.id) || 0) * 100}%, ` +
        `Weighted: ${weightedScores[0].score})`
      );
      return weightedScores[0].route;
    }

    return undefined;
  }

  /**
   * Build prompt for step selection within a single route
   * @private
   */
  private async buildStepSelectionPrompt(
    params: BuildStepSelectionPromptParams<TContext, TData> & { includeEndRoute?: boolean }
  ): Promise<string> {
    const {
      route,
      currentStep,
      candidates,
      data,
      history,
      lastMessage,
      agentOptions,
      context,
      session,
      stepConditionContext,
      includeEndRoute = false,
    } = params;
    const templateContext = createTemplateContext({ context, session, history });
    const pc = new PromptComposer<TContext, TData>(templateContext);

    // Add agent metadata
    if (agentOptions) {
      await pc.addAgentMeta(agentOptions);
    }

    // Add route context
    await pc.addInstruction(
      `Active Route: ${route.title}\nDescription: ${route.description || "N/A"}`
    );

    // Add current step context
    if (currentStep) {
      await pc.addInstruction(
        `Current Step: ${currentStep.id}\nDescription: ${currentStep.description || "N/A"
        }`
      );
    } else {
      await pc.addInstruction("Current Step: None (entering route)");
    }

    // Add collected data context
    if (Object.keys(data).length > 0) {
      await pc.addInstruction(
        `Collected Data So Far:\n${JSON.stringify(data, null, 2)}`
      );
    } else {
      await pc.addInstruction("Collected Data: None yet");
    }

    // Add conversation history
    await pc.addInteractionHistory(history);
    await pc.addLastMessage(lastMessage);

    // Add candidate steps with condition context
    const stepDescriptions = [];
    for (const candidate of candidates) {
      const idx = candidates.indexOf(candidate);
      const parts = [
        `${idx + 1}. Step ID: ${candidate.step.id}`,
        `   Description: ${candidate.step.description || "N/A"}`,
      ];

      // Add when condition context
      if (candidate.step.when) {
        const whenResult = await candidate.step.evaluateWhen(templateContext);
        if (whenResult.aiContextStrings.length > 0) {
          parts.push(`   When conditions: ${whenResult.aiContextStrings.join(", ")}`);
        } else if (typeof candidate.step.when === 'string') {
          parts.push(`   When this step should be completed: ${candidate.step.when}`);
        }
      }

      if (candidate.step.requires && candidate.step.requires.length > 0) {
        parts.push(`   Required Data: ${candidate.step.requires.join(", ")}`);
      }

      if (candidate.step.collect && candidate.step.collect.length > 0) {
        parts.push(`   Collects: ${candidate.step.collect.join(", ")}`);
      }

      stepDescriptions.push(parts.join("\n"));
    }

    await pc.addInstruction(
      `Available Steps to Transition To:\n${stepDescriptions.join("\n\n")}`
    );

    // Add step condition context if available
    if (stepConditionContext && stepConditionContext.length > 0) {
      await pc.addInstruction(
        [
          "",
          "Additional step context from conditions:",
          ...stepConditionContext.map(ctx => `- ${ctx}`),
          "",
          "Consider this context when selecting the most appropriate step.",
        ].join("\n")
      );
    }

    // Add decision prompt
    const decisionRules = [
      "Task: Decide which step to transition to based on:",
      "1. The user's current message and intent",
      "2. The conversation history and context",
      "3. The collected data we already have",
      "4. The conditions and requirements of each step",
      "5. The logical flow of the conversation",
      "",
      "Rules:",
      "- If a step has a condition, evaluate whether it's met based on context",
      "- If a step requires data we don't have, consider if we should collect it now",
      "- Choose the step that makes the most sense for moving the conversation forward",
      "- Steps with skipIf conditions that are met have already been filtered out",
    ];

    if (includeEndRoute) {
      decisionRules.push(
        "",
        `- You can select '${END_ROUTE_ID}' to complete this route if:`,
        "  * All required data has been collected",
        "  * The user's intent suggests they're done with this task",
        "  * No further steps are needed to fulfill the user's request"
      );
    }

    decisionRules.push(
      "",
      "Return ONLY JSON matching the provided schema."
    );

    await pc.addInstruction(decisionRules.join("\n"));

    return pc.build();
  }

  /**
   * Build schema for step selection
   * @private
   */
  private buildStepSelectionSchema(
    validSteps: Step<TContext, TData>[],
    includeEndRoute: boolean = false
  ): StructuredSchema {
    const stepIds = validSteps.map((s) => s.id);
    
    // Add END_ROUTE as an option if requested (when required fields are complete)
    if (includeEndRoute) {
      stepIds.push(END_ROUTE_ID);
    }

    return {
      description:
        "Step transition decision based on conversation context and collected data",
      type: "object",
      properties: {
        reasoning: {
          type: "string",
          nullable: false,
          description: "Brief explanation of why this step was selected",
        },
        selectedStepId: {
          type: "string",
          nullable: false,
          description: includeEndRoute 
            ? `The ID of the selected step to transition to, or '${END_ROUTE_ID}' to complete the route`
            : "The ID of the selected step to transition to",
          enum: stepIds,
        },
        responseDirectives: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional bullet points the response should address (concise)",
        },
      },
      required: ["reasoning", "selectedStepId"],
      additionalProperties: false,
    };
  }

  buildDynamicRoutingSchema(
    routes: Route<TContext, TData>[],
    extrasSchema?: StructuredSchema,
    activeRouteSteps?: Step<TContext, TData>[]
  ): StructuredSchema {
    const routeIds = routes.map((r) => r.id);
    const routeProperties: Record<string, StructuredSchema> = {};
    for (const id of routeIds) {
      routeProperties[id] = {
        type: "number",
        nullable: false,
        description: `Score for route ${id} based on direct evidence, context and semantic fit (0-100)`,
        minimum: 0,
        maximum: 100,
      } as StructuredSchema;
    }

    const base: StructuredSchema = {
      description:
        "Full intent analysis: score ALL available routes (0-100) using evidence and context",
      type: "object",
      properties: {
        context: {
          type: "string",
          nullable: false,
          description: "Brief summary of the user's intent/context",
        },
        routes: {
          type: "object",
          properties: routeProperties,
          required: routeIds,
          nullable: false,
          description: "Mapping of routeId to score (0-100)",
        },
        responseDirectives: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional bullet points the response should address (concise)",
        },
      },
      required: ["context", "routes"],
      additionalProperties: false,
    };

    // Add step selection fields if there's an active route with steps
    if (activeRouteSteps && activeRouteSteps.length > 0) {
      base.properties = base.properties || {};
      base.properties.selectedStepId = {
        type: "string",
        nullable: false,
        description:
          "The step ID to transition to within the active route (required if continuing in current route)",
        enum: activeRouteSteps.map((s) => s.id),
      };
      base.properties.stepReasoning = {
        type: "string",
        nullable: false,
        description: "Brief explanation of why this step was selected",
      };
      base.required = [
        ...(base.required || []),
        "selectedStepId",
        "stepReasoning",
      ];
    }

    if (extrasSchema) {
      base.properties = base.properties || {};
      base.properties.extractions = extrasSchema;
    }

    return base;
  }

  async buildRoutingPrompt(
    params: BuildRoutingPromptParams<TContext, TData>
  ): Promise<string> {
    const {
      history,
      routes,
      lastMessage,
      agentOptions,
      session,
      activeRouteSteps,
      context,
      routeConditionContext,
    } = params;
    const templateContext = createTemplateContext({ context, session, history });
    const pc = new PromptComposer<TContext, TData>(templateContext);
    if (agentOptions) {
      await pc.addAgentMeta(agentOptions);
    }
    await pc.addInstruction(
      "Task: Intent analysis and route scoring (0-100). Score ALL listed routes."
    );

    // Add session context if available
    if (session?.currentRoute) {
      const sessionInfo = [
        "Current conversation context:",
        `- Active route: ${session.currentRoute.title} (${session.currentRoute.id})`,
      ];
      if (session.currentStep) {
        sessionInfo.push(`- Current step: ${session.currentStep.id}`);
        if (session.currentStep.description) {
          sessionInfo.push(`  "${session.currentStep.description}"`);
        }
      }
      if (session.data && Object.keys(session.data).length > 0) {
        sessionInfo.push(`- Collected data: ${JSON.stringify(session.data)}`);
      }
      sessionInfo.push(
        "Note: User is mid-conversation. They may want to continue current route or switch to a new one based on their intent."
      );
      await pc.addInstruction(sessionInfo.join("\n"));

      // Add cross-route completion status
      const completionStatus = this.getRouteCompletionStatus(routes, session.data || {});
      const completedRoutes = this.evaluateRouteCompletions(routes, session.data || {});

      if (completionStatus.size > 0) {
        const statusInfo = [
          "",
          "Route completion status based on collected data:",
        ];

        for (const route of routes) {
          const progress = completionStatus.get(route.id) || 0;
          const isComplete = completedRoutes.includes(route);
          const progressPercent = Math.round(progress * 100);

          statusInfo.push(
            `- ${route.title}: ${progressPercent}% complete${isComplete ? ' ✓ COMPLETE' : ''}`
          );

          if (!isComplete && route.requiredFields) {
            const missingFields = route.getMissingRequiredFields(session.data || {});
            if (missingFields.length > 0) {
              statusInfo.push(`  Missing: ${missingFields.join(', ')}`);
            }
          }
        }

        statusInfo.push(
          "",
          "Consider route completion status when scoring. Partially complete routes may be good candidates for continuation."
        );

        await pc.addInstruction(statusInfo.join("\n"));
      }

      // Add available steps for the active route
      if (activeRouteSteps && activeRouteSteps.length > 0) {
        const stepInfo = [
          "",
          "Available steps in active route (choose one to transition to):",
        ];
        const activeStepConditionContext: string[] = [];
        
        for (const step of activeRouteSteps) {
          const idx = activeRouteSteps.indexOf(step);
          stepInfo.push(`${idx + 1}. Step: ${step.id}`);
          if (step.description) {
            stepInfo.push(`   Description: ${step.description}`);
          }
          
          // Collect AI context from step conditions
          if (step.when) {
            const whenResult = await step.evaluateWhen(templateContext);
            if (whenResult.aiContextStrings.length > 0) {
              stepInfo.push(`   When conditions: ${whenResult.aiContextStrings.join(", ")}`);
              activeStepConditionContext.push(...whenResult.aiContextStrings);
            } else if (typeof step.when === 'string') {
              stepInfo.push(`   When this step should be completed: ${step.when}`);
            }
          }
          
          if (step.requires && step.requires.length > 0) {
            stepInfo.push(`   Required data: ${step.requires.join(", ")}`);
          }
          if (step.collect && step.collect.length > 0) {
            stepInfo.push(`   Will collect: ${step.collect.join(", ")}`);
          }
        }
        stepInfo.push("");
        stepInfo.push(
          "IMPORTANT: You MUST select a step to transition to. Evaluate which step makes the most sense based on:"
        );
        stepInfo.push("- The conversation flow and what's been collected");
        stepInfo.push("- What data is still needed vs already present");
        stepInfo.push("- The logical next step in the conversation");
        stepInfo.push("- Whether conditions for steps are met");
        await pc.addInstruction(stepInfo.join("\n"));
        
        // Add active step condition context if available
        if (activeStepConditionContext.length > 0) {
          await pc.addInstruction(
            [
              "",
              "Additional context from step conditions:",
              ...activeStepConditionContext.map(ctx => `- ${ctx}`),
              "",
              "Use this context to inform your step selection decision.",
            ].join("\n")
          );
        }
      }
    }

    await pc.addInteractionHistory(history);
    await pc.addLastMessage(lastMessage);
    await pc.addRoutingOverview(routes);
    
    // Add route condition context if available
    if (routeConditionContext && routeConditionContext.length > 0) {
      await pc.addInstruction(
        [
          "",
          "Additional routing context from route conditions:",
          ...routeConditionContext.map(ctx => `- ${ctx}`),
          "",
          "Consider this context when scoring routes for relevance.",
        ].join("\n")
      );
    }
    await pc.addInstruction(
      [
        "Scoring rules:",
        "- 90-100: explicit keywords + clear intent",
        "- 70-89: strong contextual evidence + relevant keywords",
        "- 50-69: moderate relevance",
        "- 30-49: weak connection or ambiguous",
        "- 0-29: minimal/none",
        "Return ONLY JSON matching the provided schema. Include scores for ALL routes.",
      ].join("\n")
    );
    return pc.build();
  }

  decideRouteFromScores(output: RoutingDecision): {
    routeId: string;
    maxScore: number;
  } {
    // Optionally limit candidates and apply switching threshold
    const entries = Object.entries(output.routes).sort((a, b) => b[1] - a[1]);
    const limited = this.options?.maxCandidates
      ? entries.slice(0, this.options.maxCandidates)
      : entries;
    const [topId, topScore] = limited[0] || ["", 0];
    // switchThreshold is enforced by caller when a current route exists
    return { routeId: topId, maxScore: topScore };
  }
}
