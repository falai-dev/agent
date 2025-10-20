# Dynamic Tool Execution

@falai/agent provides a sophisticated tool execution system that enables AI agents to perform actions, access external data, and modify context dynamically during conversations. Unlike static tool calling, this system supports intelligent tool selection, context updates, and seamless integration with conversation flows.

## Overview

The tool execution system provides:

- **Dynamic Tool Calling**: AI selects and executes tools based on conversation context
- **Context Modification**: Tools can update agent context and collected data
- **Streaming Execution**: Tools work with both streaming and non-streaming responses
- **Error Recovery**: Robust handling of tool execution failures
- **Multi-Step Tools**: Support for complex tool interaction patterns

## Tool Definition

### Basic Tool Structure

```typescript
interface Tool<TContext, TData, TArgs extends unknown[], TResult> {
  id: string;
  name?: string; // Human-readable name shown to AI models
  description: string;
  parameters: StructuredSchema; // JSON Schema for tool arguments
  handler: ToolHandler<TContext, TArgs, TResult, TData>;
}
```

### Creating Tools

```typescript
import { Tool } from "@falai/agent";

// Simple data retrieval tool
const getWeather: Tool<unknown, WeatherData, [], string> = {
  id: "get_weather",
  name: "Weather Checker",
  description: "Get current weather for a location",
  parameters: {
    type: "object",
    properties: {
      location: { type: "string", description: "City or location name" },
    },
    required: ["location"],
  },
  handler: async (toolContext, args) => {
    const weather = await weatherAPI.getCurrentWeather(args.location);
    return {
      data: `Current weather in ${args.location}: ${weather.temperature}°C, ${weather.condition}`,
      contextUpdate: {
        lastWeatherCheck: new Date().toISOString(),
        currentLocation: args.location,
      },
    };
  },
};

// Data modification tool
const updateUserProfile: Tool<unknown, ProfileData, [], string> = {
  id: "update_profile",
  name: "Profile Updater",
  description: "Update user profile information",
  parameters: {
    type: "object",
    properties: {
      field: { type: "string", description: "Field to update" },
      value: { type: "string", description: "New value" },
    },
    required: ["field", "value"],
  },
  handler: async (toolContext, args) => {
    // Validate field exists in schema
    if (!toolContext.data || !(args.field in toolContext.data)) {
      throw new Error(`Invalid field: ${args.field}`);
    }

    return {
      data: `Updated ${args.field} to: ${args.value}`,
      dataUpdate: { [args.field]: args.value }, // Update session data
    };
  },
};
```

## Tool Execution Flow

### Automatic Tool Calling

Tools are executed automatically when the AI decides to use them:

```typescript
const agent = new Agent({
  name: "Smart Assistant",
  provider: openaiProvider,
  tools: [getWeather, updateUserProfile],

  routes: [
    agent.createRoute({
      title: "Weather Query",
      initialStep: {
        prompt: "What's the weather like? I can check for you.",
        tools: ["get_weather"], // Make tool available in this step
      },
    }),
  ],
});

// Conversation flow:
// User: "What's the weather in Paris?"
// AI: Decides to call get_weather tool
// Tool executes and updates context
// AI: "Current weather in Paris: 22°C, Sunny"
```

### Tool Result Processing

```typescript
interface ToolExecutionResult<TContext, TData> {
  toolName: string;
  success: boolean;
  result?: {
    data: unknown; // User-visible result
    contextUpdate?: Partial<TContext>; // Context modifications
    dataUpdate?: Partial<TData>; // Session data updates
  };
  error?: string;
}
```

## Context Integration

### Context Updates

Tools can modify agent context:

```typescript
const locationTracker: Tool<
  { currentLocation?: string; locationHistory?: string[] },
  { location: string },
  [],
  string
> = {
  id: "track_location",
  description: "Track and update location information",
  parameters: {
    type: "object",
    properties: {
      location: { type: "string", description: "Location to track" },
    },
    required: ["location"],
  },
  handler: async ({ context }, { location }) => {
    return {
      data: `Location set to: ${location}`,
      contextUpdate: {
        currentLocation: location,
        lastLocationUpdate: new Date().toISOString(),
        locationHistory: (prev: string[]) => [...(prev || []), location],
      },
    };
  },
};
```

### Context-Aware Tools

Tools can access current context:

```typescript
const contextualTool: Tool<
  { userName?: string; currentLocation?: string },
  {},
  [],
  string
> = {
  id: "personalized_greeting",
  description: "Generate personalized greeting based on context",
  handler: async ({ context }) => {
    const userName = context.userName || "friend";
    const location = context.currentLocation || "unknown";

    return {
      data: `Hello ${userName} from ${location}! How can I help you today?`,
      contextUpdate: {
        lastInteraction: new Date().toISOString(),
      },
    };
  },
};
```

## Data Collection Integration

### Updating Collected Data

Tools can modify session-collected data:

```typescript
const dataEnrichmentTool: Tool<{}, { email?: string }, [], string> = {
  id: "enrich_user_data",
  description: "Enrich user profile with additional information",
  handler: async ({ data }) => {
    if (!data?.email) {
      throw new Error("Email required for enrichment");
    }

    const enriched = await userAPI.enrichProfile(data.email);

    return {
      data: "Profile enriched with additional information",
      dataUpdate: {
        enrichedAt: new Date().toISOString(),
        profileComplete: true,
        ...enriched, // Merge enriched data
      },
    };
  },
};
```

### Validation Integration

```typescript
const validatingTool: Tool<{}, any, [], string> = {
  id: "validate_and_save",
  description: "Validate collected data and save to database",
  handler: async ({ data }) => {
    // Validate collected data
    const validation = validateUserData(data);

    if (!validation.valid) {
      return {
        data: `Validation failed: ${validation.errors.join(", ")}`,
        dataUpdate: {
          validationErrors: validation.errors,
          needsCorrection: true,
        },
      };
    }

    // Save to database
    await saveUserData(data);

    return {
      data: "Data validated and saved successfully",
      dataUpdate: {
        savedAt: new Date().toISOString(),
        validationStatus: "passed",
      },
    };
  },
};
```

## Tool Scoping

### Agent-Level Tools

Available to all routes and steps:

```typescript
const agent = new Agent({
  name: "Multi-Purpose Agent",
  provider: provider,
  tools: [globalSearchTool, userManagementTool], // Available everywhere

  routes: [
    route1, // Can use global tools
    route2, // Can use global tools
  ],
});
```

### Route-Level Tools

Specific to a route:

```typescript
const supportRoute = agent.createRoute({
  title: "Customer Support",
  tools: [ticketCreationTool, knowledgeBaseTool], // Route-specific

  initialStep: {
    prompt: "How can I help you?",
    tools: ["ticketCreationTool"], // Available in this step
  },
});
```

### Step-Level Tools

Limited to specific conversation steps:

```typescript
const dataCollectionStep = {
  prompt: "Please provide your information",
  collect: ["personalInfo"],
  tools: ["dataValidationTool", "privacyCheckTool"], // Step-specific only
  requires: ["userConsent"],
};
```

### Tool Resolution Priority

Tools are resolved in order of specificity:

```typescript
// 1. Step-level tools (highest priority)
// 2. Route-level tools
// 3. Agent-level tools (lowest priority)

// Same tool ID in multiple scopes:
// Step tool overrides route tool overrides agent tool
```

## Streaming Tool Execution

### Real-Time Tool Calls

Tools work seamlessly with streaming responses:

```typescript
// Streaming response with tool execution
for await (const chunk of agent.respondStream({ history, session })) {
  if (chunk.toolCalls) {
    console.log("AI called tools:", chunk.toolCalls);
  }

  if (chunk.done) {
    console.log("Final response:", chunk.accumulated);
    console.log("Updated session:", chunk.session);
  }
}
```

### Multi-Step Tool Loops

AI can make follow-up tool calls during streaming:

```typescript
// AI might:
// 1. Call tool A
// 2. Process results
// 3. Call tool B based on A's results
// 4. Continue until satisfied

const MAX_TOOL_LOOPS = 5; // Prevent infinite loops
let toolLoopCount = 0;

while (hasToolCalls && toolLoopCount < MAX_TOOL_LOOPS) {
  // Execute tools
  // Update context with results
  // Allow AI to make follow-up calls
  toolLoopCount++;
}
```

## Error Handling & Recovery

### Tool Execution Failures

```typescript
const robustTool: Tool<
  { lastApiCall?: string; errorCount?: number },
  { endpoint: string },
  [],
  string
> = {
  id: "api_call",
  description: "Make external API call with error handling",
  parameters: {
    type: "object",
    properties: {
      endpoint: { type: "string", description: "API endpoint to call" },
    },
    required: ["endpoint"],
  },
  handler: async ({ context }, { endpoint }) => {
    try {
      const result = await externalAPI.call(endpoint);
      return {
        data: `API call successful: ${result}`,
        contextUpdate: { lastApiCall: "success" },
      };
    } catch (error) {
      return {
        data: `API call failed: ${(error as Error).message}`,
        contextUpdate: {
          lastApiCall: "failed",
          errorCount: (count: number) => (count || 0) + 1,
        },
      };
    }
  },
};
```

### Fallback Tools

```typescript
const fallbackTool: Tool<
  { searchFallbackUsed?: boolean },
  { query: string },
  [],
  string
> = {
  id: "fallback_search",
  description: "Search with automatic fallback mechanisms",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
    },
    required: ["query"],
  },
  handler: async ({ context }, { query }) => {
    // Try primary search
    try {
      const result = await primarySearchAPI.search(query);
      return {
        data: `Primary search results: ${result}`,
        contextUpdate: { searchFallbackUsed: false },
      };
    } catch (primaryError) {
      // Fallback to secondary search
      try {
        const result = await secondarySearchAPI.search(query);
        return {
          data: `Secondary search results: ${result}`,
          contextUpdate: { searchFallbackUsed: true },
        };
      } catch (secondaryError) {
        // Final fallback
        return {
          data: "Search temporarily unavailable. Please try again later.",
          contextUpdate: { searchFallbackUsed: true },
        };
      }
    }
  },
};
```

## Advanced Tool Patterns

### Stateful Tools

Tools that maintain state across calls:

```typescript
let toolState = { conversationId: null };

const conversationalTool: Tool<
  { conversationState?: any; lastMessage?: string },
  { message: string },
  [],
  string
> = {
  id: "continue_conversation",
  description: "Continue multi-turn conversation with state management",
  parameters: {
    type: "object",
    properties: {
      message: { type: "string", description: "Message to send" },
    },
    required: ["message"],
  },
  handler: async ({ context }, { message }) => {
    if (!toolState.conversationId) {
      toolState.conversationId = generateId();
    }

    const response = await conversationAPI.sendMessage(
      toolState.conversationId,
      message
    );

    return {
      data: response.message,
      contextUpdate: {
        conversationState: toolState,
        lastMessage: message,
      },
    };
  },
};
```

### Chainable Tools

Tools that set up data for other tools:

```typescript
const setupTool: Tool<
  { activeWorkflowId?: string; workflowType?: string; workflowStep?: number },
  { workflowType: string },
  [],
  string
> = {
  id: "setup_workflow",
  description: "Initialize a new workflow process",
  parameters: {
    type: "object",
    properties: {
      workflowType: {
        type: "string",
        enum: ["onboarding", "support", "sales"],
        description: "Type of workflow to create",
      },
    },
    required: ["workflowType"],
  },
  handler: async ({ context }, { workflowType }) => {
    const workflowId = await workflowAPI.create(workflowType);

    return {
      data: `Workflow ${workflowId} created`,
      contextUpdate: {
        activeWorkflowId: workflowId,
        workflowType,
        workflowStep: 1,
      },
    };
  },
};

const stepTool: Tool<
  { activeWorkflowId?: string; workflowStep?: number; lastStepResult?: any },
  {},
  [],
  string
> = {
  id: "execute_workflow_step",
  description: "Execute the next step in active workflow",
  handler: async ({ context }) => {
    if (!context.activeWorkflowId) {
      throw new Error("No active workflow");
    }

    const result = await workflowAPI.executeStep(
      context.activeWorkflowId,
      context.workflowStep || 1
    );

    return {
      data: `Step ${context.workflowStep || 1} completed: ${result}`,
      contextUpdate: {
        workflowStep: (context.workflowStep || 1) + 1,
        lastStepResult: result,
      },
    };
  },
};
```

## Performance Optimization

### Efficient Tool Execution

```typescript
// Cache expensive operations
const cachedTool: Tool<{ lastCacheHit?: boolean }, { key: string }, [], any> = {
  id: "cached_data_lookup",
  description: "Lookup data with caching for performance",
  parameters: {
    type: "object",
    properties: {
      key: { type: "string", description: "Cache key for lookup" },
    },
    required: ["key"],
  },
  handler: async ({ context }, { key }) => {
    // Check cache first
    const cacheKey = `tool_cache_${key}`;
    let result = cache.get(cacheKey);

    if (!result) {
      result = await expensiveOperation(key);
      cache.set(cacheKey, result, 300000); // 5 minute cache
    }

    return {
      data: result,
      contextUpdate: { lastCacheHit: !!cache.get(cacheKey) },
    };
  },
};
```

### Batch Operations

```typescript
const batchTool: Tool<
  {},
  { items: string[]; processedItems?: any[]; batchCompletedAt?: string },
  [],
  string
> = {
  id: "batch_process",
  description: "Process multiple items in a single batch operation",
  parameters: {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: { type: "string" },
        description: "Items to process",
      },
    },
    required: ["items"],
  },
  handler: async ({ context }, { items }) => {
    // Process multiple items efficiently
    const results = await Promise.all(items.map((item) => processItem(item)));

    return {
      data: `Processed ${results.length} items`,
      dataUpdate: {
        processedItems: results,
        batchCompletedAt: new Date().toISOString(),
      },
    };
  },
};
```

## Security & Access Control

### Tool Permissions

```typescript
const secureTool: Tool<{ userRole?: string }, { action: string }, [], any> = {
  id: "admin_action",
  description: "Perform administrative actions with permission checks",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", description: "Admin action to perform" },
    },
    required: ["action"],
  },
  handler: async ({ context }, { action }) => {
    // Check permissions
    if (context.userRole !== "admin") {
      throw new Error("Insufficient permissions");
    }

    // Execute privileged action
    const result = await performAdminAction(action);
    return {
      data: `Admin action completed: ${result}`,
      contextUpdate: {
        lastAdminAction: new Date().toISOString(),
      },
    };
  },
};
```

### Input Validation

```typescript
const validatedTool: Tool<
  { userId?: string; userRole?: string },
  { userId: string; updates: any },
  [],
  any
> = {
  id: "user_update",
  description: "Update user data with validation and permission checks",
  parameters: {
    type: "object",
    properties: {
      userId: { type: "string", description: "User ID to update" },
      updates: { type: "object", description: "Fields to update" },
    },
    required: ["userId", "updates"],
  },
  handler: async ({ context }, { userId, updates }) => {
    // Validate user can only update their own data
    if (context.userId !== userId && context.userRole !== "admin") {
      throw new Error("Cannot update other users' data");
    }

    // Validate input data
    const validatedUpdates = validateUpdates(updates);

    const result = await updateUser(userId, validatedUpdates);
    return {
      data: `User ${userId} updated successfully`,
      contextUpdate: {
        lastUserUpdate: new Date().toISOString(),
      },
    };
  },
};
```

## Debugging & Monitoring

### Tool Execution Logging

```typescript
// Enable debug mode for detailed logging
const agent = new Agent({
  name: "Debug Agent",
  debug: true,
  provider: provider,
});

// Logs will show:
// [Agent] Executing dynamic tool: get_weather (success: true)
// [Agent] Tool updated collected data: { temperature: 22, condition: "sunny" }
// [Agent] Tool updated context: { lastWeatherCheck: "2024-01-15T10:30:00Z" }
```

### Performance Monitoring

```typescript
const monitoredTool: Tool<{}, { args: any }, [], any> = {
  id: "monitored_operation",
  description: "Execute operation with performance monitoring",
  parameters: {
    type: "object",
    properties: {
      args: { type: "object", description: "Arguments for the operation" },
    },
    required: ["args"],
  },
  handler: async ({ context }, { args }) => {
    const startTime = Date.now();

    try {
      const result = await performOperation(args);

      // Log success metrics
      metrics.record("tool_execution", {
        tool: "monitored_operation",
        duration: Date.now() - startTime,
        success: true,
      });

      return {
        data: `Operation completed: ${result}`,
        contextUpdate: {
          lastOperationDuration: Date.now() - startTime,
          lastOperationSuccess: true,
        },
      };
    } catch (error) {
      // Log error metrics
      metrics.record("tool_execution", {
        tool: "monitored_operation",
        duration: Date.now() - startTime,
        success: false,
        error: (error as Error).message,
      });

      return {
        data: `Operation failed: ${(error as Error).message}`,
        contextUpdate: {
          lastOperationDuration: Date.now() - startTime,
          lastOperationSuccess: false,
          lastOperationError: (error as Error).message,
        },
      };
    }
  },
};
```

## Best Practices

### Tool Design

1. **Clear Purpose**: Each tool should do one thing well
2. **Robust Error Handling**: Plan for failures and edge cases
3. **Input Validation**: Validate all inputs thoroughly
4. **Idempotent Operations**: Safe to call multiple times

### Performance

1. **Efficient Execution**: Cache results when possible
2. **Resource Limits**: Implement timeouts and rate limits
3. **Batch Operations**: Group related operations
4. **Lazy Loading**: Load heavy dependencies only when needed

### Security

1. **Access Control**: Check permissions before execution
2. **Input Sanitization**: Clean and validate all inputs
3. **Audit Logging**: Log all tool executions
4. **Rate Limiting**: Prevent abuse with rate limits

### Testing

```typescript
import { ToolExecutor } from "@falai/agent";

// Test tool execution
const executor = new ToolExecutor();
const result = await executor.executeTool({
  tool,
  context: mockContext,
  data: mockData,
  updateContext: async (updates) => {
    /* mock implementation */
  },
});

expect(result.success).toBe(true);
expect(result.data).toBeDefined();
```

The dynamic tool execution system transforms static AI responses into interactive, context-aware conversations where the AI can perform real actions and adapt based on results.
