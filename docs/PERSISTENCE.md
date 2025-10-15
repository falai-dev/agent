# Persistence with @falai/agent

The `@falai/agent` framework provides optional, flexible persistence for automatically saving conversation sessions, extracted data, and messages to your database.

## Features

- ✅ **Optional** - Persistence is completely optional
- ✅ **Provider Pattern** - Simple API like AI providers (`new PrismaAdapter({ prisma })`)
- ✅ **Type-safe** - Full TypeScript support with generics
- ✅ **Session State Integration** - Automatic saving of extracted data and conversation progress
- ✅ **Multiple Adapters** - Prisma, Redis, MongoDB, PostgreSQL, SQLite, OpenSearch, Memory
- ✅ **Extensible** - Create adapters for any database
- ✅ **Auto-save** - Automatic session state and message persistence

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

### 4. Use in Your Agent with Session State (That's it!)

```typescript
import { Agent, PrismaAdapter, GeminiProvider } from "@falai/agent";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// Define your extracted data type
interface BookingData {
  destination: string;
  date: string;
  passengers: number;
}

const agent = new Agent({
  name: "My Agent",
  ai: new GeminiProvider({ apiKey: "..." }),
  // ✨ Just add this!
  persistence: {
    adapter: new PrismaAdapter({ prisma }),
    userId: "user_123",
    autoSave: true, // Auto-saves session state!
  },
});

// Create a route with data extraction
const bookingRoute = agent.createRoute<BookingData>({
  title: "Book Flight",
  gatherSchema: {
    type: "object",
    properties: {
      destination: { type: "string" },
      date: { type: "string" },
      passengers: { type: "number" },
    },
    required: ["destination", "date", "passengers"],
  },
});

// Define states with smart data gathering and custom IDs
bookingRoute.initialState
  .transitionTo({
    id: "collect_details", // ✅ Custom state ID for easier tracking
    chatState: "Collect booking details",
    gather: ["destination", "date", "passengers"],
  })
  .transitionTo({
    id: "confirm_booking", // ✅ Custom state ID
    chatState: "Confirm all details",
    requiredData: ["destination", "date", "passengers"],
  });

// Access persistence methods
const persistence = agent.getPersistenceManager();

// Create a session with state support
const { sessionData, sessionState } =
  await persistence.createSessionWithState<BookingData>({
    userId: "user_123",
    agentName: "My Agent",
  });

// Session ID is automatically set in metadata
console.log("Session ID:", sessionState.metadata?.sessionId);
// Outputs: sessionData.id (e.g., "cuid_abc123")

// Load history
const history = await persistence.loadSessionHistory(sessionData.id);

// Generate response with session state
const response = await agent.respond({
  history,
  session: sessionState, // Pass session state with ID
});

// Session state is auto-saved! ✨
console.log("Extracted data:", response.session?.extracted);
console.log("Current state ID:", response.session?.currentState?.id); // Custom or auto-generated ID

// Save message
await persistence.saveMessage({
  sessionId: sessionData.id,
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

## Session State Integration

The new architecture automatically saves and loads `SessionState<TExtracted>` which includes:

- **Current route and state** - Track conversation progress
- **Extracted data** - All data gathered via `gatherSchema` and `gather` fields
- **Route history** - History of route transitions
- **Metadata** - Session timestamps and custom data

### How It Works

1. **Auto-Save**: When `autoSave: true`, session state is automatically persisted after each `respond()` call
2. **Conversion**: `SessionState` is automatically converted to `SessionData` for storage
3. **Recovery**: Load session state from database to resume conversations

### Create Session with State

```typescript
const { sessionData, sessionState } =
  await persistence.createSessionWithState<YourDataType>({
    userId: "user_123",
    agentName: "My Agent",
    initialData: {
      /* optional pre-filled data */
    },
  });

// sessionData: Database record
// sessionState: In-memory session state ready to use
```

### Save Session State

```typescript
// Manual save (not needed if autoSave: true)
await persistence.saveSessionState(sessionId, sessionState);
```

### Load Session State

```typescript
// Load session state from database
const sessionState = await persistence.loadSessionState<YourDataType>(
  sessionId
);

// Load message history
const history = await persistence.loadSessionHistory(sessionId);

// Resume conversation
const response = await agent.respond({
  history,
  session: sessionState,
});
```

### What Gets Persisted

The session state stores:

```typescript
{
  currentRoute: {
    id: "book_flight",
    title: "Book a Flight",
    enteredAt: Date
  },
  currentState: {
    id: "ask_dates",
    description: "Ask about travel dates",
    enteredAt: Date
  },
  extracted: {
    destination: "Paris",
    departureDate: "2025-06-15",
    passengers: 2
  },
  routeHistory: [
    { routeId: "book_flight", enteredAt: Date, completed: false }
  ],
  metadata: {
    sessionId: "session_123",
    createdAt: Date,
    lastUpdatedAt: Date
  }
}
```

This data is stored in `collectedData` field as JSON in the database.

## PersistenceManager API

Access via `agent.getPersistenceManager()`:

### Session Methods

```typescript
// Create session with state support (NEW!)
const { sessionData, sessionState } =
  await persistence.createSessionWithState<YourDataType>({
    userId: "user_123",
    agentName: "My Agent",
    initialData: {
      /* optional */
    },
  });

// Save session state (NEW!)
await persistence.saveSessionState(sessionId, sessionState);

// Load session state (NEW!)
const sessionState = await persistence.loadSessionState<YourDataType>(
  sessionId
);

// Create session (legacy)
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

1. ✅ **Use `createSessionWithState()`** - Get both database record and session state in one call
2. ✅ **Enable `autoSave: true`** - Automatically persist session state after each response
3. ✅ **Define extraction schemas** - Use `gatherSchema` in routes for structured data collection
4. ✅ **Pass session state** - Always pass `session` parameter to `agent.respond()`
5. ✅ **Load session state** - Use `loadSessionState()` to resume conversations
6. ✅ **Store extracted data** - Leverage `collectedData.extracted` for user input tracking
7. ✅ **Index frequently queried fields** - Add database indexes on `userId`, `status`, etc.
8. ✅ **Use cascading deletes** - Clean up messages automatically when deleting sessions
9. ✅ **Complete sessions** - Mark sessions as completed when conversation ends
10. ✅ **Handle errors gracefully** - Wrap persistence calls in try-catch blocks

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

### More Adapters

All adapters are production-ready and available now:

- **MongoDB**: Document-based storage ✅
- **PostgreSQL**: Raw SQL for custom schemas ✅
- **SQLite**: Lightweight file-based database ✅
- **OpenSearch**: Full-text search & analytics ✅
- **Memory**: Built-in for testing ✅

Create your own adapter by implementing the `PersistenceAdapter` interface!

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

### OpenSearch

Full-text search and analytics-powered persistence. Also compatible with Elasticsearch 7.x:

```typescript
import { OpenSearchAdapter } from "@falai/agent";
import { Client } from "@opensearch-project/opensearch";

const client = new Client({
  node: "https://localhost:9200",
  auth: {
    username: "admin",
    password: "admin",
  },
});

const adapter = new OpenSearchAdapter(client, {
  indices: {
    sessions: "agent_sessions",
    messages: "agent_messages",
  },
  autoCreateIndices: true, // Auto-create indices with mappings
  refresh: "wait_for", // Ensure documents are searchable immediately
});

// Auto-create indices with mappings
await adapter.initialize();

const agent = new Agent({
  persistence: { adapter },
});
```

**Install:** `npm install @opensearch-project/opensearch`

**Perfect for:**

- Full-text search across conversations
- Analytics and aggregations
- Time-series analysis
- AWS OpenSearch Service
- Elasticsearch 7.x users

**Advanced features:**

```typescript
// Get OpenSearch client for custom queries
const pm = agent.getPersistenceManager();
if (pm) {
  const messages = await pm.getSessionMessages(sessionId);

  // Now use the client directly for advanced queries
  const results = await client.search({
    index: "agent_messages",
    body: {
      query: {
        match: {
          content: "flight booking",
        },
      },
      aggregations: {
        by_route: {
          terms: { field: "route" },
        },
      },
    },
  });
}
```

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
