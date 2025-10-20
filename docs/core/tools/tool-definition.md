# Tool Definition

Tools in @falai/agent enable AI agents to execute custom logic, access external APIs, and perform actions during conversations. This document covers tool creation, configuration, and integration.

## Overview

Tools provide a way for agents to:

- Execute business logic and API calls
- Access external services and databases
- Perform calculations and data transformations
- Update conversation context and session data

## Tool Creation

Tools are created as objects implementing the `Tool` interface:

```typescript
import { Tool } from "@falai/agent";

const weatherTool: Tool<unknown, WeatherData, [], string> = {
  id: "get_weather",
  name: "Weather Forecast", // Human-readable name shown to AI models
  description: "Get current weather and forecast for a location",
  parameters: {
    type: "object",
    properties: {
      location: { type: "string", description: "City or location name" },
      date: { type: "string", description: "Date for forecast (YYYY-MM-DD)" },
    },
    required: ["location"],
  },
  handler: async ({ location, date }) => {
    const weather = await weatherAPI.getForecast(location, date);
    return {
      data: `The weather in ${location} on ${date} is ${weather.condition}`,
      contextUpdate: {
        currentWeather: weather,
        lastWeatherCheck: new Date().toISOString(),
      },
    };
  },
};
```

## Tool Name

The optional `name` field provides a human-readable name for the tool that is displayed to AI models. When provided, this name takes precedence over the `id` field in AI provider interactions:

```typescript
const calculatorTool: Tool<unknown, CalcData, [], string> = {
  id: "math_calculator", // Internal identifier
  name: "Math Calculator", // Display name for AI models
  description: "Perform mathematical calculations",
  // ... rest of tool definition
};
```

**Benefits:**

- **Better AI Understanding**: Clear, descriptive names help AI models choose appropriate tools
- **User-Friendly**: More readable than cryptic IDs in AI responses and logs
- **Backward Compatible**: Falls back to `id` if `name` is not provided
- **Flexible**: Allows separation of internal IDs from user-facing names

## Tool Parameters

Tool parameters are defined using JSON Schema:

```typescript
const searchTool: Tool<unknown, SearchData, [], string> = {
  id: "web_search",
  name: "Web Search Engine",
  description: "Search the web for information",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Search query",
        minLength: 1,
        maxLength: 200,
      },
      limit: {
        type: "number",
        description: "Maximum number of results",
        minimum: 1,
        maximum: 50,
        default: 10,
      },
    },
    required: ["query"],
  },
  handler: async ({ query, limit = 10 }) => {
    const results = await searchAPI.query(query, limit);
    return {
      data: `Found ${results.length} results for "${query}"`,
      contextUpdate: { searchResults: results },
    };
  },
};
```

## Tool Execution Context

Tools receive execution context including:

- **Current context** - Agent and route context
- **Session data** - Collected conversation data
- **Route information** - Current route and step details

```typescript
const userProfileTool: Tool<unknown, UserData, [], string> = {
  id: "get_user_profile",
  description: "Retrieve user profile information",
  parameters: {
    type: "object",
    properties: {
      userId: {
        type: "string",
        description: "User ID (optional, uses context if not provided)",
      },
    },
  },
  handler: async (toolContext, args) => {
    // Access current context
    const currentUserId = toolContext.context.userId || args.userId;

    // Access collected data
    const preferences = toolContext.data.userPreferences;

    const profile = await userAPI.getProfile(currentUserId);
    return {
      data: `Retrieved profile for ${profile.name}`,
      dataUpdate: { userProfile: profile },
    };
  },
};
```

## Tool Response Format

Tools return structured responses with multiple components:

```typescript
interface ToolResult {
  success: boolean;
  result?: {
    data: unknown; // User-visible result
    contextUpdate?: Partial<TContext>; // Context modifications
    dataUpdate?: Partial<TData>; // Session data updates
  };
  error?: string; // Error message if failed
}
```

## Context Updates

Tools can modify conversation context:

```typescript
const locationTool: Tool<unknown, LocationData, [], string> = {
  id: "set_location",
  description: "Update the user's location in context",
  parameters: {
    type: "object",
    properties: {
      location: { type: "string", description: "New location" },
    },
    required: ["location"],
  },
  handler: async (toolContext, args) => {
    return {
      data: `Location set to ${args.location}`,
      contextUpdate: {
        currentLocation: args.location,
        locationSetAt: new Date().toISOString(),
        locationHistory: (prev: string[]) => [...(prev || []), args.location],
      },
    };
  },
};
```

## Data Collection Updates

Tools can update session data collected during conversation:

```typescript
const validationTool: Tool<unknown, BookingData, [], string> = {
  id: "validate_booking",
  description: "Validate booking information and update session data",
  parameters: {
    type: "object",
    properties: {},
  },
  handler: async (toolContext) => {
    const validation = await bookingAPI.validate(toolContext.data.bookingInfo);

    if (!validation.valid) {
      return {
        data: `Booking validation failed: ${validation.errors.join(", ")}`,
        dataUpdate: {
          bookingErrors: validation.errors,
          bookingValid: false,
        },
      };
    }

    return {
      data: "Booking validated successfully",
      dataUpdate: {
        bookingValid: true,
        validatedAt: new Date().toISOString(),
      },
    };
  },
};
```

## Error Handling

Tools should handle errors gracefully:

```typescript
const apiTool: Tool<unknown, ApiData, [], string> = {
  id: "call_external_api",
  description: "Call an external API endpoint",
  parameters: {
    type: "object",
    properties: {
      endpoint: { type: "string", description: "API endpoint to call" },
    },
    required: ["endpoint"],
  },
  handler: async (toolContext, args) => {
    try {
      const result = await externalAPI.call(args.endpoint);
      return {
        data: `API call successful: ${result}`,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      return {
        data: `API call failed: ${errorMessage}`,
        contextUpdate: { lastApiError: errorMessage },
      };
    }
  },
};
```

## Tool Scoping

Tools can be registered at different levels:

### Agent-Level Tools

Available to all routes and steps:

```typescript
const agent = new Agent({
  name: "Assistant",
  provider: openaiProvider,
  tools: [globalSearchTool, userManagementTool],
});
```

### Route-Level Tools

Available only within specific routes:

```typescript
const supportRoute = agent.createRoute({
  title: "Customer Support",
  tools: [ticketCreationTool, knowledgeBaseTool],
});
```

### Step-Level Tools

Available only in specific steps:

```typescript
const bookingStep = route.initialStep.nextStep({
  prompt: "Ready to book?",
  tools: [paymentProcessingTool],
  requires: ["bookingDetails"],
});
```

## Tool Resolution Priority

When multiple tools with the same name exist, priority is:

1. **Step-level tools** (highest priority)
2. **Route-level tools**
3. **Agent-level tools** (lowest priority)

## Async Tools

Tools support async operations and Promises:

```typescript
const asyncTool: Tool<unknown, ProcessingData, [], string> = {
  id: "process_data",
  description: "Process data asynchronously with heavy computation",
  parameters: {
    type: "object",
    properties: {
      data: { type: "object", description: "Data to process" },
    },
    required: ["data"],
  },
  handler: async (toolContext, args) => {
    // Simulate async processing
    await new Promise((resolve) => setTimeout(resolve, 1000));

    const processed = await heavyComputation(args.data);

    return {
      data: "Data processed successfully",
      dataUpdate: { processedData: processed },
    };
  },
};
```

## Tool Validation

Tools are validated at registration time:

- **Schema validation** - Parameter schemas must be valid JSON Schema
- **Type checking** - TypeScript types must match schemas
- **Name uniqueness** - Tool names must be unique within scope

## Best Practices

- **Keep tools focused** - Each tool should do one thing well
- **Use descriptive names** - Tool names should be clear and specific
- **Handle errors gracefully** - Provide meaningful error messages
- **Leverage context updates** - Use context to maintain conversation state
- **Validate parameters** - Use JSON Schema constraints effectively
- **Consider performance** - Avoid long-running operations when possible
- **Document thoroughly** - Provide clear descriptions for AI usage
