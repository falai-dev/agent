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

##### `createObservation(description: string): Observation`

Creates an observation for disambiguation.

##### `addDomain<TName, TDomain>(name: TName, domainObject: TDomain): this`

Registers a domain with tools/methods. Returns `this` for chaining.

##### `respond(input: RespondInput<TContext>): Promise<RespondOutput>`

Generates an AI response based on conversation history with structured output including route, state, and tool call information.

```typescript
interface RespondInput<TContext> {
  history: Event[];
  state?: StateRef;
  contextOverride?: Partial<TContext>;
  signal?: AbortSignal;
}

interface RespondOutput {
  /** The message to send to the user */
  message: string;
  /** Route chosen by the agent (if applicable) */
  route?: { id: string; title: string };
  /** Current state within the route (if applicable) */
  state?: { id: string; description?: string };
  /** Tool calls requested by the agent */
  toolCalls?: Array<{
    toolName: string;
    arguments: Record<string, unknown>;
  }>;
}
```

**Enhanced Response Information:**

- Uses structured JSON output via `responses.parse()` API (OpenAI/OpenRouter) or JSON mode (Gemini)
- Automatically detects which route the agent chose based on conversation context
- Provides current state information for tracking conversation flow
- Returns tool calls for execution in your application

**Example:**

```typescript
const response = await agent.respond({
  history: conversationHistory,
});

// Save to database
await db.agentMessages.create({
  sessionId: session.id,
  role: "agent",
  content: response.message,
  route: response.route?.title,
  state: response.state?.description,
  toolCalls: response.toolCalls || [],
});

// Check if conversation is complete
if (response.route?.title === END_ROUTE) {
  await markSessionComplete(session.id);
}
```

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

interface RouteOptions {
  id?: string;              // Optional custom ID (deterministic ID generated from title if not provided)
  title: string;            // Route title
  description?: string;     // Route description
  conditions?: string[];    // Conditions that activate this route
  guidelines?: Guideline[]; // Initial guidelines for this route
}
```

**Note on IDs:** Route IDs are deterministic by default, generated from the title using a hash function. This ensures consistency across server restarts. You can provide a custom ID if you need specific control over the identifier.

#### Methods

##### `createGuideline(guideline: Guideline): this`

Adds a guideline specific to this route. Returns `this` for chaining.

##### `getGuidelines(): Guideline[]`

Returns all guidelines for this route.

##### `getRef(): RouteRef`

Returns a reference to this route.

##### `toRef(): RouteRef`

Returns a reference including the route instance (for disambiguation).

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
interface TransitionSpec {
  chatState?: string; // Transition to a chat interaction
  toolState?: ToolRef; // Transition to execute a tool
  state?: StateRef | symbol; // Transition to specific state or END_ROUTE
}

interface TransitionResult {
  id: string; // State identifier
  routeId: string; // Route identifier
  transitionTo: (spec: TransitionSpec, condition?: string) => TransitionResult;
}
```

**Returns:** A `TransitionResult` that includes the target state's reference (`id`, `routeId`) and a `transitionTo` method for chaining additional transitions.

**Example:**

```typescript
// Approach 1: Step-by-step (ideal for complex flows with branching)
const t0 = route.initialState.transitionTo({
  chatState: "Ask for user name",
});

const t1 = t0.transitionTo({
  chatState: "Ask for email",
});

const t2 = t1.transitionTo({
  chatState: "Confirm details",
});

// Access state properties
console.log(t1.id); // State ID
console.log(t1.routeId); // Route ID

// Use saved references for branching
t1.transitionTo(
  { chatState: "Handle invalid email" },
  "Email validation failed"
);

// Approach 2: Fluent chaining (elegant for linear flows)
route.initialState
  .transitionTo({ chatState: "Ask for user name" })
  .transitionTo({ chatState: "Ask for email" })
  .transitionTo({ chatState: "Confirm details" })
  .transitionTo({ state: END_ROUTE });

// Both approaches are equivalent - choose based on your needs:
// - Use step-by-step for complex flows with conditional branches
// - Use chaining for simple linear flows for conciseness
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

### `Observation`

Handles disambiguation between multiple routes.

#### Constructor

```typescript
new Observation(options: ObservationOptions)

interface ObservationOptions {
  id?: string;          // Optional custom ID (deterministic ID generated from description if not provided)
  description: string;  // The observation description
  routeRefs?: string[]; // Route IDs or titles to disambiguate between
}
```

**Note on IDs:** Observation IDs are deterministic by default, generated from the description using a hash function. This ensures consistency across server restarts.

#### Methods

##### `disambiguate(routes: (Route | RouteRef)[]): this`

Sets routes this observation can disambiguate between. Returns `this` for chaining.

##### `getRoutes(): RouteRef[]`

Returns routes associated with this observation.

#### Properties

##### `id: string`

Unique identifier (readonly).

##### `description: string`

Observation description (readonly).

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

##### `addObservations(observations): this`

Adds observations for disambiguation.

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

#### `generateObservationId(description: string): string`

Generates a deterministic observation ID from a description.

```typescript
import { generateObservationId } from "@falai/agent";

const obsId = generateObservationId("User intent is unclear");
// Returns: "observation_user_intent_is_unclear_{hash}"
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
  OBSERVATIONS = "observations",
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
