/**
 * FlowSpec: a Flow as JSON, and the checks that make a stored flow safe to run.
 *
 * Stored flows, flows an editor saves and flows an LLM generates are all
 * FlowSpecs: the same object as `Flow` with a flat step that carries a `kind`
 * and predicates only in their JSON form (`ConditionSpec`). No functions
 * anywhere, so it survives `JSON.stringify`.
 *
 * Kind rule: a talk step is `collect` whenever it has a `collect` list, with
 * or without a `prompt` beside it; it is `prompt` when it has a guideline
 * alone. A wait with a duration is `wait`; a wait on an event is `waitEvent`.
 *
 * `fromSpec` treats `null` as absent for every optional value, because the
 * generation schema (`flowSpecSchema`) says null where the type says optional.
 * `toSpec` never writes null, so `toSpec(fromSpec(spec))` is the spec with its
 * nulls dropped, and the identity on a spec that had none.
 */

import type { AgentOptions } from "../types/agent.js";
import { FlowConfigurationError } from "../types/errors.js";
import type {
  Branch,
  ConditionSpec,
  DoStep,
  Duration,
  FieldDefs,
  Flow,
  InferData,
  Instruction,
  Next,
  ParamDef,
  ParamDefs,
  Pred,
  Repeat,
  SayStep,
  ScalarDef,
  Step,
  StepBase,
  Template,
  Trigger,
  WaitEventStep,
  WaitStep,
} from "../types/flow.js";
import type { StructuredSchema } from "../types/schema.js";
import { isDuration } from "../utils/duration.js";
import { splitPhrases } from "../utils/phrases.js";
import { toWireSchema } from "../utils/schema.js";

// ── The JSON form ───────────────────────────────────────────────────────

/** The collected-data type of a toolkit without bound fields: slugs are plain strings. */
type LooseData = InferData<FieldDefs>;

export type StepKind = "prompt" | "collect" | "say" | "do" | "wait" | "waitEvent" | "if";

export type BranchSpec = { then: Next<LooseData> } & ({ when: string } | { if: ConditionSpec<LooseData> });

export type InstructionSpec = Omit<Instruction, "if"> & { if?: ConditionSpec<LooseData> };

/** A trigger with its `if` in JSON form. Same shape as `Trigger` otherwise. */
export type TriggerSpec = { repeat?: Repeat } & (
  | { message: string[]; if?: ConditionSpec<LooseData> }
  | { mention: string[]; extract?: ParamDefs; if?: ConditionSpec<LooseData> }
  | { silence: Duration; if?: ConditionSpec<LooseData>; businessHours?: boolean }
  | { event: string; if?: ConditionSpec<LooseData>; after?: Duration; businessHours?: boolean }
);

interface TalkSpecExtras {
  ask?: Partial<Record<string, string>>;
  maxAsks?: number;
  branches?: BranchSpec[];
  tools?: string[];
  instructions?: InstructionSpec[];
}

/** A flat step: `kind` plus the kind's own properties. */
export type StepSpec = StepBase<LooseData> &
  (
    | ({ kind: "prompt"; prompt: Template; collect?: undefined } & TalkSpecExtras)
    | ({ kind: "collect"; collect: string[]; prompt?: Template } & TalkSpecExtras)
    | ({ kind: "say" } & SayStep)
    | ({ kind: "do" } & DoStep<LooseData>)
    | { kind: "wait"; wait: Duration; businessHours?: boolean; else?: Next<LooseData>; branches?: BranchSpec[] }
    | ({ kind: "waitEvent" } & WaitEventStep<LooseData>)
    | { kind: "if"; if: ConditionSpec<LooseData>; else?: Next<LooseData> }
  );

export interface FlowSpec {
  id: string;
  name: string;
  description?: string;
  on?: TriggerSpec[];
  anchor?: string;
  while?: ConditionSpec<LooseData>;
  clearOnStart?: string[];
  steps: StepSpec[];
  onEnd?: "end" | "stay" | "reset";
  instructions?: InstructionSpec[];
  tools?: string[];
}

/** What a flow's names resolve against: the agent's fields, actions, events, conditions and tools. */
export type Registries = Pick<AgentOptions, "fields" | "actions" | "events" | "conditions" | "tools">;

// ── fromSpec / toSpec ───────────────────────────────────────────────────

/**
 * A spec as a typed flow. The slugs and names inside a spec are strings from
 * storage, so the result is typed by claim: `validateFlow` (which the agent
 * runs on every flow it is built with) is what makes the claim true. The
 * bound toolkit's `f.fromSpec(spec)` fills `C` and `D` in.
 */
export function fromSpec<C = unknown, D = LooseData>(spec: FlowSpec): Flow<C, D> {
  const clean = stripNulls(spec);
  if (!Array.isArray(clean.steps)) {
    throw problem(`flow "${clean.id}"`, "has no steps list", "Write steps as a list, even an empty one.");
  }
  const { steps, ...rest } = clean;
  const flow: Flow<unknown, LooseData> = { ...rest, steps: steps.map(fromStepSpec) };
  return flow as Flow<C, D>;
}

function fromStepSpec(step: StepSpec): Step<unknown, LooseData> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- `kind` is the one property the Flow form drops
  const { kind, ...body } = step;
  return body;
}

/** Throws `FlowConfigurationError` when the flow carries a function predicate: it cannot be stored. */
export function toSpec<C, D extends LooseData>(flow: Flow<C, D>): FlowSpec {
  const at = (where: string) => `flow "${flow.id}", ${where}`;
  return compact<FlowSpec>({
    id: flow.id,
    name: flow.name,
    description: flow.description,
    on: flow.on?.map((trigger, i) => triggerToSpec(trigger, at(`trigger #${i + 1}`))),
    anchor: flow.anchor,
    while: jsonPred(flow.while, at("while")),
    clearOnStart: flow.clearOnStart,
    steps: flow.steps.map((step) => stepToSpec(step, at(`step "${step.id}"`))),
    onEnd: flow.onEnd,
    instructions: flow.instructions?.map((ins, i) => instructionToSpec(ins, at(`instructions[${i}]`))),
    tools: flow.tools,
  });
}

function triggerToSpec<C, D extends LooseData>(trigger: Trigger<C, D>, at: string): TriggerSpec {
  return compact<TriggerSpec>({ ...trigger, if: jsonPred(trigger.if, `${at} if`) });
}

function instructionToSpec<C, D extends LooseData>(ins: Instruction<C, D>, at: string): InstructionSpec {
  return compact<InstructionSpec>({ ...ins, if: jsonPred(ins.if, `${at}.if`) });
}

function branchesToSpec<C, D extends LooseData>(branches: Branch<C, D>[] | undefined, at: string): BranchSpec[] | undefined {
  return branches?.map((branch, i) =>
    "if" in branch ? { ...branch, if: jsonPredRequired(branch.if, `${at} branches[${i}].if`) } : branch,
  );
}

function stepToSpec<C, D extends LooseData>(step: Step<C, D>, at: string): StepSpec {
  const base = { id: step.id, label: step.label, then: step.then, ui: step.ui };
  if ("say" in step) {
    return compact<StepSpec>({ ...base, kind: "say", say: step.say, media: step.media, once: step.once });
  }
  if ("do" in step) {
    return compact<StepSpec>({ ...base, kind: "do", do: step.do, with: step.with, onFail: step.onFail });
  }
  if ("wait" in step) {
    return isTimedWait(step)
      ? compact<StepSpec>({
          ...base,
          kind: "wait",
          wait: step.wait,
          businessHours: step.businessHours,
          else: step.else,
          branches: branchesToSpec(step.branches, at),
        })
      : compact<StepSpec>({ ...base, kind: "waitEvent", wait: step.wait, else: step.else });
  }
  if ("if" in step) {
    return compact<StepSpec>({ ...base, kind: "if", if: jsonPredRequired(step.if, `${at} if`), else: step.else });
  }
  const talk = {
    ask: step.ask,
    maxAsks: step.maxAsks,
    branches: branchesToSpec(step.branches, at),
    tools: step.tools,
    instructions: step.instructions?.map((ins, i) => instructionToSpec(ins, `${at} instructions[${i}]`)),
  };
  if (step.collect !== undefined) {
    return compact<StepSpec>({ ...base, kind: "collect", collect: step.collect, prompt: step.prompt, ...talk });
  }
  if (step.prompt === undefined) {
    throw problem(at, "has neither prompt nor collect", "A talk step needs a guideline, fields to collect, or both.");
  }
  return compact<StepSpec>({ ...base, kind: "prompt", prompt: step.prompt, ...talk });
}

/** `typeof step.wait` alone does not narrow the union for tsc; this does. */
function isTimedWait<C, D>(
  step: StepBase<D> & (WaitStep<C, D> | WaitEventStep<D>),
): step is StepBase<D> & WaitStep<C, D> {
  return typeof step.wait === "string";
}

function jsonPred<C, D extends LooseData>(pred: Pred<C, D> | undefined, at: string): ConditionSpec<LooseData> | undefined {
  return pred === undefined ? undefined : jsonPredRequired(pred, at);
}

function jsonPredRequired<C, D extends LooseData>(pred: Pred<C, D>, at: string): ConditionSpec<LooseData> {
  if (typeof pred === "function") {
    throw problem(
      at,
      "is a function, which cannot be stored as JSON",
      "Write it as a condition ({ equals }, { known }, { silenced } or a named condition) to store this flow.",
    );
  }
  return pred;
}

// ── validateFlow ────────────────────────────────────────────────────────

/** A read-only view that a typed Flow and a spec-derived Flow both fit; the validator only reads. */
// A typed flow's ConditionSpec<D> and a spec's JSON both read as a name → argument map here.
type LoosePred = ((ctx: never) => boolean) | Record<string, unknown>;
interface LooseBranch {
  then: Next<LooseData>;
  when?: string;
  if?: LoosePred;
}
interface LooseInstruction {
  if?: LoosePred;
}
interface LooseTrigger {
  repeat?: Repeat;
  message?: string[];
  mention?: string[];
  event?: string;
  silence?: Duration;
  after?: Duration;
  if?: LoosePred;
}
interface LooseStep {
  id: string;
  then?: Next<LooseData>;
  else?: Next<LooseData>;
  onFail?: Next<LooseData>;
  prompt?: Template;
  collect?: string[];
  ask?: Partial<Record<string, string>>;
  branches?: LooseBranch[];
  instructions?: LooseInstruction[];
  say?: Template;
  do?: string;
  with?: Record<string, unknown>;
  wait?: Duration | { event: string; upTo?: Duration };
  if?: LoosePred;
  tools?: string[];
}
interface LooseFlow {
  id: string;
  on?: LooseTrigger[];
  while?: LoosePred;
  clearOnStart?: string[];
  steps: LooseStep[];
  instructions?: LooseInstruction[];
  tools?: string[];
}

const BUILT_IN_CONDITIONS = ["equals", "known", "silenced"];

const DURATION_HINT = 'Write a number and a unit: "30s", "5m", "24h" or "3d".';

/** The four keys one of which makes an `on[]` entry a trigger. */
const TRIGGER_KINDS = ["message", "mention", "silence", "event"] as const;

/** The six keys one of which makes a step do something. */
const STEP_DOES = ["prompt", "collect", "say", "do", "wait", "if"] as const;

/**
 * Check a flow, typed or as a spec, against the agent's registries. Throws
 * `FlowConfigurationError` on the first problem that would break at runtime;
 * returns warnings for what runs but probably not as intended.
 */
export function validateFlow<C = unknown, D = LooseData>(
  input: Flow<C, D> | FlowSpec,
  registries: Registries,
): { warnings: string[] } {
  // Nulls mean "not set" in a spec; a typed flow has none, so one pass serves both forms.
  const flow: LooseFlow = stripNulls(input);
  const { fields, actions = {}, events = {}, conditions = {}, tools = [] } = registries;
  const toolIds = new Set(tools.map((tool) => tool.id));
  const warnings: string[] = [];

  if (typeof flow.id !== "string" || flow.id === "") {
    throw problem("flow", "has no id", "Give the flow a short unique id.");
  }
  const flowAt = `flow "${flow.id}"`;
  if (!Array.isArray(flow.steps)) {
    throw problem(flowAt, "has no steps list", "Write steps as a list, even an empty one.");
  }

  const index = new Map<string, number>();
  flow.steps.forEach((step, i) => {
    if (typeof step.id !== "string" || step.id === "") {
      throw problem(`${flowAt}, step #${i + 1}`, "has no id", "Give every step a unique id.");
    }
    if (step.id === "end") {
      throw problem(`${flowAt}, step "end"`, 'uses the reserved id "end"', '"end" ends the run; pick another id.');
    }
    if (index.has(step.id)) {
      throw problem(`${flowAt}, step "${step.id}"`, "duplicates an earlier step id", "Give each step its own id.");
    }
    index.set(step.id, i);
  });
  if (flow.on?.length && flow.steps.length === 0) {
    throw problem(flowAt, "has triggers but no steps", "Add at least one step or remove `on`.");
  }

  const slug = (name: string, at: string, where: string): void => {
    if (!own(fields, name)) {
      throw problem(at, `unknown field "${name}" in ${where}`, "Add it to the agent's fields or fix the slug.");
    }
  };

  const toolNames = (names: string[] | undefined, at: string): void => {
    for (const name of names ?? []) {
      if (!toolIds.has(name)) throw problem(at, `unknown tool "${name}"`, "Register it in the agent's tools or fix the name.");
    }
  };

  const pred = (value: LoosePred | undefined, at: string, where: string): void => {
    if (value === undefined || typeof value === "function") return;
    for (const [name, arg] of Object.entries(value)) {
      if (name === "equals") {
        if (arg === null || typeof arg !== "object" || Array.isArray(arg)) {
          throw problem(at, `${where}.equals is not an object`, "Write equals as { field: value }.");
        }
        for (const [field, given] of Object.entries(arg)) {
          slug(field, at, `${where}.equals`);
          const def = fields[field];
          if (!matches(def, given)) {
            throw problem(
              at,
              `${where}.equals gives "${field}" a ${describe(given)}, but the field is a ${def.type}`,
              `Write a ${def.type}; values are not coerced.`,
            );
          }
        }
      } else if (name === "known") {
        if (!Array.isArray(arg)) throw problem(at, `${where}.known is not a list`, "Write known as [field, ...].");
        for (const field of arg) slug(String(field), at, `${where}.known`);
      } else if (name === "silenced") {
        if (typeof arg !== "boolean") throw problem(at, `${where}.silenced is not a boolean`, "Write true or false.");
      } else if (!own(conditions, name)) {
        throw problem(
          at,
          `unknown condition "${name}" in ${where}`,
          `Register it in conditions or use ${BUILT_IN_CONDITIONS.join(", ")}.`,
        );
      }
    }
  };

  const duration = (value: string | undefined, at: string, where: string): void => {
    if (value !== undefined && !isDuration(value)) {
      throw problem(at, `${where} has duration "${value}", which does not parse`, DURATION_HINT);
    }
  };

  /** The step index a `Next` lands on; `'end'` and `{ flow }` land nowhere. */
  const target = (next: Next<LooseData>, at: string, where: string): number | undefined => {
    if (typeof next === "string") {
      if (next === "end") return undefined;
      const to = index.get(next);
      if (to === undefined) {
        throw problem(at, `${where} points at step "${next}", which does not exist`, 'Use an existing step id or "end".');
      }
      return to;
    }
    if ("flow" in next) return undefined;
    const to = index.get(next.step);
    if (to === undefined) {
      throw problem(at, `${where} points at step "${next.step}", which does not exist`, 'Use an existing step id or "end".');
    }
    for (const field of next.clear ?? []) slug(field, at, `${where}.clear`);
    return to;
  };

  /** `target`, warning when the edge goes backward without clearing anything. */
  const edge = (from: number, next: Next<LooseData> | undefined, at: string, where: string): number | undefined => {
    if (next === undefined) return undefined;
    const to = target(next, at, where);
    const clears = typeof next !== "string" && "clear" in next && (next.clear?.length ?? 0) > 0;
    if (to !== undefined && to <= from && !clears) {
      warnings.push(
        `${at}: ${where} jumps back to "${flow.steps[to].id}" without clear; the fields collected since stay known ` +
          "and those steps skip. Add clear: [...] to re-ask them.",
      );
    }
    return to;
  };

  const checkWith = (at: string, name: string, params: ParamDefs, given: Record<string, unknown> = {}): void => {
    for (const [param, def] of Object.entries(params)) {
      const value = given[param];
      if (value === undefined) {
        if (!def.optional) throw problem(at, `action "${name}" needs parameter "${param}"`, "Add it to `with`.");
        continue;
      }
      if (!matchesParam(def, value)) {
        const { expected, got, fix } = mismatch(def, value);
        throw problem(at, `parameter "${param}" of action "${name}" must be ${expected}, got ${got}`, fix);
      }
    }
    for (const param of Object.keys(given)) {
      if (!own(params, param)) {
        throw problem(at, `action "${name}" has no parameter "${param}"`, "Remove it or fix the name.");
      }
    }
  };

  for (const field of flow.clearOnStart ?? []) slug(field, flowAt, "clearOnStart");
  pred(flow.while, flowAt, "while");
  toolNames(flow.tools, flowAt);
  flow.instructions?.forEach((ins, i) => pred(ins.if, flowAt, `instructions[${i}].if`));

  flow.on?.forEach((trigger, i) => {
    const at = `${flowAt}, trigger #${i + 1}`;
    // A trigger that names no kind can never fire, and nothing downstream says
    // so: the Runner simply never finds it eligible and the flow looks broken
    // for some other reason. `{ kind: 'message', when: [...] }` — the v3 shape —
    // lands here, and so does a typo in the one key that matters.
    if (!TRIGGER_KINDS.some((key) => trigger[key] !== undefined)) {
      throw problem(
        at,
        "names no trigger kind",
        `A trigger is one of ${TRIGGER_KINDS.map((key) => `\`${key}\``).join(", ")}. ` +
          "A flow the host starts itself has no `on` at all.",
      );
    }
    if (trigger.event !== undefined && !own(events, trigger.event)) {
      throw problem(at, `unknown event "${trigger.event}"`, "Register it in events or fix the name.");
    }
    duration(trigger.silence, at, "silence");
    duration(trigger.after, at, "after");
    if (typeof trigger.repeat === "object") duration(trigger.repeat.cooldown, at, "repeat.cooldown");
    pred(trigger.if, at, "if");
    // Phrases opening with `!` rule the trigger out; a list of nothing but
    // those can never fire, so the flow is dead and nothing would say so.
    // `message: []` is the deliberate catch-all and stays legal.
    for (const key of ["message", "mention"] as const) {
      const phrases: string[] | undefined = trigger[key];
      if (!phrases?.length) continue;
      if (splitPhrases(phrases).counts.length > 0) continue;
      throw problem(
        at,
        `every ${key} phrase starts with "!", so nothing can ever match it`,
        `A "!" phrase rules the trigger out. Add at least one plain phrase saying when it should fire${
          key === "message" ? ", or use an empty list for a catch-all" : ""
        }.`,
      );
    }
  });

  flow.steps.forEach((step, i) => {
    const at = `${flowAt}, step "${step.id}"`;
    // Same reasoning as the trigger above: a step that does none of the five
    // things is a step the run walks straight past, silently. `kind` alone is
    // not enough — the spec form drops it and keeps the body, so what counts
    // is whether the body says what to do.
    if (!STEP_DOES.some((key) => step[key] !== undefined)) {
      throw problem(
        at,
        "does nothing",
        "A step talks (`prompt` / `collect`), says (`say`), acts (`do`), waits (`wait`) or forks (`if`).",
      );
    }
    const thenTo = edge(i, step.then, at, "then");
    edge(i, step.else, at, "else");

    if (step.collect !== undefined || step.prompt !== undefined) {
      for (const field of step.collect ?? []) slug(field, at, "collect");
      for (const field of Object.keys(step.ask ?? {})) slug(field, at, "ask");
      const fields_ = step.collect ?? [];
      if (step.prompt === undefined && fields_.length > 0 && fields_.every((f) => !step.ask?.[f] && !fields[f].ask)) {
        warnings.push(
          `${at}: collects ${fields_.map((f) => `"${f}"`).join(", ")} with no prompt and no ask; the AI has nothing ` +
            "to go on. Add a prompt or an ask per field.",
        );
      }
    }
    step.branches?.forEach((branch, j) => {
      const where = `branches[${j}]`;
      if (branch.when === undefined && branch.if === undefined) {
        throw problem(at, `${where} has neither when nor if`, "Give the branch an AI condition (when) or a code one (if).");
      }
      pred(branch.if, at, `${where}.if`);
      edge(i, branch.then, at, `${where}.then`);
    });
    step.instructions?.forEach((ins, j) => pred(ins.if, at, `instructions[${j}].if`));
    toolNames(step.tools, at);

    if (step.do !== undefined) {
      if (!own(actions, step.do)) {
        throw problem(at, `unknown action "${step.do}"`, "Register it in actions or fix the name.");
      }
      checkWith(at, step.do, actions[step.do].parameters, step.with);
      edge(i, step.onFail, at, "onFail");
    }
    if (typeof step.wait === "string") {
      duration(step.wait, at, "wait");
    } else if (step.wait !== undefined) {
      if (!own(events, step.wait.event)) {
        throw problem(at, `unknown event "${step.wait.event}" in wait`, "Register it in events or fix the name.");
      }
      duration(step.wait.upTo, at, "wait.upTo");
    }
    if (step.if !== undefined) {
      pred(step.if, at, "if");
      if (thenTo !== undefined && thenTo <= i && step.else === undefined) {
        throw problem(
          at,
          `"if" jumps back to "${flow.steps[thenTo].id}" with no else`,
          "Add else so the false branch has somewhere to go.",
        );
      }
    }
  });

  return { warnings };
}

function matchesParam(def: ParamDef, value: unknown): boolean {
  if (def.type === "array") return Array.isArray(value) && value.every((item) => matches(def.items, item));
  return matches(def, value);
}

/** Strict: a string is not a number here. Enum membership is checked unless the string is a template. */
function matches(def: ScalarDef, value: unknown): boolean {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return false;
  const typeOk =
    def.type === "string"
      ? typeof value === "string"
      : def.type === "boolean"
        ? typeof value === "boolean"
        : typeof value === "number" && (def.type === "number" ? Number.isFinite(value) : Number.isInteger(value));
  if (!typeOk) return false;
  if (!def.enum || (typeof value === "string" && value.includes("{{"))) return true;
  return typeof value !== "boolean" && def.enum.includes(value);
}

/**
 * What a rejected value should have been and what it was. A value of the right type that is
 * not a listed one names the listed values: "must be a string, got string" would say nothing.
 */
function mismatch(def: ParamDef, value: unknown): { expected: string; got: string; fix: string } {
  const scalar = def.type === "array" ? def.items : def;
  const { enum: allowed, ...typeOnly } = scalar;
  const items = def.type === "array" && Array.isArray(value) ? value : [value];
  const off = allowed ? items.findIndex((item) => matches(typeOnly, item) && !matches(scalar, item)) : -1;
  if (!allowed || off === -1) {
    return { expected: describeDef(def), got: describe(value), fix: "Values are not coerced; write the right type." };
  }
  const list = (v: unknown) => JSON.stringify(v);
  return { expected: `one of ${allowed.map(list).join(", ")}`, got: list(items[off]), fix: "Use one of the listed values." };
}

function describe(value: unknown): string {
  return Array.isArray(value) ? "list" : value === null ? "null" : typeof value;
}

function describeDef(def: ParamDef): string {
  return def.type === "array" ? `a list of ${def.items.type}s` : `${article(def.type)} ${def.type}`;
}

/** "an integer", "a string". A vowel test rather than one hard-coded type, so a new type reads right for free. */
function article(type: string): string {
  return /^[aeiou]/.test(type) ? "an" : "a";
}

// ── flowSpecSchema ──────────────────────────────────────────────────────

const STRING: StructuredSchema = { type: "string" };
const NUMBER: StructuredSchema = { type: "number" };
const INTEGER: StructuredSchema = { type: "integer" };
const BOOLEAN: StructuredSchema = { type: "boolean" };
const NULL: StructuredSchema = { type: "null" };

/**
 * FlowSpec's JSON schema with this workspace's actions (each with its
 * parameter schema), events, conditions and field slugs as enums. Every
 * object is closed and every property required, null standing for "not set",
 * so Gemini accepts it as a response schema. Steps are an `anyOf` (the union
 * keyword both Gemini and OpenAI strict schemas accept; `oneOf` is not)
 * discriminated by `kind`, one `do` variant per action.
 *
 * Left out on purpose, because a model should not write them: `ui`, `tools`,
 * step-level `instructions` and `ask`, a mention trigger's `extract`, and the
 * `input` of `{ flow }`. A variant whose registry is empty is left out too
 * (no actions: no `do` step). Condition arguments are typed loosely (string,
 * number, boolean or list of strings) because conditions carry no argument
 * schema yet.
 */
export function flowSpecSchema(registries: Registries): StructuredSchema {
  const { fields, actions = {}, events = {}, conditions = {} } = registries;
  const slugs = Object.keys(fields);
  const eventNames = Object.keys(events);

  const slugList = slugs.length ? list(enumOf(slugs)) : undefined;
  const duration = { type: "string", description: "A number and a unit: 30s, 5m, 24h, 3d" };
  const condition = closed({
    equals: slugs.length
      ? orNull({ ...toWireSchema(fields, { nullable: true }), description: "Fields that must hold these values" })
      : undefined,
    known: slugList && orNull({ ...slugList, description: "Fields that must be known" }),
    silenced: orNull({ ...BOOLEAN, description: "Whether the host gate is closed" }),
    ...Object.fromEntries(
      Object.keys(conditions).map((name) => [
        name,
        union([STRING, NUMBER, BOOLEAN, list(STRING)], { nullable: true, description: `Argument for condition "${name}"` }),
      ]),
    ),
  });
  const nextBranches = [
    { type: "string", description: 'A step id, or "end"' },
    closed({ step: STRING, clear: slugList && orNull({ ...slugList, description: "Fields to forget before jumping" }) }),
    closed({ flow: { type: "string", description: "Another flow to start; this run ends" } }),
  ];
  const next = union(nextBranches);
  const nextOrNull = union(nextBranches, { nullable: true });
  const repeat = union(
    [enumOf(["once", "always"]), closed({ cooldown: duration })],
    { nullable: true, description: "How often a run may start: once per session or anchor, always, or after a cooldown" },
  );
  const triggerBase = { if: orNull(condition), repeat };
  const trigger = union([
    closed({ message: list(STRING, "What the lead asks for, one phrase each; [] = catch-all"), ...triggerBase }),
    closed({ mention: list(STRING, "What the lead mentions, one phrase each"), ...triggerBase }),
    closed({ silence: { ...duration, description: "How long the lead has been quiet" }, businessHours: orNull(BOOLEAN), ...triggerBase }),
    eventNames.length
      ? closed({ event: enumOf(eventNames), after: orNull(duration), businessHours: orNull(BOOLEAN), ...triggerBase })
      : undefined,
  ]);
  const branches = orNull(
    list(union([closed({ when: STRING, then: next }), closed({ if: condition, then: next })]), "Exits judged while the step asks"),
  );
  const stepBase = { id: STRING, label: orNull(STRING), then: nextOrNull };
  const step = union([
    closed({ ...stepBase, kind: enumOf(["prompt"]), prompt: { type: "string", description: "Guideline for the AI's next message" }, branches }),
    slugList &&
      closed({
        ...stepBase,
        kind: enumOf(["collect"]),
        collect: { ...slugList, description: "Fields the AI asks for until they are known" },
        prompt: orNull(STRING),
        maxAsks: orNull({ ...INTEGER, description: "Times a field may be asked before it is skipped; default 3" }),
        branches,
      }),
    closed({ ...stepBase, kind: enumOf(["say"]), say: { type: "string", description: "Sent verbatim" }, media: orNull(closed({ slug: STRING })), once: orNull(BOOLEAN) }),
    ...Object.entries(actions).map(([name, action]) =>
      closed({
        ...stepBase,
        kind: enumOf(["do"]),
        do: enumOf([name]),
        with: Object.keys(action.parameters).length ? paramsSchema(action.parameters) : undefined,
        onFail: nextOrNull,
      }),
    ),
    closed({
      ...stepBase,
      kind: enumOf(["wait"]),
      wait: { ...duration, description: "Park this long; then = time passed, else = the lead replied" },
      businessHours: orNull(BOOLEAN),
      else: nextOrNull,
      branches,
    }),
    eventNames.length
      ? closed({
          ...stepBase,
          kind: enumOf(["waitEvent"]),
          wait: closed({ event: enumOf(eventNames), upTo: orNull({ ...duration, description: "Give up after this long; default 30d" }) }),
          else: nextOrNull,
        })
      : undefined,
    closed({ ...stepBase, kind: enumOf(["if"]), if: condition, else: nextOrNull }),
  ]);
  const instruction = closed({
    kind: orNull(enumOf(["must", "never", "should"])),
    when: orNull(list(STRING, "When the rule applies, judged by the AI")),
    if: orNull(condition),
    prompt: STRING,
  });

  return closed({
    id: { type: "string", description: "Short slug, unique in the workspace" },
    name: STRING,
    description: orNull({ type: "string", description: "When this flow should be used; the AI reads it when routing" }),
    on: orNull(list(trigger, "What starts a run; null = started by hand")),
    anchor: orNull({ type: "string", description: "'session' (default) or a host anchor such as 'lead'" }),
    while: orNull({ ...condition, description: "The run ends when this stops holding" }),
    clearOnStart: slugList && orNull({ ...slugList, description: "Fields to forget when a run starts" }),
    steps: list(step, "In order; a run moves to the next step unless `then` says otherwise"),
    onEnd: orNull(enumOf(["end", "stay", "reset"], "After the last step: end the run, stay on the last talk step it took answering every message, or reset to the first")),
    instructions: orNull(list(instruction, "Rules that apply only inside this flow")),
  });
}

/**
 * An action's `with`: required parameters stay non-null so the model cannot
 * skip them; optional ones are listed as required-but-nullable, the envelope
 * style, so the object stays closed and fully required.
 */
function paramsSchema(params: ParamDefs): StructuredSchema {
  const wire = toWireSchema(params);
  const properties = wire.properties ?? {};
  for (const [name, def] of Object.entries(params)) {
    if (def.optional) properties[name] = orNull(properties[name]);
  }
  return { ...wire, properties, required: Object.keys(params) };
}

function enumOf(values: readonly string[], description?: string): StructuredSchema {
  return compact({ type: "string", enum: [...values], description });
}

function list(items: StructuredSchema, description?: string): StructuredSchema {
  return compact({ type: "array", items, description });
}

/** A closed object requiring every property it lists; `undefined` entries are left out. */
function closed(properties: Record<string, StructuredSchema | undefined>): StructuredSchema {
  const present: Record<string, StructuredSchema> = {};
  for (const [name, schema] of Object.entries(properties)) if (schema) present[name] = schema;
  return { type: "object", properties: present, required: Object.keys(present), additionalProperties: false };
}

function union(
  branches: Array<StructuredSchema | undefined>,
  options: { nullable?: boolean; description?: string } = {},
): StructuredSchema {
  const anyOf = branches.filter((branch): branch is StructuredSchema => branch !== undefined);
  return compact({ anyOf: options.nullable ? [...anyOf, NULL] : anyOf, description: options.description });
}

/** The same schema, also accepting null. Single-typed schemas only; unions take `{ nullable: true }`. */
function orNull(schema: StructuredSchema): StructuredSchema {
  return typeof schema.type === "string" ? { ...schema, type: [schema.type, "null"] } : { anyOf: [schema, NULL] };
}

// ── Shared helpers ──────────────────────────────────────────────────────

function problem(at: string, what: string, fix: string): FlowConfigurationError {
  return new FlowConfigurationError(`[FlowConfigurationError] ${at}: ${what}. ${fix}`);
}

function own(record: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

/** Drop `undefined` values so a spec carries only what was written. */
function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

/** `null` means "not set" on the way in from JSON; drop it everywhere. */
function stripNulls<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item: unknown) => stripNulls(item)) as T;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== null)
        .map(([k, v]) => [k, stripNulls(v)]),
    ) as T;
  }
  return value;
}
