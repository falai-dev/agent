# Session Storage & Persistence

@falai/agent provides **automatic session management** through the integrated `SessionManager` class, eliminating manual session lifecycle management while providing comprehensive persistence capabilities for conversation state and history.

## Overview

The automatic session management system provides:

- **Zero-Boilerplate Sessions**: Automatic session creation, loading, and persistence
- **Built-in History Management**: Conversation history automatically maintained within sessions
- **Multi-Adapter Support**: Choose from multiple database backends
- **Server-Friendly Design**: Perfect for stateless server environments
- **Automatic Persistence**: Sessions auto-saved after each interaction
- **Type-Safe Operations**: Full TypeScript support with generics

## Enhanced Session State Structure

Sessions now include automatic conversation history management:

```typescript
interface SessionState<TData = unknown> {
  id: string; // Session identifier (always present)
  data: Partial<TData>; // Collected data from conversation
  dataByRoute: Record<string, Partial<TData>>; // Per-route data
  routeHistory: RouteHistoryEntry[]; // Route transition history
  currentRoute?: RouteRef; // Active route
  currentStep?: StepRef; // Active step
  history?: History; // Automatic conversation history
  metadata?: SessionMetadata; // Timestamps and custom data
}

// History is automatically managed
interface HistoryItem {
  role: 'user' | 'assistant' | 'system';
  content: string;
  name?: string;
  timestamp?: string; // ISO string
}
```

### What Gets Automatically Persisted

- **Collected Data**: All information gathered via `collect` fields and schemas
- **Conversation Progress**: Current route, step, and route history
- **Conversation History**: Automatic message history within sessions
- **Metadata**: Creation/update timestamps and custom fields
- **Session State**: Complete session state after each interaction

## Quick Start

### Automatic Session Management with Prisma

```typescript
import { Agent, PrismaAdapter } from "@falai/agent";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// Server endpoint with automatic session management
app.post('/chat', async (req, res) => {
  const { sessionId, message } = req.body;
  
  const agent = new Agent({
    name: "Customer Support",
    provider: new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY }),
    persistence: { adapter: new PrismaAdapter({ prisma }) },
    sessionId // Automatically loads or creates this session
  });
  
  const response = await agent.respond(message);
  
  res.json({
    message: response.message,
    sessionId: agent.session.id,
    isComplete: response.isRouteComplete
  });
});
```

### SessionManager API

The `SessionManager` provides a clean API for session operations:

```typescript
// Access the session manager
const sessionManager = agent.session;

// Get or create session (works for existing, new, or auto-generated IDs)
await sessionManager.getOrCreate("user-123");
await sessionManager.getOrCreate(); // Auto-generates ID

// History management (automatically persisted)
await sessionManager.addMessage("user", "Hello");
await sessionManager.addMessage("assistant", "Hi there!");
const history = sessionManager.getHistory();
sessionManager.clearHistory();

// Data access
const data = sessionManager.getData<MyDataType>();
await sessionManager.setData({ field: "value" });

// Session operations
await sessionManager.save(); // Manual save (auto-saves on addMessage)
await sessionManager.delete();
const newSession = await sessionManager.reset(true); // Preserve history
```

### Database Schema

```prisma
model AgentSession {
  id              String    @id @default(cuid())
  userId          String?   @map("user_id")
  agentName       String?   @map("agent_name")
  status          String    @default("active")
  currentRoute    String?   @map("current_route")
  currentStep     String?   @map("current_step")
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
  step      String?
  toolCalls Json?    @map("tool_calls")
  event     Json?
  createdAt DateTime @default(now()) @map("created_at")

  session AgentSession @relation(fields: [sessionId], references: [id], onDelete: Cascade)

  @@index([sessionId])
  @@map("agent_messages")
}
```

## Advanced Session Management

### Manual Session Operations

While sessions are managed automatically, you can perform manual operations when needed:

```typescript
// Access session manager directly
const sessionManager = agent.session;

// Create session with specific ID
await sessionManager.getOrCreate("custom-session-id");

// Session data management
await sessionManager.setData({
  userName: "John",
  preferences: { theme: "dark" },
});

// Get current session data
const data = sessionManager.getData<MyDataType>();
console.log(data.userName); // "John"

// Session information
console.log(sessionManager.id); // Current session ID
console.log(sessionManager.current); // Full session state
```

### History Management

```typescript
// Add messages to history (automatically persisted)
await sessionManager.addMessage("user", "Hello there");
await sessionManager.addMessage("assistant", "Hi! How can I help?");

// Get conversation history
const history = sessionManager.getHistory();
console.log(history); // Array of HistoryItem objects

// Set entire history (for migration or testing)
sessionManager.setHistory([
  { role: "user", content: "Previous message" },
  { role: "assistant", content: "Previous response" }
]);

// Clear history
sessionManager.clearHistory();
```

## Persistence Configuration

### Automatic Persistence Setup

```typescript
const agent = new Agent({
  name: "Assistant",
  provider: new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY }),
  persistence: {
    adapter: new PrismaAdapter({ prisma }),
    autoSave: true, // Auto-save after each interaction (default)
  },
  sessionId: "user-123" // Automatically loads or creates this session
});

// Sessions are automatically persisted - no manual save needed
const response = await agent.respond("Hello");
```

### Manual Session Operations (Advanced)

```typescript
// Access persistence manager if needed
const persistence = agent.session.getPersistenceManager();

// Manual save (usually not needed due to auto-save)
await agent.session.save();

// Delete session
await agent.session.delete();

// Reset session (creates new session, optionally preserving history)
const newSession = await agent.session.reset(true); // Preserve history
```

## Auto-Save Behavior

Sessions are automatically persisted after each interaction:

```typescript
const agent = new Agent({
  persistence: {
    adapter: new RedisAdapter(redisClient),
    autoSave: true, // Default behavior
  },
  sessionId: "user-123"
});

// Session automatically saved after each respond call
const response = await agent.respond("Hello");
// Session state automatically saved to Redis

// History automatically saved when messages are added
await agent.session.addMessage("user", "Follow-up question");
// Automatically persisted
```

### What Gets Auto-Saved

- **Collected Data**: All data from `collect` fields and schemas
- **Route Progress**: Current route and step
- **Route History**: Transition log
- **Conversation History**: Complete message history within sessions
- **Metadata**: Timestamps and custom fields

## Data Recovery & Resumption

### Automatic Session Loading

```typescript
// Agent automatically loads existing session
const agent = new Agent({
  name: "Assistant",
  provider: new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY }),
  persistence: { adapter: new PrismaAdapter({ prisma }) },
  sessionId: "existing-session-123" // Automatically loads this session
});

// Session and history automatically restored
const response = await agent.respond("Continue our conversation");
console.log(agent.session.getHistory()); // Previous conversation history
```

### Session Queries

```typescript
// Find active session for user
const activeSession = await persistence.findActiveSessionByUserId(userId);

// Get all sessions for user
const userSessions = await persistence.findSessionsByUserId(userId, {
  limit: 10,
});

// Get session by ID
const session = await persistence.findSessionById(sessionId);
```

## Message Persistence

### Automatic Message Saving

```typescript
const agent = new Agent({
  persistence: {
    adapter: new PrismaAdapter({ prisma }),
    autoSave: true, // Default - saves sessions and history
  },
  sessionId: "user-123"
});

// Messages automatically saved as part of session history
const response = await agent.respond("Hello");
// Both session state and conversation history automatically persisted
```

### Manual Message Operations

```typescript
// Save message manually
await persistence.saveMessage({
  sessionId: session.id,
  role: "user",
  content: "Hello!",
  route: session.currentRoute?.id,
  step: session.currentStep?.id,
});

// Load messages
const messages = await persistence.findMessagesBySessionId(session.id);

// Convert to Event format for agent
const history = await persistence.loadSessionHistory(session.id);
```

## Database Adapters

### Prisma Adapter

Full-featured ORM integration:

```typescript
import { PrismaAdapter } from "@falai/agent";

const adapter = new PrismaAdapter({
  prisma,
  tables: {
    sessions: "custom_sessions", // Custom table names
    messages: "custom_messages",
  },
  fieldMappings: {
    sessions: {
      userId: "user_id",
      createdAt: "created_at",
    },
  },
});
```

### Redis Adapter

High-performance key-value storage:

```typescript
import { RedisAdapter } from "@falai/agent";

const adapter = new RedisAdapter({
  redis: redisClient,
  keyPrefix: "agent:", // Key prefix
  sessionTTL: 86400, // 24 hours
  messageTTL: 604800, // 7 days
});
```

### MongoDB Adapter

Document-based flexible storage:

```typescript
import { MongoAdapter } from "@falai/agent";

const adapter = new MongoAdapter({
  client: mongoClient,
  databaseName: "myapp",
  collections: {
    sessions: "agent_sessions",
    messages: "agent_messages",
  },
});
```

### PostgreSQL Adapter

Raw SQL with auto-table creation:

```typescript
import { PostgreSQLAdapter } from "@falai/agent";

const adapter = new PostgreSQLAdapter({
  client: pgClient,
  tables: {
    sessions: "agent_sessions",
    messages: "agent_messages",
  },
});

// Auto-create tables
await adapter.initialize();
```

### SQLite Adapter

Lightweight file-based database:

```typescript
import { SQLiteAdapter } from "@falai/agent";

const adapter = new SQLiteAdapter({
  db: sqliteDb,
});

// Auto-create tables
await adapter.initialize();
```

### OpenSearch Adapter

Full-text search and analytics:

```typescript
import { OpenSearchAdapter } from "@falai/agent";

const adapter = new OpenSearchAdapter(client, {
  indices: {
    sessions: "agent_sessions",
    messages: "agent_messages",
  },
  autoCreateIndices: true,
});
```

### Memory Adapter

Testing and development:

```typescript
import { MemoryAdapter } from "@falai/agent";

const adapter = new MemoryAdapter();

// Useful for testing
const snapshot = adapter.getSnapshot();
adapter.clear();
```

## Advanced Patterns

### Context Synchronization

Auto-sync agent context with database:

```typescript
const agent = new Agent({
  context: { userId: "123", preferences: {} },
  hooks: {
    beforeRespond: async (context) => {
      // Load fresh context from database
      const session = await persistence.loadSessionState(context.sessionId);
      return {
        ...context,
        preferences: session?.data?.preferences || {},
      };
    },
    onContextUpdate: async (newContext, previousContext) => {
      // Save context changes
      if (newContext.preferences !== previousContext.preferences) {
        await persistence.updateCollectedData(newContext.sessionId, {
          preferences: newContext.preferences,
        });
      }
    },
  },
  persistence: {
    adapter: new PrismaAdapter({ prisma }),
    autoSave: true,
  },
});
```

### Session Lifecycle Management

```typescript
// Complete a session
await persistence.updateSessionStatus(sessionId, "completed", new Date());

// Abandon a session
await persistence.updateSessionStatus(sessionId, "abandoned");

// Clean up old sessions
const oldSessions = await persistence.findSessionsByUserId(userId, {
  status: "completed",
  olderThan: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), // 30 days ago
});

for (const session of oldSessions) {
  await persistence.deleteSession(session.id);
}
```

### Custom Adapters

Create adapters for any database:

```typescript
import {
  PersistenceAdapter,
  SessionRepository,
  MessageRepository,
} from "@falai/agent";

class CustomAdapter implements PersistenceAdapter {
  sessionRepository: SessionRepository;
  messageRepository: MessageRepository;

  constructor(config: CustomConfig) {
    this.sessionRepository = new CustomSessionRepository(config);
    this.messageRepository = new CustomMessageRepository(config);
  }

  async initialize?(): Promise<void> {
    // Setup database schema
  }
}
```

## Performance Optimization

### Connection Pooling

```typescript
// Reuse database connections
const prisma = new PrismaClient({
  datasources: {
    db: { url: process.env.DATABASE_URL },
  },
});

// Single adapter instance per application
const adapter = new PrismaAdapter({ prisma });
```

### Indexing Strategy

Ensure proper database indexes:

```sql
-- Essential indexes for performance
CREATE INDEX idx_sessions_user_status ON agent_sessions(user_id, status);
CREATE INDEX idx_sessions_updated ON agent_sessions(updated_at);
CREATE INDEX idx_messages_session ON agent_messages(session_id);
CREATE INDEX idx_messages_created ON agent_messages(created_at);
```

### Batch Operations

```typescript
// Batch save multiple messages
const messages = [
  { sessionId, role: "user", content: "Hi" },
  { sessionId, role: "assistant", content: "Hello!" },
];

await Promise.all(messages.map((msg) => persistence.saveMessage(msg)));
```

## Monitoring & Debugging

### Persistence Health Checks

```typescript
// Check adapter connectivity
try {
  await adapter.sessionRepository.findById("nonexistent");
  console.log("Persistence adapter is healthy");
} catch (error) {
  console.error("Persistence adapter error:", error);
}
```

### Session State Inspection

```typescript
// Debug session state
console.log("Session data:", session.data);
console.log("Current route:", session.currentRoute);
console.log("Current step:", session.currentStep);
console.log("Route history:", session.routeHistory);

// Validate session integrity
const isValid = session.id && session.data && session.metadata;
```

### Performance Monitoring

```typescript
// Monitor persistence operations
const startTime = Date.now();
await persistence.saveSessionState(sessionId, session);
const duration = Date.now() - startTime;

if (duration > 1000) {
  console.warn(`Slow persistence operation: ${duration}ms`);
}
```

## Best Practices

### Session Management

- **Always Set Session IDs**: Ensure sessions have unique identifiers
- **Use Auto-Save**: Enable `autoSave: true` for seamless persistence
- **Validate Data**: Use lifecycle hooks to validate collected data
- **Handle Errors**: Wrap persistence operations in error handling

### Database Design

- **Use Appropriate Indexes**: Index frequently queried fields
- **Plan Retention**: Implement session cleanup policies
- **Monitor Usage**: Track storage growth and query performance
- **Backup Regularly**: Ensure session data is backed up

### Performance

- **Connection Reuse**: Share database connections across requests
- **Batch Writes**: Group multiple operations when possible
- **Cache Frequently Read Data**: Cache session metadata if needed
- **Optimize Queries**: Use selective field retrieval

### Security

- **Validate User Access**: Ensure users can only access their sessions
- **Sanitize Data**: Clean user input before persistence
- **Audit Logging**: Log sensitive operations
- **Encryption**: Encrypt sensitive session data at rest

The persistence system enables robust, scalable conversational AI applications with reliable state management and comprehensive data recovery capabilities.
