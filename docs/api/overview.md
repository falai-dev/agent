# API Reference

Complete API documentation for `@falai/agent`. This framework provides a strongly-typed, modular agent architecture with AI-powered routing and schema-driven data collection.

## Table of Contents

- [Core Classes](#core-classes)
  - [Agent](#agent)
  - [Route](#route)
  - [Step](#step)
  - [RoutingEngine](#routingengine)
  - [ResponseEngine](#responseengine)
  - [PromptComposer](#promptcomposer)
  - [ToolExecutor](#toolexecutor)
- [AI Providers](#ai-providers)
- [Persistence Adapters](#persistence-adapters)
- [Types & Interfaces](#types--interfaces)
- [Utilities](#utilities)

---

## Core Classes

### Agent

The central orchestrator class that manages conversation flow, routing, and tool execution.

#### Constructor

```typescript
new Agent<TContext = unknown>(options: AgentOptions<TContext>)
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
createRoute<TData = unknown>(options: RouteOptions<TContext, TData>): Route<TContext, TData>
```

Creates a new conversation route with the specified options.

##### Context Management

```typescript
updateContext(updates: Partial<TContext>): Promise<void>
```

Updates agent context and triggers lifecycle hooks.

```typescript
getContext(): Promise<TContext | undefined>
```

Gets current context, fetching from provider if configured.

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

Generates a streaming response with real-time updates.

##### Tool Management

```typescript
createTool(tool: Tool<TContext, unknown[], unknown, unknown>): this
registerTools(tools: Tool<TContext, unknown[], unknown, unknown>[]): this
getTools(): Tool<TContext, unknown[], unknown, unknown>[]
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

### Route

Represents a conversational journey with structured steps and data collection.

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
createTool(tool: Tool<TContext, unknown[], unknown, TData>): this
registerTools(tools: Tool<TContext, unknown[], unknown, TData>[]): this
getTools(): Tool<TContext, unknown[], unknown, TData>[]
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
asStepResult(): StepResult<TContext, TData>
```

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

### ToolExecutor

Handles tool execution with context updates and data collection.

#### Methods

```typescript
executeTool(params: {
  tool: Tool;
  context: unknown;
  updateContext: (updates: Partial<unknown>) => Promise<void>;
  history: Event[];
  data: unknown;
}): Promise<ToolExecutionResult>
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
interface AgentOptions<TContext = unknown> {
  name: string;
  provider: AiProvider;
  description?: string;
  goal?: string;
  personality?: Template<TContext>;
  identity?: Template<TContext>;
  context?: TContext;
  contextProvider?: ContextProvider<TContext>;
  hooks?: ContextLifecycleHooks<TContext>;
  debug?: boolean;
  session?: SessionState;
  persistence?: PersistenceConfig;
  terms?: Term<TContext>[];
  guidelines?: Guideline<TContext>[];
  tools?: Tool<TContext, unknown[], unknown, unknown>[];
  routes?: RouteOptions<TContext, unknown>[];
  knowledgeBase?: Record<string, unknown>;
}

interface RouteOptions<TContext = unknown, TData = unknown> {
  id?: string;
  title: string;
  description?: string;
  identity?: Template<TContext, TData>;
  personality?: Template<TContext, TData>;
  conditions?: Template<TContext, TData>[];
  rules?: Template<TContext, TData>[];
  prohibitions?: Template<TContext, TData>[];
  schema?: StructuredSchema;
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

// Example: Using existing tools (new approach)
{
  prepare: "validate_user_data",  // Tool ID string
  finalize: myCustomTool,         // Tool object
}

// Example: Inline tool definition
{
  prepare: {
    id: "setup_step_context",
    description: "Prepare context for this step",
    parameters: { type: "object", properties: {} },
    handler: ({ context, data }) => {
      // Custom logic here
      return { data: "Setup complete" };
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

This API reference covers the complete @falai/agent framework. For more detailed examples and usage patterns, see the [examples directory](../../examples/) and [guides](../../docs/guides/).
