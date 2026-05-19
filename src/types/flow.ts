/**
 * Flow/Journey DSL type definitions
 */

import type { Tool } from "./tool";
import type { StructuredSchema } from "./schema";
import type { Instruction, HookContext, ExitReason } from "./agent";
import type { Template } from "./template";

// ─── Condition types (v2 when/if split) ──────────────────────────────────────

/**
 * Code-evaluated condition predicate. Returns `true` to pass, `false` to fail.
 * May be async. Used on `if` fields (free to evaluate, no LLM cost).
 */
export type ConditionPredicate<TContext = unknown, TData = unknown> = (
  ctx: { data: Partial<TData>; context: TContext; session: import("./session").SessionState<TData>; history: Event[] }
) => boolean | Promise<boolean>;

/**
 * The `if` field shape: a single predicate or an array of predicates (AND semantics).
 */
export type ConditionIf<TContext = unknown, TData = unknown> =
  | ConditionPredicate<TContext, TData>
  | ConditionPredicate<TContext, TData>[];

/**
 * The `when` field shape: a single AI-evaluated string or array of strings (AND semantics).
 * Functions are NOT allowed on `when` — they belong on `if` only.
 */
export type ConditionWhen = string | string[];
import type { SessionState } from "./session";
import type { Event } from "./history";

/**
 * Reason why execution stopped.
 * Used to indicate the stopping condition for step execution.
 *
 * v2 vocabulary — see Requirements 17.1–17.9.
 */
export type StoppedReason =
  | 'needs_input'        // Waiting for user input
  | 'last_step'          // Flow ended because the last step had no successor
  | 'completed'          // Flow ended because an explicit `complete` directive fired
  | 'aborted'            // Conversation aborted via `abort` directive
  | 'goto'              // Turn ended because a goTo/goToStep directive redirected
  | 'reset'              // Turn ended because a `reset` directive fired
  | 'halt'              // Pre-LLM halt directive — turn ends without LLM call
  | 'reply'              // Turn ended because a verbatim reply was emitted (no LLM call)
  | 'max_auto_steps'     // Auto-step chain exceeded maxAutoStepsPerTurn cap
  | 'prepare_error'      // Error in prepare hook
  | 'llm_error'          // Error during LLM call
  | 'validation_error'   // Error validating collected data
  | 'finalize_error';    // Error in finalize hook (non-fatal, logged)

/**
 * Result that a prepare/finalize hook may return to issue directives.
 * All fields are optional — returning void is also valid.
 */
export interface PrepareResult {
  /** Partial data to merge into session.data */
  dataUpdate?: Record<string, unknown>;
  /** Partial context to merge into the agent context */
  contextUpdate?: Record<string, unknown>;
  /** If true, stop the auto-step chain and end the turn with `reply` */
  halt?: boolean;
  /** Verbatim reply to send when halting */
  reply?: string;
  /** Jump to a step within the current flow */
  goToStep?: string;
  /** Jump to another flow */
  goTo?: string;
  /** Mark the current flow as complete */
  complete?: boolean;
}



// ─── Branch types ────────────────────────────────────────────────────────────

/**
 * A programmatic transition directive. The single shape any tool, hook, branch,
 * or signal handler returns to write state, redirect the conversation, or speak
 * verbatim.
 *
 * At most one position field (`goTo`, `goToStep`, `complete`, `abort`, `reset`)
 * may be set per Directive. Non-position fields (`reply`, `contextUpdate`,
 * `dataUpdate`) may accompany any position field.
 *
 * Pre-LLM augmentation fields (`appendPrompt`, `injectTools`, `halt`) are
 * one-turn-lifetime: they only take effect in pre-LLM hooks (`onEnter`,
 * `prepare`). When emitted from post-LLM hooks (`finalize`, `onComplete`) or
 * persisted to `session.pendingDirective`, these fields are ignored and a WARN
 * log is emitted. They are never serialized across turns.
 */
export interface Directive<TContext = unknown, TData = unknown> {
  // ── Position fields (mutually exclusive: at most one) ────────────
  /** Jump to a flow (string) or a flow with options (object). */
  goTo?: string | { flow?: string; step?: string; data?: Partial<TData>; reason?: string; carry?: 'preserve' | 'reset'; };
  /** Jump to a specific step, optionally in another flow. */
  goToStep?: string | { step: string; flow?: string; data?: Partial<TData>; reason?: string; };
  /** Mark the current flow as complete. */
  complete?: true | { next?: Directive<unknown, unknown>; reason?: string; };
  /** Abort the current flow. */
  abort?: string | { reason: string; clearSession?: boolean; };
  /** Reset the current flow (or jump to a step within it). */
  reset?: true | { step?: string; clearData?: boolean; reason?: string; };

  // ── Verbatim utterance ───────────────────────────────────────────
  /** Verbatim reply text to send to the user. */
  reply?: string;

  // ── State writes ─────────────────────────────────────────────────
  /** Partial context update applied before the next turn. */
  contextUpdate?: Partial<TContext>;
  /** Partial data update applied before the next turn. */
  dataUpdate?: Partial<TData>;

  // ── Pre-LLM augmentation (one-turn lifetime) ─────────────────────
  /**
   * Sentences to append to the system prompt for THIS turn only.
   * Wired through PromptComposer's per-turn appendage slot.
   *
   * Only meaningful in pre-LLM hooks (`onEnter`, `prepare`). Ignored with
   * a WARN log when emitted from post-LLM hooks or persisted.
   */
  appendPrompt?: string[];

  /**
   * Tools available for THIS turn only. Stacked on top of agent/flow/step
   * tool scopes via ToolManager's transient layer.
   *
   * Only meaningful in pre-LLM hooks (`onEnter`, `prepare`). Ignored with
   * a WARN log when emitted from post-LLM hooks or persisted.
   */
  injectTools?: Tool[];

  /**
   * If true, skip the LLM call entirely this turn.
   *
   * Co-validates with `reply`: when both are set, `reply` becomes the
   * assistant output (`stoppedReason: 'reply'`). When `halt` is true
   * without `reply`, the turn produces an empty assistant message
   * (`stoppedReason: 'halt'`).
   *
   * Only meaningful in pre-LLM hooks (`onEnter`, `prepare`). Ignored with
   * a WARN log when emitted from post-LLM hooks or persisted.
   */
  halt?: boolean;
}



/**
 * Context passed to a `BranchPredicate` function.
 *
 * **Typing note:** `data` is `Partial<TData>` — predicates must null-check
 * any field not declared in the source step's `requires`. Fields covered by
 * `requires` are guaranteed present by the engine when the predicate runs;
 * everything else is `T | undefined`.
 */
export interface BranchPredicateContext<TContext = unknown, TData = unknown> {
  /** Collected data (partial — null-check fields not in `requires`). */
  data: Partial<TData>;
  /** Agent-level context. */
  context: TContext;
  /** Full session state. */
  session: SessionState<TData>;
  /** Conversation history as events. */
  history: Event[];
}

/**
 * A code predicate for branch evaluation. Returns `true` to pass, `false`
 * to skip the entry. May be async.
 *
 * Predicates are evaluated **before** any AI condition (`when`) on the same
 * entry — code-first evaluation saves tokens when the predicate fails.
 */
export type BranchPredicate<TContext = unknown, TData = unknown> = (
  ctx: BranchPredicateContext<TContext, TData>,
) => boolean | Promise<boolean>;

/**
 * A single entry in a `BranchMap`. Evaluated in declaration order; the first
 * entry whose conditions pass wins.
 *
 * **Resolution rules for `then`:**
 * 1. String matching a step id in the current flow → enter that step.
 * 2. String matching a flow id/title in the agent → treated as
 *    `applyDirective({ goTo: <string> })`.
 * 3. `Directive` object → applied via `applyDirective` directly.
 *
 * An entry with neither `when` nor `if` is an unconditional fallback and
 * is only legal as the **last** entry in the array.
 */
export interface BranchEntry<TContext = unknown, TData = unknown> {
  /**
   * AI-evaluated condition. String or array of strings (AND semantics).
   * Costs LLM tokens. Reuses the same machinery as `step.when`.
   * Only evaluated if `if` passes (or is absent) — code-first short-circuit.
   */
  when?: string | string[];

  /**
   * Code predicate. Function or array of functions (AND semantics).
   * Free to evaluate. When both `when` and `if` are set, `if` runs first;
   * `when` is only evaluated if all `if` predicates pass (token-saving).
   */
  if?: BranchPredicate<TContext, TData> | BranchPredicate<TContext, TData>[];

  /**
   * Where to go when this entry matches.
   * - **String:** step id in the current flow, or flow id/title for cross-flow.
   * - **Directive:** full programmatic transition (cross-flow with data,
   *   complete, abort, reset, etc.).
   */
  then: string | Directive<TContext, TData>;

  /** Optional label for event traces and flow visualization. */
  label?: string;
}

/**
 * Array of branch entries evaluated in declaration order.
 * First entry whose conditions pass wins. This is the explicit, source-local
 * fork primitive — all possible paths from a step are visible in one list.
 */
export type BranchMap<TContext = unknown, TData = unknown> = Array<BranchEntry<TContext, TData>>;

// ─── End branch types ────────────────────────────────────────────────────────

/**
 * Reference to a flow
 */
export interface FlowRef {
  /** Flow identifier */
  id: string;
}

/**
 * Reference to a step within a flow
 */
export interface StepRef {
  /** Step identifier */
  id: string;
  /** Flow this step belongs to */
  flowId: string;
}



/**
 * Flow lifecycle hooks for managing flow-specific data and behavior.
 *
 * Pre-LLM hooks (`onEnter`) return `void | Directive`.
 * Post-LLM hooks (`onComplete`) return `void | Directive`.
 * Informational hooks (`onExit`) return `void`.
 * Data hooks (`onDataUpdate`, `onContextUpdate`) retain their v1 signatures.
 */
export interface FlowLifecycleHooks<TContext = unknown, TData = unknown> {
  /**
   * Called when the flow is first entered.
   * May return a Directive to augment the prompt, inject tools, halt, or redirect.
   * Pre-LLM fields (`appendPrompt`, `injectTools`, `halt`) are honored here.
   */
  onEnter?: (
    ctx: HookContext<TContext, TData>
  ) => void | Directive<TContext, TData> | Promise<void | Directive<TContext, TData>>;

  /**
   * Called when the flow is exited. Informational only — cannot influence flow control.
   * Receives the reason the flow was exited.
   */
  onExit?: (
    ctx: HookContext<TContext, TData>,
    reason: ExitReason
  ) => void | Promise<void>;

  /**
   * Called when the flow's required fields are satisfied or when a `complete` directive fires.
   * May return a Directive to chain into another flow or perform state writes.
   */
  onComplete?: (
    ctx: HookContext<TContext, TData>
  ) => void | Directive<TContext, TData> | Promise<void | Directive<TContext, TData>>;

  /**
   * Called after collected data is updated for this flow (from AI response or tool execution)
   * Useful for validation, enrichment, or persistence of flow-specific collected data
   * Return modified collected data or the same data to keep it unchanged
   *
   * Unlike Agent-level onDataUpdate, this only triggers for data changes in this specific flow.
   */
  onDataUpdate?: (
    data: Partial<TData>,
    previousCollected: Partial<TData>
  ) => Partial<TData> | Promise<Partial<TData>>;

  /**
   * Called after context is updated via updateContext() when this flow is active
   * Useful for flow-specific context reactions, validation, or side effects
   *
   * Unlike Agent-level onContextUpdate, this only triggers when this specific flow is active.
   */
  onContextUpdate?: (
    newContext: TContext,
    previousContext: TContext
  ) => void | Promise<void>;
}



/**
 * Options for creating a flow
 * @template TData - Type of data collected throughout the flow (inferred from schema)
 */
export interface FlowOptions<TContext = unknown, TData = unknown> {
  /** Custom ID for the flow (optional - will generate deterministic ID from title if not provided) */
  id?: string;
  /** Title of the flow */
  title: string;
  /** Description of what this flow accomplishes */
  description?: string;

  /**
   * AI-evaluated activation condition(s). String or array of strings (AND semantics).
   * Costs LLM tokens. Functions are NOT allowed here — use `if` for code predicates.
   */
  when?: ConditionWhen;
  /**
   * Code-evaluated activation condition(s). Function or array of functions (AND semantics).
   * Free to evaluate. When both `when` and `if` are set, `if` runs first;
   * `when` is only evaluated when `if` passes.
   */
  if?: ConditionIf<TContext, TData>;
  /**
   * Instructions for this flow.
   */
  instructions?: Instruction<TContext, TData>[];
  /** Tools available in this flow */
  tools?: (string | Tool<TContext, TData>)[];

  /** Optional: extractions the router may return (added to routing schema) */
  routingExtrasSchema?: StructuredSchema;
  /** Optional: structured response data for this flow's message generation */
  responseOutputSchema?: StructuredSchema;
  /**
   * Required fields for flow completion - must be valid keys from agent's TData type
   * Flow is considered complete when all required fields are present in agent data
   */
  requiredFields?: (keyof TData)[];
  /**
   * Optional fields that enhance the flow but aren't required for completion
   * Must be valid keys from agent's TData type
   */
  optionalFields?: (keyof TData)[];
  /**
   * Initial data to pre-populate when entering this flow
   * Useful for restoring sessions or pre-filling known information
   * Steps with skip conditions will be automatically bypassed if data is present
   * Now refers to agent-level data
   */
  initialData?: Partial<TData>;
  /**
   * Sequential steps for simple linear flows
   * If provided, automatically chains the steps from initialStep
   * The last step in the array is the implicit terminus of the flow
   * For complex flows with branching, build the step machine manually instead
   */
  steps?: StepOptions<TContext, TData>[];

  /**
   * Optional transition when the flow completes (last step finishes).
   *
   * Accepts a flow ID or title string — sugar for
   * `hooks.onComplete = () => ({ goTo: '<id>' })`.
   *
   * For dynamic completion logic, use `hooks.onComplete` instead.
   * Setting both `onComplete` and `hooks.onComplete` on the same flow
   * throws `FlowConfigurationError` at construction time.
   *
   * @example
   * // Simple string — transitions to "Collect Feedback" on completion
   * onComplete: "Collect Feedback"
   */
  onComplete?: string;
  /**
   * If true, this flow can be re-selected by the router after it has
   * completed in the current session — useful for "do another?" patterns
   * (re-book, re-search, repeat-task).
   *
   * Default: `false`. Once a flow completes (and `onComplete` is not set
   * or returns `undefined`), the flow is excluded from routing candidates
   * for the rest of the session unless `reentrant: true`.
   *
   * On re-entry, the engine clears every field declared in this flow's
   * `requiredFields` and `optionalFields` (so the flow starts fresh from
   * its initial step). Fields not declared as owned by this flow are
   * preserved in `session.data`.
   *
   * `onComplete` always wins over `reentrant`. If `onComplete` returns a
   * target flow, the session transitions there immediately on completion;
   * `reentrant` is consulted only when `onComplete` is absent or returns
   * `undefined`.
   */
  reentrant?: boolean;
  /**
   * Flow lifecycle hooks
   */
  hooks?: FlowLifecycleHooks<TContext, TData>;
}

/**
 * Step lifecycle hooks for managing step-specific behavior.
 *
 * Pre-LLM hooks (`onEnter`, `prepare`) return `void | Directive`.
 * Post-LLM hooks (`finalize`) return `void | Directive`.
 * Informational hooks (`onExit`) return `void`.
 */
export interface StepLifecycleHooks<TContext = unknown, TData = unknown> {
  /**
   * Called on step entry. May return a Directive to augment the prompt,
   * inject tools, halt, or redirect.
   * Pre-LLM fields (`appendPrompt`, `injectTools`, `halt`) are honored here.
   */
  onEnter?: (
    ctx: HookContext<TContext, TData>
  ) => void | Directive<TContext, TData> | Promise<void | Directive<TContext, TData>>;

  /**
   * Called when the step is exited. Informational only — cannot influence flow control.
   * Receives the reason the step was exited.
   */
  onExit?: (
    ctx: HookContext<TContext, TData>,
    reason: ExitReason
  ) => void | Promise<void>;

  /**
   * Called pre-LLM. May return a Directive to augment the prompt,
   * inject tools, or halt the LLM call.
   * Pre-LLM fields (`appendPrompt`, `injectTools`, `halt`) are honored here.
   */
  prepare?: (
    ctx: HookContext<TContext, TData>
  ) => void | Directive<TContext, TData> | Promise<void | Directive<TContext, TData>>;

  /**
   * Called post-LLM. May return a Directive to redirect flow, write state,
   * or emit a verbatim reply.
   */
  finalize?: (
    ctx: HookContext<TContext, TData>
  ) => void | Directive<TContext, TData> | Promise<void | Directive<TContext, TData>>;
}

/**
 * Specification for a step transition
 */
export interface StepOptions<TContext = unknown, TData = unknown> {
  /** Custom ID for this step (optional - will generate deterministic ID if not provided) */
  id?: string;
  /** Description of the transition */
  description?: string;
  /** Transition to a chat state with this description */
  prompt?: Template<TContext, TData>;
  /** Tools available for AI to call in this step (by ID reference or inline definition) */
  tools?: (string | Tool<TContext, TData>)[];
  /** Programmatic function or tool to run before AI responds */
  prepare?:
  | string
  | Tool<TContext, TData>
  | ((context: TContext, data?: Partial<TData>) => void | PrepareResult | Promise<void | PrepareResult>);
  /** Programmatic function or tool to run after AI responds */
  finalize?:
  | string
  | Tool<TContext, TData>
  | ((context: TContext, data?: Partial<TData>) => void | PrepareResult | Promise<void | PrepareResult>);

  /**
   * Fields to collect from the conversation in this step
   * These should match keys in the agent's TData schema
   */
  collect?: (keyof TData)[];
  /**
   * Code-evaluated skip condition. If evaluates to true, the step will be bypassed.
   * Function or array of functions (OR semantics) — if any returns true, step is skipped.
   * Only code predicates are allowed here (no AI strings).
   *
   * Renamed from v1 `skipIf` to clarify the if-only shape.
   */
  skip?: ConditionIf<TContext, TData>;
  /**
   * Required data fields that must be present before entering this step
   * If any required field is missing, step cannot be entered
   * Must be valid keys from agent's TData type
   */
  requires?: (keyof TData)[];
  /**
   * AI-evaluated activation condition(s). String or array of strings (AND semantics).
   * Costs LLM tokens. Functions are NOT allowed here — use `if` for code predicates.
   */
  when?: ConditionWhen;
  /**
   * Code-evaluated activation condition(s). Function or array of functions (AND semantics).
   * Free to evaluate. When both `when` and `if` are set, `if` runs first;
   * `when` is only evaluated when `if` passes.
   */
  if?: ConditionIf<TContext, TData>;
  /**
   * Instructions for this step. Replaces v1's `guidelines`.
   */
  instructions?: Instruction<TContext, TData>[];

  /**
   * If true, this step runs without an LLM call. Pre-LLM hooks
   * (`onEnter`, `prepare`) and branch resolution still execute.
   *
   * An auto-step **cannot** define `prompt`, `collect`, `tools`, or `finalize`.
   * Defining any of these will throw `FlowConfigurationError` at construction time.
   *
   * Use auto-steps for:
   * - Data enrichment between user-facing steps (CRM lookup, pricing calc).
   * - Deterministic decision points (pair with `branches`).
   * - Programmatic short-circuits (`prepare` returning `{ halt: true, reply }`).
   *
   * @default false
   */
  auto?: boolean;

  /**
   * Verbatim assistant output for this step. When set, the template is
   * rendered via the same engine as `prompt` and emitted as the assistant
   * message without invoking the LLM.
   *
   * A reply step **cannot** define `prompt`, `collect`, `tools`, `finalize`,
   * or `auto: true`. Defining any of these will throw `FlowConfigurationError`
   * at construction time.
   *
   * `onEnter` and `prepare` hooks fire normally before the reply is rendered.
   * If `prepare` returns a Directive with its own `reply` field, the
   * hook-emitted reply wins (last-emission-wins per Algorithm 4).
   *
   * After emission, `onExit` fires and `branches` are resolved for next step.
   * `stoppedReason: 'reply'`.
   *
   * Use reply steps for: confirmations, hand-offs, farewells, acks — anything
   * that doesn't need LLM reasoning.
   */
  reply?: Template<TContext, TData>;

  /**
   * Explicit source-local fork. An array of branch entries evaluated in
   * declaration order — the first entry whose conditions pass wins; its
   * `then` resolves to the next step or a Directive.
   *
   * Coexists with `nextStep`. If `branches` is absent or no entry matches,
   * resolution falls through to linear nextStep / AI step selection.
   *
   * Runs **after** the step's post-LLM phase (tool execution, `finalize`)
   * and **before** linear successor selection.
   */
  branches?: BranchMap<TContext, TData>;

  /**
   * Step lifecycle hooks for managing step-specific behavior.
   * Provides onEnter, onExit, prepare, and finalize hooks that receive HookContext.
   */
  hooks?: StepLifecycleHooks<TContext, TData>;
}

/**
 * Specification for a branch in the conversation flow
 */
export interface BranchSpec<TContext = unknown, TData = unknown> {
  /** User-friendly identifier for this branch (used as object key) */
  name: string;
  /** Optional ID for this branch (auto-generated if not provided) */
  id?: string;
  /** Step configuration for this branch */
  step: StepOptions<TContext, TData>;
}

/**
 * Result of a branch operation
 * Maps branch names to their respective step results for continued chaining
 */
export interface BranchResult<TContext = unknown, TData = unknown> {
  [branchName: string]: StepResult<TContext, TData>;
}

/**
 * Result of a transition operation
 * Combines step reference with the ability to chain transitions and create branches
 */
export interface StepResult<TContext = unknown, TData = unknown>
  extends StepRef {
  /** Allow chaining transitions */
  nextStep: (spec: StepOptions<TContext, TData>) => StepResult<TContext, TData>;
  /** Create multiple branches from this step */
  branch: (
    branches: BranchSpec<TContext, TData>[]
  ) => BranchResult<TContext, TData>;
}
