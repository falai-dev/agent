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

## Schema-Driven Extraction

When steps specify `collect` fields, the AI response is validated against JSON schemas:

```typescript
const step = route.initialStep.nextStep({
  prompt: "What's your name and email?",
  collect: ["name", "email"],
  schema: {
    type: "object",
    properties: {
      name: { type: "string" },
      email: { type: "string", format: "email" },
    },
    required: ["name", "email"],
  },
});
```

The AI receives instructions to return structured data alongside natural language responses.

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

Extracted data is validated against route schemas:

- **Type checking** - Ensures correct data types
- **Required fields** - Validates mandatory data presence
- **Format validation** - Email, dates, custom formats
- **Business rules** - Custom validation logic

## Context Updates

Response processing updates multiple context layers:

### Session Data

```typescript
// Collected data merged into session
session.data = {
  ...session.data,
  ...extractedData,
  ...toolResults,
};
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

- **Schema validation failures** - Graceful fallback to manual extraction
- **Tool execution errors** - Error recovery and user notification
- **Context update failures** - Rollback and logging
- **Routing errors** - Safe fallback to default behavior

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
