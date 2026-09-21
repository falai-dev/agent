/**
 * The authoring surface: fields, flows, steps, triggers, actions, conditions.
 *
 * A Flow is a trigger plus an ordered list of steps. Everything here is a
 * plain object literal, so the same shape round-trips through JSON (FlowSpec).
 * Two generics thread through: `C` is the host's ambient context, passed on
 * every turn; `D` is the data collected across all flows, inferred from the
 * agent's fields with `InferData`.
 */

import type { StructuredSchema } from "./schema.js";
import type { Run } from "./session.js";

// ── Scalars ─────────────────────────────────────────────────────────────

/** A time span: `'30s'`, `'5m'`, `'24h'`, `'3d'`. */
export type Duration = `${number}${"s" | "m" | "h" | "d"}`;

/** How often a trigger may start a run for one session or anchor. */
export type Repeat = "once" | "always" | { cooldown: Duration };

/**
 * Prompt text. `{{data.x}}`, `{{context.x}}` and `{{input.x}}` are filled in
 * before the text is used.
 */
export type Template = string;

/**
 * Where a step sends the run next: a step id, `'end'` (reserved; ends the
 * run), a step with fields to clear first, or another flow to start.
 */
export type Next<D = unknown> =
  | string
  | { step: string; clear?: (keyof D & string)[] }
  | { flow: Template; input?: unknown };

// ── Fields and parameters ───────────────────────────────────────────────

export type ScalarType = "string" | "number" | "integer" | "boolean";

export interface ScalarDef<T extends ScalarType = ScalarType> {
  type: T;
  description?: string;
  enum?: readonly (string | number)[];
}

/** One collectable field, authored once on the agent. */
export interface FieldDef<T extends ScalarType = ScalarType> extends ScalarDef<T> {
  /** How the AI should ask for this field when a step collects it. */
  ask?: string;
  /**
   * Where the value may be harvested from. `'anywhere'` (default for strings
   * and numbers): any lead message. `'asked'` (default for booleans): only the
   * reply to the step that lists the field, so a stray "sim" never opens a gate.
   */
  extract?: "anywhere" | "asked";
}

export type FieldDefs = Record<string, FieldDef>;

/** One parameter of a host action. All parameters are required unless `optional: true`. */
export type ParamDef =
  | (ScalarDef & { optional?: true })
  | { type: "array"; items: ScalarDef; description?: string; optional?: true };

export type ParamDefs = Record<string, ParamDef>;

type Simplify<T> = { [K in keyof T]: T[K] };

type TypeValue<T extends ScalarType> = T extends "string"
  ? string
  : T extends "boolean"
    ? boolean
    : number;

type ScalarValue<Def extends ScalarDef> = Def extends { enum: readonly (infer E)[] }
  ? E
  : TypeValue<Def["type"]>;

type ParamValue<Def extends ParamDef> = Def extends { type: "array"; items: infer I extends ScalarDef }
  ? ScalarValue<I>[]
  : Def extends ScalarDef
    ? ScalarValue<Def>
    : never;

type OptionalKeys<P extends ParamDefs> = {
  [K in keyof P]: P[K] extends { optional: true } ? K : never;
}[keyof P];

/** The collected-data type of a set of fields. Enums become literal unions. */
export type InferData<F extends FieldDefs> = Simplify<{ [K in keyof F]: ScalarValue<F[K]> }>;

/** The `with` shape of a host action, from its parameter definitions. */
export type InferParams<P extends ParamDefs> = Simplify<
  { [K in Exclude<keyof P, OptionalKeys<P>>]: ParamValue<P[K]> } & {
    [K in OptionalKeys<P>]?: ParamValue<P[K]>;
  }
>;

// ── Predicates ──────────────────────────────────────────────────────────

/** What a code predicate sees. `run` is the run about to move or start. */
export interface PredCtx<C = unknown, D = unknown, P = unknown> {
  context: C;
  data: Partial<D>;
  input: P;
  run: Run;
  /** The host's reason the assistant cannot speak right now, when it cannot. */
  silenced?: string;
  now: Date;
}

/**
 * A named host condition, used by name (with its argument) in JSON specs.
 * Declared as a method so a condition typed for one argument fits the map;
 * the argument arrives from JSON unvalidated, so the check should test it.
 */
export interface Condition<C = unknown, D = unknown, Arg = unknown> {
  check(ctx: PredCtx<C, D>, arg: Arg): boolean;
}

export type ConditionMap<C = unknown, D = unknown> = Record<string, Condition<C, D>>;

/**
 * The JSON form of a predicate. Every listed entry must hold. Built-ins:
 * `equals` (fields equal the given values), `known` (fields are known),
 * `silenced` (the host gate is closed). Any other key names one of the
 * agent's conditions and carries its argument.
 */
export interface ConditionSpec<D = unknown> {
  equals?: Partial<D>;
  known?: (keyof D & string)[];
  silenced?: boolean;
  [condition: string]: unknown;
}

/** A code predicate (free) or its JSON form. */
export type Pred<C = unknown, D = unknown, P = unknown> =
  | ((ctx: PredCtx<C, D, P>) => boolean)
  | ConditionSpec<D>;

/** A fork judged while a step is asking: `when` by the AI, `if` by code. */
export type Branch<C = unknown, D = unknown> = { then: Next<D> } & (
  | { when: string }
  | { if: Pred<C, D> }
);

// ── Triggers ────────────────────────────────────────────────────────────

/**
 * When a run starts. `repeat` defaults to `'once'` for message, mention and
 * silence triggers and to `'always'` for events.
 */
export type Trigger<C = unknown, D = unknown> = { repeat?: Repeat } & (
  /** The lead asks for this; the run takes the conversation. `[]` = catch-all. */
  | { message: string[]; if?: Pred<C, D> }
  /** The lead mentions this; the run reacts beside the conversation. `[]` + `if` = code-only. */
  | { mention: string[]; extract?: StructuredSchema; if?: Pred<C, D> }
  /** The lead has been quiet since the assistant last spoke. */
  | { silence: Duration; if?: Pred<C, D>; businessHours?: boolean }
  /** The host reported an event; its payload is the run's `input`. */
  | { event: string; if?: Pred<C, D>; after?: Duration; businessHours?: boolean }
);

// ── Instructions ────────────────────────────────────────────────────────

/** A behavioural statement rendered into the prompt while it applies. */
export interface Instruction<C = unknown, D = unknown> {
  id?: string;
  /** `'must'` always, `'never'` a prohibition, `'should'` (default) a nudge. */
  kind?: "must" | "never" | "should";
  /** AI-judged activation, rendered into the prompt. */
  when?: string | string[];
  /** Code-judged activation, free. */
  if?: Pred<C, D>;
  prompt: Template;
}

// ── Steps ───────────────────────────────────────────────────────────────

/** The AI talks: a guideline, fields to collect, or both. */
export type TalkStep<C = unknown, D = unknown> = (
  | { prompt: Template; collect?: (keyof D & string)[] }
  | { collect: (keyof D & string)[]; prompt?: Template }
) & {
  /** Per-flow wording for a field; the field's own `ask` is the default. */
  ask?: Partial<Record<keyof D & string, string>>;
  /** Times a field may be asked before it is skipped. Default 3. */
  maxAsks?: number;
  branches?: Branch<C, D>[];
  tools?: string[];
  instructions?: Instruction<C, D>[];
};

/** A fixed message goes out, verbatim. */
export interface SayStep {
  say: Template;
  media?: { slug: string };
  /** Send at most once per session. */
  once?: boolean;
}

/** The host does something. `with` is checked against the action's parameters. */
export interface DoStep<D = unknown> {
  do: string;
  with?: Record<string, unknown>;
  /** Where to go when the action reports `failed`. Default: continue. */
  onFail?: Next<D>;
}

/** Park for a while. `then` = the time passed; `else` = the lead replied first. */
export interface WaitStep<C = unknown, D = unknown> {
  wait: Duration;
  businessHours?: boolean;
  else?: Next<D>;
  branches?: Branch<C, D>[];
}

/** Park until an event. `then` = it came; `else` = `upTo` passed (default 30 days). */
export interface WaitEventStep<D = unknown> {
  wait: { event: string; upTo?: Duration };
  else?: Next<D>;
}

/** The code forks. `then` = true; `else` = false (default `'end'`). */
export interface IfStep<C = unknown, D = unknown> {
  if: Pred<C, D>;
  else?: Next<D>;
}

export interface StepBase<D = unknown> {
  /** Required, unique inside the flow, never `'end'`. */
  id: string;
  label?: string;
  then?: Next<D>;
  /** Editor-only data the framework carries but never reads. */
  ui?: Record<string, unknown>;
}

export type Step<C = unknown, D = unknown> = StepBase<D> &
  (TalkStep<C, D> | SayStep | DoStep<D> | WaitStep<C, D> | WaitEventStep<D> | IfStep<C, D>);

// ── Flow ────────────────────────────────────────────────────────────────

export interface Flow<C = unknown, D = unknown> {
  id: string;
  name: string;
  /** When this flow should be used; the AI reads it when routing. */
  description?: string;
  /** Absent or empty: the flow only starts when the host calls `start`. */
  on?: Trigger<C, D>[];
  /** `'session'` (default) or a host anchor name such as `'lead'`. */
  anchor?: string;
  /** Re-checked whenever the run moves. Default: the trigger's `if`. */
  while?: Pred<C, D>;
  clearOnStart?: (keyof D & string)[];
  steps: Step<C, D>[];
  /** What the run does after its last step. Default `'end'`. */
  onEnd?: "end" | "stay" | "reset";
  instructions?: Instruction<C, D>[];
  tools?: string[];
}

// ── Actions and events ──────────────────────────────────────────────────

export type ActionResult =
  | { ok: true; detail?: string; spoke?: true }
  | { skipped: string }
  | { failed: string }
  | { defer: Duration; detail: string };

/** What a host action sees. Handlers run at-least-once; make them idempotent on `key`. */
export interface ActionCtx<C = unknown, D = unknown> {
  context: C;
  data: Partial<D>;
  input: unknown;
  run: Run;
  /** `${runId}:${stepId}:${visit}`; the same on a replay of the same input. */
  key: string;
  /** `${flowId}:${anchor}:${nonce}`; shared across a lead's sessions. */
  dedupeKey: string;
  silenced?: string;
  now: Date;
  /** Write collected data from inside the action. */
  set(patch: Partial<D>): void;
}

export interface Action<C = unknown, D = unknown, P = Record<string, unknown>> {
  description?: string;
  parameters: ParamDefs;
  run(params: P, ctx: ActionCtx<C, D>): ActionResult | Promise<ActionResult>;
}

export type ActionMap<C = unknown, D = unknown> = Record<string, Action<C, D>>;

/** A host event the agent may react to. `P` is the payload type. */
export interface EventDef<P = unknown> {
  /**
   * `'inbound'` counts as the lead speaking (resolves reply waits);
   * `'outbound'` as the assistant speaking (re-arms silence).
   */
  direction?: "inbound" | "outbound";
  /** Phantom: the payload type, for inference. Never set at runtime. */
  readonly payload?: P;
}

export type EventMap = Record<string, EventDef>;
