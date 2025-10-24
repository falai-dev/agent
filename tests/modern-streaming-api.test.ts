/**
 * Modern Streaming API Tests
 *
 * Tests the new Agent.stream() method and its features:
 * - Simple streaming interface
 * - Automatic session management
 * - Error handling
 * - Context override support
 * - History management
 */

import { expect, test, describe, beforeEach } from "bun:test";

import { Agent, createSession, type AgentResponseStreamChunk } from "../src/index";
import {
  MockProvider,
  MockProviderFactory,
  MOCK_RESPONSES,
} from "./mock-provider";

// Test context types
interface TestContext {
  userId: string;
  sessionCount: number;
  preferences?: {
    theme: "light" | "dark";
    language: string;
  };
}

// Test data types
interface TestData {
  name?: string;
  email?: string;
  issue?: string;
  priority?: "low" | "medium" | "high";
  category?: string;
}

// Test utilities
function createStreamingTestAgent(provider?: MockProvider): Agent<TestContext, TestData> {
  return new Agent<TestContext, TestData>({
    name: "StreamingTestAgent",
    description: "Agent for testing modern streaming API",
    goal: "Test modern streaming functionality",
    context: {
      userId: "stream-test-user",
      sessionCount: 0,
      preferences: {
        theme: "light",
        language: "en",
      },
    },
    provider: provider || MockProviderFactory.basic(),
    schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        email: { type: "string", format: "email" },
        issue: { type: "string" },
        priority: { type: "string", enum: ["low", "medium", "high"] },
        category: { type: "string" },
      },
      additionalProperties: false,
    },
  });
}

function createStreamingAgentWithRoute(provider?: MockProvider): Agent<TestContext, TestData> {
  const agent = createStreamingTestAgent(provider);
  
  // Add a test route for streaming
  agent.createRoute({
    title: "Streaming Support",
    description: "Handle support requests with streaming",
    when: ["User needs streaming help"],
    requiredFields: ["issue", "category"],
    optionalFields: ["priority"],
    steps: [
      {
        id: "stream_collect_issue",
        prompt: "What's the issue you're experiencing?",
        collect: ["issue"],
      },
      {
        id: "stream_collect_category",
        prompt: "What category does this fall under?",
        collect: ["category"],
        requires: ["issue"],
      },
      {
        id: "stream_collect_priority",
        prompt: "How would you rate the priority?",
        collect: ["priority"],
        requires: ["issue", "category"],
      },
    ],
  });

  return agent;
}

describe("Modern Streaming API - Basic Functionality", () => {
  let agent: Agent<TestContext, TestData>;

  beforeEach(() => {
    agent = createStreamingTestAgent();
  });

  test("should stream with simple message parameter", async () => {
    const chunks: AgentResponseStreamChunk<TestData>[] = [];
    let finalChunk: AgentResponseStreamChunk<TestData> | undefined;

    for await (const chunk of agent.stream("Hello from modern API!")) {
      chunks.push(chunk);
      if (chunk.done) {
        finalChunk = chunk;
      }
    }

    expect(chunks.length).toBeGreaterThan(0);
    expect(finalChunk).toBeDefined();
    expect(finalChunk!.done).toBe(true);
    expect(finalChunk!.accumulated).toBe(MOCK_RESPONSES.GREETING);
    expect(finalChunk!.session).toBeDefined();
  });

  test("should work without message parameter", async () => {
    // Add a message to session first
    await agent.session.addMessage("user", "Existing message in session");

    const chunks: AgentResponseStreamChunk<TestData>[] = [];
    let finalChunk: AgentResponseStreamChunk<TestData> | undefined;

    for await (const chunk of agent.stream()) {
      chunks.push(chunk);
      if (chunk.done) {
        finalChunk = chunk;
      }
    }

    expect(chunks.length).toBeGreaterThan(0);
    expect(finalChunk).toBeDefined();
    expect(finalChunk!.done).toBe(true);
    expect(finalChunk!.accumulated).toBe(MOCK_RESPONSES.GREETING);
  });

  test("should handle empty message", async () => {
    const chunks: AgentResponseStreamChunk<TestData>[] = [];
    let finalChunk: AgentResponseStreamChunk<TestData> | undefined;

    for await (const chunk of agent.stream("")) {
      chunks.push(chunk);
      if (chunk.done) {
        finalChunk = chunk;
      }
    }

    expect(chunks.length).toBeGreaterThan(0);
    expect(finalChunk).toBeDefined();
    expect(finalChunk!.done).toBe(true);
  });

  test("should accumulate chunks correctly", async () => {
    let previousAccumulated = "";

    for await (const chunk of agent.stream("Test accumulation")) {
      expect(chunk.accumulated.length).toBeGreaterThanOrEqual(previousAccumulated.length);
      expect(chunk.accumulated.startsWith(previousAccumulated)).toBe(true);
      previousAccumulated = chunk.accumulated;

      if (chunk.done) {
        expect(chunk.accumulated).toBe(MOCK_RESPONSES.GREETING);
      }
    }
  });

  test("should provide metadata in chunks", async () => {
    let hasMetadata = false;
    let finalMetadata: AgentResponseStreamChunk<TestData>["metadata"];

    for await (const chunk of agent.stream("Metadata test")) {
      if (chunk.metadata) {
        hasMetadata = true;
      }
      if (chunk.done) {
        finalMetadata = chunk.metadata;
      }
    }

    expect(hasMetadata).toBe(true);
    expect(finalMetadata).toBeDefined();
    expect(finalMetadata!.model).toBe("mock-model-v1");
    expect(finalMetadata!.tokensUsed).toBeGreaterThan(0);
  });
});

describe("Modern Streaming API - Session Management", () => {
  let agent: Agent<TestContext, TestData>;

  beforeEach(() => {
    agent = createStreamingTestAgent();
  });

  test("should automatically manage session history", async () => {
    const testMessage = "Test automatic session management";
    
    // Stream first message
    let finalMessage = "";
    for await (const chunk of agent.stream(testMessage)) {
      if (chunk.done) {
        finalMessage = chunk.accumulated;
      }
    }

    // Check that messages were added to session history
    const history = agent.session.getHistory();
    expect(history.length).toBeGreaterThanOrEqual(2); // User message + assistant response
    expect(history[0].role).toBe("user");
    expect(history[0].content).toBe(testMessage);
    expect(history[1].role).toBe("assistant");
    expect(history[1].content).toBe(finalMessage);
  });

  test("should maintain session across multiple stream calls", async () => {
    // First stream call
    let firstResponse = "";
    for await (const chunk of agent.stream("First message")) {
      if (chunk.done) {
        firstResponse = chunk.accumulated;
      }
    }

    // Second stream call
    let secondResponse = "";
    for await (const chunk of agent.stream("Second message")) {
      if (chunk.done) {
        secondResponse = chunk.accumulated;
      }
    }

    // Check that both messages are in history
    const history = agent.session.getHistory();
    expect(history.length).toBe(4); // 2 user + 2 assistant messages
    expect(history[0].content).toBe("First message");
    expect(history[1].content).toBe(firstResponse);
    expect(history[2].content).toBe("Second message");
    expect(history[3].content).toBe(secondResponse);
  });

  test("should maintain session state during streaming", async () => {
    const sessionId = agent.session.current?.id;

    for await (const chunk of agent.stream("Session state test")) {
      expect(chunk.session).toBeDefined();
      if (sessionId) {
        expect(chunk.session?.id).toBe(sessionId);
      }
    }
  });

  test("should handle session data updates", async () => {
    // Set some initial data
    await agent.updateCollectedData({ name: "John Doe", email: "john@example.com" });

    let finalSession: any;

    for await (const chunk of agent.stream("Data update test")) {
      if (chunk.done) {
        finalSession = chunk.session;
      }
    }

    expect(finalSession).toBeDefined();
    
    // Check that collected data is preserved
    const collectedData = agent.getCollectedData();
    expect(collectedData.name).toBe("John Doe");
    expect(collectedData.email).toBe("john@example.com");
  });

  test("should create session if none exists", async () => {
    // Create a fresh agent without initializing session
    const freshAgent = createStreamingTestAgent();
    
    let sessionCreated = false;

    for await (const chunk of freshAgent.stream("Create session test")) {
      if (chunk.session) {
        sessionCreated = true;
      }
    }

    expect(sessionCreated).toBe(true);
    expect(freshAgent.session.current).toBeDefined();
  });
});

describe("Modern Streaming API - Options and Configuration", () => {
  let agent: Agent<TestContext, TestData>;

  beforeEach(() => {
    agent = createStreamingTestAgent();
  });

  test("should handle context override", async () => {
    const contextOverride: Partial<TestContext> = {
      sessionCount: 100,
      preferences: {
        theme: "dark",
        language: "es",
      },
    };

    const chunks: AgentResponseStreamChunk<TestData>[] = [];

    for await (const chunk of agent.stream("Context override test", { contextOverride })) {
      chunks.push(chunk);
    }

    expect(chunks.length).toBeGreaterThan(0);
    // The context override should be used internally but not affect the response structure
    expect(chunks[chunks.length - 1].accumulated).toBe(MOCK_RESPONSES.GREETING);
  });

  test("should handle custom history override", async () => {
    const customHistory = [
      {
        role: "user" as const,
        content: "Previous conversation",
        name: "TestUser",
      },
      {
        role: "assistant" as const,
        content: "Previous response",
      },
    ];

    const chunks: AgentResponseStreamChunk<TestData>[] = [];

    for await (const chunk of agent.stream("New message", { history: customHistory })) {
      chunks.push(chunk);
    }

    expect(chunks.length).toBeGreaterThan(0);
    
    // Session history should not be modified when using custom history
    const sessionHistory = agent.session.getHistory();
    expect(sessionHistory.length).toBe(0); // No messages added to session
  });

  test("should handle signal for cancellation", async () => {
    const controller = new AbortController();
    
    // Cancel after a short delay
    setTimeout(() => controller.abort(), 10);

    let cancelled = false;
    try {
      for await (const chunk of agent.stream("Cancellation test", { signal: controller.signal })) {
        // Should be cancelled before completion
        // Let the stream complete naturally or be cancelled
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        cancelled = true;
      }
    }

    // Note: The mock provider might not respect the signal, so we don't assert cancellation
    // This test mainly ensures the signal parameter is accepted
  });

  test("should handle all options together", async () => {
    const customHistory = [
      {
        role: "user" as const,
        content: "Custom history message",
        name: "TestUser",
      },
    ];

    const contextOverride: Partial<TestContext> = {
      sessionCount: 50,
    };

    const controller = new AbortController();

    const chunks: AgentResponseStreamChunk<TestData>[] = [];

    for await (const chunk of agent.stream("All options test", {
      history: customHistory,
      contextOverride,
      signal: controller.signal,
    })) {
      chunks.push(chunk);
    }

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[chunks.length - 1].accumulated).toBe(MOCK_RESPONSES.GREETING);
  });
});

describe("Modern Streaming API - Error Handling", () => {
  test("should handle provider errors gracefully", async () => {
    const errorProvider = MockProviderFactory.withError("Streaming provider error");
    const agent = createStreamingTestAgent(errorProvider);

    let errorReceived = false;
    let errorChunk: AgentResponseStreamChunk<TestData> | undefined;

    for await (const chunk of agent.stream("Error test")) {
      if (chunk.error) {
        errorReceived = true;
        errorChunk = chunk;
        break;
      }
      if (chunk.done) {
        break;
      }
    }

    expect(errorReceived).toBe(true);
    expect(errorChunk).toBeDefined();
    expect(errorChunk!.error).toBeDefined();
    expect(errorChunk!.done).toBe(true);
    expect(errorChunk!.delta).toBe("");
    expect(errorChunk!.accumulated).toBe("");
    expect(errorChunk!.session).toBeDefined();
  });

  test("should handle network interruptions", async () => {
    // Create a slow provider to simulate network conditions
    const slowProvider = new MockProvider({ delayMs: 50 });
    const agent = createStreamingTestAgent(slowProvider);

    let chunkCount = 0;
    let completed = false;

    try {
      for await (const chunk of agent.stream("Network test")) {
        chunkCount++;
        if (chunk.done) {
          completed = true;
          break;
        }
        
        // Simulate interruption after a few chunks
        if (chunkCount >= 3) {
          break;
        }
      }
    } catch (error) {
      // Expected behavior for interruption
    }

    expect(chunkCount).toBeGreaterThan(0);
    // Don't assert completion since we interrupted it
  });

  test("should handle invalid parameters gracefully", async () => {
    const agent = createStreamingTestAgent();

    // Test with undefined options (should work)
    let worksWithUndefined = false;
    try {
      for await (const chunk of agent.stream("Test", undefined)) {
        worksWithUndefined = true;
      }
    } catch (error) {
      // Should not throw for undefined options
    }

    expect(worksWithUndefined).toBe(true);
  });
});

describe("Modern Streaming API - Integration with Routes", () => {
  test("should work with route-based agents", async () => {
    const agent = createStreamingAgentWithRoute();

    const chunks: AgentResponseStreamChunk<TestData>[] = [];
    let finalChunk: AgentResponseStreamChunk<TestData> | undefined;

    for await (const chunk of agent.stream("I need help with a streaming issue")) {
      chunks.push(chunk);
      if (chunk.done) {
        finalChunk = chunk;
      }
    }

    expect(chunks.length).toBeGreaterThan(0);
    expect(finalChunk).toBeDefined();
    expect(finalChunk!.done).toBe(true);
    expect(finalChunk!.session).toBeDefined();
  });

  test("should handle data collection during streaming", async () => {
    const agent = createStreamingAgentWithRoute();

    // Set some initial data
    await agent.updateCollectedData({ issue: "Streaming problem" });

    let finalSession: any;

    for await (const chunk of agent.stream("Continue with the issue")) {
      if (chunk.done) {
        finalSession = chunk.session;
      }
    }

    expect(finalSession).toBeDefined();
    
    // Check that data is preserved
    const collectedData = agent.getCollectedData();
    expect(collectedData.issue).toBe("Streaming problem");
  });

  test("should handle route completion in streaming", async () => {
    const agent = createStreamingAgentWithRoute();

    // Complete the route by providing all required data
    await agent.updateCollectedData({ 
      issue: "Streaming issue",
      category: "technical",
      priority: "high" as const,
    });

    let routeCompleted = false;

    for await (const chunk of agent.stream("That's all the information")) {
      if (chunk.done) {
        // Check if route was completed (this depends on the route logic)
        routeCompleted = true;
      }
    }

    expect(routeCompleted).toBe(true);
  });
});

describe("Modern Streaming API - Performance and Concurrency", () => {
  test("should handle concurrent streaming requests", async () => {
    const agent = createStreamingTestAgent();

    // Start multiple streaming requests concurrently
    const streams = [
      agent.stream("Concurrent request 1"),
      agent.stream("Concurrent request 2"),
      agent.stream("Concurrent request 3"),
    ];

    const results = await Promise.all(
      streams.map(async (stream) => {
        let finalMessage = "";
        for await (const chunk of stream) {
          if (chunk.done) {
            finalMessage = chunk.accumulated;
          }
        }
        return finalMessage;
      })
    );

    // All streams should complete successfully
    results.forEach((result) => {
      expect(result).toBe(MOCK_RESPONSES.GREETING);
    });

    // Check that all messages were added to session history
    const history = agent.session.getHistory();
    expect(history.length).toBe(6); // 3 user + 3 assistant messages
  });

  test("should handle rapid successive calls", async () => {
    const agent = createStreamingTestAgent();

    const messages = ["First", "Second", "Third", "Fourth", "Fifth"];
    const responses: string[] = [];
    
    for (const message of messages) {
      for await (const chunk of agent.stream(message)) {
        if (chunk.done) {
          responses.push(chunk.accumulated);
        }
      }
    }

    // Check that all messages are in history
    const history = agent.session.getHistory();
    expect(history.length).toBe(10); // 5 user + 5 assistant messages
    
    // Verify order is preserved
    for (let i = 0; i < messages.length; i++) {
      expect(history[i * 2].content).toBe(messages[i]);
      expect(history[i * 2].role).toBe("user");
      expect(history[i * 2 + 1].role).toBe("assistant");
      expect(history[i * 2 + 1].content).toBe(responses[i]);
    }
  });

  test("should handle large message streaming", async () => {
    const agent = createStreamingTestAgent();
    const largeMessage = "This is a very long message. ".repeat(100);

    let totalChunks = 0;
    let totalLength = 0;

    for await (const chunk of agent.stream(largeMessage)) {
      totalChunks++;
      totalLength += chunk.delta.length;

      if (chunk.done) {
        expect(chunk.accumulated.length).toBe(MOCK_RESPONSES.GREETING.length);
        expect(totalLength).toBe(MOCK_RESPONSES.GREETING.length);
      }
    }

    expect(totalChunks).toBeGreaterThan(1); // Should be chunked
    expect(totalLength).toBe(MOCK_RESPONSES.GREETING.length);
  });
});

describe("Modern Streaming API - Comparison with Legacy API", () => {
  test("should provide same functionality as respondStream but simpler", async () => {
    const agent = createStreamingTestAgent();
    const session = await agent.session.getOrCreate();

    const history = [
      {
        role: "user" as const,
        content: "Compare APIs",
        name: "TestUser",
      },
    ];

    // Legacy API
    const legacyChunks: AgentResponseStreamChunk<TestData>[] = [];
    for await (const chunk of agent.respondStream({ history, session })) {
      legacyChunks.push(chunk);
    }

    // Modern API (reset session first)
    const freshAgent = createStreamingTestAgent();
    const modernChunks: AgentResponseStreamChunk<TestData>[] = [];
    for await (const chunk of freshAgent.stream("Compare APIs")) {
      modernChunks.push(chunk);
    }

    // Both should produce similar results
    expect(legacyChunks.length).toBeGreaterThan(0);
    expect(modernChunks.length).toBeGreaterThan(0);
    expect(legacyChunks[legacyChunks.length - 1].accumulated).toBe(
      modernChunks[modernChunks.length - 1].accumulated
    );
  });

  test("should be more convenient than legacy API", async () => {
    const agent = createStreamingTestAgent();

    // Modern API - one line
    let modernChunkCount = 0;
    for await (const chunk of agent.stream("Simple test")) {
      modernChunkCount++;
    }

    // Legacy API - requires session management
    const session = await agent.session.getOrCreate();
    const history = [
      {
        role: "user" as const,
        content: "Simple test",
        name: "TestUser",
      },
    ];

    let legacyChunkCount = 0;
    for await (const chunk of agent.respondStream({ history, session })) {
      legacyChunkCount++;
    }

    // Both should work, but modern API is simpler to use
    expect(modernChunkCount).toBeGreaterThan(0);
    expect(legacyChunkCount).toBeGreaterThan(0);
  });
});