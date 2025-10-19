/**
 * Streaming Response Tests
 *
 * Tests streaming functionality including async generators,
 * real-time responses, chunk processing, and error handling.
 */
import { expect, test, describe } from "bun:test";

import { Agent, createSession, AgentResponseStreamChunk } from "../src/index";
import {
  MockProvider,
  MockProviderFactory,
  MOCK_RESPONSES,
} from "./mock-provider";

// Test utilities
function createStreamingTestAgent(provider?: MockProvider): Agent {
  return new Agent({
    name: "StreamingTestAgent",
    description: "Agent for testing streaming functionality",
    provider: provider || MockProviderFactory.basic(),
  });
}

function createSlowProvider(delayMs: number = 50): MockProvider {
  return new MockProvider({
    responseMessage:
      "This is a slow streaming response with multiple words to test chunking.",
    delayMs,
  });
}

describe("Basic Streaming Functionality", () => {
  test("should stream basic response", async () => {
    const agent = createStreamingTestAgent();
    const session = createSession();

    const history = [
      {
        role: "user" as const,
        content: "Hello",
        name: "TestUser",
      },
    ];

    const chunks: string[] = [];
    let chunkCount = 0;
    let finalChunk: AgentResponseStreamChunk | undefined;

    for await (const chunk of agent.respondStream({ history, session })) {
      chunks.push(chunk.delta);
      chunkCount++;

      if (chunk.done) {
        finalChunk = chunk;
      }
    }

    expect(chunkCount).toBeGreaterThan(0);
    expect(chunks.length).toBeGreaterThan(0);
    expect(finalChunk).toBeDefined();
    expect(finalChunk!.done).toBe(true);
    expect(finalChunk!.session).toBeDefined();
    expect(finalChunk!.accumulated).toBe(MOCK_RESPONSES.GREETING);
  });

  test("should accumulate chunks correctly", async () => {
    const agent = createStreamingTestAgent();
    const session = createSession();

    const history = [
      {
        role: "user" as const,
        content: "Tell me something",
        name: "TestUser",
      },
    ];

    let previousAccumulated = "";

    for await (const chunk of agent.respondStream({ history, session })) {
      // Each chunk should add to the accumulation
      expect(chunk.accumulated.length).toBeGreaterThanOrEqual(
        previousAccumulated.length
      );
      expect(chunk.accumulated.startsWith(previousAccumulated)).toBe(true);

      previousAccumulated = chunk.accumulated;

      if (chunk.done) {
        expect(chunk.accumulated).toBe(MOCK_RESPONSES.GREETING);
      }
    }
  });

  test("should handle empty responses", async () => {
    const emptyProvider = MockProviderFactory.withResponse("");
    const agent = createStreamingTestAgent(emptyProvider);
    const session = createSession();

    const history = [
      {
        role: "user" as const,
        content: "Test",
        name: "TestUser",
      },
    ];

    const chunks: string[] = [];
    let finalChunk: AgentResponseStreamChunk;

    for await (const chunk of agent.respondStream({ history, session })) {
      chunks.push(chunk.delta);

      if (chunk.done) {
        finalChunk = chunk;
      }
    }

    expect(chunks).toEqual([""]); // Single empty chunk
    expect(finalChunk!.accumulated).toBe("");
    expect(finalChunk!.done).toBe(true);
  });
});

describe("Streaming with Different Providers", () => {
  test("should stream with custom response", async () => {
    const customMessage =
      "This is a custom streaming response for testing purposes.";
    const customProvider = MockProviderFactory.withResponse(customMessage);
    const agent = createStreamingTestAgent(customProvider);
    const session = createSession();

    const history = [
      {
        role: "user" as const,
        content: "Custom test",
        name: "TestUser",
      },
    ];

    let fullMessage = "";
    let chunkCount = 0;

    for await (const chunk of agent.respondStream({ history, session })) {
      fullMessage += chunk.delta;
      chunkCount++;

      if (chunk.done) {
        expect(chunk.accumulated).toBe(customMessage);
        expect(fullMessage).toBe(customMessage);
      }
    }

    expect(chunkCount).toBeGreaterThan(0);
  });

  test("should handle slow streaming responses", async () => {
    const slowProvider = createSlowProvider(10); // 10ms delay per chunk
    const agent = createStreamingTestAgent(slowProvider);
    const session = createSession();

    const history = [
      {
        role: "user" as const,
        content: "Slow test",
        name: "TestUser",
      },
    ];

    const startTime = Date.now();
    let chunkCount = 0;

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of agent.respondStream({ history, session })) {
      chunkCount++;
    }

    const endTime = Date.now();
    const duration = endTime - startTime;

    // Should take at least some time due to delays
    expect(duration).toBeGreaterThan(0);
    expect(chunkCount).toBeGreaterThan(0);
  });

  test("should handle streaming errors", async () => {
    const errorProvider = MockProviderFactory.withError("Streaming failed");
    const agent = createStreamingTestAgent(errorProvider);
    const session = createSession();

    const history = [
      {
        role: "user" as const,
        content: "Error test",
        name: "TestUser",
      },
    ];

    let errorThrown = false;
    try {
      const stream = agent.respondStream({ history, session });
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of stream) {
        // Should not reach here
        throw new Error("Expected streaming to throw an error");
      }
    } catch (error) {
      errorThrown = true;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        "Mock provider streaming error for testing"
      );
    }
    expect(errorThrown).toBe(true);
  });
});

describe("Streaming Session Management", () => {
  test("should maintain session state during streaming", async () => {
    const agent = createStreamingTestAgent();
    const session = createSession();

    const history = [
      {
        role: "user" as const,
        content: "Session test",
        name: "TestUser",
      },
    ];

    let finalChunk: AgentResponseStreamChunk;

    for await (const chunk of agent.respondStream({ history, session })) {
      // Session should be available in each chunk
      expect(chunk.session).toBeDefined();
      expect(chunk.session?.id).toBe(session.id);

      if (chunk.done) {
        finalChunk = chunk;
      }
    }

    expect(finalChunk!.session?.id).toBe(session.id);
  });

  test("should update session data during streaming", async () => {
    const agent = createStreamingTestAgent();
    const session = createSession();

    // Pre-populate session with data
    session.data = { initialValue: "test" };

    const history = [
      {
        role: "user" as const,
        content: "Data test",
        name: "TestUser",
      },
    ];

    let finalChunk: AgentResponseStreamChunk;

    for await (const chunk of agent.respondStream({ history, session })) {
      if (chunk.done) {
        finalChunk = chunk;
      }
    }

    expect(
      (finalChunk!.session?.data as { initialValue?: string })?.initialValue
    ).toBe("test");
  });

  test("should handle route progression in streaming", async () => {
    const routeProvider = MockProviderFactory.forRoute(
      "test-route",
      "test-step"
    );
    const agent = createStreamingTestAgent(routeProvider);
    const session = createSession();

    const history = [
      {
        role: "user" as const,
        content: "Route test",
        name: "TestUser",
      },
    ];

    let finalChunk;

    for await (const chunk of agent.respondStream({ history, session })) {
      if (chunk.done) {
        finalChunk = chunk;
      }
    }

    // The mock provider returns route data in structured response,
    // but without actual routes defined on the agent, no routing occurs
    expect(finalChunk.structured?.route).toBe("test-route");
    expect(finalChunk.structured?.step).toBe("test-step");
  });
});

describe("Streaming Chunk Processing", () => {
  test("should process chunks incrementally", async () => {
    const message = "This is a test message with multiple words.";
    const provider = MockProviderFactory.withResponse(message);
    const agent = createStreamingTestAgent(provider);
    const session = createSession();

    const history = [
      {
        role: "user" as const,
        content: "Chunk test",
        name: "TestUser",
      },
    ];

    const receivedChunks: string[] = [];
    let totalLength = 0;

    for await (const chunk of agent.respondStream({ history, session })) {
      receivedChunks.push(chunk.delta);
      totalLength += chunk.delta.length;

      // Each chunk should be a non-empty string (except possibly the last)
      if (!chunk.done) {
        expect(chunk.delta.length).toBeGreaterThan(0);
      }

      // Accumulated length should match total received
      expect(chunk.accumulated.length).toBe(totalLength);
    }

    // Total accumulated should equal original message
    const finalAccumulated = receivedChunks.join("");
    expect(finalAccumulated).toBe(message);
  });

  test("should handle metadata in chunks", async () => {
    const agent = createStreamingTestAgent();
    const session = createSession();

    const history = [
      {
        role: "user" as const,
        content: "Metadata test",
        name: "TestUser",
      },
    ];

    let hasMetadata = false;
    let finalMetadata: AgentResponseStreamChunk["metadata"];

    for await (const chunk of agent.respondStream({ history, session })) {
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

  test("should handle structured data in final chunk", async () => {
    const structuredResponse = {
      message: "Structured response",
      route: "test-route",
      step: "test-step",
      toolCalls: [
        {
          toolName: "test_tool",
          arguments: { param: "value" },
        },
      ],
    };

    const provider = MockProviderFactory.withResponse(
      "Test message",
      structuredResponse
    );
    const agent = createStreamingTestAgent(provider);
    const session = createSession();

    const history = [
      {
        role: "user" as const,
        content: "Structured test",
        name: "TestUser",
      },
    ];

    let finalChunk: AgentResponseStreamChunk;

    for await (const chunk of agent.respondStream({ history, session })) {
      // Only final chunk should have structured data
      if (!chunk.done) {
        expect(chunk.structured).toBeUndefined();
      } else {
        finalChunk = chunk;
      }
    }

    expect(finalChunk!.structured).toBeDefined();
    expect(finalChunk!.structured!.message).toBe("Structured response");
    expect(finalChunk!.structured!.route).toBe("test-route");
    expect(finalChunk!.structured!.toolCalls).toHaveLength(1);
  });
});

describe("Streaming Error Handling and Edge Cases", () => {
  test("should handle abrupt stream termination", async () => {
    const agent = createStreamingTestAgent();
    const session = createSession();

    const history = [
      {
        role: "user" as const,
        content: "Termination test",
        name: "TestUser",
      },
    ];

    let chunkCount = 0;
    let terminated = false;

    try {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of agent.respondStream({ history, session })) {
        chunkCount++;

        // Simulate external termination condition
        if (chunkCount >= 2) {
          terminated = true;
          break;
        }
      }
    } catch (error) {
      // This is expected if the stream doesn't handle termination gracefully
      expect(error).toBeDefined();
    }

    expect(chunkCount).toBeGreaterThan(0);
    expect(terminated).toBe(true);
  });

  test("should handle very long messages", async () => {
    const longMessage = "This is a very long message. ".repeat(10);
    const provider = MockProviderFactory.withResponse(longMessage);
    const agent = createStreamingTestAgent(provider);
    const session = createSession();

    const history = [
      {
        role: "user" as const,
        content: "Long message test",
        name: "TestUser",
      },
    ];

    let totalChunks = 0;
    let totalLength = 0;

    for await (const chunk of agent.respondStream({ history, session })) {
      totalChunks++;
      totalLength += chunk.delta.length;

      if (chunk.done) {
        expect(chunk.accumulated.length).toBe(longMessage.length);
        expect(totalLength).toBe(longMessage.length);
      }
    }

    expect(totalChunks).toBeGreaterThan(1); // Should be chunked
    expect(totalLength).toBe(longMessage.length);
  });

  test("should handle special characters in streaming", async () => {
    const specialMessage = "Special chars: àáâãäå, 中文, русский, 🚀💻🎉";
    const provider = MockProviderFactory.withResponse(specialMessage);
    const agent = createStreamingTestAgent(provider);
    const session = createSession();

    const history = [
      {
        role: "user" as const,
        content: "Special chars test",
        name: "TestUser",
      },
    ];

    let accumulated = "";

    for await (const chunk of agent.respondStream({ history, session })) {
      accumulated += chunk.delta;

      if (chunk.done) {
        expect(chunk.accumulated).toBe(specialMessage);
        expect(accumulated).toBe(specialMessage);
      }
    }

    // Verify special characters are preserved
    expect(accumulated).toContain("àáâãäå");
    expect(accumulated).toContain("中文");
    expect(accumulated).toContain("русский");
    expect(accumulated).toContain("🚀💻🎉");
  });
});

describe("Streaming Performance and Resource Management", () => {
  test("should handle concurrent streaming requests", async () => {
    const agent = createStreamingTestAgent();
    const session1 = createSession("concurrent-1");
    const session2 = createSession("concurrent-2");
    const session3 = createSession("concurrent-3");

    const history = [
      {
        role: "user" as const,
        content: "Concurrent test",
        name: "TestUser",
      },
    ];

    // Start multiple streaming requests concurrently
    const streams = [
      agent.respondStream({ history, session: session1 }),
      agent.respondStream({ history, session: session2 }),
      agent.respondStream({ history, session: session3 }),
    ];

    const results = await Promise.all(
      streams.map(async (stream) => {
        const chunks: string[] = [];
        for await (const chunk of stream) {
          chunks.push(chunk.delta);
          if (chunk.done) {
            return chunks.join("");
          }
        }
        return "";
      })
    );

    // All streams should complete successfully
    results.forEach((result) => {
      expect(result).toBe(MOCK_RESPONSES.GREETING);
    });
  });

  test("should handle memory efficiently with large streams", async () => {
    const largeMessage = "Large message. ".repeat(50);
    const provider = MockProviderFactory.withResponse(largeMessage);
    const agent = createStreamingTestAgent(provider);
    const session = createSession();

    const history = [
      {
        role: "user" as const,
        content: "Large stream test",
        name: "TestUser",
      },
    ];

    let peakMemoryUsage = 0;
    const chunks: string[] = [];

    for await (const chunk of agent.respondStream({ history, session })) {
      chunks.push(chunk.delta);

      // Track memory usage (simplified)
      const currentUsage = JSON.stringify(chunks).length;
      peakMemoryUsage = Math.max(peakMemoryUsage, currentUsage);

      // Ensure we don't accumulate too much in memory
      if (chunks.length > 10) {
        // In a real implementation, you might want to process and release chunks
        chunks.shift();
      }
    }

    expect(peakMemoryUsage).toBeGreaterThan(0);
    expect(chunks.length).toBeGreaterThan(0);
  });

  test("should handle backpressure in streaming", async () => {
    const slowProvider = createSlowProvider(20);
    const agent = createStreamingTestAgent(slowProvider);
    const session = createSession();

    const history = [
      {
        role: "user" as const,
        content: "Backpressure test",
        name: "TestUser",
      },
    ];

    let processingTime = 0;
    const startTime = Date.now();

    for await (const chunk of agent.respondStream({ history, session })) {
      // Simulate processing time for each chunk
      await new Promise((resolve) => setTimeout(resolve, 5));
      processingTime += 5;

      if (chunk.done) {
        const totalTime = Date.now() - startTime;
        // Total time should be at least the sum of provider delays + processing time
        expect(totalTime).toBeGreaterThanOrEqual(processingTime);
      }
    }
  });
});

describe("Streaming Integration with Agent Features", () => {
  test("should integrate streaming with tool calls", async () => {
    const toolCalls = [
      {
        toolName: "search_database",
        arguments: { query: "test query" },
      },
      {
        toolName: "format_results",
        arguments: { format: "json" },
      },
    ];

    const provider = MockProviderFactory.withToolCalls(toolCalls);
    const agent = createStreamingTestAgent(provider);
    const session = createSession();

    const history = [
      {
        role: "user" as const,
        content: "Tool integration test",
        name: "TestUser",
      },
    ];

    let finalChunk: AgentResponseStreamChunk;

    for await (const chunk of agent.respondStream({ history, session })) {
      if (chunk.done) {
        finalChunk = chunk;
      }
    }

    expect(finalChunk!.structured?.toolCalls).toHaveLength(2);
    expect(finalChunk!.structured?.toolCalls![0].toolName).toBe(
      "search_database"
    );
    expect(finalChunk!.structured?.toolCalls![1].toolName).toBe(
      "format_results"
    );
  });

  test("should handle route completion in streaming", async () => {
    const agent = createStreamingTestAgent();

    // Create a simple route
    agent.createRoute({
      title: "Streaming Route",
      description: "Route for streaming test",
      steps: [
        {
          id: "streaming_step",
          prompt: "Streaming step",
        },
      ],
    });

    const session = createSession();
    const history = [
      {
        role: "user" as const,
        content: "Route completion test",
        name: "TestUser",
      },
    ];

    let finalChunk: AgentResponseStreamChunk;

    for await (const chunk of agent.respondStream({ history, session })) {
      if (chunk.done) {
        finalChunk = chunk;
      }
    }

    // Check if route completed (this depends on the mock provider behavior)
    expect(finalChunk!.session).toBeDefined();
  });

  test("should maintain context across streaming responses", async () => {
    const agent = createStreamingTestAgent();
    let session = createSession();

    // First streaming response
    const history1 = [
      {
        role: "user" as const,
        content: "First message",
        name: "TestUser",
      },
    ];

    for await (const chunk of agent.respondStream({
      history: history1,
      session,
    })) {
      if (chunk.done) {
        session = chunk.session!;
      }
    }

    // Second streaming response with updated session
    const history2 = [
      ...history1,
      {
        role: "assistant" as const,
        content: MOCK_RESPONSES.GREETING,
      },
      {
        role: "user" as const,
        content: "Second message",
        name: "TestUser",
      },
    ];

    let secondResponse = "";
    for await (const chunk of agent.respondStream({
      history: history2,
      session,
    })) {
      secondResponse += chunk.delta;
      if (chunk.done) {
        expect(chunk.session?.id).toBe(session.id);
      }
    }

    expect(secondResponse).toBe(MOCK_RESPONSES.GREETING);
  });
});
