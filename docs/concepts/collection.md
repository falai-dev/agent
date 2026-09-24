---
title: "Field collection"
description: "Declare each field once, then let the two model calls fill it and the code decide what is still missing."
type: concept
order: 4
---

# Field collection

A field is one piece of data the conversation collects: a name, a company, a budget, a yes or no. You declare each field once, on the agent, with how to ask for it. A flow lists the fields it needs, and its steps say which to ask and when. The model asks and extracts. Code decides what is still missing.

## Declared once

```ts
import { falai } from "@falai/agent";

const f = falai().fields({
  nome: { type: "string", ask: "Pergunte o nome, sem tom de formulário." },
});
// `f` is the toolkit. `nome` is now a field any flow can collect.
```

Declare the rest the same way:

```ts
import { falai } from "@falai/agent";
import type { DataOf } from "@falai/agent";

const f = falai().fields({
  nome: { type: "string", ask: "Pergunte o nome de um jeito leve, sem tom de formulário." },
  tamanho: { type: "string", enum: ["1-10", "11-50", "51-200", "200+"], ask: "Pergunte quantas pessoas trabalham lá; ofereça as faixas." },
  orcamento: { type: "number", ask: "Pergunte a faixa de investimento, dizendo que é só para orientar." },
  confirmado: { type: "boolean", ask: "Resuma o que anotou e pergunte se está tudo certo." },
});

type Data = DataOf<typeof f>;
// { readonly nome: string; readonly tamanho: "1-10" | "11-50" | "51-200" | "200+"; readonly orcamento: number; readonly confirmado: boolean }
```

| Property | What it does |
|---|---|
| `type` | `'string'`, `'number'`, `'integer'` or `'boolean'`. Values are coerced to it on the way in. |
| `enum` | The allowed values. A value outside the list is dropped. It becomes a literal union in `Data`. |
| `label` | The name a person reads, in an editor or next to a collected value. The model never sees it. |
| `description` | What the field means, for the model. |
| `ask` | How the model should ask for it. A step may override it. |
| `extract` | Where a value may come from: `'anywhere'` or `'asked'`. The default depends on `type`, below. |

`f.fields()` binds the data type, so `collect`, `ask`, `clearOnStart`, `{ step, clear }`, `if: { equals }` and an action's `ctx.set()` are all checked against these field names at compile time. The collected values live in `session.data` as a `Partial<Data>`.

## A flow's data, a step's questions

A scheduling flow needs one set of fields and a triage flow another. The flow's `collect` lists the fields it needs. Each talk step's `collect` says which of them to ask now, in what order: one field, or several when the step's prompt asks them together.

```ts
import { falai } from "@falai/agent";

const f = falai().fields({
  nome: { type: "string", label: "Nome", ask: "Pergunte o nome." },
  dia: { type: "string", label: "Dia", ask: "Pergunte qual dia fica melhor." },
  orcamento: { type: "number", label: "Orçamento" },
});

const agenda = f.flow({
  id: "agenda",
  name: "Agendamento",
  on: [{ message: ["quer agendar uma visita"] }],
  collect: ["nome", "dia", "orcamento"],
  steps: [
    { id: "quem", collect: ["nome"], question: "Claro! Qual é o seu nome?" },
    { id: "quando", prompt: "Ofereça terça ou quinta.", collect: ["dia"] },
    { id: "fim", say: "Combinado, {{data.nome}}. Até {{data.dia}}." },
  ],
});

export { agenda };
```

No step asks for `orcamento`. It is still on the flow's list, so when the customer mentions a budget while this flow holds the conversation, the value is noted. A field on the list that only an answer can fill (`extract: 'asked'`, every boolean by default) and that no step asks can never be filled; `validateFlow` warns about it.

Step one asks with fixed text: `question`. Its first ask goes out word for word, with no model call. It goes out only when every field the step collects is still missing. If the customer's first message already gave the name, the step is skipped. A later ask is the model's own wording, so a customer who replies with a question gets an answer.

## Known and pending

A field is **known** when its value is not `undefined`, `null` or `''`. Anything else is unknown. There is no "asked but refused" state, only a count.

A talk step's **pending** fields are computed by code every time the step is reached or has spoken:

```text
pending = step.collect − known fields − fields asked maxAsks times      (in collect order)
```

Three things follow.

- Fields land in any order. When the first message says "sou a Ana da Zeta, somos 30", three fields become known at once, one of them belonging to a later step.
- A step with nothing pending is skipped with no model call: outcome `code: 'already-known'`. A run that was asking and finds its fields known on the next message logs `ok` and moves on.
- A step stays `asking` until its pending set is empty or a branch fires. There is no deadlock: `maxAsks` empties the set eventually.

## Where values come from

Four writers reach `session.data`. Two are the model, two are your code.

| Writer | Which fields | When |
|---|---|---|
| The understand call | Unknown fields with `extract: 'anywhere'` that the floor's flow or a candidate `message` flow lists, in its own `collect` or a talk step's. With nobody on the floor, also the catch-all's (`message: []`) | On a message, before runs move |
| The speak call | The speaking step's pending fields, whatever their `extract`, in the envelope `{ message, ...fields }` | When the step speaks |
| A tool's `data` | Whatever the tool returns | During a speak round, written as given |
| An action's `ctx.set(patch)` | Whatever the action writes | During a `do` step, written as given |

Values from the model are validated before they are written. Each dropped value leaves an outcome line instead of a write:

| Check | Outcome detail |
|---|---|
| The name is not one of the agent's fields | `code: 'unknown-field'` |
| The value does not fit the type | `code: 'bad-value'` |
| The value is not in `enum` | `code: 'not-in-enum'` |

Coercion is forgiving (`coerceField` in `src/utils/schema.ts`):

- `"30"` becomes the number 30; a comma is a decimal separator, so `"1,5"` is 1.5.
- An `integer` is truncated.
- A boolean reads `true`, `sim`, `yes`, `1` as true and `false`, `não`, `nao`, `no`, `0` as false.
- A number or boolean offered for a string is stringified.

## `extract`: anywhere or asked

`extract` says where a value may come from.

- `'anywhere'`: from any customer message, by the understand call, before the run moves. The default for `string`, `number` and `integer`.
- `'asked'`: only from the reply to the step that lists the field, by the speak envelope. The default for `boolean`, so a stray "sim" in an unrelated message never confirms anything.

The default is `extractMode` in `src/utils/schema.ts`: `def.extract ?? (def.type === 'boolean' ? 'asked' : 'anywhere')`. Set it when the default is wrong for you: a document number you want only when asked, or a boolean the customer often volunteers.

This split also decides which call spends tokens on what. On a message, the understand call lists every unknown `'anywhere'` field of the flows in play; the speak call lists only the current step's pending fields. A turn where everything the step needs is `'asked'` and no other flow is eligible skips the understand call entirely: one call for the whole turn (`tests/scenarios/s01-triagem.test.ts`, the correction test).

## `maxAsks`

`maxAsks` on a talk step is how many times a field may be asked before the step gives up on it. The default is 3 (`DEFAULT_MAX_ASKS` in `src/utils/schema.ts`).

`run.asked[field]` goes up by one each time the step speaks and the field is still unknown after that reply's own extraction. A field that reaches the ceiling drops out of the pending set. When the set is empty the step reports it and moves to `then`:

```text
{ kind: 'collect', status: 'skipped', code: 'max-asks', detail: 'orcamento' }
```

One line per field that ran out of asks, with the field's slug in `detail`. `maxAsks: 1` means "ask once, do not insist". The field stays unknown: a later step may still collect it, and a later run of the flow starts the count again, because `asked` lives on the run. A step's fixed `question` counts as one ask. `{ step, clear }` resets the count of the fields it clears, so a confirmation loop asks from scratch each round.

## Known fields are never re-extracted

Once a field is known it disappears from both calls: the understand call does not list it, the speak envelope does not carry it, and the prompt shows it under "Already known" with the instruction never to ask again. This keeps both calls small, and it means a correction cannot happen by itself. To let the customer change a value, clear it:

- `then: { step: 'quem', clear: ['confirmado', 'empresa'] }` clears the fields, then jumps. This is the idiom for a confirmation gate: a "no" clears the disputed field and re-asks it.
- `clearOnStart: ['confirmado']` on a flow clears the fields when a run starts, before this turn's extraction lands. This is the idiom for `repeat: 'always'` flows that must ask again.
- `ctx.set({ empresa: undefined })` from a `do` step.

`onEnd: 'reset'` keeps the data: the new run starts at step one with everything still known, so only the steps whose fields were cleared will ask.

```ts
import { falai } from "@falai/agent";

const f = falai().fields({
  nome: { type: "string", ask: "Pergunte o nome." },
  empresa: { type: "string", ask: "Pergunte de qual empresa a pessoa fala." },
  orcamento: { type: "number", ask: "Pergunte a faixa de investimento." },
  confirmado: { type: "boolean", ask: "Resuma o que anotou e pergunte se está tudo certo." },
});

const triagem = f.flow({
  id: "triagem",
  name: "Triagem",
  on: [{ message: ["quer saber como funciona"], repeat: "always" }],
  clearOnStart: ["confirmado"],
  steps: [
    { id: "quem", prompt: "Descubra quem é e de onde fala.", collect: ["nome", "empresa"] },
    { id: "grana", collect: ["orcamento"], ask: { orcamento: "Pergunte quanto {{data.empresa}} pensa em investir por mês." }, maxAsks: 2 },
    { id: "confirma", collect: ["confirmado"] },
    { id: "ok", if: { equals: { confirmado: true } }, else: { step: "quem", clear: ["confirmado", "empresa"] } },
    { id: "tchau", say: "Obrigada, {{data.nome}}. Um vendedor continua daqui." },
  ],
});

export { triagem };
```

## The wording

Three layers of text shape the question, from general to specific.

1. The field's `ask`: the default wording for that field everywhere.
2. The step's `ask: { orcamento: '…' }`: wins over the field's, for that step only.
3. The step's `prompt`: the guideline for the whole reply. Without one, the default is "Collect what is still missing below, in the flow of the conversation, one or two things per message."

A step's `question` skips all three for the first ask: it is the exact text the customer reads. Every later ask goes back to the three layers.

All four are templates: `{{data.x}}`, `{{context.x}}` and `{{input.x}}` are filled in before the model reads them. The model sees every pending field of the step with its wording, in collect order, and is told to ask at the pace the prompt sets and to take any value the customer's message already answers.

## What the provider sees

`toWireSchema` in `src/utils/schema.ts` is the only way a field definition reaches a provider. It keeps `type`, `description` and `enum` and strips `label`, `ask`, `extract` and `optional`: those are for the framework, not the model. The result is a closed JSON schema (`additionalProperties: false`). In both envelopes every property is required and nullable, so the model must answer each field with a value or `null`. A field name that is not a legal property name for the provider, or is spelled `message`, travels under an alias and is mapped back on the way out.

## Where next

- [Collect data](../start/03-collect-data.md): the same ideas as a tutorial.
- [Branching](../guides/branching.md): `when` and `if` branches on a talk step.
- [Fields](../reference/fields.md): `FieldDef`, `ScalarDef`, `DataOf`, `InferData`.
