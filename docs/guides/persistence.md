---
title: "Persistence"
description: "Swap the in-memory default for a durable adapter so sessions survive restarts and span processes."
type: guide
order: 5
---

# Persistence

By default, `createAgent` runs against an in-process `MemoryAdapter`. That is the right choice while you are building — zero setup, instant resets between tests — but it forgets every conversation the moment the process exits. Production needs storage that outlives a deploy, scales to multiple replicas, and lets a session resume by id from any machine.

This guide covers the swap. You will pick an adapter, wire it through `persistence`, resume sessions by `sessionId`, and run the v1 → v2 schema migration if you are upgrading an existing store.

## The seven adapters

`@falai/agent` ships seven adapters. Every one implements the same `PersistenceAdapter` interface, so the swap is one field on `createAgent`.

| Adapter | When to reach for it |
|---------|---------------------|
| [`MemoryAdapter`](../reference/adapters.md#memoryadapter) | The implicit default. Tests, prototypes, single-process demos. |
| [`PrismaAdapter`](../reference/adapters.md#prismaadapter) | You already use Prisma; want a typed schema. |
| [`RedisAdapter`](../reference/adapters.md#redisadapter) | Fast, ephemeral, TTL-driven session storage. |
| [`MongoAdapter`](../reference/adapters.md#mongoadapter) | Document-shape; flexible session payloads. |
| [`PostgreSQLAdapter`](../reference/adapters.md#postgresqladapter) | Single SQL backend without an ORM. |
| [`SQLiteAdapter`](../reference/adapters.md#sqliteadapter) | Local dev, single-node deploys, CLI tools. |
| [`OpenSearchAdapter`](../reference/adapters.md#opensearchadapter) | Searchable session and message archive. |

The full per-option contract for every adapter lives in [persistence adapters](../reference/adapters.md). This page sticks to the moves you make once.

## Recipe 1: Swap memory for Prisma

The fastest path to a real database. Add Prisma, declare the session model, point the adapter at the generated client.

**1. Install Prisma.**

```bash
bun add @prisma/client
bun add -d prisma
bunx prisma init
```

**2. Declare the session model.** Two columns matter most: `pendingDirective` and `signals`. The agent serializes its [`Directive`](../reference/directive.md) and signals state into them at the end of every turn and reads them back at the start of the next. Both are required on every adapter's session schema in v2.

```prisma
model AgentSession {
  id                String    @id
  userId            String?
  status            String    @default("active")
  currentFlow       String?
  currentStep       String?
  collectedData     Json?
  pendingDirective  Json?
  signals           Json?
  messageCount      Int       @default(0)
  lastMessageAt     DateTime?
  completedAt       DateTime?
  createdAt         DateTime  @default(now())
  updatedAt         DateTime  @updatedAt
}
```

**3. Push and generate.**

```bash
bunx prisma db push
bunx prisma generate
```

**4. Wire the adapter.** Only one field changes on `createAgent` — every flow, step, tool, and instruction stays the same.

```typescript
import { PrismaClient } from "@prisma/client";
import { createAgent, GeminiProvider, PrismaAdapter } from "@falai/agent";

const prisma = new PrismaClient();

export const agent = createAgent({
  name: "BookingBot",
  provider: new GeminiProvider({ apiKey: process.env.GEMINI_API_KEY! }),
  schema,
  flows,
  persistence: {
    adapter: new PrismaAdapter({ prisma }),
    userId: "user_123",
  },
});
```

That is the whole swap. Every `agent.respond` call now reads and writes through Prisma instead of an in-process map.

## Recipe 2: Resume a conversation with `sessionId`

`sessionId` is the contract between client and server. The same id on every request keeps the user pinned to the same conversation; the adapter loads the right `pendingDirective` and `signals`, the agent picks up exactly where the last turn ended.

There are two equivalent patterns — pick whichever fits your call site.

**Construct-time.** Pass `sessionId` to `createAgent` and the engine auto-loads it at the start of the first turn:

```typescript
const agent = createAgent({
  /* ...same as above... */
  persistence: { adapter: new PrismaAdapter({ prisma }) },
  sessionId: "user_123:thread_abc",
});

await agent.respond({ history: [{ role: "user", content: "Hi again" }] });
```

**Per-request.** Hydrate explicitly when the session id is only known at request time (typical HTTP server shape):

```typescript
const session = await agent.session.getOrCreate("user_123:thread_abc");

const response = await agent.respond({
  history: [{ role: "user", content: "Hi again" }],
  session,
});
```

`getOrCreate` returns the stored `SessionState` (collected data, flow position, `pendingDirective`, signals state) — or creates a fresh session with that id if nothing exists yet. Unknown ids are not an error path; they are the start of a new conversation pinned to that id.

A practical id shape: `<userId>:<threadId>`. Keep it stable across restarts and replicas. The adapter does the rest.

## Recipe 3: Redis for fast, ephemeral sessions

Redis is the right pick when you want fast reads, automatic expiry, and do not need long-term archives — chat widgets, ephemeral copilots, anything where a session can reasonably TTL out after a day. The adapter writes JSON-serialized strings under prefixed keys; `pendingDirective` and `signals` ride along inside the session value transparently, so there is no schema to migrate.

```typescript
import Redis from "ioredis";
import { createAgent, GeminiProvider, RedisAdapter } from "@falai/agent";

const redis = new Redis(process.env.REDIS_URL!);

export const agent = createAgent({
  name: "BookingBot",
  provider: new GeminiProvider({ apiKey: process.env.GEMINI_API_KEY! }),
  schema,
  flows,
  persistence: {
    adapter: new RedisAdapter({
      redis,
      keyPrefix: "myapp:agent:",
      sessionTTL: 60 * 60 * 24, // 1 day
      messageTTL: 60 * 60 * 24 * 7, // 1 week
    }),
    userId: "user_123",
  },
});
```

A few things worth noting:

- `keyPrefix` namespaces every key the adapter writes — pick something app-specific so it coexists cleanly with other Redis tenants.
- `sessionTTL` and `messageTTL` are seconds. Pass a large number to effectively disable expiry; default is 7 days for sessions, 30 days for messages.
- Connection pooling and reconnect strategy come from your Redis client (`ioredis` or `node-redis`) — the adapter does not own them.

If you need an archive of every session and message (audit logs, search, analytics), pair Redis with a second adapter on a slower path, or pick a durable adapter from the table above directly.

## Schema migration: v1 → v2

If you are upgrading an existing v1 store, the session schema needs two new columns before v2 runs against it:

- **`pendingDirective`** — the persisted [`Directive`](../reference/directive.md) consumed at the start of the next turn. Replaces the v1 column for the same slot.
- **`signals`** (new in v2) — the [signals](../reference/signals.md) runtime state. Required even if you do not use signals; v2 reads and writes it.

Without these columns, v2 throws a driver-specific column-not-found error on the first write, and any v1 value in the old slot is silently dropped on read.

The full migration steps per adapter — SQL `ALTER TABLE` for Postgres and SQLite, Prisma model diff, MongoDB `updateMany`, Redis Lua transform, OpenSearch `_reindex` script — live in the [v1 → v2 migration guide](../migration/v1-to-v2.md). Run those once against your store before deploying v2.

For brand-new v2 deploys there is nothing to migrate. The `PostgreSQLAdapter`, `SQLiteAdapter`, and `OpenSearchAdapter` create v2-shaped tables and indices when you call `await adapter.initialize()` once on boot. The `PrismaAdapter` and `MongoAdapter` follow your declared schema. The `MemoryAdapter` and `RedisAdapter` need no DDL at all.

## Verification

A quick checklist after the swap:

1. **Restart the process between turns** and confirm the session resumes — same flow, same step, same collected data.
2. **Inspect the row.** `pendingDirective` and `signals` should be present (possibly `null`); `collectedData` should hold whatever fields the user has supplied so far.
3. **Run two requests with the same `sessionId` from different processes** (e.g., two `curl` calls against your endpoint). The second turn should land at the right step without re-asking for collected fields.

If any of these fails, the issue is almost always the schema — re-check the column names against [persistence adapters](../reference/adapters.md) for your adapter and run the [v1 → v2 migration](../migration/v1-to-v2.md) if applicable.

**Next:** [Streaming](./streaming.md)
