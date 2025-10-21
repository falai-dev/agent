# Error Handling Patterns

This guide provides practical patterns and examples for handling errors in @fali/agent applications, covering streaming operations, route completion, and data synchronization scenarios.

## Quick Reference

| Error Type | Pattern | Recovery Strategy |
|------------|---------|-------------------|
| Streaming Errors | Proper async generator error propagation | Catch and re-throw with context |
| Route Completion | Defensive completion checking | Fallback to incomplete state |
| Data Sync | Bidirectional rollback | Restore previous consistent state |
| Tool Execution | Graceful degradation | Fallback responses with error context |
| Validation | Schema + manual fallback | Progressive fallback strategies |

## Streaming Error Patterns

### Pattern 1: Provider Error Propagation

**Problem:** Streaming errors from AI providers need to be properly propagated to the application layer.

**Solution:**
```typescript
// ✅ Correct: Proper error propagation in streaming
async function* handleStreamingResponse(provider: AIProvider, prompt: string) {
  try {
    for await (const chunk of provider.generateMessageStream(prompt)) {
      yield { success: true, data: chunk };
    }
  } catch (error) {
    // Log the error but let it propagate
    console.error("Streaming error:", error.message);
    throw error; // Important: re-throw to stop the stream
  }
}

// Usage
try {
  for await (const chunk of handleStreamingResponse(provider, prompt)) {
    if (chunk.success) {
      process.stdout.write(chunk.data);
    }
  }
} catch (error) {
  console.error("Stream failed:", error.message);
  // Handle the error appropriately
}
```

**Anti-pattern:**
```typescript
// ❌ Wrong: Swallowing streaming errors
async function* badStreamingHandler(provider: AIProvider, prompt: string) {
  try {
    for await (const chunk of provider.generateMessageStream(prompt)) {
      yield chunk;
    }
  } catch (error) {
    // Don't do this - error is lost
    yield { error: "Something went wrong" };
  }
}
```

### Pattern 2: MockProvider Testing

**Problem:** Testing streaming error scenarios requires proper error configuration.

**Solution:**
```typescript
// ✅ Correct: MockProvider with proper error testing
import { MockProvider } from "@falai/agent/testing";

describe("Streaming Error Handling", () => {
  it("should propagate streaming errors correctly", async () => {
    const mockProvider = new MockProvider({
      streamingError: "Mock provider streaming error for testing"
    });
    
    const agent = new Agent({ provider: mockProvider });
    
    // Test that the exact error message is propagated
    await expect(async () => {
      for await (const chunk of agent.respondStream({ message: "test" })) {
        // Should throw before yielding any chunks
      }
    }).rejects.toThrow("Mock provider streaming error for testing");
  });
});
```

## Route Completion Patterns

### Pattern 1: Defensive Completion Checking

**Problem:** Route completion logic needs to handle various edge cases including conditional steps and explicit termination.

**Solution:**
```typescript
// ✅ Correct: Comprehensive completion checking
const checkRouteCompletion = (route: Route, collectedData: any) => {
  try {
    // Check 1: All required fields present
    const missingFields = route.getMissingRequiredFields(collectedData);
    if (missingFields.length === 0) {
      return { complete: true, reason: "all_data_collected" };
    }
    
    // Check 2: All steps processed (including skipped ones)
    const allStepsProcessed = route.steps.every(step => {
      // Skipped steps count as processed
      if (step.skipIf && step.skipIf(collectedData)) {
        return true;
      }
      return step.isCompleted;
    });
    
    if (allStepsProcessed) {
      return { complete: true, reason: "all_steps_processed" };
    }
    
    // Check 3: Explicit route termination
    if (route.hasExplicitEnd()) {
      return { complete: true, reason: "explicit_end" };
    }
    
    return { complete: false, missingFields };
    
  } catch (error) {
    console.error("Route completion check failed:", error);
    // Safe fallback - assume incomplete
    return { complete: false, error: error.message };
  }
};
```

### Pattern 2: Conditional Step Handling

**Problem:** Routes with `skipIf` conditions can complete even when steps are skipped.

**Solution:**
```typescript
// ✅ Correct: Handle conditional steps in completion logic
const route = agent.createRoute({
  title: "Smart Booking",
  requiredFields: ["destination", "dates", "passengers"]
});

// Steps with smart skipping
const askDestination = route.initialStep.nextStep({
  prompt: "Where would you like to go?",
  collect: ["destination"],
  skipIf: (data) => !!data.destination, // Skip if already collected
});

const askDates = askDestination.nextStep({
  prompt: "When would you like to travel?", 
  collect: ["dates"],
  skipIf: (data) => !!data.dates,
});

const confirmBooking = askDates.nextStep({
  prompt: "Confirm your booking",
  requires: ["destination", "dates", "passengers"],
  onComplete: () => ({ endRoute: true })
});

// Handle response where all data is collected at once
const response = await agent.respond({
  message: "Book a flight to Tokyo on March 15th for 2 passengers"
});

// Route should be complete even though steps were skipped
console.log("Route complete:", response.isRouteComplete); // Should be true
```

## Data Synchronization Patterns

### Pattern 1: Bidirectional Sync with Rollback

**Problem:** Agent and session data must stay synchronized with proper error recovery.

**Solution:**
```typescript
// ✅ Correct: Bidirectional sync with rollback
class Agent<TContext, TData> {
  async updateCollectedData(updates: Partial<TData>): Promise<void> {
    const previousAgentData = { ...this.collectedData };
    const previousSessionData = this.session ? { ...this.session.getData() } : null;
    
    try {
      // Update agent data first
      this.collectedData = { ...this.collectedData, ...updates };
      
      // Sync with session
      if (this.session) {
        await this.session.setData(this.collectedData);
      }
      
    } catch (error) {
      // Rollback both agent and session data
      this.collectedData = previousAgentData;
      
      if (this.session && previousSessionData) {
        try {
          await this.session.setData(previousSessionData);
        } catch (rollbackError) {
          console.error("Failed to rollback session data:", rollbackError);
        }
      }
      
      throw new Error(`Data synchronization failed: ${error.message}`);
    }
  }
}
```

### Pattern 2: Session History with Persistence

**Problem:** Chat history must be reliably persisted with proper error handling.

**Solution:**
```typescript
// ✅ Correct: Reliable history persistence
class Agent<TContext, TData> {
  async chat(message: string, sessionId?: string): Promise<AgentResponse<TData>> {
    let userMessageAdded = false;
    
    try {
      // Ensure session is loaded
      await this.ensureSession(sessionId);
      
      // Add user message to history BEFORE processing
      await this.session.addMessage("user", message);
      userMessageAdded = true;
      
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
      
      // Rollback user message if it was added
      if (userMessageAdded) {
        try {
          await this.session.removeLastMessage("user");
        } catch (rollbackError) {
          console.error("Failed to rollback user message:", rollbackError);
        }
      }
      
      throw new Error(`Chat failed: ${error.message}`);
    }
  }
}
```

## Tool Execution Patterns

### Pattern 1: Graceful Tool Degradation

**Problem:** Tool failures should not break the conversation flow.

**Solution:**
```typescript
// ✅ Correct: Graceful tool error handling
const searchFlights: Tool<Context, [], void, FlightData> = {
  id: "search_flights",
  description: "Search for available flights",
  parameters: {
    type: "object",
    properties: {
      destination: { type: "string" },
      date: { type: "string" }
    }
  },
  handler: async (toolContext) => {
    try {
      const { data } = toolContext;
      
      // Validate inputs
      if (!data.destination || !data.date) {
        return {
          data: "I need both destination and date to search for flights.",
          error: "Missing required parameters"
        };
      }
      
      // Perform the search
      const results = await flightAPI.search(data.destination, data.date);
      
      return {
        data: `Found ${results.length} flights to ${data.destination}`,
        dataUpdate: { availableFlights: results }
      };
      
    } catch (error) {
      console.error("Flight search failed:", error);
      
      // Provide helpful error message to user
      return {
        data: "I'm having trouble searching for flights right now. Please try again in a moment.",
        error: error.message,
        dataUpdate: { searchError: true }
      };
    }
  }
};
```

### Pattern 2: Tool Retry with Circuit Breaker

**Problem:** External API failures need retry logic with circuit breaking.

**Solution:**
```typescript
// ✅ Correct: Tool with retry and circuit breaker
class ToolExecutor {
  private circuitBreaker = new Map<string, CircuitBreaker>();
  
  async executeTool<T>(tool: Tool, params: any): Promise<T> {
    const breaker = this.getCircuitBreaker(tool.id);
    
    return await breaker.execute(async () => {
      return await this.retryWithBackoff(
        () => tool.handler(params),
        3, // max retries
        1000 // base delay
      );
    });
  }
  
  private async retryWithBackoff<T>(
    operation: () => Promise<T>,
    maxRetries: number,
    baseDelay: number
  ): Promise<T> {
    let lastError: Error;
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error as Error;
        
        if (attempt < maxRetries - 1) {
          const delay = baseDelay * Math.pow(2, attempt);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }
    
    throw lastError;
  }
}
```

## Validation Patterns

### Pattern 1: Progressive Fallback Validation

**Problem:** Schema validation failures need graceful fallback strategies.

**Solution:**
```typescript
// ✅ Correct: Progressive validation fallback
const extractDataWithFallback = async <T>(
  response: string, 
  schema: JSONSchema
): Promise<{ data: T | null; method: string; error?: string }> => {
  
  // Try 1: Schema-based extraction
  try {
    const extracted = await extractWithSchema<T>(response, schema);
    const validation = validateSchema(extracted, schema);
    
    if (validation.valid) {
      return { data: extracted, method: "schema" };
    } else {
      console.warn("Schema validation failed:", validation.errors);
    }
  } catch (error) {
    console.warn("Schema extraction failed:", error.message);
  }
  
  // Try 2: Manual extraction with patterns
  try {
    const manual = await manualExtraction<T>(response);
    return { data: manual, method: "manual" };
  } catch (error) {
    console.warn("Manual extraction failed:", error.message);
  }
  
  // Try 3: LLM-based extraction as last resort
  try {
    const llmExtracted = await llmBasedExtraction<T>(response, schema);
    return { data: llmExtracted, method: "llm" };
  } catch (error) {
    console.error("All extraction methods failed:", error.message);
    return { data: null, method: "none", error: error.message };
  }
};
```

## Error Recovery Strategies

### Strategy 1: Exponential Backoff

```typescript
const withExponentialBackoff = async <T>(
  operation: () => Promise<T>,
  maxRetries: number = 3,
  baseDelay: number = 1000,
  maxDelay: number = 10000
): Promise<T> => {
  let lastError: Error;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error as Error;
      
      if (attempt < maxRetries - 1) {
        const delay = Math.min(
          baseDelay * Math.pow(2, attempt),
          maxDelay
        );
        
        console.warn(`Attempt ${attempt + 1} failed, retrying in ${delay}ms:`, error.message);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  
  throw new Error(`Operation failed after ${maxRetries} attempts: ${lastError.message}`);
};
```

### Strategy 2: Circuit Breaker

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
        throw new Error('Circuit breaker is open - service unavailable');
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

## Testing Error Scenarios

### Unit Test Patterns

```typescript
describe("Error Handling", () => {
  describe("Streaming Errors", () => {
    it("should propagate provider streaming errors", async () => {
      const mockProvider = new MockProvider({
        streamingError: "Test streaming error"
      });
      
      const agent = new Agent({ provider: mockProvider });
      
      await expect(async () => {
        for await (const chunk of agent.respondStream({ message: "test" })) {
          // Should throw before yielding
        }
      }).rejects.toThrow("Test streaming error");
    });
  });
  
  describe("Route Completion", () => {
    it("should handle completion check errors gracefully", async () => {
      const route = createMockRoute();
      
      // Mock completion check to throw
      jest.spyOn(route, 'isComplete').mockImplementation(() => {
        throw new Error("Completion check failed");
      });
      
      const result = checkRouteCompletion(route, {});
      
      expect(result.complete).toBe(false);
      expect(result.error).toBe("Completion check failed");
    });
  });
  
  describe("Data Synchronization", () => {
    it("should rollback on sync failures", async () => {
      const agent = new Agent({ sessionId: "test" });
      const originalData = { name: "John" };
      
      // Set initial data
      await agent.updateCollectedData(originalData);
      
      // Mock session setData to fail
      jest.spyOn(agent.session, 'setData').mockRejectedValue(
        new Error("Persistence failed")
      );
      
      // Attempt update should fail and rollback
      await expect(
        agent.updateCollectedData({ email: "john@example.com" })
      ).rejects.toThrow("Data synchronization failed");
      
      // Data should be rolled back
      expect(agent.getCollectedData()).toEqual(originalData);
    });
  });
});
```

## Best Practices Summary

1. **Always propagate streaming errors** - Don't swallow them in generators
2. **Use defensive completion checking** - Handle all edge cases gracefully
3. **Implement bidirectional rollback** - Keep agent and session data consistent
4. **Provide fallback responses** - Never leave users without feedback
5. **Log errors with context** - Include relevant metadata for debugging
6. **Test error scenarios** - Cover all failure modes in your tests
7. **Use circuit breakers** - Protect against cascading failures
8. **Implement progressive fallbacks** - Multiple recovery strategies
9. **Monitor error rates** - Track and alert on error patterns
10. **Document error handling** - Make error behavior clear to users

## Further Reading

- [Core Error Handling](../core/error-handling.md) - Comprehensive error handling reference
- [Response Processing](../core/ai-integration/response-processing.md) - AI response error handling
- [Session Management](../core/agent/session-management.md) - Session error patterns
- [Route Management](../core/conversation-flows/routes.md) - Route completion error handling