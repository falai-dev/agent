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

See [Agent](./AGENT.md) for full details.

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

##### `getData<TData>(routeId?): Partial<TData>`

Gets the collected data from current session, optionally for a specific route.

```typescript
// Option 1: Using current session (set with setCurrentSession)
agent.setCurrentSession(session);
const data = agent.getData(); // Uses current session

// Option 2: Get data for specific route
const routeData = agent.getData("onboarding"); // Route-specific data

// Option 3: From response (with current session set)
const response = await agent.respond({ history });
const data = agent.getData(); // Uses current session
```

**Parameters:**

- `routeId` (optional): Route ID to get data for. If not provided, returns current route data.

**Returns:** The collected data from the current session

**Note:** Returns empty object if no current session is set.

##### `setCurrentSession(session): void`

Sets the current session for convenience methods. Once set, methods like `getData()` don't need the session parameter.

```typescript
// Set current session
agent.setCurrentSession(session);

// Now methods use the current session automatically
const data = agent.getData();
// Get collected data for route
const routeData = agent.getData("onboarding");
```

**Parameters:**

- `session`: Session step to use as current session

##### `getCurrentSession(): SessionState | undefined`

Gets the currently set session.

```typescript
const current = agent.getCurrentSession();
if (current) {
  console.log("Current session:", current.id);
}
```

**Returns:** Current session or undefined if none set

##### `clearCurrentSession(): void`

Clears the current session.

```typescript
agent.clearCurrentSession();
```

##### `respond(input: RespondInput<TContext>): Promise<RespondOutput>`

Generates an AI response with session step management, data extraction, and intelligent routing.

```typescript
interface RespondInput<TContext> {
  history: Event[];
  session?: SessionState; // NEW: Session step for conversation tracking
  contextOverride?: Partial<TContext>;
  signal?: AbortSignal;
}

interface RespondOutput {
  /** The message to send to the user */
  message: string;
  /** Updated session step (includes collected data, current route/step) */
  session?: SessionState;
  /** Tool calls executed during response (for debugging) */
  toolCalls?: Array<{
    toolName: string;
    arguments: Record<string, unknown>;
  }>;
  /**
   * NEW: Indicates if the current route has reached END_ROUTE
   * When true, all required data has been collected and the route is complete.
   * Your application should handle this appropriately (e.g., process collected data,
   * show completion UI, start a new route, etc.)
   */
  isRouteComplete?: boolean;
}
```

**Enhanced Response Pipeline:**

1. **Tool Execution** - Execute tools if current step has `tool`
2. **Always-On Routing** - Score all routes, respect user intent to change direction
3. **Step Traversal** - Use `skipIf` and `requires` to determine next step
4. **Response Generation** - Build schema with `collect` fields, extract data
5. **Session Update** - Merge collected data into session step

**Session Step Management:**

- Tracks current route, step, and collected data across turns
- Enables "I changed my mind" scenarios with context-aware routing
- Automatically merges new collected data with existing session data
- **Per-route data preservation** - Collected data is organized by route ID, allowing users to switch routes without losing progress

**Example with Persistence Adapters:**

```typescript
import { createSession } from "@falai/agent";

// Using built-in persistence adapters
const { sessionData, sessionStep } =
  await persistence.createSessionWithStep<FlightData>({
    userId: "user_123",
    agentName: "Travel Agent",
  });

// Option 1: Set current session for convenience
agent.setCurrentSession(sessionStep);

const response = await agent.respond({
  history,
  // session: sessionStep, // No longer required!
});

// Use convenience methods without passing session
const data = agent.getData();

// Option 2: Still pass session explicitly if preferred
const response2 = await agent.respond({
  history,
  session: sessionStep,
});
```

**Example with Custom Database (Manual):**

```typescript
import { createSession, SessionState } from "@falai/agent";

// Load from your custom database
const dbSession = await yourDb.sessions.findOne({ id: sessionId });

// Restore or create session step
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
    currentStep: dbSession.currentStep
      ? {
          id: dbSession.currentStep,
          description: dbSession.collectedData?.currentStepDescription,
          enteredAt: new Date(),
        }
      : undefined,
    data: dbSession.collectedData?.data || {},
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
  currentStep: response.session?.currentStep?.id,
  collectedData: {
    data: response.session?.data,
    routeHistory: response.session?.routeHistory,
    currentRouteTitle: response.session?.currentRoute?.title,
    currentStepDescription: response.session?.currentStep?.description,
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
  step: response.session?.currentStep?.id,
});
```

**Handling Route Completion:**

When a route reaches its END_ROUTE transition (all required data collected), the response includes `isRouteComplete: true`:

```typescript
const response = await agent.respond({
  history,
  session,
});

if (response.isRouteComplete) {
  // Route is complete! All data has been collected
  console.log("✅ Route completed!");

  // Get all the collected data
  const collectedData = agent.getData(response.session!);
  console.log("Collected data:", collectedData);

  // Handle completion in your application:
  // - Save the collected data to your database
  // - Trigger business logic (e.g., create booking, send email)
  // - Show completion UI to user
  // - Start a new route or conversation

  await processCompletedData(collectedData);

  // Optional: Show a custom completion message
  return "Thank you! Your information has been saved.";
} else {
  // Normal flow - route still in progress
  return response.message;
}
```

**Example: Onboarding Flow**

```typescript
// Onboarding route with skipIf logic for pre-filled data
const onboardingRoute = agent.createRoute<OnboardingData>({
  id: "onboarding",
  title: "User Onboarding",
  schema: ONBOARDING_SCHEMA,
  initialData: existingUserData, // Pre-fill with existing data
});

// Build steps with skipIf conditions
const welcome = onboardingRoute.initialStep.nextStep({
  id: "ask_name",
  prompt: "What's your name?",
  collect: ["name"],
  skipIf: (data) => !!data.name, // Skip if name already collected
});

const askEmail = welcome.nextStep({
  id: "ask_email",
  prompt: "What's your email?",
  collect: ["email"],
  skipIf: (data) => !!data.email, // Skip if email already collected
});

const complete = askEmail.nextStep({
  id: "complete",
  prompt: "All done! Thank you.",
});

complete.nextStep({ step: END_ROUTE });

// Option 1: Set current session for convenience
agent.setCurrentSession(session);

const response = await agent.respond({ history });

if (response.isRouteComplete) {
  // If all data was pre-filled, the route completes immediately!
  // The routing engine recursively skips all steps and reaches END_ROUTE
  const data = agent.getData(); // No need to pass session!
  await saveUserProfile(data);
  return "Profile updated successfully!";
}

// Get route-specific data if needed
const onboardingData = agent.getDataForRoute("onboarding");
const bookingData = agent.getDataForRoute("booking");

return response.message;
```

**Important Notes:**

- `isRouteComplete` is `true` when the route reaches an `END_ROUTE` transition
- The `message` will be empty (`""`) when `isRouteComplete` is `true`
- You should check `isRouteComplete` and handle completion appropriately
- If all steps are skipped (due to `skipIf` conditions), the route can complete immediately on entry
- Use `agent.getData(session)` to retrieve all collected data

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
  /** Updated session step (includes collected data, current route/step) */
  session?: SessionState;
  /** Tool calls requested by the agent (only in final chunk) */
  toolCalls?: Array<{
    toolName: string;
    arguments: Record<string, unknown>;
  }>;
  /**
   * Indicates if the current route has reached END_ROUTE (only in final chunk)
   * When true, all required data has been collected and the route is complete.
   */
  isRouteComplete?: boolean;
}
```

**Key Features:**

- 🌊 Real-time streaming for better perceived performance
- 📊 Access to route, step, and tool information in final chunk
- 🛑 Cancellable with AbortSignal
- ✅ Supported by all providers (Anthropic, OpenAI, Gemini, OpenRouter)

**Example:**

```typescript
// Basic streaming
for await (const chunk of agent.respondStream({ history, session })) {
  if (chunk.delta) {
    // Display incremental text to user
    process.stdout.write(chunk.delta);
  }

  if (chunk.done) {
    console.log("\n✅ Complete!");

    // Check if route is complete
    if (chunk.isRouteComplete) {
      console.log("🎉 Route completed!");
      const data = agent.getData(chunk.session!);
      await handleCompletion(data);
    }

    // Access session step
    if (chunk.session?.currentRoute) {
      console.log("Route:", chunk.session.currentRoute.title);
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

Represents a conversation flow with steps and transitions.

#### Constructor

```typescript
new Route(options: RouteOptions)

interface RouteOptions<TData = unknown> {
  id?: string;              // Optional custom ID (deterministic ID generated from title if not provided)
  title: string;            // Route title
  description?: string;     // Route description
  conditions?: string[];    // Conditions that activate this route
  guidelines?: Guideline[]; // Initial guidelines for this route
  domains?: string[];       // Domain names allowed in this route (undefined = all domains)
  rules?: string[];         // Absolute rules the agent MUST follow in this route
  prohibitions?: string[];  // Absolute prohibitions the agent MUST NEVER do in this route

  // NEW: Schema-first data extraction
  schema?: {
    type: "object";
    properties: Record<string, any>;
    required?: string[];
    additionalProperties?: boolean;
  };

  // NEW: Pre-populate collected data when entering route
  initialData?: Partial<TData>;

  // NEW: Configure the initial step
  initialStep?: {
    id?: string;              // Custom ID for the initial step
    prompt?: string;       // Description for the initial step
    collect?: string[];        // Fields to collect in the initial step
    skipIf?: (data: Partial<TData>) => boolean;  // Skip condition
    requires?: string[];  // Required data prerequisites
  };

  // NEW: Sequential steps for simple linear flows
  steps?: TransitionSpec<unknown, TData>[];
}
```

**Note on IDs:** Route IDs are deterministic by default, generated from the title using a hash function. This ensures consistency across server restarts. You can provide a custom ID if you need specific control over the identifier.

**Initial Step Configuration:** You can configure the initial step in two ways:

1. Using `initialStep` option when creating the route
2. Using `route.initialStep.configure()` method after route creation

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

**Note:** Routes no longer have a `getData()` method. Use `agent.getData()` or `agent.getDataForRoute(routeId)` instead.

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

##### `initialStep: Step`

Starting step of the route (readonly).

---

### `Step`

Represents a step within a conversation route.

#### Methods

##### `nextStep(spec: TransitionSpec): TransitionResult`

Creates a transition from this step and returns a chainable result.

```typescript
interface TransitionSpec<TData = unknown> {
  prompt?: string; // Transition to a chat interaction
  tool?: ToolRef; // Transition to execute a tool
  step?: StepRef | symbol; // Transition to specific step or END_ROUTE

  // NEW: Data extraction fields for this step
  collect?: string[];

  // NEW: Code-based condition to skip this step
  skipIf?: (data: Partial<TData>) => boolean;

  // NEW: Prerequisites that must be met to enter this step
  requires?: string[];

  // Optional: AI-evaluated text condition for this transition
  condition?: string;
}

interface TransitionResult<TData = unknown> {
  id: string; // Step identifier
  routeId: string; // Route identifier
  nextStep: (spec: TransitionSpec<TData>) => TransitionResult<TData>;
}
```

**Parameters:**

- `spec`: The transition specification (see `TransitionSpec` above). Can include an optional `condition` property for AI-evaluated step selection guidance.

**Returns:** A `TransitionResult` that includes the target step's reference (`id`, `routeId`) and a `nextStep` method for chaining additional transitions.

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
  schema: {
    type: "object",
    properties: {
      destination: { type: "string" },
      departureDate: { type: "string" },
      passengers: { type: "number", minimum: 1, maximum: 9 },
    },
    required: ["destination", "departureDate", "passengers"],
  },
});

// Approach 1: Step-by-step with data extraction and text conditions
const askDestination = flightRoute.initialStep.nextStep({
  prompt: "Ask where they want to fly",
  collect: ["destination"],
  skipIf: (data) => !!data.destination, // Skip if already have destination
  condition: "Customer hasn't specified destination yet", // AI-evaluated condition
});

const askDates = askDestination.nextStep({
  prompt: "Ask about travel dates",
  collect: ["departureDate"],
  skipIf: (data) => !!data.departureDate,
  requires: ["destination"], // Must have destination first
  condition: "Destination confirmed, need travel dates",
});

const askPassengers = askDates.nextStep({
  prompt: "How many passengers?",
  collect: ["passengers"],
  skipIf: (data) => !!data.passengers,
});

// Access step properties
console.log(askDestination.id); // Step ID
console.log(askDestination.routeId); // Route ID

// Approach 2: Fluent chaining for linear flows
flightRoute.initialStep
  .nextStep({
    prompt: "Extract travel details",
    collect: ["destination", "departureDate", "passengers"],
  })
  .nextStep({
    prompt: "Present available flights",
  })
  .nextStep({ step: END_ROUTE });

// Use with session step
let session = createSession<FlightData>();
const response = await agent.respond({ history, session });
console.log(response.session?.data); // { destination: "Paris", ... }
```

##### `addGuideline(guideline: Guideline): void`

Adds a guideline specific to this step.

##### `configure(config): this`

Configure the step properties after creation. Useful for overriding initial step configuration. Returns `this` for chaining.

```typescript
// Configure initial step after route creation
route.initialStep.configure({
  description: "Welcome! Let's get started",
  collectFields: ["name", "email"],
  skipIf: (data) => !!data.name && !!data.email,
  requires: [],
});

// Or configure any step
const askName = route.initialStep.nextStep({ prompt: "Ask for name" });
askName.configure({
  collectFields: ["firstName", "lastName"],
});
```

**Parameters:**

- `config`: Configuration object with optional properties:
  - `description?: string` - Step description
  - `collectFields?: string[]` - Fields to collect in this step
  - `skipIf?: (data: Partial<TData>) => boolean` - Skip condition function
  - `requires?: string[]` - Required data prerequisites

**Returns:** `this` for method chaining

#### Properties

##### `id: string`

Unique step identifier (readonly).

##### `routeId: string`

ID of the route this step belongs to (readonly).

##### `description: string`

Step description (readonly).

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
  currentStep?: string;
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
  step?: string;
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

### `SessionState<TData>`

Tracks the current position in the conversation flow and data collected during route progression.

```typescript
interface SessionState<TData = Record<string, unknown>> {
  /** Unique session identifier (useful for persistence) */
  id?: string;

  /** Current route the conversation is in */
  currentRoute?: {
    id: string;
    title: string;
    enteredAt: Date;
  };

  /** Current step within the route */
  currentStep?: {
    id: string;
    description?: string;
    enteredAt: Date;
  };

  /**
   * Data collected during the current route
   * Convenience reference to dataByRoute[currentRoute.id]
   */
  data: Partial<TData>;

  /**
   * Collected data organized by route ID
   * Preserves data when switching between routes
   * Format: { "routeId": { ...dataData } }
   */
  dataByRoute: Record<string, Partial<unknown>>;

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
- **`data`** - Type-safe data collected via `schema` for the **current route**
- **`dataByRoute`** - **NEW:** Per-route data map that preserves collected data when switching routes
- **`currentRoute`** / **`currentStep`** - Track conversation position
- **`routeHistory`** - Full audit trail of route transitions
- **`metadata`** - Custom data (timestamps, user info, etc.)

**Per-Route Data Preservation:**

When users switch routes (e.g., "Actually, I want to book a hotel instead"), the framework automatically:

- Saves current route's `data` data to `dataByRoute[routeId]`
- Loads the new route's data from `dataByRoute[newRouteId]` (if resuming)
- Keeps `data` as a convenient reference to the current route's data

This allows users to:

- Switch routes without losing progress
- Resume incomplete routes where they left off
- Access historical data from previous routes via `session.dataByRoute["route_id"]`

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

// Access collected data
console.log(response.session?.data.destination); // Type-safe!
```

---

### Session Helper Functions

#### `createSession<TData>(sessionId?, metadata?): SessionState<TData>`

Creates a new session step object.

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

#### `enterRoute<TData>(session, routeId, routeTitle): SessionState<TData>`

Updates session when entering a new route. Automatically:

- Exits previous route (if exists)
- Resets collected data
- Adds route to history
- Updates timestamps

**Example:**

```typescript
let session = createSession<FlightData>();

// Enter booking route
session = enterRoute(session, "book_flight", "Book a Flight");

console.log(session.currentRoute?.title); // "Book a Flight"
console.log(session.data); // {} (reset for new route)
```

#### `enterStep<TData>(session, stepId, description?): SessionState<TData>`

Updates session when entering a new step within a route.

**Example:**

```typescript
session = enterStep(session, "ask_destination", "Ask where to fly");

console.log(session.currentStep?.id); // "ask_destination"
console.log(session.currentStep?.description); // "Ask where to fly"
```

#### `mergeData<TData>(session, data): SessionState<TData>`

Merges new collected data into session. Updates timestamps automatically.

**Example:**

```typescript
session = mergeData(session, {
  destination: "Paris",
  departureDate: "2025-06-15",
});

console.log(session.data); // { destination: "Paris", departureDate: "2025-06-15" }
```

#### `sessionStepToData<TData>(session): object`

Converts SessionState to persistence-friendly format for database storage.

**Returns:**

```typescript
{
  currentRoute?: string;          // Route ID
  currentStep?: string;          // Step ID
  collectedData: {                // All session data
    data: Partial<TData>;
    routeHistory: Array<...>;
    currentRouteTitle?: string;
    currentStepDescription?: string;
    metadata?: object;
  };
}
```

**Example:**

```typescript
const session = createSession<FlightData>("session_123");
// ... conversation happens ...

// Save to database
const dbData = sessionStepToData(session);
await db.sessions.update(session.id!, {
  currentRoute: dbData.currentRoute,
  currentStep: dbData.currentStep,
  collectedData: dbData.collectedData,
});
```

#### `sessionDataToStep<TData>(sessionId, data): SessionState<TData>`

Converts database data back to SessionState for resuming conversations.

**Parameters:**

- `sessionId`: The database session ID
- `data`: Database session data (currentRoute, currentStep, collectedData)

**Example:**

```typescript
// Load from database
const dbSession = await db.sessions.findById("session_123");

// Restore session step
const session = sessionDataToStep<FlightData>(dbSession.id, {
  currentRoute: dbSession.currentRoute,
  currentStep: dbSession.currentStep,
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
session = response1.session!; // { data: { destination: "Paris" } }

// SAVE: To database
const saveData = sessionStepToData(session);
await db.sessions.update(session.id!, saveData);

// ---  Later (new request) ---

// LOAD: From database
const loaded = await db.sessions.findById("session_123");
const restored = sessionDataToStep<FlightData>(loaded.id, loaded);

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
  /** Current step within the route (step description or null) */
  step?: string | null;
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

#### `generateStepId(routeId: string, description?: string, index?: number): string`

Generates a deterministic step ID.

```typescript
import { generateStepId } from "@falai/agent";

const stepId = generateStepId("route_123", "Ask for name");
// Returns: "step_ask_for_name_{hash}"
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

Symbol marking the end of a conversation route. Use this when building routes to mark where they should end.

```typescript
import { END_ROUTE } from "@falai/agent";

const thankYou = askEmail.nextStep({
  prompt: "Thank you for your information!",
});

// Mark the end of the route
thankYou.nextStep({ step: END_ROUTE });
```

### `END_ROUTE_ID`

String constant representing END_ROUTE for runtime comparisons. When a route completes, `currentStep.id` is set to this value.

```typescript
import { END_ROUTE_ID } from "@falai/agent";

const response = await agent.respond({ history, session });

// Method 1: Using isRouteComplete (recommended)
if (response.isRouteComplete) {
  console.log("Route completed!");
}

// Method 2: Using END_ROUTE_ID constant
if (response.session?.currentStep?.id === END_ROUTE_ID) {
  console.log("Route completed!");
}
```

**Note:** Both methods are equivalent. Use `isRouteComplete` for simplicity, or `END_ROUTE_ID` for consistency with how you build routes.

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

## Template Utilities

### Template Variable Support

The framework supports template variables using `{{variable}}` syntax in selected parts of the agent configuration. Templates are replaced with values from the agent's context at runtime to enable dynamic, personalized interactions while keeping structural elements predictable for AI consistency.

#### `renderTemplate(template: string, context?: Record<string, unknown>): string`

Renders template variables in a string using the provided context. Supports nested property access with dot notation.

```typescript
import { renderTemplate } from "@falai/agent";

// Basic usage
const template1 = "Hello {{name}}, welcome to {{company}}!";
const context1 = { name: "Alice", company: "Acme Corp" };
const result1 = renderTemplate(template1, context1);
// Result: "Hello Alice, welcome to Acme Corp!"

// Nested properties
const template2 = "Hello {{user.name}}, you are {{user.age}} years old!";
const context2 = { user: { name: "Alice", age: 30 } };
const result2 = renderTemplate(template2, context2);
// Result: "Hello Alice, you are 30 years old!"

// Arrays (joined with commas)
const template3 = "Items: {{items}}";
const context3 = { items: ["apple", "banana", "cherry"] };
const result3 = renderTemplate(template3, context3);
// Result: "Items: apple, banana, cherry"

// Objects (converted to JSON)
const template4 = "User data: {{user}}";
const context4 = { user: { name: "Alice", age: 30 } };
const result4 = renderTemplate(template4, context4);
// Result: "User data: {"name":"Alice","age":30}"
```

#### `renderTemplateArray(templates: string[], context?: Record<string, unknown>): string[]`

Renders template variables in an array of strings.

#### `renderTemplateObject(obj: unknown, context?: Record<string, unknown>): unknown`

Recursively renders template variables in objects and arrays.

**Supported in (Dynamic/Personalized):**

- Agent identity and personality (for customized AI persona)
- Route conditions (for context-aware routing logic)
- Step prompts (for personalized user messages)
- Guideline conditions and actions (for dynamic behavioral rules)
- Term names, descriptions, and synonyms (for domain-specific customization)

**Not supported in (Static/Predictable):**

- Route titles and descriptions (kept literal for consistent AI routing decisions)
- Step descriptions (kept literal for predictable step selection)
- Capability titles and descriptions (kept literal for stable AI tool understanding)
- Agent name, goal, description (kept literal for consistent agent metadata)

**Example:**

```typescript
const agent = new Agent({
  name: "Assistant", // Static - AI knows its identity
  identity:
    "I am {{name}}, here to help you, {{user.firstName}} {{user.lastName}}.", // Dynamic - personalized greeting
  context: {
    name: "HelperBot",
    user: { firstName: "Alice", lastName: "Smith", age: 30 },
  },
});

agent.createGuideline({
  condition: "User is {{user.age}} years old", // Dynamic - context-aware condition
  action:
    "Be helpful to {{user.firstName}} and consider their age in responses", // Dynamic - personalized action
});

const route = agent.createRoute({
  title: "User Onboarding", // Static - predictable route identifier
  description: "Standard onboarding process", // Static - consistent AI understanding
  conditions: ["{{user.needsOnboarding}}"], // Dynamic - context-aware activation
  initialStep: {
    prompt: "Welcome {{user.firstName}}! Let's get you set up.", // Dynamic - personalized message
  },
});
```

---

**Made with ❤️ for the community**
