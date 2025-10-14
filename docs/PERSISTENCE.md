# Persistence with @falai/agent

The `@falai/agent` framework provides optional, flexible persistence for automatically saving conversation sessions and messages to your database.

## Features

- ✅ **Optional** - Persistence is completely optional
- ✅ **Provider Pattern** - Simple API like AI providers (`new PrismaAdapter({ prisma })`)
- ✅ **Type-safe** - Full TypeScript support
- ✅ **Prisma Ready** - Built-in Prisma ORM adapter
- ✅ **Extensible** - Create adapters for any database
- ✅ **Auto-save** - Automatic message persistence

## Quick Start with Prisma

### 1. Install Dependencies

```bash
npm install @prisma/client prisma
npx prisma init
```

### 2. Set Up Schema

Copy this schema to `prisma/schema.prisma`:

```prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

generator client {
  provider = "prisma-client-js"
}

model AgentSession {
  id              String    @id @default(cuid())
  userId          String?   @map("user_id")
  agentName       String?   @map("agent_name")
  status          String    @default("active")
  currentRoute    String?   @map("current_route")
  currentState    String?   @map("current_state")
  collectedData   Json?     @map("collected_data")
  messageCount    Int       @default(0) @map("message_count")
  lastMessageAt   DateTime? @map("last_message_at")
  completedAt     DateTime? @map("completed_at")
  createdAt       DateTime  @default(now()) @map("created_at")
  updatedAt       DateTime  @updatedAt @map("updated_at")

  messages AgentMessage[]

  @@index([userId, status])
  @@map("agent_sessions")
}

model AgentMessage {
  id        String   @id @default(cuid())
  sessionId String   @map("session_id")
  userId    String?  @map("user_id")
  role      String
  content   String   @db.Text
  route     String?
  state     String?
  toolCalls Json?    @map("tool_calls")
  event     Json?
  createdAt DateTime @default(now()) @map("created_at")

  session AgentSession @relation(fields: [sessionId], references: [id], onDelete: Cascade)

  @@index([sessionId])
  @@map("agent_messages")
}
```

### 3. Generate and Migrate

```bash
npx prisma generate
npx prisma migrate dev --name init
```

### 4. Use in Your Agent (That's it!)

```typescript
import { Agent, PrismaAdapter, GeminiProvider } from "@falai/agent";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const agent = new Agent({
  name: "My Agent",
  ai: new GeminiProvider({ apiKey: "..." }),
  // ✨ Just add this!
  persistence: {
    adapter: new PrismaAdapter({ prisma }),
    userId: "user_123",
  },
});

// Access persistence methods
const persistence = agent.getPersistenceManager();

// Create a session
const session = await persistence.createSession({
  userId: "user_123",
  agentName: "My Agent",
});

// Load history
const history = await persistence.loadSessionHistory(session.id);

// Generate response
const response = await agent.respond({ history });

// Save message (auto-saved if configured)
await persistence.saveMessage({
  sessionId: session.id,
  role: "agent",
  content: response.message,
});
```

## Configuration Options

### Basic Configuration

```typescript
new PrismaAdapter({
  prisma: prismaClient, // Required: Your Prisma client
});
```

### Custom Table Names

```typescript
new PrismaAdapter({
  prisma,
  tables: {
    sessions: "myCustomSessions",
    messages: "myCustomMessages",
  },
});
```

### Custom Field Mappings

If your database uses different field names:

```typescript
new PrismaAdapter({
  prisma,
  fieldMappings: {
    sessions: {
      userId: "user_id",
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
    messages: {
      sessionId: "session_id",
      createdAt: "created_at",
    },
  },
});
```

## Auto-Save Messages

Enable automatic message persistence:

```typescript
const agent = new Agent({
  name: "My Agent",
  ai: provider,
  persistence: {
    adapter: new PrismaAdapter({ prisma }),
    autoSave: true, // Default: true
    userId: "user_123",
  },
});
```

## Using with Lifecycle Hooks

The most powerful pattern - auto-sync context with database:

```typescript
const agent = new Agent({
  name: "Smart Assistant",
  ai: provider,
  context: {
    userId: "user_123",
    sessionId: session.id,
    preferences: { theme: "light" },
  },
  hooks: {
    // Load fresh context before each response
    beforeRespond: async (ctx) => {
      const persistence = agent.getPersistenceManager();
      const session = await persistence?.getSession(ctx.sessionId);
      return {
        ...ctx,
        preferences: session?.collectedData?.preferences || ctx.preferences,
      };
    },
    // Auto-save context updates
    onContextUpdate: async (ctx) => {
      const persistence = agent.getPersistenceManager();
      await persistence?.updateCollectedData(ctx.sessionId, {
        preferences: ctx.preferences,
      });
    },
  },
  persistence: {
    adapter: new PrismaAdapter({ prisma }),
  },
});

// Now context updates are automatically persisted!
await agent.updateContext({ preferences: { theme: "dark" } });
```

## PersistenceManager API

Access via `agent.getPersistenceManager()`:

### Session Methods

```typescript
// Create session
await persistence.createSession({
  userId: "user_123",
  agentName: "My Agent",
  initialData: { key: "value" },
});

// Get session
await persistence.getSession(sessionId);

// Find active session for user
await persistence.findActiveSession(userId);

// Get all user sessions
await persistence.getUserSessions(userId);

// Update session
await persistence.updateSessionStatus(sessionId, "completed");
await persistence.updateCollectedData(sessionId, { key: "value" });
await persistence.updateRouteState(sessionId, routeId, stateId);

// Complete/abandon session
await persistence.completeSession(sessionId);
await persistence.abandonSession(sessionId);

// Delete session
await persistence.deleteSession(sessionId);
```

### Message Methods

```typescript
// Save message
await persistence.saveMessage({
  sessionId: session.id,
  userId: "user_123",
  role: "user" | "agent" | "system",
  content: "Hello!",
  route: "route_id",
  state: "state_id",
  toolCalls: [...],
});

// Get messages
await persistence.getSessionMessages(sessionId);
await persistence.getUserMessages(userId);

// Load as Event history
await persistence.loadSessionHistory(sessionId);
```

## Creating Custom Adapters

Create adapters for any database:

```typescript
import { PersistenceAdapter, SessionRepository, MessageRepository } from "@falai/agent";

class MyDatabaseAdapter implements PersistenceAdapter {
  public readonly sessionRepository: SessionRepository;
  public readonly messageRepository: MessageRepository;

  constructor(config: MyConfig) {
    this.sessionRepository = new MySessionRepository(config);
    this.messageRepository = new MyMessageRepository(config);
  }

  async initialize?(): Promise<void> {
    // Optional: Setup tables/indexes
  }

  async disconnect?(): Promise<void> {
    // Optional: Cleanup
  }
}

// Use it
const agent = new Agent({
  persistence: {
    adapter: new MyDatabaseAdapter({ ... }),
  },
});
```

## Examples

### Complete Example

See `examples/prisma-persistence.ts` for a full working example.

### Minimal Example

```typescript
import { Agent, PrismaAdapter } from "@falai/agent";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const agent = new Agent({
  name: "Assistant",
  ai: provider,
  persistence: {
    adapter: new PrismaAdapter({ prisma }),
  },
});

const persistence = agent.getPersistenceManager();
const session = await persistence.createSession({ userId: "user_123" });
const history = await persistence.loadSessionHistory(session.id);
const response = await agent.respond({ history });
await persistence.saveMessage({
  sessionId: session.id,
  role: "agent",
  content: response.message,
});
```

## Database Schema Details

### SessionData Fields

- `id`: Unique session identifier
- `userId`: Optional user identifier
- `agentName`: Name of the agent
- `status`: `"active" | "completed" | "abandoned"`
- `currentRoute`: Current route ID
- `currentState`: Current state ID
- `collectedData`: JSON object for custom data
- `messageCount`: Number of messages in session
- `lastMessageAt`: Timestamp of last message
- `completedAt`: When session was completed
- `createdAt`: Session creation time
- `updatedAt`: Last update time

### MessageData Fields

- `id`: Unique message identifier
- `sessionId`: Reference to session
- `userId`: Optional user identifier
- `role`: `"user" | "agent" | "system"`
- `content`: Message text
- `route`: Route ID when message was sent
- `state`: State ID when message was sent
- `toolCalls`: Array of tool calls (if any)
- `event`: Full event data (optional)
- `createdAt`: Message creation time

## Best Practices

1. ✅ Use lifecycle hooks for automatic context persistence
2. ✅ Enable `autoSave` to track message counts automatically
3. ✅ Store minimal data in `collectedData`
4. ✅ Index frequently queried fields
5. ✅ Use cascading deletes for cleanup
6. ✅ Handle errors gracefully
7. ✅ Complete or abandon sessions when done

## Troubleshooting

### "Cannot find module '@prisma/client'"

Install Prisma:

```bash
npm install @prisma/client prisma
npx prisma generate
```

### "Table not found"

Run migrations:

```bash
npx prisma migrate dev
```

### Custom schema not working

Check your field mappings match your actual database schema.

## Other Databases

The adapter pattern works with any database. Built-in adapters:

### Redis

Perfect for high-throughput, real-time applications:

```typescript
import { RedisAdapter } from "@falai/agent";
import Redis from "ioredis";

const redis = new Redis();

const agent = new Agent({
  persistence: {
    adapter: new RedisAdapter({
      redis,
      keyPrefix: "agent:", // Optional: custom prefix
      sessionTTL: 24 * 60 * 60, // Optional: 24 hours
      messageTTL: 7 * 24 * 60 * 60, // Optional: 7 days
    }),
  },
});
```

**Install:** `npm install ioredis` or `npm install redis`

### Coming Soon

Create your own adapter for:

- **MongoDB**: Document-based storage ✅ **Available!**
- **PostgreSQL**: Raw SQL for custom schemas ✅ **Available!**
- **MySQL**: Traditional relational database (coming soon)
- **Elasticsearch**: Full-text search integration (coming soon)

Just implement the `PersistenceAdapter` interface!

### MongoDB

Document-based storage with flexible schema:

```typescript
import { MongoAdapter } from "@falai/agent";
import { MongoClient } from "mongodb";

const client = new MongoClient("mongodb://localhost:27017");
await client.connect();

const agent = new Agent({
  persistence: {
    adapter: new MongoAdapter({
      client,
      databaseName: "myapp",
      collections: {
        // Optional: custom names
        sessions: "agent_sessions",
        messages: "agent_messages",
      },
    }),
  },
});
```

**Install:** `npm install mongodb`

### PostgreSQL

Raw SQL adapter with auto-table creation:

```typescript
import { PostgreSQLAdapter } from "@falai/agent";
import { Client } from "pg";

const client = new Client({
  host: "localhost",
  database: "myapp",
  user: "postgres",
  password: "password",
});
await client.connect();

const adapter = new PostgreSQLAdapter({
  client,
  tables: {
    // Optional: custom names
    sessions: "agent_sessions",
    messages: "agent_messages",
  },
});

// Auto-create tables with indexes
await adapter.initialize();

const agent = new Agent({
  persistence: {
    adapter,
  },
});
```

**Install:** `npm install pg`

**Note:** PostgreSQL adapter includes `initialize()` method to auto-create tables with proper indexes and foreign keys.

### SQLite

Lightweight, file-based database for local development:

```typescript
import { SQLiteAdapter } from "@falai/agent";
import Database from "better-sqlite3";

const db = new Database("agent.db");

const adapter = new SQLiteAdapter({ db });

// Auto-create tables
await adapter.initialize();

const agent = new Agent({
  persistence: { adapter },
});
```

**Install:** `npm install better-sqlite3`

**Perfect for:**

- Local development
- Testing
- Desktop applications
- Single-user apps

### Memory (Built-in)

Zero-dependency in-memory storage for testing:

```typescript
import { MemoryAdapter } from "@falai/agent";

const agent = new Agent({
  persistence: {
    adapter: new MemoryAdapter(),
    userId: "test_user",
  },
});

// Perfect for unit tests - no database setup required!
```

**Features:**

- No installation required ✨
- Perfect for testing
- Data snapshot for debugging
- Clear method for test cleanup

**Example test:**

```typescript
describe("Agent persistence", () => {
  const adapter = new MemoryAdapter();

  afterEach(() => {
    adapter.clear(); // Clean state between tests
  });

  it("should save session", async () => {
    const agent = new Agent({
      persistence: { adapter },
    });

    // Test your logic...

    const snapshot = adapter.getSnapshot();
    expect(snapshot.sessions).toHaveLength(1);
  });
});
```
