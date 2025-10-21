# Response Processing

@fali/agent processes AI responses to extract structured data, execute tools, and update conversation state according to schema definitions and routing logic.

## Overview

The `ResponseEngine` handles AI response processing, including:

- Schema-based data extraction
- Tool execution coordination
- Context and session updates
- Route progression logic

## Response Parsing

AI responses are parsed to extract:

1. **Natural Language Response** - The text to send to the user
2. **Structured Data** - JSON data matching collection schemas
3. **Tool Calls** - Instructions to execute tools
4. **Routing Decisions** - Route or step transitions

## Agent-Level Schema-Driven Extraction

When steps specify `collect` fields, the AI response is validated against the agent-level JSON schema:

```typescript
// Agent defines comprehensive schema
const agent = new Agent<{}, UserData>({
  schema: {
    type: "object",
    properties: {
      name: { type: "string" },
      email: { type: "string", format: "email" },
      phone: { type: "string" },
      preferences: { type: "object" }
    },
    required: ["name", "email"]
  }
});

// Steps collect into agent schema
const step = route.initialStep.nextStep({
  prompt: "What's your name and email?",
  collect: ["name", "email"], // Maps to agent schema fields
});
```

The AI receives instructions to return structured data that matches the agent-level schema, enabling cross-route data sharing.

## Tool Execution Pipeline

When tools are called, the response engine:

1. **Validates** tool parameters against schemas
2. **Executes** tools in the correct order
3. **Updates** context with tool results
4. **Merges** tool-returned data into session
5. **Continues** conversation with enriched context

```typescript
// Tool execution result
{
  success: true,
  result: {
    data: "Flight search completed",
    contextUpdate: { availableFlights: [...] },
    dataUpdate: { searchPerformed: true }
  }
}
```

## Data Validation

Extracted data is validated against the agent-level schema:

- **Type checking** - Ensures correct data types against agent schema
- **Required fields** - Validates mandatory data presence for route completion
- **Format validation** - Email, dates, custom formats from agent schema
- **Business rules** - Custom validation logic in agent-level hooks
- **Cross-route consistency** - Ensures data consistency across all routes

## Context Updates

Response processing updates multiple context layers:

### Agent-Level Data

```typescript
// Collected data merged into agent-level data structure
agent.collectedData = {
  ...agent.collectedData,
  ...extractedData,
  ...toolResults,
};

// Session references agent data
session.data = agent.collectedData;
```

### Route Context

```typescript
// Route-specific context updates
routeContext.lastActivity = new Date();
routeContext.stepCount += 1;
```

### Agent Context

```typescript
// Global agent context
agentContext.totalInteractions += 1;
agentContext.lastResponseTime = Date.now();
```

## Error Handling

Robust error handling for various failure scenarios:

### Schema Validation Failures

When AI responses don't match expected schemas, the system gracefully falls back:

```typescript
const processResponse = async (response: string, schema: JSONSchema) => {
  try {
    // Try schema-based extraction first
    const extracted = await extractWithSchema(response, schema);
    return { success: true, data: extracted };
  } catch (schemaError) {
    console.warn("Schema extraction failed, falling back to manual parsing:", schemaError.message);
    
    // Fallback to manual extraction
    try {
      const manualData = await manualExtraction(response);
      return { success: true, data: manualData, fallback: true };
    } catch (fallbackError) {
      return { 
        success: false, 
        error: `Both schema and manual extraction failed: ${fallbackError.message}` 
      };
    }
  }
};
```

### Tool Execution Errors

Tool failures are handled gracefully with proper error propagation:

```typescript
const executeTool = async (tool: Tool, params: any) => {
  try {
    const result = await tool.handler(params);
    return { success: true, result };
  } catch (error) {
    console.error(`Tool ${tool.id} execution failed:`, error);
    
    return {
      success: false,
      error: error.message,
      fallbackMessage: "I encountered an issue while processing your request. Please try again."
    };
  }
};
```

### Context Update Failures

Context updates include rollback mechanisms:

```typescript
const updateContext = async (newContext: any, previousContext: any) => {
  try {
    await persistContext(newContext);
    return { success: true };
  } catch (error) {
    console.error("Context update failed, rolling back:", error);
    
    try {
      await persistContext(previousContext);
      return { success: false, rolledBack: true, error: error.message };
    } catch (rollbackError) {
      return { 
        success: false, 
        rolledBack: false, 
        error: `Update and rollback both failed: ${rollbackError.message}` 
      };
    }
  }
};
```

### Streaming Error Propagation

Streaming responses properly propagate provider errors:

```typescript
async function* processStreamingResponse(provider: AIProvider, prompt: string) {
  try {
    for await (const chunk of provider.generateMessageStream(prompt)) {
      yield { success: true, chunk };
    }
  } catch (error) {
    // Ensure streaming errors are properly propagated
    yield { success: false, error: error.message };
    throw error; // Re-throw to stop the stream
  }
}
```

### Routing Errors

Safe fallback to default behavior when routing fails:

```typescript
const selectRoute = async (routes: Route[], context: any) => {
  try {
    const selectedRoute = await aiRouting.selectBestRoute(routes, context);
    return { success: true, route: selectedRoute };
  } catch (routingError) {
    console.warn("AI routing failed, using default route:", routingError.message);
    
    // Fallback to first available route or default
    const fallbackRoute = routes.find(r => r.isDefault) || routes[0];
    return { 
      success: true, 
      route: fallbackRoute, 
      fallback: true,
      error: routingError.message 
    };
  }
};
```

## Streaming Response Processing

For streaming responses, processing happens incrementally:

```typescript
for await (const chunk of agent.respondStream({...})) {
  if (chunk.delta) {
    // Process partial response
    processStreamingChunk(chunk);
  }

  if (chunk.done) {
    // Final processing
    await finalizeResponse(chunk);
  }
}
```

## Route Progression

Response processing determines next conversation steps:

- **Step completion** - Advances to next step in route
- **Route completion** - Handles `END_ROUTE` logic
- **Branching decisions** - Evaluates conditions for path selection
- **Transition triggers** - Initiates route-to-route transitions

## Performance Considerations

- **Efficient parsing** - Minimal overhead for response processing
- **Lazy validation** - Only validate when necessary
- **Caching** - Cache parsed schemas and validation rules
- **Async processing** - Non-blocking context updates

## Monitoring & Debugging

Built-in monitoring capabilities:

- **Response metrics** - Token usage, processing time
- **Error tracking** - Failed extractions, validation errors
- **Debug logging** - Detailed processing traces
- **Performance profiling** - Identify bottlenecks

## Best Practices

- Design schemas for reliable AI extraction
- Implement comprehensive error handling
- Monitor response quality and adjust prompts
- Use streaming for better user experience
- Leverage tool results for context enrichment
- Validate data at multiple levels (schema + business rules)
