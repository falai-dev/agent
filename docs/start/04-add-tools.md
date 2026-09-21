---
title: "Add tools"
description: "Give Ana a tool the model may call to answer a price question, and an action the flow runs to warn the seller."
type: tutorial
order: 4
---

# Add tools

Two kinds of code run during a conversation, and they answer different questions.

- A **tool** is a function the model may call while it speaks. The model decides, based on what the customer said. "Quanto custa?" → look up the price.
- An **action** is a function the flow runs at a fixed step. Code decides, every time a run gets there. Customer confirmed → warn the seller.

Ana gets one of each. The tool first: this is the agent from the last page with a price table added.

```ts
import { falai, GeminiProvider, type Tool } from "@falai/agent";

const precos: Record<string, number> = { "1-10": 190, "11-50": 490, "51-200": 1290, "200+": 2900 };

// A tool: the model calls it when the lead asks about price.
const tabelaDePrecos: Tool = {
  id: "tabela_de_precos",
  description: "Preço mensal do plano para uma faixa de tamanho de empresa.",
  parameters: {
    type: "object",
    properties: { tamanho: { type: "string", enum: ["1-10", "11-50", "51-200", "200+"] } },
    required: ["tamanho"],
  },
  handler: (args) => ({ value: { precoMensal: precos[String(args.tamanho)] ?? null, moeda: "BRL" } }),
};

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
  tools: [tabelaDePrecos],
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

const r = await agent.turn({ sessionId: "demo", message: "Oi! Quanto custa para uma empresa de 30 pessoas?" });
console.log(r.messages[0]?.text); // Ana gives the price for 11-50 people and asks who she is talking to
console.log(r.llmCalls); // 2 when the model called the tool once; 1 when it did not
```

## The tool

A tool is a plain object with the `Tool` shape:

| Field | What it is |
|---|---|
| `id` | The name the model calls it by. |
| `description` | When to use it. The model reads this to decide. |
| `parameters` | A JSON schema for the arguments. |
| `handler(args, ctx)` | Your function. Returns `{ value?, data? }`. |

`value` is what the model reads back. Return whatever helps it answer: an object, a string, a list. Undefined is fine too; the model then sees `{"ok":true}`.

`data` writes collected fields. A step ends when its fields are known, so a tool can finish a step. A CNPJ lookup that fills `empresa` looks like this:

```ts fragment
handler: async (args) => {
  const empresa = await buscaCnpj(String(args.cnpj));
  return { value: { razaoSocial: empresa.nome }, data: { empresa: empresa.nome } };
},
```

To have that `data` checked against Ana's fields, give the tool its two types. `Tool<undefined, Data>` says: no host context, because `falai()` was called without one, and `data` from Ana's field list. `DataOf` reads that list off the toolkit, so it follows every field you add:

```ts fragment
type Data = DataOf<typeof f>;

const tabelaDePrecos: Tool<undefined, Data> = { /* as above */ };
```

`ctx` carries `context`, `data` (what is known so far), `history`, `run` (when a run is speaking) and `now`. A tool cannot move the run to another step; movement belongs to the flow.

### Where the model may call it

`tools: [tabelaDePrecos]` on the agent offers the tool on every talk step. To narrow that, list tool ids on a step or on a flow:

```ts fragment
{ id: "quem", prompt: "Descubra quem é e de onde fala.", collect: ["nome", "empresa"], tools: ["tabela_de_precos"] },
```

A step's list wins over the flow's, and the flow's over "every agent tool". An id that is not registered on the agent fails when the agent is built.

### What it costs

Each round of tool calls is one more model call: it asks for the tool, your handler runs, the result goes back as history, and the model is asked again. `r.llmCalls` counts them all. `maxToolLoops` on the agent caps the rounds at 5 by default; after the cap the model is asked once more without tools, so a message always comes back. `maxToolLoops: 0` turns tools off.

`isReadOnly`, `isDestructive`, `validateInput` and `checkPermissions` are optional gates on the same object. [Tool](../reference/tool.md) lists them.

## The action

Now the other half: warn the seller once the customer confirmed. `f.action({ parameters, run })` builds an action, `actions` registers it under a name, and a `do` step calls it by that name. The tool from above slots in unchanged and is left out for space.

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

async function avisarVendedor(texto: string): Promise<void> {
  console.log("[vendedor]", texto); // your Slack, e-mail or CRM call goes here
}

const avisar_vendedor = f.action({
  description: "Manda um resumo do lead para o vendedor.",
  parameters: { mensagem: { type: "string" } },
  run: async ({ mensagem }) => {
    await avisarVendedor(mensagem);
    return { ok: true };
  },
});

const agent = f.agent({
  name: "Ana",
  provider: new GeminiProvider({ apiKey: process.env.GEMINI_API_KEY ?? "", model: "gemini-2.5-flash" }),
  actions: { avisar_vendedor },
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
        {
          id: "avisa",
          do: "avisar_vendedor",
          with: { mensagem: "Lead qualificado: {{data.nome}} ({{data.empresa}}), {{data.tamanho}} pessoas." },
        },
        { id: "tchau", prompt: "Agradeça e diga que um vendedor continua daqui." },
      ],
    }),
  ],
});
```

`parameters` use the same `type`, `enum` and `description` as fields (plus `optional: true`), and `run` receives them already typed: `mensagem` is a `string` above, nothing to check.

`with` fills the parameters. `{{data.x}}`, `{{context.x}}` and `{{input.x}}` are replaced before the action runs. A placeholder whose value is unknown stays as written, so a skipped `tamanho` reaches the seller as `{{data.tamanho}}`. Word the message without it, or fork first with an `if` step on `{ known: ["tamanho"] }`. A `do` step never talks to the model: zero calls.

The name and the parameters are checked when the agent is built. An unknown action, or a `with` missing a required parameter, throws `FlowConfigurationError` at startup with the step id and the fix.

### What `run` returns

| Return | What the run does next |
|---|---|
| `{ ok: true }` | Takes `then` (the next step by default). `detail` adds a note to the log. |
| `{ skipped: "motivo" }` | Takes `then`. The log says `code: 'action-skipped'`, `detail: 'motivo'`. |
| `{ failed: "motivo" }` | Takes the step's `onFail` (a step id, `'end'` or `{ flow }`, like `then`) when it has one, else `then`. The log says `code: 'action-failed'`, `detail: 'motivo'`. |
| `{ defer: "10m", detail: "..." }` | Parks the run and runs the action again when the wake fires, with the same key. |

A handler that throws counts as `failed` with the error's message.

### Run it twice, get it once

Actions run at least once, never exactly once: when a save loses a race, the same input is replayed and the action runs again. `ctx.key` is `${runId}:${stepId}:${visit}` and is the same on the replay. Make the handler idempotent, which means: store the key with the side effect, and skip a key you already handled. `ctx.set(patch)` writes collected fields from inside the action, and `ctx.silenced` tells you when Ana is not allowed to speak right now.

## Which one do I write?

| Question | Answer |
|---|---|
| Does the customer's wording decide whether it runs? | Tool. |
| Must it run every time a run reaches this point? | Action. |
| Does it only read (price, stock, a slot)? | Usually a tool. |
| Does it change something outside (CRM, tag, notify)? | Usually an action, so the flow decides when and code proves it ran. |
| Should its result move the run? | Action: `onFail`, `defer`. A tool cannot move the run. |

[Actions and events](../guides/actions-and-events.md) adds events, the other way the host talks to a flow.

Next: [Go to production](./05-go-to-production.md) puts Ana behind a real channel: a database, the save loop and timers.
