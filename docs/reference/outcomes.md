---
title: "Outcomes"
description: "Every line a turn writes about what a run did, with the full list of outcome codes and what produces each."
type: reference
order: 13
---

# Outcomes

A turn writes one line per thing a run did: a step ran, a step was skipped, a run parked, a value was dropped. Those lines are `StepOutcome`s. They come back on `TurnResult.outcomes` and stay on each run as `run.outcomes` (the last 50). Beside them, `TurnResult.started`, `ended` and `skipped` say which runs began, which ended and why, and which triggers matched but started nothing. This page lists every line the code can write, so a panel that shows runs can label each one.

Source: `src/types/session.ts`, `src/types/agent.ts`, `src/core/Runner.ts`, `src/core/Speak.ts`, `src/utils/outcomes.ts`, `src/utils/schema.ts`.

## Signature

```ts fragment
type StepOutcomeKind = "prompt" | "collect" | "say" | "do" | "wait" | "if" | "idle";
type StepOutcomeStatus = "ok" | "skipped" | "failed" | "waiting" | "deferred";

type StepOutcomeCode =
  // The turn refused the input
  | "no-session" | "duplicate-input" | "stale-wake" | "silence-broken"
  // A trigger matched but started nothing
  | "already-claimed" | "cooldown" | "hop-limit" | "already-running" | "flow-gone"
  // A run ended early
  | "step-loop" | "step-gone" | "customer-replied" | "premise-changed" | "silenced"
  // A step
  | "already-known" | "asked-fixed" | "another-reply" | "already-sent" | "branch" | "max-asks"
  | "inline-delay" | "awaiting-trigger" | "awaiting-event" | "event-arrived"
  | "no-event" | "replied" | "no-reply"
  // A host action
  | "action-skipped" | "action-failed" | "action-deferred"
  // A value the model gave
  | "unknown-field" | "bad-value" | "not-in-enum"
  // The model
  | "provider-unavailable" | "provider-quota" | "provider-auth"
  | "provider-context" | "provider-invalid";

interface StepOutcome {
  runId?: string;
  flowId?: string;
  stepId?: string;
  key?: string;
  kind: StepOutcomeKind;
  status: StepOutcomeStatus;
  /** Why. Absent when the line needs no reason. Switch on this. */
  code?: StepOutcomeCode;
  /** The English sentence for `code`, filled by the framework. */
  message?: string;
  detail?: string;
  next?: string;
  until?: string;
  at: string;
  llmCalls?: number;
}

type EndReason = "end" | "flow" | "reset" | "skipped" | "failed" | "replaced";

interface TurnResult<D = unknown> {
  outcomes: StepOutcome[];
  started: Array<{ runId: string; flowId: string; anchor: string; dedupeKey: string }>;
  ended: Array<Run & { reason: EndReason }>;
  skipped: Array<{ flowId: string; anchor: string; triggerKey: string; code: StepOutcomeCode; message: string }>;
  llmCalls: number;
  // session, changed, messages, schedule: see Agent
}
```

## StepOutcome fields

| Field | Type | Meaning |
|---|---|---|
| `runId` | `string` | `${flowId}#${triggerKey}`. Absent on lines that belong to no run (an ignored input, a dropped value, the idle speaker). |
| `flowId` | `string` | The run's flow. Absent whenever `runId` is absent. |
| `stepId` | `string` | The step the line is about. Absent when the run has not entered a step, and whenever `runId` is absent. |
| `key` | `string` | Three shapes: `${runId}:${stepId}:${visit}` on a step line, the input's own key on an ignored input, `idle:${triggerKey}` on the idle speaker's `ok` line. Absent on three kinds of line. A run-ending line. A wait line written during Ingest (`replied`, `no-reply`, `no-event`, `event-arrived`, `awaiting-trigger`) — a message turn writes `replied` too, when the customer's reply resolves a parked `wait`. And a `collect / skipped` line for a value the model gave that could not be written (`unknown-field`, `bad-value`, `not-in-enum`). |
| `kind` | `StepOutcomeKind` | What kind of step. `prompt` and `collect` are both talk steps: `collect` when the step has a non-empty `collect` list. `idle` is the idle speaker. |
| `status` | `StepOutcomeStatus` | See below. |
| `code` | `StepOutcomeCode` | Why the line says what it says. Switch on this; it is stable across versions. Absent when the line needs no reason (a step that simply ran). |
| `message` | `string` | The English sentence for `code`, copied in by the framework so a log reads on its own. To show a line in another language, map `code` yourself. The whole table is exported as `OUTCOME_MESSAGES`. Absent whenever `code` is. |
| `detail` | `string` | Text this one occurrence adds: the field slug (`unknown-field`, `bad-value`, `not-in-enum`, `max-asks`), the action's own words (`action-skipped`, `action-failed`, `action-deferred`), your `silenced` reason, the event name (`awaiting-event`), `"5000ms"` (`inline-delay`). |
| `next` | `string` | Where the step's `then` sent the run: a step id, `end`, or `flow:<id>` when it chained into another flow. Absent when the step has no `then` (the run still moves to the next step in order), when it parked, when the line does not move it, and on the talk step's `ok` line after a speak call. |
| `until` | `string` | ISO time of the wake, on `waiting` and `deferred` lines. |
| `at` | `string` | ISO time of the turn (the agent's clock). |
| `llmCalls` | `number` | Model calls the speak call spent. Present on the talk step's `ok` line and on both idle lines (`ok` and `deferred`). The talk step's `deferred` line does not carry it; `TurnResult.llmCalls` still counts those calls. |

### Statuses

| Status | Meaning |
|---|---|
| `ok` | The step did its job and the run moved (or is now asking). |
| `skipped` | Nothing happened here, on purpose. `code` says why. |
| `failed` | An action returned `failed`, or the run hit the 50-step cap. |
| `waiting` | The run parked. `until` says when the wake fires. |
| `deferred` | The step will be tried again later: an action asked for it, or the provider failed. |

### Where lines land

- `TurnResult.outcomes`: every line of this turn, in order, run lines and no-run lines alike.
- `run.outcomes`: the run's own lines, kept to the last 50, on the run inside `session.runs` and inside `TurnResult.ended`.
- `TurnResult.changed` is `false` when the input was ignored; the one ignored-input line is still on `outcomes` so you can log it, but there is nothing to save or send.

## Every code

Grouped by what produced it. `kind` and `status` are given as `kind / status`. A blank `code` cell means the line carries no code at all.

### The input was ignored

`wait / skipped`, no run, `key` = the input's key, `changed: false`.

| `code` | When |
|---|---|
| `no-session` | `turn({ wake })` with no `session`. A wake never creates a session. |
| `duplicate-input` | `turn({ message, id })` with an `id` already among the session's last 50 input ids. A replay of an already applied message. |
| `stale-wake` | A wake key that no live run is waiting on. The run moved on, ended, or was re-parked under a newer key. |
| `silence-broken` | A silence wake whose time no longer matches `lastAssistantAt`, or the customer wrote since. The assistant or the customer spoke after the wake was set. |

### Waits and wakes

| `kind / status` | `code` | When | `next` |
|---|---|---|---|
| `wait / ok` | `inline-delay`, `detail` = `"5000ms"` | A `wait` of 10 s or less, followed by a `say` or talk step, became the next message's `afterMs` delay. No wake. | `then` |
| `wait / waiting` | none | A timer `wait` parked. Wake key `${runId}:${stepId}:${atMs}`. | |
| `wait / ok` | `no-reply` | The wake fired and the customer had not written since the wait was set. | `then` |
| `wait / ok` | `replied` | The customer wrote (a message, or an `inbound` event) while a timer `wait` with `else` was parked; or the wake fired after the customer had written. | `else`; when the customer's reply resolves the wait (a message or an `inbound` event), a matching `if` branch's `then` wins. When the wake fires after the customer had written, always `else` |
| `wait / waiting` | `awaiting-event`, `detail` = the event name | A `wait: { event }` parked. `until` = now + `upTo` (default 30 days). | |
| `wait / ok` | `event-arrived` | The event was reported before `upTo`. | `then` |
| `wait / ok` | `no-event` | The `upTo` wake fired first. | `else`, or `end` |
| `wait / waiting` | `awaiting-trigger` | A run started by an `event` trigger with `after` parked before its first step. Wake key `${runId}:start:${atMs}`. | |

### Talk steps (`prompt` / `collect`)

| `kind / status` | `code` | When | `next` |
|---|---|---|---|
| `prompt` or `collect / ok` | none; `llmCalls` set | The speak call answered. The run is asking if fields are still pending, else it moved. | none. This line never carries `next`, even when the run moves on; the lines that follow show where it went |
| `collect / skipped` | `already-known` | The step was entered and every field it collects was already known (or at `maxAsks`). No call. | `then` |
| `collect / ok` | `asked-fixed` | The step's `question` went out word for word as its first ask. No call; the run is asking. | |
| `collect / ok` | none, no `llmCalls` | An asking step whose remaining fields were all known when the customer's next message resumed it: the understand call filled them in from the message, or an action's `ctx.set()` or a tool's `data` had written them since the step last asked. It moved without speaking. | `then` |
| `collect / skipped` | `max-asks`, `detail` = the field slug | One line per field still unknown when the step moves on because that field reached `maxAsks` (default 3). | |
| `prompt` or `collect / ok` | `branch` | A branch of the asking step fired: an `if` branch held, or the model answered `when` with true. | the branch's `then` |
| `prompt` or `collect / skipped` | `another-reply` | On a message turn, another run's `say` or an action with `spoke: true` already answered. The talk waits; the run stays asking. | |
| `prompt` or `collect / skipped` | `silenced`, `detail` = your reason | The step was reached fresh while `silenced`. The run ends (`reason: 'skipped'`). A step that was already asking stays asking silently and writes no line. | |
| `prompt` or `collect / deferred` | `provider-unavailable`, `provider-quota` | Waiting can still fix it: the provider was down, slow, rate-limited, or returned an empty message; or a usage window said when it reopens. The step is re-parked under `${runId}:${stepId}:${visit}:retry:${atMs}` at +1m, +5m, +15m, +1h, +6h, or at the stated reset when that is later. `until` set. | |
| `prompt` or `collect / failed` | `provider-auth`, `provider-context`, `provider-invalid`, `provider-quota` | Waiting cannot fix it: a rejected key, a prompt past the context window, a request the provider refused, a spent balance with no stated reset. No wake; the run ends `failed`. | |
| `prompt` or `collect / failed` | `provider-unavailable` | The retryable ladder ran out — six failures on the same step. The run ends `failed`. | |

### Say steps

| `kind / status` | `code` | When | `next` |
|---|---|---|---|
| `say / ok` | none | The text went into `messages[]` with `kind: 'verbatim'`. | `then` |
| `say / skipped` | `already-sent` | `once: true` and this step already sent in this session (claim `${flowId}:${stepId}:${sessionId}`). | `then` |
| `say / skipped` | `silenced`, `detail` = your reason | Reached while `silenced`. The run ends (`reason: 'skipped'`). | |

### Do steps

The action's own words arrive in `detail`, unprefixed, exactly as it returned them.

| `kind / status` | `code` | When | `next` |
|---|---|---|---|
| `do / ok` | none; `detail` when the action gave one | The action returned `{ ok: true }`. | `then` |
| `do / skipped` | `action-skipped`, `detail` = the action's words | The action returned `{ skipped: reason }`. | `then` |
| `do / failed` | `action-failed`, `detail` = the action's words | The action returned `{ failed: reason }` or threw, and then the error message is the reason. | `onFail`, else `then` |
| `do / failed` | `action-failed`, `detail: 'unknown action "notify"'` | The action name is not registered. The agent constructor refuses such a flow, so this appears only if registries changed under a running agent. | `onFail`, else `then` |
| `do / deferred` | `action-deferred`, `detail` = the action's words | The action returned `{ defer, detail }`. Wake key `${runId}:${stepId}:${atMs}`; the same step re-runs at the same visit, same `ctx.key`. `until` set. | |

### If steps

| `kind / status` | `code` | When | `next` |
|---|---|---|---|
| `if / ok` | none | The predicate was judged. | `then` on true; `else` or `end` on false |

### Values the model gave

`collect / skipped`, no run, `detail` = the field slug. The understand or speak call reported a value that could not be written.

| `code` | When |
|---|---|
| `unknown-field` | The model named a field the agent does not have. |
| `bad-value` | The value could not be turned into the field's type (`string`, `number`, `integer`, `boolean`). Strings become numbers and booleans when they parse; `sim`/`não` count as booleans. |
| `not-in-enum` | The value is not in the field's `enum`. |

Tool `data` is written without these checks and never produces these lines.

### The idle speaker

No run.

| `kind / status` | `code` | When |
|---|---|---|
| `idle / ok` | none; `llmCalls` and `key` (`idle:${triggerKey}`) set | No run held the floor on a message turn and `idle` is not `'silent'`; the model answered. |
| `idle / deferred` | any `provider-*` code; `llmCalls` set, no `key` | The idle speaker's call failed or came back empty. No retry wake either way: it has no step to re-park, and the next message tries again. |

### A run ended early

The run leaves `session.runs`, appears in `TurnResult.ended`, and writes one line whose `kind` is the current step's kind, or `if` when the run had not entered a step yet.

| `status` | `code` | `reason` on `ended` | When |
|---|---|---|---|
| `skipped` | `premise-changed` | `skipped` | The flow's `while` (default: the trigger's `if`) stopped holding when the run was about to move. |
| `skipped` | `customer-replied` | `skipped` | A silence run woke up, but the customer had written since the run started. |
| `skipped` | `flow-gone` | `skipped` | The run's flow is no longer on the agent. |
| `skipped` | `step-gone` | `skipped` | The run's step id, or a `then` target, is no longer in the flow. |
| `skipped` | `silenced`, `detail` = your reason | `skipped` | A talk or `say` step reached while `silenced` (see above). |
| `failed` | `step-loop` | `failed` | The run moved through 50 steps in one turn. A cycle with no wait, talk or end. |

## End reasons

`TurnResult.ended` carries each ended run with its `reason`:

| `reason` | When |
|---|---|
| `end` | The run passed its last step, hit `then: 'end'`, or `onEnd` is `'end'` (the default). |
| `flow` | The run followed `then: { flow }`; a child run started at `hop + 1`. |
| `reset` | `onEnd: 'reset'`: this run closed and a fresh run of the same flow started at step one, data kept, `hop + 1`. |
| `skipped` | One of the codes above: `premise-changed`, `customer-replied`, `flow-gone`, `step-gone` or `silenced`. |
| `failed` | `step-loop`. |
| `replaced` | The run was parked on its trigger's `after` (no step entered) and the same trigger fired again: the new run takes its place. |

## Triggers that matched but started nothing

`TurnResult.skipped` entries have `{ flowId, anchor, triggerKey, code, message }` and write no `StepOutcome`.

| `code` | When |
|---|---|
| `already-claimed` | `repeat: 'once'` and this flow already ran for this session or anchor; or `repeat: 'always'` and this exact trigger key was already used (a replayed event, start or chain). |
| `cooldown` | `repeat: { cooldown }` and the last run is younger than the cooldown. |
| `already-running` | A live run of this flow exists for this anchor, in this session or (through `turn({ claims })`) in another of the customer's sessions. |
| `hop-limit` | The start would be at hop 5. `{ flow }` jumps and `onEnd: 'reset'` each add a hop. |
| `flow-gone` | `turn({ start })`, a silence wake, or a `{ flow }` jump named a flow the agent does not have. |

A trigger whose `if` is false starts nothing and writes nothing.

## Example

```ts
import { falai, GeminiProvider } from "@falai/agent";

const f = falai().fields({
  nome: { type: "string", ask: "Pergunte o nome." },
});

const agent = f.agent({
  name: "Ana",
  provider: new GeminiProvider({ apiKey: process.env.GEMINI_API_KEY ?? "", model: "gemini-2.5-flash" }),
  flows: [
    f.flow({
      id: "triagem",
      name: "Triagem",
      on: [{ message: [] }], // no examples: the catch-all, starts when no other message flow wins
      steps: [
        { id: "quem", collect: ["nome"] },
        { id: "tchau", say: "Obrigada, {{data.nome}}. Um vendedor continua daqui." },
      ],
    }),
  ],
});

const r = await agent.turn({ sessionId: "demo", message: "oi, sou a Ana" });

for (const line of r.outcomes) {
  console.log(`${line.stepId ?? "-"} ${line.kind}/${line.status} ${line.code ?? ""} ${line.detail ?? ""} → ${line.next ?? ""}`);
}
for (const run of r.ended) console.log(`${run.id} ended: ${run.reason}`);
for (const skip of r.skipped) console.log(`${skip.flowId} not started: ${skip.code}`);
console.log(`model calls: ${r.llmCalls}`);
```

## See also

- [Runs and waits](../concepts/runs-and-waits.md): statuses, the floor, wakes and the key table.
- [Session](./session.md): `Run`, `RunStatus` and where `outcomes` live.
- [Error handling](../guides/error-handling.md): what a deferred talk step means for the host.
- [Actions, events, conditions](./actions-events-conditions.md): `ActionResult` and the `do` lines.
