/**
 * Runtime state: runs, step outcomes, the session blob and the Store seam.
 *
 * The session blob is the unit of consistency (invariant I1): the host loads
 * it, calls `turn`, and saves it back with the version it loaded. A losing
 * save throws `SessionConflictError` and the same input is replayed.
 */

import type { History } from "./history.js";

export type RunStatus = "running" | "asking" | "waiting" | "suspended";

export type TriggerKind = "message" | "mention" | "silence" | "event" | "start" | "flow";

/** One live execution of a flow inside a session. */
export interface Run {
  /** `${flowId}#${triggerKey}`: deterministic, so a replay mints the same keys. */
  id: string;
  flowId: string;
  anchor: string;
  dedupeKey: string;
  stepId: string | null;
  status: RunStatus;
  trigger: { kind: TriggerKind; key: string; payload?: unknown };
  input?: unknown;
  /** Flow-to-flow chaining depth; capped at 5. */
  hop: number;
  startedAt: string;
  waiting?: {
    kind: "timer" | "event";
    /** The wake key; only a `wake` equal to it is honoured. */
    key?: string;
    until?: string;
    setAt: string;
    event?: string;
  };
  /** Times each field was asked; a field at `maxAsks` is skipped. */
  asked: Record<string, number>;
  /** Times each step was entered; part of every action and message key. */
  visits: Record<string, number>;
  outcomes: StepOutcome[];
}

export type StepOutcomeKind = "prompt" | "collect" | "say" | "do" | "wait" | "if" | "idle";

export type StepOutcomeStatus = "ok" | "skipped" | "failed" | "waiting" | "deferred";

/** One line per step for the host's execution log. */
export interface StepOutcome {
  runId?: string;
  flowId?: string;
  stepId?: string;
  key?: string;
  kind: StepOutcomeKind;
  status: StepOutcomeStatus;
  detail?: string;
  next?: string;
  until?: string;
  at: string;
  llmCalls?: number;
}

/** One conversation's state. Holds many runs; at most one is asking. */
export interface Session<D = unknown> {
  id: string;
  v: 4;
  /** Optimistic-concurrency version; the host bumps it on save. */
  version: number;
  data: Partial<D>;
  /** Live runs only. */
  runs: Run[];
  /** Once/cooldown claims: one key per flow. Always-flows keep the last 50. */
  claims: Record<string, { at: string }>;
  /** The last 50 keyed input ids, for replay detection. */
  inputs: string[];
  lastUserAt?: string;
  lastAssistantAt?: string;
  /** Kept only when the host does not manage history itself (playground). */
  history?: History;
  metadata: Record<string, unknown>;
}

/**
 * Where sessions live. `save` with `expectedVersion: 0` inserts if absent;
 * a stale version throws `SessionConflictError`.
 */
export interface Store<D = unknown> {
  load(id: string): Promise<Session<D> | null>;
  save(session: Session<D>, expectedVersion: number): Promise<void>;
}
