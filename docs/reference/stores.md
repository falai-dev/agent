---
title: "Stores"
description: "The seven Store classes: the client each takes, the table or collection it expects, and how each one checks the version on save."
type: reference
order: 11
---

# Stores

A store keeps session blobs. It has two methods, `load(id)` and `save(session, expectedVersion)`, and the package ships seven of them. You build the database client yourself and pass it in; the package imports no driver. The six drivers are optional peer dependencies (`pg ^8`, `@prisma/client ^6`, `ioredis ^5`, `mongodb ^6`, `better-sqlite3 ^11 || ^12`, `@opensearch-project/opensearch ^2`), and each store types its client as a small interface, so anything with the same methods fits.

## What every store does

All seven read and write the same row through `src/persistence/sessionRow.ts`:

- **Write.** The blob is the `Session` with `id`, `v: 4`, the new `version`, `data`, `runs`, `claims`, `inputs`, `metadata`, plus `lastUserAt`, `lastAssistantAt` and `history` only when set. A store's own `created_at` / `updated_at` columns are not part of the session.
- **Read.** Text is parsed as JSON, then the blob goes through `assertSession`. Anything that is not a v4 session throws `InvalidSessionError`; a corrupt row never comes back as a fresh conversation.
- **Version.** `save(session, 0)` inserts and fails when a row exists. `save(session, n)` updates only the row whose stored version is `n`. Either failure throws `SessionConflictError`. Success stores `n + 1` and returns the session with that number. The check and the write happen in one statement, script or conditional update, never as a read followed by a write.
- **`save` returns the blob it wrote**, not a re-read of the row.

| Class | Client type | Where the row lives (default) | Insert (version 0) | Update (version n) |
|-------|-------------|-------------------------------|--------------------|--------------------|
| `MemoryStore` | none | a `Map` in the process | key exists = conflict | version differs = conflict |
| `PostgresStore` | `PgClient` | table `agent_sessions` | `INSERT … ON CONFLICT (id) DO NOTHING`, no row back = conflict | `UPDATE … WHERE id = $1 AND version = $4`, no row back = conflict |
| `PrismaStore` | `PrismaClient` | model `agentSession` | `create`, Prisma `P2002` = conflict | `updateMany({ where: { id, version } })`, `count === 0` = conflict |
| `RedisStore` | `RedisClient` | hash `agent:session:<id>` | one Lua script | the same script |
| `MongoStore` | `MongoClient` | collection `agent_sessions` | `insertOne`, code `11000` = conflict | `updateOne({ _id, version })`, `matchedCount === 0` = conflict |
| `SQLiteStore` | `SqliteDatabase` | table `agent_sessions` | `INSERT OR IGNORE`, `changes === 0` = conflict | `UPDATE … WHERE id = ? AND version = ?`, `changes === 0` = conflict |
| `OpenSearchStore` | `OpenSearchClient` | index `agent_sessions` | `index` with `op_type: 'create'`, HTTP 409 = conflict | scripted `update`, `noop` = conflict |

## MemoryStore

For tests and prototypes. Everything is lost when the process stops. Rows are kept as JSON text and read back through the same check as every other store, so `Date` objects come back as text and `undefined` drops, exactly as they would through PostgreSQL.

### Signature

```ts fragment
class MemoryStore<D = unknown> implements Store<D> {
  load(id: string): Promise<Session<D> | null>;
  save(session: Session<D>, expectedVersion: number): Promise<Session<D>>;
  /** Drop every session. */
  clear(): void;
}
```

### Example

```ts
import { MemoryStore } from "@falai/agent";
import type { Session } from "@falai/agent";

const store = new MemoryStore<{ nome: string }>();
console.log(await store.load("s1")); // null: nothing saved yet

const session: Session<{ nome: string }> = {
  id: "s1", v: 4, version: 0, data: {}, runs: [], claims: {}, inputs: [], metadata: {},
};
const saved = await store.save(session, 0);
console.log(saved.version); // 1

store.clear();
console.log(await store.load("s1")); // null
```

## PostgresStore

Over a `pg` `Client` or `Pool`. One row per session; the blob is JSONB, so PostgreSQL hands it back parsed.

### Signature

```ts fragment
interface PostgresStoreOptions {
  client: PgClient;
  /** Table name. Default `agent_sessions`. */
  tables?: { sessions?: string };
}

/** Matches `pg`'s Client and Pool. */
interface PgClient {
  query<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<PgQueryResult<T>>;
  end(): Promise<void>;
}

interface PgQueryResult<T = Record<string, unknown>> {
  rows: T[];
  rowCount?: number | null;
}

class PostgresStore<D = unknown> implements Store<D> {
  constructor(options: PostgresStoreOptions);
  /** Create the table when it is missing. */
  initialize(): Promise<void>;
  /** Calls `client.end()`. */
  disconnect(): Promise<void>;
}
```

### The table

`initialize()` runs this; run it yourself if you manage migrations:

```sql
CREATE TABLE IF NOT EXISTS agent_sessions (
  id VARCHAR(255) PRIMARY KEY,
  version INTEGER NOT NULL,
  blob JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

A 3.x `agent_sessions` table has different columns. Point `tables.sessions` at a fresh table and move old rows through `migrateSession` at the place you deserialize them, not through this table.

### Behaviour

- Version 0: `INSERT INTO t (id, version, blob) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING RETURNING version`. No row back means a row already existed.
- Version n: `UPDATE t SET version = $2, blob = $3, updated_at = NOW() WHERE id = $1 AND version = $4 RETURNING version`. No row back means the stored version is not `n`, or the row is gone.
- On a conflict the store runs one more `SELECT version` to fill `SessionConflictError.actualVersion`.

### Example

```ts
import { PostgresStore } from "@falai/agent";
import type { PgClient } from "@falai/agent";

// const pool = new Pool({ connectionString: process.env.DATABASE_URL });
declare const pool: PgClient;

const store = new PostgresStore<{ nome: string }>({ client: pool });
await store.initialize();

const session = await store.load("s1"); // null on a first turn
console.log(session?.version ?? 0);
```

## PrismaStore

Over a generated Prisma client. The store looks up one model delegate by name (default `agentSession`) and needs `create`, `findUnique` and `updateMany` on it.

### Signature

```ts fragment
interface PrismaStoreOptions {
  prisma: PrismaClient;
  /** Model name on the client. Default `agentSession`. */
  tables?: { sessions?: string };
  /** Field names when the model uses other names. */
  fieldMappings?: { sessions?: Partial<Record<PrismaSessionField, string>> };
}

type PrismaSessionField = "id" | "version" | "blob" | "createdAt" | "updatedAt";

/** Matches a generated Prisma client: model delegates by name, plus `$disconnect`. */
interface PrismaClient {
  [model: string]: unknown;
  $disconnect?: () => Promise<void>;
}

/** The delegate a generated client exposes per model. */
interface PrismaSessionModel {
  create(params: { data: Record<string, unknown> }): Promise<Record<string, unknown>>;
  findUnique(params: { where: Record<string, unknown> }): Promise<Record<string, unknown> | null>;
  updateMany(params: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
}

class PrismaStore<D = unknown> implements Store<D> {
  constructor(options: PrismaStoreOptions);
  /** Calls `prisma.$disconnect()` when it exists. */
  disconnect(): Promise<void>;
}
```

### The model

```prisma
model AgentSession {
  id        String   @id
  version   Int
  blob      Json
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}
```

Prisma exposes this as `prisma.agentSession`. Other names go through `tables.sessions` (the delegate) and `fieldMappings.sessions` (the five fields). All five fields are required; 3.x tolerated a model without `version`, and that no longer works.

### Behaviour

- The constructor checks the delegate at once. A missing model throws a `TypeError`: `[TypeError] PrismaStore cannot use model "agentSession": the client has no such delegate with create, findUnique and updateMany. Add the model to schema.prisma and run prisma generate, or pass tables.sessions with its name.`
- Version 0: `create({ data: { id, version: 1, blob, createdAt, updatedAt } })`. Prisma's unique violation, error `code === "P2002"`, is the conflict. Any other error is rethrown.
- Version n: `updateMany({ where: { id, version: n }, data: { version: n + 1, blob, updatedAt } })`. `count === 0` is the conflict.
- The blob is stored as a JSON value (Prisma's `Json`), not as text.

### Example

```ts
import { PrismaStore } from "@falai/agent";
import type { PrismaClient } from "@falai/agent";

// const prisma = new PrismaClient();   // from @prisma/client
declare const prisma: PrismaClient;

const store = new PrismaStore<{ nome: string }>({
  prisma,
  tables: { sessions: "conversa" },
  fieldMappings: { sessions: { blob: "estado", updatedAt: "atualizadoEm" } },
});
console.log(await store.load("s1")); // null on a first turn
```

## RedisStore

Over an ioredis-shaped client. One hash per session with the fields `version`, `blob` (JSON text), `createdAt` and `updatedAt`.

### Signature

```ts fragment
interface RedisStoreOptions {
  redis: RedisClient;
  /** Prefix of every key. Default `agent:`. */
  keyPrefix?: string;
  /** Seconds a session lives after its last save; `0` keeps it forever. Default 7 days. */
  sessionTTL?: number;
}

/** Matches ioredis. node-redis users wrap `eval` to this positional form. */
interface RedisClient {
  hgetall(key: string): Promise<Record<string, string>>;
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  quit(): Promise<string>;
}

class RedisStore<D = unknown> implements Store<D> {
  constructor(options: RedisStoreOptions);
  /** Calls `redis.quit()`. */
  disconnect(): Promise<void>;
}
```

### The key

`${keyPrefix}session:${id}`, so `agent:session:s1` by default. Nothing to create ahead of time.

### Behaviour

The version check and the write are one Lua script, so two writers on a shared client cannot interleave between the read and the write:

```lua
local current = redis.call('HGET', KEYS[1], 'version')
if ARGV[1] == '0' then
  if current then return current end
elseif current ~= ARGV[1] then
  return current or 'missing'
end
redis.call('HSET', KEYS[1], 'version', ARGV[2], 'blob', ARGV[3], 'updatedAt', ARGV[4])
redis.call('HSETNX', KEYS[1], 'createdAt', ARGV[4])
if tonumber(ARGV[5]) > 0 then redis.call('EXPIRE', KEYS[1], ARGV[5]) end
return nil
```

`ARGV` is the expected version, the next version, the blob, now as ISO text and the TTL in seconds. `nil` back is success; a version back is the conflict (`actualVersion` is that number); `'missing'` means the hash is gone (`actualVersion` is `undefined`).

- `sessionTTL` defaults to `7 * 24 * 60 * 60` = 604800 seconds and is reset on every save. `0` never expires.
- A session that expires takes its parked runs and claims with it. A wait longer than the TTL (an event wait defaults to 30 days) wakes to no session, and a `once` flow can fire again. Set `sessionTTL` above your longest wait, or to `0`.
- `load` returns `null` when the hash has no fields.

### Example

```ts
import { RedisStore } from "@falai/agent";
import type { RedisClient } from "@falai/agent";

// const redis = new Redis(process.env.REDIS_URL);   // from ioredis
declare const redis: RedisClient;

const store = new RedisStore<{ nome: string }>({ redis, keyPrefix: "vendas:", sessionTTL: 30 * 24 * 60 * 60 });
console.log(await store.load("s1")); // reads hash vendas:session:s1
```

## MongoStore

Over the official driver's client. One document per session: `_id` is the session id.

### Signature

```ts fragment
interface MongoStoreOptions {
  client: MongoClient;
  databaseName: string;
  /** Collection name. Default `agent_sessions`. */
  collections?: { sessions?: string };
}

interface MongoClient {
  db(name?: string): MongoDatabase;
  close(): Promise<void>;
}

interface MongoDatabase {
  collection<T = Record<string, unknown>>(name: string): MongoCollection<T>;
}

/** Matches the mongodb driver's Collection. */
interface MongoCollection<T = Record<string, unknown>> {
  insertOne(doc: T): Promise<unknown>;
  findOne(filter: Record<string, unknown>): Promise<T | null>;
  updateOne(filter: Record<string, unknown>, update: Record<string, unknown>): Promise<{ matchedCount: number }>;
}

class MongoStore<D = unknown> implements Store<D> {
  constructor(options: MongoStoreOptions);
  /** Calls `client.close()`. */
  disconnect(): Promise<void>;
}
```

### The document

```json
{ "_id": "s1", "version": 3, "blob": "{\"id\":\"s1\",\"v\":4,...}", "createdAt": ISODate, "updatedAt": ISODate }
```

`blob` is JSON text, not a sub-document, because claim keys carry channel message ids and those may contain dots, which older servers reject in field names. Nothing to create: `_id` is unique on its own.

### Behaviour

- Version 0: `insertOne({ _id, version: 1, blob, createdAt, updatedAt })`. The driver's duplicate key error, `code === 11000`, is the conflict. Any other error is rethrown.
- Version n: `updateOne({ _id, version: n }, { $set: { version: n + 1, blob, updatedAt } })`. `matchedCount === 0` is the conflict.

### Example

```ts
import { MongoStore } from "@falai/agent";
import type { MongoClient } from "@falai/agent";

// const client = new MongoClient(process.env.MONGO_URL);   // from mongodb
declare const client: MongoClient;

const store = new MongoStore<{ nome: string }>({ client, databaseName: "vendas" });
console.log(await store.load("s1")); // null on a first turn
```

## SQLiteStore

Over a better-sqlite3-shaped database; `bun:sqlite` fits the same interface. The blob is JSON text.

### Signature

```ts fragment
interface SQLiteStoreOptions {
  db: SqliteDatabase;
  /** Table name. Default `agent_sessions`. */
  tables?: { sessions?: string };
}

/** Matches better-sqlite3 and bun:sqlite databases. */
interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): unknown;
  close(): void;
}

interface SqliteStatement {
  run(...params: unknown[]): { changes: number };
  get(...params: unknown[]): unknown;
}

class SQLiteStore<D = unknown> implements Store<D> {
  constructor(options: SQLiteStoreOptions);
  /** Create the table when it is missing. */
  initialize(): Promise<void>;
  /** Calls `db.close()`. */
  disconnect(): Promise<void>;
}
```

### The table

```sql
CREATE TABLE IF NOT EXISTS agent_sessions (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  blob TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

Same note as PostgreSQL: a 3.x table has other columns, so use a fresh table.

### Behaviour

- Version 0: `INSERT OR IGNORE INTO t (id, version, blob, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`. `changes === 0` is the conflict.
- Version n: `UPDATE t SET version = ?, blob = ?, updated_at = ? WHERE id = ? AND version = ?`. `changes === 0` is the conflict.
- The driver is synchronous; the store wraps each call in a promise so a thrown error is a rejection like everywhere else.

### Example

```ts
import { SQLiteStore } from "@falai/agent";
import type { SqliteDatabase } from "@falai/agent";

// const db = new Database("sessions.db");   // from better-sqlite3 or bun:sqlite
declare const db: SqliteDatabase;

const store = new SQLiteStore<{ nome: string }>({ db });
await store.initialize();
console.log(await store.load("s1")); // null on a first turn
```

## OpenSearchStore

Over `@opensearch-project/opensearch`'s client; Elasticsearch 7.x fits the same calls. One document per session, with `blob` stored but not indexed. The constructor takes the client first and the options second.

### Signature

```ts fragment
interface OpenSearchStoreOptions {
  /** Index name. Default `agent_sessions`. */
  indices?: { sessions?: string };
  /** Create the index with its mappings on `initialize()`. Default true. */
  autoCreateIndices?: boolean;
  /** Refresh policy on writes: `true` at once, `false` in the background, `'wait_for'` blocks. Default false. */
  refresh?: boolean | "wait_for";
}

/** Matches `@opensearch-project/opensearch`'s Client. */
interface OpenSearchClient {
  index(params: { index: string; id: string; body: Record<string, unknown>; op_type?: "index" | "create"; refresh?: boolean | "wait_for" }): Promise<{ body: { result: string } }>;
  update(params: { index: string; id: string; body: Record<string, unknown>; retry_on_conflict?: number; refresh?: boolean | "wait_for" }): Promise<{ body: { result: string } }>;
  get(params: { index: string; id: string }): Promise<{ body: { _source: Record<string, unknown> } }>;
  indices: {
    exists(params: { index: string }): Promise<{ body: boolean }>;
    create(params: { index: string; body: { mappings?: Record<string, unknown> } }): Promise<{ body: { acknowledged: boolean } }>;
  };
}

class OpenSearchStore<D = unknown> implements Store<D> {
  constructor(client: OpenSearchClient, options?: OpenSearchStoreOptions);
  /** Create the index with its mappings when it is missing and `autoCreateIndices` is on. */
  initialize(): Promise<void>;
}
```

There is no `disconnect()` on this store.

### The index

`initialize()` creates it with these mappings when it is missing:

```json
{
  "mappings": {
    "properties": {
      "id": { "type": "keyword" },
      "version": { "type": "integer" },
      "blob": { "type": "object", "enabled": false },
      "createdAt": { "type": "date" },
      "updatedAt": { "type": "date" }
    }
  }
}
```

The document id is the session id; `blob` is the session object itself, stored and never indexed.

### Behaviour

- Version 0: `index({ id, op_type: 'create', body: { id, version: 1, blob, createdAt, updatedAt } })`. An HTTP 409 (`error.statusCode`) is the conflict. Any other error is rethrown.
- Version n: a Painless script `update` with `retry_on_conflict: 3` that compares `ctx._source.version` to `n` and sets `ctx.op = 'noop'` when they differ; otherwise it writes `version`, `blob` and `updatedAt`. A `noop` result, a 404 or a 409 is the conflict.
- `load` treats a 404 as `null`.
- `refresh` is passed on every write; it defaults to `false`.

### Example

```ts
import { OpenSearchStore } from "@falai/agent";
import type { OpenSearchClient } from "@falai/agent";

// const client = new Client({ node: process.env.OPENSEARCH_URL });   // from @opensearch-project/opensearch
declare const client: OpenSearchClient;

const store = new OpenSearchStore<{ nome: string }>(client, { indices: { sessions: "conversas" }, refresh: "wait_for" });
await store.initialize();
console.log(await store.load("s1")); // null on a first turn
```

## Writing your own

Implement `Store<D>`: `load` returns the session or `null`; `save` checks the version and writes in one atomic step, throws `SessionConflictError(sessionId, expectedVersion, actualVersion)` when the check fails, and returns the session stamped with `expectedVersion + 1`. Run the blob you read through `assertSession(blob, id)` so a bad row throws `InvalidSessionError` instead of starting a fresh conversation. The contract test in `tests/store-contract.test.ts` is the same for all seven; a new store should pass it too.

## See also

- [Session](./session.md): what the blob holds and who writes each field.
- [Persistence](../guides/persistence.md): the host loop, `migrateSession` for 3.x rows, and picking a store.
- [Go to production](../start/05-go-to-production.md): from `MemoryStore` to `PostgresStore` step by step.
- [Errors](./errors.md): `SessionConflictError` and `InvalidSessionError`.
