---
title: "Go to production"
description: "Run Ana on a real channel: keep sessions in a store, save before you send, put timers in a queue, and bring 3.x sessions over."
type: tutorial
order: 5
---

# Go to production

The framework never sends a message, never sleeps and never saves. Every turn returns what to send, when to wake up and the new state; the program that calls `turn()` does the rest. This page calls that program the host. Its loop is short:

1. Load the session for this conversation.
2. Call `agent.turn()` with the input.
3. If `r.changed`, save `r.session` with the version you loaded. If another turn saved first, the save throws; run the same input again.
4. Only then send `r.messages` and put `r.schedule` in a queue.
5. When a queued job fires, call `turn()` with `{ wake: key }`.

## A store

A store keeps sessions. It has two methods, `load(id)` and `save(session, expectedVersion)`, and the framework never calls either. Start in memory:

```ts
import { MemoryStore } from "@falai/agent";

const store = new MemoryStore();
console.log(await store.load("demo")); // null: no session yet
```

`MemoryStore` forgets everything when the process stops. For production, PostgreSQL — the driver is yours to install: `bun add pg`.

```ts
import { Pool } from "pg";
import { PostgresStore } from "@falai/agent";

const store = new PostgresStore({ client: new Pool({ connectionString: process.env.DATABASE_URL }) });
await store.initialize();
```

`initialize()` creates the table when it is missing. One row per session:

```sql
CREATE TABLE IF NOT EXISTS agent_sessions (
  id VARCHAR(255) PRIMARY KEY,
  version INTEGER NOT NULL,
  blob JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)
```

`tables: { sessions: "ana_sessions" }` renames it. If you have a 3.x `agent_sessions` table, point the store at a fresh name: the columns are different, and a v4 store reading a 3.x row throws. The last section moves the old rows over.

`PrismaStore`, `RedisStore`, `MongoStore`, `SQLiteStore` and `OpenSearchStore` take their own clients and behave the same. [Persistence](../guides/persistence.md) has each one's setup.

## The loop

Here is Ana behind a channel and a queue. The agent is the one from the last page; the tool and the action slot in unchanged and are left out for space.

```ts
import { Pool } from "pg";
import {
  falai,
  GeminiProvider,
  PostgresStore,
  SessionConflictError,
  type DataOf,
  type History,
  type OutboundMessage,
  type ScheduleEntry,
  type Silenced,
  type TurnKind,
} from "@falai/agent";

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
type Data = DataOf<typeof f>;

const agent = f.agent({
  name: "Ana",
  provider: new GeminiProvider({ apiKey: process.env.GEMINI_API_KEY ?? "", model: "gemini-2.5-flash" }),
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

// Yours: the channel, the queue and the transcript.
declare function sendWhatsApp(sessionId: string, message: OutboundMessage): Promise<void>;
declare function enqueueWake(sessionId: string, entry: ScheduleEntry): Promise<void>;
declare function loadHistory(sessionId: string): Promise<History>;

const store = new PostgresStore<Data>({ client: new Pool({ connectionString: process.env.DATABASE_URL }) });
await store.initialize();

/** One input in. Messages and wakes go out only after the save. */
async function handle(input: TurnKind & { sessionId: string; silenced?: Silenced }): Promise<void> {
  while (true) {
    const session = await store.load(input.sessionId);
    const history = await loadHistory(input.sessionId);
    const r = await agent.turn({ ...input, session: session ?? undefined, history });
    if (!r.changed) return;
    try {
      await store.save(r.session, session?.version ?? 0);
    } catch (error) {
      if (error instanceof SessionConflictError) continue; // someone saved first: replay the same input
      throw error;
    }
    for (const message of r.messages) await sendWhatsApp(input.sessionId, message);
    for (const entry of r.schedule) await enqueueWake(input.sessionId, entry);
    return;
  }
}

// The channel delivered a message:
await handle({ sessionId: "5511999990000", message: "oi, quero saber como funciona", id: "wamid.HBgL" });
```

Line by line:

**`store.load(sessionId)`** returns the session or `null`. The session id is your conversation id: a phone number, a chat id.

**`agent.turn({ ...input, session, history })`** runs the turn. `session` is `undefined` on a first message; the framework starts a fresh one.

**`if (!r.changed) return`** is the whole handling of a no-op. The framework says nothing changed when a message `id` was already seen, when a wake is stale, or when nothing moved. Save nothing, send nothing.

**`store.save(r.session, session?.version ?? 0)`** is a compare-and-swap. `0` means "insert; fail if a row exists". Any other number means "update the row that still has this version". Every store bumps the version by one on success.

**`SessionConflictError`** means another turn on the same session saved first: a wake and a message arrived at once, or two webhooks raced. Nothing has been sent yet, so the fix is to throw the result away and go around the loop: load the new version, run the same input again. The replay produces the same message and action keys, so nothing reaches the customer twice. The only cost is the lost turn's model calls.

**Send, then schedule.** Messages and wakes leave only after the save, so a lost race never sends twice.

## Sending messages

Each `OutboundMessage` has:

| Field | Use it for |
|---|---|
| `text` | The message. |
| `kind` | `"ai"` phrased by the model, `"verbatim"` from a `say` step. |
| `afterMs` | Wait this long before sending. It comes from a `wait` of 10 seconds or less placed before the message; a pause between two bubbles. |
| `key` | `${runId}:${stepId}:${visit}`, the same on a replay. Store it with the outgoing message and skip a key you already sent. |
| `runId`, `stepId` | The run and step that produced the message. Absent on a reply from the idle speaker (its `key` is `idle:<message id>`). |
| `media` | `{ slug }` from a `say` step, when it has one. |

Pass the channel's message id as `id` on every inbound message. It goes into the run id and every key, and a second delivery of the same id is ignored with `changed: false`.

## Timers

A `wait` longer than 10 seconds, a `silence` trigger or an `event` trigger with `after` does not sleep. The turn returns a `ScheduleEntry`; for a step `w1` with `wait: "3d"` it looks like this:

```ts fragment
{ key: "triagem#wamid.HBgL:w1:1790244000000", at: new Date("2026-09-24T10:00:00.000Z") }
```

A `silence` trigger's wake also carries `replaces`: the earlier silence wake it supersedes. Put the entry in your queue with `jobId = key` and the session id in the payload. When `replaces` is set, remove that job; it is best effort, a stale wake is harmless. When the job fires:

```ts fragment
await handle({ sessionId: job.data.sessionId, wake: job.data.key });
```

Only the run still waiting on that exact key honours the wake. Anything else returns `changed: false` with one line in `r.outcomes`: `code: 'stale-wake'` for a wait that a reply already resolved, `code: 'silence-broken'` when the customer wrote after the silence wake was set, `code: 'no-session'` when there is no session. So you do not have to cancel jobs: fire every one and the framework drops the stale ones.

`fakeClock` and `MemoryScheduler` are the test doubles for this: [Testing](../guides/testing.md) plays a two-day follow-up in one test.

## On every input

**`history`** is everything said before this input, as `{ role, content }` items, ending with Ana's last reply. Do not add the message you are passing now: the framework quotes it in the prompt itself, so it would reach the model twice. The framework does not keep it; you do, and you pass it on every input, wakes included. A wake carries no text, so the history is all the model knows about the conversation when Ana speaks first after a timer. `userMessage` and `assistantMessage` build the items:

```ts
import { assistantMessage, userMessage, type History } from "@falai/agent";

const history: History = [
  userMessage("oi, quero saber como funciona"),
  assistantMessage("Oi! Com quem eu falo, e de qual empresa?"),
];
```

**`silenced`** is the reason Ana must not speak right now: a human took the conversation, the channel's 24-hour window is closed, the account has no credits. Pass it on any input, as a string or as `{ reason, understand: true }`. A plain string spends zero model calls and sends nothing; `do` steps still run.

A run that was already asking stays asking and speaks when the gate opens. A run that reaches a new talk step while silenced ends, and the log says `code: 'silenced'` with your reason in `detail`. Keep calling `turn()` for every inbound even while a human owns the customer, so waits resolve and the state stays true. `silenced: { reason, understand: true }` still spends the understand call, so fields keep landing while nothing is said.

**`context`** is the per-turn data your flows and actions read, such as the customer record. It is typed once, `falai<Ctx>()`, and passed on every input. Ana has none. [Agent](../reference/agent.md) has the full `TurnInput`.

## Sessions from before v4

A 3.x session blob has `currentFlow`, `currentStep` and `signals`. Convert it once, where you read the row, and save it into the new table:

```ts
import { migrateSession, type Session } from "@falai/agent";

function readRow(sessionId: string, blob: unknown): Session {
  return migrateSession(blob, { sessionId, flowIdOf: (id) => id });
}
```

A v4 blob passes through checked. A 3.x blob becomes one run at the same step id, plus a claim for every 3.x signal that fired and every flow that completed, so nothing fires twice. `flowIdOf` maps an old flow id or signal key to the v4 flow id; `(id) => id` when you kept the ids. The result has `version: 0`, so the usual `store.save(session, 0)` is the insert into the new table. Anything that is neither v4 nor a recognisable 3.x blob throws `InvalidSessionError`: a broken row is a loud error, never a fresh conversation that re-asks everything. [v3 → v4](../migration/v3-to-v4.md) has the full recipe.

## Streaming

`agent.turnStream(input)` yields `{ delta }` chunks while the model writes, then one `{ done: true, result }`. The `result` is the same `TurnResult`, and the loop above applies to it unchanged. [Streaming](../guides/streaming.md) shows it.

## Where next

Ana works. To understand what you built, read [Architecture](../concepts/architecture.md) and [The turn](../concepts/pipeline.md). To make her start a conversation on her own, read [Triggers](../guides/triggers.md): `silence` brings back a customer who went quiet, `event` reacts to your system. For the exact shape of every option, start at [Agent](../reference/agent.md).
