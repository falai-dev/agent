---
title: "Actions and events"
description: "Actions are code a do step runs; events are things your program reports with turn({ event }) so flows start or stop waiting."
type: guide
order: 5
---

# Actions and events

An action is a function of yours that a flow runs in a `do` step. An event is a fact your program reports to the agent, so a flow can start on it or stop waiting for it. Both are registered on the agent once and named in flows as strings.

```ts
import { falai, GeminiProvider } from "@falai/agent";

const f = falai().fields({});

const agent = f.agent({
  name: "Ana",
  // Set GEMINI_API_KEY in your environment before running this.
  provider: new GeminiProvider({ apiKey: process.env.GEMINI_API_KEY ?? "", model: "gemini-2.5-flash" }),
  actions: {
    avisar: f.action({
      parameters: { para: { type: "string" }, texto: { type: "string" } },
      run: (params) => {
        console.log(`${params.para}: ${params.texto}`);
        return { ok: true };
      },
    }),
  },
  flows: [
    f.flow({
      id: "cadastro",
      name: "Cadastro",
      steps: [{ id: "n", do: "avisar", with: { para: "vendedor", texto: "Novo cadastro: {{input.email}}" } }],
    }),
  ],
});

const r = await agent.turn({ sessionId: "s1", start: { flow: "cadastro", input: { email: "ana@zeta.com" }, key: "signup:1" } });
console.log(r.outcomes[0]?.key, r.outcomes[0]?.status); // "cadastro#signup:1:n:1", "ok"
console.log(r.llmCalls); // 0
```

## Define an action

`f.action({ description?, parameters, run })`.

`parameters` is a `ParamDefs`: one entry per parameter, each `{ type: 'string' | 'number' | 'integer' | 'boolean', enum?, description?, optional? }` or `{ type: 'array', items: <scalar>, optional? }`. Every parameter is required unless `optional: true`. `run` receives `params` typed from them.

A `do` step fills the parameters with `with`. When the agent is built, `validateFlow` checks every `with` against the action and throws `FlowConfigurationError` when:

- a required parameter is missing: `action "avisar" needs parameter "texto"`;
- a value has the wrong type; nothing is coerced, so `"3"` is not a number. A template such as `"{{data.cep}}"` is a string, so templates can only fill string parameters (and the items of a string array);
- `with` names a parameter the action does not have.

Templates in `with` are rendered right before `run` is called, against `data` (collected fields), `context` (this turn's host context) and `input` (the run's input). An unknown path keeps its `{{...}}`, so a typo stays visible. A blank one drops out, and the space or comma it left behind goes with it — an empty string, or a path that walks through a `null` such as `{{context.lead.name}}` when there is no lead.

## What `run` sees

The second argument is an `ActionCtx`:

| Field | What it is |
|---|---|
| `context` | the host context of this `turn()` |
| `data` | the collected fields so far |
| `input` | the run's input: event payload, start input or mention extract |
| `run` | the run, with `id`, `flowId`, `stepId`, `visits` and more |
| `key` | `<runId>:<stepId>:<visit>`; the same on a replay of the same input |
| `dedupeKey` | `<flowId>:<anchor>:<nonce>`; shared across a customer's sessions |
| `silenced` | the host's reason the assistant cannot speak now; absent when it can |
| `now` | the agent's clock |
| `set(patch)` | write collected fields from inside the action |

## What `run` returns

`run` returns an `ActionResult`, or a promise of one. Each variant tells the runner something different:

| Return | Outcome line | What the run does next |
|---|---|---|
| `{ ok: true, detail?, spoke? }` | `status: 'ok'`, `detail` as given | follows `then` |
| `{ skipped: 'motivo' }` | `status: 'skipped'`, `code: 'action-skipped'`, `detail: 'motivo'` | follows `then` |
| `{ failed: 'motivo' }` | `status: 'failed'`, `code: 'action-failed'`, `detail: 'motivo'` | follows `onFail`, or `then` when there is none |
| `{ defer: '24h', detail: 'motivo' }` | `status: 'deferred'`, `detail` as given, `until` set | parks; a wake runs the same step again with the same `key` |

A `run` that throws is treated as `{ failed: error.message }`.

```ts
import { falai } from "@falai/agent";

const f = falai().fields({});

declare const canal: { enviar(templateId: string, variaveis: string[]): Promise<void> };
const creditos = { restantes: 0 };

const enviarTemplate = f.action({
  description: "Envia um template aprovado pelo canal.",
  parameters: {
    templateId: { type: "string" },
    variaveis: { type: "array", items: { type: "string" }, optional: true },
  },
  run: async (params, ctx) => {
    if (ctx.silenced) return { skipped: "assistente silenciado" };
    if (creditos.restantes === 0) return { defer: "24h", detail: "sem créditos" };
    try {
      await canal.enviar(params.templateId, params.variaveis ?? []);
    } catch (error) {
      return { failed: error instanceof Error ? error.message : String(error) };
    }
    return { ok: true, spoke: true, detail: "template enviado" };
  },
});
```

**`defer`** is for "not now": no credits, a rate limit, a window that is closed. The run parks under the wake key `<runId>:<stepId>:<atMs>` and the host schedules it like any other wake. When it fires, the step runs again at the same visit, so `ctx.key` is the same. The outcome carries your `detail` and the `until` time. A `defer` that is not a duration (`"2 minutos"`) cannot park anything, so the step fails instead, with `code: 'action-failed'` and a `detail` that quotes the value; the handler has already run, so throwing would make every replay repeat it.

**`spoke: true`** says the action itself sent something to the customer, a template through the channel for example. The framework then treats the turn as the assistant having spoken: `lastAssistantAt` is stamped and silence flows are armed. On a message turn, it also means another run's talk step does not speak (`code: 'another-reply'`): one answer per message.

## Idempotency: `key` and `dedupeKey`

Actions run inside the turn, before the host saves the session. If the save fails (`SessionConflictError`) the host replays the same input, and the action runs again. So an action runs at least once, and it must be safe to run twice.

`ctx.key` is the handle. A replay of the same input mints the same key; a revisit of the step mints a new one. Record it where you do the work:

```ts
import { falai } from "@falai/agent";

const f = falai().fields({});

const feitos = new Set<string>(); // in production: a unique index on the key

const notificar = f.action({
  parameters: { texto: { type: "string" } },
  run: (params, ctx) => {
    if (feitos.has(ctx.key)) return { ok: true, detail: "já enviado" };
    feitos.add(ctx.key);
    console.log(params.texto);
    return { ok: true };
  },
});
```

`ctx.dedupeKey` is coarser: `<flowId>:<anchor>:<nonce>`, where the nonce is empty for `repeat: 'once'` and cooldown flows. It is the same in every session of the same customer, so a welcome message anchored to the customer goes out once even when the customer writes on two channels. For `repeat: 'always'` flows the nonce is the trigger key, and the framework cannot make them exactly-once across sessions; the host's own index on `dedupeKey` can.

## Writing data from an action: `ctx.set`

An action may fill collected fields, typed against the agent's fields:

```ts
import { falai } from "@falai/agent";

const f = falai().fields({
  cep: { type: "string", ask: "Pergunte o CEP." },
  cidade: { type: "string" },
});

declare function viaCep(cep: string): Promise<string | undefined>;

const buscarCidade = f.action({
  parameters: { cep: { type: "string" } },
  run: async (params, ctx) => {
    const cidade = await viaCep(params.cep);
    if (!cidade) return { failed: `CEP ${params.cep} não encontrado` };
    ctx.set({ cidade });
    return { ok: true, detail: cidade };
  },
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

`cidade` has no `ask`, so no step ever asks for it; the action is the only writer. A field written by `set` is known from then on: a later collect step that lists it is skipped.

## Actions run while silenced

When the host passes `silenced: 'motivo'`, nothing is phrased and no model call is spent, but `do` steps still run. `ctx.silenced` carries the reason, so an action that talks to the customer can decide for itself, as `enviarTemplate` does above.

## Define an event

`f.event<Payload>({ direction? })` declares an event. Register it under `events`; flows name it in a trigger or in a `wait`. The agent refuses a flow that names an event it does not know.

```ts
import { falai, GeminiProvider } from "@falai/agent";

const f = falai().fields({});

const events = {
  // No direction: nothing about the conversation changes; flows may start or stop waiting.
  reuniao_marcada: f.event<{ quando: string }>(),
  // The customer did something that counts as speaking: a reaction, a button tap.
  reacao: f.event<{ emoji: string }>({ direction: "inbound" }),
  // A person on your team wrote to the customer: counts as the assistant speaking.
  mensagem_humana: f.event<{ texto: string }>({ direction: "outbound" }),
};

const agent = f.agent({
  name: "Ana",
  provider: new GeminiProvider({ apiKey: process.env.GEMINI_API_KEY ?? "", model: "gemini-2.5-flash" }),
  events,
  flows: [
    f.flow({
      id: "confirmacao",
      name: "Confirmação de reunião",
      on: [{ event: "reuniao_marcada" }],
      steps: [{ id: "s", say: "Reunião confirmada para {{input.quando}}. Até lá." }],
    }),
  ],
});

const r = await agent.turn({ sessionId: "s1", event: "reuniao_marcada", payload: { quando: "terça às 10h" }, key: "meet:9" });
console.log(r.messages[0]?.text); // "Reunião confirmada para terça às 10h. Até lá."
console.log(r.started[0]?.runId); // "confirmacao#meet:9"
```

The payload type is for your own `turn` calls and the flows' `{{input.x}}`; the framework carries the payload as `unknown` and never validates it.

## Publish an event

`turn({ sessionId, session, context, event, payload, key })`. The framework never picks a session: you say which conversation the event belongs to. `key` is yours and must be unique per occurrence; the run is `<flowId>#<key>`.

In one event turn, in this order:

1. **Direction.** `inbound` stamps `lastUserAt`, and every run parked on a timer `wait` with `else` takes `else` (`code: 'replied'`). `outbound` stamps `lastAssistantAt`, and silence flows are armed again from that moment. No direction: nothing is stamped.
2. **Waiting runs resume.** Every run parked on `wait: { event }` for this name writes `code: 'event-arrived'` and takes `then`. The payload is not handed to it; the run keeps its own `input`.
3. **Flows start.** Every flow with a trigger for this name goes through the start order: `if` (with the payload as `input`), `repeat`, hop, one live run per flow and anchor. `after` parks the new run with `code: 'awaiting-trigger'`.
4. **Runs move.** A talk step reached now speaks first, one model call. `say` and `do` steps cost none.

An event carries no text, so nothing is routed or extracted, and the idle speaker stays quiet. Events repeat by default: the same `key` twice is skipped with `code: 'already-claimed'`, so re-publishing after a crash is safe.

## Wait for an event

A step can park until an event arrives:

```ts
import { falai } from "@falai/agent";

const f = falai().fields({});

const proposta = f.flow({
  id: "proposta",
  name: "Acompanhar proposta",
  on: [{ event: "entrou_na_etapa", after: "1h" }],
  steps: [
    { id: "fala", prompt: "Pergunte se a proposta chegou bem e se há dúvidas." },
    // then (the next step) = the event came; else = 7 days passed without it.
    { id: "espera", wait: { event: "reuniao_marcada", upTo: "7d" }, else: "lembra" },
    { id: "ok", do: "etiquetar", with: { tags: ["reunião marcada"] }, then: "end" },
    { id: "lembra", do: "avisar", with: { para: "vendedor", texto: "Sem reunião em 7 dias." } },
  ],
});
```

- Parking writes `code: 'awaiting-event'` with `detail: 'reuniao_marcada'` and `until`, and puts a wake in `schedule[]` under `<runId>:<stepId>:<atMs>` for the deadline. `upTo` defaults to 30 days.
- The event arrives: `code: 'event-arrived'`, the run takes `then`.
- The deadline fires first: `code: 'no-event'`, the run takes `else`. Without `else`, the run ends.
- The customer writing does not end an event wait; only the event or the deadline does.

## `after` on an event trigger

`{ event: 'entrou_na_etapa', after: '1h' }` starts the run when the event arrives but parks it for an hour before its first step, with the trigger's `if` re-checked when it wakes. A second event for the same flow and anchor during that hour replaces the parked run. Details in [Triggers](triggers.md#event).

## Read next

- [Triggers](triggers.md): `event` and `silence` triggers, `repeat`, `businessHours`.
- [Flow control](flow-control.md): `onFail`, `then` and the hop cap.
- [Go to production](../start/05-go-to-production.md): the save, the outbox and the queue around `turn()`.
- [Actions, events and conditions reference](../reference/actions-events-conditions.md): `Action`, `ActionCtx`, `ActionResult`, `EventDef`.
