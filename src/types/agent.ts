/**
 * Agent-related type definitions
 */

import type { AgentStructuredResponse, AiProvider } from "./ai";
import type { Tool } from "./tool";
import type { Directive, FlowOptions, StepRef, StoppedReason } from "./flow";
import type { PersistenceConfig } from "./persistence";
import type { SessionState } from "./session";
import type { Signal, SignalFiring } from "./signals";
import type { StructuredSchema } from "./schema";
import type { Event } from "./history";
import type { Template } from "./template";
import type { ConditionWhen, ConditionIf } from "./flow";
import type { PromptCacheConfig } from "./prompt-cache";

/**
 * Context passed to every lifecycle hook (flow and step).
 * Carries the current state and a `dispatch` method for emitting directives
 * onto the per-turn directive bus.
 */
export interface HookContext<TContext = unknown, TData = unknown> {
  /** Agent-level context. */
  context: TContext;
  /** Collected data (partial — fields may be undefined). */
  data: Partial<TData>;
  /** Full session state. */
  session: SessionState<TData>;
  /** Conversation history as events. */
  history: Event[];
  /**
   * Emit a directive onto the per-turn directive bus.
   * Multiple `dispatch()` calls are allowed; they merge via Algorithm 4
   * along with any directive returned from the hook itself.
   */
  dispatch(directive: Directive<TContext, TData>): void;
}

/**
 * Reason why a flow was exited, passed to `hooks.onExit`.
 */
export type ExitReason = 'completed' | 'goto_flow' | 'goto_step' | 'aborted';

/**
 * Agent-level compaction configuration.
 * Unlike CompactionOptions, this does not require a `provider` since the agent already has one.
 */
export interface AgentCompactionConfig {
  /** Maximum token budget for the conversation */
  maxTokens: number;
  /**
   * Threshold ratio (0–1) at which to trigger compaction.
   * Must be between 0.5 and 0.95.
   * @default 0.8
   */
  compactionThreshold?: number;
  /**
   * Number of recent messages to always preserve unchanged.
   * Must be >= 2.
   * @default 4
   */
  preserveRecentCount?: number;
  /**
   * Maximum characters per tool result before truncation.
   * Must be > 0.
   * @default 5000
   */
  maxToolResultChars?: number;
  /**
   * Whether compaction is enabled.
   * @default true when config is provided
   */
  enabled?: boolean;
}

/**
 * Context lifecycle hooks for managing step persistence
 */
export interface ContextLifecycleHooks<TContext = unknown, TData = unknown> {
  /**
   * Called before respond() to get fresh context
   * Useful for loading context from a database or cache
   */
  beforeRespond?: (currentContext: TContext) => Promise<TContext> | TContext;

  /**
   * Called after context is updated via updateContext() or tool execution
   * Useful for persisting context to a database or cache
   */
  onContextUpdate?: (
    newContext: TContext,
    previousContext: TContext
  ) => Promise<void> | void;

  /**
   * Called after collected data is updated (from AI response or tool execution)
   * Useful for validation, enrichment, or persistence of collected data
   * Return modified collected data or the same data to keep it unchanged
   *
   * Note: This hook now works with agent-level data collection (TData type)
   */
  onDataUpdate?: (
    data: Partial<TData>,
    previousCollected: Partial<TData>
  ) => Partial<TData> | Promise<Partial<TData>>;
}

/**
 * Context provider function for always-fresh context
 * Alternative to static context, useful for loading from external sources
 */
export type ContextProvider<TContext = unknown> = () =>
  | Promise<TContext>
  | TContext;

/**
 * Options for creating an Agent
 */
export interface AgentOptions<TContext = unknown, TData = unknown> {
  /** Display name of the agent */
  name: string;
  /** The agent's primary goal or objective */
  goal?: string;
  /**
   * Agent persona — covers role, tone, self-concept, and communication style.
   * Rendered into the system prompt as "who you are and how you communicate."
   */
  persona?: Template<TContext>;
  /** Enable debug logging */
  debug?: boolean;
  /** Default context data available to the agent */
  context?: TContext;
  /** Optional current session for convenience methods */
  session?: SessionState;
  /** Optional sessionId to load or create - managed by SessionManager */
  sessionId?: string;
  /** Context provider function for always-fresh context (alternative to static context) */
  contextProvider?: ContextProvider<TContext>;
  /** Lifecycle hooks for context management */
  hooks?: ContextLifecycleHooks<TContext, TData>;
  /** AI provider for generating responses */
  provider: AiProvider;
  /** Initial terms for domain glossary */
  terms?: Term<TContext, TData>[];
  /**
   * Instructions for agent behavior — unified primitive.
   * Each instruction has a `kind`: `'must'` (rule), `'never'` (prohibition), or `'should'` (default, nudge).
   */
  instructions?: Instruction<TContext, TData>[];
  /** Global tools available to all flows */
  tools?: Tool<TContext, TData, unknown>[];
  /** Initial flows (will be instantiated as Flow objects) */
  flows?: FlowOptions<TContext, TData>[];
  /** Optional persistence configuration for auto-saving sessions and messages */
  persistence?: PersistenceConfig<TData>;
  /** Knowledge base containing any JSON structure the AI should know */
  knowledgeBase?: Record<string, unknown>;
  /** Agent-level data schema defining the complete data structure for collection */
  schema?: StructuredSchema;
  /** Initial data to pre-populate when creating the agent */
  initialData?: Partial<TData>;
  /**
   * Margin (0-100) the best alternative flow must exceed the current flow's score
   * by before the agent switches. Higher values make the agent "stickier" to the
   * current flow. Set to 0 to switch whenever any flow scores higher.
   * @default 15
   */
  flowSwitchMargin?: number;
  /**
  /**
   * Maximum number of consecutive auto-steps (`auto: true`) that may execute
   * within a single turn before the pipeline throws `FlowConfigurationError`.
   * Guards against infinite loops in auto-step chains.
   *
   * The default (10) is applied at Agent construction time, not on this type.
   *
   * @default 10
   */
  maxAutoStepsPerTurn?: number;
  /**
   * Maximum number of chained directives allowed within a single turn before
   * the pipeline throws `FlowConfigurationError`. Guards against infinite
   * redirection loops (e.g., goTo → onEnter emits goTo → onComplete emits goTo → …).
   *
   * Chain breakers (`abort` mid-chain) stop counting and apply immediately.
   *
   * @default 10
   */
  maxDirectiveChain?: number;
  /**
   * Optional compaction configuration for managing conversation history size.
   * When provided, the agent will validate the options and make them available
   * for use by the SessionManager/CompactionEngine.
   */
  compaction?: AgentCompactionConfig;
  /**
   * Optional prompt cache configuration for controlling section memoization behavior.
   * When provided, controls whether prompt sections are cached across turns.
   * @default { enabled: true }
   */
  promptCache?: PromptCacheConfig;
  /**
   * Reserved for future router strategies. v2.0: only `'ai'` is implemented.
   * Future v2.x widens to `'embedding' | 'rules'` etc.
   *
   * Setting any non-`'ai'` value in v2.0 throws `NotImplementedError` at
   * `Agent` construction time. This is intentional — it surfaces forward-compat
   * misconfiguration loudly. Future v2.x widens the accepted union without
   * breaking the throw site (the new value just stops throwing).
   *
   * @default 'ai'
   */
  routerMode?: 'ai';

  /**
   * Signals: typed event detectors that run around the LLM turn.
   * Empty array or undefined → signal phases are no-ops, zero cost.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  signals?: Signal<TContext, TData, any>[];

  /**
   * Maximum signals per batched classifier call. Default 10.
   * If more signals are eligible after gating, they are split into
   * parallel batches of this size.
   */
  signalBatchSize?: number;
}

/**
 * A term in the domain glossary
 */
export interface Term<TContext = unknown, TData = unknown> {
  /** Name of the term */
  name: Template<TContext, TData>;
  /** Description/definition of the term */
  description: Template<TContext, TData>;
  /** Alternative names or synonyms */
  synonyms?: Template<TContext, TData>[];
}

/**
 * Instruction — unified behavioral primitive.
 * Collapses v1's `Guideline` (scoped nudge), `Rule` (absolute must-do),
 * and `Prohibition` (absolute must-not) into a single type with a `kind` discriminator.
 *
 * @example
 * // A "should" (default) — same as a v1 Guideline
 * { prompt: "Prefer short answers", when: "User asks a simple question" }
 *
 * // A "must" — same as a v1 Rule
 * { kind: 'must', prompt: "Always validate email format before proceeding" }
 *
 * // A "never" — same as a v1 Prohibition
 * { kind: 'never', prompt: "Promise delivery dates you cannot guarantee" }
 */
export interface Instruction<TContext = unknown, TData = unknown> {
  /** Unique identifier (auto-generated if omitted). */
  id?: string;
  /**
   * Instruction severity.
   * - `'must'`  — absolute rule the agent must always follow.
   * - `'never'` — absolute prohibition the agent must never do.
   * - `'should'`— behavioral nudge, active when conditions match.
   *
   * @default 'should'
   */
  kind?: 'must' | 'never' | 'should';
  /**
   * AI-evaluated activation condition. String or array of strings (AND semantics).
   * Undefined = always active. Functions are NOT allowed here — use `if`.
   */
  when?: ConditionWhen;
  /**
   * Code-evaluated activation condition. Function or array of functions (AND semantics).
   * Free to evaluate. When both `when` and `if` are set, `if` runs first;
   * `when` is only evaluated when `if` passes.
   */
  if?: ConditionIf<TContext, TData>;
  /** Behavioral instruction text rendered into the prompt. */
  prompt: Template<TContext, TData>;
  /** Whether this instruction is currently enabled. @default true */
  enabled?: boolean;
  /** Tags for organizing and filtering instructions. */
  tags?: string[];
  /** Additional metadata. */
  metadata?: Record<string, unknown>;
}

/**
 * Carries the three scope buckets through the prompt pipeline so the composer
 * can render scope captions correctly.
 */
export interface ScopedInstructions<TContext = unknown, TData = unknown> {
  /** Agent-level — rendered with caption `[Always]`. */
  global: Instruction<TContext, TData>[];
  /**
   * Flow-level — rendered with caption `[In: <FlowTitle>]`.
   * `flowTitle` is captured here so the composer doesn't need a Flow reference.
   */
  flow?: { flowTitle: string; items: Instruction<TContext, TData>[] };
  /**
   * Step-level — rendered with caption `[Step: <stepId>]`.
   * `stepId` is captured here for the same reason.
   */
  step?: { stepId: string; items: Instruction<TContext, TData>[] };
}

/**
 * Observability record for an instruction that was active and rendered into a turn's prompt.
 * Deterministic — derived from rendering, not from LLM self-report.
 */
export interface AppliedInstruction {
  /** The instruction's id */
  id: string;
  /** Which scope the instruction originated from */
  scope: 'global' | 'flow' | 'step';
  /** FlowTitle for `scope === 'flow'`, stepId for `scope === 'step'`, undefined for `scope === 'global'`. */
  scopeRef?: string;
}

export interface AgentResponse<TData = Record<string, unknown>> {
  message: string;
  session?: SessionState<TData>;
  toolCalls?: Array<{ toolName: string; arguments: Record<string, unknown> }>;
  isFlowComplete?: boolean;
  /** Steps executed in this response (for multi-step execution) */
  executedSteps?: StepRef[];
  /** Why execution stopped (for multi-step execution) */
  stoppedReason?: StoppedReason;
  /**
   * Instructions whose conditions passed and were rendered into this turn's prompt.
   * Deterministic — derived from rendering, not from LLM self-report.
   */
  appliedInstructions?: AppliedInstruction[];
  /**
   * Signals that fired during this turn (both pre- and post-phases), in fire order.
   * Mirrors the observability framing of `executedSteps` and `appliedInstructions`.
   */
  triggeredSignals?: SignalFiring<unknown, TData>[];
}

export interface AgentResponseStreamChunk<TData = Record<string, unknown>> {
  delta: string;
  accumulated: string;
  done: boolean;
  session?: SessionState<TData>;
  toolCalls?: Array<{ toolName: string; arguments: Record<string, unknown> }>;
  isFlowComplete?: boolean;
  /** Steps executed in this response (for multi-step execution) */
  executedSteps?: StepRef[];
  /** Why execution stopped (for multi-step execution) */
  stoppedReason?: StoppedReason;
  metadata?: {
    model?: string;
    tokensUsed?: number;
    finishReason?: string;
    [key: string]: unknown;
  };
  structured?: AgentStructuredResponse;
  error?: Error;
  /**
   * Instructions whose conditions passed and were rendered into this turn's prompt.
   * Populated on the final (`done: true`) chunk only.
   */
  appliedInstructions?: AppliedInstruction[];
  /**
   * Signals that fired during this turn (both pre- and post-phases), in fire order.
   * Mirrors the observability framing of `executedSteps` and `appliedInstructions`.
   * Populated on the final (`done: true`) chunk only.
   */
  triggeredSignals?: SignalFiring<unknown, TData>[];
}

/**
 * Validation error for data validation
 */
export interface ValidationError {
  field: string;
  value: unknown;
  message: string;
  schemaPath: string;
}

/**
 * Result of data validation
 */
export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationError[];
}
