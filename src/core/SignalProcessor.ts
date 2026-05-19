/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * SignalProcessor — Orchestration for signal phase execution.
 *
 * Owns:
 * - `behaviorAllowsExecution`: Behavior gating (Algorithm 2)
 * - `recordTrigger`: Immutable session update for trigger state
 * - `buildSignalContext`: Constructs the handler context (D-Q12 writers)
 * - `runPhase` / `runPreSignalPhase` / `runPostSignalPhase`: Phase orchestration (Algorithm 1)
 *
 * @module SignalProcessor
 */

import type { AiProvider } from "../types/ai";
import type { Event } from "../types/history";
import { MessageRole as MessageRoleEnum } from "../types/history";
import type { SessionState } from "../types/session";
import type { Directive } from "../types/flow";
import type {
    Signal,
    SignalContext,
    SignalDirective,
    SignalFiring,
    SignalPredicateContext,
    SignalTriggerState,
} from "../types/signals";
import type { SignalEvaluator } from "./SignalEvaluator";
import { logger } from "../utils";

// ──────────────────────────────────────────────────────────────────────────────
// behaviorAllowsExecution — Algorithm 2
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Determines whether a signal's behavior gating allows execution this turn.
 *
 * Algorithm 2 from the design document:
 * - `'always'` (or unset) → always allowed
 * - `'once'` → allowed only if no prior trigger exists
 * - `'cooldown'` → allowed when elapsed time since last trigger >= cooldownMs;
 *   when `cooldownMs` is missing, treated as `'always'` (misconfigured)
 * - Missing trigger (first-time) → allowed regardless of behavior
 *
 * Pure function; no I/O.
 *
 * @param signal - The signal definition (with id, behavior, cooldownMs)
 * @param trigger - The existing trigger state from `session.signals.triggers[signal.id]`, or undefined
 * @returns true if the signal is allowed to execute
 *
 * @requirements 5.1, 5.2, 5.3, 5.4
 */
export function behaviorAllowsExecution<TContext = unknown, TData = unknown>(
    signal: Signal<TContext, TData, any>,
    trigger: SignalTriggerState | undefined,
): boolean {
    // No prior trigger → always allowed (first-time execution)
    if (trigger == null) return true;

    const behavior = signal.behavior ?? 'always';

    if (behavior === 'always') return true;
    if (behavior === 'once') return false;

    if (behavior === 'cooldown') {
        // Misconfigured: cooldown without cooldownMs → treat as 'always'
        if (signal.cooldownMs == null) return true;

        const lastTriggeredTime = trigger.lastTriggeredAt instanceof Date
            ? trigger.lastTriggeredAt.getTime()
            : new Date(trigger.lastTriggeredAt).getTime();

        const elapsedMs = Date.now() - lastTriggeredTime;
        return elapsedMs >= signal.cooldownMs;
    }

    // Unknown behavior value → allow (defensive)
    return true;
}

// ──────────────────────────────────────────────────────────────────────────────
// recordTrigger — Immutable session update
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Records a signal trigger on the session, returning a new session object
 * (immutable update — never mutates input).
 *
 * - On first trigger: sets `firstTriggeredAt` and `lastTriggeredAt` to now,
 *   `count = 1`, plus `lastReason` and `lastPhase`.
 * - On subsequent triggers: leaves `firstTriggeredAt` unchanged, increments
 *   `count`, updates `lastTriggeredAt`, `lastReason`, `lastPhase`.
 *
 * @param session - Current session state (not mutated)
 * @param signal - The signal that fired
 * @param reason - The match reason (AI rationale, 'code-only', or 'unconditional')
 * @param phase - The phase in which the signal fired
 * @returns A new session with updated `signals.triggers[signal.id]`
 *
 * @requirements 10.1, 10.2
 */
export function recordTrigger<TData = unknown>(
    session: SessionState<TData>,
    signal: Signal<any, TData, any>,
    reason: string,
    phase: 'pre' | 'post',
): SessionState<TData> {
    const signalId = signal.id ?? 'unknown';
    const now = new Date();

    const existingTriggers = session.signals?.triggers ?? {};
    const existingTrigger = existingTriggers[signalId];

    let updatedTrigger: SignalTriggerState;

    if (existingTrigger == null) {
        // First trigger
        updatedTrigger = {
            firstTriggeredAt: now,
            lastTriggeredAt: now,
            count: 1,
            lastReason: reason,
            lastPhase: phase,
        };
    } else {
        // Subsequent trigger — preserve firstTriggeredAt, increment count
        updatedTrigger = {
            firstTriggeredAt: existingTrigger.firstTriggeredAt,
            lastTriggeredAt: now,
            count: existingTrigger.count + 1,
            lastReason: reason,
            lastPhase: phase,
        };
    }

    return {
        ...session,
        signals: {
            ...session.signals,
            triggers: {
                ...existingTriggers,
                [signalId]: updatedTrigger,
            },
        },
    };
}

// ──────────────────────────────────────────────────────────────────────────────
// buildSignalContext — Constructs the handler context
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Parameters for building the SignalContext.
 */
export interface BuildSignalContextParams<TContext = unknown, TData = unknown, TExtract = void> {
    signal: Signal<TContext, TData, TExtract>;
    reason: string;
    extracted: TExtract extends void ? undefined : TExtract;
    phase: 'pre' | 'post';
    session: SessionState<TData>;
    context: TContext;
    history: Event[];
    /** Turn-local directive bus — `dispatch` pushes onto this array. */
    directiveBus: SignalDirective<TContext, TData>[];
    /** Session updater — called when handler invokes `updateContext`. */
    onUpdateSession: (updatedSession: SessionState<TData>) => void;
}

/**
 * Builds the `SignalContext` passed to signal handlers.
 *
 * - `updateContext` and `updateData` replicate the ToolContext D-Q12 writer
 *   pattern: shallow-merge partial updates into the session, call the
 *   `onUpdateSession` callback so the processor can track mutations.
 * - `dispatch` pushes a `SignalDirective` onto the turn-local bus.
 * - `lastUserMessage` is derived from the last user-role event in history.
 * - `triggeredAt` is set to `new Date()` at construction time.
 * - `matched` is always `true` (literal type).
 *
 * @requirements 6.1, 6.2, 6.3
 */
export function buildSignalContext<TContext = unknown, TData = unknown, TExtract = void>(
    params: BuildSignalContextParams<TContext, TData, TExtract>,
): SignalContext<TContext, TData, TExtract> {
    const {
        signal,
        reason,
        extracted,
        phase,
        session,
        context,
        history,
        directiveBus,
        onUpdateSession,
    } = params;

    // Derive lastUserMessage from the last user-role event
    const lastUserMessage = deriveLastUserMessage(history);

    // D-Q12 contract writers — same signature as ToolContext
    const updateContext = (updates: Partial<TContext>): Promise<void> => {
        // Context is agent-level (not on session directly). Push a contextUpdate
        // directive so the pipeline applies the merge after handler returns.
        directiveBus.push({ contextUpdate: updates } as SignalDirective<TContext, TData>);
        return Promise.resolve();
    };

    const updateData = (updates: Partial<TData>): Promise<void> => {
        const updatedData = { ...session.data, ...updates };
        const updatedSession: SessionState<TData> = {
            ...session,
            data: updatedData,
        };
        onUpdateSession(updatedSession);
        // Also push a dataUpdate directive for the pipeline
        directiveBus.push({ dataUpdate: updates } as SignalDirective<TContext, TData>);
        return Promise.resolve();
    };

    const dispatch = (directive: SignalDirective<TContext, TData>): void => {
        directiveBus.push(directive);
    };

    return {
        signal,
        phase,
        matched: true,
        reason,
        extracted,
        session,
        context,
        data: session.data,
        history,
        lastUserMessage,
        triggeredAt: new Date(),
        updateContext,
        updateData,
        dispatch,
    } as SignalContext<TContext, TData, TExtract>;
}

// ──────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Extracts the last user message from history events.
 * Walks backward to find the most recent user-role message event.
 */
function deriveLastUserMessage(history: Event[]): string | undefined {
    for (let i = history.length - 1; i >= 0; i--) {
        const event = history[i];
        // eslint-disable-next-line @typescript-eslint/no-unsafe-enum-comparison
        if (event.source === MessageRoleEnum.USER && event.kind === 'message') {
            const data = event.data as { message?: string; participant?: { display_name?: string } };
            if (data?.message) {
                return data.message;
            }
        }
    }
    return undefined;
}

// ──────────────────────────────────────────────────────────────────────────────
// SignalProcessor — Full Algorithm 1 implementation
// ──────────────────────────────────────────────────────────────────────────────

/** Internal matched-signal entry carried through the pipeline. */
interface MatchedEntry<TContext, TData> {
    signal: Signal<TContext, TData, any>;
    reason: string;
    extracted?: unknown;
    /** Original index in the signals array (declaration order). */
    declarationIndex: number;
}

/**
 * SignalProcessor — Orchestrates signal phase execution.
 *
 * Constructed only when `options.signals` is non-empty (Requirement 2.3).
 * Owns the full Algorithm 1 lifecycle: filtering, gating, evaluation,
 * handler invocation, directive collection, and state persistence.
 */
export class SignalProcessor<TContext = unknown, TData = unknown> {
    constructor(
        private readonly signals: Signal<TContext, TData, any>[],
        private readonly provider: AiProvider,
        private readonly evaluator: SignalEvaluator<TContext, TData>,
        private readonly options: { batchSize: number },
    ) { }

    /** @internal Expose internals for testability. */
    get _internals() {
        return { signals: this.signals, provider: this.provider, evaluator: this.evaluator, options: this.options };
    }

    /**
     * Pre-signal phase. Delegates to `runPhase('pre', ...)`.
     * Return type narrows `mergedDirective` to `Directive | undefined`.
     */
    async runPreSignalPhase(params: {
        session: SessionState<TData>;
        history: Event[];
        context: TContext;
    }): Promise<{
        mergedDirective?: Directive<TContext, TData>;
        firings: SignalFiring<TContext, TData>[];
        updatedSession: SessionState<TData>;
    }> {
        return await this.runPhase('pre', params);
    }

    /**
     * Post-signal phase. Delegates to `runPhase('post', ...)`.
     * Return type narrows `mergedDirective` to `Directive | undefined`.
     * Pre-LLM-only fields (`appendPrompt`, `injectTools`, `halt`) are
     * already dropped inside `runPhase` for the post phase.
     */
    async runPostSignalPhase(params: {
        session: SessionState<TData>;
        history: Event[];
        context: TContext;
    }): Promise<{
        mergedDirective?: Directive<TContext, TData>;
        firings: SignalFiring<TContext, TData>[];
        updatedSession: SessionState<TData>;
    }> {
        return await this.runPhase('post', params);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Private: Algorithm 1 — Phase orchestration
    // ──────────────────────────────────────────────────────────────────────────

    private async runPhase(
        phase: 'pre' | 'post',
        params: { session: SessionState<TData>; history: Event[]; context: TContext },
    ): Promise<{
        mergedDirective?: Directive<TContext, TData>;
        firings: SignalFiring<TContext, TData>[];
        updatedSession: SessionState<TData>;
    }> {
        const { session, history, context } = params;

        // ── STEP 0: zero-cost fast path ──────────────────────────────────────
        if (this.signals.length === 0) {
            return { firings: [], updatedSession: session };
        }

        // ── STEP 1: filter eligible signals for this phase ───────────────────
        const eligible = this.signals.filter(
            (s) => s.enabled !== false && (s.phase === phase || s.phase === 'both'),
        );
        if (eligible.length === 0) {
            return { firings: [], updatedSession: session };
        }

        logger.debug(`[Signals] Phase "${phase}" eligible signals: [${eligible.map(s => s.id ?? 'unknown').join(', ')}]`);

        // ── STEP 2: filter by behavior gating ────────────────────────────────
        const gated = eligible.filter((s) =>
            behaviorAllowsExecution(s, session.signals?.triggers?.[s.id ?? 'unknown']),
        );
        if (gated.length === 0) {
            return { firings: [], updatedSession: session };
        }

        logger.debug(`[Signals] Phase "${phase}" after behavior gating: [${gated.map(s => s.id ?? 'unknown').join(', ')}]`);

        // ── STEP 3: partition by evaluation mode ─────────────────────────────
        const unconditional: Signal<TContext, TData, any>[] = [];
        const codeOnly: Signal<TContext, TData, any>[] = [];
        const llmConditioned: Signal<TContext, TData, any>[] = [];

        for (const s of gated) {
            if (s.when != null) {
                llmConditioned.push(s);
            } else if (s.if != null) {
                codeOnly.push(s);
            } else {
                unconditional.push(s);
            }
        }

        // Build predicate context (shared across code-only and if-gating)
        const predicateCtx: SignalPredicateContext<TContext, TData> = {
            data: session.data,
            context,
            session,
            history,
        };

        // ── STEP 4: unconditional signals — always match ─────────────────────
        const matched: MatchedEntry<TContext, TData>[] = [];

        for (const s of unconditional) {
            matched.push({
                signal: s,
                reason: 'unconditional',
                declarationIndex: this.signals.indexOf(s),
            });
        }

        // ── STEP 5: code-only signals → evaluateIf ──────────────────────────
        for (const s of codeOnly) {
            const passes = await this.evaluator.evaluateIf(s.if!, predicateCtx);
            if (passes) {
                matched.push({
                    signal: s,
                    reason: 'code-only',
                    declarationIndex: this.signals.indexOf(s),
                });
            }
        }

        // ── STEP 6: LLM-conditioned signals ─────────────────────────────────
        if (llmConditioned.length > 0) {
            // Gate by `if` first to skip token cost
            const ifGated: Signal<TContext, TData, any>[] = [];
            for (const s of llmConditioned) {
                if (s.if == null) {
                    ifGated.push(s);
                } else {
                    const passes = await this.evaluator.evaluateIf(s.if, predicateCtx);
                    if (passes) {
                        ifGated.push(s);
                    }
                }
            }

            if (ifGated.length > 0) {
                const classifierStart = performance.now();
                const classifierResults = await this.evaluator.evaluateSignalsBatched({
                    signals: ifGated,
                    batchSize: this.options.batchSize,
                    session,
                    history,
                    context,
                });
                const classifierDurationMs = performance.now() - classifierStart;
                logger.debug(`[Signals] Phase "${phase}" classifier call duration: ${classifierDurationMs.toFixed(1)}ms for ${ifGated.length} LLM-conditioned signals`);

                for (const s of ifGated) {
                    const id = s.id ?? 'unknown';
                    const result = classifierResults[id];
                    if (result?.matched) {
                        matched.push({
                            signal: s,
                            reason: result.reason ?? 'matched',
                            extracted: result.extracted,
                            declarationIndex: this.signals.indexOf(s),
                        });
                    }
                }
            }
        }

        // ── STEP 6b: unconditional + extract signals ────────────────────────
        const unconditionalWithExtract = unconditional.filter((s) => s.extract != null);
        if (unconditionalWithExtract.length > 0) {
            const extractResults = await this.evaluator.evaluateSignals({
                signals: unconditionalWithExtract,
                session,
                history,
                context,
            });

            // Attach extracted data to already-matched unconditional entries
            for (const s of unconditionalWithExtract) {
                const id = s.id ?? 'unknown';
                const entry = matched.find((m) => m.signal === s);
                if (entry) {
                    entry.extracted = extractResults[id]?.extracted;
                }
            }
        }

        // ── STEP 7: sort by priority desc, declaration order tiebreaker ──────
        matched.sort((a, b) => {
            const priorityDiff = (b.signal.priority ?? 0) - (a.signal.priority ?? 0);
            if (priorityDiff !== 0) return priorityDiff;
            return a.declarationIndex - b.declarationIndex;
        });

        // ── STEP 8: invoke handlers; collect directives; track state ─────────
        const bus: SignalDirective<TContext, TData>[] = [];
        const firings: SignalFiring<TContext, TData>[] = [];
        let updatedSession = session;

        for (const m of matched) {
            // Turn-local directive bus for this handler (captures dispatch calls)
            const handlerBus: SignalDirective<TContext, TData>[] = [];


            const sigCtx = buildSignalContext<TContext, TData, any>({
                signal: m.signal,
                reason: m.reason,
                extracted: m.extracted,
                phase,
                session: updatedSession,
                context,
                history,
                directiveBus: handlerBus,
                onUpdateSession: (s) => { updatedSession = s; },
            });

            const start = performance.now();

            try {

                const handlerResult = await m.signal.handler(sigCtx);

                // Collect directives from dispatch calls
                for (const d of handlerBus) {
                    bus.push(d);
                }

                let resolvedDirective: SignalDirective<TContext, TData> | undefined;

                if (handlerResult != null && typeof handlerResult === 'object') {
                    resolvedDirective = { ...handlerResult } as SignalDirective<TContext, TData>;

                    // Resolve replyWith → reply
                    if (resolvedDirective.replyWith != null) {
                        if (typeof resolvedDirective.replyWith === 'function') {
                            // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
                            resolvedDirective.reply = resolvedDirective.replyWith(sigCtx);
                        } else {
                            resolvedDirective.reply = resolvedDirective.replyWith;
                        }
                        delete resolvedDirective.replyWith;
                    }

                    bus.push(resolvedDirective);
                }

                // Update session via recordTrigger
                updatedSession = recordTrigger(updatedSession, m.signal, m.reason, phase);

                const handlerDurationMs = performance.now() - start;

                // Debug: per-handler duration and emitted directive fields
                const directiveFields = resolvedDirective
                    ? Object.keys(resolvedDirective).filter(k => resolvedDirective[k as keyof typeof resolvedDirective] !== undefined)
                    : [];
                logger.debug(
                    `[Signals] Phase "${phase}" handler "${m.signal.id ?? 'unknown'}" completed in ${handlerDurationMs.toFixed(1)}ms` +
                    (directiveFields.length > 0 ? `, directive fields: [${directiveFields.join(', ')}]` : ', no directive'),
                );

                // Record firing
                firings.push({
                    id: m.signal.id ?? 'unknown',
                    phase,
                    reason: m.reason,
                    extracted: m.extracted,
                    directive: resolvedDirective,
                    durationMs: handlerDurationMs,
                });

                // stopOtherSignals → break iteration
                if (resolvedDirective?.stopOtherSignals === true) {
                    break;
                }
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                const handlerDurationMs = performance.now() - start;

                // Handler errors logged at ERROR regardless of debug flag (Requirement 13.2)
                logger.error(`[Signals] Handler threw for signal "${m.signal.id ?? 'unknown'}": ${errorMessage}`);

                // Still record trigger even on error (the signal matched)
                updatedSession = recordTrigger(updatedSession, m.signal, m.reason, phase);

                firings.push({
                    id: m.signal.id ?? 'unknown',
                    phase,
                    reason: m.reason,
                    handlerError: errorMessage,
                    durationMs: handlerDurationMs,
                });

                // Continue iteration — handler errors never break the turn
            }
        }

        // ── STEP 9: merge directives ─────────────────────────────────────────
        let mergedDirective: Directive<TContext, TData> | undefined;

        if (bus.length > 0) {
            mergedDirective = this.mergeDirectives(bus);

            // For post-phase, drop pre-LLM-only fields with debug warning
            if (phase === 'post') {
                if (mergedDirective.appendPrompt != null) {
                    logger.debug('[Signals] Dropping appendPrompt from post-phase signal directive (pre-LLM-only field)');
                    delete mergedDirective.appendPrompt;
                }
                if (mergedDirective.injectTools != null) {
                    logger.debug('[Signals] Dropping injectTools from post-phase signal directive (pre-LLM-only field)');
                    delete mergedDirective.injectTools;
                }
                if (mergedDirective.halt != null) {
                    logger.debug('[Signals] Dropping halt from post-phase signal directive (pre-LLM-only field)');
                    delete mergedDirective.halt;
                }
            }

            // Check if merged directive is now empty after stripping
            const hasFields = Object.keys(mergedDirective).length > 0;
            if (!hasFields) {
                mergedDirective = undefined;
            }
        }

        return { mergedDirective, firings, updatedSession };
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Directive merging — Algorithm 4 pattern
    // ──────────────────────────────────────────────────────────────────────────

    /**
     * Merges an array of signal directives into a single directive.
     *
     * Merge strategy (matches Algorithm 4 / AutoChainExecutor pattern):
     * - Position fields (`goTo`, `goToStep`, `complete`, `abort`, `reset`, `halt`): last-write-wins
     * - `reply`: last-write-wins
     * - `appendPrompt`: array-concat
     * - `injectTools`: array-concat
     * - `dataUpdate`: shallow-merge (later values overwrite earlier for same key)
     * - `contextUpdate`: shallow-merge
     * - `stopOtherSignals`: OR (any true → true)
     */
    private mergeDirectives(
        directives: SignalDirective<TContext, TData>[],
    ): Directive<TContext, TData> {
        const merged: Directive<TContext, TData> = {};

        for (const d of directives) {
            // Position fields — last-write-wins
            if (d.goTo !== undefined) {
                merged.goTo = d.goTo;
                // Clear other position fields
                delete merged.goToStep;
                delete merged.complete;
                delete merged.abort;
                delete merged.reset;
            }
            if (d.goToStep !== undefined) {
                merged.goToStep = d.goToStep;
                delete merged.goTo;
                delete merged.complete;
                delete merged.abort;
                delete merged.reset;
            }
            if (d.complete !== undefined) {
                merged.complete = d.complete;
                delete merged.goTo;
                delete merged.goToStep;
                delete merged.abort;
                delete merged.reset;
            }
            if (d.abort !== undefined) {
                merged.abort = d.abort;
                delete merged.goTo;
                delete merged.goToStep;
                delete merged.complete;
                delete merged.reset;
            }
            if (d.reset !== undefined) {
                merged.reset = d.reset;
                delete merged.goTo;
                delete merged.goToStep;
                delete merged.complete;
                delete merged.abort;
            }

            // halt — last-write-wins
            if (d.halt !== undefined) {
                merged.halt = d.halt;
            }

            // reply — last-write-wins
            if (d.reply !== undefined) {
                merged.reply = d.reply;
            }

            // appendPrompt — array-concat
            if (d.appendPrompt != null) {
                merged.appendPrompt = [
                    ...(merged.appendPrompt ?? []),
                    ...d.appendPrompt,
                ];
            }

            // injectTools — array-concat
            if (d.injectTools != null) {
                merged.injectTools = [
                    ...(merged.injectTools ?? []),
                    ...d.injectTools,
                ];
            }

            // dataUpdate — shallow-merge
            if (d.dataUpdate != null) {
                merged.dataUpdate = {
                    ...(merged.dataUpdate ?? {}),
                    ...d.dataUpdate,
                };
            }

            // contextUpdate — shallow-merge
            if (d.contextUpdate != null) {
                merged.contextUpdate = {
                    ...(merged.contextUpdate ?? {}),
                    ...d.contextUpdate,
                };
            }
        }

        return merged;
    }
}
