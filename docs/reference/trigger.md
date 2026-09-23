---
title: "Trigger"
description: "The Trigger union kind by kind, Repeat and its default per kind, and the trigger key, run id, dedupe key and wake key each kind mints."
type: reference
order: 4
---

# Trigger

A trigger says when a run of a flow starts. There are four: the customer asks for the flow (`message`), the customer mentions something (`mention`), the customer goes quiet (`silence`), or something happens in the host (`event`). A flow with no trigger starts only by hand, with `turn({ start })`, or from another flow's `then: { flow }`. Every trigger may carry `repeat` and a code `if`.

## Signature

```ts fragment
type Trigger<C, D> = { repeat?: Repeat } & (
  | { message: string[]; if?: Pred<C, D> }
  | { mention: string[]; extract?: ParamDefs; if?: Pred<C, D> }
  | { silence: Duration; if?: Pred<C, D>; businessHours?: boolean }
  | { event: string; if?: Pred<C, D>; after?: Duration; businessHours?: boolean }
);

type Repeat = "once" | "always" | { cooldown: Duration };

type TriggerKind = "message" | "mention" | "silence" | "event" | "start" | "flow";
```

`TriggerKind` is what `run.trigger.kind` records. It has two values no trigger has: `'start'` for `turn({ start })` and `'flow'` for a run another flow started.

## The four triggers

### message

| Field | Type | Default | Meaning |
|---|---|---|---|
| `message` | `string[]` | required | Phrases that describe what the customer asks for. The model scores the flow against the message. `[]` is the catch-all: it is never scored, and it starts only when no other message flow scores 40 or more. |
| `if` | `Pred<C, D>` | none | Code gate. The flow is not offered to the model when it is false. |
| `repeat` | `Repeat` | `'once'` | |

The run takes the conversation: it becomes the asker and holds the floor — only one run asks at a time.

### mention

| Field | Type | Default | Meaning |
|---|---|---|---|
| `mention` | `string[]` | required | Phrases that describe what the customer brings up. The model answers true or false. `[]` with `if` is a code-only detector. |
| `extract` | `ParamDefs` | none | Values the model pulls from the message when it says true. They become the run's `input`, read as `{{input.x}}` in templates and `ctx.input` in code. |
| `if` | `Pred<C, D>` | none | Code gate, judged at start with `extract` in hand as `input`. |
| `repeat` | `Repeat` | `'once'` | |

The run starts beside the conversation. It is meant for `do` and `say` steps: it does not get routed to. A talk step in it behaves like any talk step and takes the floor.

### Phrases that rule a trigger out

Phrases are alternatives — one match is enough — so a list alone can only say "any of these". A phrase that opens with `!` says the opposite: it stops the trigger, whatever else matched.

```ts fragment
on: [{
  mention: [
    'o cliente pede para falar com uma pessoa',
    '!o cliente só concorda com o horário oferecido',   // "pode sim" is a yes to the meeting
    '!o cliente menciona outra pessoa sem pedir atendimento',
  ],
}]
```

Without the two exclusions, a customer answering "pode sim" to an offer of a meeting reads as a request for a human, because that sentence really does mention a person. The model is given the two lists separately and told that an exclusion overrides a match.

Works in `message` (an exclusion scores the flow 0), in `mention` (an exclusion answers false), and in an instruction's `when`. Whitespace around a phrase is trimmed, a bare `"!"` is ignored, and a `!` anywhere but the first character is ordinary text.

A trigger whose phrases are *all* exclusions can never fire, so `validateFlow` rejects it. For a flow that should catch everything else, use `message: []`.

### silence

| Field | Type | Default | Meaning |
|---|---|---|---|
| `silence` | `Duration` | required | How long the customer has been quiet since the assistant last spoke. |
| `if` | `Pred<C, D>` | none | Judged when the wake is armed and again when it fires. |
| `businessHours` | `boolean` | `false` | Snap the wake forward with the agent's `businessHours`. |
| `repeat` | `Repeat` | `'once'` | |

### event

| Field | Type | Default | Meaning |
|---|---|---|---|
| `event` | `string` | required | The event's name in the agent's `events`. |
| `after` | `Duration` | none | Park the run this long before its first step. |
| `if` | `Pred<C, D>` | none | Judged when the event arrives, with the payload as `input`. |
| `businessHours` | `boolean` | `false` | Start only in working hours: snap the start (now, or now + `after`) forward with the agent's `businessHours`. |
| `repeat` | `Repeat` | `'always'` | |

The event's `payload` is the run's `input`.

## Repeat

| Value | Meaning |
|---|---|
| `'once'` | One run per flow and anchor, ever. A second match is skipped with `code: 'already-claimed'`. |
| `'always'` | A run per input. The claim carries the trigger key, so only a replay of the same input is skipped. |
| `{ cooldown: '7d' }` | A run, then none until the cooldown passes (`code: 'cooldown'`). The claim is refreshed on each start. |

Default: `'once'` for `message`, `mention` and `silence`; `'always'` for `event`. Runs started by `turn({ start })` or by another flow are `'always'`.

## Keys

Every key is deterministic: the same input against the same session mints the same key.

| Kind | Trigger key | Run id |
|---|---|---|
| message, mention | the message `id`; without one, its `at`; without that, the clock's now as ISO | `${flowId}#${triggerKey}` |
| silence | `session.lastAssistantAt` in milliseconds since the epoch, as a string | `${flowId}#${ms}` |
| event | the `key` passed with `turn({ event })` | `${flowId}#${key}` |
| start | `start.key` | `${flowId}#${key}` |
| flow | the parent step's key `${parentRunId}:${stepId}:${visit}` | `${flowId}#${parentRunId}:${stepId}:${visit}` |

Pass a real message `id` on every message turn. Only `id` is checked against the session's last 50 inputs; without it a replay is not detected, and without `at` as well the key is the clock's now, so the replay mints new keys.

**Dedupe key.** `${flowId}:${anchor}:${nonce}`. The nonce is the trigger key when `repeat` is `'always'` and empty otherwise. It is written to `session.claims` when the run starts, given to actions as `ctx.dedupeKey`, and returned in `started[]`. The last 50 `'always'` claims per flow and anchor are kept; `'once'` and cooldown claims are never pruned. The host may pass claims from the customer's other sessions in `turn({ claims })`; they count the same.

**Wake for `after`.** `${runId}:start:${atMs}`, where `atMs` is the fire time in milliseconds after `businessHours` snapping. With `businessHours: true` and no `after`, the same wake parks a run whose event arrives outside working hours; inside them it starts at once. The run is returned in `started[]` at once with the outcome `code: 'awaiting-trigger'`. At the wake it enters its first step. A second event for the same flow and anchor while it is parked replaces it: the parked run ends with reason `'replaced'`.

**Wake for silence.** `silence:${flowId}:${sessionId}:${lastAssistantAtMs}`. Armed at the end of every turn in which the assistant spoke and the customer has not written since, for every silence flow passing `if` and `repeat`; the entry's `replaces` names the previous silence wake. At fire time it is honoured only while `session.lastAssistantAt` still equals that timestamp and the customer has not written since (`code: 'silence-broken'` otherwise).

## Behaviour

**How message flows are chosen.** On a message turn, the eligible flows are those with a non-empty `message` list passing `if` and `repeat`, in agent order.
- No run asking: the understand call scores each eligible flow from 0 to 100, a lone one included. The top flow starts if it scores 40 or more; otherwise the first eligible `message: []` flow starts, if there is one.
- One exception: a single eligible flow, with no `message: []` flow passing and `idle: 'silent'`, starts without being scored, because a low score would leave the customer with no reply. The understand call is then skipped altogether when there is nothing else to judge: no mention flows, no `when` branches, no unknown `'anywhere'` field.
- A run is asking: it keeps the floor unless another flow scores at least 15 above it and at least 40. Then that flow starts, or its suspended run resumes, and the asker is suspended.
- The catch-all `message: []` is never scored. It obeys `if` and `repeat` like any trigger, so with the default `'once'` it fires once per session. When nothing starts and no run is asking, the idle speaker answers.

**Mentions.** A non-empty `mention` list reaches the understand call on every message turn while `repeat` allows. When the model says true, the run starts with `extract` values as `input`; they arrive as the model returned them, with null and empty values dropped, and are not coerced. `mention: []` skips the model: the run goes through the start order on every message turn, so `if` and `repeat` decide.

**Where `if` runs.** With a draft run (`stepId: null`) for message eligibility and silence arming; with the real run about to start otherwise. `ctx.input` is the event payload or the mention's extract; `ctx.run` is the run; `ctx.silenced` is the host's reason, when any.

**Skip reasons** land in `TurnResult.skipped` with the flow, anchor and trigger key: `code: 'already-claimed'`, `code: 'cooldown'`, `code: 'already-running'` (one live run per flow and anchor, here or in another of the customer's sessions), `code: 'hop-limit'` (hop 5), `code: 'flow-gone'` (`start` or `{ flow }` named a flow that does not exist). A trigger whose `if` is false is not listed.

## Example

```ts
import { falai, GeminiProvider } from "@falai/agent";

interface Ctx {
  lead: { dono: "ia" | "humano"; etapa: string };
}

const f = falai<Ctx>().fields({
  nome: { type: "string", ask: "Pergunte o nome." },
});

const agent = f.agent({
  name: "Ana",
  provider: new GeminiProvider({ apiKey: process.env.GEMINI_API_KEY ?? "", model: "gemini-2.5-flash" }),
  events: { entrou_na_etapa: f.event<{ etapa: string }>() },
  conditions: { naEtapa: f.condition((ctx, etapa: string) => ctx.context.lead.etapa === etapa) },
  actions: { avisar: f.action({ parameters: { texto: { type: "string" } }, run: () => ({ ok: true }) }) },
  flows: [
    f.flow({
      id: "triagem",
      name: "Triagem",
      on: [{ message: ["quer saber como funciona", "pede um orçamento"], repeat: "always" }],
      steps: [{ id: "quem", collect: ["nome"] }],
    }),
    f.flow({
      id: "concorrente",
      name: "Falou de concorrente",
      on: [{ mention: ["cita ou compara com um concorrente"], extract: { trecho: { type: "string" } } }],
      steps: [{ id: "avisa", do: "avisar", with: { texto: 'Falou de concorrente: "{{input.trecho}}"' } }],
    }),
    f.flow({
      id: "retomar",
      name: "Retomar quem sumiu",
      on: [{ silence: "24h", businessHours: true, if: ({ context }) => context.lead.dono === "ia" }],
      steps: [{ id: "p1", prompt: "Retome a conversa de forma leve e pergunte se ainda faz sentido." }],
    }),
    f.flow({
      id: "proposta",
      name: "Acompanhar proposta",
      on: [{ event: "entrou_na_etapa", after: "1h", if: { naEtapa: "proposta" } }],
      steps: [{ id: "fala", prompt: "Pergunte se a proposta chegou bem." }],
    }),
    f.flow({
      id: "boas-vindas",
      name: "Boas-vindas",
      steps: [{ id: "oi", say: "Oi! Vi que você se cadastrou. Posso ajudar em algo?" }],
    }),
  ],
});

const context: Ctx = { lead: { dono: "ia", etapa: "proposta" } };
const r = await agent.turn({ sessionId: "s1", context, start: { flow: "boas-vindas", key: "signup:456" } });
console.log(r.started[0]?.runId, r.messages[0]?.key); // 'boas-vindas#signup:456', 'boas-vindas#signup:456:oi:1'
console.log(r.schedule.map((s) => s.key)); // [ 'silence:retomar:s1:<ms>' ]: the assistant spoke, so the silence wake is armed
```

## See also

- [Triggers guide](../guides/triggers.md) for choosing a trigger
- [Flow](flow.md) for `anchor`, `while` and the start order
- [Runs and waits](../concepts/runs-and-waits.md) for the full key table and the floor
- [Session](session.md) for `Run.trigger` and `Session.claims`
