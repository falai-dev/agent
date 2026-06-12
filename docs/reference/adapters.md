---
title: "Persistence adapters"
description: "Storage strategies that let an Agent persist sessions and messages across turns, processes, and machines."
type: reference
order: 11
---

# Persistence adapters

> **Where this is introduced:** [Persistence](../guides/persistence.md)

A **persistence adapter** is the strategy plug between an `Agent` and a storage backend. Every adapter implements the same `PersistenceAdapter` interface, so the agent itself stays storage-agnostic. Pass an instance through `persistence.adapter` on the agent options and every turn auto-saves the session (flow position, collected data, pending directive, signals state) and the message log.

`@falai/agent` ships seven built-in adapters. `MemoryAdapter` is the **implicit default** — when `persistence` is omitted, the agent runs against an in-memory store automatically. Reach for the others when you need durability across processes.

| Adapter | Class | Backend | When to use |
|---------|-------|---------|-------------|
| Memory | `MemoryAdapter` | in-process Maps | Default. Tests, prototypes, single-process demos. |
| Prisma | `PrismaAdapter` | any Prisma-supported DB | You already have Prisma; want a typed schema. |
| Redis | `RedisAdapter` | Redis / KeyDB / Dragonfly | Fast, ephemeral, TTL-driven session storage. |
| MongoDB | `MongoAdapter` | MongoDB / Atlas | Document-shape; flexible session payloads. |
| PostgreSQL | `PostgreSQLAdapter` | Postgres (raw `pg`) | Single SQL backend without an ORM. |
| SQLite | `SQLiteAdapter` | `better-sqlite3` | Local dev, single-node deploys, CLI tools. |
| OpenSearch | `OpenSearchAdapter` | OpenSearch / Elasticsearch 7.x | Searchable session/message archive. |

## Shared shape

Every adapter implements the same surface and the agent only ever talks to it through this contract:

```typescript
interface PersistenceAdapter<TData> {
  readonly sessionRepository: SessionRepository<TData>;
  readonly messageRepository: MessageRepository;
  initialize?(): Promise<void>;
  disconnect?(): Promise<void>;
}

interface PersistenceConfig<TData> {
  adapter: PersistenceAdapter<TData>;
  autoSave?: boolean;       // default: true
  userId?: string;          // attached to created sessions/messages
  schemaVersion?: number;   // stamps persisted state; see "Schema versioning"
  migrateSession?: (       // upgrades state written under an older schemaVersion
    collectedData: CollectedStateData<TData>,
    fromVersion: number | undefined
  ) => CollectedStateData<TData> | Promise<CollectedStateData<TData>>;
}
```

The `SessionRepository` write methods accept a `CollectedStateData` payload that carries everything that needs to survive a process restart:

```typescript
interface CollectedStateData<TData> {
  /** User-defined schema version of the agent that wrote this state. */
  schemaVersion?: number;
  data: Partial<TData>;
  flowHistory: SessionState<TData>["flowHistory"];
  history?: SessionState<TData>["history"];
  metadata: SessionState<TData>["metadata"];
  /** Persisted directive applied at the start of the next turn. */
  pendingDirective?: SessionState<TData>["pendingDirective"];
  /** Reserved for v2.x Signals — passed through bit-identical. */
  signals?: SessionState<TData>["signals"];
}
```

Two columns deserve special attention:

- **`pendingDirective`** — a serialized [`Directive`](./directive.md) the pipeline consumes at the start of the next turn (e.g., what `Agent.dispatch()` writes). Stored as JSON.
- **`signals`** — the [signals](./signals.md) runtime state (firing counts, cooldown timestamps, last-extracted payloads). Stored as JSON.

Both are **required columns** on every adapter's session schema. v1 schemas had a `pending_transition` column instead; v2 replaces it. See the per-adapter migration notes below and the consolidated [v1 → v2 migration](../migration/v1-to-v2.md).

## Optimistic locking

Every session row carries a `version: number` (on `SessionData` / `SessionState`), incremented by the repository on every update. `SessionRepository.update()` takes an optional compare-and-swap guard:

```typescript
interface SessionUpdateOptions {
  /** Reject the update with SessionConflictError if the stored `version` differs. */
  expectedVersion?: number;
}

update(
  id: string,
  data: Partial<Omit<SessionData<TData>, "id" | "createdAt">>,
  options?: SessionUpdateOptions
): Promise<SessionData<TData> | null>;
```

When the agent saves a session and another writer bumped the stored `version` since this copy was loaded (concurrent `respond()` calls from two processes, parallel webhooks, two tabs), the save throws the exported [`SessionConflictError`](./errors.md) — carrying `sessionId`, `expectedVersion`, and `actualVersion` — instead of silently overwriting the winner's state. Recommended handling: reload the session and retry. Same-process concurrent saves of one session are serialized through a per-session queue and never conflict with each other.

What each adapter needs:

| Adapter | `version` storage | Migration from pre-2.4 |
|---------|-------------------|------------------------|
| `MemoryAdapter` | in-memory field | None. |
| `MongoAdapter` | document field | None — added on next save. |
| `RedisAdapter` | inside the JSON value | None. |
| `OpenSearchAdapter` | document field | None. |
| `SQLiteAdapter` | `version INTEGER` column | None — `initialize()` auto-adds the column. |
| `PostgreSQLAdapter` | `version INTEGER` column | None — `initialize()` auto-adds the column. |
| `PrismaAdapter` | your model's `version Int?` | Add `version Int?` to your session model. Without it the adapter detects the missing column and degrades gracefully — locking stays inactive. |

Rows written by pre-2.4 versions have no stored `version` and are **accepted without conflict**; the first v2.4 save stamps them. If you implement a custom `SessionRepository`, honor `options.expectedVersion` as a compare-and-swap (see `MemoryAdapter` for the reference implementation) or ignore the parameter to opt out of locking.

## Schema versioning

Independent of the locking `version`, `CollectedStateData.schemaVersion` tracks the **user-defined shape** of your persisted state. Configure `persistence.schemaVersion` and the agent stamps it on every save; on load, a session written under a different (or missing) version is passed through `persistence.migrateSession` before use. See the [persistence guide](../guides/persistence.md#schema-versioning-migrate-old-sessions-on-load) for the recipe.

### Wiring with `sessionId`

Pass `sessionId` to the agent constructor or directly to a `respond` call to resume a conversation by id:

```typescript
const agent = createAgent({
  schema,
  provider,
  flows,
  persistence: { adapter, userId: "user_123" },
  sessionId: "user_123:thread_abc",
});

await agent.respond({ history: [{ role: "user", content: "Hi again" }] });
```

The engine looks the id up via `sessionRepository.findById`, hydrates the full `SessionState` (including `pendingDirective` and `signals`), and continues the turn against the restored state. Unknown ids create a new session with that id — there's no "not found" error path.

## MemoryAdapter

The implicit default. Omit `persistence` entirely to use it; instantiate explicitly only when you want to inspect or clear the store from tests.

### Signature

```typescript
new MemoryAdapter()

class MemoryAdapter<TData> implements PersistenceAdapter<TData> {
  clear(): void;
  getSnapshot(): { sessions: SessionData<TData>[]; messages: MessageData[] };
}
```

### Fields

No constructor options. `clear()` drops every session and message; `getSnapshot()` returns a read-only snapshot for assertions.

### Examples

```typescript
// Implicit — no setup at all.
const agent = createAgent({ schema, provider, flows });

// Explicit — when you need clear()/getSnapshot() in tests.
import { MemoryAdapter } from "@falai/agent";

const adapter = new MemoryAdapter();
const agent = createAgent({
  schema, provider, flows,
  persistence: { adapter, userId: "test_user" },
});

afterEach(() => adapter.clear());
```

## PrismaAdapter

Rides on top of any Prisma-supported database. You own the schema; the adapter does the reads and writes through your generated client.

### Signature

```typescript
new PrismaAdapter(options: PrismaAdapterOptions)

interface PrismaAdapterOptions {
  prisma: PrismaClient;
  tables?: { sessions?: string; messages?: string };
  fieldMappings?: FieldMappings;   // rename map for non-default column names
  autoMigrate?: boolean;
}
```

### Fields

| Field | Type | Required | Default | Notes |
|-------|------|----------|---------|-------|
| `prisma` | `PrismaClient` | yes | — | Generated client from `@prisma/client`. |
| `tables.sessions` | `string` | no | `"agentSession"` | Prisma model name to use for sessions. |
| `tables.messages` | `string` | no | `"agentMessage"` | Prisma model name to use for messages. |
| `fieldMappings` | `FieldMappings` | no | — | Optional rename map when your model uses different column names than the standard `SessionData` / `MessageData` shapes. |
| `autoMigrate` | `boolean` | no | `false` | Experimental. Use `prisma migrate` in production. |

### Schema requirements

Your `Session` model must declare `pendingDirective` and `signals` JSON columns alongside the standard fields. Add `version Int?` to enable [optimistic locking](#optimistic-locking):

```prisma
model AgentSession {
  id                String    @id
  userId            String?
  agentName         String?
  status            String    @default("active")
  currentFlow       String?
  currentStep       String?
  collectedData     Json?
  pendingDirective  Json?
  signals           Json?
  version           Int?
  messageCount      Int       @default(0)
  lastMessageAt     DateTime?
  completedAt       DateTime?
  createdAt         DateTime  @default(now())
  updatedAt         DateTime  @updatedAt
}
```

`version` is optional — the adapter detects a missing column on the first write and degrades gracefully, leaving locking inactive. The other columns are required; if your existing schema lacks them, see [v1 → v2 migration](../migration/v1-to-v2.md) for the column rename and DDL.

### Examples

```typescript
import { PrismaClient } from "@prisma/client";
import { createAgent, PrismaAdapter } from "@falai/agent";

const prisma = new PrismaClient();

const agent = createAgent({
  schema, provider, flows,
  persistence: {
    adapter: new PrismaAdapter({ prisma }),
    userId: "user_123",
  },
});

// Custom table names + column rename:
new PrismaAdapter({
  prisma,
  tables: { sessions: "Conversation", messages: "ConversationMessage" },
  fieldMappings: { sessions: { collectedData: "payload" } },
});
```

## RedisAdapter

Redis is the right pick when you want fast reads, automatic expiry, and don't need long-term archives. Sessions and messages are stored as JSON-serialized strings under prefixed keys.

### Signature

```typescript
new RedisAdapter(options: RedisAdapterOptions)

interface RedisAdapterOptions {
  redis: RedisClient;          // ioredis or node-redis
  keyPrefix?: string;
  sessionTTL?: number;         // seconds
  messageTTL?: number;         // seconds
}
```

### Fields

| Field | Type | Required | Default | Notes |
|-------|------|----------|---------|-------|
| `redis` | `RedisClient` | yes | — | An `ioredis` or `node-redis` client. |
| `keyPrefix` | `string` | no | `"agent:"` | Namespace for every key the adapter writes. |
| `sessionTTL` | `number` | no | `604800` (7 days) | Per-session expiry. Pass a large number to effectively disable. |
| `messageTTL` | `number` | no | `2592000` (30 days) | Per-message expiry. |

### Schema requirements

None. The adapter writes JSON strings — `pendingDirective` and `signals` ride along inside the session value transparently.

### Examples

```typescript
import Redis from "ioredis";
import { createAgent, RedisAdapter } from "@falai/agent";

const redis = new Redis(process.env.REDIS_URL!);

const agent = createAgent({
  schema, provider, flows,
  persistence: {
    adapter: new RedisAdapter({
      redis,
      keyPrefix: "myapp:agent:",
      sessionTTL: 60 * 60 * 24, // 1 day
    }),
    userId: "user_123",
  },
});
```

## MongoAdapter

Document-shape storage. Indexes are not auto-created — add `{ id: 1 }`, `{ userId: 1, status: 1 }`, and `{ sessionId: 1, createdAt: 1 }` yourself.

### Signature

```typescript
new MongoAdapter(options: MongoAdapterOptions)

interface MongoAdapterOptions {
  client: MongoClient;
  databaseName: string;
  collections?: { sessions?: string; messages?: string };
}
```

### Fields

| Field | Type | Required | Default | Notes |
|-------|------|----------|---------|-------|
| `client` | `MongoClient` | yes | — | Connected `mongodb` client. |
| `databaseName` | `string` | yes | — | Database to write into. |
| `collections.sessions` | `string` | no | `"agent_sessions"` | Collection name for sessions. |
| `collections.messages` | `string` | no | `"agent_messages"` | Collection name for messages. |

### Schema requirements

Schemaless — v2 imposes no DDL changes. The session document gains `pendingDirective` and `signals` as top-level fields automatically.

### Examples

```typescript
import { MongoClient } from "mongodb";
import { createAgent, MongoAdapter } from "@falai/agent";

const client = new MongoClient(process.env.MONGO_URL!);
await client.connect();

const agent = createAgent({
  schema, provider, flows,
  persistence: {
    adapter: new MongoAdapter({ client, databaseName: "myapp" }),
    userId: "user_123",
  },
});
```

## PostgreSQLAdapter

Raw SQL adapter on top of `pg`. `initialize()` creates v2 tables and indexes for you.

### Signature

```typescript
new PostgreSQLAdapter(options: PostgreSQLAdapterOptions)

interface PostgreSQLAdapterOptions {
  client: PgClient;            // pg.Client or pg.Pool
  tables?: { sessions?: string; messages?: string };
}
```

### Fields

| Field | Type | Required | Default | Notes |
|-------|------|----------|---------|-------|
| `client` | `PgClient` | yes | — | Connected `pg.Client` or `pg.Pool`. |
| `tables.sessions` | `string` | no | `"agent_sessions"` | Override the sessions table name. |
| `tables.messages` | `string` | no | `"agent_messages"` | Override the messages table name. |

### Schema requirements

`initialize()` creates tables with the v2 columns and auto-adds the `version` column to tables created by pre-2.4 versions — no manual DDL for the locking upgrade. Migrating from v1:

```sql
ALTER TABLE agent_sessions DROP COLUMN IF EXISTS pending_transition;
ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS pending_directive JSONB;
ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS signals JSONB;
```

### Examples

```typescript
import { Client } from "pg";
import { createAgent, PostgreSQLAdapter } from "@falai/agent";

const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

const adapter = new PostgreSQLAdapter({ client });
await adapter.initialize();

const agent = createAgent({
  schema, provider, flows,
  persistence: { adapter, userId: "user_123" },
});
```

## SQLiteAdapter

Right pick for local dev, single-node deploys, and CLI tools. Built on `better-sqlite3` (synchronous, fast, zero-config).

### Signature

```typescript
new SQLiteAdapter(options: SQLiteAdapterOptions)

interface SQLiteAdapterOptions {
  db: SqliteDatabase;          // better-sqlite3 Database
  tables?: { sessions?: string; messages?: string };
}
```

### Fields

| Field | Type | Required | Default | Notes |
|-------|------|----------|---------|-------|
| `db` | `SqliteDatabase` | yes | — | A `better-sqlite3` database. |
| `tables.sessions` | `string` | no | `"agent_sessions"` | Override the sessions table name. |
| `tables.messages` | `string` | no | `"agent_messages"` | Override the messages table name. |

### Schema requirements

`initialize()` creates the v2 tables and auto-adds the `version` column to tables created by pre-2.4 versions — no manual DDL for the locking upgrade. Migrating from v1 (SQLite 3.35+):

```sql
ALTER TABLE agent_sessions DROP COLUMN pending_transition;
ALTER TABLE agent_sessions ADD COLUMN pending_directive TEXT;
ALTER TABLE agent_sessions ADD COLUMN signals TEXT;
```

`pending_directive` and `signals` are stored as JSON `TEXT`.

### Examples

```typescript
import Database from "better-sqlite3";
import { createAgent, SQLiteAdapter } from "@falai/agent";

const db = new Database("agent.db");
const adapter = new SQLiteAdapter({ db });
await adapter.initialize();

const agent = createAgent({
  schema, provider, flows,
  persistence: { adapter, userId: "user_123" },
});
```

## OpenSearchAdapter

Right pick when you want session and message archives that are searchable out of the box. Auto-creates indices with sensible mappings on `initialize()`. Compatible with OpenSearch 1.x/2.x and Elasticsearch 7.x.

### Signature

```typescript
new OpenSearchAdapter(client: OpenSearchClient, options?: OpenSearchAdapterOptions)

interface OpenSearchAdapterOptions {
  indices?: { sessions?: string; messages?: string };
  autoCreateIndices?: boolean;       // default: true
  refresh?: boolean | "wait_for";    // default: false
}
```

### Fields

| Field | Type | Required | Default | Notes |
|-------|------|----------|---------|-------|
| `client` (positional) | `OpenSearchClient` | yes | — | Connected `@opensearch-project/opensearch` client. |
| `indices.sessions` | `string` | no | `"agent_sessions"` | Override the sessions index. |
| `indices.messages` | `string` | no | `"agent_messages"` | Override the messages index. |
| `autoCreateIndices` | `boolean` | no | `true` | When `true`, `initialize()` creates indices with v2 mappings. |
| `refresh` | `boolean \| "wait_for"` | no | `false` | Refresh strategy on writes. `true` for tests; `"wait_for"` for a balanced default. |

### Schema requirements

The auto-created mappings include `pendingDirective` and `signals` as opaque object fields (`enabled: false`). If you manage mappings yourself, mirror that shape:

```json
{
  "mappings": {
    "properties": {
      "id":               { "type": "keyword" },
      "userId":           { "type": "keyword" },
      "status":           { "type": "keyword" },
      "collectedData":    { "type": "object", "enabled": false },
      "pendingDirective": { "type": "object", "enabled": false },
      "signals":          { "type": "object", "enabled": false }
    }
  }
}
```

### Examples

```typescript
import { Client } from "@opensearch-project/opensearch";
import { createAgent, OpenSearchAdapter } from "@falai/agent";

const client = new Client({
  node: process.env.OPENSEARCH_URL!,
  auth: { username: "admin", password: process.env.OPENSEARCH_PASS! },
});

const adapter = new OpenSearchAdapter(client, { autoCreateIndices: true });
await adapter.initialize();

const agent = createAgent({
  schema, provider, flows,
  persistence: { adapter, userId: "user_123" },
});
```

## Errors

Adapter errors propagate from the underlying driver — the agent does not wrap them. Your `try`/`catch` sees the native vendor error (e.g., `PrismaClientKnownRequestError`, `MongoServerError`, `ioredis.ReplyError`). The one framework-owned exception is `SessionConflictError`.

| When | Error | Why |
|------|-------|-----|
| A save carries a stale `version` — a concurrent writer persisted the session first | `SessionConflictError` (exported) | Reload the session and retry. See [Optimistic locking](#optimistic-locking). |
| `pendingDirective` or `signals` column missing on a v1 schema | Driver-specific column-not-found error | Run the v2 migration shown above for your adapter. |
| `findById` returns `null` for a `sessionId` you passed to `createAgent` | None — a new session is created with that id | Treat unknown ids as "first turn." |
| `initialize()` not called on Postgres / SQLite / OpenSearch | Driver-specific table/index-not-found error on first write | Call `await adapter.initialize()` once on boot, or run the equivalent DDL yourself. |
| Adapter `disconnect()` not called on shutdown | None at runtime — connection leak in long-lived processes | Call `await adapter.disconnect()` in your shutdown hook. |

## Related

- [Persistence](../guides/persistence.md) — recipe for swapping memory for a real adapter
- [Architecture](../concepts/architecture.md) — where the adapter sits among the six primitives
- [createAgent](./create-agent.md) — the `persistence` and `sessionId` fields
- [Directive](./directive.md) — what `pendingDirective` stores
- [Signals](./signals.md) — what the `signals` column stores
- [Errors](./errors.md) — `SessionConflictError` fields and recovery
- [v1 → v2 migration](../migration/v1-to-v2.md) — column renames and DDL diffs
- [v2.3 → v2.4 migration](../migration/v2-3-to-v2-4.md) — the `version` column and `update()` signature change
