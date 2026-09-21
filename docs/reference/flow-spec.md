---
title: "Flow spec"
description: "A Flow as JSON: flat steps with a kind, predicates in JSON form, and the functions that convert, validate and describe it to a model."
type: reference
order: 12
---

# Flow spec

A `FlowSpec` is a `Flow` written as plain JSON: the same object, with each step carrying a `kind` and every predicate in its JSON form (`ConditionSpec`). No functions anywhere, so you can store it in a database row, edit it in a form, and let a model write one. Four functions work on it: `fromSpec` turns it into a `Flow`, `toSpec` goes the other way, `validateFlow` checks that it can run, and `flowSpecSchema` describes it to a model that writes one.

Source: `src/core/FlowSpec.ts`, `src/core/Agent.ts`.

## Signature

```ts fragment
type StepKind = "prompt" | "collect" | "say" | "do" | "wait" | "waitEvent" | "if";

interface FlowSpec {
  id: string;
  name: string;
  description?: string;
  on?: TriggerSpec[];
  anchor?: string;
  while?: ConditionSpec;
  clearOnStart?: string[];
  steps: StepSpec[];
  onEnd?: "end" | "stay" | "reset";
  instructions?: InstructionSpec[];
  tools?: string[];
}

type StepSpec = StepBase &
  (
    | { kind: "prompt"; prompt: Template; ask?; maxAsks?; branches?: BranchSpec[]; tools?; instructions?: InstructionSpec[] }
    | { kind: "collect"; collect: string[]; prompt?: Template; ask?; maxAsks?; branches?: BranchSpec[]; tools?; instructions?: InstructionSpec[] }
    | { kind: "say"; say: Template; media?: { slug: string }; once?: boolean }
    | { kind: "do"; do: string; with?: Record<string, unknown>; onFail?: Next }
    | { kind: "wait"; wait: Duration; businessHours?: boolean; else?: Next; branches?: BranchSpec[] }
    | { kind: "waitEvent"; wait: { event: string; upTo?: Duration }; else?: Next }
    | { kind: "if"; if: ConditionSpec; else?: Next }
  );

type TriggerSpec = { repeat?: Repeat } & (
  | { message: string[]; if?: ConditionSpec }
  | { mention: string[]; extract?: ParamDefs; if?: ConditionSpec }
  | { silence: Duration; if?: ConditionSpec; businessHours?: boolean }
  | { event: string; if?: ConditionSpec; after?: Duration; businessHours?: boolean }
);

type BranchSpec = { then: Next } & ({ when: string } | { if: ConditionSpec });

type InstructionSpec = Omit<Instruction, "if"> & { if?: ConditionSpec };

/** What a flow's names resolve against. */
type Registries = Pick<AgentOptions, "fields" | "actions" | "events" | "conditions" | "tools">;

function fromSpec<C = unknown, D = InferData<FieldDefs>>(spec: FlowSpec): Flow<C, D>;
function toSpec<C, D>(flow: Flow<C, D>): FlowSpec;
function validateFlow<C, D>(input: Flow<C, D> | FlowSpec, registries: Registries): { warnings: string[] };
function flowSpecSchema(registries: Registries): StructuredSchema;
```

`f.fromSpec(spec)` is `fromSpec` with the toolkit's `C` and `D` filled in.

## FlowSpec fields

Every field means what it means on [Flow](./flow.md). The differences:

| Field | Spec type | Difference from `Flow` |
|---|---|---|
| `steps` | `StepSpec[]` | Each step carries `kind`. |
| `while` | `ConditionSpec` | JSON form only. |
| `on[].if` | `ConditionSpec` | JSON form only. |
| `instructions[].if` | `ConditionSpec` | JSON form only. |
| `steps[].branches[].if` | `ConditionSpec` | JSON form only. |
| `steps[].if` | `ConditionSpec` | JSON form only. |
| any optional field | may be `null` | `null` means "not set" on the way in; `fromSpec` drops it. |

## StepKind

| `kind` | Flow step | Rule |
|---|---|---|
| `prompt` | talk step with `prompt` alone | A guideline, nothing to collect. |
| `collect` | talk step with `collect` | Has a `collect` list, with or without a `prompt`. |
| `say` | `say` step | A fixed text. |
| `do` | `do` step | A host action. |
| `wait` | `wait: '5m'` | A duration. |
| `waitEvent` | `wait: { event }` | An event. |
| `if` | `if` step | A code fork. |

`fromSpec` drops `kind`; `toSpec` derives it from the step's shape by this table. A talk step with neither `prompt` nor `collect` makes `toSpec` throw.

## fromSpec

- Strips `null` from every optional value, at any depth.
- Removes `kind` from each step. Nothing else changes.
- Throws `FlowConfigurationError` when `steps` is not a list: `[FlowConfigurationError] flow "x": has no steps list. Write steps as a list, even an empty one.`
- Does **not** check names. The result is typed as a `Flow` but nothing is verified yet; `validateFlow` does that, and the agent runs it on every flow it is built with.

## toSpec

- Never writes `null` or `undefined`; a field that was not set is absent.
- Throws `FlowConfigurationError` on a function predicate anywhere (`while`, a trigger `if`, an instruction `if`, a branch `if`, an `if` step): `[FlowConfigurationError] flow "x", step "y" if: is a function, which cannot be stored as JSON. Write it as a condition ({ equals }, { known }, { silenced } or a named condition) to store this flow.`
- `toSpec(fromSpec(spec))` is `spec` with its `null`s dropped, and `spec` itself when it had none.

## validateFlow

`validateFlow(input, registries)` accepts a typed `Flow` or a `FlowSpec`. It throws `FlowConfigurationError` on the first problem that would break at run time and returns `{ warnings }` for what runs but probably not as you meant. The agent constructor calls it on every flow and logs each warning through the logger with an `[Agent]` prefix.

Every message has the form `[FlowConfigurationError] <where>: <what>. <fix>`, where `<where>` is `flow` (no id yet), `flow "id"`, `flow "id", trigger #n`, `flow "id", step #n` (step n has no id) or `flow "id", step "sid"`.

### Errors

| Family | Example of `<what>` | Fix in the message |
|---|---|---|
| No flow id | `has no id` | Give the flow a short unique id. |
| Steps missing | `has no steps list` | Write steps as a list, even an empty one. |
| Step without id | `has no id` (`<where>` is `flow "id", step #2`) | Give every step a unique id. |
| Reserved step id | `uses the reserved id "end"` | "end" ends the run; pick another id. |
| Duplicate step id | `duplicates an earlier step id` | Give each step its own id. |
| Triggers, no steps | `has triggers but no steps` | Add at least one step or remove `on`. |
| Unknown field | `unknown field "x" in collect` (also `ask`, `clearOnStart`, `then.clear`, `while.equals`, `if.known`, …) | Add it to the agent's fields or fix the slug. |
| Unknown tool | `unknown tool "x"` (flow or step `tools`) | Register it in the agent's tools or fix the name. |
| Unknown action | `unknown action "x"` | Register it in actions or fix the name. |
| Unknown event | `unknown event "x"` (trigger) or `unknown event "x" in wait` | Register it in events or fix the name. |
| Unknown condition | `unknown condition "x" in if` | Register it in conditions or use equals, known, silenced. |
| `equals` shape | `if.equals is not an object` | Write equals as { field: value }. |
| `equals` type | `if.equals gives "orcamento" a string, but the field is a number` | Write a number; values are not coerced. |
| `known` shape | `if.known is not a list` | Write known as [field, ...]. |
| `silenced` shape | `if.silenced is not a boolean` | Write true or false. |
| Bad duration | `wait has duration "5 min", which does not parse` (also `silence`, `after`, `repeat.cooldown`, `wait.upTo`) | Write a number and a unit: "30s", "5m", "24h" or "3d". |
| Dangling jump | `then points at step "x", which does not exist` (also `else`, `onFail`, `branches[n].then`) | Use an existing step id or "end". |
| Missing parameter | `action "notify" needs parameter "message"` | Add it to `with`. |
| Wrong parameter type | `parameter "tags" of action "add_tags" must be a list of string, got string` | Values are not coerced; write the right type. |
| Extra parameter | `action "notify" has no parameter "to"` | Remove it or fix the name. |
| Branch without a test | `branches[0] has neither when nor if` | Give the branch an AI condition (when) or a code one (if). |
| Backward `if` with no `else` | `"if" jumps back to "quem" with no else` | Add else so the false branch has somewhere to go. |

Parameter values are checked strictly: `"3"` is not a number, `3.5` is not an integer, and an `enum` must contain the value unless the string holds `{{`, because a template's value is only known at run time.

Two checks live in the agent constructor rather than in `validateFlow`: `flow "x" is declared twice` and `idle: unknown tool "x"`.

### Warnings

| Warning | Why |
|---|---|
| `flow "f", step "s": then jumps back to "quem" without clear; the fields collected since stay known and those steps skip. Add clear: [...] to re-ask them.` | A `then`, `else`, `onFail` or branch target points at the same or an earlier step and clears nothing, so a collect step it lands on is skipped with `code: 'already-known'`. |
| `flow "f", step "s": collects "nome", "empresa" with no prompt and no ask; the model has nothing to go on. Add a prompt or an ask per field.` | A collect step with no `prompt`, where no listed field has an `ask` on the step or on the agent. |

## flowSpecSchema

`flowSpecSchema(registries)` returns a `StructuredSchema` for `FlowSpec` with this agent's field slugs, actions (each with its parameter schema), events and conditions as enums. Pass it as `parameters.jsonSchema` of a provider call and the model can only write a flow that names things you have.

- Every object is closed (`additionalProperties: false`) and every property is required; `null` stands for "not set". Gemini accepts it as a response schema.
- Steps are an `anyOf` with one variant per `kind`, and one `do` variant per registered action. `anyOf` is the union keyword both Gemini and OpenAI strict schemas accept; `oneOf` is not.
- A variant whose registry is empty is left out: no actions, no `do` step; no events, no `event` trigger and no `waitEvent` step; no fields, no `collect` step.
- Condition arguments are typed loosely (string, number, boolean or list of strings) because a `Condition` carries no argument schema.
- Left out on purpose, so a model does not write them: `ui`, `tools`, step-level `instructions`, `ask`, a mention trigger's `extract`, and the `input` of `{ flow }`.

The schema shapes the answer; `validateFlow` checks it. Run it on every generated spec before it reaches an agent.

## Example

```ts
import { falai, FlowConfigurationError, flowSpecSchema, GeminiProvider, toSpec, validateFlow, type FlowSpec } from "@falai/agent";

const f = falai().fields({
  nome: { type: "string", ask: "Pergunte o nome." },
  empresa: { type: "string", ask: "Pergunte a empresa." },
});

// Everything a stored flow may name, registered once.
const registries = {
  fields: f.fields,
  actions: {
    notify: f.action({
      parameters: { recipient: { type: "string" }, message: { type: "string" } },
      run: (params) => {
        console.log(`[notify] ${params.recipient}: ${params.message}`);
        return { ok: true };
      },
    }),
    add_tags: f.action({
      parameters: { tags: { type: "array", items: { type: "string" } } },
      run: (params) => {
        console.log("[add_tags]", params.tags);
        return { ok: true };
      },
    }),
  },
};

// A flow typed in a chat and stored as a row: flat steps with a `kind`, no functions.
const concorrente: FlowSpec = {
  id: "concorrente",
  name: "Lead falou de concorrente",
  on: [{ mention: ["o lead cita ou compara com um concorrente"], extract: { trecho: { type: "string" } }, repeat: "once" }],
  steps: [
    { id: "tag", kind: "do", do: "add_tags", with: { tags: ["concorrente"] } },
    { id: "avisa", kind: "do", do: "notify", with: { recipient: "owner", message: '{{data.nome}} falou de concorrente: "{{input.trecho}}"' } },
  ],
};

// Validate on save. The error names the unknown field, action, event, condition or step.
console.log(validateFlow(concorrente, registries).warnings); // []
try {
  validateFlow({ ...concorrente, steps: [{ id: "x", kind: "do", do: "send_email", with: {} }] }, registries);
} catch (error) {
  if (error instanceof FlowConfigurationError) console.log(error.message);
  // [FlowConfigurationError] flow "concorrente", step "x": unknown action "send_email". Register it in actions or fix the name.
}

// The TypeScript form is the same object.
const triagem = f.flow({
  id: "triagem",
  name: "Triagem",
  on: [{ message: ["quer um orçamento"] }],
  steps: [
    { id: "quem", prompt: "Descubra quem é.", collect: ["nome", "empresa"] },
    { id: "avisa", do: "notify", with: { recipient: "owner", message: "Lead: {{data.nome}} ({{data.empresa}})" } },
  ],
});
console.log(toSpec(triagem).steps[0]); // { id: "quem", kind: "collect", prompt: "Descubra quem é.", collect: ["nome", "empresa"] }

// Let a model write one: the schema is the response schema of an ordinary generation call.
const provider = new GeminiProvider({ apiKey: process.env.GEMINI_API_KEY ?? "", model: "gemini-2.5-flash" });
const generated = await provider.generateMessage<undefined, FlowSpec>({
  prompt: "Write a flow, as JSON, for: 'quando o lead pedir para falar com uma pessoa, avise o dono e marque a tag humano'. Texts in Brazilian Portuguese.",
  history: [],
  context: undefined,
  parameters: { jsonSchema: flowSpecSchema(registries), schemaName: "flow" },
});
const spec = generated.structured;
if (!spec) throw new Error("The model returned no flow JSON. It usually ignored the schema or hit its token limit; check the raw response and ask again.");
validateFlow(spec, registries);

// Rows load like any other flow.
const agent = f.agent({ name: "Ana", provider, ...registries, flows: [triagem, f.fromSpec(concorrente), f.fromSpec(spec)] });
console.log(agent.options.flows?.map((flow) => flow.id));
```

## See also

- [Flows from JSON](../guides/flows-from-json.md): storing, editing and generating flows.
- [Flow](./flow.md), [Step](./step.md), [Trigger](./trigger.md), [Branches](./branches.md): the typed forms.
- [Actions, events, conditions](./actions-events-conditions.md): what the names resolve against, and `ConditionSpec`.
- [Errors](./errors.md): `FlowConfigurationError` and the message contract.
