# Tool Definition with Unified Interface

Tools in @falai/agent enable AI agents to execute custom logic, access external APIs, and perform actions during conversations. The unified Tool interface supports both simple return values and complex ToolResult patterns, providing maximum flexibility with minimal complexity.

## Overview

The unified Tool system provides:

- **Single Interface**: One Tool interface that handles both simple and advanced patterns
- **Flexible Returns**: Return simple values (`return 'result'`) or complex objects (`return { data: 'result', success: true }`)
- **Multiple Creation Methods**: Direct addition, registry system, pattern helpers, and manual creation
- **Type Safety**: Full TypeScript support with automatic type inference
- **Helper Methods**: Built-in context and data update utilities
- **Intelligent Scoping**: Hierarchical tool resolution with registry fallback

## Unified Tool Interface

All tools use the same interface regardless of complexity:

```typescript
interface Tool<TContext = unknown, TData = unknown, TResult = unknown> {
  id: string;
  name?: string;
  description?: string;
  parameters?: unknown;
  handler: (
    context: ToolContext<TContext, TData>,
    args?: Record<string, unknown>
  ) => Promise<TResult | ToolResult<TResult, TContext, TData>> | TResult | ToolResult<TResult, TContext, TData>;
}
```

The handler can return either:
- **Simple values**: `return 'result'` or `return { status: 'complete' }`
- **ToolResult objects**: `return { data: 'result', success: true, contextUpdate: {...} }`

```typescript
import { Agent, GeminiProvider } from "@falai/agent";

const agent = new Agent({
  name: "Assistant",
  provider: new GeminiProvider({
    apiKey: process.env.GEMINI_API_KEY!,
  }),
});

// Access ToolManager for advanced operations
const toolManager = agent.tool;
```

## Tool Creation Methods

The unified Tool interface supports multiple creation approaches, each optimized for different use cases:

### 1. Simple Return Values (Recommended for Most Cases)

The most straightforward approach - just return the result directly:

```typescript
import { Agent, GeminiProvider } from "@falai/agent";

interface UserContext {
  userId: string;
  preferences: Record<string, any>;
}

interface WeatherData {
  location?: string;
  temperature?: number;
  condition?: string;
}

const agent = new Agent<UserContext, WeatherData>({
  name: "Weather Assistant",
  provider: new GeminiProvider({
    apiKey: process.env.GEMINI_API_KEY!,
  }),
});

// Simple return value - most common pattern
agent.addTool({
  id: "get_weather",
  name: "Weather Forecast",
  description: "Get current weather and forecast for a location",
  parameters: {
    type: "object",
    properties: {
      location: { type: "string", description: "City or location name" },
      date: { type: "string", description: "Date for forecast (YYYY-MM-DD)" },
    },
    required: ["location"],
  },
  handler: async ({ context, data, updateContext, updateData }, args) => {
    const weather = await weatherAPI.getForecast(args.location, args.date);
    
    // Use helper methods for updates
    await updateContext({ lastWeatherCheck: new Date().toISOString() });
    await updateData({
      location: args.location,
      temperature: weather.temperature,
      condition: weather.condition,
    });
    
    // Return simple string - unified interface handles the rest
    return `The weather in ${args.location} on ${args.date} is ${weather.condition}`;
  },
});
```

### 2. Advanced ToolResult Pattern

For complex scenarios requiring detailed control:

```typescript
// Advanced ToolResult pattern for complex scenarios
agent.addTool({
  id: "process_payment",
  name: "Payment Processor",
  description: "Process payment with detailed result tracking",
  parameters: {
    type: "object",
    properties: {
      amount: { type: "number", description: "Payment amount" },
      currency: { type: "string", description: "Currency code" },
    },
    required: ["amount", "currency"],
  },
  handler: async ({ context, data }, args) => {
    try {
      const result = await paymentAPI.process(args.amount, args.currency);
      
      // Return detailed ToolResult object
      return {
        data: `Payment of ${args.amount} ${args.currency} processed successfully`,
        success: true,
        contextUpdate: {
          lastPaymentId: result.transactionId,
          paymentHistory: [...(context.paymentHistory || []), result]
        },
        dataUpdate: {
          paymentStatus: 'completed',
          transactionId: result.transactionId
        }
      };
    } catch (error) {
      return {
        data: `Payment failed: ${error.message}`,
        success: false,
        contextUpdate: {
          lastPaymentError: error.message
        }
      };
    }
  },
});
```

## Multiple Creation Approaches

Choose the approach that best fits your use case:

### 3. Direct Addition (`agent.addTool`)

Add tools directly to agent scope - available to all routes and steps:

```typescript
// Creates and adds tool to agent scope in one operation
agent.addTool({
  id: "math_calculator",
  name: "Math Calculator",
  description: "Perform mathematical calculations",
  parameters: {
    type: "object",
    properties: {
      expression: { type: "string", description: "Mathematical expression to evaluate" },
    },
    required: ["expression"],
  },
  handler: async ({ context, data, updateData }, args) => {
    const result = performCalculation(args.expression);
    
    // Update collected data with calculation result
    await updateData({ lastCalculation: result });
    
    // Simple return value
    return `Result: ${result}`;
  },
});
```

### 4. Registry System (`agent.tool.register`)

Register tools for reuse across multiple contexts:

```typescript
// Register tool without adding to any scope
agent.tool.register({
  id: "reusable_search",
  name: "Universal Search",
  description: "Search across multiple data sources",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
      sources: { type: "array", items: { type: "string" }, description: "Data sources to search" },
    },
    required: ["query"],
  },
  handler: async ({ context, data }, args) => {
    const results = await searchMultipleSources(args.query, args.sources);
    return `Found ${results.length} results`; // Simple return
  },
});

// Reference registered tool by ID in steps
route.initialStep.nextStep({
  prompt: "What would you like to search for?",
  tools: ['reusable_search'] // Reference by ID
});

// Or add registered tool to specific scopes
const searchTool = agent.tool.find('reusable_search');
route.addTool(searchTool);
```

### 5. Manual Creation (`agent.tool.create`)

Create tool instances without registering or adding to any scope:

```typescript
// Create tool instance for manual management
const customTool = agent.tool.create({
  id: "standalone_processor",
  description: "Process data independently",
  handler: async ({ context, data }) => {
    return "Processing complete"; // Simple return
  },
});

// Manually add to specific contexts as needed
someStep.tools = [customTool];
```

### 6. Bulk Operations (`registerMany`)

Register multiple tools at once:

```typescript
agent.tool.registerMany([
  {
    id: "system_status",
    description: "Check system health",
    handler: async () => "System OK", // Simple return
  },
  {
    id: "audit_log",
    description: "Create audit log entry",
    handler: async ({ context }) => `Audit logged for ${context.userId}`,
  },
  existingToolInstance, // Can mix definitions and instances
]);
```

### 7. Pattern Helpers

Use built-in helpers for common tool patterns - these return tool instances that can be registered or added as needed:

```typescript
// Data enrichment tool - returns Tool instance
const enrichmentTool = agent.tool.createDataEnrichment({
  id: "enrich_user_profile",
  fields: ['name', 'email'] as const, // Type-safe field selection
  enricher: async (context, data) => ({
    fullName: `${data.name} (${context.userRole})`,
    emailDomain: data.email?.split('@')[1],
  })
});

// Validation tool - returns Tool instance
const validationTool = agent.tool.createValidation({
  id: "validate_booking",
  fields: ['date', 'guests'] as const,
  validator: async (context, data) => {
    const errors = [];
    if (!data.date) errors.push({ field: 'date', message: 'Date is required' });
    if (!data.guests || data.guests < 1) errors.push({ field: 'guests', message: 'At least 1 guest required' });
    
    return { valid: errors.length === 0, errors };
  }
});

// API call tool - returns Tool instance
const apiTool = agent.tool.createApiCall({
  id: "fetch_weather_data",
  endpoint: "https://api.weather.com/v1/current",
  method: "GET",
  headers: { "API-Key": process.env.WEATHER_API_KEY! },
  transform: (response: any) => response.data.current,
});

// Computation tool - returns Tool instance
const computeTool = agent.tool.createComputation({
  id: "calculate_total_cost",
  inputs: ['basePrice', 'taxRate', 'discountPercent'] as const,
  compute: async (context, inputs) => {
    const subtotal = inputs.basePrice * (1 - (inputs.discountPercent || 0) / 100);
    return subtotal * (1 + (inputs.taxRate || 0));
  }
});

// Register or add pattern helpers as needed
agent.tool.registerMany([enrichmentTool, validationTool, apiTool, computeTool]);
```

## When to Use Each Approach

- **Simple Return Values**: Most common cases, straightforward results
- **ToolResult Pattern**: Complex scenarios requiring context/data updates
- **Direct Addition**: Tools specific to one agent
- **Registry System**: Reusable tools across multiple contexts
- **Manual Creation**: Custom tool management scenarios
- **Bulk Operations**: Efficient registration of multiple tools
- **Pattern Helpers**: Common patterns with built-in logic

## Tool Parameters

Tool parameters are defined using JSON Schema:

```typescript
agent.addTool({
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
  handler: async ({ context, data }, args) => {
    const { query, limit = 10 } = args;
    const results = await searchAPI.query(query, limit);
    return {
      data: `Found ${results.length} results for "${query}"`,
      contextUpdate: { searchResults: results },
    };
  },
});
```

## Simplified Tool Context

Tools receive a simplified context with direct access to agent data and helper methods:

```typescript
agent.addTool({
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
  handler: async ({ context, data, updateContext, updateData }, args) => {
    // Direct access to current context and data
    const currentUserId = context.userId || args.userId;
    const preferences = data.userPreferences;

    const profile = await userAPI.getProfile(currentUserId);
    
    // Use helper methods for updates
    await updateData({ userProfile: profile });
    
    return {
      data: `Retrieved profile for ${profile.name}`,
    };
  },
});
```

### Context Helper Methods

The simplified context provides convenient helper methods:

```typescript
agent.addTool({
  id: "user_preferences",
  handler: async ({ context, data, getField, setField, hasField }) => {
    // Check if field exists
    if (hasField('preferences')) {
      const prefs = getField('preferences');
      console.log('Current preferences:', prefs);
    }
    
    // Set field value
    await setField('lastLogin', new Date().toISOString());
    
    return { data: "Preferences updated" };
  },
});
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

Tools can be added at different scopes using the new ToolManager API:

### Agent-Level Tools

Available to all routes and steps:

```typescript
// Add tools directly to agent scope
agent.addTool({
  id: "global_search",
  description: "Search across all data sources",
  handler: async ({ context, data }) => {
    // Tool logic here
    return { data: "Search completed" };
  },
});

// Or register for later use
agent.tool.register({
  id: "user_management",
  description: "Manage user accounts",
  handler: async ({ context, data }) => {
    return { data: "User managed" };
  },
});
```

### Route-Level Tools

Available only within specific routes:

```typescript
const supportRoute = agent.createRoute({
  title: "Customer Support",
});

// Add tools to route scope
supportRoute.addTool({
  id: "create_ticket",
  description: "Create support ticket",
  handler: async ({ context, data }) => {
    return { data: "Ticket created" };
  },
});
```

### Step-Level Tools

Available only in specific steps:

```typescript
// Add tool directly to step
const bookingStep = route.initialStep.nextStep({
  prompt: "Ready to book?",
  requires: ["bookingDetails"],
}).addTool({
  id: "process_payment",
  description: "Process payment for booking",
  handler: async ({ context, data }) => {
    return { data: "Payment processed" };
  },
});

// Or reference registered tools by ID
const step = route.initialStep.nextStep({
  prompt: "Processing...",
  tools: ['registered_tool_id'], // Reference by ID
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

## Pattern Helpers

ToolManager provides built-in helpers for common tool patterns:

### Data Enrichment Tools

For tools that modify collected data:

```typescript
const enrichmentTool = agent.tool.createDataEnrichment({
  id: "enrich_user_data",
  fields: ['name', 'email'],
  enricher: async (context, data) => ({
    fullName: `${data.name} (${context.userRole})`,
    emailDomain: data.email.split('@')[1]
  })
});

// Register or add to scope
agent.tool.register(enrichmentTool);
```

### Validation Tools

For tools that validate data fields:

```typescript
const validationTool = agent.tool.createValidation({
  id: "validate_booking",
  fields: ['bookingDate', 'guestCount'],
  validator: async (context, data) => {
    const errors = [];
    if (!data.bookingDate) errors.push({ field: 'bookingDate', message: 'Required' });
    if (data.guestCount < 1) errors.push({ field: 'guestCount', message: 'Must be positive' });
    
    return {
      valid: errors.length === 0,
      errors
    };
  }
});

agent.addTool(validationTool);
```

### API Call Tools

For tools that make external API calls:

```typescript
const apiTool = agent.tool.createApiCall({
  id: "fetch_weather",
  endpoint: "https://api.weather.com/forecast",
  method: "GET",
  headers: { "API-Key": process.env.WEATHER_API_KEY },
  transform: (response) => response.data.forecast
});

agent.tool.register(apiTool);
```

### Computation Tools

For tools that perform calculations:

```typescript
const computeTool = agent.tool.createComputation({
  id: "calculate_total",
  inputs: ['price', 'quantity', 'taxRate'],
  compute: async (context, inputs) => {
    const subtotal = inputs.price * inputs.quantity;
    const tax = subtotal * inputs.taxRate;
    return subtotal + tax;
  }
});

agent.addTool(computeTool);
```

## Tool Registry and Resolution

### Registry Management

```typescript
// Register multiple tools at once
agent.tool.registerMany([
  { id: 'tool1', handler: () => {} },
  { id: 'tool2', handler: () => {} },
  existingToolInstance
]);

// Check if tool is registered
if (agent.tool.isRegistered('my_tool')) {
  console.log('Tool is available');
}

// Get all registered tools
const registeredTools = agent.tool.getRegistered();
```

### Tool Resolution

Tools are resolved with the following priority:

1. **Step-level inline tools** (highest priority)
2. **Step-level tool references** (by ID) → Registry lookup
3. **Route-level tools**
4. **Agent-level tools**
5. **Registered tools** (fallback for unresolved IDs)

```typescript
// Find tool across all scopes
const tool = agent.tool.find('my_tool');

// Get available tools for current context
const availableTools = agent.tool.getAvailable();
```

## Tools as Step Lifecycle Hooks

Tools can be used as `prepare` and `finalize` functions in step lifecycle, enabling powerful data processing and side effects before and after AI responses:

### Using Tools for Step Preparation

```typescript
// Create a preparation tool
agent.addTool({
  id: "validate_user_data",
  name: "User Data Validator",
  description: "Validate user data before processing",
  parameters: { type: "object", properties: {} },
  handler: async ({ context, data, updateData }) => {
    // Validation logic with helper methods
    if (!data.email?.includes("@")) {
      throw new Error("Invalid email address");
    }
    
    // Mark as validated using helper method
    await updateData({ emailValidated: true });
    
    return "User validation completed successfully";
  },
});

// Use tool as prepare hook
const step = route.initialStep.nextStep({
  id: "collect_info",
  description: "Collect user information",
  collect: ["name", "email"],
  prompt: "Please provide your name and email.",
  prepare: "validate_user_data", // Tool ID string - executes before AI response
});
```

### Using Tools for Step Finalization

```typescript
// Create a finalization tool with ToolResult pattern
agent.addTool({
  id: "send_welcome_email",
  name: "Welcome Email Sender",
  description: "Send welcome email after data collection",
  parameters: { type: "object", properties: {} },
  handler: async ({ context, data }) => {
    const emailResult = await emailService.sendWelcome(data.email, data.name);
    
    return {
      data: `Welcome email sent to ${data.email}`,
      success: emailResult.success,
      contextUpdate: { 
        lastEmailSent: new Date().toISOString(),
        emailsSent: (context.emailsSent || 0) + 1
      }
    };
  },
});

// Use tool as finalize hook
const welcomeStep = route.initialStep.nextStep({
  id: "send_welcome",
  description: "Send welcome email",
  prompt: "Welcome! Check your email for confirmation.",
  finalize: "send_welcome_email", // Tool ID string - executes after AI response
});
```

### Multiple Lifecycle Approaches

Tools can be used in step lifecycle in several ways:

```typescript
// Method 1: Tool ID reference (most common)
const step1 = route.initialStep.nextStep({
  prompt: "Processing your request...",
  prepare: "setup_processing", // References registered tool by ID
  finalize: "cleanup_processing", // References registered tool by ID
});

// Method 2: Inline tool definition
const step2 = route.initialStep.nextStep({
  prompt: "Validating your information...",
  prepare: {
    id: "inline_validator",
    description: "Validate data inline",
    handler: async ({ context, data }) => {
      // Inline validation logic
      return data.isValid ? "Validation passed" : "Validation failed";
    }
  }
});

// Method 3: Function reference (traditional approach)
const step3 = route.initialStep.nextStep({
  prompt: "Setting up your account...",
  prepare: async (context, data) => {
    // Traditional function approach
    console.log("Preparing account setup...");
  },
  finalize: async (context, data) => {
    // Traditional function approach
    console.log("Account setup complete");
  }
});
```

### Advanced Lifecycle Tool Patterns

```typescript
// Data enrichment during preparation
agent.addTool({
  id: "enrich_user_context",
  description: "Enrich user context before processing",
  handler: async ({ context, data, updateContext, updateData }) => {
    // Fetch additional user data
    const userProfile = await userService.getProfile(context.userId);
    const preferences = await userService.getPreferences(context.userId);
    
    // Update context with enriched data
    await updateContext({
      userProfile,
      preferences,
      lastEnrichment: new Date().toISOString()
    });
    
    // Update collected data
    await updateData({
      userTier: userProfile.tier,
      preferredLanguage: preferences.language
    });
    
    return {
      data: "User context enriched successfully",
      contextUpdate: { enrichmentComplete: true }
    };
  }
});

// Audit logging during finalization
agent.addTool({
  id: "audit_step_completion",
  description: "Log step completion for audit trail",
  handler: async ({ context, data }) => {
    await auditService.logStepCompletion({
      userId: context.userId,
      stepId: context.currentStep,
      timestamp: new Date(),
      collectedData: data
    });
    
    return "Step completion logged";
  }
});

// Use in step with both prepare and finalize
const auditedStep = route.initialStep.nextStep({
  prompt: "Processing your secure transaction...",
  prepare: "enrich_user_context",
  finalize: "audit_step_completion",
  collect: ["transactionAmount", "recipientAccount"]
});
```

### Benefits of Tool-Based Lifecycle Hooks

- ✅ **Reusable Logic** - Tools can be shared across steps and routes
- ✅ **Error Handling** - Tool execution includes automatic error handling
- ✅ **Context Access** - Tools receive full context and collected data
- ✅ **Data Updates** - Tools can modify collected data or agent context
- ✅ **Flexible Returns** - Support both simple returns and complex ToolResult objects
- ✅ **Type Safety** - Full TypeScript support with automatic inference
- ✅ **Registry Integration** - Reference tools by ID for consistency

### Lifecycle Execution Order

When using tools in step lifecycle:

1. **Prepare Phase**: Tool executes before AI response generation
2. **AI Response**: Agent generates response based on enriched context/data
3. **Finalize Phase**: Tool executes after AI response, can process results

```typescript
const lifecycleStep = route.initialStep.nextStep({
  prompt: "Let me process your request...",
  prepare: "setup_processing", // 1. Executes first
  // 2. AI generates response using enriched context
  finalize: "complete_processing", // 3. Executes last
});
```

## Best Practices

- **Use pattern helpers** - Leverage built-in helpers for common patterns
- **Register reusable tools** - Use registry for tools referenced across multiple steps
- **Keep tools focused** - Each tool should do one thing well
- **Use descriptive names** - Tool names should be clear and specific
- **Handle errors gracefully** - Provide meaningful error messages
- **Leverage helper methods** - Use `updateContext`, `updateData`, `getField`, etc.
- **Validate parameters** - Use JSON Schema constraints effectively
- **Consider performance** - Avoid long-running operations when possible
- **Document thoroughly** - Provide clear descriptions for AI usage
- **Use lifecycle hooks** - Leverage prepare/finalize for setup and cleanup logic
