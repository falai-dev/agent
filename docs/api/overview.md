# API Reference

Complete API documentation for `@falai/agent`. This framework provides a strongly-typed, modular agent architecture with AI-powered routing and schema-driven data collection.

## Table of Contents

- [Core Classes](#core-classes)
  - [Agent](#agent)
  - [ResponseModal](#responsemodal)
  - [Route](#route)
  - [Step](#step)
  - [RoutingEngine](#routingengine)
  - [ResponseEngine](#responseengine)
  - [PromptComposer](#promptcomposer)

- [AI Providers](#ai-providers)
- [Persistence Adapters](#persistence-adapters)
- [Types & Interfaces](#types--interfaces)
- [Utilities](#utilities)

---

## Core Classes

### Agent

The central orchestrator class that manages conversation flow, routing, tool execution, and agent-level data collection.

#### Constructor

```typescript
new Agent<TContext = unknown, TData = unknown>(options: AgentOptions<TContext, TData>)
```

#### Properties

- `name: string` - Agent display name
- `description?: string` - Detailed description
- `goal?: string` - Primary objective
- `context?: TContext` - Static context data
- `session?: SessionState` - Current session state

#### Methods

##### Route Management

```typescript
createRoute(options: RouteOptions<TContext, TData>): Route<TContext, TData>
```

Creates a new conversation route with required fields specification that references the agent-level schema.

##### Context Management

```typescript
updateContext(updates: Partial<TContext>): Promise<void>
```

Updates agent context and triggers lifecycle hooks.

```typescript
getContext(): Promise<TContext | undefined>
```

Gets current context, fetching from provider if configured.

##### Agent-Level Data Management

```typescript
getCollectedData(): Partial<TData>
```

Gets the current agent-level collected data.

```typescript
updateCollectedData(updates: Partial<TData>): Promise<void>
```

Updates agent-level collected data and triggers validation and lifecycle hooks.

```typescript
validateData(data: Partial<TData>): ValidationResult
```

Validates data against the agent-level schema, returning detailed validation results.

##### Response Generation

```typescript
respond(params: {
  history: Event[];
  session?: SessionState;
  contextOverride?: Partial<TContext>;
  signal?: AbortSignal;
}): Promise<{
  message: string;
  session?: SessionState;
  toolCalls?: ToolCall[];
  isRouteComplete?: boolean;
}>
```

Generates a single response based on conversation history.

```typescript
respondStream(params: {
  history: Event[];
  session?: SessionState;
  contextOverride?: Partial<TContext>;
  signal?: AbortSignal;
}): AsyncGenerator<{
  delta: string;
  accumulated: string;
  done: boolean;
  session?: SessionState;
  toolCalls?: ToolCall[];
  isRouteComplete?: boolean;
}>
```

Generates a streaming response with real-time updates. **Note:** Now delegates to internal ResponseModal class.

```typescript
stream(message?: string, options?: StreamOptions<TContext>): AsyncGenerator<AgentResponseStreamChunk<TData>>
```

**NEW:** Modern streaming API with automatic session management. Recommended for new implementations.

```typescript
// Simple streaming
for await (const chunk of agent.stream("Hello")) {
  console.log(chunk.delta);
}
```

##### Tool Management

```typescript
addTool(definition: Tool<TContext, TData, TResult>): this
tool: ToolManager<TContext, TData> // Access to ToolManager instance
```

**Comprehensive Tool Examples:**

```typescript
// 1. Simple return value (most common)
agent.addTool({
  id: "calculate_tip",
  description: "Calculate tip amount",
  handler: async ({ context, data }, args) => {
    const tip = args.amount * args.percentage;
    return `Tip: $${tip.toFixed(2)}`; // Simple string return
  }
});

// 2. Complex ToolResult pattern
agent.addTool({
  id: "process_order",
  description: "Process customer order",
  handler: async ({ context, data }, args) => {
    const order = await orderService.process(args.items);
    return {
      data: `Order ${order.id} processed successfully`,
      success: true,
      contextUpdate: { lastOrderId: order.id },
      dataUpdate: { orderStatus: 'processed' }
    }; // Detailed ToolResult object
  }
});

// 3. Registry for reuse
agent.tool.register({
  id: "send_notification",
  description: "Send notification to user",
  handler: async ({ context }, args) => {
    await notificationService.send(context.userId, args.message);
    return "Notification sent"; // Simple return
  }
});

// 4. Pattern helper
const validationTool = agent.tool.createValidation({
  id: "validate_email",
  fields: ['email'],
  validator: async (context, data) => ({
    valid: /\S+@\S+\.\S+/.test(data.email),
    errors: []
  })
});
agent.tool.register(validationTool);
```

##### Domain Knowledge

```typescript
createTerm(term: Term<TContext>): this
createGuideline(guideline: Guideline<TContext>): this
getTerms(): Term<TContext>[]
getGuidelines(): Guideline<TContext>[]
getKnowledgeBase(): Record<string, unknown>
```

##### Session Management

```typescript
setCurrentSession(session: SessionState): void
getCurrentSession(): SessionState | undefined
clearCurrentSession(): void
getData<TData = unknown>(routeId?: string): Partial<TData>
```

##### Route Transitions

```typescript
nextStepRoute(
  routeIdOrTitle: string,
  session?: SessionState,
  condition?: Template<TContext, unknown>,
  history?: Event[]
): Promise<SessionState>
```

Manually transitions to a different route.

##### Persistence

```typescript
getPersistenceManager(): PersistenceManager | undefined
hasPersistence(): boolean
```

---

### ResponseModal

**NEW:** Internal class that centralizes all response generation logic for improved architecture and maintainability.

#### Constructor

```typescript
new ResponseModal<TContext = unknown, TData = unknown>(
  agent: Agent<TContext, TData>,
  options?: ResponseModalOptions
)
```

#### Methods

##### Modern APIs (Recommended)

```typescript
stream(message?: string, options?: StreamOptions<TContext>): AsyncGenerator<AgentResponseStreamChunk<TData>>
generate(message?: string, options?: GenerateOptions<TContext>): Promise<AgentResponse<TData>>
```

Modern streaming and non-streaming APIs with automatic session management.

##### Legacy APIs (Backward Compatible)

```typescript
respond(params: RespondParams<TContext, TData>): Promise<AgentResponse<TData>>
respondStream(params: RespondParams<TContext, TData>): AsyncGenerator<AgentResponseStreamChunk<TData>>
```

Legacy APIs that maintain full backward compatibility with existing code.

##### Error Handling

```typescript
ResponseGenerationError: Error class for response-specific errors
```

Comprehensive error handling with detailed context and phase information.

#### Key Features

- **Unified Logic**: Both streaming and non-streaming use the same underlying logic
- **Modern APIs**: Simple `stream()` and `generate()` methods for new code
- **Backward Compatibility**: Existing `respond()` and `respondStream()` methods work unchanged
- **Error Handling**: Detailed error context with phase and original error information
- **Performance**: Optimized response pipeline with minimal code duplication

---

### Route

Represents a conversational journey with required fields specification and steps that collect data into the agent-level schema.

#### Constructor

```typescript
new Route<TContext = unknown, TData = unknown>(options: RouteOptions<TContext, TData>)
```

#### Properties

- `id: string` - Unique route identifier
- `title: string` - Human-readable title
- `description?: string` - Detailed description
- `identity?: Template<TContext, TData>` - Route-specific identity
- `personality?: Template<TContext, TData>` - Route-specific personality
- `initialStep: Step<TContext, TData>` - Entry point for the route

#### Methods

##### Step Management

```typescript
createStep(options: StepOptions<TContext, TData>): Step<TContext, TData>
getStep(stepId: string): Step<TContext, TData> | undefined
getAllSteps(): Step<TContext, TData>[]
```

##### Route Completion Logic

```typescript
isComplete(data: Partial<TData>): boolean
```

Checks if the route is complete based on agent-level data.

```typescript
getMissingRequiredFields(data: Partial<TData>): (keyof TData)[]
```

Returns the fields still needed for route completion.

```typescript
getCompletionProgress(data: Partial<TData>): number
```

Returns completion progress as a number between 0 and 1.

##### Data Collection

```typescript
getRules(): Template<TContext, TData>[]
getProhibitions(): Template<TContext, TData>[]
getTerms(): Term<TContext>[]
getKnowledgeBase(): Record<string, unknown>
```

##### Schema & Validation

```typescript
getResponseOutputSchema(): StructuredSchema | undefined
getRoutingExtrasSchema(): StructuredSchema | undefined
```

##### Tool Management

```typescript
addTool(definition: Tool<TContext, TData, TResult>): this
```

##### Lifecycle Hooks

```typescript
handleDataUpdate(data: Partial<TData>, previousData: Partial<TData>): Promise<Partial<TData>>
handleContextUpdate(newContext: TContext, previousContext: TContext): Promise<void>
evaluateOnComplete(session: { data?: Partial<TData> }, context?: TContext): Promise<RouteTransitionConfig | undefined>
```

---

### Step

Represents an individual conversation state within a route.

#### Constructor

```typescript
new Step<TContext = unknown, TData = unknown>(routeId: string, options?: StepOptions<TContext, TData>)
```

#### Properties

- `id: string` - Unique step identifier
- `routeId: string` - Parent route identifier
- `description?: string` - Human-readable description
- `collect?: string[]` - Fields to extract from AI responses
- `requires?: string[]` - Required data fields
- `prompt?: Template<TContext, TData>` - Step-specific prompt
- `tools?: (string | Tool)[]` - Step-specific tools

#### Methods

##### Configuration

```typescript
configure(config: Partial<StepOptions<TContext, TData>>): this
```

##### Transitions

```typescript
nextStep(spec: StepOptions<TContext, TData>): StepResult<TContext, TData>
branch(branches: BranchSpec<TContext, TData>[]): BranchResult<TContext, TData>
endRoute(options?: Omit<StepOptions<TContext, TData>, 'step'>): StepResult<TContext, TData>
```

##### Validation

```typescript
shouldSkip(data: Partial<TData>): boolean
hasRequires(data: Partial<TData>): boolean
```

##### Tool Management

```typescript
addGuideline(guideline: Guideline<TContext>): void
getGuidelines(): Guideline<TContext>[]
getTransitions(): Step<TContext, TData>[]
```

##### References

```typescript
getRef(): StepRef
```

---

### StepResult

Result interface returned by step transition methods that enables fluent chaining of conversation flows.

#### Interface

```typescript
interface StepResult<TContext = unknown, TData = unknown> extends StepRef {
  nextStep: (spec: StepOptions<TContext, TData>) => StepResult<TContext, TData>;
  branch: (branches: BranchSpec<TContext, TData>[]) => BranchResult<TContext, TData>;
  endRoute: (options?: Omit<StepOptions<TContext, TData>, "step">) => StepResult<TContext, TData>;
}
```

#### Methods

##### Chaining

```typescript
nextStep(spec: StepOptions<TContext, TData>): StepResult<TContext, TData>
```

Creates a transition and returns a chainable result for building linear flows.

##### Branching

```typescript
branch(branches: BranchSpec<TContext, TData>[]): BranchResult<TContext, TData>
```

Creates multiple conditional branches for complex conversation flows.

##### Route Completion

```typescript
endRoute(options?: Omit<StepOptions<TContext, TData>, "step">): StepResult<TContext, TData>
```

Shortcut method to end the current route with optional completion configuration.

#### Properties

Inherits from `StepRef`:

- `id: string` - Step identifier
- `routeId: string` - Route this step belongs to

---

### RoutingEngine

AI-powered routing system that intelligently selects routes and steps based on conversation context.

#### Constructor

```typescript
new RoutingEngine(options?: RoutingEngineOptions)
```

#### Methods

##### Route Selection

```typescript
decideRouteAndStep(params: {
  routes: Route[];
  session: SessionState;
  history: Event[];
  agentOptions?: AgentOptions;
  provider: AiProvider;
  context: unknown;
  signal?: AbortSignal;
}): Promise<{
  selectedRoute?: Route;
  selectedStep?: Step;
  responseDirectives?: string[];
  session: SessionState;
  isRouteComplete?: boolean;
}>
```

##### Single Route Optimization

```typescript
decideSingleRouteStep(params: {
  route: Route;
  session: SessionState;
  history: Event[];
  agentOptions?: AgentOptions;
  provider: AiProvider;
  context: unknown;
  signal?: AbortSignal;
}): Promise<{
  selectedRoute?: Route;
  selectedStep?: Step;
  responseDirectives?: string[];
  session: SessionState;
  isRouteComplete?: boolean;
}>
```

##### Candidate Discovery

```typescript
getCandidateSteps<TData>(
  route: Route,
  currentStep: Step | undefined,
  data: Partial<TData>
): CandidateStep[]
```

##### Prompt Generation

```typescript
buildRoutingPrompt(params: BuildRoutingPromptParams): Promise<string>
buildStepSelectionPrompt(params: BuildStepSelectionPromptParams): Promise<string>
```

---

### ResponseEngine

Handles prompt composition and response schema generation for AI interactions.

#### Methods

##### Schema Generation

```typescript
responseSchemaForRoute(route: Route, currentStep?: Step): StructuredSchema
```

##### Prompt Building

```typescript
buildResponsePrompt(params: BuildResponsePromptParams): Promise<string>
buildFallbackPrompt(params: BuildFallbackPromptParams): Promise<string>
```

---

### PromptComposer

Utility for composing structured prompts with agent metadata, knowledge, and context.

#### Constructor

```typescript
new PromptComposer<TContext = unknown, TData = unknown>(context?: TemplateContext<TContext, TData>)
```

#### Methods

##### Metadata Addition

```typescript
addAgentMeta(agent: AgentOptions): Promise<this>
addGlossary(terms: Term[]): Promise<this>
addGuidelines(guidelines: Guideline[]): Promise<this>
addKnowledgeBase(agentKb?: Record<string, unknown>, routeKb?: Record<string, unknown>): Promise<this>
```

##### Content Addition

```typescript
addInstruction(text: string): Promise<this>
addInteractionHistory(history: Event[], note?: string): Promise<this>
addLastMessage(message: string): Promise<this>
addRoutingOverview(routes: Route[]): Promise<this>
addDirectives(directives?: string[]): Promise<this>
```

##### Finalization

```typescript
build(): Promise<string>
```



---

## AI Providers

### OpenAIProvider

```typescript
new OpenAIProvider(options: OpenAIProviderOptions)

generateMessage(input: GenerateMessageInput): Promise<GenerateMessageOutput>
generateMessageStream(input: GenerateMessageInput): AsyncGenerator<GenerateMessageStreamChunk>
```

### GeminiProvider

```typescript
new GeminiProvider(options: GeminiProviderOptions)

generateMessage(input: GenerateMessageInput): Promise<GenerateMessageOutput>
generateMessageStream(input: GenerateMessageInput): AsyncGenerator<GenerateMessageStreamChunk>
```

### AnthropicProvider

```typescript
new AnthropicProvider(options: AnthropicProviderOptions)

generateMessage(input: GenerateMessageInput): Promise<GenerateMessageOutput>
generateMessageStream(input: GenerateMessageInput): AsyncGenerator<GenerateMessageStreamChunk>
```

### OpenRouterProvider

```typescript
new OpenRouterProvider(options: OpenRouterProviderOptions)

generateMessage(input: GenerateMessageInput): Promise<GenerateMessageOutput>
generateMessageStream(input: GenerateMessageInput): AsyncGenerator<GenerateMessageStreamChunk>
```

---

## Persistence Adapters

### PrismaAdapter

```typescript
new PrismaAdapter(options: {
  prisma: PrismaClient;
  tables?: { sessions?: string; messages?: string };
  fieldMappings?: FieldMappings;
})

sessionRepository: SessionRepository
messageRepository: MessageRepository
```

### RedisAdapter

```typescript
new RedisAdapter(options: {
  redis: Redis;
  keyPrefix?: string;
  sessionTTL?: number;
  messageTTL?: number;
})

sessionRepository: SessionRepository
messageRepository: MessageRepository
```

### MongoAdapter

```typescript
new MongoAdapter(options: {
  client: MongoClient;
  databaseName: string;
  collections?: { sessions?: string; messages?: string };
})

sessionRepository: SessionRepository
messageRepository: MessageRepository
```

### PostgreSQLAdapter

```typescript
new PostgreSQLAdapter(options: {
  client: Client;
  tables?: { sessions?: string; messages?: string };
})

sessionRepository: SessionRepository
messageRepository: MessageRepository

initialize(): Promise<void>  // Auto-create tables
```

### SQLiteAdapter

```typescript
new SQLiteAdapter(options: { db: Database })

sessionRepository: SessionRepository
messageRepository: MessageRepository

initialize(): Promise<void>  // Auto-create tables
```

### OpenSearchAdapter

```typescript
new OpenSearchAdapter(client: Client, options: {
  indices?: { sessions?: string; messages?: string };
  autoCreateIndices?: boolean;
  refresh?: string;
})

sessionRepository: SessionRepository
messageRepository: MessageRepository
```

### MemoryAdapter

```typescript
new MemoryAdapter()

sessionRepository: SessionRepository
messageRepository: MessageRepository

clear(): void
getSnapshot(): { sessions: SessionData[]; messages: MessageData[] }
```

---

## Types & Interfaces

### Core Types

```typescript
interface AgentOptions<TContext = unknown, TData = unknown> {
  name: string;
  provider: AiProvider;
  description?: string;
  goal?: string;
  personality?: Template<TContext, TData>;
  identity?: Template<TContext, TData>;
  context?: TContext;
  contextProvider?: ContextProvider<TContext>;
  
  // NEW: Agent-level data schema and initial data
  schema?: StructuredSchema;
  initialData?: Partial<TData>;
  
  hooks?: ContextLifecycleHooks<TContext, TData>;
  debug?: boolean;
  session?: SessionState;
  persistence?: PersistenceConfig;
  terms?: Term<TContext>[];
  guidelines?: Guideline<TContext>[];
  tools?: Tool<TContext, unknown[], unknown, TData>[];
  routes?: RouteOptions<TContext, TData>[];
  knowledgeBase?: Record<string, unknown>;
}

interface RouteOptions<TContext = unknown, TData = unknown> {
  id?: string;
  title: string;
  description?: string;
  identity?: Template<TContext, TData>;
  personality?: Template<TContext, TData>;
  when?: ConditionTemplate<TContext, TData>;
  skipIf?: ConditionTemplate<TContext, TData>;
  rules?: Template<TContext, TData>[];
  prohibitions?: Template<TContext, TData>[];
  
  // NEW: Required fields for route completion (replaces schema)
  requiredFields?: (keyof TData)[];
  optionalFields?: (keyof TData)[];
  
  // REMOVED: schema (now at agent level)
  // schema?: StructuredSchema;
  
  initialData?: Partial<TData>;
  steps?: StepOptions<TContext, TData>[];
  initialStep?: Omit<StepOptions<TContext, TData>, "step">;
  endStep?: Omit<StepOptions<TContext, TData>, "step" | "condition" | "skipIf">;
  onComplete?: string | RouteTransitionConfig | RouteCompletionHandler;
  hooks?: RouteLifecycleHooks<TContext, TData>;
  guidelines?: Guideline<TContext>[];
  terms?: Term<TContext>[];
  tools?: Tool<TContext, unknown[], unknown, TData>[];
  knowledgeBase?: Record<string, unknown>;
}

interface StepOptions<TContext = unknown, TData = unknown> {
  id?: string;
  description?: string;
  prompt?: Template<TContext, TData>;
  collect?: string[];
  skipIf?: (data: Partial<TData>) => boolean;
  requires?: string[];
  when?: Template<TContext, TData>;
  prepare?: string | Tool<TContext, unknown[], unknown, TData> | ((
    context: TContext,
    data?: Partial<TData>
  ) => void | Promise<void>);
  finalize?: string | Tool<TContext, unknown[], unknown, TData> | ((
    context: TContext,
    data?: Partial<TData>
  ) => void | Promise<void>);
  tools?: (string | Tool<TContext, unknown[], unknown, TData>)[];
}

interface StepResult<TContext = unknown, TData = unknown> extends StepRef {
  nextStep: (spec: StepOptions<TContext, TData>) => StepResult<TContext, TData>;
  branch: (branches: BranchSpec<TContext, TData>[]) => BranchResult<TContext, TData>;
  endRoute: (options?: Omit<StepOptions<TContext, TData>, "step">) => StepResult<TContext, TData>;
}

interface BranchResult<TContext = unknown, TData = unknown> {
  [branchName: string]: StepResult<TContext, TData>;
}

interface BranchSpec<TContext = unknown, TData = unknown> {
  name: string;
  id?: string;
  step: StepOptions<TContext, TData>;
}

interface StepRef {
  id: string;
  routeId: string;
}

interface RouteRef {
  id: string;
}

// ==============================================================================
// LIFECYCLE HOOKS: prepare & finalize
// ==============================================================================

/**
 * Step lifecycle hooks allow you to execute custom logic before and after AI responses.
 * Both prepare and finalize can be functions, tool references, or inline tool definitions.
 */

// Example: Using functions (traditional approach)
{
  prepare: (context, data) => {
    console.log("Preparing step execution...");
  },
  finalize: (context, data) => {
    console.log("Finalizing step execution...");
  }
}

// Example: Using existing tools (unified Tool interface)
{
  prepare: "validate_user_data",  // Tool ID string - simple return value
  finalize: "send_notification",  // Tool ID string - ToolResult pattern
}

// Example: Inline tool definition with flexible returns
{
  prepare: {
    id: "setup_step_context",
    description: "Prepare context for this step",
    parameters: { type: "object", properties: {} },
    handler: ({ context, data }) => {
      // Simple return value
      return "Setup complete";
    }
  },
  finalize: {
    id: "cleanup_step_context", 
    description: "Clean up after step completion",
    handler: ({ context, data }) => {
      // Complex ToolResult pattern
      return {
        data: "Cleanup complete",
        success: true,
        contextUpdate: { lastCleanup: new Date() }
      };
    }
  }
}
```

### Session Types

```typescript
interface SessionState<TData = unknown> {
  id?: string;
  data: Partial<TData>;
  dataByRoute: Record<string, Partial<TData>>;
  routeHistory: RouteHistoryEntry[];
  currentRoute?: RouteRef;
  currentStep?: StepRef;
  metadata?: SessionMetadata;
}

interface SessionData {
  id: string;
  userId?: string;
  agentName?: string;
  status: SessionStatus;
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

### Tool Types

```typescript
interface Tool<TContext, TArgs extends unknown[], TResult, TData> {
  id: string;
  description: string;
  parameters: StructuredSchema;
  execute: ToolHandler<TContext, TArgs, TResult, TData>;
}

type ToolHandler<TContext, TArgs extends unknown[], TResult, TData> = (
  args: TArgs[0],
  context: {
    context: TContext;
    data: Partial<TData>;
  }
) => Promise<{
  data: unknown;
  contextUpdate?: Partial<TContext>;
  dataUpdate?: Partial<TData>;
}>;
```

### AI Provider Types

```typescript
interface AiProvider {
  name: string;
  generateMessage(input: GenerateMessageInput): Promise<GenerateMessageOutput>;
  generateMessageStream(
    input: GenerateMessageInput
  ): AsyncGenerator<GenerateMessageStreamChunk>;
}

interface GenerateMessageInput<TContext = unknown> {
  prompt: string;
  history: Event[];
  context?: TContext;
  tools?: ToolDefinition[];
  parameters?: {
    jsonSchema?: StructuredSchema;
    schemaName?: string;
    maxOutputTokens?: number;
    reasoning?: { effort: "low" | "medium" | "high" };
  };
  signal?: AbortSignal;
}
```

---

## Utilities

### Session Utilities

```typescript
createSession<TData = unknown>(initialData?: {
  data?: Partial<TData>;
  metadata?: SessionMetadata;
}): SessionState<TData>

enterRoute<TData>(
  session: SessionState<TData>,
  routeId: string,
  routeTitle: string
): SessionState<TData>

enterStep<TData>(
  session: SessionState<TData>,
  stepId: string,
  stepDescription?: string
): SessionState<TData>

mergeCollected<TData>(
  session: SessionState<TData>,
  data: Partial<TData>
): SessionState<TData>
```

### Template Utilities

```typescript
render<TContext, TData>(
  template: Template<TContext, TData> | undefined,
  params: TemplateContext<TContext, TData>
): Promise<string>

renderMany<TContext, TData>(
  templates: Template<TContext, TData>[] | undefined,
  params: TemplateContext<TContext, TData>
): Promise<string[]>

formatKnowledgeBase(
  data: Record<string, unknown>,
  title?: string,
  maxDepth?: number
): string
```

### ID Generators

```typescript
generateRouteId(title: string): string
generateStepId(routeId: string, description?: string): string
generateToolId(name: string): string
```

## Agent-Level Data Collection Example

Here's a comprehensive example showing the new agent-level data collection architecture:

```typescript
import { Agent, OpenAIProvider } from "@falai/agent";

// Define comprehensive agent-level data interface
interface CustomerServiceData {
  // Customer identification
  customerId?: string;
  customerName?: string;
  email?: string;
  phone?: string;
  
  // Issue tracking
  issueType?: 'booking' | 'billing' | 'technical' | 'other';
  issueDescription?: string;
  priority?: 'low' | 'medium' | 'high';
  
  // Feedback
  rating?: number;
  comments?: string;
  recommendToFriend?: boolean;
}

// Create agent with centralized schema
const agent = new Agent<{}, CustomerServiceData>({
  name: "Customer Service Agent",
  provider: new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY, model: "gpt-4" }),
  
  // Agent-level schema defines all possible data fields
  schema: {
    type: "object",
    properties: {
      customerId: { type: "string" },
      customerName: { type: "string" },
      email: { type: "string", format: "email" },
      phone: { type: "string" },
      issueType: { type: "string", enum: ["booking", "billing", "technical", "other"] },
      issueDescription: { type: "string" },
      priority: { type: "string", enum: ["low", "medium", "high"] },
      rating: { type: "number", minimum: 1, maximum: 5 },
      comments: { type: "string" },
      recommendToFriend: { type: "boolean" }
    }
  },
  
  // Agent-level data validation and enrichment
  hooks: {
    onDataUpdate: async (data, previousData) => {
      // Auto-set priority based on issue type
      if (data.issueType === 'billing' && !data.priority) {
        data.priority = 'high';
      }
      
      // Enrich customer data
      if (data.customerName && !data.customerId) {
        data.customerId = await lookupCustomerId(data.customerName);
      }
      
      return data;
    }
  }
});

// Routes specify required fields instead of schemas
const supportRoute = agent.createRoute({
  title: "Customer Support",
  requiredFields: ["customerName", "email", "issueType", "issueDescription"],
  optionalFields: ["phone", "priority"],
  
  initialStep: {
    prompt: "I'm here to help with your issue. Can you tell me your name and email?",
    collect: ["customerName", "email"]
  }
});

const feedbackRoute = agent.createRoute({
  title: "Feedback Collection",
  requiredFields: ["customerName", "email", "rating"],
  optionalFields: ["comments", "recommendToFriend"],
  
  initialStep: {
    prompt: "I'd love to get your feedback. What's your name and email?",
    collect: ["customerName", "email"]
  }
});

// Cross-route data sharing example
const response1 = await agent.respond("Hi, I'm John Doe, email john@example.com, I have a billing issue");
// Agent data: { customerName: "John Doe", email: "john@example.com", issueType: "billing" }

const response2 = await agent.respond("Actually, I want to leave feedback instead. I'd rate you 5 stars.");
// Feedback route completes immediately: already has name, email, and now rating
// { customerName: "John Doe", email: "john@example.com", rating: 5 }

// Check route completion
console.log(feedbackRoute.isComplete(agent.getCollectedData())); // true
console.log(feedbackRoute.getCompletionProgress(agent.getCollectedData())); // 1.0
```

This API reference covers the complete @falai/agent framework. For more detailed examples and usage patterns, see the [examples directory](../../examples/) and [guides](../../docs/guides/).
