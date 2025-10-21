# Error Handling

@fali/agent provides comprehensive error handling mechanisms for streaming operations, route completion detection, and agent-session data synchronization. This document covers error propagation patterns, recovery strategies, and best practices.

## Overview

The framework handles errors across multiple layers:

- **Streaming Error Propagation** - Proper error handling in streaming AI responses
- **Route Completion Logic** - Accurate detection of route completion states
- **Session Data Synchronization** - Consistent error handling for agent-session data operations
- **Tool Execution Errors** - Graceful handling of tool failures
- **Validation Errors** - Schema and data validation error recovery

## Streaming Error Propagation

### Error Handling in Streaming Responses

When using streaming AI providers, errors must be properly propagated from the underlying provider to the application layer:

```typescript
import { Agent, OpenAIProvider } from "@falai/agent";

const agent = new Agent({
  provider: new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY }),
});

try {
  // Streaming response with proper error handling
  for await (const chunk of agent.respondStream({
    message: "Hello",
    sessionId: "user-123"
  })) {
    if (chunk.error) {
      // Handle streaming errors properly
      console.error("Streaming error:", chunk.error);
      break;
    }
    
    if (chunk.delta) {
      process.stdout.write(chunk.delta);
    }
  }
} catch (error) {
  // Catch provider-level streaming errors
  console.error("Provider streaming error:", error.message);
}
```

### MockProvider Error Testing

For testing streaming error scenarios, the MockProvider properly propagates configured errors:

```typescript
import { MockProvider } from "@falai/agent/testing";

const mockProvider = new MockProvider({
  streamingError: "Mock provider streaming error for testing"
});

const agent = new Agent({ provider: mockProvider });

try {
  for await (const chunk of agent.respondStream({ message: "test" })) {
    // This will throw the configured streaming error
  }
} catch (error) {
  // Error message will be exactly: "Mock provider streaming error for testing"
  expect(error.message).toBe("Mock provider streaming error for testing");
}
```

**Key Points:**
- Streaming errors are thrown from the async generator itself
- Error messages are preserved exactly as configured
- Test logic catches actual provider errors, not test-generated errors

## Route Completion Error Handling

### Proper Route Completion Detection

Routes with conditional steps and `endRoute()` calls require careful completion detection:

```typescript
const route = agent.createRoute({
  title: "Conditional Route",
  requiredFields: ["name", "email"]
});

// Step with skipIf condition
const askName = route.initialStep.nextStep({
  prompt: "What's your name?",
  collect: ["name"],
  skipIf: (data) => !!data.name, // Skip if name already collected
});

// Step that calls endRoute()
const confirmDetails = askName.nextStep({
  prompt: "Confirm your details",
  requires: ["name", "email"],
  onComplete: () => {
    // This step calls endRoute() when complete
    return { endRoute: true };
  }
});

// Check route completion properly
const response = await agent.respond({
  message: "My name is John and email is john@example.com",
  sessionId: "user-123"
});

// Route should be marked complete when all steps are processed
if (response.isRouteComplete) {
  console.log("Route completed successfully");
} else {
  console.log("Route still in progress");
}
```

### Handling Route Completion Edge Cases

```typescript
// Route completion with error handling
const checkRouteCompletion = (route: Route, collectedData: any) => {
  try {
    // Check if all required fields are present
    const missingFields = route.getMissingRequiredFields(collectedData);
    
    if (missingFields.length === 0) {
      // All required data collected
      return { complete: true, reason: "all_data_collected" };
    }
    
    // Check if route explicitly ended
    if (route.hasExplicitEnd()) {
      return { complete: true, reason: "explicit_end" };
    }
    
    // Check if all steps are skipped/completed
    if (route.allStepsProcessed()) {
      return { complete: true, reason: "all_steps_processed" };
    }
    
    return { complete: false, missingFields };
  } catch (error) {
    console.error("Route completion check failed:", error);
    return { complete: false, error: error.message };
  }
};
```

## Agent-Session Data Synchronization

### Bidirectional Data Sync Error Handling

Agent and session data must remain synchronized with proper error handling:

```typescript
class Agent<TContext, TData> {
  async updateCollectedData(updates: Partial<TData>): Promise<void> {
    try {
      // Update agent data
      this.collectedData = { ...this.collectedData, ...updates };
      
      // Sync with session data
      if (this.session) {
        await this.session.setData(this.collectedData);
      }
    } catch (error) {
      // Rollback agent data on session sync failure
      console.error("Failed to sync data with session:", error);
      // Restore previous state
      throw new Error(`Data synchronization failed: ${error.message}`);
    }
  }
  
  getCollectedData(): Partial<TData> {
    try {
      // Ensure session data is in sync
      if (this.session) {
        const sessionData = this.session.getData<TData>();
        if (sessionData && Object.keys(sessionData).length > 0) {
          this.collectedData = { ...this.collectedData, ...sessionData };
        }
      }
      return this.collectedData;
    } catch (error) {
      console.error("Failed to retrieve collected data:", error);
      return this.collectedData; // Return agent data as fallback
    }
  }
}
```

### Session Data Operations with Error Recovery

```typescript
class SessionManager<TData> {
  async setData(data: Partial<TData>): Promise<void> {
    try {
      // Validate data before setting
      if (this.schema) {
        this.validateData(data);
      }
      
      // Update session data
      this.session.data = { ...this.session.data, ...data };
      
      // Sync with agent if available
      if (this.agent) {
        this.agent.collectedData = { ...this.agent.collectedData, ...data };
      }
      
      // Persist changes
      await this.save();
    } catch (error) {
      console.error("Session data update failed:", error);
      // Restore previous session state
      await this.restore();
      throw new Error(`Session data update failed: ${error.message}`);
    }
  }
  
  private async restore(): Promise<void> {
    try {
      // Reload session from persistence
      const restored = await this.adapter.getSession(this.session.id);
      if (restored) {
        this.session = restored;
      }
    } catch (error) {
      console.error("Failed to restore session state:", error);
    }
  }
}
```

## Session History Error Handling

### Chat Method with Proper History Management

```typescript
class Agent<TContext, TData> {
  async chat(message: string, sessionId?: string): Promise<AgentResponse<TData>> {
    try {
      // Ensure session exists
      if (!this.session || this.session.id !== sessionId) {
        await this.loadSession(sessionId);
      }
      
      // Add user message to history BEFORE processing
      await this.session.addMessage("user", message);
      
      // Process the message
      const response = await this.respond({
        message,
        sessionId: this.session.id
      });
      
      // Add assistant response to history
      if (response.message) {
        await this.session.addMessage("assistant", response.message);
      }
      
      return response;
    } catch (error) {
      console.error("Chat method failed:", error);
      
      // Try to remove the user message if response failed
      try {
        await this.session.removeLastMessage("user");
      } catch (rollbackError) {
        console.error("Failed to rollback user message:", rollbackError);
      }
      
      throw new Error(`Chat failed: ${error.message}`);
    }
  }
}
```

### History Persistence with Error Recovery

```typescript
class SessionManager<TData> {
  async addMessage(role: "user" | "assistant", content: string): Promise<void> {
    try {
      const message: HistoryItem = {
        role,
        content,
        timestamp: new Date().toISOString()
      };
      
      // Add to in-memory history
      this.session.history.push(message);
      
      // Persist immediately
      await this.save();
    } catch (error) {
      // Remove from in-memory history on persistence failure
      this.session.history.pop();
      console.error("Failed to persist message:", error);
      throw new Error(`Message persistence failed: ${error.message}`);
    }
  }
  
  async getHistory(): Promise<HistoryItem[]> {
    try {
      // Ensure we have the latest history from persistence
      await this.refresh();
      return this.session.history || [];
    } catch (error) {
      console.error("Failed to retrieve history:", error);
      // Return in-memory history as fallback
      return this.session.history || [];
    }
  }
}
```

## Tool Execution Error Handling

### Graceful Tool Error Recovery

```typescript
import { Tool } from "@falai/agent";

const searchFlights: Tool<Context, [], void, FlightData> = {
  id: "search_flights",
  description: "Search for available flights",
  parameters: {
    type: "object",
    properties: {
      destination: { type: "string" },
      date: { type: "string" }
    },
    required: ["destination", "date"]
  },
  handler: async (toolContext) => {
    try {
      const { data } = toolContext;
      
      // Validate required data
      if (!data.destination || !data.date) {
        return {
          error: "Missing required flight search parameters",
          data: undefined
        };
      }
      
      // Perform search
      const results = await flightSearchAPI.search({
        destination: data.destination,
        date: data.date
      });
      
      return {
        data: "Flight search completed successfully",
        dataUpdate: {
          availableFlights: results,
          searchPerformed: true
        }
      };
    } catch (error) {
      console.error("Flight search failed:", error);
      
      return {
        error: `Flight search failed: ${error.message}`,
        data: "I encountered an error while searching for flights. Please try again.",
        dataUpdate: {
          searchError: error.message,
          searchPerformed: false
        }
      };
    }
  }
};
```

## Validation Error Handling

### Schema Validation with Fallback

```typescript
const validateAndExtractData = <T>(response: string, schema: JSONSchema): T | null => {
  try {
    // Try to extract structured data
    const extracted = extractStructuredData<T>(response, schema);
    
    // Validate against schema
    const validation = validateSchema(extracted, schema);
    
    if (validation.valid) {
      return extracted;
    } else {
      console.warn("Schema validation failed:", validation.errors);
      // Fall back to manual extraction
      return manualExtraction<T>(response);
    }
  } catch (error) {
    console.error("Data extraction failed:", error);
    // Return null to indicate extraction failure
    return null;
  }
};
```

## Error Recovery Strategies

### Automatic Retry with Backoff

```typescript
const retryWithBackoff = async <T>(
  operation: () => Promise<T>,
  maxRetries: number = 3,
  baseDelay: number = 1000
): Promise<T> => {
  let lastError: Error;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error as Error;
      
      if (attempt < maxRetries - 1) {
        const delay = baseDelay * Math.pow(2, attempt);
        console.warn(`Operation failed, retrying in ${delay}ms:`, error.message);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  
  throw new Error(`Operation failed after ${maxRetries} attempts: ${lastError.message}`);
};

// Usage
const response = await retryWithBackoff(
  () => agent.respond({ message: "Hello", sessionId: "user-123" }),
  3,
  1000
);
```

### Circuit Breaker Pattern

```typescript
class CircuitBreaker {
  private failures = 0;
  private lastFailureTime = 0;
  private state: 'closed' | 'open' | 'half-open' = 'closed';
  
  constructor(
    private threshold: number = 5,
    private timeout: number = 60000
  ) {}
  
  async execute<T>(operation: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      if (Date.now() - this.lastFailureTime > this.timeout) {
        this.state = 'half-open';
      } else {
        throw new Error('Circuit breaker is open');
      }
    }
    
    try {
      const result = await operation();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }
  
  private onSuccess(): void {
    this.failures = 0;
    this.state = 'closed';
  }
  
  private onFailure(): void {
    this.failures++;
    this.lastFailureTime = Date.now();
    
    if (this.failures >= this.threshold) {
      this.state = 'open';
    }
  }
}
```

## Best Practices

### Error Logging and Monitoring

```typescript
import { Logger } from "@falai/agent/utils";

const logger = new Logger("agent-errors");

// Structured error logging
const logError = (context: string, error: Error, metadata?: any) => {
  logger.error({
    context,
    message: error.message,
    stack: error.stack,
    metadata,
    timestamp: new Date().toISOString()
  });
};

// Usage in error handlers
try {
  await agent.respond({ message, sessionId });
} catch (error) {
  logError("agent-response", error, { message, sessionId });
  throw error;
}
```

### Error Boundaries for Route Execution

```typescript
const executeRouteWithErrorBoundary = async (route: Route, context: any) => {
  try {
    return await route.execute(context);
  } catch (error) {
    // Log the error
    logError("route-execution", error, { routeId: route.id });
    
    // Provide fallback response
    return {
      message: "I encountered an error processing your request. Please try again.",
      isRouteComplete: false,
      error: error.message
    };
  }
};
```

### Graceful Degradation

```typescript
const respondWithFallback = async (agent: Agent, message: string) => {
  try {
    // Try normal response
    return await agent.respond({ message });
  } catch (error) {
    console.warn("Normal response failed, using fallback:", error.message);
    
    // Fallback to simple response without routing
    return {
      message: "I'm experiencing some technical difficulties. How can I help you?",
      isRouteComplete: false,
      session: agent.session
    };
  }
};
```

## Testing Error Scenarios

### Unit Tests for Error Handling

```typescript
describe("Error Handling", () => {
  it("should handle streaming errors properly", async () => {
    const mockProvider = new MockProvider({
      streamingError: "Test streaming error"
    });
    
    const agent = new Agent({ provider: mockProvider });
    
    await expect(async () => {
      for await (const chunk of agent.respondStream({ message: "test" })) {
        // Should throw before yielding any chunks
      }
    }).rejects.toThrow("Test streaming error");
  });
  
  it("should handle route completion errors", async () => {
    const route = agent.createRoute({
      title: "Test Route",
      requiredFields: ["name"]
    });
    
    // Mock route completion logic to throw
    jest.spyOn(route, 'isComplete').mockImplementation(() => {
      throw new Error("Completion check failed");
    });
    
    const response = await agent.respond({ message: "Hello" });
    
    // Should handle error gracefully
    expect(response.isRouteComplete).toBe(false);
  });
});
```

## Monitoring and Observability

### Error Metrics Collection

```typescript
class ErrorMetrics {
  private errorCounts = new Map<string, number>();
  private errorRates = new Map<string, number[]>();
  
  recordError(type: string, error: Error): void {
    // Count errors by type
    this.errorCounts.set(type, (this.errorCounts.get(type) || 0) + 1);
    
    // Track error rates
    const now = Date.now();
    const rates = this.errorRates.get(type) || [];
    rates.push(now);
    
    // Keep only last hour of data
    const oneHourAgo = now - 3600000;
    this.errorRates.set(type, rates.filter(time => time > oneHourAgo));
  }
  
  getErrorRate(type: string): number {
    const rates = this.errorRates.get(type) || [];
    return rates.length; // Errors per hour
  }
  
  getTopErrors(limit: number = 10): Array<[string, number]> {
    return Array.from(this.errorCounts.entries())
      .sort(([,a], [,b]) => b - a)
      .slice(0, limit);
  }
}
```

This comprehensive error handling documentation covers all the key areas identified in the task requirements, providing practical examples and best practices for handling errors in streaming operations, route completion logic, and agent-session data synchronization.