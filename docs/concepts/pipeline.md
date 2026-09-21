---
title: "The turn pipeline"
description: "The eight phases of one agent.turn() call, what each one does and what each one spends."
type: concept
order: 2
---

# The turn pipeline

One turn is one call to `agent.turn(input)`. The input is a message, a wake, an event or a manual start. All four run the same eight phases, in the same order. Two phases may call the model, once each. The rest is code.

| # | Phase | Who | What it does | Spends |
|---|---|---|---|---|
| 1 | Load | code | Reads the clock, copies the session or creates one, trims the history when `compaction` is set | 0, or 1 when a summary is written |
| 2 | Ingest | code | Records the input, resolves waits, starts event and manual runs | 0 |
| 3 | Understand | model | Judges the customer's message: routing, mentions, branches, field values | 0 or 1 |
| 4 | Decide | code | Applies the judgement: starts and resumes runs, writes fields, fires a branch | 0 |
| 5 | Run | code | Moves every run that can move until it asks, parks or ends | 0 |
| 6 | Speak | model | Phrases the one reply and extracts the step's fields | 0 or 1, plus 1 per tool round |
| 7 | Settle | code | Applies what was spoken, re-parks on failure, arms silence wakes | 0 |
| 8 | Return | code | Builds the `TurnResult` | 0 |

`Agent.turn()` in `src/core/Agent.ts` is these phases in one line each: `Runner.begin` (1 and 2), `Understand.run` (3), `Runner.decide` (4), `Runner.advance` (5), `Speak.run` (6), `Runner.settle` (7), `Runner.finish` (8).

```ts
import type { Agent } from "@falai/agent";
declare const agent: Agent; // one flow, one collect step; see Architecture

const r = await agent.turn({ sessionId: "s1", message: "oi" });
console.log(r.llmCalls); // 1: one flow, nothing to judge, one speak call
console.log(r.outcomes.map((o) => [o.stepId, o.status, o.detail]));
```

## 1. Load

`now` comes from the agent's `clock` (default: the system time). The session you passed is deep-copied; the input is never mutated. No session means a fresh one: `{ id: sessionId, v: 4, version: 0, data: {}, runs: [], claims: {}, inputs: [], metadata: {} }`. A `wake` with no session does nothing: outcome `code: 'no-session'`, `changed: false`.

A session saved by 3.x is the host's job: run `migrateSession` where you deserialize, before `turn()`. See [Persistence](../guides/persistence.md).

When the agent has `compaction`, the history is trimmed here, once per turn, before either call sees it. Only the last layer (`auto_compact`, a written summary) calls the model, and it counts as one call in `llmCalls`. See [Compaction](../guides/compaction.md).

## 2. Ingest

What happens depends on the input kind.

**Message.** An `id` the session already saw (it keeps the last 50) is dropped: `code: 'duplicate-input'`, `changed: false`. Otherwise the id is recorded and `lastUserAt` is set to `at` (or `now`). Then every run parked on a timer `wait` with an `else` takes that `else`, in the order the runs started: the customer replied before the timer ran out. Outcome `code: 'replied'`.

**Wake.** A key starting with `silence:` is a silence wake: it starts the silence flow only while the session still shows that silence (see [Runs and waits](./runs-and-waits.md#wakes)). Any other key belongs to the one run whose `waiting.key` equals it. That run goes back to `running`, and its step says what the wake means: `code: 'no-reply'` on a timer wait, `code: 'no-event'` on an event wait, or a deferred `do` about to run again. No such run: `code: 'stale-wake'`, `changed: false`.

**Event.** An `inbound` event counts as the customer speaking: it sets `lastUserAt` and resolves reply waits like a message. An `outbound` one counts as the assistant speaking and sets `lastAssistantAt`. Every run parked on `wait: { event }` for this name takes `then` (`code: 'event-arrived'`). Then every flow with a matching `event` trigger goes through the [start checks](./runs-and-waits.md#starting-a-run); the payload becomes the run's `input`, and `after` parks the new run before its first step (`code: 'awaiting-trigger'`).

**Start.** The named flow goes through the start checks with the host's `key` and `input`. A flow the agent does not have leaves `code: 'flow-gone'` in `skipped`.

A run that takes or resumes the floor here (a resolved wait, a wake) makes phase 4 skip routing: the customer is answering that run.

## 3. Understand

Only a `message` turn reaches this phase. It is skipped under `silenced` unless you passed `{ reason, understand: true }`.

Code first works out what there is to judge:

- **Candidates**: the flow holding the floor, whatever its trigger, plus every `message` flow with a non-empty phrase list whose `if` holds and whose `repeat` allows a start, in flow order. `message: []` catch-alls are never scored.
- **Mentions**: every `mention` flow with a non-empty list whose `repeat` allows a start.
- **Branches**: the `when` branches of the asking step.
- **Fields**: every unknown field with `extract: 'anywhere'` listed by any talk step of the floor's flow or of a candidate flow.

Then the shortcuts, each worth zero calls:

- Nothing to judge: no call. The catch-all or the idle speaker answers.
- Exactly one eligible `message` flow, nobody on the floor, nothing else to judge: it starts without scoring.
- A floor holder, no other candidate, nothing else to judge: there is nothing to compare.

Otherwise one call, `schemaName: 'understand'`, with one envelope: `{ flows: { id: 0–100 }, mentions: { id: boolean }, extract: { id: { … } }, branches: { q1: boolean }, fields: { field: value } }`. Only the sections with something to judge are present; inside a section every property is required and nullable, so the model must answer each one. Branch keys travel as short aliases (`q1`, `q2`) because a run id is not a legal property name; they are mapped back to `${runId}/${stepId}/${index}` when the reply is parsed. A reply with no usable JSON is logged and treated as an empty judgement; the call still counts. A provider failure here throws `ProviderError`: nothing ran, nothing was saved, and the host retries the input.

## 4. Decide

Code applies the judgement in a fixed order.

1. **Routing**, skipped when a run took the floor in Ingest. With an asking run, another flow takes over only when its score is at least 40 and beats the asker's by at least 15. With no asker: a single eligible flow starts as is; otherwise the best score at 40 or above starts, else the first `message: []` catch-all, else nobody, and the idle speaker answers in phase 6. A `suspended` run of the chosen flow resumes instead of a new one starting.
2. **Mention runs** start in flow order. A `mention: []` trigger is a code-only detector: it goes through the start checks on every message without the call, so a blocked `repeat` is logged as a skip. A trigger's `extract` values become the run's `input`.
3. **The routed run** starts or resumes and holds the floor. A run that starts applies `clearOnStart` now, before extracted values land.
4. **Fields** from the envelope are written one at a time, after validation. An unknown field name is dropped (`code: 'unknown-field'`), a value that does not fit the type is dropped (`code: 'bad-value'`), a value outside `enum` is dropped (`code: 'not-in-enum'`). Strings are coerced to numbers and booleans on the way in.
5. **The first true branch** of the asking step takes its `then` (`code: 'branch'`): `if` branches by code, `when` branches from the envelope.

## 5. Run

If no run is asking, the most recently suspended one returns to asking. Then every live run is moved in turn; a child started by `then: { flow }` joins the queue. A run moves only if it can: `waiting` and `suspended` runs stay put, and an asking run re-speaks only on a message, never on a wake or an event.

Before a run moves, its premise is re-checked with this turn's context: `while` when the flow has one, otherwise the trigger's `if`. A false premise ends the run: `code: 'premise-changed'`. A silence-started run moved by a wake also ends when the customer has written since it started: `code: 'customer-replied'`. A flow the agent no longer has ends the run with `code: 'flow-gone'`; a missing step, `code: 'step-gone'`.

Then the run walks its steps until one stops it.

- **Talk** (`prompt` / `collect`). Pending is `collect` minus known minus at `maxAsks`. A collect step with nothing pending is skipped with no call (`code: 'already-known'`) and the run continues. Under `silenced`, a resuming asker stays asking and any other run ends `code: 'silenced'` (`detail` = your reason). Otherwise every other asking run is suspended, this run becomes `asking`, and it is the turn's speaker, unless speaking already happened this turn, in which case it waits for the next message.
- **Say.** The text goes to `messages[]` as `kind: 'verbatim'` with the pending `afterMs`. `once` writes a claim; a repeat is `code: 'already-sent'`. Under `silenced` the run ends `code: 'silenced'` (`detail` = your reason).
- **Do.** The action runs now, with `with` rendered against `data`, `context` and `input`, under `key = ${runId}:${stepId}:${visit}`. `{ ok }` continues (`spoke: true` makes this run the one that answered); `{ skipped }` continues (`code: 'action-skipped'`); `{ failed }` takes `onFail` or continues (`code: 'action-failed'`); `{ defer }` parks the run under a new wake and re-runs the same step, same key, when it fires. An unknown action is `code: 'action-failed'` with `detail: 'unknown action "notify"'`; a thrown error is `code: 'action-failed'`, the error message in `detail`.
- **Wait** (timer). Ten seconds or less, when the next step is a `say` or a talk step: the delay rides on that message as `afterMs` (`code: 'inline-delay'`, `detail: '3000ms'`). Anything else parks the run and adds `{ key, at }` to `schedule[]`, with `at` moved forward to the next business hour when the step sets `businessHours: true`.
- **Wait** (event). Parks until the event arrives or `upTo` passes (default 30 days).
- **If.** `then` when the predicate holds, else `else` (default `'end'`).

Caps: 50 steps per run per turn (`code: 'step-loop'`), 5 hops of flow-to-flow chaining (`code: 'hop-limit'`).

## 6. Speak

One speaker per turn. It is the talk step phase 5 queued or, on a message with no run asking and nothing said yet, the idle speaker: `idle` on the agent, a prompt; `'silent'` mutes it; left unset, it answers with no guideline of its own. Under `silenced` nobody speaks and no call is made.

One rule protects the customer from two answers: when a run other than the floor holder already answered the message this turn (a `say`, or a `do` that returned `spoke: true`), the floor's talk is skipped (`code: 'another-reply'`) and that run stays asking for the next message. A run's own `say` never silences its own talk.

The prompt is built per call, in `src/core/Speak.ts`, in this order:

- identity: name, persona, goal
- the knowledge base
- the flow's name and description
- the step's `prompt`, or a default guideline
- the pending fields with their `ask`
- the known fields, as settled facts
- the instructions whose `if` holds: agent, then flow, then step
- the customer's message, or, on anything but a message (a wake, an event, a start), a note that there is no new message and the assistant speaks first
- the response format

The envelope is `{ message, ...pending fields of this step }`, every property required and nullable, so one call both answers and extracts. Tools run in rounds. Each round is one call; the model may call tools, their results go back as history, and it is asked again. After `maxToolLoops` rounds (default 5; `0` disables tools) it is asked once more without tools, so a message always comes back. Field values merge across rounds, last one wins. A provider failure or an empty message returns `deferred` instead of throwing; phase 7 re-parks the step.

## 7. Settle

The one place the spoken result is applied.

**Spoken.** The message goes to `messages[]` as `kind: 'ai'` with `key = ${runId}:${stepId}:${visit}`, or `idle:<trigger key>` for the idle speaker. Envelope values are validated and written like phase 4; tool `data` patches are written as given. Pending is recomputed. Each field still pending gets `asked + 1` and the run stays `asking`. Nothing pending: a field that hit `maxAsks` is reported (`code: 'max-asks'`, one line per field), the run takes `then` and keeps moving this turn, except that a talk step reached now waits for the next message.

**Deferred.** The talk step is re-parked under `${runId}:${stepId}:${visit}:retry:${atMs}`: one minute out, then five, then fifteen on later failures, outcome `code: 'provider-unavailable'`. The session is saved with everything phase 5 did. The retry wake re-runs the step under the same key, so the `do` steps before it do not run again.

Then three bookkeeping moves. `lastAssistantAt` is set when anything went out. The most recently suspended run resumes when nobody is asking. And when the assistant spoke last, every `silence` flow whose `if` and `repeat` allow it gets a wake at `lastAssistantAt + silence`, key `silence:${flowId}:${sessionId}:${lastAssistantAtMs}`, with `replaces` naming the previous one.

## 8. Return

`TurnResult`: `session` (version unchanged; the host bumps it on save), `changed`, `messages` in emission order, `schedule`, `outcomes`, `started`, `ended` (each with a reason), `skipped` (triggers that matched but did not start, with the reason), `llmCalls`. `changed` is `false` when the input was ignored — a repeated message id, a wake with no session, a wake nothing is waiting for — or when the session came back identical with no message, no wake, no outcome and no skip to show for the turn.

## The budget

Every row but the last is asserted by a scenario in `tests/scenarios/`; the compaction row is read off `Agent.compacted` in `src/core/Agent.ts`. The mock provider in the scenarios throws when it runs out of scripted replies, so a turn that spends one call too many fails loudly.

| Turn | Calls | Why | Scenario |
|---|---|---|---|
| A message with a floor holder or several candidate flows | 2 | understand, then speak | S1 |
| A message when one flow is eligible and nothing else needs judging | 1 | speak only | S0, S1 |
| A message with no flows, answered by the idle speaker | 1 | speak only | S9 |
| A message where a mention flow's `say` answers | 1 | understand only; the floor's talk is skipped | S4 |
| Each tool round | +1 | one more speak call | S8, S9 |
| A wake or start that reaches a talk step | 1 | speak only; there is no message to understand | S2, S5, S12 |
| A wake or start that runs only `do`, `wait` and `if` steps | 0 | code only | S5 (the start; its defer test covers the wake) |
| Any input under `silenced` (a plain reason) | 0 | `do` steps run, nobody speaks; `{ reason, understand: true }` still spends the understand call | S2, S12 |
| A message with `idle: 'silent'` and no eligible flow | 0 | nothing to judge, nobody speaks | S9 |
| A compaction summary | +1 | once per turn, before both calls | `Agent.ts` |

`llmCalls` is on every `TurnResult`, and on the outcome line of the talk or idle step that spent it.
