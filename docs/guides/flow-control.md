---
title: "Flow control"
description: "Every way a run moves, and the outcome line each move writes."
type: guide
order: 4
---

# Flow control

A run walks its flow's steps in order. `then` changes where it goes next; `else` and `onFail` cover a step's other exit. That is the whole vocabulary.

```ts
import { falai, GeminiProvider } from "@falai/agent";

const f = falai().fields({});

const agent = f.agent({
  name: "Ana",
  // Set GEMINI_API_KEY in your environment before running this.
  provider: new GeminiProvider({ apiKey: process.env.GEMINI_API_KEY ?? "", model: "gemini-2.5-flash" }),
  flows: [
    f.flow({
      id: "aviso",
      name: "Aviso",
      steps: [
        { id: "a", say: "Oi. Aqui é da loja." },
        { id: "b", say: "Chegou o iPhone 17, pronta entrega.", then: "end" },
        // Only here to show that `then: 'end'` stops before it.
        { id: "c", say: "Este passo nunca sai." },
      ],
    }),
  ],
});

const r = await agent.turn({ sessionId: "s1", start: { flow: "aviso", key: "k1" } });
console.log(r.messages.map((m) => m.text)); // ["Oi. Aqui é da loja.", "Chegou o iPhone 17, pronta entrega."]
console.log(r.outcomes.map((o) => [o.stepId, o.next])); // [["a", undefined], ["b", "end"]]
console.log(r.ended[0]?.reason); // "end"
```

## Which exit a step takes

Every step has `then`. Without it, the run goes to the next step in the list; after the last step, `onEnd` decides. What "then" means depends on the kind:

| Step | `then` is taken when | Other exit |
|---|---|---|
| talk (`prompt`, `collect`) | its fields are known, or a `prompt` without `collect` has spoken once | `branches[].then` while it asks |
| `say` | right after the message is queued | none |
| `do` | the action returned `ok` or `skipped` | `onFail` when it returned `failed` |
| `wait: '2d'` | the time passed | `else` when the customer replied first; `branches[].then` on that reply |
| `wait: { event }` | the event came | `else` when `upTo` passed (default 30 days) |
| `if` | the predicate holds | `else` when it does not (default `'end'`) |

Each exit is a `Next`, and every outcome line records where it went in `next`.

## The four forms of `Next`

### A step id

```ts fragment
{ id: "sem-humanos", say: "Nossa equipe está fora agora.", then: "dados" }
```

Jumps to that step of the same flow. Entering a step mints a new visit, so the messages and actions it produces get new keys (`suporte#m1:dados:2`). The step must exist; `validateFlow` refuses the flow otherwise. Jumping backward to a collect step whose fields are known skips it (`code: 'already-known'`), which is why the next form exists.

### `{ step, clear }`

```ts
import { falai } from "@falai/agent";

const f = falai().fields({
  nome: { type: "string", ask: "Pergunte o nome." },
  confirmado: { type: "boolean", ask: "Resuma o que anotou e pergunte se está certo." },
});

const triagem = f.flow({
  id: "triagem",
  name: "Triagem",
  on: [{ message: ["quer saber como funciona"] }],
  steps: [
    { id: "quem", collect: ["nome"] },
    { id: "confirma", collect: ["confirmado"] },
    { id: "ok", if: { equals: { confirmado: true } }, else: { step: "quem", clear: ["confirmado", "nome"] } },
    { id: "tchau", prompt: "Agradeça e diga que um vendedor continua daqui." },
  ],
});
```

Deletes the listed fields from the collected data, then jumps. The steps that collect them ask again. Without `clear`, a backward edge logs a warning when the agent is built, because the run would skip straight past the steps you jumped to.

### `'end'`

Ends the run now. `onEnd` (below) says what the flow does about it. `'end'` is a reserved word: no step may use it as an id.

### `{ flow, input }`

```ts
import { falai, GeminiProvider } from "@falai/agent";

const f = falai().fields({
  nome: { type: "string", ask: "Pergunte o nome." },
});

const agent = f.agent({
  name: "Ana",
  provider: new GeminiProvider({ apiKey: process.env.GEMINI_API_KEY ?? "", model: "gemini-2.5-flash" }),
  actions: {
    send_template: f.action({
      parameters: { templateId: { type: "string" } },
      run: (params) => {
        console.log(`enviando ${params.templateId}`);
        return { ok: true, spoke: true };
      },
    }),
  },
  flows: [
    f.flow({
      id: "campanha",
      name: "Campanha",
      steps: [
        { id: "envio", do: "send_template", with: { templateId: "{{input.templateId}}" } },
        // The customer answered: hand the conversation to the flow named in the start input.
        { id: "espera", wait: "1d", else: { flow: "{{input.flowId}}" } },
        { id: "nudge", prompt: "Cutuque de leve: pergunte se a pessoa viu a mensagem." },
      ],
    }),
    f.flow({ id: "funil", name: "Funil", steps: [{ id: "q", collect: ["nome"] }] }),
  ],
});

const t1 = await agent.turn({ sessionId: "s1", start: { flow: "campanha", input: { templateId: "t1", flowId: "funil" }, key: "camp:1" } });
// The customer replies before the day is over:
const t2 = await agent.turn({ sessionId: "s1", session: t1.session, message: "vi sim, me conta mais", id: "m1" });
console.log(t2.ended.map((run) => [run.flowId, run.reason])); // [["campanha", "flow"]]
console.log(t2.started.map((s) => s.runId)); // ["funil#campanha#camp:1:espera:1"]
console.log(t2.session.runs[0]?.hop); // 1
```

Ends this run with `reason: 'flow'` and starts the other flow in the same turn. The child:

- has the id `<childFlowId>#<parentRunId>:<stepId>:<visit>` and `trigger.kind: 'flow'`;
- gets `input` if you pass it, otherwise the parent's `input`, so `{{input.x}}` keeps working;
- takes the floor and moves in this same turn; a talk step reached this way speaks now;
- has `hop` one higher than the parent. A chain deeper than 5 stops: the child is skipped with `code: 'hop-limit'`.
- repeats by default (`'always'`), so a flow may be chained into many times; its claim carries the parent's step key.

`flow` is a template: `{{input.flowId}}` resolves against the run's input and context. A flow id that does not exist lands in `skipped[]` with `code: 'flow-gone'`; a child flow with a live run for the same anchor is skipped with `code: 'already-running'`. This is how one flow hands the conversation to another: the last step of a qualifying flow can `then: { flow: 'agendamento' }`.

## `onEnd`: after the last step

| `onEnd` | What happens | `ended[].reason` |
|---|---|---|
| `'end'` (default) | the run ends; the session is idle | `'end'` |
| `'stay'` | the run goes back to the last talk step it took and answers every later message from there, with a new key each time; the steps after that talk step do not run again | none: the run does not end |
| `'reset'` | the run ends and a fresh run of the same flow starts at the first step, data kept, one hop deeper | `'reset'` |

```ts
import { falai } from "@falai/agent";

const f = falai().fields({});

// Every later question lands on the same step, with a new message key each time.
const faq = f.flow({
  id: "faq",
  name: "Dúvidas",
  on: [{ message: ["tem uma dúvida sobre o produto"] }],
  onEnd: "stay",
  steps: [{ id: "r", prompt: "Responda a dúvida com base no que sabe e pergunte se ficou claro." }],
});
```

The talk step does not have to be the last step, and it does not need anything left to collect. A flow that asks for the name, tells the team, and then keeps talking is `steps: [{ id: "quem", collect: ["nome"] }, { id: "avisa", do: "notify" }]` with `onEnd: "stay"`: `avisa` runs once, then `quem` answers every message, even though the name is known. A `say` or a `do` that returned `spoke: true` on the way to the end counts as the answer to that message, so the step waits for the next one. A flow with no talk step ends, as with `'end'`.

`'reset'` is a chain into the same flow, so it costs a hop: a flow with no talk step that resets forever stops at the hop cap instead of spinning.

## `while`: the run's premise

`while` is a code predicate re-checked every time the run is about to move, including right after it starts. When it stops holding, the run ends with `code: 'premise-changed'` and `reason: 'skipped'`, without speaking.

```ts
import { falai } from "@falai/agent";

interface Ctx {
  lead: { etapa: string };
}

const f = falai<Ctx>().fields({});

const proposta = f.flow({
  id: "proposta",
  name: "Acompanhar proposta",
  on: [{ event: "entrou_na_etapa", after: "1h", if: ({ context }) => context.lead.etapa === "proposta" }],
  // The run only makes sense while the deal is still here. Without `while`, the trigger's `if` is re-checked instead.
  while: ({ context }) => context.lead.etapa === "proposta",
  steps: [{ id: "fala", prompt: "Pergunte se a proposta chegou bem e se há dúvidas." }],
});
```

Without `while`, the trigger's `if` is the premise. The run holds while any trigger of the same kind would still fire. A flow started by hand or by a chain has no such trigger, so its premise always holds. A run a silence trigger started has one more premise on a wake: if the customer wrote since the run started, the run ends with `code: 'customer-replied'`.

## `onFail` on a `do` step

An action that returns `{ failed }` writes `code: 'action-failed'` and the run follows `onFail`. Without `onFail` the run continues as if the action had succeeded, so give a step that matters an `onFail`.

```ts
import { falai } from "@falai/agent";

const f = falai().fields({
  cep: { type: "string", ask: "Pergunte o CEP." },
  cidade: { type: "string" },
});

const entrega = f.flow({
  id: "entrega",
  name: "Prazo de entrega",
  on: [{ message: ["quer saber o prazo de entrega"] }],
  steps: [
    { id: "cep", collect: ["cep"] },
    { id: "cidade", do: "buscarCidade", with: { cep: "{{data.cep}}" }, onFail: "cep_errado" },
    { id: "prazo", prompt: "Informe o prazo de entrega para {{data.cidade}}.", then: "end" },
    { id: "cep_errado", prompt: "Diga que não achou o CEP e peça de novo.", then: { step: "cep", clear: ["cep"] } },
  ],
});
```

The action side of this, `ctx.set` included, is in [Actions and events](actions-and-events.md).

## The caps

- **50 steps per run per turn.** A run that moves 50 times without stopping to ask or wait ends with `code: 'step-loop'` and `reason: 'failed'`. Two `if` steps pointing at each other hit it.
- **Hop 5.** `{ flow }`, `onEnd: 'reset'` and `turn({ start, hop })` each add one; at 5 the start is skipped with `code: 'hop-limit'`.

## When the flow changed under a live run

Flows are read from the agent on every turn, so a run may wake up in a flow you have since edited:

- The flow is gone (disabled or removed): the run ends with `code: 'flow-gone'`.
- The step is gone: the run ends with `code: 'step-gone'`.

Keep the ids of talk steps stable when you edit a flow that has live runs.

## Every outcome line, in one place

| `code` | Written when |
|---|---|
| none, `next` set | a step finished normally and moved |
| `branch` | a branch fired on an asking step |
| `code: 'already-known'` | a collect step's fields were already known |
| `code: 'max-asks'` (`detail` = the field) | a field hit `maxAsks` and was given up |
| `code: 'already-sent'` | a `say` with `once: true` had already gone out |
| `code: 'another-reply'` | another run's `say` or spoke action answered this message |
| `code: 'silenced'` (`detail` = your reason) | a talk or `say` step was reached while the host had silenced the assistant |
| `code: 'action-skipped'` | a `do` returned `skipped` |
| `code: 'action-failed'` | a `do` returned `failed` or threw |
| `code: 'replied'`, `code: 'no-reply'`, `code: 'inline-delay'` | a timer `wait` ended by a reply, by the timer, or rode on the next message |
| `code: 'awaiting-event'`, `code: 'event-arrived'`, `code: 'no-event'` | an event `wait` parked, resumed, or timed out |
| `code: 'awaiting-trigger'` | an event trigger's `after` parked the new run |
| `code: 'premise-changed'` | `while` (or the trigger's `if`) stopped holding |
| `code: 'customer-replied'` | a silence run woke after the customer wrote |
| `code: 'flow-gone'`, `code: 'step-gone'` | the flow or step no longer exists |
| `code: 'step-loop'` | the 50-step cap |
| `code: 'action-deferred'`, with `until` set | a `do` returned `{ defer }` |
| `code: 'provider-unavailable'`, `code: 'provider-quota'` | the speak call failed and a wait may help; the step is parked under a retry wake |
| `code: 'provider-auth'`, `code: 'provider-context'`, `code: 'provider-invalid'` | the speak call failed and no wait can help; the run ends `failed` |
| `code: 'no-session'`, `code: 'duplicate-input'`, `code: 'stale-wake'`, `code: 'silence-broken'` | the input was a no-op; the turn returns `changed: false` |
| `code: 'unknown-field'`, `code: 'bad-value'`, `code: 'not-in-enum'` | an extracted value was dropped instead of written |

Trigger-level skips (`code: 'already-claimed'`, `code: 'cooldown'`, `code: 'already-running'`, `code: 'hop-limit'`) go to `skipped[]` instead. The full list with every field is in [Outcomes](../reference/outcomes.md).

## Coming from 3.x

Every position change is now a `then` or `else` on a step. A tool cannot move the run; an `if` step, a branch or a host `start` does that. Code that ran around a step is a `do` step at that position. The before-and-after is in [v3 → v4 migration](../migration/v3-to-v4.md#5-movement-then--else-replace-directives-and-hooks).

## Read next

- [Branching](branching.md): `when` and `if` branches on an asking step.
- [Runs and waits](../concepts/runs-and-waits.md): the floor, suspended runs, wakes and keys.
- [Step reference](../reference/step.md): every step kind and `Next`.
