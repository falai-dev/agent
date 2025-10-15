# API Reference

Complete API documentation for `@falai/agent`.

---

## Core Classes

### `Agent<TContext>`

Main agent class for managing conversational AI.

#### Constructor

```typescript
new Agent<TContext>(options: AgentOptions<TContext>)
```

See [Constructor Options](./CONSTRUCTOR_OPTIONS.md) for full details.

#### Methods

##### `createRoute(options: RouteOptions): Route`

Creates a new conversation route.

##### `createTerm(term: Term): this`

Adds a domain glossary term. Returns `this` for chaining.

##### `createGuideline(guideline: Guideline): this`

Adds a behavioral guideline. Returns `this` for chaining.

##### `createCapability(capability: Capability): this`

Adds an agent capability. Returns `this` for chaining.

##### `addDomain<TName, TDomain>(name: TName, domainObject: TDomain): void`

Registers a domain with tools/methods.

##### `getDomainsForRoute(routeId: string): Record<string, Record<string, unknown>>`

Gets allowed domains for a specific route by ID. Returns filtered domains based on route's `domains` property, or all domains if route has no restrictions.

##### `getDomainsForRouteByTitle(routeTitle: string): Record<string, Record<string, unknown>>`

Gets allowed domains for a specific route by title. Returns filtered domains based on route's `domains` property, or all domains if route has no restrictions.

##### `respond(input: RespondInput<TContext>): Promise<RespondOutput>`

Generates an AI response with session state management, data extraction, and intelligent routing.

```typescript
interface RespondInput<TContext> {
  history: Event[];
  session?: SessionState; // NEW: Session state for conversation tracking
  contextOverride?: Partial<TContext>;
  signal?: AbortSignal;
}

interface RespondOutput {
  /** The message to send to the user */
  message: string;
  /** Updated session state (includes extracted data, current route/state) */
  session?: SessionState;
  /** Tool calls executed during response (for debugging) */
  toolCalls?: Array<{
    toolName: string;
    arguments: Record<string, unknown>;
  }>;
}
```

**Enhanced Response Pipeline:**

1. **Tool Execution** - Execute tools if current state has `toolState`
2. **Always-On Routing** - Score all routes, respect user intent to change direction
3. **State Traversal** - Use `skipIf` and `requiredData` to determine next state
4. **Response Generation** - Build schema with `gather` fields, extract data
5. **Session Update** - Merge extracted data into session state

**Session State Management:**

- Tracks current route, state, and extracted data across turns
- Enables "I changed my mind" scenarios with context-aware routing
- Automatically merges new extracted data with existing session data

**Example with Persistence Adapters:**

```typescript
import { createSession } from "@falai/agent";

// Using built-in persistence adapters
const { sessionData, sessionState } =
  await persistence.createSessionWithState<FlightData>({
    userId: "user_123",
    agentName: "Travel Agent",
  });

const response = await agent.respond({
  history,
  session: sessionState, // Auto-saves if autoSave: true
});
```

**Example with Custom Database (Manual):**

```typescript
import { createSession, SessionState } from "@falai/agent";

// Load from your custom database
const dbSession = await yourDb.sessions.findOne({ id: sessionId });

// Restore or create session state
let agentSession: SessionState<YourDataType>;

if (dbSession && dbSession.currentRoute && dbSession.collectedData) {
  // Restore existing session from database
  agentSession = {
    currentRoute: {
      id: dbSession.currentRoute,
      title:
        dbSession.collectedData?.currentRouteTitle || dbSession.currentRoute,
      enteredAt: new Date(),
    },
    currentState: dbSession.currentState
      ? {
          id: dbSession.currentState,
          description: dbSession.collectedData?.currentStateDescription,
          enteredAt: new Date(),
        }
      : undefined,
    extracted: dbSession.collectedData?.extracted || {},
    routeHistory: dbSession.collectedData?.routeHistory || [],
    metadata: {
      sessionId: dbSession.id,
      createdAt: dbSession.createdAt,
      lastUpdatedAt: new Date(),
    },
  };
} else {
  // Create new session
  agentSession = createSession<YourDataType>({
    sessionId: dbSession?.id || "new-session-id",
  });
}

// Use session in conversation
const response = await agent.respond({
  history,
  session: agentSession,
});

// Manually save to your database
await yourDb.sessions.update({
  id: dbSession.id,
  currentRoute: response.session?.currentRoute?.id,
  currentState: response.session?.currentState?.id,
  collectedData: {
    extracted: response.session?.extracted,
    routeHistory: response.session?.routeHistory,
    currentRouteTitle: response.session?.currentRoute?.title,
    currentStateDescription: response.session?.currentState?.description,
    metadata: response.session?.metadata,
  },
  lastMessageAt: new Date(),
});

// Save message
await yourDb.messages.create({
  sessionId: dbSession.id,
  role: "agent",
  content: response.message,
  route: response.session?.currentRoute?.id,
  state: response.session?.currentState?.id,
});
```

See also: [Custom Database Integration Example](../examples/custom-database-persistence.ts)

##### `respondStream(input: RespondInput<TContext>): AsyncGenerator<StreamChunk>`

Generates an AI response as a real-time stream for better user experience. Provides the same structured output as `respond()` but delivers it incrementally.

```typescript
interface StreamChunk {
  /** The incremental text delta */
  delta: string;
  /** Full accumulated text so far */
  accumulated: string;
  /** Whether this is the final chunk */
  done: boolean;
  /** Route chosen by the agent (only in final chunk) */
  route?: { id: string; title: string };
  /** Current state within the route (only in final chunk) */
  state?: { id: string; description?: string };
  /** Tool calls requested by the agent (only in final chunk) */
  toolCalls?: Array<{
    toolName: string;
    arguments: Record<string, unknown>;
  }>;
}
```

**Key Features:**

- 🌊 Real-time streaming for better perceived performance
- 📊 Access to route, state, and tool information in final chunk
- 🛑 Cancellable with AbortSignal
- ✅ Supported by all providers (Anthropic, OpenAI, Gemini, OpenRouter)

**Example:**

```typescript
// Basic streaming
for await (const chunk of agent.respondStream({ history })) {
  if (chunk.delta) {
    // Display incremental text to user
    process.stdout.write(chunk.delta);
  }

  if (chunk.done) {
    console.log("\n✅ Complete!");
    // Access final metadata
    if (chunk.route) {
      console.log("Route:", chunk.route.title);
    }
    if (chunk.toolCalls) {
      console.log("Tool calls:", chunk.toolCalls.length);
    }
  }
}
```

**With Cancellation:**

```typescript
const abortController = new AbortController();

// Cancel after 5 seconds
setTimeout(() => abortController.abort(), 5000);

try {
  for await (const chunk of agent.respondStream({
    history,
    signal: abortController.signal,
  })) {
    console.log(chunk.delta);
  }
} catch (error) {
  if (error.name === "AbortError") {
    console.log("Stream cancelled");
  }
}
```

**Collecting Full Response:**

```typescript
let fullMessage = "";
let finalChunk;

for await (const chunk of agent.respondStream({ history })) {
  fullMessage += chunk.delta;
  if (chunk.done) {
    finalChunk = chunk;
  }
}

// Save to database
await db.agentMessages.create({
  sessionId: session.id,
  role: "agent",
  content: fullMessage,
  route: finalChunk.route?.title,
  toolCalls: finalChunk.toolCalls || [],
});
```

**See Also:** [streaming-agent.ts](../examples/streaming-agent.ts) for comprehensive examples.

#### Properties

##### `name: string`

Agent's name (readonly).

##### `description?: string`

Agent's description (readonly).

##### `goal?: string`

Agent's goal (readonly).

##### `domain: Record<string, Record<string, unknown>>`

Dynamic domain registry access.

---

### `Route`

Represents a conversation flow with states and transitions.

#### Constructor

```typescript
new Route(options: RouteOptions)

interface RouteOptions<TExtracted = unknown> {
  id?: string;              // Optional custom ID (deterministic ID generated from title if not provided)
  title: string;            // Route title
  description?: string;     // Route description
  conditions?: string[];    // Conditions that activate this route
  guidelines?: Guideline[]; // Initial guidelines for this route
  domains?: string[];       // Domain names allowed in this route (undefined = all domains)
  rules?: string[];         // Absolute rules the agent MUST follow in this route
  prohibitions?: string[];  // Absolute prohibitions the agent MUST NEVER do in this route

  // NEW: Schema-first data extraction
  gatherSchema?: {
    type: "object";
    properties: Record<string, any>;
    required?: string[];
    additionalProperties?: boolean;
  };

  // NEW: Pre-populate extracted data when entering route
  initialData?: Partial<TExtracted>;
}
```

**Note on IDs:** Route IDs are deterministic by default, generated from the title using a hash function. This ensures consistency across server restarts. You can provide a custom ID if you need specific control over the identifier.

#### Methods

##### `createGuideline(guideline: Guideline): this`

Adds a guideline specific to this route. Returns `this` for chaining.

##### `getGuidelines(): Guideline[]`

Returns all guidelines for this route.

##### `getDomains(): string[] | undefined`

Returns allowed domain names for this route. Returns `undefined` if all domains are allowed, or an array of domain names if restricted.

##### `getRules(): string[]`

Returns the rules that must be followed in this route.

##### `getProhibitions(): string[]`

Returns the prohibitions that must never be done in this route.

##### `getRef(): RouteRef`

Returns a reference to this route.

##### `describe(): string`

Generates a description of this route's structure.

#### Properties

##### `id: string`

Unique route identifier (readonly).

##### `title: string`

Route title (readonly).

##### `description?: string`

Route description (readonly).

##### `conditions: string[]`

Conditions that trigger this route (readonly).

##### `initialState: State`

Starting state of the route (readonly).

---

### `State`

Represents a state within a conversation route.

#### Methods

##### `transitionTo(spec: TransitionSpec, condition?: string): TransitionResult`

Creates a transition from this state and returns a chainable result.

```typescript
interface TransitionSpec<TExtracted = unknown> {
  chatState?: string; // Transition to a chat interaction
  toolState?: ToolRef; // Transition to execute a tool
  state?: StateRef | symbol; // Transition to specific state or END_ROUTE

  // NEW: Data extraction fields for this state
  gather?: string[];

  // NEW: Code-based condition to skip this state
  skipIf?: (extracted: Partial<TExtracted>) => boolean;

  // NEW: Prerequisites that must be met to enter this state
  requiredData?: string[];
}

interface TransitionResult<TExtracted = unknown> {
  id: string; // State identifier
  routeId: string; // Route identifier
  transitionTo: (
    spec: TransitionSpec<TExtracted>,
    condition?: string
  ) => TransitionResult<TExtracted>;
}
```

**Returns:** A `TransitionResult` that includes the target state's reference (`id`, `routeId`) and a `transitionTo` method for chaining additional transitions.

**Example:**

```typescript
// Define your data extraction type
interface FlightData {
  destination: string;
  departureDate: string;
  passengers: number;
}

// Create a data-driven route
const flightRoute = agent.createRoute<FlightData>({
  title: "Book Flight",
  gatherSchema: {
    type: "object",
    properties: {
      destination: { type: "string" },
      departureDate: { type: "string" },
      passengers: { type: "number", minimum: 1, maximum: 9 },
    },
    required: ["destination", "departureDate", "passengers"],
  },
});

// Approach 1: Step-by-step with data extraction
const askDestination = flightRoute.initialState.transitionTo({
  chatState: "Ask where they want to fly",
  gather: ["destination"],
  skipIf: (extracted) => !!extracted.destination, // Skip if already have destination
});

const askDates = askDestination.transitionTo({
  chatState: "Ask about travel dates",
  gather: ["departureDate"],
  skipIf: (extracted) => !!extracted.departureDate,
  requiredData: ["destination"], // Must have destination first
});

const askPassengers = askDates.transitionTo({
  chatState: "How many passengers?",
  gather: ["passengers"],
  skipIf: (extracted) => !!extracted.passengers,
});

// Access state properties
console.log(askDestination.id); // State ID
console.log(askDestination.routeId); // Route ID

// Approach 2: Fluent chaining for linear flows
flightRoute.initialState
  .transitionTo({
    chatState: "Extract travel details",
    gather: ["destination", "departureDate", "passengers"],
  })
  .transitionTo({
    chatState: "Present available flights",
  })
  .transitionTo({ state: END_ROUTE });

// Use with session state
let session = createSession<FlightData>();
const response = await agent.respond({ history, session });
console.log(response.session?.extracted); // { destination: "Paris", ... }
```

##### `addGuideline(guideline: Guideline): void`

Adds a guideline specific to this state.

#### Properties

##### `id: string`

Unique state identifier (readonly).

##### `routeId: string`

ID of the route this state belongs to (readonly).

##### `description: string`

State description (readonly).

---

### `DomainRegistry`

Registry for organizing agent tools and methods by domain.

#### Methods

##### `register<TDomain>(name: string, domain: TDomain): void`

Registers a new domain with its tools/methods. Throws error if domain name already exists.

##### `get<TDomain>(name: string): TDomain | undefined`

Gets a registered domain by name. Returns `undefined` if not found.

##### `has(name: string): boolean`

Checks if a domain is registered.

##### `all(): Record<string, Record<string, unknown>>`

Returns all registered domains as a single object.

##### `getFiltered(allowedNames?: string[]): Record<string, Record<string, unknown>>`

Returns filtered domains by names. If `allowedNames` is `undefined`, returns all domains.

**Example:**

```typescript
const registry = new DomainRegistry();

registry.register("payment", {
  processPayment: async (amount: number) => {
    /* ... */
  },
});

registry.register("shipping", {
  calculateShipping: (zipCode: string) => {
    /* ... */
  },
});

// Get specific domains
const filtered = registry.getFiltered(["payment"]); // Only payment domain

// Get all domains
const all = registry.getFiltered(); // payment + shipping
```

##### `getDomainNames(): string[]`

Returns list of all registered domain names.

---

### `AnthropicProvider`

AI provider implementation for Anthropic (Claude models).

#### Constructor

```typescript
new AnthropicProvider(options: AnthropicProviderOptions)

interface AnthropicProviderOptions {
  apiKey: string;
  model: string;               // Required: e.g., "claude-sonnet-4-5"
  backupModels?: string[];     // Fallback models
  config?: Partial<Omit<MessageCreateParamsNonStreaming, "model" | "messages" | "max_tokens">>;
  retryConfig?: {
    timeout?: number;          // Default: 60000ms
    retries?: number;          // Default: 3
  };
}
```

**Note:** `model` is required for AnthropicProvider. Available models include:

- `claude-sonnet-4-5` - Latest Claude Sonnet 4.5 (most capable)
- `claude-opus-4-1` - Claude Opus 4.1 (powerful for complex tasks)
- `claude-sonnet-4-0` - Claude Sonnet 4.0 (stable, production-ready)

#### Methods

##### `generateMessage<TContext>(input: GenerateMessageInput<TContext>): Promise<GenerateMessageOutput>`

Generates a message with retry logic and backup models using Anthropic's API.

**Example:**

```typescript
import { AnthropicProvider } from "@falai/agent";

const provider = new AnthropicProvider({
  apiKey: process.env.ANTHROPIC_API_KEY!,
  model: "claude-sonnet-4-5",
  backupModels: ["claude-opus-4-1", "claude-sonnet-4-0"],
  config: {
    temperature: 0.7,
    top_p: 0.9,
  },
  retryConfig: {
    timeout: 60000,
    retries: 3,
  },
});
```

---

### `GeminiProvider`

AI provider implementation for Google Gemini.

#### Constructor

```typescript
new GeminiProvider(options: GeminiProviderOptions)

interface GeminiProviderOptions {
  apiKey: string;
  model?: string;              // Default: "models/gemini-2.5-flash"
  backupModels?: string[];     // Fallback models
  retryConfig?: {
    timeout?: number;          // Default: 60000ms
    retries?: number;          // Default: 3
  };
}
```

#### Methods

##### `generateMessage<TContext>(input: GenerateMessageInput<TContext>): Promise<GenerateMessageOutput>`

Generates a message with retry logic and backup models.

---

### `OpenAIProvider`

AI provider implementation for OpenAI (GPT models).

#### Constructor

```typescript
new OpenAIProvider(options: OpenAIProviderOptions)

interface OpenAIProviderOptions {
  apiKey: string;
  model: string;               // Required: e.g., "gpt-4o", "gpt-5"
  backupModels?: string[];     // Fallback models
  retryConfig?: {
    timeout?: number;          // Default: 60000ms
    retries?: number;          // Default: 3
  };
}
```

**Note:** Unlike GeminiProvider, `model` is required for OpenAIProvider. Choose from available OpenAI models like "gpt-4o", "gpt-5", "gpt-4-turbo", etc.

#### Methods

##### `generateMessage<TContext>(input: GenerateMessageInput<TContext>): Promise<GenerateMessageOutput>`

Generates a message with retry logic and backup models using OpenAI's API.

**Example:**

```typescript
import { OpenAIProvider } from "@falai/agent";

const provider = new OpenAIProvider({
  apiKey: process.env.OPENAI_API_KEY!,
  model: "gpt-5",
  backupModels: ["gpt-4o", "gpt-4-turbo"],
  retryConfig: {
    timeout: 60000,
    retries: 3,
  },
});
```

---

### `OpenRouterProvider`

AI provider implementation for OpenRouter (access to 200+ models).

#### Constructor

```typescript
new OpenRouterProvider(options: OpenRouterProviderOptions)

interface OpenRouterProviderOptions {
  apiKey: string;
  model: string;               // Required: e.g., "openai/gpt-5", "anthropic/claude-sonnet-4-5"
  backupModels?: string[];     // Fallback models
  siteUrl?: string;            // Optional: your app URL for OpenRouter rankings
  siteName?: string;           // Optional: your app name for OpenRouter rankings
  retryConfig?: {
    timeout?: number;          // Default: 60000ms
    retries?: number;          // Default: 3
  };
}
```

**Note:** OpenRouter provides access to models from multiple providers. Model names follow the format `provider/model-name` (e.g., "openai/gpt-5", "anthropic/claude-sonnet-4-5", "google/gemini-pro").

#### Methods

##### `generateMessage<TContext>(input: GenerateMessageInput<TContext>): Promise<GenerateMessageOutput>`

Generates a message with retry logic and backup models using OpenRouter's API.

**Example:**

```typescript
import { OpenRouterProvider } from "@falai/agent";

const provider = new OpenRouterProvider({
  apiKey: process.env.OPENROUTER_API_KEY!,
  model: "openai/gpt-5",
  backupModels: ["anthropic/claude-sonnet-4-5", "google/gemini-pro"],
  siteUrl: "https://yourapp.com",
  siteName: "Your App Name",
  retryConfig: {
    timeout: 60000,
    retries: 3,
  },
});
```

**See Also:** [Providers Guide](./PROVIDERS.md) for detailed provider comparison and configuration examples.

---

## Persistence Adapters

Optional persistence for auto-saving sessions and messages. All adapters implement the `PersistenceAdapter` interface.

### `PersistenceManager`

Manages persistence operations for sessions and messages.

#### Constructor

```typescript
new PersistenceManager(config: PersistenceConfig)

interface PersistenceConfig {
  adapter: PersistenceAdapter;
  autoSave?: boolean;    // Default: true
  userId?: string;       // Optional: associate with user
}
```

#### Methods

##### `createSession(data: Partial<SessionData>): Promise<SessionData>`

Creates a new conversation session.

```typescript
const session = await persistence.createSession({
  userId: "user_123",
  agentName: "Support Bot",
  initialData: { channel: "web" },
});
```

##### `getSession(sessionId: string): Promise<SessionData | null>`

Retrieves a session by ID.

##### `findActiveSession(userId: string): Promise<SessionData | null>`

Finds the active session for a user.

##### `getUserSessions(userId: string, limit?: number): Promise<SessionData[]>`

Gets all sessions for a user.

##### `updateSessionStatus(sessionId: string, status: SessionStatus): Promise<SessionData | null>`

Updates session status ("active" | "completed" | "abandoned").

##### `saveMessage(data: Partial<MessageData>): Promise<MessageData>`

Saves a message to the database.

```typescript
await persistence.saveMessage({
  sessionId: session.id,
  role: "user",
  content: "Hello!",
});
```

##### `getSessionMessages(sessionId: string, limit?: number): Promise<MessageData[]>`

Gets all messages for a session.

##### `loadSessionHistory(sessionId: string, limit?: number): Promise<Event[]>`

Loads session history in Event format for agent.respond().

```typescript
const history = await persistence.loadSessionHistory(sessionId);
const response = await agent.respond({ history });
```

##### `completeSession(sessionId: string): Promise<SessionData | null>`

Marks a session as completed.

##### `abandonSession(sessionId: string): Promise<SessionData | null>`

Marks a session as abandoned.

---

### `PrismaAdapter`

Type-safe ORM adapter with migrations support.

#### Constructor

```typescript
new PrismaAdapter(options: PrismaAdapterOptions)

interface PrismaAdapterOptions {
  prisma: PrismaClient;
  autoMigrate?: boolean;      // Default: false
  tables?: {
    sessions?: string;        // Default: "AgentSession"
    messages?: string;        // Default: "AgentMessage"
  };
  fieldMappings?: FieldMappings;  // Custom field names
}
```

#### Example

```typescript
import { PrismaAdapter } from "@falai/agent";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const agent = new Agent({
  persistence: {
    adapter: new PrismaAdapter({
      prisma,
      autoMigrate: true, // Auto-run migrations
      tables: {
        sessions: "CustomSessions",
        messages: "CustomMessages",
      },
    }),
    userId: "user_123",
  },
});
```

**Schema Example:** See [examples/prisma-schema.example.prisma](../examples/prisma-schema.example.prisma)

**Full Example:** See [examples/prisma-persistence.ts](../examples/prisma-persistence.ts)

---

### `RedisAdapter`

Fast, in-memory persistence for high-throughput applications.

#### Constructor

```typescript
new RedisAdapter(options: RedisAdapterOptions)

interface RedisAdapterOptions {
  redis: RedisClient;         // ioredis or redis client
  keyPrefix?: string;         // Default: "agent:"
  sessionTTL?: number;        // Default: 7 days (in seconds)
  messageTTL?: number;        // Default: 30 days (in seconds)
}
```

#### Example

```typescript
import { RedisAdapter } from "@falai/agent";
import Redis from "ioredis";

const redis = new Redis();

const agent = new Agent({
  persistence: {
    adapter: new RedisAdapter({
      redis,
      keyPrefix: "chat:",
      sessionTTL: 24 * 60 * 60, // 24 hours
      messageTTL: 7 * 24 * 60 * 60, // 7 days
    }),
  },
});
```

**Install:** `npm install ioredis` or `npm install redis`

**Full Example:** See [examples/redis-persistence.ts](../examples/redis-persistence.ts)

---

### `MongoAdapter`

Document-based storage with flexible schema.

#### Constructor

```typescript
new MongoAdapter(options: MongoAdapterOptions)

interface MongoAdapterOptions {
  client: MongoClient;
  databaseName: string;
  collections?: {
    sessions?: string;        // Default: "agent_sessions"
    messages?: string;        // Default: "agent_messages"
  };
}
```

#### Example

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
        sessions: "chat_sessions",
        messages: "chat_messages",
      },
    }),
  },
});
```

**Install:** `npm install mongodb`

---

### `PostgreSQLAdapter`

Raw SQL adapter with auto table/index creation.

#### Constructor

```typescript
new PostgreSQLAdapter(options: PostgreSQLAdapterOptions)

interface PostgreSQLAdapterOptions {
  client: PgClient;           // pg client
  tables?: {
    sessions?: string;        // Default: "agent_sessions"
    messages?: string;        // Default: "agent_messages"
  };
}
```

#### Methods

##### `initialize(): Promise<void>`

Creates tables and indexes if they don't exist.

#### Example

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

const adapter = new PostgreSQLAdapter({ client });

// Auto-create tables
await adapter.initialize();

const agent = new Agent({
  persistence: { adapter },
});
```

**Install:** `npm install pg`

---

### `SQLiteAdapter`

Lightweight, file-based database for local development.

#### Constructor

```typescript
new SQLiteAdapter(options: SQLiteAdapterOptions)

interface SQLiteAdapterOptions {
  db: SqliteDatabase;           // better-sqlite3 database
  tables?: {
    sessions?: string;          // Default: "agent_sessions"
    messages?: string;          // Default: "agent_messages"
  };
}
```

#### Methods

##### `initialize(): Promise<void>`

Creates tables and indexes if they don't exist.

#### Example

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

**Perfect for:** Local development, testing, desktop apps, single-user applications

---

### `OpenSearchAdapter`

Full-text search and analytics-powered persistence. Compatible with OpenSearch and Elasticsearch 7.x.

#### Constructor

```typescript
new OpenSearchAdapter(client: OpenSearchClient, options?: OpenSearchAdapterOptions)

interface OpenSearchAdapterOptions {
  indices?: {
    sessions?: string;        // Default: "agent_sessions"
    messages?: string;        // Default: "agent_messages"
  };
  autoCreateIndices?: boolean; // Default: true
  refresh?: boolean | "wait_for"; // Default: false
}
```

#### Methods

##### `initialize(): Promise<void>`

Creates indices with proper mappings if they don't exist.

##### `disconnect(): Promise<void>`

Gracefully disconnect (no-op for OpenSearch - connection pooling is automatic).

#### Example

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
  autoCreateIndices: true,
  refresh: "wait_for", // Wait for documents to be searchable
});

// Auto-create indices with mappings
await adapter.initialize();

const agent = new Agent({
  persistence: { adapter },
});
```

**Install:** `npm install @opensearch-project/opensearch`

**Perfect for:** Full-text search, analytics, time-series analysis, AWS OpenSearch Service, Elasticsearch 7.x users

**Full Example:** See [examples/opensearch-persistence.ts](../examples/opensearch-persistence.ts)

---

### `MemoryAdapter`

Zero-dependency in-memory storage for testing and development.

#### Constructor

```typescript
new MemoryAdapter();
```

No options needed - it's ready to go! ✨

#### Methods

##### `clear(): void`

Clears all stored data (useful for testing).

##### `getSnapshot(): { sessions: SessionData[]; messages: MessageData[] }`

Returns a snapshot of all data (useful for debugging/testing).

#### Example

```typescript
import { MemoryAdapter } from "@falai/agent";

const adapter = new MemoryAdapter();

const agent = new Agent({
  persistence: { adapter },
});

// Perfect for unit tests!
```

**Testing Example:**

```typescript
describe("Agent", () => {
  const adapter = new MemoryAdapter();

  afterEach(() => {
    adapter.clear(); // Reset between tests
  });

  it("should persist messages", async () => {
    const agent = new Agent({
      persistence: { adapter },
    });

    // ... test logic ...

    const { sessions, messages } = adapter.getSnapshot();
    expect(sessions).toHaveLength(1);
    expect(messages).toHaveLength(2);
  });
});
```

**No installation required** - built into the framework!

---

### Persistence Types

#### `SessionData`

```typescript
interface SessionData {
  id: string;
  userId?: string;
  agentName?: string;
  status: SessionStatus; // "active" | "completed" | "abandoned"
  currentRoute?: string;
  currentState?: string;
  collectedData?: Record<string, unknown>;
  messageCount: number;
  lastMessageAt?: Date;
  completedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}
```

#### `MessageData`

```typescript
interface MessageData {
  id: string;
  sessionId: string;
  userId?: string;
  role: MessageRole; // "user" | "agent" | "system"
  content: string;
  route?: string;
  state?: string;
  toolCalls?: Array<{
    toolName: string;
    arguments: Record<string, unknown>;
    result?: unknown;
  }>;
  event?: Event;
  createdAt: Date;
}
```

#### `PersistenceAdapter`

Interface for creating custom adapters:

```typescript
interface PersistenceAdapter {
  sessionRepository: SessionRepository;
  messageRepository: MessageRepository;
  initialize?(): Promise<void>; // Optional: setup tables/indexes
  disconnect?(): Promise<void>; // Optional: cleanup
}
```

**See Also:**

- [docs/PERSISTENCE.md](./PERSISTENCE.md) - Complete persistence guide
- [docs/ADAPTERS.md](./ADAPTERS.md) - Adapter comparison and details

---

### `PromptBuilder`

Constructs prompts for AI generation.

#### Methods

##### `addIdentity(name: string, description?: string, goal?: string): this`

Adds agent identity section.

##### `addContext(variables: ContextVariable[]): this`

Adds context variables.

##### `addGlossary(terms: Term[]): this`

Adds domain glossary terms.

##### `addGuidelinesForMessageGeneration(guidelines: GuidelineMatch[]): this`

Adds guidelines section.

##### `addCapabilitiesForMessageGeneration(capabilities: Capability[]): this`

Adds capabilities section.

##### `addActiveRoutes(routes): this`

Adds active routes to the prompt.

##### `build(): string`

Builds the final prompt string.

---

## Utility Functions

### `defineTool<TContext, TArgs, TReturn>()`

Defines a type-safe tool.

```typescript
defineTool<TContext, TArgs extends unknown[], TReturn>(
  name: string,
  handler: ToolHandler<TContext, TArgs, TReturn>,
  options?: {
    id?: string;              // Optional custom ID (deterministic ID generated from name if not provided)
    description?: string;
    parameters?: unknown;
  }
): ToolRef<TContext, TArgs, TReturn>
```

**Note on IDs:** Tool IDs are deterministic by default, generated from the name using a hash function. This ensures consistency across server restarts.

**Example:**

```typescript
const getTool = defineTool<MyContext, [id: string], Data>(
  "get_data",
  async ({ context }, id) => {
    return { data: await fetchData(id) };
  },
  {
    id: "custom_get_data_tool", // Optional: provide your own ID
    description: "Fetches data by ID",
  }
);
```

---

### `createMessageEvent()`

Creates a message event for conversation history.

```typescript
createMessageEvent(
  source: EventSource,
  participantName: string,
  message: string,
  timestamp?: string  // Optional: provide custom timestamp (ISO 8601 format)
): Event
```

**Example:**

```typescript
// With auto-generated timestamp
createMessageEvent(EventSource.CUSTOMER, "Alice", "Hello!");

// With custom timestamp (useful for historical data)
createMessageEvent(
  EventSource.CUSTOMER,
  "Alice",
  "Hello!",
  "2025-10-13T10:30:00Z"
);
```

---

### `createToolEvent()`

Creates a tool execution event.

```typescript
createToolEvent(
  source: EventSource,
  toolCalls: ToolCall[],
  timestamp?: string  // Optional: provide custom timestamp (ISO 8601 format)
): Event
```

**Example:**

```typescript
// With auto-generated timestamp
createToolEvent(EventSource.AI_AGENT, [
  { tool_id: "get_data", arguments: { id: "123" }, result: { data: {...} } }
]);

// With custom timestamp
createToolEvent(
  EventSource.AI_AGENT,
  [{ tool_id: "get_data", arguments: { id: "123" }, result: { data: {...} } }],
  "2025-10-13T10:30:00Z"
);
```

---

### `adaptEvent()`

Adapts an event to the internal format.

```typescript
adaptEvent(event: EmittedEvent): Event
```

---

## Type Definitions

### `Term`

```typescript
interface Term {
  name: string;
  description: string;
  synonyms?: string[];
}
```

---

### `Guideline`

```typescript
interface Guideline {
  id?: string;
  condition?: string;
  action: string;
  enabled?: boolean; // Default: true
  tags?: string[];
  tools?: ToolRef[];
  metadata?: Record<string, unknown>;
}
```

---

### `Capability`

```typescript
interface Capability {
  id?: string;
  title: string;
  description: string;
  tools?: ToolRef[];
}
```

---

### `Event`

```typescript
interface Event {
  kind: EventKind;
  source: EventSource;
  data: MessageEventData | ToolEventData | StatusEventData;
  creation_utc: string;
}

enum EventKind {
  MESSAGE = "message",
  TOOL = "tool",
  STATUS = "status",
}

enum EventSource {
  CUSTOMER = "customer",
  AI_AGENT = "agent",
  SYSTEM = "system",
}
```

---

### `ToolContext<TContext>`

```typescript
interface ToolContext<TContext> {
  context: TContext;
  // Additional runtime context
}
```

---

### `ToolResult<TReturn>`

```typescript
interface ToolResult<TReturn> {
  data: TReturn;
  error?: string;
}
```

---

## Types

### `SessionState<TExtracted>`

Tracks the current position in the conversation flow and data extracted during route progression.

```typescript
interface SessionState<TExtracted = Record<string, unknown>> {
  /** Unique session identifier (useful for persistence) */
  id?: string;

  /** Current route the conversation is in */
  currentRoute?: {
    id: string;
    title: string;
    enteredAt: Date;
  };

  /** Current state within the route */
  currentState?: {
    id: string;
    description?: string;
    enteredAt: Date;
  };

  /** Data extracted during the current route */
  extracted: Partial<TExtracted>;

  /** History of routes visited in this session */
  routeHistory: Array<{
    routeId: string;
    enteredAt: Date;
    exitedAt?: Date;
    completed: boolean;
  }>;

  /** Session metadata */
  metadata?: {
    createdAt?: Date;
    lastUpdatedAt?: Date;
    [key: string]: unknown;
  };
}
```

**Key Features:**

- **`id`** - Optional session identifier that persists across database operations
- **`extracted`** - Type-safe data collected via `gatherSchema`
- **`currentRoute`** / **`currentState`** - Track conversation position
- **`routeHistory`** - Full audit trail of route transitions
- **`metadata`** - Custom data (timestamps, user info, etc.)

**Usage:**

```typescript
interface FlightData {
  destination: string;
  departureDate: string;
}

// Create session with database ID
const session = createSession<FlightData>("session_abc123");

// Use in conversation
const response = await agent.respond({ history, session });

// Access extracted data
console.log(response.session?.extracted.destination); // Type-safe!
```

---

### Session Helper Functions

#### `createSession<TExtracted>(sessionId?, metadata?): SessionState<TExtracted>`

Creates a new session state object.

**Parameters:**

- `sessionId` (optional): Unique session identifier from database
- `metadata` (optional): Additional metadata to attach

**Example:**

```typescript
// Simple usage
const session = createSession<OnboardingData>();

// With database ID (when loading from persistence)
const session = createSession<OnboardingData>("session_123");

// With metadata
const session = createSession<OnboardingData>("session_123", {
  userId: "user_456",
  channel: "whatsapp",
});
```

#### `enterRoute<TExtracted>(session, routeId, routeTitle): SessionState<TExtracted>`

Updates session when entering a new route. Automatically:

- Exits previous route (if exists)
- Resets extracted data
- Adds route to history
- Updates timestamps

**Example:**

```typescript
let session = createSession<FlightData>();

// Enter booking route
session = enterRoute(session, "book_flight", "Book a Flight");

console.log(session.currentRoute?.title); // "Book a Flight"
console.log(session.extracted); // {} (reset for new route)
```

#### `enterState<TExtracted>(session, stateId, description?): SessionState<TExtracted>`

Updates session when entering a new state within a route.

**Example:**

```typescript
session = enterState(session, "ask_destination", "Ask where to fly");

console.log(session.currentState?.id); // "ask_destination"
console.log(session.currentState?.description); // "Ask where to fly"
```

#### `mergeExtracted<TExtracted>(session, data): SessionState<TExtracted>`

Merges new extracted data into session. Updates timestamps automatically.

**Example:**

```typescript
session = mergeExtracted(session, {
  destination: "Paris",
  departureDate: "2025-06-15",
});

console.log(session.extracted); // { destination: "Paris", departureDate: "2025-06-15" }
```

#### `sessionStateToData<TExtracted>(session): object`

Converts SessionState to persistence-friendly format for database storage.

**Returns:**

```typescript
{
  currentRoute?: string;          // Route ID
  currentState?: string;          // State ID
  collectedData: {                // All session data
    extracted: Partial<TExtracted>;
    routeHistory: Array<...>;
    currentRouteTitle?: string;
    currentStateDescription?: string;
    metadata?: object;
  };
}
```

**Example:**

```typescript
const session = createSession<FlightData>("session_123");
// ... conversation happens ...

// Save to database
const dbData = sessionStateToData(session);
await db.sessions.update(session.id!, {
  currentRoute: dbData.currentRoute,
  currentState: dbData.currentState,
  collectedData: dbData.collectedData,
});
```

#### `sessionDataToState<TExtracted>(sessionId, data): SessionState<TExtracted>`

Converts database data back to SessionState for resuming conversations.

**Parameters:**

- `sessionId`: The database session ID
- `data`: Database session data (currentRoute, currentState, collectedData)

**Example:**

```typescript
// Load from database
const dbSession = await db.sessions.findById("session_123");

// Restore session state
const session = sessionDataToState<FlightData>(dbSession.id, {
  currentRoute: dbSession.currentRoute,
  currentState: dbSession.currentState,
  collectedData: dbSession.collectedData,
});

// Resume conversation
const response = await agent.respond({ history, session });
```

**Complete Persistence Example:**

```typescript
// CREATE: New session
let session = createSession<FlightData>(dbSession.id);

// CONVERSATION: Extract data
const response1 = await agent.respond({ history: history1, session });
session = response1.session!; // { extracted: { destination: "Paris" } }

// SAVE: To database
const saveData = sessionStateToData(session);
await db.sessions.update(session.id!, saveData);

// ---  Later (new request) ---

// LOAD: From database
const loaded = await db.sessions.findById("session_123");
const restored = sessionDataToState<FlightData>(loaded.id, loaded);

// CONTINUE: Conversation
const response2 = await agent.respond({ history: history2, session: restored });
```

---

### `AgentStructuredResponse`

The structured response format returned by AI providers when JSON mode is enabled.

```typescript
interface AgentStructuredResponse {
  /** The actual message to send to the user */
  message: string;
  /** Route chosen by the agent (route title or null if no route) */
  route?: string | null;
  /** Current state within the route (state description or null) */
  state?: string | null;
  /** Tool calls the agent wants to execute */
  toolCalls?: Array<{
    toolName: string;
    arguments: Record<string, unknown>;
  }>;
  /** Additional reasoning or internal thoughts (optional) */
  reasoning?: string;
}
```

This type represents the structured JSON output that AI providers return when using the enhanced response format. The `Agent.respond()` method automatically parses this and returns a more convenient format.

---

### ID Generation Utilities

Generate deterministic IDs for consistency across server restarts.

#### `generateRouteId(title: string): string`

Generates a deterministic route ID from a title.

```typescript
import { generateRouteId } from "@falai/agent";

const routeId = generateRouteId("User Onboarding");
// Returns: "route_user_onboarding_{hash}"
```

#### `generateStateId(routeId: string, description?: string, index?: number): string`

Generates a deterministic state ID.

```typescript
import { generateStateId } from "@falai/agent";

const stateId = generateStateId("route_123", "Ask for name");
// Returns: "state_ask_for_name_{hash}"
```

#### `generateToolId(name: string): string`

Generates a deterministic tool ID from a name.

```typescript
import { generateToolId } from "@falai/agent";

const toolId = generateToolId("get_user_data");
// Returns: "tool_get_user_data_{hash}"
```

**Why Deterministic IDs?**

All IDs are generated deterministically using a hash function of their content (title, name, description). This ensures:

- **Consistency** - Same input always produces the same ID
- **Server Restart Safe** - IDs remain stable across application restarts
- **Persistence Friendly** - Safe to store in databases and reference later
- **Custom Control** - You can always provide your own IDs when needed

---

## Constants

### `END_ROUTE`

Symbol marking the end of a conversation route.

```typescript
import { END_ROUTE } from "@falai/agent";

state.transitionTo({ state: END_ROUTE });
```

---

## Enums

### `CompositionMode`

```typescript
enum CompositionMode {
  FLUID = "fluid",
  CANNED_FLUID = "canned_fluid",
  CANNED_COMPOSITED = "composited_canned",
  CANNED_STRICT = "strict_canned",
}
```

---

### `BuiltInSection`

Prompt builder section identifiers.

```typescript
enum BuiltInSection {
  IDENTITY = "identity",
  GLOSSARY = "glossary",
  CONTEXT = "context",
  GUIDELINES = "guidelines",
  CAPABILITIES = "capabilities",
  ACTIVE_ROUTES = "active_routes",
}
```

---

## Advanced Topics

### Custom AI Providers

Implement the `AiProvider` interface:

```typescript
interface AiProvider {
  generateMessage<TContext = unknown>(
    input: GenerateMessageInput<TContext>
  ): Promise<GenerateMessageOutput>;
}
```

### Domain Registry

Organize tools by domain:

```typescript
const paymentDomain = {
  processPayment: async (amount: number) => {
    /*...*/
  },
  refund: async (transactionId: string) => {
    /*...*/
  },
};

agent.addDomain("payment", paymentDomain);

// Access via agent.domain.payment.processPayment()
```

---

**Made with ❤️ for the community**
