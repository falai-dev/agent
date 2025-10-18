# Tools

Tools in `@falai/agent` provide a way for your agent to execute custom logic, access external APIs, perform calculations, or modify context during conversation flow. Tools are designed to **enrich context before AI response generation**, enabling more intelligent and context-aware conversations.

## Design Philosophy

### Pre-Response Execution

Tools execute **before** the AI generates its response, not after. This allows tools to:

- **Enrich Context**: Add relevant data to the conversation context
- **Update Session Data**: Modify collected data based on tool results
- **Perform Actions**: Execute business logic, API calls, or computations
- **Enable Intelligence**: Provide the AI with up-to-date information for better responses

### Two Data Collection Mechanisms

The framework provides two parallel data collection mechanisms:

1. **Declarative Collection** (AI-driven): Fields specified in step `collect` arrays
2. **Imperative Collection** (Tool-driven): Data returned by tool execution

This design allows flexible data gathering - some data comes from user input via AI extraction, while other data comes from tool execution.

## Tool Lifecycle

```
1. User Input → 2. Route/Step Selection → 3. Tool Execution → 4. AI Response → 5. Data Extraction
```

### 1. User Input

User provides input through conversation.

### 2. Route/Step Selection

Routing engine determines which route and step to execute.

### 3. Tool Execution (Pre-Response)

If the current step has a `tool` property, it's executed before AI response generation:

```typescript
// Example: Flight search tool
const searchFlights = defineTool({
  name: "search_flights",
  handler: async ({ context, data }) => {
    const flights = await flightAPI.search({
      from: data.departure,
      to: data.destination,
      date: data.date,
    });

    return {
      data: { flightResults: flights },
      contextUpdate: { availableFlights: flights },
      collectedUpdate: { availableFlights: flights },
    };
  },
});
```

### 4. AI Response Generation

AI generates response using enriched context from tool execution.

### 5. Declarative Data Extraction

AI extracts additional data based on step `collect` fields.

## Tool Definition

### Basic Tool

```typescript
import { defineTool } from "@falai/agent";

const getWeather = defineTool({
  name: "get_weather",
  description: "Get current weather for a location",
  handler: async ({ context, data, history }) => {
    const weather = await weatherAPI.get(data.location);
    return {
      data: weather,
      contextUpdate: { currentWeather: weather },
    };
  },
});
```

### Advanced Tool with Parameters

```typescript
const calculateTotal = defineTool({
  name: "calculate_total",
  description: "Calculate order total with tax and shipping",
  parameters: {
    type: "object",
    properties: {
      items: { type: "array" },
      taxRate: { type: "number" },
      shipping: { type: "number" },
    },
  },
  handler: async ({ context }, { items, taxRate, shipping }) => {
    const subtotal = items.reduce((sum, item) => sum + item.price, 0);
    const tax = subtotal * taxRate;
    const total = subtotal + tax + shipping;

    return {
      data: { subtotal, tax, total },
      collectedUpdate: { orderTotal: total },
    };
  },
});
```

## Tool Context

Tools receive a `ToolContext` object with runtime information:

```typescript
interface ToolContext<TContext, TData> {
  context: TContext; // Agent context
  updateContext: (updates: Partial<TContext>) => Promise<void>; // Update context
  history: Event[]; // Conversation history
  data: Partial<TData>; // Current collected data
}
```

## Tool Results

Tools return a `ToolResult` object:

```typescript
interface ToolResult {
  toolName: string;
  success: boolean;
  data?: unknown; // Tool execution result data
  contextUpdate?: Record<string, unknown>; // Context modifications
  collectedUpdate?: Record<string, unknown>; // Session data modifications
  error?: string;
}
```

### Result Properties

- **`data`**: The primary result of tool execution
- **`contextUpdate`**: Modifications to agent context (persists across conversation)
- **`collectedUpdate`**: Modifications to session collected data (route-specific)

## Tool Security

### Domain Enforcement

Tools are automatically tagged with their domain name for security enforcement:

```typescript
agent.addDomain("payment", {
  processPayment: defineTool({...}),
  refundPayment: defineTool({...})
});

// Tools are tagged with domainName: "payment"
```

When executing tools, the framework checks if the tool's domain is allowed in the current route:

```typescript
// Route with domain restrictions
const checkoutRoute = agent.createRoute({
  title: "Checkout",
  domains: ["payment", "shipping"], // Only these domains allowed
});
```

### Domain Security Violation

```typescript
// This will throw an error
agent.addDomain("unauthorized", {
  hackSystem: defineTool({...})
});

// If tool executed in restricted route:
// Error: Domain security violation: Tool "hackSystem" belongs to domain
// "unauthorized" which is not allowed in this route. Allowed domains: [payment, shipping]
```

## Tool Execution Flow

### Single Tool Execution

```typescript
const result = await toolExecutor.executeTool({
  tool: myTool,
  context: agentContext,
  updateContext: agent.updateContext.bind(agent),
  history: conversationHistory,
  data: session.data,
  allowedDomains: route.getDomains(),
});
```

### Sequential Tool Execution

```typescript
const results = await toolExecutor.executeTools({
  tools: [tool1, tool2, tool3],
  context: agentContext,
  updateContext: agent.updateContext.bind(agent),
  history: conversationHistory,
  data: session.data,
  allowedDomains: route.getDomains(),
});

// Stops on first failure
```

## Integration Patterns

### Data Enrichment

```typescript
const enrichUserData = defineTool({
  name: "enrich_user_profile",
  handler: async ({ data }) => {
    const enriched = await userAPI.enrich(data.userId);
    return {
      contextUpdate: { userProfile: enriched },
      collectedUpdate: { enrichedProfile: enriched },
    };
  },
});
```

### External API Integration

```typescript
const searchProducts = defineTool({
  name: "search_products",
  handler: async ({ data }) => {
    const products = await productAPI.search(data.query);
    return {
      data: products,
      contextUpdate: { searchResults: products },
    };
  },
});
```

### Context Modification

```typescript
const updatePreferences = defineTool({
  name: "update_user_preferences",
  handler: async ({ context, updateContext }, { preferences }) => {
    await userAPI.updatePreferences(context.userId, preferences);
    await updateContext({ userPreferences: preferences });
    return {
      data: { success: true },
    };
  },
});
```

## Best Practices

### 1. Idempotent Operations

Design tools to be safe for re-execution.

### 2. Error Handling

Tools should handle errors gracefully and return meaningful error messages.

### 3. Domain Organization

Group related tools into domains for better organization and security.

### 4. Context vs Data

Use `contextUpdate` for persistent changes, `collectedUpdate` for session-specific data.

### 5. Tool Naming

Use descriptive, action-oriented names (e.g., `search_flights`, `calculate_total`).

### 6. Parameter Validation

Validate tool parameters before execution.

## Error Handling

Tools that fail return an error result:

```typescript
{
  toolName: "failed_tool",
  success: false,
  error: "Connection timeout",
  data: undefined
}
```

Sequential tool execution stops on the first failure, preventing cascading errors.

## Tool Registration

Register tools through domains:

```typescript
agent.addDomain("utilities", {
  calculator: calculateTool,
  formatter: formatTool,
});

// Access via: agent.domain.utilities.calculator
```

This provides a clean, organized way to access tools and enables domain-based security enforcement.
