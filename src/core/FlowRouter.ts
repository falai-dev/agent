import type {
  Event,
  AgentOptions,
  StructuredSchema,
  SessionState,
  AiProvider,
  TemplateContext,
} from "../types";
import { MessageRole } from "../types";
import { enterFlow, mergeCollected, isFlowCompletedThisSession } from "../utils";
import type { Flow } from "./Flow";
import type { Step } from "./Step";
import { PromptComposer } from "./PromptComposer";
import { PromptSectionCache } from "./PromptSectionCache";
import { createTemplateContext, getLastMessageFromHistory, logger, eventsToHistory } from "../utils";

export interface CandidateStep<TContext = unknown, TData = unknown> {
  step: Step<TContext, TData>;
  isFlowComplete?: boolean;
}

export interface FlowRoutingDecisionOutput {
  context: string;
  flows: Record<string, number>;
  selectedStepId?: string; // For active flow, which step to transition to
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

export interface FlowRouterOptions {
  /**
   * Score margin the best alternative flow must exceed the current flow's score
   * by before the agent switches flows. Prevents flip-flopping on marginal differences.
   * @default 15
   */
  flowSwitchMargin?: number;
  /**
   * Callback invoked when the active flow changes.
   * Used by Agent to invalidate flow-dependent prompt cache sections.
   */
  onFlowSwitch?: () => void;
  /**
   * Shared prompt section cache for memoizing static prompt sections.
   */
  promptSectionCache?: PromptSectionCache;
}

export interface BuildStepSelectionPromptParams<
  TContext = unknown,
  TData = unknown
> {
  flow: Flow<TContext, TData>;
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
  flows: Flow<TContext, TData>[];
  lastMessage: string;
  agentOptions?: AgentOptions<TContext, TData>;
  session?: SessionState<TData>;
  activeFlowSteps?: Step<TContext, TData>[];
  context?: TContext;
}

export class FlowRouter<TContext = unknown, TData = unknown> {
  constructor(private readonly options?: FlowRouterOptions) { }

  /**
   * Check whether the history contains any user messages.
   * Used to detect "session resume" scenarios where a flow/step was
   * pre-set programmatically and the conversation starts with only
   * system messages (or no messages at all).
   * @private
   */
  private hasUserMessages(history: Event[]): boolean {
    return history.some(
      (event) => event.source === MessageRole.USER
    );
  }

  /**
   * Handle the "session resume" fast-path: when a session already has a
   * pre-set currentFlow (and optionally currentStep) and the conversation
   * history contains no user messages, honor the pre-set position instead
   * of running AI flow/step selection.
   *
   * Returns `undefined` when the fast-path does not apply.
   * @private
   */
  private async handleSessionResume(params: {
    flows: Flow<TContext, TData>[];
    session: SessionState<TData>;
    history: Event[];
    context: TContext;
  }): Promise<{
    selectedFlow?: Flow<TContext, TData>;
    selectedStep?: Step<TContext, TData>;
    session: SessionState<TData>;
    isFlowComplete?: boolean;
    completedFlows?: Flow<TContext, TData>[];
  } | undefined> {
    const { flows, session, history, context } = params;

    // Fast-path only applies when:
    // 1. Session already has a currentFlow set
    // 2. There are no user messages in the history (system-only or empty)
    if (!session.currentFlow || this.hasUserMessages(history)) {
      return undefined;
    }

    // Find the pre-set flow among available flows
    const presetFlow = flows.find(
      (r) => r.id === session.currentFlow!.id
    );

    if (!presetFlow) {
      logger.warn(
        `[FlowConfigurationError] Pre-set flow not found: session references flow "${session.currentFlow.id}" which does not exist among available flows. Falling back to normal routing. Remove the stale session reference or register the missing flow.`
      );
      return undefined;
    }

    logger.debug(
      `[FlowRouter] Session resume: honoring pre-set flow '${presetFlow.title}' (no user messages in history)`
    );

    // Enter flow if needed (merges initialData, no-op if already entered)
    const updatedSession = this.enterFlowIfNeeded(session, presetFlow);

    // Evaluate cross-flow completions
    const completedFlows = this.evaluateFlowCompletions(flows, updatedSession.data || {});

    // If a currentStep is also pre-set, honor it — stay on that step
    if (session.currentStep) {
      const presetStep = presetFlow.getStep(session.currentStep.id);

      if (presetStep) {
        logger.debug(
          `[FlowRouter] Session resume: honoring pre-set step '${presetStep.id}'`
        );
        return {
          selectedFlow: presetFlow,
          selectedStep: presetStep,
          session: updatedSession,
          isFlowComplete: false,
          completedFlows,
        };
      }

      logger.warn(
        `[FlowConfigurationError] Pre-set step not found: session references step "${session.currentStep.id}" which does not exist in flow "${presetFlow.title}". Resolving from initial step. Remove the stale step reference or register the missing step.`
      );
    }

    // No currentStep pre-set (or it wasn't found) — resolve from initialStep
    // using the standard candidate logic (handles skipIf, etc.)
    const templateContext = createTemplateContext({
      context,
      session: updatedSession,
      history,
      data: updatedSession.data,
    });

    const candidates = await this.getCandidateStepsWithConditions(
      presetFlow,
      undefined, // No current step — start from beginning
      templateContext
    );

    if (candidates.length === 0) {
      logger.warn(
        `[FlowConfigurationError] No valid steps found: all steps in flow "${presetFlow.title}" are skipped by their conditions. Check skip/when conditions on the flow's steps.`
      );
      return {
        selectedFlow: presetFlow,
        selectedStep: undefined,
        session: updatedSession,
        isFlowComplete: false,
        completedFlows,
      };
    }

    const candidate = candidates[0];

    if (candidate.isFlowComplete) {
      logger.debug(
        `[FlowRouter] Session resume: flow '${presetFlow.title}' is already complete`
      );
      return {
        selectedFlow: presetFlow,
        selectedStep: undefined,
        session: updatedSession,
        isFlowComplete: true,
        completedFlows,
      };
    }

    logger.debug(
      `[FlowRouter] Session resume: resolved initial step '${candidate.step.id}'`
    );
    return {
      selectedFlow: presetFlow,
      selectedStep: candidate.step,
      session: updatedSession,
      isFlowComplete: false,
      completedFlows,
    };
  }

  /**
   * Enter a flow if not already in it, merging initial data.
   *
   * When the flow is `reentrant` and was previously completed in this
   * session, clears every field declared in the flow's `requiredFields`
   * and `optionalFields` before entering — so the flow starts fresh from
   * its initial step instead of being instantly marked complete by stale
   * data. Fields not owned by this flow are preserved.
   *
   * @private
   */
  private enterFlowIfNeeded(
    session: SessionState<TData>,
    route: Flow<TContext, TData>
  ): SessionState<TData> {
    if (!session.currentFlow || session.currentFlow.id !== route.id) {
      let workingSession = session;

      // Re-entry into a `reentrant` flow that previously completed:
      // clear owned fields so completion logic doesn't short-circuit on
      // stale data from the prior run.
      const previouslyCompleted = isFlowCompletedThisSession(session, route.id);
      if (previouslyCompleted && route.reentrant) {
        const ownedFields = [
          ...(route.requiredFields ?? []),
          ...(route.optionalFields ?? []),
        ];
        if (ownedFields.length > 0) {
          const owned = new Set<keyof TData>(ownedFields);
          const filtered: Partial<TData> = {};
          for (const key of Object.keys(session.data ?? {}) as (keyof TData)[]) {
            if (!owned.has(key)) {
              (filtered as Record<keyof TData, unknown>)[key] =
                (session.data as Record<keyof TData, unknown>)[key];
            }
          }
          workingSession = { ...session, data: filtered };
          logger.debug(
            `[FlowRouter] Re-entering reentrant flow ${route.title}: cleared ${ownedFields.length} owned field(s)`
          );
        }
      }

      let updatedSession = enterFlow(workingSession, route.id, route.title);
      if (route.initialData) {
        updatedSession = mergeCollected(updatedSession, route.initialData);
        logger.debug(
          `[FlowRouter] Merged initial data for flow ${route.title}:`,
          route.initialData
        );
      }
      logger.debug(`[FlowRouter] Entered flow: ${route.title}`);
      this.options?.onFlowSwitch?.();
      return updatedSession;
    }
    return session;
  }

  /**
   * Optimized decision for single-flow scenarios
   * Skips flow scoring and only does step selection
   * @private
   */
  private async decideSingleFlowStep(params: {
    route: Flow<TContext, TData>;
    session: SessionState<TData>;
    history: Event[];
    agentOptions?: AgentOptions<TContext, TData>;
    provider: AiProvider;
    context: TContext;
    signal?: AbortSignal;
  }): Promise<{
    selectedFlow?: Flow<TContext, TData>;
    selectedStep?: Step<TContext, TData>;
    responseDirectives?: string[];
    session: SessionState<TData>;
    isFlowComplete?: boolean;
    completedFlows?: Flow<TContext, TData>[];
  }> {
    const { route, session, history, agentOptions, provider, context, signal } =
      params;

    const selectedFlow = route;

    // Enter flow if not already in it (this may merge initial data)
    const updatedSession = this.enterFlowIfNeeded(session, route);

    // Check if this single flow is complete (use updated session data)
    const completedFlows = route.isComplete(updatedSession.data || {}) ? [route] : [];

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
      logger.warn(`[FlowConfigurationError] No valid steps found: all candidates in the single-flow agent are skipped. Check step skip/when conditions.`);
      return { selectedFlow, session: updatedSession };
    }

    // If only one candidate, check if it's a completion marker
    if (candidates.length === 1) {
      const candidate = candidates[0];

      if (candidate.isFlowComplete) {
        logger.debug(
          `[FlowRouter] Single-flow: Flow complete - all required fields collected or last step reached`
        );
        // Don't return a selectedStep when flow is complete - there's no step to enter
        return {
          selectedFlow,
          selectedStep: undefined,
          session: updatedSession,
          isFlowComplete: true,
          completedFlows,
        };
      } else {
        logger.debug(
          `[FlowRouter] Single-flow: Only one valid step: ${candidate.step.id}`
        );
        return {
          selectedFlow,
          selectedStep: candidate.step,
          session: updatedSession,
          isFlowComplete: false,
          completedFlows,
        };
      }
    }

    // No candidates means flow has no valid next steps (edge case)
    if (candidates.length === 0) {
      logger.debug(
        `[FlowRouter] Single-flow: No valid candidate steps found`
      );
      return {
        selectedFlow,
        selectedStep: undefined,
        session: updatedSession,
        isFlowComplete: false,
        completedFlows,
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

    // Check if any candidate is a completion marker (isFlowComplete = true)
    const hasCompletionOption = candidates.some(c => c.isFlowComplete);

    const stepPrompt = await this.buildStepSelectionPrompt({
      flow: route,
      currentStep,
      candidates,
      data: updatedSession.data || {},
      history,
      lastMessage: lastUserMessage,
      agentOptions,
      context,
      session: updatedSession,
      stepConditionContext,
      includeCompletion: hasCompletionOption,
    });

    const stepSchema = this.buildStepSelectionSchema(
      candidates.filter(c => !c.isFlowComplete).map((c) => c.step),
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
      history: eventsToHistory(history),
      context,
      signal,
      parameters: {
        jsonSchema: stepSchema,
        schemaName: "step_selection",
      },
    });

    const selectedStepId = stepResult.structured?.selectedStepId;

    // Check if AI selected flow completion
    if (selectedStepId === '__COMPLETE__') {
      logger.debug(
        `[FlowRouter] Single-flow: AI selected flow completion`
      );
      logger.debug(
        `[FlowRouter] Single-flow: Reasoning: ${stepResult.structured?.reasoning}`
      );
      return {
        selectedFlow,
        selectedStep: undefined,
        responseDirectives: stepResult.structured?.responseDirectives,
        session: updatedSession,
        isFlowComplete: true,
        completedFlows,
      };
    }

    const selectedStep = candidates.find((c) => c.step.id === selectedStepId);

    if (selectedStep) {
      logger.debug(
        `[FlowRouter] Single-flow: AI selected step: ${selectedStep.step.id}`
      );
      logger.debug(
        `[FlowRouter] Single-flow: Reasoning: ${stepResult.structured?.reasoning}`
      );
    } else {
      logger.warn(
        `[FlowConfigurationError] Invalid step ID returned: AI router returned a step ID that does not match any candidate. Falling back to first candidate. Check flow step ids and router configuration.`
      );
    }

    return {
      selectedFlow,
      selectedStep: selectedStep?.step || candidates[0].step,
      responseDirectives: stepResult.structured?.responseDirectives,
      session: updatedSession,
      completedFlows,
    };
  }

  /**
   * Recursively traverse step chain to find first non-skipped step using new condition evaluation
   * @private
   */
  private async findFirstValidStepRecursiveWithConditions(
    currentStep: Step<TContext, TData>,
    templateContext: TemplateContext<TContext, TData>,
    visited: Set<string>
  ): Promise<{
    step?: Step<TContext, TData>;
    isFlowComplete?: boolean;
    aiContextStrings?: string[];
  }> {
    // Prevent infinite loops
    if (visited.has(currentStep.id)) {
      return { aiContextStrings: [] };
    }
    visited.add(currentStep.id);

    const transitions = currentStep.getTransitions();
    const allAiContextStrings: string[] = [];

    // No transitions means implicit terminus — flow is complete
    if (transitions.length === 0) {
      return {
        isFlowComplete: true,
        aiContextStrings: allAiContextStrings,
      };
    }

    for (const transition of transitions) {
      const target = transition;

      if (!target) continue;

      // Evaluate skip condition (code-only, if-shape)
      const skipResult = await target.evaluateSkip(templateContext);
      allAiContextStrings.push(...skipResult.aiContextStrings);

      // If target should NOT be skipped, we found our step
      if (!skipResult.shouldSkip) {
        logger.debug(
          `[FlowRouter] Found valid step after skipping: ${target.id}`
        );
        return {
          step: target,
          isFlowComplete: false,
          aiContextStrings: allAiContextStrings,
        };
      }

      // Target should be skipped too - recurse deeper
      logger.debug(
        `[FlowRouter] Skipping step ${target.id} (skipIf condition met), continuing traversal...`
      );
      const result = await this.findFirstValidStepRecursiveWithConditions(target, templateContext, visited);

      // Collect AI context from recursive call
      if (result.aiContextStrings) {
        allAiContextStrings.push(...result.aiContextStrings);
      }

      // If we found something (a valid step or flow complete), return it
      if (result.step || result.isFlowComplete) {
        return {
          ...result,
          aiContextStrings: allAiContextStrings,
        };
      }
    }

    // No valid steps found in this branch — all skipped with no further transitions
    return {
      isFlowComplete: true,
      aiContextStrings: allAiContextStrings,
    };
  }



  /**
   * Identify valid next candidate steps using new condition evaluation system
   * Returns step with isFlowComplete flag if flow is complete (all steps skipped or no transitions remain)
   * 
   * Flow completion is implicit: when the last step has no transitions, the flow is done.
   */
  async getCandidateStepsWithConditions(
    route: Flow<TContext, TData>,
    currentStep: Step<TContext, TData> | undefined,
    templateContext: TemplateContext<TContext, TData>
  ): Promise<CandidateStep<TContext, TData>[]> {
    const candidates: CandidateStep<TContext, TData>[] = [];

    if (!currentStep) {
      // Entering flow for the first time — always start the step flow

      const initialStep = route.initialStep;
      const skipResult = await initialStep.evaluateSkip(templateContext);

      if (skipResult.shouldSkip) {
        // Initial step should be skipped - recursively traverse to find first non-skipped step
        const result = await this.findFirstValidStepRecursiveWithConditions(
          initialStep,
          templateContext,
          new Set<string>()
        );

        if (result.isFlowComplete) {
          // All steps are skipped and no transitions remain
          logger.debug(
            `[FlowRouter] Flow complete on entry: all steps skipped, no transitions remain`
          );
          candidates.push({
            step: initialStep,
            isFlowComplete: true,
          });
        } else if (result.step) {
          // Found a non-skipped step
          candidates.push({
            step: result.step,
            isFlowComplete: result.isFlowComplete || false,
          });
        }
        // If no step found and not complete, fall through to return empty candidates
      } else {
        candidates.push({
          step: initialStep,
          isFlowComplete: false,
        });
      }
      return candidates;
    }

    // Continue normal step progression — flows complete when last step has no transitions (implicit terminus)
    const transitions = currentStep.getTransitions();

    // No transitions means this is the last step — flow is complete
    if (transitions.length === 0) {
      logger.debug(
        `[FlowRouter] Flow complete: current step has no transitions (implicit terminus)`
      );
      return [
        {
          step: currentStep,
          isFlowComplete: true,
        },
      ];
    }

    for (const transition of transitions) {
      const target = transition;

      if (!target) continue;

      const skipResult = await target.evaluateSkip(templateContext);

      if (skipResult.shouldSkip) {
        logger.debug(
          `[FlowRouter] Skipping step ${target.id} (skip condition met)`
        );

        // Recursively traverse to find next valid step
        const result = await this.findFirstValidStepRecursiveWithConditions(
          target,
          templateContext,
          new Set<string>([currentStep.id]) // Already visited current step
        );

        if (result.isFlowComplete) {
          // All forward paths lead to terminus
          candidates.push({
            step: currentStep,
            isFlowComplete: true,
          });
        } else if (result.step) {
          // Found a non-skipped step deeper in the chain
          candidates.push({
            step: result.step,
            isFlowComplete: false,
          });
        }
        continue;
      }

      candidates.push({
        step: target,
        isFlowComplete: false,
      });
    }

    // If no valid candidates found after evaluating all transitions
    if (candidates.length === 0) {
      // All transitions were skipped — flow is complete
      logger.debug(
        `[FlowRouter] Flow complete: all transitions skipped`
      );
      return [
        {
          step: currentStep,
          isFlowComplete: true,
        },
      ];
    }

    return candidates;
  }

  /**
   * Full routing orchestration: builds prompt and schema, calls AI, selects route/step,
   * and updates the session (including initialData merge when entering a new flow).
   *
   * OPTIMIZATION: If there's only 1 route, skips route scoring and only does step selection.
   * CROSS-FLOW COMPLETION: Evaluates all flows for completion based on collected data.
   */
  async decideFlowAndStep(params: {
    flows: Flow<TContext, TData>[];
    session: SessionState<TData>;
    history: Event[];
    agentOptions?: AgentOptions<TContext, TData>;
    provider: AiProvider;
    context: TContext;
    signal?: AbortSignal;
  }): Promise<{
    selectedFlow?: Flow<TContext, TData>;
    selectedStep?: Step<TContext, TData>;
    responseDirectives?: string[];
    session: SessionState<TData>;
    isFlowComplete?: boolean;
    completedFlows?: Flow<TContext, TData>[];
  }> {
    const {
      flows,
      session,
      history,
      agentOptions,
      provider,
      context,
      signal,
    } = params;

    if (flows.length === 0) {
      return { session };
    }

    // SESSION RESUME: If the session has a pre-set flow and there are no user
    // messages in the history, honor the pre-set position without AI routing.
    // This supports programmatic session setup and persistence-based resume.
    const resumeResult = await this.handleSessionResume({
      flows,
      session,
      history,
      context,
    });
    if (resumeResult) {
      return resumeResult;
    }

    // Exclude flows that completed earlier in this session unless explicitly
    // re-entrant. A completed flow surrenders the conversation back to
    // routing — it cannot be re-selected without `flow.reentrant: true`.
    const reEntryFiltered = flows.filter(
      (f) => !isFlowCompletedThisSession(session, f.id) || f.reentrant === true
    );
    const excludedFlows = flows.length - reEntryFiltered.length;
    if (excludedFlows > 0) {
      logger.debug(
        `[FlowRouter] Excluded ${excludedFlows} completed (non-reentrant) flow(s) from routing candidates`
      );
    }

    // CROSS-FLOW COMPLETION EVALUATION: Check all eligible flows for completion
    const completedFlows = this.evaluateFlowCompletions(reEntryFiltered, session.data || {});

    // Log completed flows
    if (completedFlows.length > 0) {
      logger.debug(
        `[FlowRouter] Found ${completedFlows.length} completed routes: ${completedFlows.map(r => r.title).join(', ')}`
      );
    }

    // OPTIMIZATION: Single flow - skip flow scoring, only do step selection
    if (reEntryFiltered.length === 1) {
      const result = await this.decideSingleFlowStep({
        route: reEntryFiltered[0],
        session,
        history,
        agentOptions,
        provider,
        context,
        signal,
      });
      return {
        ...result,
        completedFlows,
      };
    }

    // No eligible flows after re-entry filtering — caller falls back to the
    // generic non-flow response path.
    if (reEntryFiltered.length === 0) {
      logger.debug(
        `[FlowRouter] All flows completed and none are reentrant — releasing session to fallback`
      );
      return { session, completedFlows };
    }

    const lastUserMessage = getLastMessageFromHistory(history);
    const templateContext = createTemplateContext({
      context,
      session,
      history,
      data: session.data
    });

    // Apply flow filtering with new condition evaluation system
    const whenResult = await this.filterFlowsByWhen(reEntryFiltered, templateContext);

    // Use filtered flows for further processing
    const eligibleRoutes = whenResult.eligibleRoutes;

    logger.debug(`[FlowRouter] Flow filtering: ${flows.length} total → ${reEntryFiltered.length} after re-entry filter → ${eligibleRoutes.length} after when`);

    let activeFlowSteps: Step<TContext, TData>[] | undefined;
    let activeFlow: Flow<TContext, TData> | undefined;
    let isFlowComplete = false;
    let updatedSession = session;

    if (session.currentFlow) {
      activeFlow = eligibleRoutes.find((r) => r.id === session.currentFlow?.id);
      if (activeFlow) {
        const currentStep = session.currentStep
          ? activeFlow.getStep(session.currentStep.id)
          : undefined;
        const activeTemplateContext = createTemplateContext({
          ...templateContext,
          session: updatedSession,
          data: updatedSession.data
        });
        const candidates = await this.getCandidateStepsWithConditions(
          activeFlow,
          currentStep,
          activeTemplateContext
        );

        // Check if flow is complete
        // getCandidateStepsWithConditions now automatically handles completion when required fields are collected
        if (candidates.length === 1 && candidates[0].isFlowComplete) {
          isFlowComplete = true;
          logger.debug(
            `[FlowRouter] Flow ${activeFlow.title} is complete - all required fields collected or last step reached`
          );
          // Don't include steps in routing if route is complete
          activeFlowSteps = undefined;
        } else if (candidates.length === 0) {
          // No candidates available — don't end flow based on data alone
          logger.debug(
            `[FlowRouter] Flow ${activeFlow.title} has no valid candidate steps`
          );
          activeFlowSteps = undefined;
        } else {
          // Multiple candidates or single non-complete candidate
          activeFlowSteps = candidates.map((c) => c.step);
          logger.debug(
            `[FlowRouter] Found ${activeFlowSteps.length} candidate steps for active route`
          );
        }
      }
    }

    const routingSchema = this.buildDynamicFlowSchema(
      eligibleRoutes,
      undefined,
      activeFlowSteps
    );

    const routingPrompt = await this.buildRoutingPrompt({
      history,
      flows: eligibleRoutes,
      lastMessage: lastUserMessage,
      agentOptions,
      session,
      activeFlowSteps,
      context,
    });

    const routingResult = await provider.generateMessage<
      TContext,
      FlowRoutingDecisionOutput
    >({
      prompt: routingPrompt,
      history: eventsToHistory(history),
      context,
      signal,
      parameters: {
        jsonSchema: routingSchema,
        schemaName: "routing_output",
      },
    });

    let selectedFlow: Flow<TContext, TData> | undefined;
    let selectedStep: Step<TContext, TData> | undefined;
    let responseDirectives: string[] | undefined;

    if (routingResult.structured?.flows) {
      // Use cross-flow completion evaluation to select optimal flow
      const optimalRoute = this.selectOptimalFlow(
        eligibleRoutes,
        updatedSession.data || {},
        routingResult.structured.flows,
        updatedSession.currentFlow?.id
      );

      // If no optimal flow found, check why
      if (!optimalRoute) {
        if (eligibleRoutes.length === 0) {
          // No flows passed filtering
          logger.debug(
            `[FlowRouter] No eligible flows available - all flows filtered out`
          );
          selectedFlow = undefined;
        } else {
          // Routes exist but selectOptimalFlow returned undefined
          // This means all flows are 100% complete
          logger.debug(
            `[FlowRouter] No optimal route found - all ${eligibleRoutes.length} eligible routes are complete`
          );
          selectedFlow = undefined;
        }
      } else {
        selectedFlow = optimalRoute;
      }

      responseDirectives = routingResult.structured.responseDirectives;

      if (
        selectedFlow === activeFlow &&
        routingResult.structured.selectedStepId &&
        activeFlow
      ) {
        selectedStep = activeFlow.getStep(
          routingResult.structured.selectedStepId
        );
        if (selectedStep) {
          logger.debug(
            `[FlowRouter] AI selected step: ${selectedStep.id} in active route`
          );
          logger.debug(
            `[FlowRouter] Step reasoning: ${routingResult.structured.stepReasoning}`
          );
        }
      }

      if (selectedFlow) {
        logger.debug(`[FlowRouter] Selected route: ${selectedFlow.title}`);
        updatedSession = this.enterFlowIfNeeded(updatedSession, selectedFlow);
      }
    }

    return {
      selectedFlow,
      selectedStep,
      responseDirectives,
      session: updatedSession,
      isFlowComplete,
      completedFlows,
    };
  }

  /**
   * Filter flows based on when conditions
   * @param routes - Flows that passed skipIf filtering
   * @param templateContext - Context for condition evaluation
   * @returns Object with eligible flows and collected AI context strings
   */
  async filterFlowsByWhen(
    routes: Flow<TContext, TData>[],
    templateContext: TemplateContext<TContext, TData>
  ): Promise<{
    eligibleRoutes: Flow<TContext, TData>[];
    aiContextStrings: string[];
  }> {
    const eligibleRoutes: Flow<TContext, TData>[] = [];
    const aiContextStrings: string[] = [];

    for (const route of routes) {
      const whenResult = await route.evaluateWhen(templateContext);

      // Collect AI context strings from when conditions
      aiContextStrings.push(...whenResult.aiContextStrings);

      // If flow has no programmatic conditions or they evaluate to true, it's eligible
      if (!whenResult.hasProgrammaticConditions || whenResult.programmaticResult) {
        eligibleRoutes.push(route);
      } else {
        logger.debug(`[FlowRouter] Flow ${route.title} not eligible (when condition not met)`);
      }
    }

    return { eligibleRoutes, aiContextStrings };
  }

  /**
   * Evaluate all flows for completion based on collected data
   * @param routes - All available flows
   * @param data - Currently collected agent-level data
   * @returns Array of flows that are complete
   */
  evaluateFlowCompletions(routes: Flow<TContext, TData>[], data: Partial<TData>): Flow<TContext, TData>[] {
    return routes.filter(route => route.isComplete(data));
  }

  /**
   * Get completion status for all flows
   * @param routes - All available flows
   * @param data - Currently collected agent-level data
   * @returns Map of flow ID to completion progress (0-1)
   */
  getFlowCompletionStatus(routes: Flow<TContext, TData>[], data: Partial<TData>): Map<string, number> {
    const completionStatus = new Map<string, number>();

    for (const route of routes) {
      const progress = route.getCompletionProgress(data);
      completionStatus.set(route.id, progress);
    }

    return completionStatus;
  }

  /**
   * Find the best flow to continue based on completion status and user intent
   * Prioritizes flows that are partially complete but not finished
   * IMPORTANT: Completed flows are excluded to prevent re-entering finished tasks
   * @param routes - All available flows
   * @param data - Currently collected agent-level data
   * @param routeScores - AI-generated route scores from routing decision
   * @returns Flow that should be prioritized for continuation
   */
  selectOptimalFlow(
    routes: Flow<TContext, TData>[],
    data: Partial<TData>,
    routeScores: Record<string, number>,
    currentRouteId?: string
  ): Flow<TContext, TData> | undefined {
    const completionStatus = this.getFlowCompletionStatus(routes, data);
    const switchMargin = this.options?.flowSwitchMargin ?? 15;

    // Create weighted scores combining AI intent scores with completion progress
    const weightedScores: Array<{ route: Flow<TContext, TData>; score: number }> = [];

    for (const route of routes) {
      const aiScore = routeScores[route.id] || 0;
      const completionProgress = completionStatus.get(route.id) || 0;

      // ALWAYS skip fully completed flows to prevent re-entering finished tasks
      if (completionProgress >= 1.0) {
        logger.debug(
          `[FlowRouter] Excluding completed flow: ${route.title} (100% complete)`
        );
        continue;
      }

      // Boost partially complete flows that match user intent
      let weightedScore = aiScore;
      if (completionProgress > 0 && completionProgress < 1.0) {
        weightedScore += (completionProgress * 20); // Up to 20 point boost
      }

      weightedScores.push({ route, score: weightedScore });
    }

    // Sort by weighted score descending
    weightedScores.sort((a, b) => b.score - a.score);

    if (weightedScores.length === 0) {
      return undefined;
    }

    // Apply sticky routing: if there's a current route, only switch if the
    // best alternative exceeds the current flow's score by the configured margin
    if (currentRouteId) {
      const currentEntry = weightedScores.find(e => e.route.id === currentRouteId);
      const bestEntry = weightedScores[0];

      if (currentEntry && bestEntry.route.id !== currentRouteId) {
        if (bestEntry.score < currentEntry.score + switchMargin) {
          logger.debug(
            `[FlowRouter] Staying on current flow: ${currentEntry.route.title} ` +
            `(current: ${currentEntry.score}, best alternative: ${bestEntry.score}, ` +
            `margin required: ${switchMargin})`
          );
          return currentEntry.route;
        }
        logger.debug(
          `[FlowRouter] Switching flow: ${currentEntry.route.title} → ${bestEntry.route.title} ` +
          `(current: ${currentEntry.score}, alternative: ${bestEntry.score}, ` +
          `margin: ${switchMargin})`
        );
      }
    }

    logger.debug(
      `[FlowRouter] Selected optimal route: ${weightedScores[0].route.title} ` +
      `(AI: ${routeScores[weightedScores[0].route.id]}, ` +
      `Completion: ${(completionStatus.get(weightedScores[0].route.id) || 0) * 100}%, ` +
      `Weighted: ${weightedScores[0].score})`
    );
    return weightedScores[0].route;
  }

  /**
   * Build prompt for step selection within a single flow
   * @private
   */
  private async buildStepSelectionPrompt(
    params: BuildStepSelectionPromptParams<TContext, TData> & { includeCompletion?: boolean }
  ): Promise<string> {
    const {
      flow: route,
      currentStep,
      candidates,
      data,
      history,
      lastMessage,
      agentOptions,
      context,
      session,
      stepConditionContext,
      includeCompletion = false,
    } = params;
    const templateContext = createTemplateContext({ context, session, history });
    const pc = new PromptComposer<TContext, TData>(templateContext, this.options?.promptSectionCache);

    // Add agent metadata
    if (agentOptions) {
      await pc.addAgentMeta(agentOptions);
    }

    // Add flow context
    await pc.addInstruction(
      `Active Flow: ${route.title}\nDescription: ${route.description || "N/A"}`
    );

    // Add current step context
    if (currentStep) {
      await pc.addInstruction(
        `Current Step: ${currentStep.id}\nDescription: ${currentStep.description || "N/A"
        }`
      );
    } else {
      await pc.addInstruction("Current Step: None (entering flow)");
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

    if (includeCompletion) {
      decisionRules.push(
        "",
        `- You can select '__COMPLETE__' to complete this flow if:`,
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
    includeCompletion: boolean = false
  ): StructuredSchema {
    const stepIds = validSteps.map((s) => s.id);

    // Add completion option if requested (when required fields are complete)
    if (includeCompletion) {
      stepIds.push('__COMPLETE__');
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
          description: includeCompletion
            ? "The ID of the selected step to transition to, or '__COMPLETE__' to complete the flow"
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

  buildDynamicFlowSchema(
    routes: Flow<TContext, TData>[],
    extrasSchema?: StructuredSchema,
    activeFlowSteps?: Step<TContext, TData>[]
  ): StructuredSchema {
    const routeIds = routes.map((r) => r.id);
    const routeProperties: Record<string, StructuredSchema> = {};
    for (const id of routeIds) {
      routeProperties[id] = {
        type: "number",
        nullable: false,
        description: `Score for flow ${id} based on direct evidence, context and semantic fit (0-100)`,
        minimum: 0,
        maximum: 100,
      } as StructuredSchema;
    }

    const base: StructuredSchema = {
      description:
        "Full intent analysis: score ALL available flows (0-100) using evidence and context",
      type: "object",
      properties: {
        context: {
          type: "string",
          nullable: false,
          description: "Brief summary of the user's intent/context",
        },
        flows: {
          type: "object",
          properties: routeProperties,
          required: routeIds,
          nullable: false,
          description: "Mapping of flowId to score (0-100)",
        },
        responseDirectives: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional bullet points the response should address (concise)",
        },
      },
      required: ["context", "flows"],
      additionalProperties: false,
    };

    // Add step selection fields if there's an active flow with steps
    if (activeFlowSteps && activeFlowSteps.length > 0) {
      base.properties = base.properties || {};
      base.properties.selectedStepId = {
        type: "string",
        nullable: false,
        description:
          "The step ID to transition to within the active flow (required if continuing in current flow)",
        enum: activeFlowSteps.map((s) => s.id),
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
      flows: routes,
      lastMessage,
      agentOptions,
      session,
      activeFlowSteps,
      context,
    } = params;
    const templateContext = createTemplateContext({ context, session, history });
    const pc = new PromptComposer<TContext, TData>(templateContext, this.options?.promptSectionCache);
    if (agentOptions) {
      await pc.addAgentMeta(agentOptions);
    }
    await pc.addInstruction(
      "Task: Intent analysis and route scoring (0-100). Score ALL listed routes."
    );

    // Add session context if available
    if (session?.currentFlow) {
      const sessionInfo = [
        "Current conversation context:",
        `- Active route: ${session.currentFlow.title} (${session.currentFlow.id})`,
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
      const completionStatus = this.getFlowCompletionStatus(routes, session.data || {});
      const completedFlows = this.evaluateFlowCompletions(routes, session.data || {});

      if (completionStatus.size > 0) {
        const statusInfo = [
          "",
          "Flow completion status based on collected data:",
        ];

        for (const route of routes) {
          const progress = completionStatus.get(route.id) || 0;
          const isComplete = completedFlows.includes(route);
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
      if (activeFlowSteps && activeFlowSteps.length > 0) {
        const stepInfo = [
          "",
          "Available steps in active route (choose one to transition to):",
        ];
        const activeStepConditionContext: string[] = [];

        for (const step of activeFlowSteps) {
          const idx = activeFlowSteps.indexOf(step);
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
    await pc.addFlowOverview(routes);

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

}
