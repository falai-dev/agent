/**
 * Signals types for v2.x.
 *
 * This is the canonical location for all signals-related types.
 * `SignalsState` and `SignalTriggerState` originated in `session.ts` as v2.0
 * forward-compat reservations and are re-exported from there for backward
 * compatibility within the same major.
 */

import type { SessionState } from "./session";
import type { Directive } from "./flow";
import type { Event } from "./history";

// ──────────────────────────────────────────────────────────────────────────────
// Persistence types (shape locked in v2.0 — DO NOT modify)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Per-signal trigger tracking state.
 * Shape is locked to enable forward-compatible persistence in v2.0.
 */
export interface SignalTriggerState {
    /** When this signal first completed its handler successfully. */
    firstTriggeredAt: Date;
    /** When this signal last completed its handler successfully. */
    lastTriggeredAt: Date;
    /** Total number of successful handler completions for this signal. */
    count: number;
    /** Free-text reason from the last successful trigger (if supplied). */
    lastReason?: string;
    /** Which phase the signal last completed in. */
    lastPhase?: 'pre' | 'post';
}

/**
 * Aggregated signals state stored on the session.
 * Shape is locked to enable forward-compatible persistence in v2.0.
 */
export interface SignalsState {
    /** Per-signal trigger tracking; keyed by signal id. */
    triggers: Record<string, SignalTriggerState>;
}

// ──────────────────────────────────────────────────────────────────────────────
// Schema types
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Schema for extraction signals. JSON Schema subset or Zod-compatible shape.
 * The framework uses this to build the per-signal `extracted` field in the
 * classifier response schema.
 *
 * When set on a signal, the signal operates in extraction mode: the classifier
 * call includes this schema in the response format, and the handler receives
 * `extracted: TExtract` when the signal matches.
 *
 * The type parameter `_T` is a phantom type that carries the extraction shape
 * for downstream inference — the runtime value is always a JSON Schema object.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export type SignalSchema<_T = unknown> = Record<string, unknown>;

// ──────────────────────────────────────────────────────────────────────────────
// Predicate types
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Context passed to signal `if` predicates.
 * Symmetric with `BranchPredicateContext` used by branches.
 */
export interface SignalPredicateContext<TContext = unknown, TData = unknown> {
    /** Collected data (partial — null-check fields not guaranteed). */
    data: Partial<TData>;
    /** Agent-level context. */
    context: TContext;
    /** Full session state. */
    session: SessionState<TData>;
    /** Conversation history as events. */
    history: Event[];
}

/**
 * Code-evaluated predicate for signal `if` conditions.
 * Returns `true` to pass (signal proceeds to `when` evaluation or fires),
 * `false` to skip (signal is not evaluated this turn).
 *
 * Predicates evaluate BEFORE `when` conditions — code-first short-circuit.
 * If `if` returns false, `when` is NOT evaluated (token-saving).
 *
 * If a predicate throws, the signal is treated as non-match and other
 * signals continue evaluation.
 */
export type SignalPredicate<TContext = unknown, TData = unknown> = (
    ctx: SignalPredicateContext<TContext, TData>,
) => boolean | Promise<boolean>;

// ──────────────────────────────────────────────────────────────────────────────
// Signal directive
// ──────────────────────────────────────────────────────────────────────────────

/**
 * SignalDirective — what signal handlers return.
 * Extends `Directive`. Adds signal-specific fields: `stopOtherSignals` and `replyWith`.
 *
 * All position-control (`goTo`, `goToStep`, `complete`, `abort`, `reset`),
 * state writes (`dataUpdate`, `contextUpdate`), prompt augmentation
 * (`appendPrompt`, `injectTools`), `reply`, and `halt` are inherited unchanged.
 *
 * Post-phase drop rules: when returned in the post-phase, `appendPrompt`,
 * `injectTools`, and `halt` are dropped with a WARN log — they have
 * no meaning after the LLM call has already completed.
 */
export interface SignalDirective<TContext = unknown, TData = unknown>
    extends Directive<TContext, TData> {
    /**
     * Stop processing remaining signals for this phase after this handler.
     * Does not affect the other phase.
     */
    stopOtherSignals?: boolean;

    /**
     * Verbatim reply with optional late-binding (function form).
     * - String: same as `Directive.reply`.
     * - Function: evaluated at emit time; result projects onto `Directive.reply`.
     *
     * The field is resolved and stripped before reaching the directive merge bus.
     */
    replyWith?: string | ((ctx: SignalContext<TContext, TData>) => string);
}

/**
 * A signal directive as reported on the response surface (SignalFiring).
 * `replyWith` has been resolved onto `reply` and stripped by the processor,
 * leaving a directive that is covariant in TContext — which lets firings
 * flow into AgentResponse without casts.
 */
export type ResolvedSignalDirective<TContext = unknown, TData = unknown> =
    Directive<TContext, TData> & {
        /** Stop processing remaining signals for this phase after this handler. */
        stopOtherSignals?: boolean;
    };

// ──────────────────────────────────────────────────────────────────────────────
// Signal context (handler argument)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Context passed to signal handlers when a signal fires.
 * Symmetric with `ToolContext` — provides session state and writer methods.
 *
 * The `updateContext` and `updateData` writers follow the same D-Q12 contract
 * as `ToolContext` writers.
 */
export interface SignalContext<
    TContext = unknown,
    TData = unknown,
    TExtract = void,
> {
    /** The signal definition that fired. */
    signal: Signal<TContext, TData, TExtract>;

    /** Phase in which this signal fired. */
    phase: 'pre' | 'post';

    /** Whether the signal matched (always `true` when handler runs). */
    matched: true;

    /** AI rationale when `when` matched, or `'code-only'` / `'unconditional'`. */
    reason: string;

    /**
     * Extracted data when the signal has `extract` set. Typed via the
     * TExtract generic. Undefined for detection-only signals.
     */
    extracted: TExtract extends void ? undefined : TExtract;

    /** Session state. Use writers below for mutations. */
    session: SessionState<TData>;
    /** Agent-level context. */
    context: TContext;
    /** Collected data (partial). */
    data: Partial<TData>;
    /** Conversation history as events. */
    history: Event[];

    /** Last user message (convenience). */
    lastUserMessage?: string;

    /** Timestamp when the signal fired. */
    triggeredAt: Date;

    /** Update agent context (same signature as ToolContext.updateContext). */
    updateContext: (updates: Partial<TContext>) => Promise<void>;
    /** Update collected data (same signature as ToolContext.updateData). */
    updateData: (updates: Partial<TData>) => Promise<void>;

    /** Imperative directive emission onto the per-turn bus. */
    dispatch(directive: SignalDirective<TContext, TData>): void;
}

// ──────────────────────────────────────────────────────────────────────────────
// Signal definition
// ──────────────────────────────────────────────────────────────────────────────

/**
 * A signal: a typed event detector (and optional data extractor) that runs
 * around an LLM turn.
 *
 * Conditions use the v2 `when` / `if` split:
 * - `when`: AI-evaluated string(s). Entries prefixed with `!` are exclusion
 *   conditions rendered under "DO NOT TRIGGER WHEN" in the classifier prompt.
 *   Non-prefixed entries render under "TRIGGER WHEN". Positive entries use OR
 *   semantics (any match can trigger). Negative entries also use OR semantics
 *   for exclusion (any match inhibits firing).
 * - `if`: Code-evaluated function(s). Free. AND semantics.
 *
 * When both `if` and `when` are set, `if` evaluates first. If `if` returns
 * false, `when` is not evaluated (token-saving).
 *
 * Signals with neither `when` nor `if` are unconditional — they always fire
 * (subject to behavior gating). If `extract` is set on an unconditional signal,
 * the extraction runs every turn.
 */
export interface Signal<
    TContext = unknown,
    TData = unknown,
    TExtract = void,
> {
    /** Unique identifier. Auto-generated if omitted (stable within session). */
    id?: string;

    /** Display title (shown in logs and traces). */
    title?: string;

    /** Free-text description of what this signal detects. */
    description?: string;

    /**
     * AI-evaluated trigger condition(s). String or array of strings.
     * - Non-prefixed entries: OR semantics. Any match can trigger.
     * - `!`-prefixed entries: OR exclusion. Any match inhibits firing.
     *
     * At prompt-render time, the framework splits entries by prefix:
     * - Non-`!` → rendered under "TRIGGER WHEN"
     * - `!` → stripped of prefix, rendered under "DO NOT TRIGGER WHEN"
     */
    when?: string | string[];

    /**
     * Code predicate(s). Function or array of functions (AND).
     * Free to evaluate; runs before `when`. If `if` returns false, the
     * signal is skipped — `when` is not evaluated.
     */
    if?: SignalPredicate<TContext, TData> | SignalPredicate<TContext, TData>[];

    /**
     * Optional structured extraction schema. When set, the signal operates
     * in extraction mode: the classifier call includes this schema in the
     * response format, and the handler receives `extracted: TExtract` when
     * the signal matches.
     *
     * Extraction signals participate in the same batched classifier call as
     * detection signals. The merged response schema includes each signal's
     * extraction fields alongside the standard `matched` / `reason`.
     *
     * When absent, the signal operates in detection mode (boolean match).
     */
    extract?: SignalSchema<TExtract>;

    /**
     * When this signal evaluates relative to the LLM call.
     * - `'pre'`: before the LLM call (parallel with routing).
     * - `'post'`: after the LLM call (sequential, after finalize).
     * - `'both'`: evaluated in both phases.
     */
    phase: 'pre' | 'post' | 'both';

    /**
     * Handler invoked when the signal fires. Receives match info and
     * extracted data (if applicable). Returns void or a SignalDirective.
     */
    handler: (ctx: SignalContext<TContext, TData, TExtract>)
        => void
        | SignalDirective<TContext, TData>
        | Promise<void | SignalDirective<TContext, TData>>;

    /**
     * Rate-limit / dedup behavior:
     * - `'once'`: fire once per session.
     * - `'always'`: fire every match (default).
     * - `'cooldown'`: fire, then suppress for `cooldownMs`.
     */
    behavior?: 'once' | 'always' | 'cooldown';

    /** Cooldown duration in ms. Required when `behavior === 'cooldown'`. */
    cooldownMs?: number;

    /** Whether this signal is currently enabled. @default true */
    enabled?: boolean;

    /**
     * Higher priority signals fire first within a phase. Default 0.
     * Tie: declaration order in `agent.signals`.
     */
    priority?: number;
}

// ──────────────────────────────────────────────────────────────────────────────
// Observability types
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Observability record for a signal that fired during a turn.
 * Populated in fire order across both pre- and post-phases.
 * Mirrors the observability framing of `executedSteps` and `appliedGuidelines`.
 */
export interface SignalFiring<TContext = unknown, TData = unknown> {
    /** The signal's unique identifier. */
    id: string;
    /** Which phase the signal fired in. */
    phase: 'pre' | 'post';
    /** AI rationale when `when` matched, or 'code-only' / 'unconditional'. */
    reason?: string;
    /** Extracted data when the signal operates in extraction mode. */
    extracted?: unknown;
    /** The directive returned by the signal handler (if any), with `replyWith` already resolved to `reply`. */
    directive?: ResolvedSignalDirective<TContext, TData>;
    /** Error message if the handler threw. */
    handlerError?: string;
    /**
     * Set when the signal matched in extraction mode (`extract` defined) but the
     * classifier returned no extracted payload — the handler ran with
     * `extracted: undefined`. Independent of `handlerError`.
     */
    extractionError?: string;
    /** Wall-clock duration of the handler invocation in milliseconds. */
    durationMs?: number;
}
