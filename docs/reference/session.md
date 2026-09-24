---
title: "Session"
description: "One conversation's state as JSON: its fields, its runs, the Store contract, and every key the framework builds."
type: reference
order: 10
---

# Session

A session is one conversation's state as one JSON blob. The host loads it, passes it to `turn()`, and saves what comes back with the version it loaded. The framework never saves anything; it returns the new blob on `TurnResult.session`. Everything the framework remembers between turns is in this blob: the live runs, the data collected so far, the claims that stop a flow from starting twice, and the last 50 message ids.

## Signature

```ts fragment
interface Session<D = unknown> {
  id: string;
  v: 4;
  version: number;
  data: Partial<D>;
  runs: Run[];
  claims: Record<string, { at: string }>;
  inputs: string[];
  lastUserAt?: string;
  lastAssistantAt?: string;
  history?: History;
  metadata: Record<string, unknown>;
}

interface Run {
  id: string;
  flowId: string;
  anchor: string;
  dedupeKey: string;
  stepId: string | null;
  status: RunStatus;
  trigger: { kind: TriggerKind; key: string; payload?: unknown };
  input?: unknown;
  hop: number;
  startedAt: string;
  suspendedAt?: string;
  staying?: true;
  waiting?: { kind: "timer" | "event"; key?: string; until?: string; setAt: string; event?: string };
  asked: Record<string, number>;
  visits: Record<string, number>;
  outcomes: StepOutcome[];
}

type RunStatus = "running" | "asking" | "waiting" | "suspended";
type TriggerKind = "message" | "mention" | "silence" | "event" | "start" | "flow";

interface Store<D = unknown> {
  load(id: string): Promise<Session<D> | null>;
  save(session: Session<D>, expectedVersion: number): Promise<Session<D>>;
}
```

From `src/types/session.ts`. Every date is ISO 8601 text, never a `Date`: the blob has to survive `JSON.stringify` and come back the same.

## Session fields

| Field | Type | Who writes it |
|-------|------|---------------|
| `id` | `string` | The host's `sessionId`. A first turn creates the blob with it. On load, `assertSession` rejects a blob whose `id` is not the row's id. |
| `v` | `4` | The framework. Any other value fails `assertSession` with `InvalidSessionError`. |
| `version` | `number` | The store. A fresh blob (first turn, or one from `migrateSession`) has `0`. `save(session, expectedVersion)` stores `expectedVersion + 1` and returns the blob with that number. `TurnResult.session.version` is the loaded version, unchanged. |
| `data` | `Partial<D>` | The turn. Fields land here from the understand call (`extract: 'anywhere'`), from the speak envelope, from a tool's `data`, and from an action's `ctx.set(patch)`. `clear` on a `{ step, clear }` move and `clearOnStart` delete keys. |
| `runs` | `Run[]` | The turn. Live runs only: a run is added when it starts and removed when it ends. The ended run is on `TurnResult.ended` with its `reason`. |
| `claims` | `Record<string, { at }>` | The turn. One entry per started run, under `run.dedupeKey`, written in the same save as the run (invariant I5, see [Runs and waits](../concepts/runs-and-waits.md#five-rules-that-always-hold)). A `say` step with `once` writes `${flowId}:${stepId}:${sessionId}`. Claims of `repeat: 'always'` flows keep the last 50 per flow and anchor; `once` and cooldown claims are never dropped. |
| `inputs` | `string[]` | Ingest. The `id` of every `{ message }` input, last 50. A repeated id ends the turn at once: `code: 'duplicate-input'`, `changed: false`. Wakes, events and starts are not recorded here: an event or start replay is caught by the claim, a wake replay by the run's `waiting.key`. |
| `lastUserAt` | `string?` | Ingest. A message turn writes the input's `at`, or the clock's now when there is none. An event whose `EventDef.direction` is `'inbound'` writes now. |
| `lastAssistantAt` | `string?` | Settle. Written when the turn spoke: a talk step, a `say`, an action that returned `spoke: true`, or the idle speaker. An event with `direction: 'outbound'` writes now. Silence wakes are checked against it. |
| `history` | `History?` | The host, or nobody. The framework never writes it and reads it only when the input carries no `history`. |
| `metadata` | `Record<string, unknown>` | The host. The framework never touches it. `migrateSession` copies a 3.x session's `metadata` with its dates turned into ISO text. |

## Run fields

| Field | Type | Meaning |
|-------|------|---------|
| `id` | `string` | `${flowId}#${triggerKey}`. Deterministic: a replay of the same input mints the same id. |
| `flowId` | `string` | The flow this run executes. |
| `anchor` | `string` | The session id. When the flow declares `anchor` and the input carries `anchors[flow.anchor].key`, that key instead. |
| `dedupeKey` | `string` | `${flowId}:${anchor}:${nonce}`. The claim key. `nonce` is the trigger key under `repeat: 'always'` and empty otherwise. |
| `stepId` | `string \| null` | The current step. `null` before the first step: a run parked on a trigger's `after`. |
| `status` | `RunStatus` | See the next table. |
| `trigger` | `{ kind, key, payload? }` | What started the run. `payload` is the event payload, the `start.input`, a `mention` trigger's extracted values, or a chained run's input; absent when the trigger carried nothing. |
| `input` | `unknown?` | The event payload, the `start.input`, a `mention` trigger's extracted values, or on a chained run the `{ flow, input }` move's `input` (the parent's input when the move has none). Templates read it as `{{input.x}}`. |
| `hop` | `number` | Chaining depth. `0` for a run a trigger started; `+1` per `{ flow }` move and per `onEnd: 'reset'`. A start at hop 5 is skipped: `code: 'hop-limit'` on `TurnResult.skipped`. |
| `startedAt` | `string` | The clock's now when the run started. |
| `suspendedAt` | `string?` | Set while `suspended`. The most recently suspended run is the one that resumes. |
| `staying` | `true?` | Set once an `onEnd: 'stay'` run has finished its steps and sits on its last talk step, answering every message. Any other move clears it. |
| `waiting` | object? | Set while `waiting`. See below. |
| `asked` | `Record<string, number>` | Per field, how many times a talk step spoke with that field still pending. A field at the step's `maxAsks` (default 3, `src/utils/schema.ts`) leaves the pending set: `code: 'max-asks'`, with the field's slug in `detail`. |
| `visits` | `Record<string, number>` | Per step, how many times this run entered it. Part of every message and action key, so a revisit mints new keys. |
| `outcomes` | `StepOutcome[]` | This run's lines, last 50. Every line is also on `TurnResult.outcomes`. |

### RunStatus

| Status | Meaning |
|--------|---------|
| `running` | Moving through steps. The turn's advance loop keeps going while a run is `running`. |
| `asking` | Parked on a talk step, waiting for the customer's next message. At most one run per session is `asking`: it holds the floor, the one run the customer's next message answers (see [Runs and waits](../concepts/runs-and-waits.md)). |
| `waiting` | Parked on a timer or an event. `waiting` says which key wakes it. |
| `suspended` | Was `asking` when another run took the floor. Goes back to `asking` when no other run is `asking`, most recently suspended first. |

### Run.waiting

| Field | Type | Meaning |
|-------|------|---------|
| `kind` | `"timer" \| "event"` | A `wait: '2d'`, a deferred `do`, a trigger's `after` or a retry are timers. `wait: { event }` is an event. |
| `key` | `string?` | The wake key. Only `turn({ wake })` with exactly this key moves the run; any other key is ignored with `code: 'stale-wake'`. The framework always sets it. |
| `until` | `string?` | When the wake is due. An event wait times out after `upTo` (default `30d`, `src/core/Runner.ts`). |
| `setAt` | `string` | When the run parked. A timer `wait` with `else`: a customer message after `setAt` takes `else`, with `code: 'replied'`. |
| `event` | `string?` | For `kind: 'event'`, the event name that releases it. |

## StepOutcome

One line per step for the host's execution log: `{ runId?, flowId?, stepId?, key?, kind, status, code?, message?, detail?, next?, until?, at, llmCalls? }`. `kind` is `prompt | collect | say | do | wait | if | idle`; `status` is `ok | skipped | failed | waiting | deferred`. `code` says why, and is what you switch on; `message` is its English sentence, filled by the framework from `OUTCOME_MESSAGES`; `detail` carries only what this one line is about (a field name, an action's own words, your `silenced` reason). Each run keeps its last 50; the turn returns all of this turn's lines on `TurnResult.outcomes`. The full `code` vocabulary is in [Outcomes](./outcomes.md).

## Store

Two methods, one rule. `load(id)` returns the session or `null`. `save(session, expectedVersion)`:

- `expectedVersion: 0` inserts, and fails if a row already exists.
- Any other value updates only when the stored version is exactly that number.
- A failed check throws `SessionConflictError` with `expectedVersion` and the version it found (`undefined` when the row is gone).
- Success stores `expectedVersion + 1` and returns the session with that version.

The host loop is `load` → `turn` → if `changed`, `save(result.session, loaded?.version ?? 0)` → send `messages[]` → enqueue `schedule[]`. On a conflict, nothing has left the host's hands: load again and replay the same input (invariant I1, see [Runs and waits](../concepts/runs-and-waits.md#five-rules-that-always-hold)). The seven stores are in [Stores](./stores.md).

## Keys

Every key is built from ids the host already has, so a replay mints the same keys and the host can dedupe sends and jobs on them. From `src/core/Runner.ts`.

| Key | Format | Example |
|-----|--------|---------|
| Run id | `${flowId}#${triggerKey}` | `triagem#m1` |
| Message and action key | `${runId}:${stepId}:${visit}` | `triagem#m1:quem:1` |
| Wait wake (a timer `wait`, a `wait: { event }` timeout, a deferred `do`) | `${runId}:${stepId}:${atMs}` | `retomar#1758362400000:w1:1758535200000` |
| Trigger `after` wake | `${runId}:start:${atMs}` | `campanha#ev1:start:1758535200000` |
| Retry wake (the speak call failed) | `${runId}:${stepId}:${visit}:retry:${atMs}` | `triagem#m1:quem:1:retry:1758362460000` |
| Silence wake | `silence:${flowId}:${sessionId}:${lastAssistantAtMs}` | `silence:retomar:s1:1758362400000` |
| Idle message key | `idle:${triggerKey}` | `idle:m1` |
| Dedupe key (the run's claim) | `${flowId}:${anchor}:${nonce}` | `triagem:s1:` or `comentario:s1:ev7` |
| `say` with `once` claim | `${flowId}:${stepId}:${sessionId}` | `boas-vindas:oi:s1` |

The trigger key depends on what started the run:

| Trigger kind | Trigger key |
|--------------|-------------|
| `message`, `mention` | The input's `id`; its `at` when there is no id. |
| `silence` | `lastAssistantAt` as epoch milliseconds, as text. |
| `event` | The input's `key`. |
| `start` | `start.key`. |
| `flow` (a `{ flow }` move or `onEnd: 'reset'`) | The parent step's key, `${parentRunId}:${stepId}:${visit}`. |

## Limits

All from `src/core/Runner.ts`.

| What | Limit | What happens at the limit |
|------|-------|---------------------------|
| `inputs` | 50 | The oldest id is dropped. |
| `always` claims per flow and anchor | 50 | The oldest claim is dropped. `once` and cooldown claims are kept forever. |
| `outcomes` per run | 50 | The oldest line is dropped. |
| `hop` | 5 | The start is skipped: `code: 'hop-limit'`. |
| Steps one run may take in one turn | 50 | The run ends `failed`: `code: 'step-loop'`. |
| Retry wakes after a failed speak call | +1m, +5m, +15m, +1h, +6h | Only for a failure a wait can fix, and only five of them: the sixth ends the run. A provider that stated when its limit reopens is woken then, when that is later. |

## Example

```ts
import { MemoryStore, SessionConflictError } from "@falai/agent";
import type { Session } from "@falai/agent";

type Data = { nome: string };

const store = new MemoryStore<Data>();
console.log(await store.load("s1")); // null: nothing saved yet

const fresh: Session<Data> = {
  id: "s1",
  v: 4,
  version: 0,
  data: { nome: "Ana" },
  runs: [],
  claims: {},
  inputs: [],
  metadata: {},
};

const v1 = await store.save(fresh, 0);
console.log(v1.version); // 1

const loaded = await store.load("s1");
console.log(loaded?.version); // 1

try {
  await store.save(fresh, 0); // a row exists: the insert loses
} catch (error) {
  if (error instanceof SessionConflictError) {
    console.log(error.expectedVersion, error.actualVersion); // 0 1
  }
}
```

## See also

- [Runs and waits](../concepts/runs-and-waits.md): the floor, waits, wakes and the invariants.
- [Stores](./stores.md): the seven `Store` classes and the schema each expects.
- [Outcomes](./outcomes.md): every outcome `code` and when it is emitted.
- [Persistence](../guides/persistence.md): the host loop, `migrateSession` and `assertSession`.
- [Errors](./errors.md): `SessionConflictError` and `InvalidSessionError`.
