/**
 * Agent options and the one entry point: `turn`.
 */

import type { AiProvider, TokenUsage } from "./ai.js";
import type {
  ActionMap,
  ConditionMap,
  EventMap,
  FieldDefs,
  Flow,
  Instruction,
  Template,
} from "./flow.js";
import type { History } from "./history.js";
import type { Run, Session, StepOutcome, StepOutcomeCode } from "./session.js";
import type { Tool } from "./tool.js";

/** Returns "now". Tests pass a fake clock. */
export type Clock = () => Date;

/** Moves a time forward to the next working moment. Snaps, never clamps. */
export type BusinessHours<C = unknown> = (at: Date, ctx: { context: C }) => Date;

/**
 * The one speaker that is not a step: answers when no run holds the floor.
 * `'silent'` mutes it.
 */
export type Idle<C = unknown, D = unknown> =
  | { prompt: Template; tools?: string[]; instructions?: Instruction<C, D>[] }
  | "silent";

/**
 * Agent-level compaction configuration. `provider` comes from the agent.
 */
export interface AgentCompactionConfig {
  /** Maximum token budget for the conversation. */
  maxTokens: number;
  /** Ratio (0.5–0.95) at which to compact. Default 0.8. */
  compactionThreshold?: number;
  /** Recent messages always kept unchanged (>= 2). Default 4. */
  preserveRecentCount?: number;
  /** Characters per tool result before truncation (> 0). Default 5000. */
  maxToolResultChars?: number;
  /** Default true when the config is present. */
  enabled?: boolean;
}

export interface AgentOptions<C = unknown, D = unknown> {
  name: string;
  /** What the agent is for. */
  goal?: Template;
  /** Who the agent is and how it talks. */
  persona?: Template;
  provider: AiProvider;
  /** Every collectable field, authored once. */
  fields: FieldDefs;
  flows?: Flow<C, D>[];
  /** Host actions `do` steps may name. */
  actions?: ActionMap<C, D>;
  /** Host events triggers and waits may name. */
  events?: EventMap;
  /** Host conditions JSON predicates may name. */
  conditions?: ConditionMap<C, D>;
  tools?: Tool<C, D>[];
  instructions?: Instruction<C, D>[];
  /** Any JSON the AI should know. */
  knowledgeBase?: Record<string, unknown>;
  idle?: Idle<C, D>;
  clock?: Clock;
  businessHours?: BusinessHours<C>;
  /** Tool rounds per speak call. Default 5; 0 disables tools. */
  maxToolLoops?: number;
  /** Trim the history both calls see, once per turn, when it grows past `maxTokens`. */
  compaction?: AgentCompactionConfig;
  debug?: boolean;
}

// ── turn() input ────────────────────────────────────────────────────────

/** The host's reason the assistant cannot speak. Zero calls unless `understand: true`. */
export type Silenced = string | { reason: string; understand?: boolean };

type ContextField<C> = undefined extends C ? { context?: C } : { context: C };

export type TurnBase<C = unknown, D = unknown> = ContextField<C> & {
  sessionId: string;
  /** Absent on a first turn. A wake never creates a session. */
  session?: Session<D>;
  /**
   * The conversation BEFORE this input. Pass it on every input kind, wakes included.
   * Leave out the message this turn carries: both calls quote it on their own, so a
   * history that ends with it makes the model read it twice.
   */
  history?: History;
  silenced?: Silenced;
  /** Host anchors this session belongs to, e.g. `{ lead: { key: 'lead:456', lastInboundAt } }`. */
  anchors?: Record<string, { key: string; lastInboundAt?: string }>;
  /** Claims held in the lead's other sessions: `dedupeKey → at`, and live `${flowId}:${anchor}` pairs. */
  claims?: { held: Record<string, string>; active: string[] };
};

export type TurnKind =
  /** The lead wrote. Hosts pass the channel id and receipt time. */
  | { message: string; id?: string; at?: string }
  /** A scheduled wake fired; the key came from `schedule[]`. */
  | { wake: string }
  /** Something happened in the host. */
  | { event: string; payload?: unknown; key: string; hop?: number }
  /** Start a flow by hand. */
  | { start: { flow: string; input?: unknown; key: string; hop?: number } };

export type TurnInput<C = unknown, D = unknown> = TurnBase<C, D> & TurnKind;

// ── turn() result ───────────────────────────────────────────────────────

export interface OutboundMessage {
  text: string;
  /** `'ai'` was phrased by the model; `'verbatim'` came from a `say` step. */
  kind: "ai" | "verbatim";
  media?: { slug: string };
  /** Delay before sending, from a short `wait` that preceded it. */
  afterMs: number;
  /** `${runId}:${stepId}:${visit}`; the same on a replay. */
  key: string;
  runId?: string;
  stepId?: string;
}

/** A wake to enqueue with `jobId = key`; at fire time call `turn({ wake: key })`. */
export interface ScheduleEntry {
  key: string;
  at: Date;
  /** An earlier wake this one supersedes; removing it is best effort. */
  replaces?: string;
}

export type EndReason = "end" | "flow" | "reset" | "skipped" | "failed" | "replaced";

export interface TurnResult<D = unknown> {
  /** Version unchanged; the host bumps it on save. */
  session: Session<D>;
  /** False: save nothing, send nothing. */
  changed: boolean;
  messages: OutboundMessage[];
  schedule: ScheduleEntry[];
  outcomes: StepOutcome[];
  started: Array<{ runId: string; flowId: string; anchor: string; dedupeKey: string }>;
  ended: Array<Run & { reason: EndReason }>;
  /** Triggers that matched but did not start a run, with the reason. */
  skipped: Array<{ flowId: string; anchor: string; triggerKey: string; code: StepOutcomeCode; message: string }>;
  llmCalls: number;
  /**
   * What those calls cost, added up. Absent when the turn spent none, or when
   * the provider reported no counts.
   */
  usage?: TokenUsage;
}

export type TurnStreamChunk<D = unknown> = { delta: string } | { done: true; result: TurnResult<D> };
