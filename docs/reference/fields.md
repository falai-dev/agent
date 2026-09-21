---
title: "Fields"
description: "How to declare a field, what ask and extract do, and how a value is checked before it reaches session.data."
type: reference
order: 5
---

# Fields

A field is one piece of data the agent collects, authored once on the agent. Steps name fields in `collect`; the model extracts values from what the customer says; the framework checks each value against the field's type and writes it to `session.data`. Fields are typed: `falai().fields(defs)` turns the definitions into the data type every `collect`, `clear`, `equals` and `ctx.set` is checked against.

## Signature

```ts fragment
type ScalarType = "string" | "number" | "integer" | "boolean";

interface ScalarDef<T extends ScalarType = ScalarType> {
  type: T;
  description?: string;
  enum?: readonly (string | number)[];
}

interface FieldDef<T extends ScalarType = ScalarType> extends ScalarDef<T> {
  ask?: string;
  extract?: "anywhere" | "asked";
}

type FieldDefs = Record<string, FieldDef>;

type InferData<F extends FieldDefs> = { [K in keyof F]: /* string | number | boolean, or the enum's literal union */ };
type DataOf<T extends { fields: FieldDefs }> = InferData<T["fields"]>;
```

## FieldDef

| Field | Type | Default | Meaning |
|---|---|---|---|
| `type` | `ScalarType` | required | `'string'`, `'number'`, `'integer'` or `'boolean'`. |
| `enum` | `readonly (string \| number)[]` | none | The allowed values. A value outside the list is dropped (`code: 'not-in-enum'`). In the data type the field becomes the literal union. |
| `description` | `string` | none | What the field is. Sent to the model with the field's type and options. |
| `ask` | `string` | none | How the model should ask for it. Sent to the speak call as "How to ask" while the field is pending. A talk step's own `ask` overrides it. A template: `{{data.x}}` and `{{context.x}}` are filled in. |
| `extract` | `'anywhere' \| 'asked'` | `'anywhere'` for string, number and integer; `'asked'` for boolean | Where a value may be taken from. `'anywhere'`: any message from the customer, whether or not the field was asked. `'asked'`: only the reply to the step that lists the field, so a stray "sim" never confirms anything. |

The slug (the key in `fields`) is the name in `session.data`, in `collect`, in templates (`{{data.nome}}`) and in the model's envelope. Use letters, digits, `_` and `-`; any other character makes the framework send the field under an alias and map it back.

## DataOf and InferData

`InferData<F>` maps each slug to its value type: `string`, `number` (for `number` and `integer`), `boolean`, or the `enum` list as a literal union. Every key is required in `Data`; the session stores `Partial<Data>`, because fields land one at a time.

`DataOf<typeof f>` is the shortcut for a bound toolkit: `type Data = DataOf<typeof f>`.

Properties are readonly — `fields()` takes the definitions as a `const` type, so the data type is read-only; the framework writes `session.data`, your code reads it.

## Behaviour

**Known.** A field is known when its value is not `undefined`, `null` or `''`. Known fields are never asked again and never re-extracted; both calls list them under "Already known".

**Which call extracts what.** The understand call, on a message turn, extracts every unknown `'anywhere'` field named in a `collect` of the flow holding the floor and of every eligible message flow, in one envelope. The speak call extracts the pending fields of the step that speaks, `'asked'` ones included, in the same call that phrases the reply. Tools write `data` and actions call `ctx.set()`; those values are written as given, with no check.

**Coercion.** A raw value from the model goes through `coerceField(def, raw)` before it is written:

| Field type | Accepted | Result |
|---|---|---|
| `string` | a string; a number or boolean | as is; converted with `String()` |
| `number` | a finite number; a numeric string. `"1500,50"` becomes `1500.5` (one comma is read as the decimal mark); `"1.500,50"` is dropped | the number |
| `integer` | as `number` | truncated toward zero |
| `boolean` | a boolean; `"true"`, `"sim"`, `"yes"`, `"1"`; `"false"`, `"não"`, `"nao"`, `"no"`, `"0"` (case-insensitive, trimmed) | the boolean |

Anything else is dropped with the outcome line `code: 'bad-value'`. A value outside `enum` is dropped with `code: 'not-in-enum'`. A value for a slug that is not a field is dropped with `code: 'unknown-field'`. Dropped values leave a `collect` outcome with status `skipped` and no run id; the field stays pending and is asked again.

**What reaches the provider.** `toWireSchema(defs)` turns definitions into the JSON schema the model must fill: a closed object (`additionalProperties: false`) with one property per field carrying `type`, `description` and `enum`, and nothing else. `ask` and `extract` are stripped; they steer the framework, not the schema. In the envelope style used by both calls every property is required and nullable (`type: [type, 'null']`), so the model answers `null` for what the customer did not give. The prompt describes each field once more in words (`nome (string) [a | b]: description`) and, in the speak call, adds the pending field's "How to ask".

**Clearing.** `{ step, clear: ['x'] }` on a `then`/`else`/branch and `clearOnStart` on a flow delete the field from `session.data`, so the next step that collects it asks again. `maxAsks` on a talk step (default 3) is the other way a field stops being pending: it is skipped for that run with `code: 'max-asks'`, the field in `detail`.

**Action parameters** use the sibling type `ParamDef`: a `ScalarDef` plus `optional?: true`, or `{ type: 'array', items: ScalarDef }`. `InferParams<P>` gives the `with` shape. They share `toWireSchema` and the same strictness at construction. See [Actions, events and conditions](actions-events-conditions.md).

## Example

```ts
import { falai, GeminiProvider, type DataOf } from "@falai/agent";

const f = falai().fields({
  nome: { type: "string", ask: "Pergunte o nome de um jeito leve, sem tom de formulário." },
  tamanho: {
    type: "string",
    enum: ["1-10", "11-50", "51-200", "200+"],
    ask: "Pergunte quantas pessoas trabalham lá e ofereça as faixas.",
  },
  orcamento: { type: "number", description: "Valor mensal em reais.", ask: "Pergunte a faixa de investimento, só para orientar." },
  // boolean: extract defaults to 'asked', so only the reply to `confirma` can set it
  confirmado: { type: "boolean", ask: "Resuma em uma frase o que anotou e pergunte se está tudo certo." },
});

type Data = DataOf<typeof f>;
// { readonly nome: string; readonly tamanho: "1-10" | "11-50" | "51-200" | "200+"; readonly orcamento: number; readonly confirmado: boolean }

const agent = f.agent({
  name: "Ana",
  provider: new GeminiProvider({ apiKey: process.env.GEMINI_API_KEY ?? "", model: "gemini-2.5-flash" }),
  flows: [
    f.flow({
      id: "triagem",
      name: "Triagem",
      on: [{ message: [] }],
      steps: [
        { id: "quem", prompt: "Descubra quem é e de onde fala.", collect: ["nome", "tamanho", "orcamento"] },
        { id: "confirma", collect: ["confirmado"] },
        { id: "ok", if: { equals: { confirmado: true } }, else: { step: "quem", clear: ["confirmado"] } },
        { id: "tchau", say: "Obrigada, {{data.nome}}. Um vendedor continua daqui." },
      ],
    }),
  ],
});

const r = await agent.turn({ sessionId: "s1", message: "Oi, sou a Ana, somos 30 pessoas" });
const data: Partial<Data> = r.session.data;
console.log(data); // { nome: 'Ana', tamanho: '11-50' } once the model has read them; `orcamento` is still pending
```

## See also

- [Collection](../concepts/collection.md) for pending fields, `maxAsks` and what each call extracts
- [Step](step.md) for `collect`, `ask` and `maxAsks` on a talk step
- [Actions, events and conditions](actions-events-conditions.md) for `ParamDef` and `InferParams`
- [Outcomes](outcomes.md) for the dropped-value lines
