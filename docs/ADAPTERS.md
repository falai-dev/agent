# Persistence Adapters Summary

All adapters follow the **provider pattern** - no dependencies required in the package, users install only what they need.

**NEW**: All adapters now support the new **Session State** pattern with automatic persistence of extracted data, current route/state, and conversation progress!

## ✅ Implemented Adapters

### 1. **PrismaAdapter**

- **Use case:** Type-safe ORM with migrations
- **Install:** `npm install @prisma/client`
- **Features:**
  - Auto-migration support
  - Custom field mappings
  - Works with any Prisma-supported database

### 2. **RedisAdapter**

- **Use case:** High-throughput, real-time apps
- **Install:** `npm install ioredis` or `npm install redis`
- **Features:**
  - Fast in-memory storage
  - Configurable TTLs
  - Custom key prefixes

### 3. **MongoAdapter**

- **Use case:** Flexible document storage
- **Install:** `npm install mongodb`
- **Features:**
  - Schema-less design
  - Custom collection names
  - Native MongoDB queries

### 4. **PostgreSQLAdapter**

- **Use case:** Raw SQL with custom schemas
- **Install:** `npm install pg`
- **Features:**
  - Auto table/index creation
  - Foreign key constraints
  - Full SQL control

### 5. **SQLiteAdapter**

- **Use case:** Lightweight local database
- **Install:** `npm install better-sqlite3`
- **Features:**
  - File-based database
  - Perfect for local development
  - Auto table/index creation
  - Zero configuration

### 6. **OpenSearchAdapter**

- **Use case:** Full-text search & analytics
- **Install:** `npm install @opensearch-project/opensearch`
- **Features:**
  - Built-in full-text search
  - Powerful aggregations
  - Auto index/mapping creation
  - Compatible with Elasticsearch 7.x
  - AWS OpenSearch Service ready

### 7. **MemoryAdapter**

- **Use case:** Testing & development
- **Install:** Built-in (no dependencies required) ✨
- **Features:**
  - In-memory storage
  - No setup required
  - Perfect for unit tests
  - Data snapshot/clear utilities

## 🎯 Usage Pattern

All adapters follow the same simple pattern with full session state support:

```typescript
import { Agent, [Adapter]Adapter } from "@falai/agent";

// Define your data extraction type
interface YourDataType {
  field1: string;
  field2: number;
}

const adapter = new [Adapter]Adapter({
  client: yourClientInstance,
  // ... adapter-specific options
});

const agent = new Agent({
  persistence: {
    adapter,
    userId: "user_123",
    autoSave: true, // ✨ Auto-saves session state!
  },
});

// Create a route with data extraction
const route = agent.createRoute<YourDataType>({
  title: "My Route",
  extractionSchema: {
    type: "object",
    properties: {
      field1: { type: "string" },
      field2: { type: "number" },
    },
    required: ["field1", "field2"],
  },
});

// Define states
route.initialState.transitionTo({
  chatState: "Collect data",
  gather: ["field1", "field2"],
});

// Use with session state
const persistence = agent.getPersistenceManager();
const { sessionData, sessionState } =
  await persistence.createSessionWithState<YourDataType>({
    userId: "user_123",
    agentName: "My Agent",
  });

// Chat with automatic session state persistence
const response = await agent.respond({
  history: [...],
  session: sessionState, // Pass session state
});

// Session state auto-saved! Includes extracted data
console.log("Extracted:", response.session?.extracted);
```

## 🔌 Optional Dependencies

All database clients are **optional peer dependencies** - they won't be installed unless you explicitly add them:

```json
{
  "peerDependencies": {
    "@prisma/client": "^6.0.0",
    "ioredis": "^5.7.0",
    "redis": "^4.6.0 || ^5.0.0",
    "mongodb": "^6.0.0 || ^7.0.0",
    "pg": "^8.11.0",
    "mysql2": "^3.2.0",
    "better-sqlite3": "^11.0.0 || ^12.0.0",
    "@opensearch-project/opensearch": "^2.0.0"
  },
  "peerDependenciesMeta": {
    "@prisma/client": { "optional": true },
    "ioredis": { "optional": true },
    "redis": { "optional": true },
    "mongodb": { "optional": true },
    "pg": { "optional": true },
    "mysql2": { "optional": true },
    "better-sqlite3": { "optional": true }
  }
}
```

## 🛠️ Creating Custom Adapters

Implement the `PersistenceAdapter` interface:

```typescript
import type { PersistenceAdapter } from "@falai/agent";

export class MyCustomAdapter implements PersistenceAdapter {
  sessionRepository: SessionRepository;
  messageRepository: MessageRepository;

  constructor(options: MyAdapterOptions) {
    this.sessionRepository = new MySessionRepository(options);
    this.messageRepository = new MyMessageRepository(options);
  }

  async initialize?(): Promise<void> {
    // Optional: setup tables, indexes, etc.
  }

  async disconnect?(): Promise<void> {
    // Optional: cleanup
  }
}
```

## 📝 Type Safety

All adapters are fully typed with **zero `any` types** (except for Prisma's dynamic model access):

- Generic client interfaces with `SessionState<TExtracted>` support
- Typed repository methods
- Full IDE autocomplete
- Type-safe data extraction throughout

## 💾 What Gets Stored

All adapters store session state in the `collectedData` JSON field:

```json
{
  "extracted": {
    "destination": "Paris",
    "departureDate": "2025-06-15",
    "passengers": 2
  },
  "routeHistory": [
    {
      "routeId": "book_flight",
      "enteredAt": "2025-10-15T10:00:00Z",
      "completed": false
    }
  ],
  "currentRouteTitle": "Book a Flight",
  "currentStateDescription": "Ask about travel dates",
  "metadata": {
    "sessionId": "session_123",
    "createdAt": "2025-10-15T10:00:00Z",
    "lastUpdatedAt": "2025-10-15T10:05:00Z"
  }
}
```

This allows:

- ✅ Full session state recovery
- ✅ Analytics on extracted data
- ✅ Conversation progress tracking
- ✅ Multi-turn conversation support

## 🚀 Coming Soon

- **MySQLAdapter**: Traditional relational database (similar to PostgreSQL)
- **ElasticsearchAdapter**: Full-text search integration
- **DynamoDBAdapter**: AWS serverless storage

All adapters are production-ready and fully tested!
