---
title: "Flows from JSON"
description: "Store flows as rows, let an editor draw them or a model write them: FlowSpec is the same object as a Flow, with no functions in it."
type: guide
order: 11
---

# Flows from JSON

A flow written as JSON is a `FlowSpec`. `f.fromSpec(spec)` turns it into a typed flow, and the agent checks it when it is built.

```ts
import { falai, GeminiProvider, type FlowSpec } from "@falai/agent";

const f = falai().fields({
  nome: { type: "string", ask: "Pergunte o nome." },
});

// A rule someone typed in a chat, stored as a row.
const concorrente: FlowSpec = {
  id: "concorrente",
  name: "Lead falou de concorrente",
  on: [{ mention: ["o lead cita um concorrente"] }],
  steps: [{ id: "tag", kind: "do", do: "add_tags", with: { tags: ["concorrente"] } }],
};

const agent = f.agent({
  name: "Ana",
  provider: new GeminiProvider({ apiKey: process.env.GEMINI_API_KEY ?? "", model: "gemini-2.5-flash" }),
  actions: {
    add_tags: f.action({ parameters: { tags: { type: "array", items: { type: "string" } } }, run: () => ({ ok: true }) }),
  },
  idle: { prompt: "Responda pela empresa, sem inventar preços." },
  flows: [f.fromSpec(concorrente)],
});

const r = await agent.turn({ sessionId: "demo", message: "a Acme cobra metade disso" });
console.log(r.started.map((s) => s.flowId)); // [ 'concorrente' ]
```

The customer mentions a competitor. The understand call detects it, the `do` step tags the customer beside the conversation, and the idle speaker answers. The row is the flow: nothing here behaves differently from a flow written in code.

## The JSON form

A `FlowSpec` is a `Flow` with two differences: every step is flat and carries a `kind`, and every predicate is in its JSON form (`ConditionSpec`). There are no functions anywhere, so it survives `JSON.stringify`, a database column and a model's output.

```ts fragment
interface FlowSpec {
  id: string;
  name: string;
  description?: string;
  on?: TriggerSpec[];          // Trigger with `if` as a ConditionSpec
  anchor?: string;
  while?: ConditionSpec;
  clearOnStart?: string[];
  steps: StepSpec[];           // flat, each with `kind`
  onEnd?: "end" | "stay" | "reset";
  instructions?: InstructionSpec[];  // Instruction with `if` as a ConditionSpec
  tools?: string[];
}

type StepKind = "prompt" | "collect" | "say" | "do" | "wait" | "waitEvent" | "if";
```

How each step maps, from `src/core/FlowSpec.ts`:

| In code | `kind` | Rule |
|---|---|---|
| `{ prompt }` | `prompt` | a guideline alone |
| `{ collect, prompt? }` | `collect` | whenever there is a `collect` list, with or without a prompt beside it |
| `{ say, media?, once? }` | `say` | |
| `{ do, with?, onFail? }` | `do` | |
| `{ wait: "2d", else?, branches?, businessHours? }` | `wait` | `wait` is a duration string |
| `{ wait: { event, upTo? }, else? }` | `waitEvent` | `wait` is an object |
| `{ if, else? }` | `if` | `if` must be a `ConditionSpec` |

Everything else on a step (`id`, `label`, `then`, `ui`, `ask`, `maxAsks`, `branches`, `tools`, `instructions`) keeps its name. A `ConditionSpec` is an object where every key must hold: `equals` (fields equal these values), `known` (these fields are known), `silenced` (the host gate is closed), and any other key names one of the agent's conditions with its argument. See [conditions](./conditions.md).

## `fromSpec` and `toSpec`

`fromSpec(spec)` drops the `kind` from each step and returns a `Flow`. It treats `null` as "not set" for every optional value, because the generation schema below says null where the type says optional. The types it returns are a promise, not a proof: the field slugs and the action names inside came out of storage as plain strings, and `validateFlow` is what checks them. Use `f.fromSpec` from a bound toolkit so `C` and `D` are filled in.

`toSpec(flow)` goes the other way and never writes `null`, so `toSpec(fromSpec(spec))` is `spec` with its nulls dropped. It throws `FlowConfigurationError` when the flow carries a function predicate, because a function cannot be stored:

```ts
import { falai, FlowConfigurationError, toSpec } from "@falai/agent";

const f = falai().fields({
  nome: { type: "string", ask: "Pergunte o nome." },
  confirmado: { type: "boolean", ask: "Pergunte se está tudo certo." },
});

const ok = f.flow({
  id: "triagem",
  name: "Triagem",
  on: [{ message: ["quer um orçamento"] }],
  steps: [
    { id: "quem", prompt: "Descubra quem é.", collect: ["nome"] },
    { id: "confirma", collect: ["confirmado"] },
    { id: "gate", if: { equals: { confirmado: true } }, else: { step: "quem", clear: ["confirmado"] } },
  ],
});
console.log(JSON.stringify(toSpec(ok).steps[0])); // {"id":"quem","kind":"collect","collect":["nome"],"prompt":"Descubra quem é."}

const notStorable = f.flow({
  id: "vip",
  name: "VIP",
  on: [{ message: ["quer atendimento vip"], if: ({ data }) => data.nome === "Ana" }],
  steps: [{ id: "p", prompt: "Dê boas-vindas." }],
});
try {
  toSpec(notStorable);
} catch (error) {
  if (error instanceof FlowConfigurationError) console.log(error.message);
  // [FlowConfigurationError] flow "vip", trigger #1 if: is a function, which cannot be stored as JSON. Write it as a condition …
}
```

## `validateFlow(spec, registries)`

`Registries` is the part of the agent's options a flow's names resolve against: `fields`, `actions`, `events`, `conditions`, `tools`. Run it when a row is saved, so the person who typed the rule sees the problem, not the customer. The agent runs it again on every flow at construction.

```ts
import { falai, FlowConfigurationError, validateFlow, type FlowSpec, type Registries } from "@falai/agent";

const f = falai().fields({
  nome: { type: "string", ask: "Pergunte o nome." },
});

const registries: Registries = {
  fields: f.fields,
  actions: {
    notify: f.action({ parameters: { recipient: { type: "string" }, message: { type: "string" } }, run: () => ({ ok: true }) }),
  },
};

const spec: FlowSpec = {
  id: "avisa",
  name: "Avisa o dono",
  on: [{ message: ["quer falar com uma pessoa"] }],
  steps: [
    { id: "quem", kind: "collect", collect: ["nome"] },
    { id: "n", kind: "do", do: "notify", with: { recipient: "owner", message: "{{data.nome}} quer falar com alguém" } },
  ],
};

console.log(validateFlow(spec, registries).warnings); // []

try {
  validateFlow({ ...spec, steps: [{ id: "x", kind: "do", do: "send_email", with: {} }] }, registries);
} catch (error) {
  if (error instanceof FlowConfigurationError) console.log(error.message);
  // [FlowConfigurationError] flow "avisa", step "x": unknown action "send_email". Register it in actions or fix the name.
}
```

It throws `FlowConfigurationError` on the first problem that would break at runtime:

- no flow id, no `steps` list, triggers with no steps
- a step with no id, the reserved id `"end"`, or a duplicate id
- an unknown field in `collect`, `ask`, `clearOnStart`, a `clear` list or an `equals`
- an `equals` value of the wrong type for its field (values are not coerced)
- an unknown action, or a `with` that misses a required parameter, gives one the wrong type, or names one the action does not have
- an unknown event in a trigger or a `wait`
- an unknown condition in any `if` or `while`; a malformed `equals`, `known` or `silenced`
- an unknown tool in `tools`
- a duration that does not parse, in `wait`, `upTo`, `silence`, `after` or `repeat.cooldown`
- a `then`, `else`, `onFail` or branch pointing at a step that does not exist
- a branch with neither `when` nor `if`
- an `if` step that jumps backward with no `else`

And it returns warnings for what runs but probably not as intended:

- a `then`, `else` or branch that jumps back to an earlier step without `clear`: the fields collected since stay known and those steps skip
- a `collect` step with no `prompt` and no `ask` on any of its fields: the model has nothing to go on

## Letting a model write a flow

`flowSpecSchema(registries)` is the JSON schema of a `FlowSpec` for this agent: field slugs, action names with their parameter schemas, event names and condition names are enums. Every object is closed and every property required, with `null` standing for "not set", so Gemini and OpenAI strict mode both accept it as a response schema. Steps are an `anyOf` discriminated by `kind`, one `do` variant per action.

Use it as the response schema of your own generation call, then validate. The schema shapes the answer; `validateFlow` proves it.

```ts
import { falai, flowSpecSchema, GeminiProvider, validateFlow, type FlowSpec, type Registries, type StructuredSchema } from "@falai/agent";

const f = falai().fields({
  nome: { type: "string", ask: "Pergunte o nome." },
});

const registries: Registries = {
  fields: f.fields,
  actions: {
    notify: f.action({ parameters: { recipient: { type: "string" }, message: { type: "string" } }, run: () => ({ ok: true }) }),
    add_tags: f.action({ parameters: { tags: { type: "array", items: { type: "string" } } }, run: () => ({ ok: true }) }),
  },
};

// Your call to a model, with any SDK. The schema is plain JSON Schema.
declare function generateJson<T>(prompt: string, schema: StructuredSchema): Promise<T>;

const spec = await generateJson<FlowSpec>(
  "Write a flow, as JSON, for this request: 'quando o lead pedir para falar com uma pessoa, avise o dono e marque a tag humano'. Write the texts in Brazilian Portuguese.",
  flowSpecSchema(registries),
);

const { warnings } = validateFlow(spec, registries); // throws FlowConfigurationError when the model wrote something the agent cannot run
console.log(spec.id, warnings);

const provider = new GeminiProvider({ apiKey: process.env.GEMINI_API_KEY ?? "", model: "gemini-2.5-flash" });
const agent = f.agent({ name: "Ana", provider, ...registries, flows: [f.fromSpec(spec)] });
console.log(agent.options.flows?.length); // 1
```

The agent's own provider serves as the generator too: `provider.generateMessage<undefined, FlowSpec>({ prompt, history: [], context: undefined, parameters: { jsonSchema: flowSpecSchema(registries), schemaName: "flow" } })` and read `.structured`, as `examples/09-flows-from-json.ts` does.

Left out of the schema on purpose, because a model should not write them: `ui`, `tools`, step-level `instructions` and `ask`, a mention trigger's `extract`, and the `input` of `{ flow }`. A variant with an empty registry is left out too: with no actions there is no `do` step, with no events no `event` trigger and no `waitEvent`. Condition arguments are typed loosely (string, number, boolean or list of strings) because conditions carry no argument schema.

## Rows into the agent

The agent is immutable: `f.agent({ flows })` reads the flows once. Load the rows, `f.fromSpec` each one, build the agent, and serve every session with that one instance. When a row changes, build a new agent. A row that no longer validates fails the build with the message above, which is the moment to show it in the editor rather than at the customer's next message.

A run in a stored session that points at a flow you removed does not crash: it ends with `code: 'flow-gone'`. See [outcomes](../reference/outcomes.md).

See [the flow spec reference](../reference/flow-spec.md) for every type, and [triggers](./triggers.md) for what a `mention` with `extract` can do.
