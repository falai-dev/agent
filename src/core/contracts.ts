/**
 * The seams between the turn's phases. Runner decides who is eligible and
 * what is pending; Understand and Speak turn that into at most one provider
 * call each and hand back plain data for Runner to apply.
 *
 * Runner (code)  ──UnderstandRequest──▶  Understand (≤1 call)  ──Understanding──▶  Runner
 * Runner (code)  ──SpeakRequest──────▶  Speak (≤1 call + tools) ──SpeakOutcome──▶  Runner
 */

import type { Idle } from "../types/agent.js";
import type { FieldDef, Flow, Instruction, StepBase, TalkStep } from "../types/flow.js";
import type { History } from "../types/history.js";
import type { Run } from "../types/session.js";
import type { Tool } from "../types/tool.js";

export type InputKind = "message" | "wake" | "event" | "start";

// ── Understand ──────────────────────────────────────────────────────────

/** Everything the understand call may judge this turn. Runner filters by `if` and `repeat` first. */
export interface UnderstandRequest<C = unknown, D = unknown> {
  text: string;
  history: History;
  context: C;
  data: Partial<D>;
  /** The run holding the floor, always a candidate whatever its trigger. */
  floor?: { run: Run; flow: Flow<C, D> };
  /** Eligible `message` flows, in flow order. `[]` triggers (catch-alls) are excluded. */
  messageFlows: Flow<C, D>[];
  /** Eligible `mention` flows with a non-empty `mention[]`, in flow order. */
  mentionFlows: Flow<C, D>[];
  /** `when` branches of the asking step. */
  branches: Array<{ runId: string; stepId: string; index: number; when: string }>;
  /** Pending fields harvestable from any text (`extract: 'anywhere'`). */
  fields: Record<string, FieldDef>;
}

/** The judged result. Raw values: Runner validates and writes them. */
export interface Understanding {
  /** flowId → 0–100 fit of the lead's message to the flow. */
  flows: Record<string, number>;
  /** flowId → the lead mentioned it. */
  mentions: Record<string, boolean>;
  /** flowId → values extracted for a mention trigger's `extract` schema. */
  extract: Record<string, Record<string, unknown>>;
  /** `${runId}/${stepId}/${index}` → the branch condition holds. */
  branches: Record<string, boolean>;
  /** field → raw value the lead gave, or nothing. */
  fields: Record<string, unknown>;
  llmCalls: number;
}

// ── Speak ───────────────────────────────────────────────────────────────

/** A talk step queued to speak, with its pending fields already computed. */
export interface TalkRequest<C = unknown, D = unknown> {
  run: Run;
  flow: Flow<C, D>;
  step: StepBase<D> & TalkStep<C, D>;
  /** `step.collect` minus known minus at `maxAsks`, in order. */
  pending: string[];
}

/** No run holds the floor; the idle speaker answers. */
export interface IdleRequest {
  idle: Exclude<Idle, "silent">;
}

export interface SpeakRequest<C = unknown, D = unknown> {
  talk: TalkRequest<C, D> | IdleRequest;
  /** What started this turn. A wake has no text: the assistant speaks first. */
  input: { kind: InputKind; text?: string };
  context: C;
  data: Partial<D>;
  history: History;
  now: Date;
  /** Already filtered by their `if`; `when` stays for the prompt. */
  instructions: Instruction<C, D>[];
  tools: Tool<C, D>[];
}

export interface Spoken {
  message: string;
  /** Raw envelope values for the pending fields. Runner validates and writes them. */
  fields: Record<string, unknown>;
  /** Data patches returned by tools, merged in call order. */
  data: Record<string, unknown>;
  toolCalls: Array<{ toolName: string; arguments: Record<string, unknown> }>;
  llmCalls: number;
}

/** `deferred` is the provider failing; Runner re-parks the step under a retry wake. */
export type SpeakOutcome = { spoken: Spoken } | { deferred: string; llmCalls: number };

export type SpeakStreamChunk = { delta: string } | { done: true; outcome: SpeakOutcome };
