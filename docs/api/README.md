# API Reference

Complete API documentation for `@falai/agent`. This framework provides a strongly-typed, modular agent architecture with AI-powered routing and schema-driven data collection.

## 📋 Documentation Structure

- **[Complete API Overview](./overview.md)** - Comprehensive reference for all classes, interfaces, and utilities
- **[Agent Architecture](../core/agent/README.md)** - Agent class, context management, and lifecycle
- **[AI Routing System](../core/routing/intelligent-routing.md)** - Intelligent route and step selection
- **[Route DSL](../core/conversation-flows/route-dsl.md)** - Declarative conversation flow design
- **[Data Collection](../core/conversation-flows/data-collection.md)** - Schema-driven data extraction
- **[Tool Execution](../core/tools/tool-execution.md)** - Dynamic tool calling and context updates
- **[Session Storage](../core/persistence/session-storage.md)** - Persistence and session management
- **[AI Providers](../core/ai-integration/providers.md)** - Provider integrations and configuration

---

## Core Classes

### `Agent<TContext, TData>`

Main agent class for managing conversational AI with agent-level data collection.

#### Constructor

```typescript
new Agent<TContext, TData>(options: AgentOptions<TContext, TData>)
```

See [Agent](./AGENT.md) for full details.

#### Methods

##### `createRoute(options: RouteOptions): Route`

Creates a new conversation route with required fields specification.

##### `getCollectedData(): Partial<TData>`

Gets the current agent-level collected data.

```typescript
const data = agent.getCollectedData();
console.log(data); // { customerName: "John", email: "john@example.com" }
```

##### `updateCollectedData(updates: Partial<TData>): Promise<void>`

Updates agent-level collected data and triggers validation.

```typescript
await agent.updateCollectedData({
  customerId: "CUST-12345",
  priority: "high"
});
```

##### `validateData(data: Partial<TData>): ValidationResult`

Validates data against the agent-level schema.

```typescript
const validation = agent.validateData({ email: "invalid-email" });
if (!validation.valid) {
  console.log(validation.errors); // Detailed validation errors
}
```

##### `createTerm(term: Term): this`

Adds a domain glossary term. Returns `this` for chaining.

##### `createGuideline(guideline: Guideline): this`

Adds a behavioral guideline. Returns `this` for chaining.

##### `addTool(definition: Tool<TContext, TData, TResult>): this`

Creates and adds a tool to agent scope using the unified Tool interface. Returns `this` for chaining.

```typescript
// Simple return value approach
agent.addTool({
  id: "weather_check",
  description: "Get current weather",
  parameters: {
    type: "object",
    properties: {
      location: { type: "string", description: "City name" }
    },
    required: ["location"]
  },
  handler: async ({ context, data }, args) => {
    const weather = await weatherAPI.get(args.location);
    return `Weather in ${args.location}: ${weather.condition}`;
  }
});

// Advanced ToolResult pattern
agent.addTool({
  id: "user_lookup",
  description: "Look up user information",
  handler: async ({ context, data }, args) => {
    const user = await userAPI.find(args.userId);
    return {
      data: `Found user: ${user.name}`,
      success: true,
      contextUpdate: { currentUser: user },
      dataUpdate: { userName: user.name }
    };
  }
});
```

##### `tool: ToolManager<TContext, TData>`

Access to the ToolManager instance for advanced tool operations.

```typescript
// Register tools for ID-based reference
agent.tool.register({
  id: "reusable_search",
  description: "Search across data sources",
  handler: async ({ context, data }, args) => "Search results"
});

// Create tools without adding to scope
const customTool = agent.tool.create({
  id: "standalone_tool",
  handler: async () => "Custom result"
});

// Use pattern helpers
const enrichmentTool = agent.tool.createDataEnrichment({
  id: "enrich_profile",
  fields: ['name', 'email'],
  enricher: async (context, data) => ({
    displayName: `${data.name} <${data.email}>`
  })
});
```

##### `respond(input: RespondInput<TContext>): Promise<RespondOutput>`

Generates an AI response with session step management, tool execution, data extraction, and intelligent routing.

**Note:** This method now delegates to the internal `ResponseModal` class for improved architecture and maintainability.

**Enhanced Response Pipeline:**

1. **Tool Execution** - Execute tools if current step has `tool` (enriches context before AI response)
2. **Always-On Routing** - Score all routes, respect user intent to change direction
3. **Step Traversal** - Use `skipIf` and `requires` to determine next step
4. **Response Generation** - Build schema with `collect` fields, extract data
5. **Session Update** - Merge collected data into session step

**Tool Execution (Pre-Response):**
Tools execute before AI response generation, allowing them to:

- Enrich context with external data
- Update collected session data
- Perform business logic
- Access APIs and databases

This design enables more intelligent, context-aware responses.

##### `getKnowledgeBase(): Record<string, unknown>`

Gets the agent's knowledge base containing any JSON structure the AI should know.

```typescript
const knowledge = agent.getKnowledgeBase();
// Returns the agent's knowledge base
```

##### `getRoutes(): Route<TContext, unknown>[]`

Gets all routes configured in the agent.

```typescript
const routes = agent.getRoutes();
// Returns array of all configured routes
```

##### `getTerms(): Term<TContext>[]`

Gets all terms configured in the agent.

```typescript
const terms = agent.getTerms();
// Returns array of all configured terms
```

##### `getGuidelines(): Guideline<TContext>[]`

Gets all guidelines configured in the agent.

```typescript
const guidelines = agent.getGuidelines();
// Returns array of all configured guidelines
```

````typescript

##### `getPersistenceManager(): PersistenceManager | undefined`

Gets the persistence manager if configured.

```typescript
const persistence = agent.getPersistenceManager();
// Returns PersistenceManager instance or undefined if not configured
````

##### `hasPersistence(): boolean`

Checks if persistence is enabled.

```typescript
if (agent.hasPersistence()) {
  // Persistence is configured
}
```

##### `nextStepRoute(routeIdOrTitle, session?, condition?, history?): Promise<SessionState>`

Manually transition to a different route by setting a pending transition that will be executed on the next `respond()` call.

```typescript
// Transition to feedback route after completion
const updatedSession = await agent.nextStepRoute(
  "feedback-collection",
  session
);

// Next respond() call will automatically transition
const response = await agent.respond({ history, session: updatedSession });
```

**Parameters:**

- `routeIdOrTitle`: Route ID or title to transition to
- `session`: Session step to update (uses current session if not provided)
- `condition`: Optional AI-evaluated condition for the transition
- `history`: Optional history for template context

**Returns:** Updated session with pending transition

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

**Example with Automatic Session Management:**

```typescript
// Server endpoint with automatic session management
app.post('/chat', async (req, res) => {
  const { sessionId, message } = req.body;
  
  const agent = new Agent({
    name: "Travel Agent",
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

**SessionManager API:**

```typescript
// Access session manager
const sessionManager = agent.session;

// Get or create session (works for existing, new, or auto-generated IDs)
await sessionManager.getOrCreate("user-123");
await sessionManager.getOrCreate(); // Auto-generates ID

// Data access
const data = sessionManager.getData<FlightData>();
await sessionManager.setData({ destination: "Paris" });

// History management
await sessionManager.addMessage("user", "Hello");
const history = sessionManager.getHistory();
sessionManager.clearHistory();

// Session operations
await sessionManager.save(); // Manual save (auto-saves on addMessage)
await sessionManager.delete();
const newSession = await sessionManager.reset(true); // Preserve history
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
  role: "assistant",
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

return response.message;
```

**Important Notes:**

- `isRouteComplete` is `true` when the route reaches an `END_ROUTE` transition
- The `message` contains the completion message generated by the AI when `isRouteComplete` is `true`
- You should check `isRouteComplete` and handle completion appropriately
- If all steps are skipped (due to `skipIf` conditions), the route can complete immediately on entry
- Use `agent.getData(session)` to retrieve all collected data

See also: [Custom Database Integration Example](../examples/custom-database-persistence.ts)

##### `respondStream(input: RespondInput<TContext>): AsyncGenerator<StreamChunk>`

Generates an AI response as a real-time stream for better user experience. Provides the same structured output as `respond()` but delivers it incrementally.

**Note:** This method now delegates to the internal `ResponseModal` class for improved architecture and maintainability.

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

##### `stream(message?: string, options?: StreamOptions<TContext>): AsyncGenerator<AgentResponseStreamChunk<TData>>`

**NEW:** Modern streaming API that provides a simple interface similar to `chat()` but returns a stream. This is the recommended way to implement streaming responses.

```typescript
interface StreamOptions<TContext = unknown> {
  contextOverride?: Partial<TContext>;
  signal?: AbortSignal;
  history?: History; // Optional: override session history
}
```

**Key Features:**

- 🎯 **Simple Interface**: Just `agent.stream("message")` - no complex parameters
- 🔄 **Automatic Session Management**: Handles conversation history automatically
- 🌊 **Real-time Streaming**: Same performance as `respondStream()` but easier to use
- 🛑 **Cancellable**: Supports AbortSignal for cancellation

**Example:**

```typescript
// Simple streaming - automatically manages session history
for await (const chunk of agent.stream("Hello, how are you?")) {
  if (chunk.delta) {
    process.stdout.write(chunk.delta);
  }
  
  if (chunk.done) {
    console.log("\n✅ Stream complete!");
    // Session history is automatically updated
  }
}

// With cancellation
const controller = new AbortController();
setTimeout(() => controller.abort(), 5000); // Cancel after 5s

for await (const chunk of agent.stream("Tell me a long story", {
  signal: controller.signal
})) {
  process.stdout.write(chunk.delta);
}
```

**Migration from `respondStream()`:**

```typescript
// Old way (still supported)
for await (const chunk of agent.respondStream({
  history: agent.session.getHistory(),
  session: await agent.session.getOrCreate()
})) {
  // Handle chunk
}

// New way (recommended)
for await (const chunk of agent.stream("Your message")) {
  // Handle chunk - session management is automatic
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
  role: "assistant",
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

##### `identity(): Template<TContext> | undefined`

Agent's identity template (readonly).

---

### `ResponseModal<TContext, TData>`

**NEW:** Internal class that handles all response generation logic for the Agent. This class centralizes response processing, provides unified streaming and non-streaming APIs, and improves maintainability.

**Note:** This class is primarily used internally by the Agent class. Most users should use the Agent's response methods (`respond`, `respondStream`, `stream`, `chat`) rather than accessing ResponseModal directly.

#### Constructor

```typescript
new ResponseModal<TContext, TData>(
  agent: Agent<TContext, TData>,
  options?: ResponseModalOptions
)

interface ResponseModalOptions {
  /** Maximum number of tool loops allowed during response generation */
  maxToolLoops?: number;
  /** Enable automatic session saving after response generation */
  enableAutoSave?: boolean;
  /** Enable debug mode for detailed logging */
  debugMode?: boolean;
}
```

#### Methods

##### `respond(params: RespondParams<TContext, TData>): Promise<AgentResponse<TData>>`

Generates a non-streaming response using unified logic. This method consolidates all response generation logic including routing, tool execution, and data collection.

##### `respondStream(params: RespondParams<TContext, TData>): AsyncGenerator<AgentResponseStreamChunk<TData>>`

Generates a streaming response using unified logic. Provides the same functionality as `respond()` but delivers results incrementally.

##### `stream(message?: string, options?: StreamOptions<TContext>): AsyncGenerator<AgentResponseStreamChunk<TData>>`

Modern streaming API with automatic session management. This is the recommended way to implement streaming responses.

```typescript
// Simple usage
for await (const chunk of responseModal.stream("Hello")) {
  console.log(chunk.delta);
}

// With options
for await (const chunk of responseModal.stream("Hello", {
  contextOverride: { userId: "123" },
  signal: abortController.signal
})) {
  console.log(chunk.delta);
}
```

##### `generate(message?: string, options?: GenerateOptions<TContext>): Promise<AgentResponse<TData>>`

Modern non-streaming API equivalent to `chat()` but more explicit. Provides automatic session management for non-streaming responses.

```typescript
// Simple usage
const response = await responseModal.generate("Hello");
console.log(response.message);

// With options
const response = await responseModal.generate("Hello", {
  contextOverride: { userId: "123" }
});
```

#### Error Handling

ResponseModal includes comprehensive error handling with the `ResponseGenerationError` class:

```typescript
try {
  const response = await responseModal.respond(params);
} catch (error) {
  if (ResponseGenerationError.isResponseGenerationError(error)) {
    console.log("Response generation failed:", error.message);
    console.log("Phase:", error.details?.phase);
    console.log("Original error:", error.details?.originalError);
  }
}
```

#### Architecture Benefits

- **Separation of Concerns**: Agent focuses on configuration and orchestration, ResponseModal handles response generation
- **Unified Logic**: Both streaming and non-streaming responses use the same underlying logic
- **Modern APIs**: Provides simple `stream()` and `generate()` methods alongside legacy compatibility
- **Error Handling**: Comprehensive error handling with detailed context
- **Performance**: Optimized response pipeline with minimal duplication

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
  identity?: string;        // Optional identity prompt defining the agent's role and persona for this route
  personality?: Template;   // Optional personality prompt defining the agent's communication style for this route
  conditions?: string[];    // Conditions that activate this route
  guidelines?: Guideline[]; // Initial guidelines for this route
  terms?: Term[];          // Initial terms for the route's domain glossary
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
  steps?: StepOptions<unknown, TData>[];
  /** Knowledge base specific to this route containing any JSON structure the AI should know */
  knowledgeBase?: Record<string, unknown>;
  /**
   * Route lifecycle hooks
   */
  hooks?: RouteLifecycleHooks<TContext, TData>;
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

##### `createTerm(term: Term): this`

Adds a term to the route's domain glossary. Returns `this` for chaining.

##### `getTerms(): Term[]`

Returns all terms in the route's domain glossary.

##### `getRules(): string[]`

Returns the rules that must be followed in this route.

##### `getProhibitions(): string[]`

Returns the prohibitions that must never be done in this route.

##### `getKnowledgeBase(): Record<string, unknown>`

Gets the route's knowledge base containing any JSON structure the AI should know.

```typescript
const knowledge = route.getKnowledgeBase();
// Returns the route-specific knowledge base
```

##### `getRef(): RouteRef`

Returns a reference to this route.

##### `getAllSteps(): Step<TContext, TData>[]`

Gets all steps in this route via traversal from the initial step.

```typescript
const steps = route.getAllSteps();
// Returns array of all steps in the route
```

##### `getStep(stepId: string): Step<TContext, TData> | undefined`

Gets a specific step by ID.

```typescript
const step = route.getStep("ask_destination");
// Returns the step with the specified ID or undefined
```

##### `describe(): string`

Generates a description of this route's structure for debugging.

```typescript
const description = route.describe();
console.log(description);
// Output:
// Route: Book Flight
// ID: route_book_flight
// Description: N/A
// Conditions: None
//
// Steps:
//   - step_ask_destination: Ask where to fly
//     -> step_ask_dates: Ask about travel dates
//     -> step_ask_passengers: How many passengers?
```

##### `handleDataUpdate(data, previousCollected): Promise<Partial<TData>>`

Handles data updates for this route, calling the onDataUpdate hook if configured. Returns modified data after hook processing, or original data if no hook.

```typescript
const updatedData = await route.handleDataUpdate(newData, previousData);
```

**Parameters:**

- `data`: New collected data
- `previousCollected`: Previously collected data

**Returns:** Modified data after hook processing

##### `handleContextUpdate(newContext, previousContext): Promise<void>`

Handles context updates for this route, calling the onContextUpdate hook if configured.

```typescript
await route.handleContextUpdate(newContext, previousContext);
```

**Parameters:**

- `newContext`: New context
- `previousContext`: Previous context

##### `evaluateOnComplete(session, context?): Promise<RouteTransitionConfig<TContext, TData> | undefined>`

Evaluates the onComplete handler and returns transition config.

```typescript
const transition = await route.evaluateOnComplete(
  { data: session.data },
  context
);

if (transition) {
  // Transition to next route
  console.log(`Next route: ${transition.nextStep}`);
}
```

**Note:** Routes no longer have a `getData()` method. Use `agent.getData()` or `agent.getData(routeId)` instead.

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

##### `hooks?: RouteLifecycleHooks<TContext, TData>`

Route lifecycle hooks for managing route-specific data and behavior (readonly).

---

### `Step`

Represents a step within a conversation route.

#### Methods

##### `nextStep(spec: StepOptions): Step`

Creates a transition from this step and returns a chainable result.

```typescript
interface StepOptions<TData = unknown> {
  id?: string; // step id
  description?: string; // Step description
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

interface Step<TContext = unknown, TData = unknown> {
  id: string; // Step identifier
  routeId: string; // Route identifier
  nextStep: (spec: StepOptions<TContext, TData>) => Step<TContext, TData>;
  description?: string; // Step description
  collect?: (keyof TData)[]; // Fields to collect in this step
  skipIf?: (data: Partial<TData>) => boolean; // Skip condition function
  requires?: (keyof TData)[]; // Required data prerequisites
}
```

**Parameters:**

- `spec`: The transition specification (see `StepOptions` above). Can include an optional `condition` property for AI-evaluated step selection guidance.

**Returns:** A `Step` that includes the target step's reference (`id`, `routeId`) and a `nextStep` method for chaining additional transitions.

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

// Automatic session management
const agent = new Agent({
  name: "Travel Agent",
  provider: new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY }),
  persistence: { adapter: new PrismaAdapter({ prisma }) },
  sessionId: "user-123" // Automatically loads or creates session
});

const response = await agent.respond("I want to book a flight to Paris");
console.log(agent.session.getData<FlightData>()); // { destination: "Paris", ... }
```

##### `addGuideline(guideline: Guideline): void`

Adds a guideline specific to this step.

##### `getGuidelines(): Guideline<TContext>[]`

Gets all guidelines for this step.

```typescript
const guidelines = step.getGuidelines();
// Returns array of guidelines specific to this step
```

##### `getTransitions(): Step<TContext, TData>[]`

Gets all transitions from this step.

```typescript
const nextSteps = step.getTransitions();
// Returns array of possible next steps
```

##### `shouldSkip(data: Partial<TData>): boolean`

Checks if this step should be skipped based on collected data.

```typescript
if (step.shouldSkip(session.data)) {
  // Skip this step
}
```

##### `hasRequires(data: Partial<TData>): boolean`

Checks if this step has all required data to proceed.

```typescript
if (step.hasRequires(session.data)) {
  // Step can proceed
}
```



##### `configure(config): this`

Configure the step properties after creation. Useful for overriding initial step configuration. Returns `this` for chaining.

```typescript
// Configure initial step after route creation
route.initialStep.configure({
  description: "Welcome! Let's get started",
  collect: ["name", "email"],
  skipIf: (data) => !!data.name && !!data.email,
  requires: [],
  prompt: "Hello! Let's get started with your information.",
});

// Or configure any step
const askName = route.initialStep.nextStep({ prompt: "Ask for name" });
askName.configure({
  collect: ["firstName", "lastName"],
});
```

**Parameters:**

- `config`: Configuration object with optional properties:
  - `description?: string` - Step description
  - `collect?: string[]` - Fields to collect in this step
  - `skipIf?: (data: Partial<TData>) => boolean` - Skip condition function
  - `requires?: string[]` - Required data prerequisites
  - `prompt?: Template<TContext, TData>` - Step prompt template

**Returns:** `this` for method chaining

#### Properties

##### `id: string`

Unique step identifier (readonly).

##### `routeId: string`

ID of the route this step belongs to (readonly).

##### `description: string`

Step description (readonly).

---

---

## Tool Execution

Tools provide a powerful way to execute custom logic, access external APIs, and enrich conversation context before AI response generation.

**See Also:** [TOOLS.md](./TOOLS.md) - Complete guide to tool execution, lifecycle, and best practices

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

##### `updateCollectedData(sessionId: string, collectedData: Record<string, unknown>): Promise<SessionData | null>`

Updates collected data in session.

##### `updateRouteStep(sessionId: string, route?: string, step?: string): Promise<SessionData | null>`

Updates current route and step in session.

##### `getUserMessages(userId?: string, limit?: number): Promise<MessageData[]>`

Gets messages for a user.

##### `deleteSession(sessionId: string): Promise<boolean>`

Deletes a session and all its messages.

##### `messageToEvent(message: MessageData): Event | undefined`

Helper: Convert message data to Event format.

##### `saveSessionState(sessionId: string, sessionStep: SessionState): Promise<SessionData | null>`

Saves SessionState to database by converting to SessionData.

```typescript
const saved = await persistence.saveSessionState(sessionId, sessionState);
```

##### `loadSessionState(sessionId: string): Promise<SessionState | null>`

Loads SessionState from database by converting from SessionData.

```typescript
const sessionState = await persistence.loadSessionState(sessionId);
```

##### `createSessionWithStep(options: CreateSessionOptions): Promise<{ sessionData: SessionData; sessionStep: SessionState }>`

Creates a new session with both SessionData and initialized SessionState.

```typescript
const { sessionData, sessionStep } = await persistence.createSessionWithStep({
  userId: "user_123",
  agentName: "Travel Agent",
  initialData: { channel: "web" },
});
```

---

### `RoutingEngine<TContext, TData>`

Handles route and step selection logic for conversation orchestration.

#### Constructor

```typescript
new RoutingEngine<TContext, TData>(options?: RoutingEngineOptions)

interface RoutingEngineOptions {
  allowRouteSwitch?: boolean;  // Default: true
  switchThreshold?: number;    // Default: 70 (0-100)
  maxCandidates?: number;      // Default: 5
}
```

#### Methods

##### `decideRouteAndStep(params): Promise<RoutingDecision>`

Combines route selection and step selection into a single orchestrated decision.

**Parameters:**

- `routes`: Array of available routes
- `session`: Current session state
- `history`: Conversation history
- `agentOptions`: Agent metadata
- `provider`: AI provider for scoring
- `context`: Agent context
- `signal`: Optional abort signal

**Returns:** Routing decision with selected route, step, directives, and updated session

---

### `ResponseEngine<TContext>`

Builds prompts and response schemas for AI message generation.

#### Constructor

```typescript
new ResponseEngine<TContext>();
```

#### Methods

##### `responseSchemaForRoute(route, currentStep?): StructuredSchema`

Builds JSON schema for AI responses based on route and current step.

##### `buildResponsePrompt(params): Promise<string>`

Builds a comprehensive prompt for AI response generation including context, guidelines, and route information.

**Parameters:**

- `route`: Current route
- `currentStep`: Current step in route
- `rules`: Route-specific rules
- `prohibitions`: Route-specific prohibitions
- `directives`: Response directives
- `history`: Conversation history
- `lastMessage`: Last user message
- `agentOptions`: Agent metadata
- `context`: Agent context
- `session`: Current session state

##### `buildFallbackPrompt(params): Promise<string>`

Builds a fallback prompt when no routes are configured.

---

### `Events`

Utility functions for creating and adapting conversation events.

#### Functions

##### `adaptEvent(event): string`

Adapts an event for inclusion in AI prompts by transforming it into serializable format.

```typescript
const promptText = adaptEvent(messageEvent);
```

##### History Format

For conversation history, use the simplified `History` type instead of manually creating events. See the [History Format](#history-format) section below for details.

##### `createToolEvent(source, toolCalls, timestamp?): Event`

Creates a tool execution event.

```typescript
const toolEvent = createToolEvent(MessageRole.AGENT, [
  { tool_id: "search_flights", arguments: { from: "NYC", to: "LAX" }, result: { flights: [...] } }
]);
```

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
  role: MessageRole; // "user" | "assistant" | "agent" | "system"
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

##### `addActiveRoutes(routes): this`

Adds active routes to the prompt.

##### `build(): string`

Builds the final prompt string.

---

### `PromptComposer`

Constructs prompts for AI generation.

**Note:** As of the latest version, many methods in `PromptComposer` are `async` to support function-based templates.

#### Methods

##### `addIdentity(name: string, description?: string, goal?: string): this`

Adds agent identity section.

##### `addContext(variables: ContextVariable[]): this`

Adds context variables.

##### `addGlossary(terms: Term[]): this`

Adds domain glossary terms.

##### `addGuidelinesForMessageGeneration(guidelines: GuidelineMatch[]): this`

Adds guidelines section.

##### `addActiveRoutes(routes): this`

Adds active routes to the prompt.

##### `build(): Promise<string>`

Builds the final prompt string.

---

## Utility Functions

### `Tool<TContext, TArgs, TResult, TData>`

Defines a type-safe tool using the Tool interface.

```typescript
interface Tool<
  TContext = unknown,
  TArgs extends unknown[] = unknown[],
  TResult = unknown,
  TData = unknown
> {
  id: string; // Unique tool identifier
  description?: string; // Description for AI discovery
  parameters?: unknown; // JSON Schema for tool parameters
  handler: ToolHandler<TContext, TArgs, TResult, TData>; // Tool execution handler
}
```

**Example:**

```typescript
const getTool: Tool<MyContext, [id: string], Data> = {
  id: "get_data",
  description: "Fetches data by ID",
  parameters: {
    type: "object",
    properties: {
      id: { type: "string", description: "The data ID to fetch" },
    },
    required: ["id"],
  },
  handler: async (toolContext, args) => {
    return { data: await fetchData(args.id) };
  },
};
```

---

### `formatKnowledgeBase(data, title?, maxDepth?)`

Formats a JSON structure into readable markdown format for AI prompts. Handles nested objects, arrays, and primitive values.

```typescript
formatKnowledgeBase(
  data: Record<string, unknown> | unknown,
  title?: string,
  maxDepth?: number
): string
```

**Parameters:**

- `data` - The JSON data to format
- `title` - Optional title for the knowledge base section
- `maxDepth` - Maximum nesting depth (default: 3)

**Returns:** Formatted markdown string

**Example:**

```typescript
import { formatKnowledgeBase } from "@falai/agent";

const knowledge = {
  company: {
    name: "Acme Corp",
    products: ["Widget A", "Widget B"],
    locations: {
      headquarters: "NYC",
      branches: ["LA", "Chicago"],
    },
  },
};

const markdown = formatKnowledgeBase(knowledge, "Company Information");
// Output:
// ## Company Information
//
// - **name**: Acme Corp
// - **products**:
//   - Widget A
//   - Widget B
// - **locations**:
//   - **headquarters**: NYC
//   - **branches**:
//     - LA
//     - Chicago
```

---

### History Format

The agent accepts a simplified history format for conversation context. This format is easier to use than the internal Event structure.

#### Types

```typescript
type Role = "user" | "assistant" | "tool" | "system";

type HistoryItem =
  | {
      role: "user";
      content: string;
      name?: string; // Optional participant name
    }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: Array<{
        id: string;
        name: string;
        arguments: Record<string, unknown>;
      }>;
    }
  | {
      role: "tool";
      tool_call_id: string;
      name: string;
      content: any;
    }
  | {
      role: "system";
      content: string;
    };

type History = HistoryItem[];
```

**Example:**

```typescript
// Simple conversation history
const history: History = [
  {
    role: "user",
    content: "Hello! Can you help me book a flight?",
    name: "Alice"
  },
  {
    role: "assistant",
    content: "I'd be happy to help you book a flight. Where would you like to go?"
  },
  {
    role: "user",
    content: "I want to go to Paris next Friday for 2 people.",
    name: "Alice"
  }
];

// Assistant with tool calls
const historyWithTools: History = [
  {
    role: "assistant",
    content: "I'll search for flights to Paris.",
    tool_calls: [
      {
        id: "search_flights_1",
        name: "search_flights",
        arguments: {
          destination: "Paris",
          date: "2025-10-18",
          passengers: 2
        }
      }
    ]
  },
  {
    role: "tool",
    tool_call_id: "search_flights_1",
    name: "search_flights",
    content: { flights: [...] }  // Tool execution result
  }
];
```

---

### `createToolEvent()`

Creates a tool execution event.

```typescript
createToolEvent(
  source: MessageRole,
  toolCalls: ToolCall[],
  timestamp?: string  // Optional: provide custom timestamp (ISO 8601 format)
): Event
```

**Example:**

```typescript
// With auto-generated timestamp
createToolEvent(MessageRole.AGENT, [
  { tool_id: "get_data", arguments: { id: "123" }, result: { data: {...} } }
]);

// With custom timestamp
createToolEvent(
  MessageRole.AGENT,
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
interface Term<TContext = unknown> {
  name: Template<TContext>;
  description: Template<TContext>;
  synonyms?: Template<TContext>[];
}
```

---

### `Guideline`

```typescript
interface Guideline<TContext = unknown> {
  id?: string;
  condition?: Template<TContext>;
  action: Template<TContext>;
  enabled?: boolean; // Default: true
  tags?: string[];
  tools?: ToolRef[];
  metadata?: Record<string, unknown>;
}
```

---

### `RouteLifecycleHooks<TContext, TData>`

Route lifecycle hooks for managing route-specific data and behavior.

```typescript
interface RouteLifecycleHooks<TContext = unknown, TData = unknown> {
  /**
   * Called after collected data is updated for this route (from AI response or tool execution)
   * Useful for validation, enrichment, or persistence of route-specific collected data
   * Return modified collected data or the same data to keep it unchanged
   *
   * Unlike Agent-level onDataUpdate, this only triggers for data changes in this specific route.
   */
  onDataUpdate?: (
    data: Partial<TData>,
    previousCollected: Partial<TData>
  ) => Partial<TData> | Promise<Partial<TData>>;

  /**
   * Called after context is updated via updateContext() when this route is active
   * Useful for route-specific context reactions, validation, or side effects
   *
   * Unlike Agent-level onContextUpdate, this only triggers when this specific route is active.
   */
  onContextUpdate?: (
    newContext: TContext,
    previousContext: TContext
  ) => void | Promise<void>;
}
```

---

---

### `Event`

```typescript
interface Event {
  kind: EventKind;
  source: MessageRole;
  data: MessageEventData | ToolEventData | StatusEventData;
  creation_utc: string;
}

enum EventKind {
  MESSAGE = "message",
  TOOL = "tool",
  STATUS = "status",
}

enum MessageRole {
  USER = "user",
  ASSISTANT = "assistant",
  AGENT = "agent",
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

### `RoutingDecision`

Result of route and step selection process.

```typescript
interface RoutingDecision {
  context: string;
  routes: Record<string, number>; // Route scores
  responseDirectives?: string[];
  extractions?: unknown;
  contextUpdate?: Record<string, unknown>;
}
```

---

### `ToolExecutionResult`

Result of tool execution.

```typescript
interface ToolExecutionResult {
  toolName: string;
  success: boolean;
  data?: unknown;
  contextUpdate?: Record<string, unknown>;
  dataUpdate?: Record<string, unknown>;
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
  data?: Partial<TData>;

  /**
   * Data collected organized by route ID
   * Persists data when switching between routes
   * Allows resuming incomplete routes where they left off
   */
  dataByRoute?: Record<string, Partial<unknown>>;

  /** History of routes visited in this session */
  routeHistory: Array<{
    routeId: string;
    enteredAt: Date;
    exitedAt?: Date;
    completed: boolean;
  }>;

  /**
   * Pending route transition after completion
   * Set when a route completes with onComplete handler
   */
  pendingTransition?: {
    targetRouteId: string;
    condition?: string;
    reason: "route_complete" | "manual";
  };

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
- **`dataByRoute`** - **Per-route data map that preserves collected data when switching routes**
- **`currentRoute`** / **`currentStep`** - Track conversation position
- **`routeHistory`** - Full audit trail of route transitions
- **`pendingTransition`** - Handles route completion transitions
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

#### `mergeCollected<TData>(session, data): SessionState<TData>`

Merges new collected data into session. Updates timestamps automatically.

**Example:**

```typescript
session = mergeCollected(session, {
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
  TOOLS
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

---

## Template Utilities

### Dynamic Content with Templates

The framework supports dynamic content generation through a versatile `Template` system. A `Template` can be either a simple string with `{{variable}}` placeholders or a function that returns a string, allowing for more complex, context-aware logic.

Templates are evaluated at runtime with a `TemplateContext` object that provides access to the agent's state:

```typescript
interface TemplateContext<TContext = unknown, TData = unknown> {
  context?: TContext;
  session?: SessionState<TData>;
  history?: Event[];
  data?: Partial<TData>; // Convenience alias for session.data
}
```

#### `Template<TContext, TData>` Type

This is the core type for all dynamic content:

```typescript
type Template<TContext = unknown, TData = unknown> =
  | string
  | ((params: TemplateContext<TContext, TData>) => string | Promise<string>);
```

**String Templates:**

Simple strings with `{{variable}}` placeholders are rendered using values from the `context` object.

```typescript
const agent = new Agent({
  identity: "I am {{name}}",
  context: { name: "HelperBot" },
});
```

**Function Templates:**

For more complex logic, you can provide a function that receives the `TemplateContext` and returns a string (or a `Promise<string>` for async operations).

```typescript
const agent = new Agent({
  identity: ({ context }) => `I am here to help, ${context.user.name}`,
  context: { user: { name: "Alice" } },
});
```

#### `render(template, params)`

An internal async utility that resolves a `Template` to a string. You won't typically call this directly, but it powers the dynamic content generation throughout the framework.

**Supported in (Dynamic/Personalized):**

- **Agent**: `identity`
- **Terms**: `name`, `description`, `synonyms`
- **Guidelines**: `condition`, `action`
- **Routes**: `conditions`, `rules`, `prohibitions`
- **Steps/Transitions**: `prompt`, `condition`

**Not supported in (Static/Predictable):**

- Agent `name`, `goal`, `description`
- Route `title`, `description`
- Step `description`

**Example:**

```typescript
const agent = new Agent({
  name: "Assistant", // Static
  identity: ({ context }) =>
    `I am here to help you, ${context.user.firstName}.`, // Dynamic
  context: {
    user: { firstName: "Alice", age: 30 },
  },
});

agent.createGuideline({
  condition: ({ context }) => context.user.age > 18, // Dynamic condition
  action:
    "Be helpful to {{user.firstName}} and consider their age in responses", // Dynamic action
});
```

---

**Made with ❤️ for the community**