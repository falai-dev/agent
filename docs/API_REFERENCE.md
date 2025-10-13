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

Generates an AI response based on conversation history.

```typescript
interface RespondInput<TContext> {
  history: Event[];
  contextOverride?: Partial<TContext>;
}

interface RespondOutput {
  message: string;
  // ... additional fields
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
```

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

Creates a transition from this state.

```typescript
interface TransitionSpec {
  chatState?: string; // Transition to a chat interaction
  toolState?: ToolRef; // Transition to execute a tool
  state?: StateRef | symbol; // Transition to specific state or END_ROUTE
}
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
```

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
    description?: string;
    metadata?: Record<string, unknown>;
  }
): ToolRef<TContext, TArgs, TReturn>
```

**Example:**

```typescript
const getTool = defineTool<MyContext, [id: string], Data>(
  "get_data",
  async ({ context }, id) => {
    return { data: await fetchData(id) };
  },
  { description: "Fetches data by ID" }
);
```

---

### `createMessageEvent()`

Creates a message event for conversation history.

```typescript
createMessageEvent(
  source: EventSource,
  name: string,
  message: string
): Event
```

---

### `createToolEvent()`

Creates a tool execution event.

```typescript
createToolEvent(
  toolName: string,
  data: unknown
): Event
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
