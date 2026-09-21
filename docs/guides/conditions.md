---
title: "Conditions"
description: "if is a question your code answers for free; when is a question the model answers inside a model call."
type: guide
order: 2
---

# Conditions

Two words, two judges. `if` is a question your code answers. `when` is a question the model answers from what the customer just said.

The smallest condition is an `if` step:

```ts
import { falai, GeminiProvider } from "@falai/agent";

interface Ctx {
  lead: { tags: string[] };
}

const f = falai<Ctx>().fields({});

const agent = f.agent({
  name: "Ana",
  // Set GEMINI_API_KEY in your environment before running this.
  provider: new GeminiProvider({ apiKey: process.env.GEMINI_API_KEY ?? "", model: "gemini-2.5-flash" }),
  flows: [
    f.flow({
      id: "boas-vindas",
      name: "Boas-vindas",
      steps: [
        { id: "vip", if: ({ context }) => context.lead.tags.includes("vip"), then: "tapete", else: "oi" },
        { id: "tapete", say: "Bem-vindo de volta. Já avisei seu gerente de conta.", then: "end" },
        { id: "oi", say: "Oi. Posso ajudar em algo?" },
      ],
    }),
  ],
});

const r = await agent.turn({ sessionId: "s1", context: { lead: { tags: ["vip"] } }, start: { flow: "boas-vindas", key: "signup:1" } });
console.log(r.messages[0]?.text); // "Bem-vindo de volta. Já avisei seu gerente de conta."
console.log(r.llmCalls); // 0
```

Code answered the question, so the turn cost no model call.

## `if`: code, free

An `if` is a `Pred`: a function that returns a boolean, or the same thing written as JSON (a `ConditionSpec`). Both see the same context.

| `PredCtx` field | What it is |
|---|---|
| `context` | the host context passed to this `turn()` |
| `data` | the collected fields so far, `Partial<D>` |
| `input` | the run's input: an event payload, a start input, a mention's extract; `unknown` |
| `run` | the run being judged; absent only for an agent-level instruction while the idle speaker answers |
| `silenced` | the host's reason the assistant cannot speak now; absent when it can |
| `now` | the agent's clock |

### As a function

```ts fragment
if: ({ context, data, now }) => context.lead.owner === "ai" && data.nome !== undefined && now.getHours() < 18
```

A function is the most direct form. It cannot be stored: `toSpec` refuses a flow that carries one with a `FlowConfigurationError`. For a flow that lives in a database, write the JSON form.

### As JSON

A `ConditionSpec` is an object whose keys are conditions. Every listed key must hold. Three are built in:

| Key | Holds when | Example |
|---|---|---|
| `equals` | each listed field equals the given value | `{ equals: { confirmado: true } }` |
| `known` | each listed field has a value (not `undefined`, `null` or `''`) | `{ known: ['nome', 'empresa'] }` |
| `silenced` | `true`: the host said the assistant cannot speak; `false`: it can | `{ silenced: true }` |

Any other key names one of the agent's `conditions` and carries its argument:

```ts
import { falai, GeminiProvider } from "@falai/agent";

interface Ctx {
  lead: { tags: string[] };
}

const f = falai<Ctx>().fields({
  nome: { type: "string", ask: "Pergunte o nome." },
  confirmado: { type: "boolean", ask: "Resuma o que anotou e pergunte se está certo." },
});

const agent = f.agent({
  name: "Ana",
  provider: new GeminiProvider({ apiKey: process.env.GEMINI_API_KEY ?? "", model: "gemini-2.5-flash" }),
  conditions: {
    // Used by name in JSON: { tagsAny: ["vip", "parceiro"] }. The argument comes from JSON unchecked, so test it.
    tagsAny: f.condition((ctx, tags: string[]) => Array.isArray(tags) && tags.some((t) => ctx.context.lead.tags.includes(t))),
  },
  flows: [
    f.flow({
      id: "fechamento",
      name: "Fechamento",
      on: [{ message: ["quer fechar o contrato"], if: { tagsAny: ["vip", "parceiro"] } }],
      steps: [
        { id: "quem", collect: ["nome"] },
        { id: "confirma", collect: ["confirmado"] },
        { id: "ok", if: { equals: { confirmado: true } }, else: { step: "quem", clear: ["confirmado", "nome"] } },
        { id: "tchau", prompt: "Agradeça e diga que um vendedor continua daqui." },
      ],
    }),
  ],
});
```

`f.condition` gives the check its argument type; the JSON side stays a plain object. When the agent is built, `validateFlow` checks every JSON condition and throws `FlowConfigurationError` on the first problem:

- `equals` must be an object; each key must be a field; each value must have the field's exact type (`"3"` is not a number, nothing is coerced) and be in its `enum` unless it is a template such as `"{{context.plano}}"`.
- `known` must be a list of field slugs.
- `silenced` must be a boolean.
- Any other key must be a registered condition, or the error names it: `unknown condition "tagsAny"`.

Keys with an `undefined` value are skipped. An empty object `{}` always holds.

## `when`: judged by the model

A `when` is a sentence about the customer's latest message. It appears in two places:

- **A branch on a talk step.** The understand call answers it true or false while the step is asking. The first branch that holds moves the run. See [Branching](branching.md).
- **An instruction.** The sentence is rendered into the speak prompt for the model to apply itself: "when the customer is upset, apologise once". It is guidance, not a gate; code never evaluates it.

```ts
import { falai } from "@falai/agent";

const f = falai().fields({
  pedido: { type: "string", ask: "Pergunte o número do pedido." },
});

const suporte = f.flow({
  id: "suporte",
  name: "Suporte a pedidos",
  on: [{ message: ["problema com um pedido"] }],
  instructions: [{ kind: "must", when: "o cliente está irritado", prompt: "Peça desculpa uma vez e vá direto à solução." }],
  steps: [
    {
      id: "dados",
      collect: ["pedido"],
      branches: [{ when: "a pessoa pede para falar com um humano", then: { flow: "humano" } }],
    },
    { id: "resolve", prompt: "Explique o próximo passo para o pedido {{data.pedido}}." },
  ],
});
```

What a `when` costs: the understand call happens at most once per turn, and every `when` branch rides in it. When that call would not happen otherwise (a single message flow, nothing to extract, no mention flows), a `when` branch alone makes the turn spend it. An instruction's `when` costs nothing extra: it is text inside the speak prompt.

A `when` only makes sense where there is fresh customer text. Branches on a `wait` step are judged when the customer replies, by code only: an `if` branch there works, a `when` branch is listed by the type but never asked.

## Where each is allowed

| Place | `if` | `when` |
|---|---|---|
| Trigger (`on[].if`) | yes: the run starts only if it holds; also the flow's default `while` | no: the phrases in `message` and `mention` are the model's part |
| Flow `while` | yes: re-checked whenever the run moves | no |
| Branch on a talk step | yes, code | yes, the understand call |
| Branch on a `wait` step | yes, when the customer replies | never judged |
| `if` step | yes, required | no |
| Instruction (agent, flow or step) | yes: the instruction is dropped from the prompt when it fails | yes: rendered into the prompt |

## Which one to write

Ask where the answer already is.

- In `context`, `data` or the input: `if`. It is free and deterministic.
- In what the customer just said, and you need code to act on it: a `when` branch.
- In what the customer just said, and it is a yes or no you will keep: collect a boolean field with `extract: 'asked'` and gate on it with an `if` step. The speak envelope of that step fills the field; there is no extra call. The confirmation pattern in [Collection](../concepts/collection.md) is this.
- Both: a `when` branch on the step and an `if` on the flow. Each is judged by its own judge.

## JSON flows

A stored flow carries only the JSON form. `f.fromSpec` types it, and the agent checks the names when it is built:

```ts
import { falai, GeminiProvider } from "@falai/agent";
import type { FlowSpec } from "@falai/agent";

interface Ctx {
  lead: { stageId: string };
}

const f = falai<Ctx>().fields({});

const spec: FlowSpec = {
  id: "proposta",
  name: "Acompanhar proposta",
  on: [{ event: "stage_entered", after: "1h", if: { inStage: "proposta" } }],
  while: { inStage: "proposta" },
  steps: [{ id: "p", kind: "prompt", prompt: "Pergunte se a proposta chegou bem e se há dúvidas." }],
};

const agent = f.agent({
  name: "Ana",
  provider: new GeminiProvider({ apiKey: process.env.GEMINI_API_KEY ?? "", model: "gemini-2.5-flash" }),
  events: { stage_entered: f.event<{ stageId: string }>() },
  conditions: {
    inStage: f.condition((ctx, stageId: string) => ctx.context.lead.stageId === stageId),
  },
  flows: [f.fromSpec(spec)],
});
```

Remove `inStage` from `conditions` and `f.agent` throws `[FlowConfigurationError] flow "proposta": unknown condition "inStage" in while. Register it in conditions or use equals, known, silenced.` The flow's `while` is checked before its triggers, so that is the line you see first. More in [Flows from JSON](flows-from-json.md).

## Read next

- [Branching](branching.md): `when` and `if` branches, the `if` step, `clear`.
- [Flow control](flow-control.md): `while` and the premise check.
- [Actions, events and conditions reference](../reference/actions-events-conditions.md): `Condition`, `ConditionSpec`, `PredCtx`.
