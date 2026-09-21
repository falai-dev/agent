---
title: "Persistence"
description: "Where sessions live: the two-method Store, the version check that makes concurrent turns safe, the seven stores, and moving a 3.x row."
type: guide
order: 8
---

# Persistence

A store has two methods: `load(id)` and `save(session, expectedVersion)`. The framework never calls either. You load before a turn and save after it.

```ts
import { MemoryStore } from "@falai/agent";

const store = new MemoryStore();

console.log(await store.load("demo")); // null: no conversation yet
```

`null` means there is no session for that id. You pass nothing to `turn()`, it hands one back in `result.session`, and you save that. `save` returns the session with its new version; the turn never touches the version, so `TurnResult.session.version` is still the version you loaded.

## The Store seam

```ts fragment
interface Store<D> {
  load(id: string): Promise<Session<D> | null>;
  save(session: Session<D>, expectedVersion: number): Promise<Session<D>>;
}
```

The version rules, the same in all seven stores:

| You pass | The store does | Result |
|---|---|---|
| `expectedVersion: 0` | inserts, if no row exists | the row is at version 1 |
| `expectedVersion: n` | updates, if the row is still at `n` | the row is at `n + 1` |
| a version the row is not at | nothing | throws `SessionConflictError` |

```ts
import { MemoryStore, type Session } from "@falai/agent";

const store = new MemoryStore();

const fresh: Session = { id: "demo", v: 4, version: 0, data: {}, runs: [], claims: {}, inputs: [], metadata: {} };
console.log((await store.save(fresh, 0)).version); // 1
console.log((await store.load("demo"))?.version); // 1
```

Nobody writes that literal in real code — it is here to show the insert. In an app the session comes from `turn()`.

The session blob is the unit of consistency. Two turns on the same session both load version 3; both run; the first save moves the row to 4 and the second throws. Nothing the loser computed reaches the customer, because you send messages only after a save succeeds. You load again and replay the same input on version 4.

## The host loop

```ts
import { falai, GeminiProvider, MemoryScheduler, MemoryStore, SessionConflictError, type DataOf, type OutboundMessage, type TurnKind } from "@falai/agent";

const f = falai().fields({
  nome: { type: "string", ask: "Pergunte o nome." },
});
type Data = DataOf<typeof f>;

const agent = f.agent({
  name: "Ana",
  provider: new GeminiProvider({ apiKey: process.env.GEMINI_API_KEY ?? "", model: "gemini-2.5-flash" }),
  flows: [f.flow({ id: "boas-vindas", name: "Boas-vindas", on: [{ message: [] }], steps: [{ id: "nome", collect: ["nome"] }] })],
});

const store = new MemoryStore<Data>();
const scheduler = new MemoryScheduler(); // your queue in production
const outbox: OutboundMessage[] = []; // your channel in production

async function runTurn(input: TurnKind & { sessionId: string }): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const session = await store.load(input.sessionId);
    const r = await agent.turn({ ...input, session: session ?? undefined });
    if (!r.changed) return; // an ignored input: save nothing, send nothing
    try {
      await store.save(r.session, session?.version ?? 0);
    } catch (error) {
      if (error instanceof SessionConflictError) continue; // someone saved first: replay on the new version
      throw error;
    }
    outbox.push(...r.messages);
    for (const entry of r.schedule) scheduler.add(entry);
    return;
  }
  throw new Error(`three conflicts in a row on session "${input.sessionId}": check for a stuck queue worker`);
}

await runTurn({ sessionId: "s1", message: "oi, sou a Ana", id: "m1" });
console.log(outbox[0]?.text, (await store.load("s1"))?.version); // "…", 1
```

Three attempts is enough: a fourth conflict means two workers are firing on the same session, which is a queue problem, not a race.

Three things happen after the save and never before it: messages go out (honouring `afterMs`, keyed by `key`), `schedule[]` entries go into your queue with `jobId = key`, and at fire time you call `turn({ wake: key })` through this same loop. `changed: false` means the input changed nothing (a stale wake, a repeated message id): skip the save and the send.

## What a row holds

Every store writes the same blob and nothing else:

```ts fragment
{
  id, v: 4, version,
  data,              // the collected fields
  runs,              // live runs only
  claims,            // once/cooldown claims, and the last 50 always-claims per flow
  inputs,            // the last 50 message ids, for replay detection
  metadata,          // yours
  lastUserAt?, lastAssistantAt?,
  history?,          // only when the host does not manage history itself
}
```

`undefined` values drop and `Date`s become text on the way in, in every store, including `MemoryStore`, which keeps rows as JSON text for exactly this reason. On the way out every store runs `assertSession`, so a row that is not a v4 session for that id throws `InvalidSessionError` instead of coming back as an empty conversation. A store's own `created_at` / `updated_at` columns are never part of the session.

Pass `history` on every `turn()` yourself when you already keep the conversation somewhere. `session.history` is for the playground case where you do not.

## MemoryStore

Nothing survives the process. It is for tests, prototypes and the playground, and it runs the same version check and the same shape check as the durable stores, so a test against it proves the same loop. `clear()` drops every session.

## The six durable stores

All six are optional peer dependencies: you install the driver, open the client, and hand it over. The store never opens a connection of its own. Five of them close the client you gave it with `disconnect()`; `OpenSearchStore` has none, so close that client yourself.

```ts
import {
  MongoStore,
  OpenSearchStore,
  PostgresStore,
  PrismaStore,
  RedisStore,
  SQLiteStore,
  type MongoClient,
  type OpenSearchClient,
  type PgClient,
  type PrismaClient,
  type RedisClient,
  type SqliteDatabase,
} from "@falai/agent";

declare const pg: PgClient; // a `pg` Pool or Client
declare const prisma: PrismaClient; // your generated client
declare const redis: RedisClient; // an ioredis client
declare const mongo: MongoClient; // the mongodb driver's MongoClient
declare const db: SqliteDatabase; // better-sqlite3 or bun:sqlite
declare const opensearch: OpenSearchClient; // @opensearch-project/opensearch

const postgres = new PostgresStore({ client: pg });
await postgres.initialize(); // CREATE TABLE IF NOT EXISTS agent_sessions

const viaPrisma = new PrismaStore({ prisma, tables: { sessions: "agentSession" } });
const viaRedis = new RedisStore({ redis, keyPrefix: "agent:", sessionTTL: 7 * 24 * 60 * 60 });
const viaMongo = new MongoStore({ client: mongo, databaseName: "app" });
const sqlite = new SQLiteStore({ db });
await sqlite.initialize();
const search = new OpenSearchStore(opensearch, { refresh: "wait_for" });
await search.initialize();

console.log([postgres, viaPrisma, viaRedis, viaMongo, sqlite, search].length); // 6
```

| Store | Client it takes | Where a session lives | How a conflict is detected |
|---|---|---|---|
| `PostgresStore` | `PgClient`: a `pg` `Pool` or `Client` | table `agent_sessions`: `id`, `version`, `blob` JSONB, `created_at`, `updated_at` | `INSERT … ON CONFLICT DO NOTHING` first, `UPDATE … WHERE version = $n` after; no row back is the conflict |
| `SQLiteStore` | `SqliteDatabase`: better-sqlite3 or `bun:sqlite` | table `agent_sessions`: `id`, `version`, `blob` TEXT, `created_at`, `updated_at` | `INSERT OR IGNORE` first, `UPDATE … WHERE version = ?` after; `changes === 0` is the conflict |
| `PrismaStore` | `PrismaClient`: your generated client | model `agentSession` with `id`, `version`, `blob Json`, `createdAt`, `updatedAt`; rename with `fieldMappings.sessions` | `create` first, and Prisma's `P2002` is the conflict; `updateMany` on `{ id, version }` after, `count === 0` is the conflict |
| `RedisStore` | `RedisClient`: ioredis, or node-redis with `eval` wrapped to the positional form | one hash at `${keyPrefix}session:${id}` with `version`, `blob`, `createdAt`, `updatedAt` | one Lua script checks and writes in one step, so two writers on a shared client cannot interleave |
| `MongoStore` | `MongoClient`: the official driver | collection `agent_sessions`: `_id`, `version`, `blob` as JSON text, `createdAt`, `updatedAt` | `insertOne` first, and the duplicate-key error `11000` is the conflict; `updateOne` on `{ _id, version }` after, `matchedCount === 0` is the conflict |
| `OpenSearchStore` | `OpenSearchClient`: `@opensearch-project/opensearch` (Elasticsearch 7.x fits) | index `agent_sessions`: `id`, `version`, `blob` stored but not indexed, `createdAt`, `updatedAt` | `index` with `op_type: 'create'` first, and the 409 is the conflict; a painless script after, which becomes a `noop` when the version differs |

Options and defaults:

- `PostgresStore`, `SQLiteStore`: `tables.sessions`, default `"agent_sessions"`. `initialize()` creates the table when it is missing.
- `PrismaStore`: `tables.sessions` is the model name on the client, default `"agentSession"`; `fieldMappings.sessions` renames any of `id`, `version`, `blob`, `createdAt`, `updatedAt`. The constructor throws a `TypeError` when the client has no such model.
- `RedisStore`: `keyPrefix`, default `"agent:"`; `sessionTTL` in seconds since the last save, default 7 days; `0` keeps the hash forever.
- `MongoStore`: `databaseName` is required; `collections.sessions`, default `"agent_sessions"`. The blob is JSON text because claim keys carry channel message ids, which may contain dots that older servers reject in field names.
- `OpenSearchStore`: the client is the first argument; `indices.sessions`, default `"agent_sessions"`; `autoCreateIndices`, default `true`, for `initialize()`; `refresh`, default `false` (`true` refreshes at once, `"wait_for"` blocks until visible).

Use a fresh table. The default names are the 3.x names, but the columns are new, and a v4 store pointed at a live 3.x table throws `InvalidSessionError` on every load. Create the new table, then move rows with `migrateSession` as they are first needed.

## Moving a 3.x row

A 3.x row holds four keys v4 does not have: `currentFlow`, `currentStep`, `flowHistory` and `signals`. `migrateSession` turns it into one v4 session, once, where you deserialize. The migrated session is at version 0, so your usual save is the insert.

```ts
import { migrateSession, type Session } from "@falai/agent";

// A 3.x row, as it sits in the old table (shape from tests/fixtures/blobs/prospectar-midflow.json).
const legacyRow: unknown = {
  id: "session_1756731890123_k3j9x2",
  currentFlow: { id: "qualificacao", title: "Qualificação", enteredAt: "2026-09-01T13:05:12.000Z" },
  currentStep: { id: "ask_budget", enteredAt: "2026-09-01T13:07:40.000Z" },
  data: { nome: "Mariana", empresa: "Padaria Estrela", tamanho: "1-10" },
  flowHistory: [
    { flowId: "boas_vindas", enteredAt: "2026-09-01T13:04:50.000Z", exitedAt: "2026-09-01T13:05:12.000Z", completed: true },
    { flowId: "qualificacao", enteredAt: "2026-09-01T13:05:12.000Z", completed: false },
  ],
  metadata: { workspaceId: "ws_demo", channel: "whatsapp" },
  version: 12,
};

const session: Session = migrateSession(legacyRow, {
  sessionId: "session_1756731890123_k3j9x2",
  flowIdOf: (key) => key, // an old flow id, or a key under `signals.triggers` → v4 flow id; identity when you kept the ids
});

console.log(session.version); // 0
console.log(session.runs[0]?.flowId, session.runs[0]?.stepId, session.runs[0]?.status); // qualificacao ask_budget asking
console.log(Object.keys(session.claims)); // [ 'boas_vindas:session_…:', 'qualificacao:session_…:' ]
```

What the migration keeps and drops:

- `data` is kept as it is, the same object.
- `currentFlow` plus `currentStep` become one run at that step with `status: "asking"`, so the conversation keeps its place. Keep your talk-step ids when you convert flows. A flow entered before its first step becomes a `running` run with no step.
- Every completed `flowHistory` entry and every `signals.triggers[key]` becomes a claim, `${flowIdOf(key)}:${sessionId}:`, so a `once` flow does not fire again. The mid-flow run gets its own claim too.
- `metadata` is kept, with any `Date` turned into ISO text.
- `history` is kept only when the row had one.
- Every other 3.x key is dropped, the old `version` included: the new table has no row yet.

A blob that already carries `v: 4` passes straight through `assertSession`. Anything that is neither throws `InvalidSessionError`.

`assertSession(blob, sessionId)` is the shape check on its own, for a blob you read from somewhere other than a store. It returns a `Session` holding only the session keys, or throws.

## Checking a store of your own

If you write a `Store` for another database, it needs the same three behaviours: `0` inserts and refuses to overwrite an existing row, a matching version updates and bumps by one, and a stale version throws `SessionConflictError` with the stored version in `actualVersion`. Read the blob back through `assertSession`. `tests/store-contract.test.ts` in the repo runs one contract against all seven stores; copy it.

See [the stores reference](../reference/stores.md) for every option type, and [the session reference](../reference/session.md) for the blob's fields.
