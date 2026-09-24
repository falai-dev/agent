---
title: "Branching"
description: "Leave a step early while it asks: a when branch the model judges, an if branch code judges, and the if step for a plain code fork."
type: guide
order: 3
---

# Branching

A branch is an early exit from a step that is asking. The model judges `when`; code judges `if`. The first branch that holds moves the run.

```ts
import { falai, GeminiProvider } from "@falai/agent";

interface Ctx {
  atendentesOnline: number;
}

const f = falai<Ctx>().fields({
  pedido: { type: "string", ask: "Pergunte o número do pedido." },
});

const agent = f.agent({
  name: "Léo",
  // Set GEMINI_API_KEY in your environment before running this.
  provider: new GeminiProvider({ apiKey: process.env.GEMINI_API_KEY ?? "", model: "gemini-2.5-flash" }),
  flows: [
    f.flow({
      id: "suporte",
      name: "Suporte a pedidos",
      on: [{ message: ["problema com um pedido"] }],
      steps: [
        {
          id: "dados",
          collect: ["pedido"],
          branches: [
            // The model answers this about the customer's next message.
            { when: "a pessoa pede para falar com um humano", then: { flow: "humano" } },
            // Code answers this. It costs nothing.
            { if: ({ context }) => context.atendentesOnline === 0, then: "fora" },
          ],
        },
        { id: "resolve", prompt: "Explique o próximo passo para o pedido {{data.pedido}}.", then: "end" },
        { id: "fora", say: "Nossa equipe está fora agora. Deixe o número do pedido que retornamos assim que alguém entrar." },
      ],
    }),
    f.flow({
      id: "humano",
      name: "Passar para um humano",
      steps: [{ id: "aviso", say: "Claro, vou chamar alguém da equipe. Um minuto." }],
    }),
  ],
});

const context: Ctx = { atendentesOnline: 2 };
const t1 = await agent.turn({ sessionId: "s1", context, message: "meu pedido veio errado", id: "m1" });
// t1: the step asks for the order number. No branch is judged yet: the step has to speak first.
const t2 = await agent.turn({ sessionId: "s1", context, session: t1.session, message: "quero falar com uma pessoa", id: "m2" });
console.log(t2.ended.map((run) => run.reason)); // ["flow", "end"]: the when branch fired and chained into "humano", which then ran to its end
console.log(t2.messages.map((m) => m.text)); // ["Claro, vou chamar alguém da equipe. Um minuto."]
```

## Where branches live

`branches` is allowed on two step kinds:

- A talk step that collects (`collect`, with or without a `prompt`). Both `when` and `if` branches work while it asks. A `prompt` step with no `collect` speaks once and moves on in the same turn, so its branches are only judged in the rare turn where it is still asking: the talk step an `onEnd: 'stay'` flow stays on, or a turn where another run answered the customer first.
- A timer `wait` step (`wait: '2d'`). Only `if` branches are judged there.

`say`, `do`, `if` and `wait: { event }` steps have no branches. A code fork between them is an `if` step.

## When a branch is judged

**On a talk step**, the branches are judged on the customer's next message, while the step is asking. Not when the step is first reached (it has to speak first), not on a wake, not on an event. In that turn:

1. The understand call answers every `when` branch of the asking step, true or false, alongside routing and extraction. The extracted fields land in the data.
2. The branches are checked in the order you wrote them. An `if` branch is evaluated by code with this turn's context and data; a `when` branch uses the model's answer. The first one that holds wins.
3. The step writes `code: 'branch'` and `next` to its outcome line, and the run follows the branch's `then` in the same turn. It does not speak again.

If no branch holds, the step carries on: it speaks again with what is still pending, or completes when its fields are known.

**On a `wait` step**, the branches are judged only when the customer replies while the run is parked, which is also when `else` applies. The first `if` branch that holds wins over `else`. A `wait` with no `else` ignores the reply, branches included. When the timer fires, branches are not consulted: the run takes `then`, or `else` if the customer wrote after the wait was set. The outcome line reads `code: 'replied'` or `code: 'no-reply'`.

```ts
import { falai } from "@falai/agent";

interface Ctx {
  lead: { owner: "ai" | "human" };
}

const f = falai<Ctx>().fields({
  nome: { type: "string", ask: "Pergunte o nome." },
});

const retomar = f.flow({
  id: "retomar",
  name: "Retomar quem sumiu",
  on: [{ silence: "24h" }],
  steps: [
    { id: "p1", prompt: "Retome a conversa de forma leve." },
    {
      id: "w1",
      wait: "2d",
      // The customer replied. If a human took over meanwhile, step aside quietly; otherwise thank them.
      branches: [{ if: ({ context }) => context.lead.owner === "human", then: "end" }],
      else: "obrigada",
    },
    { id: "p2", prompt: "Última tentativa, curta e sem pressão.", then: "end" },
    { id: "obrigada", prompt: "Agradeça a resposta e retome de onde parou." },
  ],
});
```

## `then`: where a branch goes

`then` is a `Next`, the same type every step uses:

| `then` | Effect |
|---|---|
| `'fora'` (any step id) | jump to that step of this flow |
| `'end'` | end the run; the flow's `onEnd` decides what happens next |
| `{ step: 'quem', clear: ['nome'] }` | forget those fields, then jump |
| `{ flow: 'humano', input? }` | end this run and start that flow; it takes the floor |

All four are covered in [Flow control](flow-control.md).

## The `if` step

When the question has nothing to do with the latest message, do not wait for one. An `if` step is a code fork that runs the moment the run reaches it, with zero model calls.

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
    // true: fall through to "tchau". false: forget the answer and ask again from "quem".
    { id: "ok", if: { equals: { confirmado: true } }, else: { step: "quem", clear: ["confirmado", "nome"] } },
    { id: "tchau", prompt: "Agradeça e diga que um vendedor continua daqui." },
  ],
});
```

`then` is taken when the predicate holds; it defaults to the next step. `else` is taken when it does not; it defaults to `'end'`. The outcome line is `{ kind: 'if', status: 'ok', next: 'quem' }`.

The `if` step is where a collected boolean becomes a decision. `confirmado` is a boolean, so it is harvested only from the reply to the step that asks for it (`extract: 'asked'`); a stray "sim" earlier in the conversation cannot open the gate. [Collection](../concepts/collection.md) has the rules.

## Backward edges and `clear`

Known fields are never asked twice. A branch or `else` that jumps back to a collect step whose fields are already known does not re-ask them: the step is skipped with `code: 'already-known'` and the run moves on. To ask again, clear the fields on the way: `{ step: 'quem', clear: ['nome'] }`.

`validateFlow` runs on every flow when the agent is built and logs a warning for a `then`, `else`, `onFail` or branch `then` that points backward without `clear`: `jumps back to "quem" without clear; the fields collected since stay known and those steps skip. Add clear: [...] to re-ask them.` An `if` step whose `then` points backward with no `else` is refused outright, because its false case would have nowhere to go.

A jump backward re-enters the step, which mints a new visit and a new message key (`triagem#m1:quem:2`). A run that moves 50 steps in one turn without stopping ends with `code: 'step-loop'`.

## What you get back

- `outcomes[]`: the asking step's line with `code: 'branch'` and `next` set to the step id, `end`, or `flow:<id>`.
- `ended[]`: when `then` was `'end'` (`reason: 'end'`) or `{ flow }` (`reason: 'flow'`).
- `started[]`: the chained run, when `then` was `{ flow }`.
- `messages[]`: whatever the run said after moving, in order.

## Read next

- [Conditions](conditions.md): what `if` and `when` see, in code and in JSON.
- [Flow control](flow-control.md): every form of `then`, `onEnd`, `while`, the caps.
- [Branches reference](../reference/branches.md): the `Branch` type.
