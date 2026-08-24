/**
 * Response processing utilities shared between respond() and respondStream() methods
 */

import type { EndedFlow,
  AgentOptions,
  Event,
  SessionState,
  Directive,
  StructuredSchema,
} from "../types";
import type { SignalFiring } from "../types/signals";
import {
  createSession,
  enterStep,
  mergeCollected,
  logger,
  historyToEvents,
  eventsToHistory,
  getLastMessageFromHistory,
} from "../utils";
import { enterFlow } from "../utils/session";
import { createTemplateContext } from "../utils/template";
import { Flow } from "./Flow";
import { Step, FlowConfigurationError } from "../core/Step";
import { FlowRouter } from "./FlowRouter";
import { evaluateBranches, createAiConditionEvaluator } from "./BranchEvaluator";
import { DirectiveChainTracker } from "./DirectiveChainTracker";
import { ResponseGenerationError } from "./ResponseGenerationError";
import type { SignalCoordinator } from "./SignalCoordinator";

/**
 * Position fields on a Directive that represent a navigation decision.
 * When any of these is set, the directive "wins" the turn's position decision
 * and downstream resolution (branches, linear, AI) must not run.
 */
const DIRECTIVE_POSITION_FIELDS = ['goTo', 'goToStep', 'complete', 'abort', 'reset'] as const;

/**
 * Returns `true` if the given directive has at least one position field set.
 * Used as the guard at the directive-bus / branch-evaluation seam:
 * if the bus produced a winner with a position field, `evaluateStepBranches`
 * (and linear/AI selection) must not run.
 */
export function hasDirectivePositionField<TContext = unknown, TData = unknown>(
  directive: Directive<TContext, TData> | undefined | null,
): boolean {
  if (!directive) return false;
  return DIRECTIVE_POSITION_FIELDS.some(
    (field) => (directive as Record<string, unknown>)[field] !== undefined,
  );
}

/**
 * Compute the per-key data writes the signal phase applied to a session.
 * The signal phase and routing start from the same input session, so any
 * key whose value differs between the input and the signal output was
 * written by the signal phase alone (handler `updateData` calls).
 */
function diffSignalDataWrites<TData>(
  before: Partial<TData> | undefined,
  after: Partial<TData> | undefined,
): Partial<TData> {
  const beforeData = (before ?? {}) as Record<string, unknown>;
  const afterData = (after ?? {}) as Record<string, unknown>;
  const writes: Record<string, unknown> = {};
  for (const key of Object.keys(afterData)) {
    if (afterData[key] !== beforeData[key]) {
      writes[key] = afterData[key];
    }
  }
  return writes as Partial<TData>;
}

export interface ResponsePreparationResult<TContext, TData = unknown> {
  effectiveContext: TContext;
  session: SessionState<TData>;
  /** Context returned by the beforeRespond hook, for the caller to sync back to the agent. */
  contextAfterHook?: TContext;
}

export interface RoutingResult<TContext, TData = unknown> {
  selectedFlow: Flow<TContext, TData> | undefined;
  selectedStep: Step<TContext, TData> | undefined;
  responseDirectives: string[] | undefined;
  session: SessionState<TData>;
  isFlowComplete: boolean;
  completedFlows?: Flow<TContext, TData>[];
  /** Flows exited via pendingDirective redirects/resets this turn. */
  endedFlows?: EndedFlow[];
}

/**
 * Shared response processing logic between respond() and respondStream() methods
 */
export class ResponsePipeline<TContext = unknown, TData = unknown> {
  /**
   * Per-turn directive chain tracker. Created fresh at the start of each turn
   * via `createChainTracker()`. Used by directive application points to detect
   * infinite redirection loops.
   */
  private _chainTracker: DirectiveChainTracker | undefined;

  constructor(
    private readonly options: AgentOptions<TContext, TData>,
    private readonly getFlows: () => Flow<TContext, TData>[],
    private readonly flowRouter: FlowRouter<TContext, TData>,
    private readonly signalCoordinator: SignalCoordinator<TContext, TData>,
    private readonly updateCollectedData: (updates: Partial<TData>) => Promise<void>,
    private readonly getSchema: () => StructuredSchema | undefined
  ) { }

  /**
   * Create a fresh chain tracker for the current turn.
   * Call at the start of each turn; the tracker is discarded at turn end.
   */
  createChainTracker(): DirectiveChainTracker {
    const maxChain = this.options.maxDirectiveChain ?? 10;
    this._chainTracker = new DirectiveChainTracker(maxChain);
    return this._chainTracker;
  }

  /**
   * Get the current turn's chain tracker (creates one if none exists).
   */
  get chainTracker(): DirectiveChainTracker {
    if (!this._chainTracker) {
      return this.createChainTracker();
    }
    return this._chainTracker;
  }

  /**
   * Prepare context and session for response generation
   */
  async prepareResponseContext(params: {
    contextOverride?: Partial<TContext>;
    session?: SessionState<TData>;
    /** The agent's current context, resolved by the caller (contextProvider already applied). */
    currentContext?: TContext;
    /** The agent's live session, used when no explicit session is passed. */
    currentSession?: SessionState<TData>;
  }): Promise<ResponsePreparationResult<TContext, TData>> {
    const { contextOverride, session } = params;

    let currentContext = params.currentContext;
    let contextAfterHook: TContext | undefined;

    // Call beforeRespond hook if configured
    if (this.options.hooks?.beforeRespond && currentContext !== undefined) {
      currentContext = await this.options.hooks.beforeRespond(currentContext);
      // Surface the hook result so the caller can sync it back to the agent
      contextAfterHook = currentContext;
    }

    // Merge context with override
    const effectiveContext = {
      ...(currentContext as Record<string, unknown>),
      ...(contextOverride as Record<string, unknown>),
    } as TContext;

    // Initialize or get session (use the live session if available)
    const targetSession = session || params.currentSession || createSession<TData>();

    return {
      effectiveContext,
      session: targetSession,
      contextAfterHook,
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
    /** Restrict ROUTING candidates; directive targets still use the full registry. */
    allowedFlows?: string[];
  }): Promise<RoutingResult<TContext, TData>> {
    const { session, history, context, signal, allowedFlows } = params;

    // PHASE 2: ROUTING + STEP SELECTION - Determine which flow and step to use (combined)
    let selectedFlow: Flow<TContext, TData> | undefined;
    let responseDirectives: string[] | undefined;
    let selectedStep: Step<TContext, TData> | undefined;
    let isFlowComplete = false;
    let completedFlows: Flow<TContext, TData>[] = [];
    let targetSession = session;
    // Flows exited this turn via pendingDirective redirect/reset
    const endedFlows: EndedFlow[] = [];
    let exitPrevFlowId: string | undefined;
    let exitPrevFlowTitle: string | undefined;
    let exitReason: EndedFlow['reason'] | undefined;

    // Get flows early since we need them for pending directives
    const flows = this.getFlows();
    // Routing candidates may be narrowed for this turn (entry pins); the
    // pendingDirective applier below still resolves targets against the FULL
    // registry so declared redirects always resolve.
    const routingFlows =
      allowedFlows && allowedFlows.length > 0
        ? flows.filter(
            (f) => allowedFlows.includes(f.id) || allowedFlows.includes(f.title),
          )
        : flows;

    // Check for pending directive from previous flow completion or external dispatch
    if (targetSession.pendingDirective) {
      const directive = targetSession.pendingDirective;
      logger.debug(
        `[ResponsePipeline] Applying pending directive at start of turn`
      );

      // Track directive chain depth (Requirement 22.1)
      const tracker = this.chainTracker;
      tracker.record(directive, "pending");
      // If abort (chain breaker), the tracker stops counting; apply normally below

      // Clear pendingDirective before application (unless complete.next chains another)
      let nextDirective: typeof targetSession.pendingDirective | undefined = undefined;
      if (
        directive.complete &&
        typeof directive.complete === 'object' &&
        directive.complete.next
      ) {
        nextDirective = directive.complete.next;
      }

      targetSession = {
        ...targetSession,
        pendingDirective: nextDirective,
      };

      // Capture the flow we're leaving so directive-driven exits surface on
      // the response (endedFlows).
      exitPrevFlowId = targetSession.currentFlow?.id;
      exitPrevFlowTitle = exitPrevFlowId
        ? flows.find((f) => f.id === exitPrevFlowId)?.title
        : undefined;

      // Apply the directive: resolve position field to a flow/step
      if (directive.goTo) {
        exitReason = 'goto';
        const flowTarget = typeof directive.goTo === 'string'
          ? directive.goTo
          : directive.goTo.flow;

        if (flowTarget) {
          const targetFlow = flows.find(
            (r) => r.id === flowTarget || r.title === flowTarget
          );

          if (targetFlow) {
            logger.debug(
              `[ResponsePipeline] Pending directive goTo → flow: ${targetFlow.title}`
            );
            targetSession = enterFlow(
              targetSession,
              targetFlow.id,
              targetFlow.title
            );

            // Merge initial data if available
            if (targetFlow.initialData) {
              targetSession = mergeCollected(
                targetSession,
                targetFlow.initialData
              );
            }

            // Merge directive-carried data if present
            if (typeof directive.goTo === 'object' && directive.goTo.data) {
              targetSession = mergeCollected(
                targetSession,
                directive.goTo.data
              );
            }

            selectedFlow = targetFlow;

            // If goTo specifies a step, enter it
            if (typeof directive.goTo === 'object' && directive.goTo.step) {
              const stepTarget = directive.goTo.step;
              const targetStep = targetFlow.getStep(stepTarget);
              if (targetStep) {
                targetSession = enterStep(targetSession, targetStep.id, targetStep.description);
                selectedStep = targetStep;
              }
            }
          } else {
            logger.warn(
              `[FlowConfigurationError] Pending directive goTo target not found: flow "${flowTarget}" does not exist. Falling back to normal routing. Fix the goTo reference or remove the pending directive.`
            );
          }
        }
      } else if (directive.goToStep) {
        const stepTarget = typeof directive.goToStep === 'string'
          ? directive.goToStep
          : directive.goToStep.step;
        const flowTarget = typeof directive.goToStep === 'object'
          ? directive.goToStep.flow
          : undefined;

        if (flowTarget) {
          const targetFlow = flows.find(
            (r) => r.id === flowTarget || r.title === flowTarget
          );
          if (targetFlow) {
            targetSession = enterFlow(targetSession, targetFlow.id, targetFlow.title);
            selectedFlow = targetFlow;
            const targetStep = targetFlow.getStep(stepTarget);
            if (targetStep) {
              targetSession = enterStep(targetSession, targetStep.id, targetStep.description);
              selectedStep = targetStep;
            }
          }
        } else if (targetSession.currentFlow) {
          // Step within current flow
          const currentFlow = flows.find(r => r.id === targetSession.currentFlow?.id);
          if (currentFlow) {
            selectedFlow = currentFlow;
            const targetStep = currentFlow.getStep(stepTarget);
            if (targetStep) {
              targetSession = enterStep(targetSession, targetStep.id, targetStep.description);
              selectedStep = targetStep;
            }
          }
        }
      } else if (directive.reset) {
        exitReason = 'reset';
        // Reset current flow
        if (targetSession.currentFlow) {
          const currentFlow = flows.find(r => r.id === targetSession.currentFlow?.id);
          if (currentFlow) {
            const resetStep = typeof directive.reset === 'object' && directive.reset.step
              ? directive.reset.step
              : undefined;
            selectedFlow = currentFlow;
            if (resetStep) {
              const targetStep = currentFlow.getStep(resetStep);
              if (targetStep) {
                targetSession = enterStep(targetSession, targetStep.id, targetStep.description);
                selectedStep = targetStep;
              }
            } else {
              // Reset to initial step
              const initialStep = currentFlow.initialStep;
              targetSession = enterStep(targetSession, initialStep.id, initialStep.description);
              selectedStep = initialStep;
            }
          }
        }
      }
      // For complete/abort, selectedFlow stays undefined → handled downstream

      // Apply state writes from the directive
      if (directive.dataUpdate) {
        targetSession = mergeCollected(targetSession, directive.dataUpdate);
      }

      // Skip FlowRouter.decideFlowAndStep — the directive resolved the position
    }

    if (
      exitReason &&
      exitPrevFlowId &&
      (!selectedFlow || selectedFlow.id !== exitPrevFlowId)
    ) {
      endedFlows.push({ flowId: exitPrevFlowId, title: exitPrevFlowTitle, reason: exitReason });
    }

    // If no pending transition or transition handled, do normal routing.
    // Candidates honor allowedFlows; completion scoring runs over the same set.
    if (routingFlows.length > 0 && !selectedFlow) {
      const orchestration = await this.flowRouter.decideFlowAndStep({
        flows: routingFlows,
        session: targetSession,
        history,
        agentOptions: this.options,
        provider: this.options.provider,
        context,
        signal,
      });

      selectedFlow = orchestration.selectedFlow;
      selectedStep = orchestration.selectedStep;
      responseDirectives = orchestration.responseDirectives;
      targetSession = orchestration.session;
      isFlowComplete = orchestration.isFlowComplete || false;
      completedFlows = orchestration.completedFlows || [];

      // Log if flow is complete
      if (isFlowComplete) {
        logger.debug(
          `[ResponsePipeline] Flow complete: all required data collected or last step reached`
        );
      }
    }

    return {
      selectedFlow,
      selectedStep,
      responseDirectives,
      session: targetSession,
      isFlowComplete,
      completedFlows,
      ...(endedFlows.length > 0 ? { endedFlows } : {}),
    };
  }

  /**
   * Combine a routing-derived session with the signal phase's non-position
   * mutations. The routing session is the base — it owns position state AND
   * data merges such as flow initialData and directive-carried writes; the
   * signal phase's mutations (trigger recording under `signals`, handler
   * data writes) are re-applied on top. Both phases start from the same
   * input session, so their mutations cannot silently collide.
   */
  private combineRoutingAndSignalSessions(params: {
    inputSession: SessionState<TData>;
    signalSession: SessionState<TData>;
    routingSession: SessionState<TData>;
  }): SessionState<TData> {
    const { inputSession, signalSession, routingSession } = params;
    let combined = routingSession;

    if (signalSession.signals !== inputSession.signals) {
      combined = { ...combined, signals: signalSession.signals };
    }

    const signalWrites = diffSignalDataWrites(
      inputSession.data,
      signalSession.data,
    );
    if (Object.keys(signalWrites).length > 0) {
      combined = mergeCollected(combined, signalWrites);
    }

    return combined;
  }

  /**
   * Determine next step and update session
   */
  async determineNextStep(params: {
    selectedFlow: Flow<TContext, TData> | undefined;
    selectedStep: Step<TContext, TData> | undefined;
    session: SessionState<TData>;
    isFlowComplete: boolean;
    /** The turn's effective context, passed explicitly (no stored pipeline state). */
    context: TContext;
    /** Merged directive from the directive bus (pre-LLM + post-LLM phases). */
    busDirective?: Directive<TContext, TData>;
  }): Promise<{ nextStep: Step<TContext, TData> | undefined; session: SessionState<TData>; flowChanged?: Flow<TContext, TData> }> {
    const { selectedFlow, selectedStep, session, isFlowComplete, context, busDirective } = params;

    if (!selectedFlow) {
      return { nextStep: undefined, session };
    }

    // ─── GUARD: directive bus winner with a position field preempts branches ───
    // Resolution precedence (design.md): bus > branches > linear > AI.
    // If the bus produced a directive with a position field (goTo, goToStep,
    // complete, abort, reset), that decision wins the turn. Do NOT evaluate
    // branches or linear/AI selection — the caller applies the bus directive.
    if (hasDirectivePositionField(busDirective)) {
      logger.debug(
        `[ResponsePipeline] Directive bus winner has position field — skipping branch evaluation and linear/AI selection`,
      );
      return { nextStep: undefined, session };
    }

    // STEP 1 (Algorithm 1): branches win over linear chain AND flow completion.
    // Evaluate branches before checking isFlowComplete — a branch can redirect
    // even from the "last" step (which getCandidateStepsWithConditions marks as complete).
    if (!selectedStep) {
      const currentStep = session.currentFlow?.id === selectedFlow.id && session.currentStep
        ? selectedFlow.getStep(session.currentStep.id)
        : undefined;

      if (currentStep?.branches && currentStep.branches.length > 0) {
        const branchResult = await this.evaluateStepBranches(
          currentStep, selectedFlow, session, context
        );
        if (branchResult) {
          return branchResult;
        }
        // undefined → fall through to linear/AI selection or flow completion
      }
    }

    if (isFlowComplete) {
      return { nextStep: undefined, session };
    }

    let nextStep: Step<TContext, TData>;

    // If we have a selected step from the combined routing decision, use it
    if (selectedStep) {
      nextStep = selectedStep;
    } else {
      // Determine current step from session if we're already in this flow
      const currentStep = session.currentFlow?.id === selectedFlow.id && session.currentStep
        ? selectedFlow.getStep(session.currentStep.id)
        : undefined;

      // Get candidate steps based on current position in the flow
      const candidates = await this.flowRouter.getCandidateStepsWithConditions(
        selectedFlow,
        currentStep, // Pass current step instead of undefined to maintain progression
        createTemplateContext({ data: session.data, session, context })
      );

      if (candidates.length > 0) {
        nextStep = candidates[0].step;
        logger.debug(
          `[ResponsePipeline] Using first valid step: ${nextStep.id}${currentStep ? ' (progressing from ' + currentStep.id + ')' : ' for new flow'}`
        );
      } else {
        // Fallback to initial step even if it should be skipped
        nextStep = selectedFlow.initialStep;
        logger.warn(
          `[FlowConfigurationError] No valid steps found in flow "${selectedFlow.title}": all candidates were skipped. Falling back to initial step "${nextStep.id}". Review step skip conditions.`
        );
      }
    }

    // Before entering the step, check if requires fields are satisfied
    if (nextStep.requires && nextStep.requires.length > 0) {
      const sessionData = session.data || {};
      const missingRequires = nextStep.requires.filter(
        field => (sessionData as Record<string, unknown>)[String(field)] === undefined
      );
      if (missingRequires.length > 0) {
        logger.debug(
          `[ResponsePipeline] Cannot enter step "${nextStep.id}": missing required fields [${missingRequires.join(', ')}]. Staying at current step.`
        );
        // Stay at current step - don't enter the next one
        const currentStepId = session.currentStep?.id;
        if (currentStepId && selectedFlow) {
          const currentStepInstance = selectedFlow.getStep(currentStepId);
          if (currentStepInstance) {
            nextStep = currentStepInstance;
          }
        }
        return { nextStep, session };
      }
    }

    // Update session with next step
    const updatedSession = enterStep(
      session,
      nextStep.id,
      nextStep.description
    );
    logger.debug(`[ResponsePipeline] Entered step: ${nextStep.id}`);

    return { nextStep, session: updatedSession };
  }

  /**
   * Evaluate branches on a step and resolve the `then` value.
   *
   * Resolution rules (Algorithm 1, STEP 1 + then resolution):
   * - String `then` → look up in current flow's step registry first (local step wins).
   * - Not a local step → look up in agent's flow registry; if found, treat as goTo directive.
   * - Neither → throw FlowConfigurationError.
   * - Directive `then` → apply directly (bypass directive bus merge).
   *
   * Returns the resolved { nextStep, session, flowChanged? } or undefined if no branch matched.
   */
  async evaluateStepBranches(
    currentStep: Step<TContext, TData>,
    selectedFlow: Flow<TContext, TData>,
    session: SessionState<TData>,
    context: TContext,
  ): Promise<{ nextStep: Step<TContext, TData> | undefined; session: SessionState<TData>; flowChanged?: Flow<TContext, TData> } | undefined> {
    const history = session.history ? historyToEvents(session.history) : [];

    // Build the BranchPredicateContext
    const branchCtx = {
      data: session.data,
      context,
      session,
      history,
    };

    // Create the AI condition evaluator
    const aiEvaluator = createAiConditionEvaluator(
      this.options.provider,
      history,
      context,
    );

    const result = await evaluateBranches(
      currentStep.branches!,
      branchCtx,
      aiEvaluator,
    );

    if (result === undefined) {
      return undefined; // No branch matched → fall through to linear/AI selection
    }

    // Task 4.3: Directive `then` value — apply directly
    if (typeof result === 'object' && result !== null) {
      const directive = result;
      return this.applyBranchDirective(directive, selectedFlow, session);
    }

    // Task 4.2: String `then` resolution
    // 1. Look up in current flow's step registry first (local step wins)
    const localStep = selectedFlow.getStep(result);
    if (localStep) {
      const updatedSession = enterStep(session, localStep.id, localStep.description);
      logger.debug(`[ResponsePipeline] Branch resolved to local step: ${localStep.id}`);
      return { nextStep: localStep, session: updatedSession };
    }

    // 2. Look up in agent's flow registry
    const flows = this.getFlows();
    const targetFlow = flows.find(f => f.id === result || f.title === result);
    if (targetFlow) {
      // Treat as applyDirective({ goTo: result }) — enter the target flow
      logger.debug(`[ResponsePipeline] Branch resolved to flow: ${targetFlow.title}`);
      const updatedSession = enterFlow(session, targetFlow.id, targetFlow.title);
      return { nextStep: undefined, session: updatedSession, flowChanged: targetFlow };
    }

    // 3. Neither → throw FlowConfigurationError
    throw new FlowConfigurationError(
      `[FlowConfigurationError] Unresolved branch target: "${result}" does not match any step in flow "${selectedFlow.id}" or any flow in the agent. ` +
      `Source: ${selectedFlow.id}.${currentStep.id}. Fix the branch "then" value to reference a valid step id or flow id/title.`
    );
  }

  /**
   * Apply a Directive returned by a branch entry's `then` value.
   * Branches bypass the directive bus — the Directive is the position decision.
   */
  private applyBranchDirective(
    directive: Directive<TContext, TData>,
    selectedFlow: Flow<TContext, TData>,
    session: SessionState<TData>,
  ): { nextStep: Step<TContext, TData> | undefined; session: SessionState<TData>; flowChanged?: Flow<TContext, TData> } {
    // Track directive chain depth (Requirement 22.1)
    const tracker = this.chainTracker;
    tracker.record(directive, `branch:${selectedFlow.id}`);

    let updatedSession = session;

    // Apply state writes first
    if (directive.dataUpdate) {
      updatedSession = mergeCollected(updatedSession, directive.dataUpdate);
    }

    // Handle position fields
    if (directive.goToStep) {
      const stepTarget = typeof directive.goToStep === 'string'
        ? directive.goToStep
        : directive.goToStep.step;
      const flowTarget = typeof directive.goToStep === 'object'
        ? directive.goToStep.flow
        : undefined;

      if (flowTarget) {
        // Cross-flow step reference — enter the target flow first
        const flows = this.getFlows();
        const targetFlow = flows.find(f => f.id === flowTarget || f.title === flowTarget);
        if (targetFlow) {
          updatedSession = enterFlow(updatedSession, targetFlow.id, targetFlow.title);
          updatedSession = enterStep(updatedSession, stepTarget);
          // Try to resolve the target step instance for the caller
          const targetStepInstance = targetFlow.getStep(stepTarget);
          logger.debug(`[ResponsePipeline] Branch directive goToStep → ${flowTarget}.${stepTarget}`);
          return { nextStep: targetStepInstance || undefined, session: updatedSession, flowChanged: targetFlow };
        }
        throw new FlowConfigurationError(
          `[FlowConfigurationError] Branch directive goToStep targets unknown flow: "${flowTarget}" does not match any flow id or title. ` +
          `Fix the goToStep.flow value or use goTo to target a known flow.`
        );
      }

      // Local step reference
      const targetStep = selectedFlow.getStep(stepTarget);
      if (targetStep) {
        updatedSession = enterStep(updatedSession, targetStep.id, targetStep.description);
        logger.debug(`[ResponsePipeline] Branch directive goToStep → ${targetStep.id}`);
        return { nextStep: targetStep, session: updatedSession };
      }
      throw new FlowConfigurationError(
        `[FlowConfigurationError] Branch directive goToStep targets unknown step: "${stepTarget}" does not exist in flow "${selectedFlow.id}". ` +
        `Fix the goToStep value to reference a valid step id in the current flow.`
      );
    }

    if (directive.goTo) {
      const flowTarget = typeof directive.goTo === 'string'
        ? directive.goTo
        : directive.goTo.flow ?? directive.goTo.step;

      if (flowTarget) {
        const flows = this.getFlows();
        const targetFlow = flows.find(f => f.id === flowTarget || f.title === flowTarget);
        if (targetFlow) {
          updatedSession = enterFlow(updatedSession, targetFlow.id, targetFlow.title);

          // If goTo is an object with a step field, enter that step too
          if (typeof directive.goTo === 'object' && directive.goTo.step) {
            updatedSession = enterStep(updatedSession, directive.goTo.step);
          }

          logger.debug(`[ResponsePipeline] Branch directive goTo → ${targetFlow.title}`);
          return { nextStep: undefined, session: updatedSession, flowChanged: targetFlow };
        }
        throw new FlowConfigurationError(
          `[FlowConfigurationError] Branch directive goTo targets unknown flow: "${flowTarget}" does not match any flow id or title. ` +
          `Fix the goTo value to reference a valid flow.`
        );
      }
    }

    if (directive.complete) {
      logger.debug(`[ResponsePipeline] Branch directive complete`);
      return { nextStep: undefined, session: updatedSession };
    }

    if (directive.abort) {
      logger.debug(`[ResponsePipeline] Branch directive abort`);
      return { nextStep: undefined, session: updatedSession };
    }

    if (directive.reset) {
      const resetStep = typeof directive.reset === 'object' && directive.reset.step
        ? directive.reset.step
        : undefined;
      if (resetStep) {
        const targetStep = selectedFlow.getStep(resetStep);
        if (targetStep) {
          updatedSession = enterStep(updatedSession, targetStep.id, targetStep.description);
          return { nextStep: targetStep, session: updatedSession };
        }
      }
      // Reset to initial step
      const initialStep = selectedFlow.initialStep;
      updatedSession = enterStep(updatedSession, initialStep.id, initialStep.description);
      logger.debug(`[ResponsePipeline] Branch directive reset → ${initialStep.id}`);
      return { nextStep: initialStep, session: updatedSession };
    }

    // Directive with only non-position fields (e.g., just dataUpdate/contextUpdate/reply)
    // No position change — fall through to linear selection
    return { nextStep: undefined, session: updatedSession };
  }


  /**
   * TURN ROUTING + STEP SELECTION — the single entry point for deciding which
   * flow and step a turn renders. Runs the routing-skip optimization, the
   * pre-signal phase (parallel with routing when a processor is configured),
   * pre-extraction, and next-step determination.
   */
  async routeAndSelectStep(params: {
    session: SessionState<TData>;
    history: Event[]; // Use Event[] for internal processing
    context: TContext;
    signal?: AbortSignal;
    /** Restrict this turn's routing candidates (entry pins). */
    allowedFlows?: string[];
  }): Promise<{
    selectedFlow?: Flow<TContext, TData>;
    selectedStep?: Step<TContext, TData>;
    responseDirectives?: string[];
    session: SessionState<TData>;
    isFlowComplete: boolean;
    /** Signal firings from the pre-phase (threaded through for response surface). */
    signalFirings?: SignalFiring<TContext, TData>[];
    /** Non-position signal directive for pre-LLM augmentation (appendPrompt, injectTools, etc). */
    signalPreDirective?: Directive<TContext, TData>;
    /** Pre-signal phase halted the turn. */
    signalHalted?: boolean;
    /** Reply text from the halt directive. */
    signalHaltReply?: string;
    /** Flows exited via pendingDirective redirects/resets this turn. */
    endedFlows?: EndedFlow[];
  }> {
    try {
      // Create a fresh chain tracker for this turn (Requirement 22.1)
      this.createChainTracker();

      // ROUTING SKIP OPTIMIZATION (Requirements 20.1, 20.2, 20.3):
      // When the current step has collect fields AND step-scoped pre-extraction
      // populates at least one of those fields, skip FlowRouter.decideFlowAndStep
      // for this turn. The check's extraction result is reused by the fallthrough
      // paths below so a turn costs at most ONE extraction LLM call.
      const routingSkipCheck = await this.attemptRoutingSkipForCollect(params);
      if (routingSkipCheck.skipResult) {
        const skipResult = routingSkipCheck.skipResult;
        // Even when routing is skipped, run pre-signal phase if processor is present
        if (this.signalCoordinator.enabled) {
          const signalResult = await this.signalCoordinator.runPrePhase(
            params.session, params.context, params.history,
          );
          // If signal halts, override the routing skip result
          if (signalResult.mergedDirective?.halt) {
            return {
              ...skipResult,
              session: signalResult.updatedSession,
              signalFirings: signalResult.firings,
              signalHalted: true,
              signalHaltReply: signalResult.mergedDirective.reply,
            };
          }
          // If signal has position fields, override routing skip result
          if (hasDirectivePositionField(signalResult.mergedDirective)) {
            return this.signalCoordinator.applyPositionDirective(signalResult);
          }
          // Non-position directive: keep the skip result (extraction merges,
          // step entry) and re-apply the signal phase's non-position mutations
          return {
            ...skipResult,
            session: this.combineRoutingAndSignalSessions({
              inputSession: params.session,
              signalSession: signalResult.updatedSession,
              routingSession: skipResult.session,
            }),
            signalFirings: signalResult.firings,
            signalPreDirective: signalResult.mergedDirective || undefined,
          };
        }
        return skipResult;
      }

      // ── PARALLEL PRE-SIGNAL PHASE + ROUTING (Algorithm 5) ────────────────
      // When signalProcessor is present, run pre-signals in parallel with routing.
      // When absent, call the router directly (zero overhead, preserve current behavior).
      if (this.signalCoordinator.enabled) {
        // Run pre-signal phase in parallel with routing (Requirement 8.1)
        const [signalResult, routingResult] = await Promise.all([
          this.signalCoordinator.runPrePhase(
            params.session, params.context, params.history,
          ),
          this.handleRoutingAndStepSelection({
            session: params.session,
            history: params.history,
            context: params.context,
            signal: params.signal,
            allowedFlows: params.allowedFlows,
          }),
        ]);

        // ── Requirement 8.2: halt → discard routing, skip LLM ────────────
        if (signalResult.mergedDirective?.halt) {
          return {
            selectedFlow: undefined,
            selectedStep: undefined,
            session: signalResult.updatedSession,
            isFlowComplete: false,
            signalFirings: signalResult.firings,
            signalHalted: true,
            signalHaltReply: signalResult.mergedDirective.reply,
          };
        }

        // ── Requirement 8.3: position directive → discard routing, apply signal position ──
        if (hasDirectivePositionField(signalResult.mergedDirective)) {
          return this.signalCoordinator.applyPositionDirective(signalResult);
        }

        // ── Requirement 8.4: non-position directive → use routing, propagate augmentation ──
        // ── Requirement 8.5: no directive → use routing as-is ─────────────
        // Base = routed session (position state AND router data merges such as
        // flow initialData survive); the signal phase's non-position mutations
        // (trigger state, handler data writes) are re-applied on top.
        let updatedSession = this.combineRoutingAndSignalSessions({
          inputSession: params.session,
          signalSession: signalResult.updatedSession,
          routingSession: routingResult.session,
        });

        // Explicit dataUpdate from the signal's merged directive lands last
        if (signalResult.mergedDirective?.dataUpdate) {
          updatedSession = mergeCollected(updatedSession, signalResult.mergedDirective.dataUpdate);
        }

        const isFlowComplete = routingResult.isFlowComplete;

        // PRE-EXTRACTION: same logic as below — extract data from user message.
        // Reuses the routing-skip check's step-scoped extraction when it already
        // ran this turn (at most ONE extraction LLM call per turn).
        if (routingResult.selectedFlow && !isFlowComplete) {
          let extractedData: Partial<TData> | undefined;
          if (routingSkipCheck.extractionRan) {
            extractedData = routingSkipCheck.extractedData;
          } else if (this.shouldPreExtractData(routingResult.selectedFlow)) {
            logger.debug(
              `[ResponsePipeline] Pre-extracting data for flow: ${routingResult.selectedFlow.title}`
            );
            extractedData = await this.preExtractFlowData({
              route: routingResult.selectedFlow,
              history: params.history,
              context: params.context,
              session: updatedSession,
              signal: params.signal,
            });
          }
          if (extractedData && Object.keys(extractedData).length > 0) {
            logger.debug(`[ResponsePipeline] Pre-extracted data:`, extractedData);
            updatedSession = mergeCollected(updatedSession, extractedData);
            await this.updateCollectedData(extractedData);
          }
        }

        // Determine next step
        const stepResult = await this.determineNextStep({
          selectedFlow: routingResult.selectedFlow,
          selectedStep: routingResult.selectedStep,
          session: updatedSession,
          isFlowComplete,
          context: params.context,
        });

        return {
          selectedFlow: stepResult.flowChanged || routingResult.selectedFlow,
          selectedStep: stepResult.nextStep,
          responseDirectives: routingResult.responseDirectives,
          session: stepResult.session,
          isFlowComplete: stepResult.flowChanged ? false : isFlowComplete,
          signalFirings: signalResult.firings,
          signalPreDirective: signalResult.mergedDirective || undefined,
          endedFlows: routingResult.endedFlows,
        };
      }

      // ── No signal processor: existing behavior (zero overhead) ────────────
      const routingResult = await this.handleRoutingAndStepSelection({
        session: params.session,
        history: params.history,
        context: params.context,
        signal: params.signal,
        allowedFlows: params.allowedFlows,
      });

      let updatedSession = routingResult.session;
      const isFlowComplete = routingResult.isFlowComplete;

      // PRE-EXTRACTION: If entering a flow that collects data, extract data from user message first
      // This allows us to skip steps whose data is already provided.
      // Reuses the routing-skip check's step-scoped extraction when it already
      // ran this turn — at most ONE extraction LLM call per turn.
      if (routingResult.selectedFlow && !isFlowComplete) {
        // Always pre-extract when flow collects data (not just on new flow entry)
        // This ensures step selection has the most up-to-date data
        let extractedData: Partial<TData> | undefined;
        if (routingSkipCheck.extractionRan) {
          extractedData = routingSkipCheck.extractedData;
        } else if (this.shouldPreExtractData(routingResult.selectedFlow)) {
          logger.debug(
            `[ResponsePipeline] Pre-extracting data for flow: ${routingResult.selectedFlow.title}`
          );

          extractedData = await this.preExtractFlowData({
            route: routingResult.selectedFlow,
            history: params.history,
            context: params.context,
            session: updatedSession,
            signal: params.signal,
          });
        }

        if (extractedData && Object.keys(extractedData).length > 0) {
          logger.debug(
            `[ResponsePipeline] Pre-extracted data:`,
            extractedData
          );
          // Merge pre-extracted data into session before step selection
          updatedSession = mergeCollected(updatedSession, extractedData);
          // Also update agent's collected data
          await this.updateCollectedData(extractedData);
        }
      }

      // Determine next step using pipeline method for consistency
      const stepResult = await this.determineNextStep({
        selectedFlow: routingResult.selectedFlow,
        selectedStep: routingResult.selectedStep,
        session: updatedSession, // Use updated session with pre-extracted data
        isFlowComplete, // Use updated completion status
        context: params.context,
      });

      return {
        selectedFlow: stepResult.flowChanged || routingResult.selectedFlow,
        selectedStep: stepResult.nextStep, // Use the determined next step
        responseDirectives: routingResult.responseDirectives,
        session: stepResult.session,
        // If a branch changed the flow, the original isFlowComplete no longer applies
        isFlowComplete: stepResult.flowChanged ? false : isFlowComplete,
        endedFlows: routingResult.endedFlows,
      };
    } catch (error) {
      throw ResponseGenerationError.fromError(error, 'routing_optimization', params);
    }
  }

  /**
   * RENDER-STEP RESOLUTION — resolve the step a flow response will render,
   * shared by the streaming and non-streaming paths. When no step was
   * pre-selected: branches win over the linear chain, then candidate steps,
   * then the initial-step fallback. Enforces `requires` (stays at the current
   * step when required fields are missing) and enters the resolved step.
   *
   * Returns `flowTransition: true` when a branch resolved to a flow
   * transition or completion — there is no local step to render and the
   * caller handles the transition.
   */
  async resolveRenderStep(params: {
    selectedFlow: Flow<TContext, TData>;
    selectedStep?: Step<TContext, TData>;
    session: SessionState<TData>;
    context: TContext;
  }): Promise<{
    nextStep?: Step<TContext, TData>;
    session: SessionState<TData>;
    flowTransition: boolean;
  }> {
    const { selectedFlow, selectedStep, context } = params;
    let session = params.session;

    // Determine next step
    let nextStep: Step<TContext, TData>;
    if (selectedStep) {
      nextStep = selectedStep;
    } else {
      // Determine current step from session if we're already in this flow
      const isInSameFlow = session.currentFlow?.id === selectedFlow.id;
      const currentStep = isInSameFlow && session.currentStep
        ? selectedFlow.getStep(session.currentStep.id)
        : undefined;

      logger.debug(`[ResponsePipeline] Step determination: flow match=${isInSameFlow}, currentFlow=${session.currentFlow?.id}, selectedFlow=${selectedFlow.id}, currentStep=${currentStep?.id || 'none'}`);

      // STEP 1 (Algorithm 1): branches win over linear chain
      if (currentStep?.branches && currentStep.branches.length > 0) {
        const branchResult = await this.evaluateStepBranches(
          currentStep, selectedFlow, session, context
        );
        if (branchResult) {
          if (branchResult.nextStep) {
            nextStep = branchResult.nextStep;
            session = branchResult.session;
          } else {
            // Flow transition or completion — no local step to render
            return { nextStep: undefined, session: branchResult.session, flowTransition: true };
          }
        }
      }

      if (!nextStep!) {
        // Get candidate steps based on current position in the flow
        const candidates = await this.flowRouter.getCandidateStepsWithConditions(
          selectedFlow,
          currentStep, // Pass current step instead of undefined to maintain progression
          createTemplateContext({ data: session.data, session, context })
        );

        logger.debug(`[ResponsePipeline] Found ${candidates.length} candidate steps${currentStep ? ' from current step ' + currentStep.id : ' (new flow entry)'}`);

        if (candidates.length > 0) {
          nextStep = candidates[0].step;
          logger.debug(`[ResponsePipeline] Using first valid step: ${nextStep.id}${currentStep ? ' (progressing from ' + currentStep.id + ')' : ' for new flow'}`);
        } else {
          // Fallback to initial step even if it should be skipped
          nextStep = selectedFlow.initialStep;
          logger.warn(`[FlowConfigurationError] No valid steps found: all candidates were skipped in flow. Falling back to initial step "${nextStep.id}". Review step skip conditions.`);
        }
      }
    }

    // Update session with next step
    // If the next step has requires fields that are missing, stay at the previous step
    if (nextStep.requires && nextStep.requires.length > 0) {
      const sessionData = session.data || {};
      const missingRequires = nextStep.requires.filter(
        field => (sessionData as Record<string, unknown>)[String(field)] === undefined
      );
      if (missingRequires.length > 0) {
        const warning = `[FlowConfigurationError] Cannot advance to step "${nextStep.description || nextStep.id}": ` +
          `missing required fields [${missingRequires.join(', ')}]. Staying at current step. Ensure preceding steps collect these fields.`;
        logger.warn(warning);
        console.warn(warning);
        // Stay at the current step - don't enter the next one
        const currentStepId = session.currentStep?.id;
        if (currentStepId) {
          const currentStepInstance = selectedFlow.getStep(currentStepId);
          if (currentStepInstance) {
            nextStep = currentStepInstance;
            logger.debug(`[ResponsePipeline] Staying at current step: ${nextStep.id} due to missing requires`);
          }
        }
      } else {
        session = enterStep(session, nextStep.id, nextStep.description);
        logger.debug(`[ResponsePipeline] Entered step: ${nextStep.id}`);
      }
    } else {
      session = enterStep(session, nextStep.id, nextStep.description);
      logger.debug(`[ResponsePipeline] Entered step: ${nextStep.id}`);
    }

    return { nextStep, session, flowTransition: false };
  }

  /**
   * Routing skip check (Requirements 20.1, 20.2, 20.3):
   * When the current step declares `collect` fields AND step-scoped extraction
   * populates at least one of those fields from the user's message, the caller
   * skips routing for this turn (`skipResult`).
   *
   * The extraction is scoped to EXACTLY this step's collect fields — incidental
   * mentions of other (e.g. other-flow) fields cannot pin the routing decision.
   * It is skipped entirely when every collect field is already populated.
   *
   * Always returns what the check did so the caller can reuse the single
   * extraction result in its normal path instead of extracting twice:
   * - `extractionRan` — whether an extraction LLM call was made this turn.
   * - `extractedData` — that call's result (empty when nothing found / not run).
   */
  private async attemptRoutingSkipForCollect(params: {
    session: SessionState<TData>;
    history: Event[];
    context: TContext;
    signal?: AbortSignal;
  }): Promise<{
    extractionRan: boolean;
    extractedData: Partial<TData>;
    skipResult?: {
      selectedFlow?: Flow<TContext, TData>;
      selectedStep?: Step<TContext, TData>;
      responseDirectives?: string[];
      session: SessionState<TData>;
      isFlowComplete: boolean;
    };
  }> {
    const { session } = params;
    const notApplicable = { extractionRan: false, extractedData: {} as Partial<TData> };

    // Only applies when we already have a current flow and step
    if (!session.currentFlow || !session.currentStep) {
      return notApplicable;
    }

    // Also skip this optimization if there's a pending directive (it takes priority)
    if (session.pendingDirective) {
      return notApplicable;
    }

    // Look up the actual Flow and Step objects to access `collect`
    const currentFlow = this.getFlows().find(
      (f) => f.id === session.currentFlow?.id
    );
    if (!currentFlow) {
      return notApplicable;
    }

    const currentStep = currentFlow.getStep(session.currentStep.id);
    if (!currentStep || !currentStep.collect || currentStep.collect.length === 0) {
      return notApplicable;
    }

    const collectFields = currentStep.collect;

    // Every relevant field already set — the skip cannot fire; don't spend
    // an extraction LLM call probing for it.
    const sessionRecord = (session.data ?? {}) as Record<string, unknown>;
    const allPopulated = collectFields.every((field) => {
      const value = sessionRecord[String(field)];
      return value !== undefined && value !== null;
    });
    if (allPopulated) {
      return notApplicable;
    }

    // Snapshot current data for comparison
    const dataBefore = { ...sessionRecord } as Record<string, unknown>;

    // Step-scoped pre-extraction: see if the user's message populates any of
    // THIS step's collect fields.
    const extractedData = await this.preExtractFlowData({
      route: currentFlow,
      history: params.history,
      context: params.context,
      session,
      signal: params.signal,
      restrictToFields: collectFields.map(String),
    });

    if (!extractedData || Object.keys(extractedData).length === 0) {
      return { extractionRan: true, extractedData: {} };
    }

    // Determine which collect fields were newly populated by pre-extraction
    const extractedRecord = extractedData as Record<string, unknown>;
    const populatedCollectFields: string[] = [];
    for (const field of collectFields) {
      const key = String(field);
      const hadValue =
        dataBefore[key] !== undefined && dataBefore[key] !== null;
      const hasNewValue =
        extractedRecord[key] !== undefined && extractedRecord[key] !== null;
      if (hasNewValue && !hadValue) {
        populatedCollectFields.push(key);
      }
    }

    if (populatedCollectFields.length === 0) {
      // Pre-extraction didn't populate any declared collect field — no skip
      return { extractionRan: true, extractedData };
    }

    // ROUTING SKIP: pre-extraction populated collect fields → retain current flow/step
    logger.debug(
      `[ResponsePipeline] Routing skip: pre-extraction populated collect fields [${populatedCollectFields.join(', ')}] for step "${currentStep.id}" — skipping FlowRouter`
    );

    // Merge extracted data into session
    const updatedSession = mergeCollected(session, extractedData);
    await this.updateCollectedData(extractedData);

    // Determine next step using pipeline method for consistency
    // Pass the current flow/step as the routing result (retained)
    const stepResult = await this.determineNextStep({
      selectedFlow: currentFlow,
      selectedStep: currentStep,
      session: updatedSession,
      isFlowComplete: false,
      context: params.context,
    });

    return {
      extractionRan: true,
      extractedData,
      skipResult: {
        selectedFlow: stepResult.flowChanged || currentFlow,
        selectedStep: stepResult.nextStep,
        responseDirectives: undefined,
        session: stepResult.session,
        isFlowComplete: false,
      },
    };
  }

  /**
   * Check if a flow should pre-extract data before determining the initial step
   */
  private shouldPreExtractData(flow: Flow<TContext, TData>): boolean {
    // Pre-extract if flow has declared required or optional fields
    if (flow.requiredFields && flow.requiredFields.length > 0) {
      return true;
    }
    if (flow.optionalFields && flow.optionalFields.length > 0) {
      return true;
    }

    // Pre-extract if any step in the flow collects data
    const steps = flow.getAllSteps();
    const hasDataCollectionSteps = steps.some(
      step => step.collect && step.collect.length > 0
    );

    return hasDataCollectionSteps;
  }

  /**
   * Build an extraction schema limited to the given subset of agent schema
   * fields. Used by the routing-skip probe so only the current step's collect
   * fields are visible to the extractor.
   */
  private buildFieldRestrictedSchema(
    agentSchema: StructuredSchema,
    fields: string[],
  ): StructuredSchema {
    const properties: Record<string, StructuredSchema> = {};
    for (const field of fields) {
      const prop = agentSchema.properties?.[field];
      if (prop) {
        properties[field] = prop;
      }
    }
    return {
      type: "object",
      description: `Extraction restricted to these fields: ${fields.join(', ')}`,
      properties,
      additionalProperties: false,
    };
  }

  /**
   * Pre-extract data from user message when entering a flow
   * This allows skipping steps whose data is already provided
   */
  private async preExtractFlowData(params: {
    route: Flow<TContext, TData>;
    history: Event[];
    context: TContext;
    session: SessionState<TData>;
    signal?: AbortSignal;
    /** When set, extraction is restricted to exactly these schema fields (step-scoped routing-skip probe). */
    restrictToFields?: string[];
  }): Promise<Partial<TData>> {
    const { route: flow, history, signal, restrictToFields } = params;

    // Build a schema for data extraction based on flow's fields
    const agentSchema = this.getSchema();
    if (!agentSchema) {
      logger.warn(`[ResponsePipeline] No schema available for pre-extraction`);
      return {};
    }
    const extractionSchema = restrictToFields
      ? this.buildFieldRestrictedSchema(agentSchema, restrictToFields)
      : agentSchema;

    // Get last user message
    const lastMessage = getLastMessageFromHistory(history);

    // Build extraction prompt
    const extractionPrompt = [
      `Extract any relevant information from the user's message that matches the following data fields.`,
      `Only extract information that is explicitly stated or clearly implied.`,
      ``,
      `User's message: "${lastMessage}"`,
      ``,
      `Extract data for these fields if present:`,
    ];

    // Add field descriptions
    if (restrictToFields) {
      extractionPrompt.push(`Only these fields: ${restrictToFields.join(', ')}`);
    } else {
      if (flow.requiredFields) {
        extractionPrompt.push(`Required fields: ${flow.requiredFields.join(', ')}`);
      }
      if (flow.optionalFields) {
        extractionPrompt.push(`Optional fields: ${flow.optionalFields.join(', ')}`);
      }
    }

    extractionPrompt.push(
      ``,
      `Return ONLY the extracted data as JSON. If no data can be extracted, return an empty object {}.`
    );

    // Convert Event[] to HistoryItem[] for provider call
    const historyItems = eventsToHistory(history);

    // Call AI to extract data
    try {
      const result = await this.options.provider.generateMessage<TContext, Partial<TData>>({
        prompt: extractionPrompt.join('\n'),
        history: historyItems,
        context: {} as TContext, // Passed as empty object so AI doesn't "extract" from context
        // NOTE: context is intentionally NOT passed here.
        // Passing context caused the AI to "extract" data from the lead's context
        // (e.g., name, sector, city) instead of from what the user actually said.
        signal,
        parameters: {
          jsonSchema: extractionSchema,
          schemaName: 'data_extraction',
        },
      });

      return result.structured || {};
    } catch (error) {
      logger.error(`[ResponsePipeline] Pre-extraction failed:`, error);
      return {};
    }
  }

}
