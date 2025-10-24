/**
 * ResponseModal Unit Tests
 *
 * Tests the ResponseModal class functionality including:
 * - Response generation (respond method)
 * - Streaming response generation (respondStream method)
 * - Modern streaming API (stream method)
 * - Modern non-streaming API (generate method)
 * - Error handling
 * - Unified response logic
 */

import { expect, test, describe, beforeEach } from "bun:test";

import { Agent, createSession, type AgentResponseStreamChunk } from "../src/index";
import { ResponseModal, type RespondParams, type StreamOptions, type GenerateOptions, ResponseGenerationError } from "../src/core/ResponseModal";
import {
  MockProvider,
  MockProviderFactory,
  MOCK_RESPONSES,
} from "./mock-provider";

// Test context types
interface TestContext {
  userId: string;
  sessionCount: number;
}

// Test data types
interface TestData {
  name?: string;
  email?: string;
  issue?: string;
  priority?: "low" | "medium" | "high";
}

// Test utilities
function createTestAgent(provider?: MockProvider): Agent<TestContext, TestData> {
  return new Agent<TestContext, TestData>({
    name: "TestAgent",
    description: "A test agent for ResponseModal testing",
    goal: "Test ResponseModal functionality",
    context: {
      userId: "test-user-123",
      sessionCount: 0,
    },
    provider: provider || MockProviderFactory.basic(),
    schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        email: { type: "string", format: "email" },
        issue: { type: "string" },
        priority: { type: "string", enum: ["low", "medium", "high"] },
      },
      additionalProperties: false,
    },
  });
}

function createTestAgentWithRoute(provider?: MockProvider): Agent<TestContext, TestData> {
  const agent = createTestAgent(provider);
  
  // Add a test route
  agent.createRoute({
    title: "Support Request",
    description: "Handle customer support requests",
    when: ["User needs help"],
    requiredFields: ["issue"],
    optionalFields: ["priority"],
    steps: [
      {
        id: "collect_issue",
        prompt: "What's the issue you're experiencing?",
        collect: ["issue"],
      },
      {
        id: "collect_priority",
        prompt: "How would you rate the priority?",
        collect: ["priority"],
        requires: ["issue"],
      },
    ],
  });

  return agent;
}

describe("ResponseModal Core Functionality", () => {
  let agent: Agent<TestContext, TestData>;
  let responseModal: ResponseModal<TestContext, TestData>;

  beforeEach(() => {
    agent = createTestAgent();
    responseModal = new ResponseModal(agent);
  });

  test("should create ResponseModal instance", () => {
    expect(responseModal).toBeDefined();
    expect(responseModal.getResponseEngine).toBeDefined();
    expect(responseModal.getResponsePipeline).toBeDefined();
  });

  test("should have access to agent dependencies", () => {
    const responseEngine = responseModal.getResponseEngine();
    const responsePipeline = responseModal.getResponsePipeline();
    
    expect(responseEngine).toBeDefined();
    expect(responsePipeline).toBeDefined();
  });
});

describe("ResponseModal.respond() Method", () => {
  let agent: Agent<TestContext, TestData>;
  let responseModal: ResponseModal<TestContext, TestData>;

  beforeEach(() => {
    agent = createTestAgent();
    responseModal = new ResponseModal(agent);
  });

  test("should generate basic response", async () => {
    const session = createSession<TestData>();
    const history = [
      {
        role: "user" as const,
        content: "Hello",
        name: "TestUser",
      },
    ];

    const params: RespondParams<TestContext, TestData> = {
      history,
      session,
    };

    const response = await responseModal.respond(params);

    expect(response).toBeDefined();
    expect(response.message).toBe(MOCK_RESPONSES.GREETING);
    expect(response.session).toBeDefined();
    expect(response.isRouteComplete).toBe(false);
    expect(response.toolCalls).toBeUndefined();
  });

  test("should handle context override", async () => {
    const session = createSession<TestData>();
    const history = [
      {
        role: "user" as const,
        content: "Hello",
        name: "TestUser",
      },
    ];

    const contextOverride: Partial<TestContext> = {
      sessionCount: 5,
    };

    const params: RespondParams<TestContext, TestData> = {
      history,
      session,
      contextOverride,
    };

    const response = await responseModal.respond(params);

    expect(response).toBeDefined();
    expect(response.message).toBe(MOCK_RESPONSES.GREETING);
    expect(response.session).toBeDefined();
  });

  test("should handle route-based responses", async () => {
    const agentWithRoute = createTestAgentWithRoute();
    const responseModalWithRoute = new ResponseModal(agentWithRoute);
    
    const session = createSession<TestData>();
    const history = [
      {
        role: "user" as const,
        content: "I need help with an issue",
        name: "TestUser",
      },
    ];

    const params: RespondParams<TestContext, TestData> = {
      history,
      session,
    };

    const response = await responseModalWithRoute.respond(params);

    expect(response).toBeDefined();
    expect(response.message).toBe(MOCK_RESPONSES.GREETING);
    expect(response.session).toBeDefined();
  });

  test("should handle tool calls in response", async () => {
    const toolCalls = [
      {
        toolName: "search_database",
        arguments: { query: "test query" },
      },
    ];

    const provider = MockProviderFactory.withToolCalls(toolCalls);
    const agentWithTools = createTestAgent(provider);
    const responseModalWithTools = new ResponseModal(agentWithTools);

    const session = createSession<TestData>();
    const history = [
      {
        role: "user" as const,
        content: "Search for something",
        name: "TestUser",
      },
    ];

    const params: RespondParams<TestContext, TestData> = {
      history,
      session,
    };

    const response = await responseModalWithTools.respond(params);

    expect(response).toBeDefined();
    expect(response.message).toBeDefined();
    expect(response.session).toBeDefined();
  });

  test("should throw ResponseGenerationError on failure", async () => {
    const errorProvider = MockProviderFactory.withError("Test error");
    const agentWithError = createTestAgent(errorProvider);
    const responseModalWithError = new ResponseModal(agentWithError);

    const session = createSession<TestData>();
    const history = [
      {
        role: "user" as const,
        content: "This should fail",
        name: "TestUser",
      },
    ];

    const params: RespondParams<TestContext, TestData> = {
      history,
      session,
    };

    await expect(responseModalWithError.respond(params)).rejects.toThrow(ResponseGenerationError);
  });

  test("should validate required parameters", async () => {
    const params: RespondParams<TestContext, TestData> = {
      history: null as any, // Invalid history
    };

    await expect(responseModal.respond(params)).rejects.toThrow(ResponseGenerationError);
  });
});

describe("ResponseModal.respondStream() Method", () => {
  let agent: Agent<TestContext, TestData>;
  let responseModal: ResponseModal<TestContext, TestData>;

  beforeEach(() => {
    agent = createTestAgent();
    responseModal = new ResponseModal(agent);
  });

  test("should generate streaming response", async () => {
    const session = createSession<TestData>();
    const history = [
      {
        role: "user" as const,
        content: "Hello",
        name: "TestUser",
      },
    ];

    const params: RespondParams<TestContext, TestData> = {
      history,
      session,
    };

    const chunks: AgentResponseStreamChunk<TestData>[] = [];
    let finalChunk: AgentResponseStreamChunk<TestData> | undefined;

    for await (const chunk of responseModal.respondStream(params)) {
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

  test("should accumulate chunks correctly", async () => {
    const session = createSession<TestData>();
    const history = [
      {
        role: "user" as const,
        content: "Tell me something",
        name: "TestUser",
      },
    ];

    const params: RespondParams<TestContext, TestData> = {
      history,
      session,
    };

    let previousAccumulated = "";

    for await (const chunk of responseModal.respondStream(params)) {
      expect(chunk.accumulated.length).toBeGreaterThanOrEqual(previousAccumulated.length);
      expect(chunk.accumulated.startsWith(previousAccumulated)).toBe(true);
      previousAccumulated = chunk.accumulated;

      if (chunk.done) {
        expect(chunk.accumulated).toBe(MOCK_RESPONSES.GREETING);
      }
    }
  });

  test("should handle streaming errors", async () => {
    const errorProvider = MockProviderFactory.withError("Streaming failed");
    const agentWithError = createTestAgent(errorProvider);
    const responseModalWithError = new ResponseModal(agentWithError);

    const session = createSession<TestData>();
    const history = [
      {
        role: "user" as const,
        content: "This should fail",
        name: "TestUser",
      },
    ];

    const params: RespondParams<TestContext, TestData> = {
      history,
      session,
    };

    let errorChunk: AgentResponseStreamChunk<TestData> | undefined;

    for await (const chunk of responseModalWithError.respondStream(params)) {
      if (chunk.error) {
        errorChunk = chunk;
        break;
      }
      if (chunk.done) {
        break;
      }
    }

    expect(errorChunk).toBeDefined();
    expect(errorChunk!.error).toBeInstanceOf(ResponseGenerationError);
    expect(errorChunk!.done).toBe(true);
    expect(errorChunk!.delta).toBe("");
    expect(errorChunk!.accumulated).toBe("");
    expect(errorChunk!.session).toBeDefined();
  });

  test("should maintain session state during streaming", async () => {
    const session = createSession<TestData>("test-session-id");
    const history = [
      {
        role: "user" as const,
        content: "Session test",
        name: "TestUser",
      },
    ];

    const params: RespondParams<TestContext, TestData> = {
      history,
      session,
    };

    for await (const chunk of responseModal.respondStream(params)) {
      expect(chunk.session).toBeDefined();
      expect(chunk.session?.id).toBe(session.id);
    }
  });
});

describe("ResponseModal.stream() Method - Modern API", () => {
  let agent: Agent<TestContext, TestData>;
  let responseModal: ResponseModal<TestContext, TestData>;

  beforeEach(() => {
    agent = createTestAgent();
    responseModal = new ResponseModal(agent);
  });

  test("should stream with simple message parameter", async () => {
    const chunks: AgentResponseStreamChunk<TestData>[] = [];
    let finalChunk: AgentResponseStreamChunk<TestData> | undefined;

    for await (const chunk of responseModal.stream("Hello!")) {
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

  test("should handle automatic session management", async () => {
    const sessionId = agent.session.current?.id;

    for await (const chunk of responseModal.stream("Test message")) {
      expect(chunk.session).toBeDefined();
      if (sessionId) {
        expect(chunk.session?.id).toBe(sessionId);
      }
    }

    // Check that message was added to session history
    const history = agent.session.getHistory();
    expect(history.length).toBeGreaterThanOrEqual(2); // User message + assistant response
    expect(history[0].role).toBe("user");
    expect(history[0].content).toBe("Test message");
  });

  test("should handle context override", async () => {
    const options: StreamOptions<TestContext> = {
      contextOverride: {
        sessionCount: 10,
      },
    };

    const chunks: AgentResponseStreamChunk<TestData>[] = [];

    for await (const chunk of responseModal.stream("Context test", options)) {
      chunks.push(chunk);
      if (chunk.done) break;
    }

    expect(chunks.length).toBeGreaterThan(0);
  });

  test("should handle custom history override", async () => {
    const customHistory = [
      {
        role: "user" as const,
        content: "Previous message",
        name: "TestUser",
      },
      {
        role: "assistant" as const,
        content: "Previous response",
      },
    ];

    const options: StreamOptions<TestContext> = {
      history: customHistory,
    };

    const chunks: AgentResponseStreamChunk<TestData>[] = [];

    for await (const chunk of responseModal.stream("New message", options)) {
      chunks.push(chunk);
      if (chunk.done) break;
    }

    expect(chunks.length).toBeGreaterThan(0);
    
    // Session history should not be modified when using custom history
    const sessionHistory = agent.session.getHistory();
    expect(sessionHistory.length).toBe(0); // No messages added to session
  });

  test("should work without message parameter", async () => {
    // Add a message to session first
    await agent.session.addMessage("user", "Existing message");

    const chunks: AgentResponseStreamChunk<TestData>[] = [];

    for await (const chunk of responseModal.stream()) {
      chunks.push(chunk);
      if (chunk.done) break;
    }

    expect(chunks.length).toBeGreaterThan(0);
  });
});

describe("ResponseModal.generate() Method - Modern API", () => {
  let agent: Agent<TestContext, TestData>;
  let responseModal: ResponseModal<TestContext, TestData>;

  beforeEach(() => {
    agent = createTestAgent();
    responseModal = new ResponseModal(agent);
  });

  test("should generate response with simple message parameter", async () => {
    const response = await responseModal.generate("Hello!");

    expect(response).toBeDefined();
    expect(response.message).toBe(MOCK_RESPONSES.GREETING);
    expect(response.session).toBeDefined();
  });

  test("should handle automatic session management", async () => {
    const response = await responseModal.generate("Test message");

    expect(response.session).toBeDefined();
    
    // Check that message was added to session history
    const history = agent.session.getHistory();
    expect(history.length).toBeGreaterThanOrEqual(2); // User message + assistant response
    expect(history[0].role).toBe("user");
    expect(history[0].content).toBe("Test message");
    expect(history[1].role).toBe("assistant");
    expect(history[1].content).toBe(MOCK_RESPONSES.GREETING);
  });

  test("should handle context override", async () => {
    const options: GenerateOptions<TestContext> = {
      contextOverride: {
        sessionCount: 15,
      },
    };

    const response = await responseModal.generate("Context test", options);

    expect(response).toBeDefined();
    expect(response.message).toBe(MOCK_RESPONSES.GREETING);
  });

  test("should handle custom history override", async () => {
    const customHistory = [
      {
        role: "user" as const,
        content: "Previous message",
        name: "TestUser",
      },
      {
        role: "assistant" as const,
        content: "Previous response",
      },
    ];

    const options: GenerateOptions<TestContext> = {
      history: customHistory,
    };

    const response = await responseModal.generate("New message", options);

    expect(response).toBeDefined();
    expect(response.message).toBe(MOCK_RESPONSES.GREETING);
    
    // Session history should not be modified when using custom history
    const sessionHistory = agent.session.getHistory();
    expect(sessionHistory.length).toBe(0); // No messages added to session
  });

  test("should work without message parameter", async () => {
    // Add a message to session first
    await agent.session.addMessage("user", "Existing message");

    const response = await responseModal.generate();

    expect(response).toBeDefined();
    expect(response.message).toBe(MOCK_RESPONSES.GREETING);
  });

  test("should merge agent collected data into session", async () => {
    // Set some collected data on the agent
    await agent.updateCollectedData({ name: "John Doe", email: "john@example.com" });

    const response = await responseModal.generate("Test with data");

    expect(response).toBeDefined();
    expect(response.session).toBeDefined();
    
    // Check that collected data was merged
    const collectedData = agent.getCollectedData();
    expect(collectedData.name).toBe("John Doe");
    expect(collectedData.email).toBe("john@example.com");
  });
});

describe("ResponseModal Error Handling", () => {
  let agent: Agent<TestContext, TestData>;
  let responseModal: ResponseModal<TestContext, TestData>;

  beforeEach(() => {
    agent = createTestAgent();
    responseModal = new ResponseModal(agent);
  });

  test("should create ResponseGenerationError with details", () => {
    const originalError = new Error("Original error");
    const params = { history: [] };
    
    const error = new ResponseGenerationError("Test error", {
      originalError,
      params,
      phase: "test_phase",
      context: { test: true },
    });

    expect(error).toBeInstanceOf(ResponseGenerationError);
    expect(error.message).toBe("Test error");
    expect(error.details?.originalError).toBe(originalError);
    expect(error.details?.params).toBe(params);
    expect(error.details?.phase).toBe("test_phase");
  });

  test("should create ResponseGenerationError from unknown error", () => {
    const unknownError = "String error";
    const error = ResponseGenerationError.fromError(unknownError, "test_phase");

    expect(error).toBeInstanceOf(ResponseGenerationError);
    expect(error.message).toContain("test_phase");
    expect(error.message).toContain("String error");
  });

  test("should identify ResponseGenerationError instances", () => {
    const responseError = new ResponseGenerationError("Test");
    const regularError = new Error("Regular error");

    expect(ResponseGenerationError.isResponseGenerationError(responseError)).toBe(true);
    expect(ResponseGenerationError.isResponseGenerationError(regularError)).toBe(false);
    expect(ResponseGenerationError.isResponseGenerationError("string")).toBe(false);
  });

  test("should preserve stack trace from original error", () => {
    const originalError = new Error("Original error");
    const responseError = new ResponseGenerationError("Wrapped error", {
      originalError,
    });

    expect(responseError.stack).toContain("Wrapped error");
    expect(responseError.stack).toContain("Caused by:");
  });
});

describe("ResponseModal Configuration Options", () => {
  let agent: Agent<TestContext, TestData>;

  beforeEach(() => {
    agent = createTestAgent();
  });

  test("should accept configuration options", () => {
    const options = {
      maxToolLoops: 3,
      enableAutoSave: true,
      debugMode: true,
    };

    const responseModal = new ResponseModal(agent, options);

    expect(responseModal).toBeDefined();
  });

  test("should work with default options", () => {
    const responseModal = new ResponseModal(agent);

    expect(responseModal).toBeDefined();
  });
});

describe("ResponseModal Integration with Agent Features", () => {
  test("should work with agent-level data collection", async () => {
    const agent = createTestAgentWithRoute();
    const responseModal = new ResponseModal(agent);

    // Set some initial data
    await agent.updateCollectedData({ issue: "Login problem" });

    const response = await responseModal.generate("I need help");

    expect(response).toBeDefined();
    expect(response.session).toBeDefined();
    
    // Check that data is preserved
    const collectedData = agent.getCollectedData();
    expect(collectedData.issue).toBe("Login problem");
  });

  test("should handle route completion", async () => {
    const agent = createTestAgentWithRoute();
    const responseModal = new ResponseModal(agent);

    // Complete the route by providing all required data
    await agent.updateCollectedData({ 
      issue: "Login problem",
      priority: "high" as const,
    });

    const response = await responseModal.generate("That's all the info");

    expect(response).toBeDefined();
    expect(response.session).toBeDefined();
  });

  test("should maintain context across multiple calls", async () => {
    const agent = createTestAgent();
    const responseModal = new ResponseModal(agent);

    // First call
    const response1 = await responseModal.generate("First message");
    expect(response1).toBeDefined();

    // Second call should maintain context
    const response2 = await responseModal.generate("Second message");
    expect(response2).toBeDefined();

    // Check history
    const history = agent.session.getHistory();
    expect(history.length).toBe(4); // 2 user + 2 assistant messages
  });
});