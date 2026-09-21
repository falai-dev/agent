---
title: "Runs and waits"
description: "How one run at a time holds the floor, how a parked run wakes up, and how every key is built."
type: concept
order: 3
---

# Runs and waits

A **run** is one live execution of a flow inside a session. A session holds many runs at once: a triage asking for a name, a follow-up parked for two days, a reminder waiting for an event. Code decides which one moves, which one speaks and which one wakes. This page is that code, in words. The code itself is `src/core/Runner.ts`.

## A run

A message that starts a flow creates a run:

```ts
import type { Agent } from "@falai/agent";
declare const agent: Agent;

const r = await agent.turn({ sessionId: "s1", message: "oi" });
console.log(r.session.runs[0].status); // "asking": the run spoke and waits for the answer
```

| Status | Meaning | Moves again when |
|---|---|---|
| `running` | Between steps, inside a turn. | Now |
| `asking` | Its talk step spoke and waits for the answer. This run holds the floor. | The next message arrives |
| `waiting` | Parked on a `wait`, a deferred `do`, a speak retry, or the trigger's `after`. | Its wake fires, the customer replies (a timer wait with `else`), or its event arrives |
| `suspended` | Was asking; another run took the floor. | Nobody is asking any more |

Here is everything the session keeps about that run:

```ts fragment
interface Run {
  id: string;                 // `${flowId}#${triggerKey}`
  flowId: string;
  anchor: string;             // the session id, or a host anchor key
  dedupeKey: string;          // `${flowId}:${anchor}:${nonce}`
  stepId: string | null;      // null before the first step
  status: "running" | "asking" | "waiting" | "suspended";
  trigger: { kind: "message" | "mention" | "silence" | "event" | "start" | "flow"; key: string; payload?: unknown };
  input?: unknown;            // the trigger payload, read as {{input.x}}
  hop: number;                // flow-to-flow chaining depth, capped at 5
  startedAt: string;
  suspendedAt?: string;       // set while suspended
  waiting?: { kind: "timer" | "event"; key?: string; until?: string; setAt: string; event?: string };
  asked: Record<string, number>;   // times each field was asked
  visits: Record<string, number>;  // times each step was entered
  outcomes: StepOutcome[];         // the last 50
}
```

`session.runs` holds live runs only. A run that ends leaves the session and appears once in `TurnResult.ended` with a reason: `end` (the last step, or `then: 'end'`), `flow` (it chained into another flow), `reset` (`onEnd: 'reset'`), `skipped` (a premise failed, the flow or step is gone, or it was silenced), `failed` (the step cap), `replaced` (it was still parked on its trigger's `after` when the same flow started again for that anchor).

## Starting a run

Every start, whatever the trigger, goes through the same checks in `Runner.startRun`, in this order. The first check that fails stops the start, and most leave a line in `TurnResult.skipped`.

1. The trigger's `if`, with the payload as `input`. False: no run, no line.
2. The claim. `repeat: 'once'` with a claim held: `code: 'already-claimed'`. A cooldown still running: `code: 'cooldown'`.
3. The hop cap. A start at `hop` 5: `code: 'hop-limit'`.
4. One live run per flow and anchor. A live run in this session, or a `${flowId}:${anchor}` pair in the host's `claims.active`: `code: 'already-running'`. One exception: a run still parked on its own `after` timer ends with reason `replaced`, and the new one takes its place.
5. The claim is written, `clearOnStart` clears its fields, the run joins `session.runs`, `started[]` gets a line.
6. An `event` trigger with `after` parks the run before its first step (`code: 'awaiting-trigger'`).

## The floor

At most one run in a session is `asking`. That run holds the floor: its talk step spoke last, and the next message is read as its answer.

- A talk step reached by any other run suspends the asker (`status: 'suspended'`, `suspendedAt: now`) and takes the floor. A follow-up nudge that fires while triage is mid-question does exactly this.
- Whenever nobody is asking, at the start of phase 5 and again after Speak, the **most recently suspended** run returns to asking. It is a stack: `suspendedAt` decides, not `startedAt`. `tests/runner.test.ts` ("the floor") pins this with three runs.
- An asking run re-speaks only on a message. Wakes and events leave it alone.
- On a message, routing may move the floor to another flow: it needs a score of at least 40 and at least 15 above the asker's. Then that flow's suspended run resumes, or a new run starts. Routing never takes the floor from a run that took it in Ingest (a resolved wait, a wake). [Triggers](../guides/triggers.md) has the routing rules.
- One answer per message. When a run other than the floor holder answered this turn (a `say`, or a `do` returning `spoke: true`), the floor's talk is skipped (`code: 'another-reply'`) and the asker stays asking.

## Waits

A `wait` step parks the run. There are two kinds.

**Timer**: `{ wait: '2d', else?, businessHours?, branches? }`. `then` means the time passed; `else` means the customer replied first.

- **Ten seconds or less**, when the next step is a `say` or a talk step: no wake at all. The delay rides on that message as `afterMs` (`wait: '3s'` gives `afterMs: 3000`) and the run keeps moving. Any other short wait behaves like a long one.
- **Longer**: the run parks with `waiting: { kind: 'timer', key, until, setAt }`, and `schedule[]` gets `{ key, at }`. `businessHours: true` moves `at` forward to the next open hour, using the agent's `businessHours` function.
- A message, or an inbound event, while parked: every timer wait with an `else` takes it at Ingest, outcome `code: 'replied'`. An `if` branch on the wait step is checked first and wins over `else`; `when` branches on a wait step are not judged.
- The wake fires: `code: 'no-reply'`, `then`. Unless the customer wrote after `waiting.setAt` and the step has an `else`: then `code: 'replied'`, `else`. The reply beat the job.

**Event**: `{ wait: { event: 'meeting_booked', upTo?: '7d' }, else? }`. The event arrives: `code: 'event-arrived'`, `then`. `upTo` passes (default 30 days): `code: 'no-event'`, `else`, or the run ends when there is no `else`.

Two more things park a run: a `do` step that returns `{ defer: '24h', detail }`, whose wake re-runs the same step under the same key; and a speak call that failed in a way a wait can fix, which gets a retry wake at 1, 5 and 15 minutes, then an hour, then six (see [the pipeline](./pipeline.md#7-settle)).

```ts
import type { Agent } from "@falai/agent";
declare const agent: Agent;

const t1 = await agent.turn({ sessionId: "s1", start: { flow: "lembrete", key: "k1" } });
// t1.llmCalls === 0; t1.schedule[0].key === "lembrete#k1:espera:<atMs>", one day out
```

The agent behind it, with a fake clock so the wake can be replayed:

```ts
import { falai, fakeClock } from "@falai/agent";
import type { AiProvider } from "@falai/agent";

declare const provider: AiProvider;

const clock = fakeClock("2026-09-20T10:00:00.000Z");
const f = falai().fields({});
const agent = f.agent({
  name: "Ana",
  provider,
  clock,
  flows: [
    f.flow({
      id: "lembrete",
      name: "Lembrete",
      steps: [
        { id: "espera", wait: "1d" },
        { id: "aviso", prompt: "Lembre a pessoa da reunião de amanhã, em uma frase." },
      ],
    }),
  ],
});

const t1 = await agent.turn({ sessionId: "s1", start: { flow: "lembrete", key: "k1" } });
// t1.llmCalls === 0; t1.schedule[0].key === `lembrete#k1:espera:${Date.parse("2026-09-21T10:00:00.000Z")}`

clock.advance("1d");
const t2 = await agent.turn({ sessionId: "s1", session: t1.session, wake: t1.schedule[0].key });
// t2.llmCalls === 1; t2.messages[0].key === "lembrete#k1:aviso:1"
```

## Wakes

A wake is `turn({ wake: key })`, called by the host when a `schedule[]` entry comes due. The framework never cancels one. A wake that no longer means anything is ignored, and an ignored wake is `changed: false`, so the host saves nothing.

| Wake key | Honoured by | Otherwise |
|---|---|---|
| A run wake (any key below except the silence key) | The one run whose `waiting.key` equals it | `code: 'stale-wake'` |
| `silence:<flowId>:<sessionId>:<ms>` | Nobody yet: it starts the silence flow, provided `session.lastAssistantAt` is still exactly `<ms>` and the customer has not written since (`lastUserAt`, plus the anchor's `lastInboundAt` for anchored flows) | `code: 'silence-broken'`; a flow the agent no longer has is `code: 'flow-gone'` |
| Any wake, no session | Nobody | `code: 'no-session'` |

An honoured wake then re-checks the run's premise before it moves: `while`, or the trigger's `if`, with this turn's context (`code: 'premise-changed'` when false); and for a silence run, that the customer has not written since the run started (`code: 'customer-replied'`).

`ScheduleEntry.replaces` names the wake this one supersedes: a new silence wake after the assistant spoke again. Removing it from your queue is a courtesy; the old key is ignored anyway.

## The keys

Every key is built from the input, so a replay of the same input builds the same keys and a new visit builds new ones.

| Key | Format | Where |
|---|---|---|
| Trigger key | `message` and `mention`: the message `id`, or `at` when there is none. `event` and `start`: the host's `key`. `silence`: `lastAssistantAt` in ms. `flow`: the parent's step key | `run.trigger.key` |
| Run id | `${flowId}#${triggerKey}` | `run.id` |
| Message and action key | `${runId}:${stepId}:${visit}` | `OutboundMessage.key`, `ActionCtx.key`, `StepOutcome.key` |
| Idle message key | `idle:${triggerKey}` | `OutboundMessage.key` |
| Timer, event and deferral wake | `${runId}:${stepId}:${atMs}` | `run.waiting.key`, `ScheduleEntry.key` |
| Trigger `after` wake | `${runId}:start:${atMs}` | same |
| Speak retry wake | `${runId}:${stepId}:${visit}:retry:${atMs}` | same |
| Silence wake | `silence:${flowId}:${sessionId}:${lastAssistantAtMs}` | `ScheduleEntry.key` |
| Dedupe key | `${flowId}:${anchor}:${nonce}` | `run.dedupeKey`, `ActionCtx.dedupeKey`, `session.claims` |
| `say` once claim | `${flowId}:${stepId}:${sessionId}` | `session.claims` |

`visit` is the number of times the run has entered the step. Going back to a step with `then: { step, clear }` or `onEnd: 'stay'` enters it again, so the second message from the same step is `…:2`, not a duplicate of `…:1`.

## Claims and repeat

`repeat` on a trigger says how often a flow may start for one session or anchor: `'once'`, `'always'`, or `{ cooldown: '7d' }`. The default is `'once'` for `message`, `mention` and `silence` triggers and `'always'` for `event` triggers, manual starts and chained flows.

A claim is one row in `session.claims`, keyed by the dedupe key `${flowId}:${anchor}:${nonce}` (the nonce is a suffix that tells one start from another), holding the time it was written.

- `'once'` and cooldown use an empty nonce, so there is one key per flow and anchor. `once`: any claim blocks. Cooldown: a claim younger than the window blocks (`code: 'cooldown'`); an older one is overwritten.
- `'always'` uses the trigger key as the nonce, so every start has its own claim. The last 50 per flow and anchor are kept; `once` and cooldown claims are never pruned.
- The claim is written in the same turn as the run's first step, so a run never exists without its claim, and a replayed input finds the claim and skips.

Across a customer's sessions the host does the sharing: pass `claims.held` (dedupe key to time) and `claims.active` (live `${flowId}:${anchor}` pairs) on every turn, and write `started[].dedupeKey` into a unique index in the same transaction as the save.

## Anchors

A flow's `anchor` is `'session'` by default: the run belongs to this conversation. Any other name (`'lead'`) is looked up in the turn's `anchors` (`{ lead: { key: 'lead:456', lastInboundAt } }`), and that key becomes `run.anchor`, so there is one run per customer across every conversation with them. A missing anchor falls back to the session id. `lastInboundAt` lets a silence wake see that the customer wrote in another conversation.

## Five rules that always hold

From the design record, `docs/rfc/v4-one-flow.md` §5, adjusted only where the code differs.

- I1. The saved session is the unit of consistency: `load(v) → turn → save(expectedVersion = v)`. A losing turn is discarded and the same input replayed.
- I2. Messages, schedules, claims and ended runs leave the host's hands only after a successful save. `do` handlers are the exception: they run inside the turn, **at-least-once**, and must be idempotent on `ctx.key` (or `ctx.dedupeKey` for `once`/cooldown flows shared across a customer's sessions). `always` flows cannot be made exactly-once across sessions by the framework.
- I3. A run wake is honoured only by the run whose `waiting.key` equals it; a silence wake only when the saved session still shows that silence. Everything else is ignored, `changed: false`. Nothing is ever cancelled; `replaces` is a best-effort hint.
- I4. Every `do` and message carries `key = ${runId}:${stepId}:${visit}`; run ids come from host keys (message `id`, event/start `key`, the silence timestamp, parent run), so a replay of the same input builds the same keys and a revisit builds new ones.
- I5. A run's claim is written in the same save as its first step; a run never exists without its claim.

The one adjustment is in I4. The RFC says "wake key"; the code keys a silence run by `lastAssistantAt` in milliseconds (`retomar#1789898400000`), not by the whole wake key.
