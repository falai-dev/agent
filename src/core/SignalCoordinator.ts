/**
 * SignalCoordinator owns the signal pre/post phase orchestration for a turn:
 *
 * - `runPrePhase()` / `runPostPhase()` — delegation to the SignalProcessor,
 *   returning a stable empty shape when no processor is configured.
 * - `applyPositionDirective()` — applies a pre-phase directive's position
 *   field (goTo, goToStep, complete, abort, reset) as the turn's routing
 *   decision, discarding the router's result.
 * - `applyPostPhase()` — runs the post phase and applies its directive to
 *   the turn result in one step: session updates, pendingDirective for
 *   position fields (no mid-turn re-entry per D6), and the reply override
 *   of the user-visible message.
 */

import type { Directive, Event, SessionState } from "../types";
import type { SignalFiring } from "../types/signals";
import type { SignalProcessor } from "./SignalProcessor";
import type { Flow } from "./Flow";
import type { Step } from "./Step";
import { hasDirectivePositionField } from "./ResponsePipeline";
import { enterFlow, enterStep, mergeCollected, logger } from "../utils";

/** Result of a signal phase run (pre or post). */
export interface SignalPhaseResult<TContext = unknown, TData = unknown> {
    firings: SignalFiring<TContext, TData>[];
    updatedSession: SessionState<TData>;
    mergedDirective: Directive<TContext, TData> | undefined;
}

export class SignalCoordinator<TContext = unknown, TData = unknown> {
    constructor(
        private readonly deps: {
            getFlows: () => Flow<TContext, TData>[];
            signalProcessor?: SignalProcessor<TContext, TData>;
        }
    ) { }

    /** Whether a signal processor is configured (zero-cost path when absent). */
    get enabled(): boolean {
        return this.deps.signalProcessor !== undefined;
    }

    /**
     * PRE-SIGNAL PHASE — Evaluates pre/both signals in parallel with routing.
     *
     * Delegates to `signalProcessor.runPreSignalPhase(...)` when configured.
     * When no signal processor is present (zero-cost path), returns a stable
     * empty shape so callers don't need to branch.
     *
     * @requirements 2.1, 2.3, 8.6, 13.3
     */
    async runPrePhase(
        session: SessionState<TData>,
        context: TContext,
        history: Event[],
    ): Promise<SignalPhaseResult<TContext, TData>> {
        if (!this.deps.signalProcessor) {
            return { firings: [], updatedSession: session, mergedDirective: undefined };
        }
        const result = await this.deps.signalProcessor.runPreSignalPhase({ session, history, context });
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
    async runPostPhase(
        session: SessionState<TData>,
        context: TContext,
        history: Event[],
    ): Promise<SignalPhaseResult<TContext, TData>> {
        if (!this.deps.signalProcessor) {
            return { firings: [], updatedSession: session, mergedDirective: undefined };
        }
        const result = await this.deps.signalProcessor.runPostSignalPhase({ session, history, context });
        return {
            firings: result.firings,
            updatedSession: result.updatedSession,
            mergedDirective: result.mergedDirective,
        };
    }

    /**
     * Run the post phase and apply its merged directive to the turn result:
     * session updates from the phase, `pendingDirective` for position fields
     * (Requirement 9.3, no mid-turn re-entry per D6), and the reply override
     * of the user-visible message (undefined means "leave it unchanged"; an
     * empty string is an explicit replacement).
     *
     * @requirements 9.1, 9.2, 9.3, 9.4
     */
    async applyPostPhase(params: {
        session: SessionState<TData>;
        context: TContext;
        historyEvents: Event[];
        message: string;
    }): Promise<{
        session: SessionState<TData>;
        message: string;
        firings: SignalFiring<TContext, TData>[];
        /** True when the directive's `reply` replaced the message. */
        replyOverridden: boolean;
    }> {
        const postResult = await this.runPostPhase(
            params.session, params.context, params.historyEvents,
        );
        let session = postResult.updatedSession;

        // Requirement 9.3: Post-phase position directive sets session.pendingDirective
        if (postResult.mergedDirective && hasDirectivePositionField(postResult.mergedDirective)) {
            session = { ...session, pendingDirective: postResult.mergedDirective };
        }

        const replyOverridden = postResult.mergedDirective?.reply !== undefined;
        const message = replyOverridden
            ? postResult.mergedDirective!.reply!
            : params.message;

        return { session, message, firings: postResult.firings, replyOverridden };
    }

    /**
     * Apply a signal's position directive (goTo, goToStep, complete, abort, reset).
     * Discards routing result and uses the signal's position decision.
     *
     * @requirements 8.3
     */
    applyPositionDirective(
        signalResult: {
            firings: SignalFiring<TContext, TData>[];
            updatedSession: SessionState<TData>;
            mergedDirective: Directive<TContext, TData> | undefined;
        },
    ): {
        selectedFlow?: Flow<TContext, TData>;
        selectedStep?: Step<TContext, TData>;
        responseDirectives?: string[];
        session: SessionState<TData>;
        isFlowComplete: boolean;
        signalFirings?: SignalFiring<TContext, TData>[];
        signalPreDirective?: Directive<TContext, TData>;
        signalHalted?: boolean;
        signalHaltReply?: string;
    } {
        const directive = signalResult.mergedDirective!;
        let session = signalResult.updatedSession;
        const flows = this.deps.getFlows();
        let selectedFlow: Flow<TContext, TData> | undefined;
        let selectedStep: Step<TContext, TData> | undefined;
        let isFlowComplete = false;

        // Apply data updates if present alongside position
        if (directive.dataUpdate) {
            session = mergeCollected(session, directive.dataUpdate);
        }

        if (directive.goTo) {
            const flowTarget = typeof directive.goTo === 'string'
                ? directive.goTo
                : directive.goTo.flow ?? directive.goTo.step;

            if (flowTarget) {
                const targetFlow = flows.find(f => f.id === flowTarget || f.title === flowTarget);
                if (targetFlow) {
                    session = enterFlow(session, targetFlow.id, targetFlow.title);
                    selectedFlow = targetFlow;

                    if (typeof directive.goTo === 'object' && directive.goTo.step) {
                        const targetStep = targetFlow.getStep(directive.goTo.step);
                        if (targetStep) {
                            session = enterStep(session, targetStep.id, targetStep.description);
                            selectedStep = targetStep;
                        }
                    }
                } else {
                    logger.warn(`[Signals] Pre-phase goTo target not found: "${flowTarget}". Falling back to no flow.`);
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
                const targetFlow = flows.find(f => f.id === flowTarget || f.title === flowTarget);
                if (targetFlow) {
                    session = enterFlow(session, targetFlow.id, targetFlow.title);
                    selectedFlow = targetFlow;
                    const targetStep = targetFlow.getStep(stepTarget);
                    if (targetStep) {
                        session = enterStep(session, targetStep.id, targetStep.description);
                        selectedStep = targetStep;
                    }
                }
            } else if (session.currentFlow) {
                const currentFlow = flows.find(f => f.id === session.currentFlow?.id);
                if (currentFlow) {
                    selectedFlow = currentFlow;
                    const targetStep = currentFlow.getStep(stepTarget);
                    if (targetStep) {
                        session = enterStep(session, targetStep.id, targetStep.description);
                        selectedStep = targetStep;
                    }
                }
            }
        } else if (directive.complete) {
            isFlowComplete = true;
        } else if (directive.abort) {
            // Abort — no flow, session cleared or marked
            isFlowComplete = true;
        } else if (directive.reset) {
            if (session.currentFlow) {
                const currentFlow = flows.find(f => f.id === session.currentFlow?.id);
                if (currentFlow) {
                    selectedFlow = currentFlow;
                    const resetStep = typeof directive.reset === 'object' && directive.reset.step
                        ? directive.reset.step
                        : undefined;
                    if (resetStep) {
                        const targetStep = currentFlow.getStep(resetStep);
                        if (targetStep) {
                            session = enterStep(session, targetStep.id, targetStep.description);
                            selectedStep = targetStep;
                        }
                    } else {
                        const initialStep = currentFlow.initialStep;
                        session = enterStep(session, initialStep.id, initialStep.description);
                        selectedStep = initialStep;
                    }
                }
            }
        }

        return {
            selectedFlow,
            selectedStep,
            session,
            isFlowComplete,
            signalFirings: signalResult.firings,
            signalPreDirective: signalResult.mergedDirective || undefined,
        };
    }
}
