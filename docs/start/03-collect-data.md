---
title: "Collect data"
description: "Give Ana four fields, let them land in any order, cap how often she asks, and confirm before moving on."
type: tutorial
order: 3
---

# Collect data

Ana's job is to screen the customer: find out who is writing, from which company, how big the company is, and check that she got it right. That is four fields and five steps. The flow is now called `triagem`; everything else from the last page stays.

```ts
import { falai, GeminiProvider } from "@falai/agent";

const f = falai().fields({
  nome: { type: "string", ask: "Pergunte o nome da pessoa, sem tom de formulário." },
  empresa: { type: "string", ask: "Pergunte de qual empresa a pessoa fala." },
  tamanho: {
    type: "string",
    enum: ["1-10", "11-50", "51-200", "200+"],
    ask: "Pergunte quantas pessoas trabalham lá e ofereça as faixas.",
  },
  confirmado: { type: "boolean", ask: "Resuma em uma frase o que anotou e pergunte se está tudo certo." },
});

const agent = f.agent({
  name: "Ana",
  provider: new GeminiProvider({ apiKey: process.env.GEMINI_API_KEY ?? "", model: "gemini-2.5-flash" }),
  flows: [
    f.flow({
      id: "triagem",
      name: "Triagem",
      on: [{ message: [] }],
      steps: [
        { id: "quem", prompt: "Descubra quem é e de onde fala.", collect: ["nome", "empresa"] },
        { id: "porte", collect: ["tamanho"], maxAsks: 2 },
        { id: "confirma", collect: ["confirmado"] },
        { id: "ok", if: { equals: { confirmado: true } }, else: { step: "quem", clear: ["confirmado"] } },
        { id: "tchau", prompt: "Agradeça e diga que um vendedor continua daqui." },
      ],
    }),
  ],
});

const first = await agent.turn({ sessionId: "demo", message: "Oi, quero saber como funciona" });
console.log(first.messages[0]?.text); // Ana asks who she is talking to, and from which company

const second = await agent.turn({
  sessionId: "demo",
  session: first.session,
  message: "Sou a Bia, da Acme. Somos uns 30.",
});
console.log(second.session.data); // { nome: "Bia", empresa: "Acme", tamanho: "11-50" }
console.log(second.outcomes.map((o) => [o.stepId, o.status, o.code]));
// [ ["quem", "ok", undefined], ["porte", "skipped", "already-known"], ["confirma", "ok", undefined] ]
```

One message gave three fields, one of them belonging to a step Ana had not reached. `quem` finished, `porte` was skipped without a model call, and `confirma` spoke: Ana repeats what she noted and asks if it is right.

## Fields

Each field has a `type` (`string`, `number`, `integer` or `boolean`) and, optionally, an `ask`, an `enum` and a `description`. A field a step collects needs an `ask` or a step `prompt`, or the model has nothing to go on; a field a tool fills needs neither.

`tamanho` has an `enum`. The model sees the list and must pick from it; "somos uns 30" becomes `"11-50"`. A value outside the list is dropped, and `r.outcomes` gets a line saying `code: 'not-in-enum'`. Code enforces the list, not the prompt.

`confirmado` is a boolean. Booleans are read only from the reply to the step that asks for them, so a "sim" said at any other moment never confirms anything. More on this below.

## A step asks only for what is missing

Every turn, code computes what a talk step still needs:

> pending = `collect` − fields already known − fields asked `maxAsks` times

When a run enters a step with nothing pending, the step is skipped with no model call and the log says `code: 'already-known'`. That is why `porte` was skipped above: `tamanho` had landed one step early. The step that was asking (`quem`) and got its fields from the reply completes instead: its line is `ok`, no detail.

Known fields are never asked again and never read again. Once `nome` is `"Bia"`, no later message changes it unless a step clears it.

## maxAsks

A customer who will not answer must not block the flow. `maxAsks` on a step caps how many times each of its fields is asked; the default is 3. `porte` uses 2: after two replies without a size, the log says `code: 'max-asks'` with `tamanho` in `detail`, `tamanho` stays unknown, and the run moves on to `confirma`.

Read `r.outcomes` when something surprises you. Every skip and every drop is one line there, with a `code` you can switch on and an English `message` beside it. A skip carries the step id; a dropped value does not — it is read before any step runs.

## Confirmation

Confirmation is a field plus a fork:

```ts fragment
{ id: "confirma", collect: ["confirmado"] },
{ id: "ok", if: { equals: { confirmado: true } }, else: { step: "quem", clear: ["confirmado"] } },
```

`confirma` is a normal talk step: its `ask` tells Ana to repeat what she noted and ask if it is right. The reply lands in `confirmado` as `true` or `false`.

`ok` is an `if` step: code, no model call. `if` is a yes-or-no test on the data; `{ equals: { confirmado: true } }` is its JSON form. When it passes, the run takes `then`, which defaults to the next step (`tchau`). When it fails, the run takes `else`:

- `{ step: "quem", clear: ["confirmado"] }` forgets `confirmado` and jumps back to `quem`.
- `quem` and `porte` still have their fields, so they are skipped again, and `confirma` asks a second time.

To let the customer fix a value, clear it too. If "no" usually means the company is wrong, clear `empresa` as well, and only `empresa` is asked again:

```ts fragment
{ id: "ok", if: { equals: { confirmado: true } }, else: { step: "quem", clear: ["confirmado", "empresa"] } },
```

An `if` step with no `else` ends the run when the test fails. The test can also be a plain function: `if: ({ data }) => data.confirmado === true`. [Conditions](../guides/conditions.md) covers both forms.

## Why a boolean is safe here

Fields have an `extract` mode: `"anywhere"` (the default for strings and numbers) lets any message fill them, which is how "Somos uns 30" filled `tamanho` before `porte` asked. `"asked"` (the default for booleans) fills the field only from the reply to the step that lists it. So the customer can say "sim, pode ser" while answering `quem` and `confirmado` stays empty until `confirma` actually asks.

Set `extract` on a field to override either default.

## A step's own wording

A step may phrase a field its own way without changing the field:

```ts fragment
{ id: "porte", collect: ["tamanho"], maxAsks: 2, ask: { tamanho: "Pergunte quantas pessoas a {{data.empresa}} tem hoje." } },
```

`{{data.empresa}}` is filled in before the text reaches the model. The field's own `ask` stays the default for every other step.

A flow can also start clean: `clearOnStart: ["confirmado"]` on the flow forgets those fields every time a run starts, which matters once a flow can run more than once per session. [Collection](../concepts/collection.md) has the whole model.

Next: [Add tools](./04-add-tools.md) lets Ana look up a price and warns the seller when a customer is qualified.
