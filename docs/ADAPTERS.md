# Persistence Adapters Summary

All adapters follow the **provider pattern** - no dependencies required in the package, users install only what they need.

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

All adapters follow the same simple pattern:

```typescript
import { Agent, [Adapter]Adapter } from "@falai/agent";

const adapter = new [Adapter]Adapter({
  client: yourClientInstance,
  // ... adapter-specific options
});

const agent = new Agent({
  persistence: {
    adapter,
    userId: "user_123",
    autoSave: true,
  },
});
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

- Generic client interfaces
- Typed repository methods
- Full IDE autocomplete

## 🚀 Coming Soon

- **MySQLAdapter**: Traditional relational database (similar to PostgreSQL)
- **ElasticsearchAdapter**: Full-text search integration
- **DynamoDBAdapter**: AWS serverless storage

All adapters are production-ready and fully tested!
