/**
 * ResponseModal Integration Tests for Type Fixes
 *
 * Tests that verify ResponseModal works correctly with the type fixes,
 * focusing on history conversion, type compatibility, and ensuring
 * all public methods work without type errors.
 */

import { expect, test, describe, beforeEach } from "bun:test";

import { Agent, createSession, type AgentResponseStreamChunk } from "../src/index";
import { ResponseModal, type RespondParams, type StreamOptions, type GenerateOptions, ResponseGenerationError } from "../src/core/ResponseModal";
import { historyToEvents, eventsToHistory } from "../src/utils/history";
import {
  MockProvider,
  MockProviderFactory,
  MOCK_RESPONSES,
} from "./mock-provider";

// Test context types
interface TestContext {
  userId: string;
  sessionCount: number;
  environment: "test" | "production";
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
function createTestAgent(provider?: MockProvider): Agent<TestContext, TestData> {
  return new Agent<TestContext, TestData>({
    name: "TypeFixTestAgent",
    description: "A test agent for ResponseModal type fix integration testing",
    goal: "Test ResponseModal type compatibility and history conversion",
    context: {
      userId: "type-test-user-123",
      sessionCount: 0,
      environment: "test",
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

function createComplexAgent(): Agent<TestContext, TestData> {
  const agent = createTestAgent();
  
  // Add multiple routes to test complex scenarios
  agent.createRoute({
    title: "Support Request",
    description: "Handle customer support requests",
    when: ["User needs help", "User has an issue"],
    requiredFields: ["issue", "priority"],
    optionalFields: ["category"],
    steps: [
      {
        id: "collect_issue",
        prompt: "What's the issue you're experiencing?",
        collect: ["issue"],
      },
      {
        id: "collect_priority",
        prompt: "How would you rate the priority of this issue?",
        collect: ["priority"],
        requires: ["issue"],
      },
      {
        id: "collect_category",
        prompt: "What category does this issue fall under?",
        collect: ["category"],
        requires: ["issue", "priority"],
      },
    ],
  });

  agent.createRoute({
    title: "Information Request",
    description: "Handle information requests",
    when: ["User wants information"],
    requiredFields: ["name"],
    optionalFields: ["email"],
    steps: [
      {
        id: "collect_name",
        prompt: "What's your name?",
        collect: ["name"],
      },
      {
        id: "collect_email",
        prompt: "What's your email address?",
        collect: ["email"],
        requires: ["name"],
      },
    ],
  });

  return agent;
}

describe("ResponseModal Type Compatibility Integration", () => {
  let agent: Agent<TestContext, TestData>;
  let responseModal: ResponseModal<TestContext, TestData>;

  beforeEach(() => {
    agent = createTestAgent();
    responseModal = new ResponseModal(agent);
  });

  test("should handle RespondParams as Record<string, unknown> in all methods", async () => {
    const session = createSession<TestData>("type-test-session");
    const history = [
      { role: "user" as const, content: "Type compatibility test", name: "TypeTestUser" },
    ];

    // Create RespondParams that extends Record<string, unknown>
    const params: RespondParams<TestContext, TestData> = {
      history,
      session,
      contextOverride: {
        userId: "type-test-user",
        sessionCount: 5,
        environment: "test",
      },
      // Additional properties to test Record<string, unknown> compatibility
      customProperty: "custom value",
      metadata: {
        testRun: true,
        timestamp: new Date().toISOString(),
      },
    };

    // Test that params can be used as Record<string, unknown>
    const asRecord: Record<string, unknown> = params;
    expect(asRecord.customProperty).toBe("custom value");
    expect(asRecord.metadata).toBeDefined();

    // Test respond method
    const response = await responseModal.respond(params);
    expect(response).toBeDefined();
    expect(response.message).toBeDefined();
    expect(response.session).toBeDefined();

    // Test respondStream method
    const chunks: AgentResponseStreamChunk<TestData>[] = [];
    for await (const chunk of responseModal.respondStream(params)) {
      chunks.push(chunk);
      if (chunk.done) break;
    }
    expect(chunks.length).toBeGreaterThan(0);
  });

  test("should handle complex history with all message types", async () => {
    const complexHistory = [
      { role: "system" as const, content: "System initialization complete" },
      { role: "user" as const, content: "I need help with an issue", name: "ComplexUser" },
      { 
        role: "assistant" as const, 
        content: "I'll help you with that. Let me search for solutions.",
        tool_calls: [
          {
            id: "call_search_123",
            name: "search_knowledge_base",
            arguments: { query: "user issue", category: "support" },
          },
        ],
      },
      {
        role: "tool" as const,
        tool_call_id: "call_search_123",
        name: "search_knowledge_base",
        content: { results: ["Solution 1", "Solution 2"], count: 2 },
      },
      { role: "assistant" as const, content: "Based on the search results, here are some solutions..." },
      { role: "user" as const, content: "Thank you, that helps!" },
    ];

    const session = createSession<TestData>("complex-history-test");
    const params: RespondParams<TestContext, TestData> = {
      history: complexHistory,
      session,
    };

    // Test that complex history works with respond
    const response = await responseModal.respond(params);
    expect(response).toBeDefined();
    expect(response.message).toBeDefined();

    // Test that complex history works with streaming
    const chunks: AgentResponseStreamChunk<TestData>[] = [];
    for await (const chunk of responseModal.respondStream(params)) {
      chunks.push(chunk);
      if (chunk.done) break;
    }
    expect(chunks.length).toBeGreaterThan(0);
  });

  test("should maintain type safety with AgentStructuredResponse", async () => {
    const toolCalls = [
      {
        toolName: "validate_data",
        arguments: { data: "test data", strict: true },
      },
    ];

    const provider = MockProviderFactory.withToolCalls(toolCalls);
    const agentWithTools = createTestAgent(provider);
    const responseModalWithTools = new ResponseModal(agentWithTools);

    const session = createSession<TestData>("structured-response-test");
    const params: RespondParams<TestContext, TestData> = {
      history: [{ role: "user", content: "Please validate this data" }],
      session,
    };

    const response = await responseModalWithTools.respond(params);
    
    // Verify response maintains type safety
    expect(response.message).toBeDefined();
    expect(response.session).toBeDefined();
    expect(response.isRouteComplete).toBeDefined();
    
    // Verify the response has the expected structure
    expect(typeof response.message).toBe("string");
    expect(response.session).toBeDefined();
    expect(typeof response.isRouteComplete).toBe("boolean");
  });

  test("should handle history conversion in internal processing", async () => {
    const originalHistory = [
      { role: "user" as const, content: "History conversion test", name: "ConversionUser" },
      { role: "assistant" as const, content: "I understand your request" },
      { 
        role: "assistant" as const, 
        content: null,
        tool_calls: [
          {
            id: "call_convert_123",
            name: "process_request",
            arguments: { type: "conversion_test" },
          },
        ],
      },
      {
        role: "tool" as const,
        tool_call_id: "call_convert_123",
        name: "process_request",
        content: "Processing complete",
      },
    ];

    // Test that history can be converted to events and back
    const events = historyToEvents(originalHistory);
    expect(events).toHaveLength(4);
    
    const convertedHistory = eventsToHistory(events);
    expect(convertedHistory).toHaveLength(4);

    // Test that ResponseModal can handle the converted history
    const session = createSession<TestData>("conversion-test");
    const params: RespondParams<TestContext, TestData> = {
      history: convertedHistory,
      session,
    };

    const response = await responseModal.respond(params);
    expect(response).toBeDefined();
    expect(response.message).toBeDefined();
  });
});

describe("ResponseModal Streaming Integration with Type Fixes", () => {
  let agent: Agent<TestContext, TestData>;
  let responseModal: ResponseModal<TestContext, TestData>;

  beforeEach(() => {
    agent = createTestAgent();
    responseModal = new ResponseModal(agent);
  });

  test("should handle streaming with complex type scenarios", async () => {
    const session = createSession<TestData>("streaming-type-test");
    
    // Test with modern streaming API
    const chunks: AgentResponseStreamChunk<TestData>[] = [];
    
    for await (const chunk of responseModal.stream("Streaming type test", {
      contextOverride: {
        userId: "streaming-user",
        sessionCount: 3,
        environment: "test",
      },
    })) {
      chunks.push(chunk);
      
      // Verify each chunk maintains type compatibility
      expect(chunk.delta).toBeDefined();
      expect(chunk.accumulated).toBeDefined();
      expect(chunk.done).toBeDefined();
      expect(chunk.session).toBeDefined();
      
      if (chunk.done) break;
    }

    expect(chunks.length).toBeGreaterThan(0);
    
    const finalChunk = chunks[chunks.length - 1];
    expect(finalChunk.done).toBe(true);
    expect(finalChunk.accumulated).toBe(MOCK_RESPONSES.GREETING);
  });

  test("should handle streaming with custom history override", async () => {
    const customHistory = [
      { role: "system" as const, content: "Custom streaming test system" },
      { role: "user" as const, content: "Previous message", name: "StreamUser" },
      { role: "assistant" as const, content: "Previous response" },
    ];

    const chunks: AgentResponseStreamChunk<TestData>[] = [];
    
    for await (const chunk of responseModal.stream("New streaming message", {
      history: customHistory,
      contextOverride: {
        environment: "test",
        userId: "custom-stream-user",
        sessionCount: 1,
      },
    })) {
      chunks.push(chunk);
      
      // Verify type compatibility in streaming context
      expect(typeof chunk.delta).toBe("string");
      expect(typeof chunk.accumulated).toBe("string");
      expect(typeof chunk.done).toBe("boolean");
      
      if (chunk.done) break;
    }

    expect(chunks.length).toBeGreaterThan(0);
  });

  test("should handle streaming errors with proper type handling", async () => {
    const errorProvider = MockProviderFactory.withError("Streaming type error test");
    const agentWithError = createTestAgent(errorProvider);
    const responseModalWithError = new ResponseModal(agentWithError);

    const chunks: AgentResponseStreamChunk<TestData>[] = [];
    let errorChunk: AgentResponseStreamChunk<TestData> | undefined;

    for await (const chunk of responseModalWithError.stream("Error test message")) {
      chunks.push(chunk);
      
      if (chunk.error) {
        errorChunk = chunk;
        expect(chunk.error).toBeInstanceOf(ResponseGenerationError);
        expect(chunk.done).toBe(true);
        expect(chunk.delta).toBe("");
        expect(chunk.accumulated).toBe("");
        break;
      }
      
      if (chunk.done) break;
    }

    expect(errorChunk).toBeDefined();
    expect(errorChunk!.error).toBeInstanceOf(ResponseGenerationError);
  });
});

describe("ResponseModal Route Integration with Type Fixes", () => {
  let agent: Agent<TestContext, TestData>;
  let responseModal: ResponseModal<TestContext, TestData>;

  beforeEach(() => {
    agent = createComplexAgent();
    responseModal = new ResponseModal(agent);
  });

  test("should handle route-based responses with type compatibility", async () => {
    const session = createSession<TestData>("route-type-test");
    
    // Start a support request route
    const response1 = await responseModal.generate("I need help with an urgent issue", {
      contextOverride: {
        userId: "route-test-user",
        sessionCount: 1,
        environment: "test",
      },
    });

    expect(response1).toBeDefined();
    expect(response1.message).toBeDefined();
    expect(response1.session).toBeDefined();

    // Continue the route with collected data
    await agent.updateCollectedData({ issue: "Login problems" });
    
    const response2 = await responseModal.generate("The issue is with login", {
      contextOverride: {
        environment: "test",
        userId: "route-test-user",
        sessionCount: 2,
      },
    });

    expect(response2).toBeDefined();
    expect(response2.message).toBeDefined();
    
    // Verify collected data is maintained with proper types
    const collectedData = agent.getCollectedData();
    expect(collectedData.issue).toBe("Login problems");
  });

  test("should handle route completion with streaming", async () => {
    // Set up complete data for route completion
    await agent.updateCollectedData({
      issue: "Email delivery problems",
      priority: "high" as const,
      category: "technical",
    });

    const chunks: AgentResponseStreamChunk<TestData>[] = [];
    
    for await (const chunk of responseModal.stream("That's all the information I have")) {
      chunks.push(chunk);
      
      // Verify type compatibility during route completion
      expect(chunk.session).toBeDefined();
      expect(typeof chunk.done).toBe("boolean");
      
      if (chunk.done) {
        // Check that route completion maintains type safety
        expect(chunk.session?.data).toBeDefined();
        break;
      }
    }

    expect(chunks.length).toBeGreaterThan(0);
    
    // Verify final collected data maintains types
    const finalData = agent.getCollectedData();
    expect(finalData.issue).toBe("Email delivery problems");
    expect(finalData.priority).toBe("high");
    expect(finalData.category).toBe("technical");
  });

  test("should handle multiple routes with type safety", async () => {
    const session = createSession<TestData>("multi-route-test");
    
    // Test information request route
    const infoResponse = await responseModal.generate("I'd like to get some information", {
      contextOverride: {
        userId: "multi-route-user",
        sessionCount: 1,
        environment: "test",
      },
    });

    expect(infoResponse).toBeDefined();
    expect(infoResponse.message).toBeDefined();

    // Switch to support request route
    const supportResponse = await responseModal.generate("Actually, I have a technical issue", {
      contextOverride: {
        userId: "multi-route-user",
        sessionCount: 2,
        environment: "test",
      },
    });

    expect(supportResponse).toBeDefined();
    expect(supportResponse.message).toBeDefined();
    
    // Verify session maintains type integrity across route switches
    const history = agent.session.getHistory();
    expect(history.length).toBeGreaterThan(0);
    
    // Each history item should maintain proper type structure
    for (const item of history) {
      expect(item.role).toBeDefined();
      expect(typeof item.role).toBe("string");
      if (item.role === "user" || item.role === "assistant" || item.role === "system") {
        expect(typeof item.content === "string" || item.content === null).toBe(true);
      }
    }
  });
});

describe("ResponseModal Error Handling Integration", () => {
  let agent: Agent<TestContext, TestData>;
  let responseModal: ResponseModal<TestContext, TestData>;

  beforeEach(() => {
    agent = createTestAgent();
    responseModal = new ResponseModal(agent);
  });

  test("should handle errors with proper type information", async () => {
    const errorProvider = MockProviderFactory.withError("Integration error test");
    const agentWithError = createTestAgent(errorProvider);
    const responseModalWithError = new ResponseModal(agentWithError);

    const session = createSession<TestData>("error-integration-test");
    const params: RespondParams<TestContext, TestData> = {
      history: [{ role: "user", content: "This will cause an error" }],
      session,
      contextOverride: {
        userId: "error-test-user",
        sessionCount: 1,
        environment: "test",
      },
      // Additional properties to test error handling with Record<string, unknown>
      errorTestProperty: "error test value",
      metadata: { errorTest: true },
    };

    try {
      await responseModalWithError.respond(params);
      expect(false).toBe(true); // Should not reach here
    } catch (error) {
      expect(error).toBeInstanceOf(ResponseGenerationError);
      
      const responseError = error as ResponseGenerationError;
      expect(responseError.message).toContain("Integration error test");
      
      // Verify error details maintain type compatibility
      if (responseError.details?.params) {
        const errorParams = responseError.details.params as Record<string, unknown>;
        expect(errorParams.errorTestProperty).toBe("error test value");
        expect(errorParams.metadata).toEqual({ errorTest: true });
      }
    }
  });

  test("should handle validation errors with type safety", async () => {
    const invalidParams: RespondParams<TestContext, TestData> = {
      history: null as any, // Invalid history to trigger validation error
      session: createSession<TestData>("validation-test"),
    };

    try {
      await responseModal.respond(invalidParams);
      expect(false).toBe(true); // Should not reach here
    } catch (error) {
      expect(error).toBeInstanceOf(ResponseGenerationError);
      
      // Verify error maintains type information
      const responseError = error as ResponseGenerationError;
      expect(responseError.message).toBeDefined();
      expect(typeof responseError.message).toBe("string");
    }
  });

  test("should handle streaming errors with complete type information", async () => {
    const errorProvider = MockProviderFactory.withError("Streaming integration error");
    const agentWithError = createTestAgent(errorProvider);
    const responseModalWithError = new ResponseModal(agentWithError);

    let errorOccurred = false;
    let errorChunk: AgentResponseStreamChunk<TestData> | undefined;

    for await (const chunk of responseModalWithError.stream("Streaming error test", {
      contextOverride: {
        userId: "streaming-error-user",
        sessionCount: 1,
        environment: "test",
      },
    })) {
      if (chunk.error) {
        errorOccurred = true;
        errorChunk = chunk;
        
        // Verify error chunk maintains all type properties
        expect(chunk.error).toBeInstanceOf(ResponseGenerationError);
        expect(chunk.done).toBe(true);
        expect(chunk.delta).toBe("");
        expect(chunk.accumulated).toBe("");
        expect(chunk.session).toBeDefined();
        
        break;
      }
    }

    expect(errorOccurred).toBe(true);
    expect(errorChunk).toBeDefined();
    expect(errorChunk!.error).toBeInstanceOf(ResponseGenerationError);
  });
});