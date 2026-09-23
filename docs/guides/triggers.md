---
title: "Triggers"
description: "The five ways a run starts, what each costs, how if and repeat gate them, and how a message picks its flow."
type: guide
order: 1
---

# Triggers

A trigger says when a run of a flow starts. It lives in the flow's `on` list. There are four trigger kinds, and a flow with no `on` is started by the host.

| Trigger | A run starts when | Judged by |
|---|---|---|
| `{ message: [...] }` | the customer asks for this; the run takes the conversation | the model, in the turn's one understand call — the single judging call, see [The turn](../concepts/pipeline.md) |
| `{ mention: [...] }` | the customer brings this up; the run reacts beside the conversation | the model, in the same call |
| `{ silence: '24h' }` | the customer has been quiet this long since the assistant last spoke | code, from a wake |
| `{ event: 'reuniao_marcada' }` | the host reports the event with `turn({ event })` | code |
| no `on` | the host calls `turn({ start })`, or another flow chains here with `then: { flow }` | code |

The smallest flow has one message trigger:

```ts
import { falai, GeminiProvider } from "@falai/agent";

const f = falai().fields({
  nome: { type: "string", ask: "Pergunte o nome da pessoa." },
});

const agent = f.agent({
  name: "Ana",
  // Set GEMINI_API_KEY in your environment before running this.
  provider: new GeminiProvider({ apiKey: process.env.GEMINI_API_KEY ?? "", model: "gemini-2.5-flash" }),
  flows: [
    f.flow({
      id: "orcamento",
      name: "Orçamento",
      on: [{ message: ["pede um orçamento", "quer saber o preço"] }],
      steps: [{ id: "quem", collect: ["nome"] }],
    }),
  ],
});

const r = await agent.turn({ sessionId: "s1", message: "quanto custa?", id: "m1" });
console.log(r.started[0]?.runId); // "orcamento#m1"
console.log(r.messages[0]?.text); // the model asks for the name
```

The customer wrote "quanto custa?", the model matched it to the flow, and a run started. Its id is `orcamento#m1`: the flow id, `#`, and the message id you passed. Pass the channel's message `id` on every message. The framework uses it to spot a replay (`code: 'duplicate-input'`, `changed: false`) and to mint the same keys when the host retries a turn.

## Message

`message` is a list of phrases that describe what the customer says. The model reads them, plus the flow's `name` and `description`, when it routes. It scores every candidate flow from 0 to 100; how the winner is picked is in [How a message picks its flow](#how-a-message-picks-its-flow) below.

A message run takes the conversation: its talk steps ask, and it holds the floor — the right to ask the next question, which only one run has at a time — until it ends or another flow wins the floor. By default it starts once per session (`repeat: 'once'`).

`message: []` is the catch-all. It is never scored. It starts when no other message flow wins and no run holds the floor. Its `if` and `repeat` still apply, and `repeat` still defaults to `'once'`: a catch-all that should pick up every new topic needs `repeat: 'always'`.

## Mention

A mention is something the customer brings up while talking about something else: they ask for a human, they name a competitor. The run starts beside the conversation and does not take it over.

```ts
import { falai, GeminiProvider } from "@falai/agent";

const f = falai().fields({
  nome: { type: "string", ask: "Pergunte o nome." },
});

const agent = f.agent({
  name: "Ana",
  provider: new GeminiProvider({ apiKey: process.env.GEMINI_API_KEY ?? "", model: "gemini-2.5-flash" }),
  actions: {
    chamar_humano: f.action({ parameters: {}, run: () => ({ ok: true }) }),
    avisar: f.action({
      parameters: { texto: { type: "string" } },
      run: (params) => {
        console.log(params.texto);
        return { ok: true };
      },
    }),
  },
  flows: [
    f.flow({
      id: "triagem",
      name: "Triagem",
      on: [{ message: [] }],
      steps: [{ id: "quem", collect: ["nome"] }],
    }),
    f.flow({
      id: "pediu_humano",
      name: "Pediu para falar com uma pessoa",
      on: [{ mention: ["pede para falar com uma pessoa, um humano ou um atendente"] }],
      steps: [
        { id: "s", say: "Claro. Já chamo alguém da equipe para continuar com você." },
        { id: "a", do: "chamar_humano" },
      ],
    }),
    f.flow({
      id: "concorrente",
      name: "Falou de concorrente",
      on: [{ mention: ["cita ou compara com um concorrente"], extract: { trecho: { type: "string" } } }],
      steps: [{ id: "avisa", do: "avisar", with: { texto: 'Falou de concorrente: "{{input.trecho}}"' } }],
    }),
  ],
});

const r = await agent.turn({ sessionId: "s1", message: "quero falar com uma pessoa", id: "m1" });
console.log(r.messages.map((m) => [m.kind, m.text])); // [["verbatim", "Claro. Já chamo alguém ..."]]
```

- The model answers "did the customer bring this up?" with true or false, in the same understand call that routes the message. The prompt tells it to be conservative: true needs clear evidence in the message.
- `extract` names values to pull from the message when the mention is true. They land in the run's `input`, so `{{input.trecho}}` works in `say`, `prompt` and `with`. They are never written to the collected data.
- A `say` step in a mention flow answers the customer this turn. The run that was asking does not speak (`code: 'another-reply'`) and asks again on the next message. `do` steps run in the same turn. The turn above costs one model call.
- A talk step in a mention flow takes the floor like any other talk step: the run that was asking is suspended and resumes when this one ends.
- Default `repeat: 'once'`: once the flow has run, it is left out of the understand call, so a second mention starts nothing and writes no line. A code-only `mention: []` detector is the exception: it goes through the start order on every message and logs `code: 'already-claimed'` in `skipped[]`.

`mention: []` with an `if` is a code-only detector. It costs no model call and is checked on every message:

```ts
import { falai } from "@falai/agent";

interface Ctx {
  lead: { tags: string[] };
}

const f = falai<Ctx>().fields({});

const aviso = f.flow({
  id: "aviso",
  name: "Aviso de humano",
  on: [{ mention: [], if: ({ context }) => context.lead.tags.includes("pediu_humano") }],
  steps: [{ id: "s", say: "Já chamo alguém da equipe." }],
});
```

## Silence

The customer stopped answering. A silence trigger fires when the assistant's last message has gone this long without a reply.

```ts
import { falai, GeminiProvider } from "@falai/agent";

interface Ctx {
  lead: { owner: "ai" | "human" };
}

const f = falai<Ctx>().fields({
  nome: { type: "string", ask: "Pergunte o nome." },
});

const retomar = f.flow({
  id: "retomar",
  name: "Retomar quem sumiu",
  on: [{ silence: "24h", if: ({ context }) => context.lead.owner === "ai" }],
  steps: [
    { id: "p1", prompt: "Retome a conversa de forma leve e pergunte se ainda faz sentido." },
    { id: "w1", wait: "2d", else: "end" },
    { id: "p2", prompt: "Última tentativa, curta e sem pressão." },
  ],
});

const agent = f.agent({
  name: "Ana",
  provider: new GeminiProvider({ apiKey: process.env.GEMINI_API_KEY ?? "", model: "gemini-2.5-flash" }),
  flows: [
    f.flow({ id: "triagem", name: "Triagem", on: [{ message: [] }], steps: [{ id: "quem", collect: ["nome"] }] }),
    retomar,
  ],
});

const context: Ctx = { lead: { owner: "ai" } };
const t1 = await agent.turn({ sessionId: "s1", context, message: "oi", id: "m1" });
console.log(t1.schedule); // [{ key: "silence:retomar:s1:<ms>", at: <24 hours after the assistant's reply> }]

// 24 hours later the host's queue fires the job. A real host reloads the session from its store first.
const t2 = await agent.turn({ sessionId: "s1", context, session: t1.session, wake: t1.schedule[0].key, history: [] });
console.log(t2.started.map((s) => s.flowId), t2.llmCalls); // ["retomar"], 1
```

How it works, in order:

1. The assistant speaks: a talk step, a `say`, or an action that returns `spoke: true`. The turn stamps `session.lastAssistantAt`.
2. For every silence flow whose `if` holds and whose `repeat` allows, the turn puts a wake in `schedule[]`: key `silence:<flowId>:<sessionId>:<lastAssistantAtMs>`, `at` = that time plus the duration. `replaces` names the previous silence key of the same flow so the host can drop the old job. Dropping it is best effort; a stale wake is harmless.
3. The host enqueues the wake with the key in the payload and `encodeURIComponent(key)` as the job id, because BullMQ refuses a `:` in a custom id, and calls `turn({ wake: key })` when it fires.
4. The wake is honoured only while the session still shows that silence: the assistant's last message is still the same one and the customer has not written since. Otherwise the turn ends with `code: 'silence-broken'` and `changed: false`.
5. The run starts, takes the floor and speaks first. A talk step costs one model call; the prompt tells the model there is no new message from the customer.

The trigger's `if` is judged with fresh context twice: when the wake is armed and when it fires. The run's premise is re-checked on every later wake too: if the customer wrote since the run started, it ends with `code: 'customer-replied'`. That is why a follow-up flow parks with `wait: '2d', else: 'end'` between its messages: a reply ends the run cleanly.

With `businessHours: true`, the agent's `businessHours` function moves the wake forward to the next working hour (see [businessHours](#businesshours)). Default `repeat: 'once'`.

## Event

Something happened in your program: a deal moved stage, a meeting was booked, a comment landed on a post. Declare the event once, register it on the agent, and name it in the trigger.

```ts
import { falai, GeminiProvider } from "@falai/agent";

interface Ctx {
  lead: { stageId: string };
}

const f = falai<Ctx>().fields({
  urgencia: { type: "string", enum: ["agora", "30 dias", "sem prazo"], ask: "Pergunte para quando precisam resolver." },
});

const agent = f.agent({
  name: "Ana",
  provider: new GeminiProvider({ apiKey: process.env.GEMINI_API_KEY ?? "", model: "gemini-2.5-flash" }),
  events: {
    stage_entered: f.event<{ stageId: string }>(),
  },
  flows: [
    f.flow({
      id: "interesse",
      name: "Entrou em negociação",
      on: [{ event: "stage_entered", after: "1h", if: ({ context }) => context.lead.stageId === "negociacao" }],
      steps: [{ id: "p", prompt: "Diga que viu o interesse avançar e pergunte para quando precisam.", collect: ["urgencia"] }],
    }),
  ],
});

const context: Ctx = { lead: { stageId: "negociacao" } };
const r = await agent.turn({ sessionId: "s1", context, event: "stage_entered", payload: { stageId: "negociacao" }, key: "stage:7" });
console.log(r.llmCalls); // 0
console.log(r.schedule[0]?.key); // "interesse#stage:7:start:<ms>", one hour from now
console.log(r.outcomes[0]?.code); // "awaiting-trigger"
```

- `turn({ event, payload, key })` publishes it. The payload becomes the run's `input`: `{{input.stageId}}` in templates, `ctx.input` in actions, `input` in the trigger's `if`. `input` is typed `unknown` there; narrow it before you read it.
- `after: '1h'` parks the new run before its first step. The wake key is `<runId>:start:<atMs>`; the outcome line reads `code: 'awaiting-trigger'`. If the same event arrives again for the same flow and anchor while the run is still parked there, the parked run is replaced (`ended[].reason: 'replaced'`). Any other live run makes the new one skip with `code: 'already-running'`.
- `businessHours: true` moves `after` forward to the next working hour. With no `after`, it holds an event that arrives after hours until the next working hour, and starts at once inside them.
- Default `repeat: 'always'`: every event with a new `key` starts a run. The same `key` twice is skipped with `code: 'already-claimed'`, so publishing an event again is safe.
- Zero model calls, unless the run reaches a talk step: then the assistant speaks first, one call.
- An event may carry a `direction`, which stamps the session as the customer or the assistant speaking. See [Actions and events](actions-and-events.md).

## Start

A flow with no `on` starts only when asked: by the host with `turn({ start })`, or by another flow with `then: { flow }`.

```ts
import { falai, GeminiProvider } from "@falai/agent";

const f = falai().fields({});

const agent = f.agent({
  name: "Ana",
  provider: new GeminiProvider({ apiKey: process.env.GEMINI_API_KEY ?? "", model: "gemini-2.5-flash" }),
  flows: [
    f.flow({
      id: "boas-vindas",
      name: "Boas-vindas",
      steps: [{ id: "oi", say: "Oi, {{input.nome}}. Vi que você se cadastrou. Posso ajudar em algo?" }],
    }),
  ],
});

const r = await agent.turn({ sessionId: "s1", start: { flow: "boas-vindas", input: { nome: "Ana" }, key: "signup:456" } });
console.log(r.messages[0]?.text); // "Oi, Ana. Vi que você se cadastrou. Posso ajudar em algo?"
console.log(r.llmCalls); // 0
```

`input` becomes the run's `input`. `key` is yours; make it unique per start (`boas-vindas#signup:456` is the run id). Starts repeat by default (`'always'`); the same key twice is skipped. An unknown flow id lands in `skipped[]` with `code: 'flow-gone'`.

Chaining from another flow is in [Flow control](flow-control.md).

## `if` on a trigger

Every trigger takes an `if`: a code predicate the run must pass to start. It sees `context`, `data`, `input` (the event payload or the mention's extract), `silenced` and `now`. A failed `if` starts nothing and writes nothing to `skipped[]`.

```ts fragment
on: [{ event: 'stage_entered', after: '1h', if: ({ context }) => context.lead.stageId === 'negociacao' }]
```

The `if` also becomes the flow's default `while`: it is re-checked with fresh context every time the run is about to move, and the run ends with `code: 'premise-changed'` when it stops holding. Set `while` on the flow to check something else. Conditions in code or JSON, and where each is allowed: [Conditions](conditions.md).

## `repeat`

How often a trigger may start a run for one session. A flow with `anchor: 'lead'` counts per customer instead; see [One live run per flow and anchor](#one-live-run-per-flow-and-anchor).

| `repeat` | Meaning | Skip line |
|---|---|---|
| `'once'` | one run ever per flow and anchor | `code: 'already-claimed'` |
| `'always'` | every trigger key starts a new run | none; the same key twice is `code: 'already-claimed'` |
| `{ cooldown: '7d' }` | a new run only after this long since the last start | `code: 'cooldown'` |

Defaults: `'once'` for `message`, `mention` and `silence`; `'always'` for `event`, manual starts and chained flows.

Each start writes a claim in `session.claims` under `<flowId>:<anchor>:<nonce>`. The nonce is empty for `'once'` and cooldown and is the trigger key for `'always'`; the last 50 always-claims per flow and anchor are kept. A run that repeats usually needs `clearOnStart` to forget the fields the previous run collected; otherwise the steps that collect them are skipped as already known.

The host can extend the ledger across a customer's other sessions with `turn({ claims: { held, active } })`: `held` maps a dedupe key to when it was claimed, `active` lists `<flowId>:<anchor>` pairs live elsewhere.

## One live run per flow and anchor

Inside a session, a flow has at most one live run per anchor. A trigger that fires while one is live is skipped with `code: 'already-running'`. The one exception is a run still parked on its trigger's `after`, which the new one replaces.

`anchor` defaults to the session. A flow with `anchor: 'lead'` reads its key from `turn({ anchors: { lead: { key: 'lead:456' } } })`, so one run serves every conversation of that customer. More in [Runs and waits](../concepts/runs-and-waits.md).

## `businessHours`

Timers can wait for working hours. Give the agent a `businessHours` function and set `businessHours: true` where it should apply: a silence trigger, an event trigger (its `after`, or the start itself when it has none), a `wait` step.

```ts
import { falai, GeminiProvider } from "@falai/agent";

const f = falai().fields({});

const agent = f.agent({
  name: "Ana",
  provider: new GeminiProvider({ apiKey: process.env.GEMINI_API_KEY ?? "", model: "gemini-2.5-flash" }),
  // 9h to 18h. Anything later moves to 9h the next day.
  businessHours: (at) => {
    const d = new Date(at);
    if (d.getHours() >= 18) d.setHours(33, 0, 0, 0);
    if (d.getHours() < 9) d.setHours(9, 0, 0, 0);
    return d;
  },
  flows: [
    f.flow({
      id: "retomar",
      name: "Retomar",
      on: [{ silence: "24h", businessHours: true }],
      steps: [
        { id: "p1", prompt: "Retome a conversa de forma leve." },
        { id: "w1", wait: "2d", businessHours: true, else: "end" },
      ],
    }),
  ],
});
```

The function receives the computed time and `{ context }` and returns the time to use. Move it forward; never move it back.

## How a message picks its flow

Every message turn decides who speaks, in this order:

1. **Ingest first.** If the message ends a `wait` with `else` and the run goes on to another step, that run takes the floor and routing is skipped.
2. **Eligible flows.** Message flows with a non-empty list whose `if` holds and whose `repeat` allows, in the order you passed them to the agent.
3. **The run that is asking keeps priority.** When a run is asking, its flow is scored too. Another flow wins only when its score is at least 15 above the asking flow's and at least 40. Then a suspended run of that flow resumes, or a new run starts; the run that was asking is suspended and comes back when the winner ends.
4. **No floor.** The best score wins if it is at least 40. Otherwise the first `message: []` catch-all that passes `if` and `repeat` starts. Otherwise nobody takes the floor. A lone candidate is scored too, so "oi" does not start your scheduling flow just because it is the only one.
5. **One candidate and nobody else to answer.** When no catch-all passes and `idle` is `'silent'`, a low score would leave the customer with no reply. So the one candidate starts without a score. If nothing else needs the model this turn (no mention flows, no pending fields to extract), the turn spends no understand call.
6. **Nobody has the floor.** The idle speaker answers.

Scores come from the understand call, 0 to 100 per candidate. The two thresholds, 40 and 15, are constants in `src/core/Runner.ts`.

Two flows the model has to tell apart:

```ts
import { falai, GeminiProvider } from "@falai/agent";

const f = falai().fields({
  nome: { type: "string", ask: "Pergunte o nome." },
});

const agent = f.agent({
  name: "Ana",
  provider: new GeminiProvider({ apiKey: process.env.GEMINI_API_KEY ?? "", model: "gemini-2.5-flash" }),
  idle: { prompt: "Responda pela empresa; não invente preços." },
  flows: [
    f.flow({
      id: "triagem",
      name: "Triagem",
      description: "Quando alguém chega querendo saber se o produto serve para a empresa dele",
      on: [{ message: ["quer saber como funciona", "pede um orçamento"] }],
      steps: [{ id: "quem", collect: ["nome"] }],
    }),
    f.flow({
      id: "suporte",
      name: "Suporte",
      description: "Quando um cliente atual tem um problema com o produto",
      on: [{ message: ["já é cliente e algo não funciona", "pede ajuda com um erro"] }],
      steps: [{ id: "p", prompt: "Peça detalhes do problema e diga que vai encaminhar." }],
    }),
  ],
});

const r = await agent.turn({ sessionId: "s1", message: "oi, quero saber como funciona", id: "m1" });
console.log(r.started.map((s) => s.flowId)); // ["triagem"] when it scores at least 40; otherwise the idle speaker answers
```

Write `description` for every message flow: it is the sentence the model reads to score it.

### The idle speaker

`idle` is the one speaker that is not a step. It answers a message when no run holds the floor and nothing else spoke this turn.

```ts fragment
idle: { prompt: 'Responda pela empresa; não invente preços.', tools: ['faq'], instructions: [] }
// or
idle: 'silent'
```

With no `idle` option the model still answers, with the agent's persona and no extra guideline. `'silent'` mutes it: zero calls, no message, but the input is still recorded. The idle message is keyed `idle:<messageId>` and its outcome line has `kind: 'idle'`.

## Read next

- [Conditions](conditions.md): `if` in code or JSON, `when` for the model.
- [Actions and events](actions-and-events.md): declaring events, `direction`, `wait: { event }`.
- [Runs and waits](../concepts/runs-and-waits.md): the floor, keys, claims and anchors.
- [Trigger reference](../reference/trigger.md): the type, field by field.
