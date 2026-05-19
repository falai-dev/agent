---
title: "Go to production"
description: "Add durable persistence, streaming responses, and an HTTP endpoint to ship the booking agent."
type: tutorial
order: 5
---

# Go to production

The framework stays the same shape from prototype to production; only the adapter and the call site change. This page adds `PrismaAdapter` for durable sessions, `respondStream` for real-time output, and a session-keyed POST endpoint that any chat client can call. Same seven primitives, same booking flow — now with persistence and streaming on top.

The booking agent from [04 — Add tools](./04-add-tools.md) runs end to end, but it forgets every conversation the moment the process exits, hands replies back as one final string, and lives in a script. Production has three more requirements: durability, real-time output, and a way for clients to talk to it. This page wires up all three.

You will:

1. Swap the implicit `MemoryAdapter` for `PrismaAdapter` so sessions survive restarts.
2. Switch the call site from `agent.respond` to `agent.respondStream` and consume chunks as they arrive.
3. Wrap the agent in a session-keyed POST endpoint that any chat client can call.

By the end you have the same booking agent — same flow, same tools — running behind an HTTP API with persistent state.

## 1. Persist sessions with Prisma

By default `createAgent` uses `MemoryAdapter`, an in-process map that vanishes with the process. Production needs storage that outlives a deploy. `PrismaAdapter` rides on top of any Prisma-supported database; you own the schema, the adapter does the reads and writes.

Add Prisma to the project:

```bash
bun add @prisma/client
bun add -d prisma
bunx prisma init
```

Open the generated `prisma/schema.prisma` and add the `AgentSession` and `AgentMessage` models. Two columns matter most: `pendingDirective` and `signals`. The agent serializes its [`Directive`](../reference/directive.md) and signal state into them at the end of every turn and reads them back at the start of the next.

```prisma
// prisma/schema.prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

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
  messageCount      Int       @default(0)
  lastMessageAt     DateTime?
  completedAt       DateTime?
  createdAt         DateTime  @default(now())
  updatedAt         DateTime  @updatedAt
}

model AgentMessage {
  id        String   @id @default(cuid())
  sessionId String
  role      String
  content   String
  createdAt DateTime @default(now())

  @@index([sessionId, createdAt])
}
```

Push the schema and generate the client:

```bash
bunx prisma db push
bunx prisma generate
```

Now wire the adapter into the booking agent. The only change from the previous tutorial is the new `persistence` field — every flow, step, tool, and instruction stays exactly the same.

```typescript
import { PrismaClient } from "@prisma/client";
import { createAgent, GeminiProvider, PrismaAdapter } from "@falai/agent";
import { bookingFlow, bookingTools, bookingInstructions, schema } from "./booking";

const prisma = new PrismaClient();

export const agent = createAgent({
  name: "BookingBot",
  provider: new GeminiProvider({ apiKey: process.env.GEMINI_API_KEY! }),
  schema,
  flows: [bookingFlow],
  tools: bookingTools,
  instructions: bookingInstructions,
  persistence: {
    adapter: new PrismaAdapter({ prisma }),
    userId: "user_123",
  },
});
```

To resume a conversation by id, hydrate the session from the adapter and pass it through. `agent.session.getOrCreate(sessionId)` loads the stored `SessionState` (collected data, flow position, `pendingDirective`, signals state) — or creates a fresh one with that id if nothing exists yet.

```typescript
const session = await agent.session.getOrCreate("user_123:thread_abc");

const response = await agent.respond({
  history: [{ role: "user", content: "Hi again" }],
  session,
});
```

Unknown ids start fresh against that id; there is no "not found" error path.

For the full schema migration story (renaming `pending_transition` to `pendingDirective`, adding the `signals` column) see [persistence adapters reference](../reference/adapters.md#prismaadapter).

## 2. Stream responses

`agent.respond` returns one final `AgentResponse` after the LLM and any tools have finished. That works for batch jobs, but a chat UI feels dead until the first character lands. `agent.respondStream` returns an `AsyncGenerator<AgentResponseStreamChunk>` — every chunk has the latest `delta` and `accumulated` text, plus a `done` flag.

```typescript
const stream = agent.respondStream({
  history: [{ role: "user", content: "Book me a hotel in Lisbon for two nights." }],
});

for await (const chunk of stream) {
  if (chunk.delta) {
    process.stdout.write(chunk.delta);
  }
  if (chunk.done) {
    console.log("\n---");
    console.log("Applied instructions:", chunk.appliedInstructions);
    console.log("Triggered signals:", chunk.triggeredSignals);
    console.log("Flow complete:", chunk.isFlowComplete);
  }
}
```

Two fields land only on the terminal chunk (`done: true`):

- `appliedInstructions` — the [instructions](../reference/instruction.md) whose conditions passed and were rendered into this turn's prompt. Deterministic; derived from rendering, not from LLM self-report.
- `triggeredSignals` — the signals (if any) that fired during this turn, in fire order.

Use them for telemetry, audit logs, or showing the user which guardrails ran. They mirror the same fields on the non-streaming `AgentResponse`, so swapping between APIs does not change observability.

To cancel mid-stream — say, the user hits Stop — pass an `AbortSignal`:

```typescript
const controller = new AbortController();
setTimeout(() => controller.abort(), 5000);

const stream = agent.respondStream({
  history,
  signal: controller.signal,
});
```

## 3. A session-keyed HTTP endpoint

The agent is now durable and streaming. The last piece is exposing it. Any HTTP framework works — Express, Bun.serve, Fastify, Hono. The pattern is the same: accept a `sessionId` and `message`, look up history, stream chunks back to the client. This Bun example is one screenful.

```typescript
import { agent } from "./agent";

Bun.serve({
  port: 3000,
  async fetch(req) {
    if (req.method !== "POST" || new URL(req.url).pathname !== "/chat") {
      return new Response("Not found", { status: 404 });
    }

    const { sessionId, message } = await req.json() as {
      sessionId: string;
      message: string;
    };

    const session = await agent.session.getOrCreate(sessionId);

    const stream = agent.respondStream({
      history: [{ role: "user", content: message }],
      session,
    });

    return new Response(
      new ReadableStream({
        async start(controller) {
          for await (const chunk of stream) {
            controller.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify({
                  delta: chunk.delta,
                  done: chunk.done,
                  isFlowComplete: chunk.isFlowComplete,
                })}\n\n`
              )
            );
          }
          controller.close();
        },
      }),
      { headers: { "Content-Type": "text/event-stream" } }
    );
  },
});
```

The shape that matters: `sessionId` is the contract between client and server. The same id on every request keeps the user pinned to the same conversation; the adapter loads the right `pendingDirective` and `signals`, the agent picks up exactly where the last turn ended. No per-request setup, no global state.

A real chat backend adds auth, rate limits, and persistent message storage — but the core glue is the four lines that build `agent`, the four lines that read `request.json()`, and the loop that pipes stream chunks into Server-Sent Events.

That is the full path: a 12-line `createAgent` call in [02 — Your first agent](./02-first-agent.md), data extraction in [03](./03-collect-data.md), tools in [04](./04-add-tools.md), and now durable, streaming, HTTP-served. The framework stays the same shape from prototype to production — only the adapter and the call site change.

**Next:** [How-to guides](../guides/conditions.md)
