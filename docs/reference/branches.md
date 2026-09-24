---
title: "Branches"
description: "The Branch type, when versus if, the order branches are judged in, where they are legal, and how the understand call names them."
type: reference
order: 6
---

# Branches

A branch is an early exit from a step that is waiting on the customer. A talk step asks; a wait step waits for a reply. While either one is parked, the customer's next message is judged against the step's `branches`, in order, and the first branch that holds sends the run to its `then`. `when` is a question the model answers; `if` is code and costs nothing.

## Signature

```ts fragment
type Branch<C = unknown, D = unknown> = { then: Next<D> } & (
  | { when: string }
  | { if: Pred<C, D> }
);
```

## Fields

| Field | Type | Default | Meaning |
|---|---|---|---|
| `when` | `string` | one of `when` or `if` is required | A yes-or-no question about the customer's message, in plain words: `'a pessoa pede para falar com um humano'`. The understand call answers it. A template: `{{data.x}}` and `{{context.x}}` are filled in. |
| `if` | `Pred<C, D>` | one of `when` or `if` is required | A function `(ctx) => boolean` or a `ConditionSpec` (`{ equals }`, `{ known }`, `{ silenced }`, or a registered condition by name). Judged by code. |
| `then` | `Next<D>` | required | Where the run goes when the branch holds: a step id, `'end'`, `{ step, clear }` or `{ flow, input }`. See [Step](step.md#next). |

## Behaviour

**On a talk step.** Branches are judged on a message turn, for the run that is asking, before the step speaks again:
1. The understand call receives every `when` branch of the asking step as a question and answers true or false. `if` branches never reach the model.
2. The framework walks `branches` in array order. An `if` branch holds when its predicate returns true; a `when` branch holds when the model answered true. The first one that holds wins.
3. The run leaves the step with the outcome `code: 'branch'` (kind `prompt` or `collect`, status `ok`, `next` naming the target) and follows `then` in the same turn. Fields the understand call extracted from the same message are written first, so `then` may land on a step that is already satisfied.
4. When no branch holds, the step continues as usual: pending fields are harvested and the step speaks again.

A `when` branch costs the understand call; when it is the only thing to judge, that is one model call the turn would not otherwise spend. An `if` branch is judged on every message turn even when no understand call happens. A suspended run that returns to asking during the turn, because the asker ended or moved on without a word, has its `if` branches judged before its step speaks; its `when` branches were not in the understand call, so they wait for the next message.

**On a wait step.** Only `if` branches are judged, and only when the customer writes before the time passes and the step has `else`. The first `if` branch that holds replaces `else` as the target (outcome `code: 'replied'`). A `when` branch on a wait step is never asked, because a reply to a wait step does not reach the understand call. When the wake fires, branches are not consulted: the run follows `then`, or `else` when the customer wrote after the wait was set.

**Where branches are legal.** The types allow `branches` on a talk step and on a duration wait step. `say`, `do`, `if` and event wait steps have none; a fork after those is an `if` step.

**Construction checks.** Every branch must have `when` or `if`, its `then` must point at an existing step, `'end'` or a flow, and an `if` predicate in JSON form must name known fields and registered conditions. A `then` that jumps backward without `clear` logs a warning: the fields collected since stay known, so those steps skip.

**How the understand call names them.** Each `when` branch is keyed `${runId}/${stepId}/${index}` inside the framework. Run ids carry `#` and `:`, which the providers' schemas reject in property names, so every branch reaches the envelope's `branches` section under a short alias such as `q1`, `q2`, and the prompt lists the question next to that alias. Flow ids and field slugs keep their own names when they are made of letters, digits, `_` and `-`, and get an `f` or `d` alias otherwise. The reply is mapped back before anything is judged; a key the framework did not send is dropped.

## Example

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
  provider: new GeminiProvider({ apiKey: process.env.GEMINI_API_KEY ?? "", model: "gemini-2.5-flash" }),
  flows: [
    f.flow({
      id: "suporte",
      name: "Suporte a pedidos",
      on: [{ message: ["problema com um pedido", "pedido atrasado ou errado"] }],
      steps: [
        {
          id: "dados",
          collect: ["pedido"],
          branches: [
            // judged first, by code, on every message while this step asks
            { if: ({ context }) => context.atendentesOnline === 0, then: "sem-humanos" },
            // judged by the understand call
            { when: "a pessoa pede para falar com um humano", then: { flow: "humano" } },
          ],
        },
        { id: "resolve", prompt: "Explique o próximo passo para o pedido {{data.pedido}}." },
        {
          id: "espera",
          wait: "2d",
          // the lead replied: hand over when someone is online, otherwise let the conversation run
          else: "end",
          branches: [{ if: ({ context }) => context.atendentesOnline > 0, then: { flow: "humano" } }],
        },
        { id: "lembra", prompt: "Pergunte se o problema foi resolvido.", then: "end" },
        { id: "sem-humanos", say: "Nossa equipe atende das 9h às 18h. Deixe o número do pedido aqui e alguém te responde assim que abrir.", then: "end" },
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

// Turn 1 starts `suporte`; `dados` asks for the order id. Branches are not judged yet: no run was asking.
const first = await agent.turn({ sessionId: "s1", context, message: "meu pedido veio errado", id: "m1" });

// Turn 2: `dados` is asking, so its branches are judged against this message.
const second = await agent.turn({ sessionId: "s1", session: first.session, context, message: "quero falar com uma pessoa", id: "m2" });
console.log(second.ended.map((run) => `${run.flowId} → ${run.reason}`)); // [ 'suporte → flow', 'humano → end' ] when the model answers the `when` with true
console.log(second.outcomes[0]?.code, second.messages[0]?.key); // 'branch', 'humano#suporte#m1:dados:1:aviso:1'
```

## See also

- [Branching](../guides/branching.md) for when to fork with a branch and when with an `if` step
- [Conditions](../guides/conditions.md) for `when` versus `if`
- [Step](step.md) for the talk and wait steps that carry branches
- [Pipeline](../concepts/pipeline.md) for what the understand call judges
