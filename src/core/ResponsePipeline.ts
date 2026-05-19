/**
 * Response processing utilities shared between respond() and respondStream() methods
 */

import type {
  AgentOptions,
  Event,
  SessionState,
  AgentStructuredResponse,
  Tool,
  Directive,
} from "../types";
import type { SignalFiring } from "../types/signals";
import type { SignalProcessor } from "./SignalProcessor";
import type { HistoryItem } from "../types/history";
import {
  createSession,
  enterStep,
  mergeCollected,
  completeCurrentFlow,
  logger,
  historyToEvents,
  serializeToolResult,
} from "../utils";
import { enterFlow } from "../utils/session";
import { createTemplateContext } from "../utils/template";
import { Flow } from "./Flow";
import { Step, FlowConfigurationError } from "../core/Step";
import { FlowRouter } from "./FlowRouter";
import type { ToolManager } from "../core/ToolManager";
import { evaluateBranches, createAiConditionEvaluator } from "./BranchEvaluator";
import { DirectiveChainTracker } from "./DirectiveChainTracker";
import { DirectiveBus } from "./DirectiveBus";

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

export interface ResponsePreparationResult<TContext, TData = unknown> {
  effectiveContext: TContext;
  session: SessionState<TData>;
}

export interface RoutingResult<TContext, TData = unknown> {
  selectedFlow: Flow<TContext, TData> | undefined;
  selectedStep: Step<TContext, TData> | undefined;
  responseDirectives: string[] | undefined;
  session: SessionState<TData>;
  isFlowComplete: boolean;
  completedFlows?: Flow<TContext, TData>[];
}

export interface ToolExecutionResult<TData = unknown> {
  session: SessionState<TData>;
  toolCalls:
  | Array<{ toolName: string; arguments: Record<string, unknown> }>
  | undefined;
  /** Map of tool name to serialized result data for inclusion in conversation history */
  toolResults?: Map<string, string>;
}

export interface DataCollectionResult<TData = unknown> {
  session: SessionState<TData>;
  collectedData?: Partial<TData>;
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
    private readonly tools: Tool<TContext, TData>[],
    private readonly flowRouter: FlowRouter<TContext, TData>,
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
    private readonly toolManager?: ToolManager<TContext, TData>,
    private readonly signalProcessor?: SignalProcessor<TContext, TData>
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
   * Create a fresh DirectiveBus for a new turn.
   * The bus collects directives from hooks, tools, and branches during the turn
   * and merges them at phase boundaries via Algorithm 4.
   */
  createDirectiveBus(): DirectiveBus<TContext, TData> {
    return new DirectiveBus<TContext, TData>();
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Signal pipeline phases
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * PRE-SIGNAL PHASE — Evaluates pre/both signals in parallel with routing.
   *
   * Delegates to `signalProcessor.runPreSignalPhase(...)` when configured.
   * When no signal processor is present (zero-cost path), returns a stable
   * empty shape so callers don't need to branch.
   *
   * @requirements 2.1, 2.3, 8.6, 13.3
   */
  async runPreSignalPhase(
    session: SessionState<TData>,
    context: TContext,
    history: Event[],
  ): Promise<{
    firings: SignalFiring<TContext, TData>[];
    updatedSession: SessionState<TData>;
    mergedDirective: Directive<TContext, TData> | undefined;
  }> {
    if (!this.signalProcessor) {
      return { firings: [], updatedSession: session, mergedDirective: undefined };
    }
    const result = await this.signalProcessor.runPreSignalPhase({ session, history, context });
    return {
      firings: result.firings,
      updatedSession: result.updatedSession,
      mergedDirective: result.mergedDirective,
    };
  }

  /**
   * POST-SIGNAL PHASE — Evaluates post/both signals after finalize/onComplete.
   *
   * Delegates to `signalProcessor.runPostSignalPhase(...)` when configured.
   * When no signal processor is present, returns a stable empty shape.
   *
   * Post-phase signals see the complete turn result: assistant message in history,
   * collected data, tool results. Position directives from this phase set
   * `session.pendingDirective` (no mid-turn re-entry per D6 decision).
   *
   * Pre-LLM-only fields (`appendPrompt`, `injectTools`, `halt`) are already
   * dropped inside `runPostSignalPhase` per Phase 4.5 — this seam does NOT
   * re-introduce them.
   *
   * @requirements 9.1, 9.2, 9.3, 9.4
   */
  async runPostSignalPhase(
    session: SessionState<TData>,
    context: TContext,
    history: Event[],
  ): Promise<{
    firings: SignalFiring<TContext, TData>[];
    updatedSession: SessionState<TData>;
    mergedDirective: Directive<TContext, TData> | undefined;
  }> {
    if (!this.signalProcessor) {
      return { firings: [], updatedSession: session, mergedDirective: undefined };
    }
    const result = await this.signalProcessor.runPostSignalPhase({ session, history, context });
    return {
      firings: result.firings,
      updatedSession: result.updatedSession,
      mergedDirective: result.mergedDirective,
    };
  }

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

    // PHASE 2: ROUTING + STEP SELECTION - Determine which flow and step to use (combined)
    let selectedFlow: Flow<TContext, TData> | undefined;
    let responseDirectives: string[] | undefined;
    let selectedStep: Step<TContext, TData> | undefined;
    let isFlowComplete = false;
    let completedFlows: Flow<TContext, TData>[] = [];
    let targetSession = session;

    // Get flows early since we need them for pending directives
    const flows = this.getFlows();

    // Check for pending directive from previous flow completion or external dispatch
    if (targetSession.pendingDirective) {
      const directive = targetSession.pendingDirective;
      logger.debug(
        `[ResponseHandler] Applying pending directive at start of turn`
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

      // Apply the directive: resolve position field to a flow/step
      if (directive.goTo) {
        const flowTarget = typeof directive.goTo === 'string'
          ? directive.goTo
          : directive.goTo.flow;

        if (flowTarget) {
          const targetFlow = flows.find(
            (r) => r.id === flowTarget || r.title === flowTarget
          );

          if (targetFlow) {
            logger.debug(
              `[ResponseHandler] Pending directive goTo → flow: ${targetFlow.title}`
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

    // If no pending transition or transition handled, do normal routing
    if (flows.length > 0 && !selectedFlow) {
      const orchestration = await this.flowRouter.decideFlowAndStep({
        flows: flows,
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
          `[ResponseHandler] Flow complete: all required data collected or last step reached`
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
    };
  }

  /**
   * Determine next step and update session
   */
  async determineNextStep(params: {
    selectedFlow: Flow<TContext, TData> | undefined;
    selectedStep: Step<TContext, TData> | undefined;
    session: SessionState<TData>;
    isFlowComplete: boolean;
    /** Merged directive from the directive bus (pre-LLM + post-LLM phases). */
    busDirective?: Directive<TContext, TData>;
  }): Promise<{ nextStep: Step<TContext, TData> | undefined; session: SessionState<TData>; flowChanged?: Flow<TContext, TData> }> {
    const { selectedFlow, selectedStep, session, isFlowComplete, busDirective } = params;

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
        `[ResponseHandler] Directive bus winner has position field — skipping branch evaluation and linear/AI selection`,
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
        const contextToUse = this.getStoredContext();
        const branchResult = await this.evaluateStepBranches(
          currentStep, selectedFlow, session, contextToUse as TContext
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

      const contextToUse = this.getStoredContext();

      // Get candidate steps based on current position in the flow
      const candidates = await this.flowRouter.getCandidateStepsWithConditions(
        selectedFlow,
        currentStep, // Pass current step instead of undefined to maintain progression
        createTemplateContext({ data: session.data, session, context: contextToUse })
      );

      if (candidates.length > 0) {
        nextStep = candidates[0].step;
        logger.debug(
          `[ResponseHandler] Using first valid step: ${nextStep.id}${currentStep ? ' (progressing from ' + currentStep.id + ')' : ' for new flow'}`
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
          `[ResponseHandler] Cannot enter step "${nextStep.id}": missing required fields [${missingRequires.join(', ')}]. Staying at current step.`
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
    logger.debug(`[ResponseHandler] Entered step: ${nextStep.id}`);

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
      logger.debug(`[ResponseHandler] Branch resolved to local step: ${localStep.id}`);
      return { nextStep: localStep, session: updatedSession };
    }

    // 2. Look up in agent's flow registry
    const flows = this.getFlows();
    const targetFlow = flows.find(f => f.id === result || f.title === result);
    if (targetFlow) {
      // Treat as applyDirective({ goTo: result }) — enter the target flow
      logger.debug(`[ResponseHandler] Branch resolved to flow: ${targetFlow.title}`);
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
          logger.debug(`[ResponseHandler] Branch directive goToStep → ${flowTarget}.${stepTarget}`);
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
        logger.debug(`[ResponseHandler] Branch directive goToStep → ${targetStep.id}`);
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

          logger.debug(`[ResponseHandler] Branch directive goTo → ${targetFlow.title}`);
          return { nextStep: undefined, session: updatedSession, flowChanged: targetFlow };
        }
        throw new FlowConfigurationError(
          `[FlowConfigurationError] Branch directive goTo targets unknown flow: "${flowTarget}" does not match any flow id or title. ` +
          `Fix the goTo value to reference a valid flow.`
        );
      }
    }

    if (directive.complete) {
      logger.debug(`[ResponseHandler] Branch directive complete`);
      return { nextStep: undefined, session: updatedSession };
    }

    if (directive.abort) {
      logger.debug(`[ResponseHandler] Branch directive abort`);
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
      logger.debug(`[ResponseHandler] Branch directive reset → ${initialStep.id}`);
      return { nextStep: initialStep, session: updatedSession };
    }

    // Directive with only non-position fields (e.g., just dataUpdate/contextUpdate/reply)
    // No position change — fall through to linear selection
    return { nextStep: undefined, session: updatedSession };
  }

  /**
   * Execute tool calls and handle results
   */
  async executeToolCalls(params: {
    toolCalls: Array<{ toolName: string; arguments: Record<string, unknown> }>;
    selectedFlow?: Flow<TContext, TData>;
    context: TContext;
    session: SessionState<TData>;
    history: Event[];
    isStreaming?: boolean;
  }): Promise<ToolExecutionResult<TData>> {
    const {
      toolCalls,
      selectedFlow,
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
    const toolResults = new Map<string, string>();

    for (const toolCall of toolCalls) {
      const tool = this.findAvailableTool(toolCall.toolName, selectedFlow);
      if (!tool) {
        logger.warn(`[ToolExecutionError] Tool not found: "${toolCall.toolName}" is not registered in any scope (transient, step, flow, or agent). Skipping this tool call. Register the tool or check the tool name.`);
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

      // Store the actual tool result data for history
      toolResults.set(toolCall.toolName, serializeToolResult(result));

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
        `[ResponseHandler] Executed ${isStreaming ? "streaming " : ""}tool: ${String(tool.id || tool.id || 'unknown')
        } (success: ${result.success})`
      );
    }

    return {
      session: updatedSession,
      toolCalls: executedToolCalls.length > 0 ? executedToolCalls : undefined,
      toolResults,
    };
  }

  /**
   * Execute tool loop for follow-up tool calls
   */
  async executeToolLoop(params: {
    initialToolCalls:
    | Array<{ toolName: string; arguments: Record<string, unknown> }>
    | undefined;
    selectedFlow?: Flow<TContext, TData>;
    nextStep: Step<TContext, TData>;
    responsePrompt: string;
    history: HistoryItem[];
    context: TContext;
    session: SessionState<TData>;
    responseSchema: Record<string, unknown>;
    isStreaming?: boolean;
  }): Promise<ToolExecutionResult<TData>> {
    const {
      initialToolCalls,
      selectedFlow,
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
    // Track tool results across loop iterations for history
    let currentToolResults = new Map<string, string>();

    while (hasToolCalls && toolLoopCount < MAX_TOOL_LOOPS) {
      toolLoopCount++;
      logger.debug(
        `[ResponseHandler] Starting ${isStreaming ? "streaming " : ""
        }tool loop ${toolLoopCount}/${MAX_TOOL_LOOPS}`
      );

      // Add tool execution results to history so AI knows what happened
      const toolResultItems: HistoryItem[] = [];
      for (const toolCall of currentToolCalls || []) {
        const tool = this.findAvailableTool(toolCall.toolName, selectedFlow);
        if (tool) {
          toolResultItems.push({
            role: "assistant" as const,
            content: null,
            tool_calls: [{
              id: toolCall.toolName,
              name: toolCall.toolName,
              arguments: toolCall.arguments,
            }],
          });
          toolResultItems.push({
            role: "tool" as const,
            tool_call_id: toolCall.toolName,
            name: toolCall.toolName,
            content: currentToolResults.get(toolCall.toolName) || "Tool executed successfully",
          });
        }
      }

      // Create updated history with tool results
      const updatedHistory = [...history, ...toolResultItems];

      // Make follow-up AI call to see if more tools are needed
      const followUpResult = await this.options.provider.generateMessage({
        prompt: responsePrompt,
        history: updatedHistory,
        context,
        tools: this.collectAvailableTools(selectedFlow, nextStep),
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
          selectedFlow,
          context,
          session: currentSession,
          history: historyToEvents(updatedHistory),
          isStreaming,
        });

        currentSession = toolResult.session;
        currentToolCalls = followUpToolCalls;
        currentToolResults = toolResult.toolResults || new Map();
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
        `[ResponseGenerationError] ${isStreaming ? "Streaming t" : "T"}ool loop limit reached: ${toolLoopCount} iterations hit the cap (${MAX_TOOL_LOOPS}). Stopping tool execution. Increase MAX_TOOL_LOOPS or reduce recursive tool calls.`
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
   * Handle flow completion: pure state transition.
   *
   * Releases the session to idle (`currentFlow`/`currentStep` cleared),
   * marks the active `flowHistory` entry completed, and (when `onComplete`
   * is set) wires `pendingDirective` for the next turn. The framework
   * emits no message of its own at the completion boundary; callers that
   * need closing copy should add a final interactive step.
   */
  async handleFlowCompletion(params: {
    selectedFlow: Flow<TContext, TData>;
    session: SessionState<TData>;
    context: TContext;
    history: Event[];
  }): Promise<{ session: SessionState<TData>; hasTransition: boolean }> {
    const { selectedFlow, session, context } = params;

    // Check for onComplete transition
    const transitionConfig = await selectedFlow.evaluateOnComplete(
      { data: session.data },
      context
    );

    // Release to idle. When the flow is reentrant, scrub its owned
    // fields so a future re-selection doesn't short-circuit on stale data.
    const ownedFields = selectedFlow.reentrant
      ? [
        ...(selectedFlow.requiredFields ?? []),
        ...(selectedFlow.optionalFields ?? []),
      ]
      : undefined;
    let updatedSession = completeCurrentFlow(session, {
      clearOwnedFields: ownedFields,
    });

    if (transitionConfig) {
      // Extract target from directive's goTo field
      const goToTarget = typeof transitionConfig.goTo === 'string'
        ? transitionConfig.goTo
        : transitionConfig.goTo?.flow;

      // Find target flow by ID or title
      const targetFlow = goToTarget ? this.getFlows().find(
        (r) =>
          r.id === goToTarget ||
          r.title === goToTarget
      ) : undefined;

      if (targetFlow) {
        updatedSession = {
          ...updatedSession,
          pendingDirective: {
            goTo: targetFlow.id,
          },
        };
        logger.debug(
          `[ResponseHandler] Flow ${selectedFlow.title} completed with pending directive to: ${targetFlow.title}`
        );
        return { session: updatedSession, hasTransition: true };
      } else if (goToTarget) {
        logger.warn(
          `[FlowConfigurationError] onComplete target not found: flow "${selectedFlow.title}" completed but onComplete target "${goToTarget}" does not match any flow. ` +
          `Fix the onComplete value to reference an existing flow id/title, or remove onComplete to release the session to idle.`
        );
      }
    }

    logger.debug(
      `[ResponseHandler] Flow ${selectedFlow.title} completed; session released to idle.`
    );

    return { session: updatedSession, hasTransition: false };
  }


  /**
   * Find an available tool by name for the given flow using ToolManager
   * Delegates to ToolManager for unified tool resolution
   */
  private findAvailableTool(
    toolName: string,
    flow?: Flow<TContext, TData>
  ): Tool<TContext, TData> | undefined {
    // Use ToolManager for unified tool resolution if available
    if (this.toolManager) {
      return this.toolManager.find(toolName, undefined, undefined, flow);
    }

    // Fallback to legacy resolution if ToolManager not available
    logger.warn(`[ResponsePipeline] ToolManager not available, using legacy tool resolution for: ${toolName}`);

    // Check flow-level tools first (if flow provided)
    if (flow) {
      const flowTool = flow
        .getTools()
        .find((tool) => tool.id === toolName || tool.id === toolName);
      if (flowTool) return flowTool;
    }

    // Fall back to agent-level tools
    return this.tools.find(
      (tool) => tool.id === toolName || tool.id === toolName
    );
  }

  /**
   * Collect all available tools for the given flow and step context using ToolManager
   * Delegates to ToolManager for unified tool resolution and deduplication
   */
  private collectAvailableTools(
    flow?: Flow<TContext, TData>,
    step?: Step<TContext, TData>
  ): Array<{ id: string; description?: string; parameters?: unknown }> {
    // Use ToolManager for unified tool collection if available
    if (this.toolManager) {
      const availableTools = this.toolManager.getAvailable(undefined, step, flow);
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

    // Add flow-level tools (these take precedence)
    if (flow) {
      flow.getTools().forEach((tool) => {
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
   * Handle cross-flow completion evaluation and notifications
   * This method evaluates all flows for completion and can trigger completion handlers
   */
  async handleCrossFlowCompletion(params: {
    flows: Flow<TContext, TData>[];
    session: SessionState<TData>;
    context: TContext;
    history: Event[];
  }): Promise<{
    session: SessionState<TData>;
    completedFlows: Flow<TContext, TData>[];
    pendingTransitions: Array<{
      flow: Flow<TContext, TData>;
      transitionConfig: Directive<TContext, TData>;
    }>;
  }> {
    const { flows, session, context } = params;

    // Evaluate all flows for completion
    const completedFlows: Flow<TContext, TData>[] = [];
    const pendingTransitions: Array<{
      flow: Flow<TContext, TData>;
      transitionConfig: Directive<TContext, TData>;
    }> = [];

    for (const flow of flows) {
      if (flow.isComplete(session.data || {})) {
        completedFlows.push(flow);

        // Check for onComplete transitions
        const transitionConfig = await flow.evaluateOnComplete(
          { data: session.data },
          context
        );

        if (transitionConfig) {
          pendingTransitions.push({ flow, transitionConfig });
        }

        logger.debug(
          `[ResponsePipeline] Flow completed: ${flow.title} ` +
          `(${Math.round(flow.getCompletionProgress(session.data || {}) * 100)}%)`
        );
      }
    }

    // Log completion status for all flows
    if (completedFlows.length > 0) {
      logger.debug(
        `[ResponsePipeline] Cross-flow completion evaluation: ` +
        `${completedFlows.length}/${flows.length} flows complete`
      );
    }

    return {
      session,
      completedFlows,
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
    flows: Flow<TContext, TData>[];
  }): Promise<SessionState<TData>> {
    const { session, dataUpdate, flows } = params;

    // Update session data
    const updatedSession = await this.updateData(session, dataUpdate);

    // Update agent-level data if handler is available
    if (this.updateCollectedData) {
      await this.updateCollectedData(dataUpdate);
    }

    // Evaluate flow completions after data update
    const completionResults = await this.handleCrossFlowCompletion({
      flows,
      session: updatedSession,
      context: this.context!,
      history: [],
    });

    // Log any newly completed flows
    if (completionResults.completedFlows.length > 0) {
      logger.debug(
        `[ResponsePipeline] Data update resulted in ${completionResults.completedFlows.length} completed flows`
      );
    }

    return completionResults.session;
  }
}
