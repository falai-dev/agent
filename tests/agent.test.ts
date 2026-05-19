/**
 * Agent Core Functionality Tests
 *
 * Tests the main Agent class functionality including:
 * - Agent creation and configuration
 * - Basic response generation
 * - Error handling
 * - Provider integration
 * - Context management
 */

import { Agent, type Instruction, type Term } from "../src/index";
import {
  MockProvider,
  MockProviderFactory,
  MOCK_RESPONSES,
} from "./mock-provider";
import { generateFlowId } from "../src/utils/id";
import { describe, test, expect } from "bun:test";

// Test context types
interface TestContext {
  userId: string;
  sessionCount: number;
  lastUpdatedAt?: string;
  lastAction?: string;
}

// Test data types for agent-level data collection
interface SupportTicketData {
  issue: string;
  priority: "low" | "medium" | "high";
  category: string;
  customerName?: string;
  email?: string;
  ticketId?: string;
  resolution?: string;
}

interface UserProfileData {
  name?: string;
  email?: string;
  phone?: string;
  preferences?: {
    theme: "light" | "dark";
    notifications: boolean;
  };
  accountType?: "basic" | "premium";
}

// Test utilities
function createTestAgent(provider?: MockProvider): Agent<TestContext> {
  return new Agent<TestContext>({
    name: "TestAgent",
    description: "A test agent for unit testing",
    goal: "Test agent functionality",
    context: {
      userId: "test-user-123",
      sessionCount: 0,
    },
    provider: provider || MockProviderFactory.basic(),
  });
}

function createSupportAgent(): Agent<TestContext, SupportTicketData> {
  const agent = new Agent<TestContext, SupportTicketData>({
    name: "SupportAgent",
    description: "Agent for testing agent-level data collection",
    context: {
      userId: "test-user-123",
      sessionCount: 0,
    },
    provider: MockProviderFactory.basic(),
    schema: {
      type: "object",
      properties: {
        issue: { type: "string" },
        priority: { type: "string", enum: ["low", "medium", "high"] },
        category: { type: "string" },
        customerName: { type: "string" },
        email: { type: "string", format: "email" },
        ticketId: { type: "string" },
        resolution: { type: "string" },
      },
      required: ["issue", "category"],
    },
  });

  // Add guidelines
  agent.createInstruction({
    when: "User asks for help",
    prompt: "Provide helpful assistance",
    enabled: true,
  });

  // Add terms
  agent.createTerm({
    name: "Support Ticket",
    description: "A request for technical assistance",
  });

  // Add a support flow with required fields
  agent.createFlow({
    title: "Support Request",
    description: "Handle customer support requests",
    when: ["User needs help", "Technical issue"],
    requiredFields: ["issue", "category"],
    optionalFields: ["priority", "customerName", "email"],
    steps: [
      {
        prompt: "What's the issue you're experiencing?",
        collect: ["issue"],
      },
      {
        prompt: "What category does this fall under?",
        collect: ["category"],
        requires: ["issue"],
      },
      {
        prompt: "How would you rate the priority?",
        collect: ["priority"],
        requires: ["issue", "category"],
      },
    ],
  });

  return agent;
}

// Simple test runner functions
function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) {
    throw new Error(
      `Assertion failed: ${message}. Expected ${JSON.stringify(
        expected
      )}, got ${JSON.stringify(actual)}`
    );
  }
}

function assertDeepEqual<T>(actual: T, expected: T, message: string) {
  const actualStr = JSON.stringify(actual);
  const expectedStr = JSON.stringify(expected);
  if (actualStr !== expectedStr) {
    throw new Error(
      `Assertion failed: ${message}. Expected ${expectedStr}, got ${actualStr}`
    );
  }
}

async function runTest(name: string, testFn: () => Promise<void> | void) {
  try {
    console.log(`🧪 Running: ${name}`);
    await testFn();
    console.log(`✅ Passed: ${name}`);
  } catch (error) {
    console.log(`❌ Failed: ${name}`);
    console.log(
      `   Error: ${error instanceof Error ? error.message : String(error)}`
    );
    throw error;
  }
}

async function testAgentCreationAndConfiguration() {
  console.log("=== Agent Creation and Configuration Tests ===");

  await runTest("should create agent with minimal configuration", () => {
    const agent = createTestAgent();

    // Test that agent was created successfully
    assert(agent !== undefined, "Agent should be created");
    assert(agent !== null, "Agent should not be null");
    assert(
      typeof agent.respond === "function",
      "Agent should have respond method"
    );

    // Test that the agent was created successfully with context
    assert(agent !== undefined, "Agent should be created");
    assert(
      typeof agent.respond === "function",
      "Agent should have respond method"
    );
  });

  await runTest("should create agent with agent-level schema", () => {
    const agent = new Agent<TestContext, UserProfileData>({
      name: "SchemaAgent",
      description: "Agent with schema",
      context: {
        userId: "schema-test-user",
        sessionCount: 0,
      },
      provider: MockProviderFactory.basic(),
      schema: {
        type: "object",
        properties: {
          name: { type: "string" },
          email: { type: "string", format: "email" },
          phone: { type: "string" },
          preferences: {
            type: "object",
            properties: {
              theme: { type: "string", enum: ["light", "dark"] },
              notifications: { type: "boolean" },
            },
          },
          accountType: { type: "string", enum: ["basic", "premium"] },
        },
        required: ["name", "email"],
      },
    });

    assert(agent !== undefined, "Agent should be created");
    assert(typeof agent.validateData === "function", "Should have validateData method");
    assert(typeof agent.getCollectedData === "function", "Should have getCollectedData method");
    assert(typeof agent.updateCollectedData === "function", "Should have updateCollectedData method");
  });

  await runTest("should create agent with full configuration", () => {
    const agent = new Agent<TestContext>({
      name: "FullTestAgent",
      description: "Fully configured test agent",
      goal: "Test all features",
      context: {
        userId: "full-test-user",
        sessionCount: 5,
      },
      provider: MockProviderFactory.basic(),
      terms: [
        {
          name: "Test Term",
          description: "A test term",
        },
      ],
      instructions: [
        {
          when: "Test condition",
          prompt: "Test action",
        },
      ],
    });

    // Test that full configuration works
    assert(agent !== undefined, "Agent should be created");
    assert(agent.getTerms().length === 1, "Should have 1 term");
    assert(agent.getInstructions().length === 1, "Should have 1 instruction");
  });

  await runTest("should update context dynamically", async () => {
    const agent = createTestAgent();
    const updates: Partial<TestContext> = {
      sessionCount: 10,
    };

    // Test that updateContext method exists and can be called
    await agent.updateContext(updates);
    assert(
      agent !== undefined,
      "Agent should still exist after context update"
    );
  });

  await runTest("should validate agent-level data", async () => {
    const agent = createSupportAgent();

    // Test valid data
    const validData: Partial<SupportTicketData> = {
      issue: "Login problem",
      category: "technical",
      priority: "high",
    };

    const validResult = agent.validateData(validData);
    assert(validResult.valid === true, "Valid data should pass validation");
    assert(validResult.errors.length === 0, "Valid data should have no errors");

    // Test invalid data (field not in schema)
    const invalidData = {
      issue: "Login problem",
      invalidField: "should not be allowed",
    };

    const invalidResult = agent.validateData(invalidData as any);
    assert(invalidResult.valid === false, "Invalid data should fail validation");
    assert(invalidResult.errors.length > 0, "Invalid data should have errors");
  });

  await runTest("should update collected data with validation", async () => {
    const agent = createSupportAgent();

    // Test valid update
    const validUpdate: Partial<SupportTicketData> = {
      issue: "Cannot access account",
      category: "technical",
    };

    await agent.updateCollectedData(validUpdate);
    const collectedData = agent.getCollectedData();
    assertEqual(collectedData.issue, "Cannot access account", "Issue should be updated");
    assertEqual(collectedData.category, "technical", "Category should be updated");

    // Test invalid update should throw error
    try {
      await agent.updateCollectedData({ invalidField: "test" } as any);
      throw new Error("Expected validation error was not thrown");
    } catch (error) {
      assert(
        error instanceof Error && error.message.includes("validation failed"),
        "Should throw validation error for invalid data"
      );
    }
  });

  await runTest("should support new addTool method with unified interface", () => {
    const agent = createSupportAgent();

    // Test that addTool method exists
    assert(typeof agent.addTool === "function", "Agent should have addTool method");

    // Test adding a tool using unified interface with direct return
    agent.addTool({
      id: "support_helper",
      description: "Helps with support tickets",
      handler: async (context) => {
        return `Helping ${context.context?.userId} with support`;
      },
    });

    // Test adding a tool with ToolResult return
    agent.addTool({
      id: "ticket_processor",
      description: "Processes support tickets",
      handler: async (context) => {
        return {
          dataUpdate: { lastTicketId: context.data?.ticketId },
          contextUpdate: { lastAction: "processTicket" }
        };
      },
    });

    // Verify tools were added to agent
    const tools = agent.getTools();
    const helperTool = tools.find(t => t.id === "support_helper");
    const processorTool = tools.find(t => t.id === "ticket_processor");

    assert(helperTool !== undefined, "Helper tool should be added to agent");
    assertEqual(helperTool?.description, "Helps with support tickets", "Helper tool description should match");
    assert(processorTool !== undefined, "Processor tool should be added to agent");
    assertEqual(processorTool?.description, "Processes support tickets", "Processor tool description should match");
  });

  await runTest("should access ToolManager through agent.tool property", () => {
    const agent = createSupportAgent();

    // Test that ToolManager is accessible
    assert(agent.tool !== undefined, "Agent should have tool property");
    assert(typeof agent.tool.create === "function", "ToolManager should have create method");
    assert(typeof agent.tool.register === "function", "ToolManager should have register method");
    assert(typeof agent.tool.find === "function", "ToolManager should have find method");
    assert(typeof agent.tool.getAvailable === "function", "ToolManager should have getAvailable method");

    // Test creating tool through ToolManager
    const tool = agent.tool.create({
      id: "toolmanager_test",
      description: "Created via ToolManager",
      handler: async (context) => {
        return `ToolManager result for ${context.context?.userId}`;
      },
    });

    assertEqual(tool.id, "toolmanager_test", "Tool ID should match");
    assertEqual(tool.description, "Created via ToolManager", "Tool description should match");
    assert(typeof tool.handler === "function", "Tool should have handler function");
  });

  await runTest("should register and find tools using ToolManager", () => {
    const agent = createSupportAgent();

    // Register a tool
    const registeredTool = agent.tool.register({
      id: "registered_support_tool",
      description: "Registered support tool",
      handler: async (context) => {
        return `Registered tool for ${context.context?.userId}`;
      },
    });

    // Test tool is registered
    assert(agent.tool.isRegistered("registered_support_tool"), "Tool should be registered");
    assertEqual(agent.tool.getRegisteredTool("registered_support_tool"), registeredTool, "Should return registered tool");

    // Test finding the tool
    const foundTool = agent.tool.find("registered_support_tool");
    assertEqual(foundTool, registeredTool, "Should find registered tool");

    // Test tool appears in available tools
    const availableTools = agent.tool.getAvailable();
    assert(availableTools.includes(registeredTool), "Registered tool should be available");
  });
}

async function testAgentResponseGeneration() {
  console.log("=== Agent Response Generation Tests ===");

  await runTest("should generate basic response", async () => {
    const agent = createTestAgent();
    const session = await agent.session.getOrCreate();

    const history = [
      {
        role: "user" as const,
        content: "Hello",
        name: "TestUser",
      },
    ];

    const response = await agent.respond({ history, session });

    assertEqual(
      response.message,
      MOCK_RESPONSES.GREETING,
      "Response message should match"
    );
    assert(response.session !== undefined, "Session should be defined");
    assertEqual(
      response.isFlowComplete,
      false,
      "Flow should not be complete"
    );
    assert(response.toolCalls === undefined, "Tool calls should be undefined");
  });

  await runTest("should delegate respond() to ResponseModal", async () => {
    const agent = createTestAgent();
    const session = await agent.session.getOrCreate();

    const history = [
      {
        role: "user" as const,
        content: "Test delegation",
        name: "TestUser",
      },
    ];

    // Test that respond method works (delegation is internal)
    const response = await agent.respond({ history, session });

    assert(response !== undefined, "Response should be defined");
    assertEqual(response.message, MOCK_RESPONSES.GREETING, "Response should match mock");
    assert(response.session !== undefined, "Session should be defined");
  });

  await runTest("should handle provider errors gracefully", async () => {
    const errorProvider = MockProviderFactory.withError("Test error");
    const agent = createTestAgent(errorProvider);
    const session = await agent.session.getOrCreate();

    const history = [
      {
        role: "user" as const,
        content: "Hello",
        name: "TestUser",
      },
    ];

    try {
      await agent.respond({ history, session });
      throw new Error("Expected error was not thrown");
    } catch (error) {
      assert(
        error instanceof Error && error.message.includes("Test error"),
        "Error should contain test message"
      );
    }
  });

  await runTest("should maintain session state across responses", async () => {
    const agent = createTestAgent();
    let session = await agent.session.getOrCreate();

    // First interaction
    const response1 = await agent.respond({
      history: [
        {
          role: "user" as const,
          content: "Start a support request",
          name: "TestUser",
        },
      ],
      session,
    });

    assert(response1.session !== undefined, "Session should be defined");
    session = response1.session!;

    // Second interaction with same session
    const response2 = await agent.respond({
      history: [
        {
          role: "user" as const,
          content: "Start a support request",
          name: "TestUser",
        },
        {
          role: "assistant" as const,
          content: response1.message,
        },
        {
          role: "user" as const,
          content: "My issue is urgent",
          name: "TestUser",
        },
      ],
      session,
    });

    assertEqual(
      response2.session?.id,
      session.id,
      "Session ID should be maintained"
    );
  });

  await runTest("should handle context in responses", async () => {
    const agent = createTestAgent();
    const session = await agent.session.getOrCreate();

    const history = [
      {
        role: "user" as const,
        content: "Hello",
        name: "TestUser",
      },
    ];

    const response = await agent.respond({ history, session });

    // The mock provider doesn't use context, but the agent should still function
    assert(
      response.message !== undefined,
      "Response message should be defined"
    );
    assert(response.session !== undefined, "Session should be defined");
  });

  await runTest("should use new chat method for simplified conversations", async () => {
    const agent = createTestAgent();

    // Use the new chat method
    const response1 = await agent.chat("Hello!");
    assert(response1.message !== undefined, "First response should be defined");

    const response2 = await agent.chat("How are you?");
    assert(response2.message !== undefined, "Second response should be defined");

    // Check that history is managed automatically
    const history = agent.session.getHistory();
    assert(history.length === 4, "Should have 4 messages in history"); // 2 user + 2 assistant
    assertEqual(history[0].role, "user", "First message should be from user");
    assertEqual(history[0].content, "Hello!", "First message content should match");
    assertEqual(history[1].role, "assistant", "Second message should be from assistant");
    assertEqual(history[2].role, "user", "Third message should be from user");
    assertEqual(history[2].content, "How are you?", "Third message content should match");
    assertEqual(history[3].role, "assistant", "Fourth message should be from assistant");
  });

  await runTest("should delegate chat() to ResponseModal.generate()", async () => {
    const agent = createTestAgent();

    // Test that chat method works (delegation is internal)
    const response = await agent.chat("Test chat delegation");

    assert(response !== undefined, "Response should be defined");
    assertEqual(response.message, MOCK_RESPONSES.GREETING, "Response should match mock");
    assert(response.session !== undefined, "Session should be defined");

    // Check that message was added to session history
    const history = agent.session.getHistory();
    assert(history.length >= 2, "Should have at least 2 messages in history");
    assertEqual(history[0].role, "user", "First message should be from user");
    assertEqual(history[0].content, "Test chat delegation", "User message should match");
  });

  await runTest("should delegate respondStream() to ResponseModal", async () => {
    const agent = createTestAgent();
    const session = await agent.session.getOrCreate();

    const history = [
      {
        role: "user" as const,
        content: "Test streaming delegation",
        name: "TestUser",
      },
    ];

    const chunks: any[] = [];
    let finalChunk;

    for await (const chunk of agent.respondStream({ history, session })) {
      chunks.push(chunk);
      if (chunk.done) {
        finalChunk = chunk;
      }
    }

    assert(chunks.length > 0, "Should receive streaming chunks");
    assert(finalChunk !== undefined, "Should have final chunk");
    assert(finalChunk!.done === true, "Final chunk should be marked as done");
    assertEqual(finalChunk!.accumulated, MOCK_RESPONSES.GREETING, "Final message should match mock");
  });

  await runTest("should support new stream() method", async () => {
    const agent = createTestAgent();

    const chunks: any[] = [];
    let finalChunk;

    for await (const chunk of agent.stream("Test new stream API")) {
      chunks.push(chunk);
      if (chunk.done) {
        finalChunk = chunk;
      }
    }

    assert(chunks.length > 0, "Should receive streaming chunks");
    assert(finalChunk !== undefined, "Should have final chunk");
    assert(finalChunk!.done === true, "Final chunk should be marked as done");
    assertEqual(finalChunk!.accumulated, MOCK_RESPONSES.GREETING, "Final message should match mock");

    // Check that message was added to session history
    const history = agent.session.getHistory();
    assert(history.length >= 2, "Should have at least 2 messages in history");
    assertEqual(history[0].role, "user", "First message should be from user");
    assertEqual(history[0].content, "Test new stream API", "User message should match");
  });
}

async function testAgentGuidelinesAndTerms() {
  console.log("=== Agent Guidelines and Terms Tests ===");

  await runTest("should manage instructions", () => {
    const agent = createTestAgent();

    // Initially empty
    assert(
      agent.getInstructions().length === 0,
      "Should start with no instructions"
    );

    // Add instruction
    const instruction: Instruction = {
      when: "User is confused",
      prompt: "Ask clarifying questions",
      enabled: true,
    };

    agent.createInstruction(instruction);
    assert(agent.getInstructions().length === 1, "Should have 1 instruction");

    const createdInstruction = agent.getInstructions()[0];
    assert(createdInstruction.when === instruction.when, "When should match");
    assert(createdInstruction.prompt === instruction.prompt, "Prompt should match");
    assert(createdInstruction.enabled === instruction.enabled, "Enabled should match");
    assert(typeof createdInstruction.id === "string", "Should have auto-generated ID");
  });

  await runTest("should manage terms", () => {
    const agent = createTestAgent();

    // Initially empty
    assert(agent.getTerms().length === 0, "Should start with no terms");

    // Add term
    const term: Term = {
      name: "API Key",
      description: "A secret key for API authentication",
    };

    agent.createTerm(term);
    assert(agent.getTerms().length === 1, "Should have 1 term");
    assertDeepEqual(agent.getTerms()[0], term, "Term should match");
  });

  await runTest(
    "should handle dynamic term descriptions with context",
    async () => {
      const agent = createTestAgent();

      const dynamicTerm: Term<TestContext> = {
        name: "User Session",
        description: ({ context }) => `Session for user ${context?.userId}`,
      };

      agent.createTerm(dynamicTerm);
      const terms = agent.getTerms();
      assert(terms.length === 1, "Should have 1 term");

      // Test that the description function works
      const term = terms[0];
      assert(
        typeof term.description === "function",
        "Description should be a function"
      );
      const context = await agent.getContext();
      assertEqual(
        (term.description as (params: { context?: TestContext }) => string)(
          { context: context as TestContext }
        ),
        "Session for user test-user-123",
        "Dynamic description should work"
      );
    }
  );

  await runTest(
    "should handle dynamic instruction prompts with context",
    async () => {
      const agent = createTestAgent();

      const dynamicInstruction: Instruction<TestContext> = {
        when: "User needs personalized help",
        prompt: ({ context }) => `I'll help you, ${context?.userId}`,
        enabled: true,
      };

      agent.createInstruction(dynamicInstruction);
      const instructions = agent.getInstructions();
      assert(instructions.length === 1, "Should have 1 instruction");

      // Test that the prompt function works
      const instruction = instructions[0];
      assert(
        typeof instruction.prompt === "function",
        "Prompt should be a function"
      );
      const context = await agent.getContext();
      assertEqual(
        (instruction.prompt as (params: { context?: TestContext }) => string)(
          { context: context as TestContext }
        ),
        "I'll help you, test-user-123",
        "Dynamic prompt should work"
      );
    }
  );
}

async function testAgentBackwardCompatibility() {
  console.log("=== Agent Backward Compatibility Tests ===");

  await runTest("should maintain backward compatibility for respond()", async () => {
    const agent = createTestAgent();
    const session = await agent.session.getOrCreate();

    const history = [
      {
        role: "user" as const,
        content: "Backward compatibility test",
        name: "TestUser",
      },
    ];

    // This should work exactly as before the refactor
    const response = await agent.respond({ history, session });

    // Verify the response structure matches the original API
    assert(typeof response === "object", "Response should be an object");
    assert(typeof response.message === "string", "Response should have message string");
    assert(response.session !== undefined, "Response should have session");
    assert(typeof response.isFlowComplete === "boolean", "Response should have isFlowComplete boolean");
    assertEqual(response.message, MOCK_RESPONSES.GREETING, "Response message should match mock");
  });

  await runTest("should maintain backward compatibility for respondStream()", async () => {
    const agent = createTestAgent();
    const session = await agent.session.getOrCreate();

    const history = [
      {
        role: "user" as const,
        content: "Streaming backward compatibility test",
        name: "TestUser",
      },
    ];

    // This should work exactly as before the refactor
    const chunks: any = [];
    let chunkCount = 0;
    let finalChunk;

    for await (const chunk of agent.respondStream({ history, session })) {
      chunks.push(chunk);
      chunkCount++;

      // Verify chunk structure matches original API
      assert(typeof chunk === "object", "Chunk should be an object");
      assert(typeof chunk.delta === "string", "Chunk should have delta string");
      assert(typeof chunk.accumulated === "string", "Chunk should have accumulated string");
      assert(typeof chunk.done === "boolean", "Chunk should have done boolean");
      assert(chunk.session !== undefined, "Chunk should have session");

      if (chunk.done) {
        finalChunk = chunk;
      }
    }

    assert(chunkCount > 0, "Should receive at least one chunk");
    assert(finalChunk !== undefined, "Should have final chunk");
    assertEqual(finalChunk!.accumulated, MOCK_RESPONSES.GREETING, "Final accumulated should match mock");
  });

  await runTest("should maintain exact method signatures", async () => {
    const agent = createTestAgent();
    const session = await agent.session.getOrCreate();

    // Test that all method signatures are preserved
    assert(typeof agent.respond === "function", "respond should be a function");
    assert(typeof agent.respondStream === "function", "respondStream should be a function");
    assert(typeof agent.chat === "function", "chat should be a function");
    assert(typeof agent.stream === "function", "stream should be a function");

    // Test parameter compatibility
    const params = {
      history: [{ role: "user" as const, content: "test", name: "TestUser" }],
      session,
      contextOverride: { userId: "test-override" },
    };

    // These should all work without type errors
    const response = await agent.respond(params);
    assert(response !== undefined, "respond should work with full params");

    const streamChunks: any[] = [];
    for await (const chunk of agent.respondStream(params)) {
      streamChunks.push(chunk);
      if (chunk.done) break;
    }
    assert(streamChunks.length > 0, "respondStream should work with full params");
  });
}

async function testAgentLevelDataCollection() {
  console.log("=== Agent-Level Data Collection Tests ===");

  await runTest("should collect data across flows", async () => {
    const agent = createSupportAgent();

    // Create multiple flows that work with the same agent data
    const infoFlow = agent.createFlow({
      title: "Customer Info",
      requiredFields: ["customerName", "email"],
      steps: [
        {
          prompt: "What's your name?",
          collect: ["customerName"],
        },
        {
          prompt: "What's your email?",
          collect: ["email"],
          requires: ["customerName"],
        },
      ],
    });

    const ticketFlow = agent.createFlow({
      title: "Ticket Creation",
      requiredFields: ["issue", "category"],
      steps: [
        {
          prompt: "What's the issue?",
          collect: ["issue"],
        },
        {
          prompt: "What category?",
          collect: ["category"],
          requires: ["issue"],
        },
      ],
    });

    // Test that flows can access the same agent-level data
    assert(!!infoFlow.requiredFields?.includes("customerName"), "Info flow should require customerName");
    assert(!!ticketFlow.requiredFields?.includes("issue"), "Ticket flow should require issue");

    // Test flow completion logic
    const partialData: Partial<SupportTicketData> = {
      customerName: "John Doe",
      issue: "Login problem",
    };

    assert(infoFlow.isComplete(partialData) === false, "Info flow should not be complete without email");
    assert(ticketFlow.isComplete(partialData) === false, "Ticket flow should not be complete without category");

    const completeInfoData: Partial<SupportTicketData> = {
      ...partialData,
      email: "john@example.com",
    };

    assert(infoFlow.isComplete(completeInfoData) === true, "Info flow should be complete with name and email");

    const completeTicketData: Partial<SupportTicketData> = {
      ...partialData,
      category: "technical",
    };

    assert(ticketFlow.isComplete(completeTicketData) === true, "Ticket flow should be complete with issue and category");
  });

  await runTest("should validate flow field references against agent schema", () => {
    const agent = createSupportAgent();

    // Test valid field references
    const validFlow = agent.createFlow({
      title: "Valid Flow",
      requiredFields: ["issue", "category"], // These exist in agent schema
      optionalFields: ["priority"], // This exists in agent schema
    });

    assert(validFlow !== undefined, "Flow with valid fields should be created");

    // Test invalid field references should throw error
    try {
      agent.createFlow({
        title: "Invalid Flow",
        requiredFields: ["nonExistentField"] as any,
      });
      throw new Error("Expected flow configuration error was not thrown");
    } catch (error) {
      assert(
        error instanceof Error && error.message.includes("Invalid required fields"),
        "Should throw flow configuration error for invalid fields"
      );
    }
  });

  await runTest("should calculate flow completion progress", () => {
    const agent = createSupportAgent();
    const flow = agent.createFlow({
      title: "Progress Flow",
      requiredFields: ["issue", "category", "priority"],
    });

    // Test 0% completion
    const noData: Partial<SupportTicketData> = {};
    assertEqual(flow.getCompletionProgress(noData), 0, "Empty data should be 0% complete");

    // Test 33% completion
    const oneFieldData: Partial<SupportTicketData> = { issue: "Test issue" };
    assertEqual(Math.round(flow.getCompletionProgress(oneFieldData) * 100), 33, "One field should be ~33% complete");

    // Test 67% completion
    const twoFieldData: Partial<SupportTicketData> = { issue: "Test issue", category: "technical" };
    assertEqual(Math.round(flow.getCompletionProgress(twoFieldData) * 100), 67, "Two fields should be ~67% complete");

    // Test 100% completion
    const completeData: Partial<SupportTicketData> = {
      issue: "Test issue",
      category: "technical",
      priority: "high"
    };
    assertEqual(flow.getCompletionProgress(completeData), 1, "All fields should be 100% complete");
  });

  await runTest("should get missing required fields", () => {
    const agent = createSupportAgent();
    const flow = agent.createFlow({
      title: "Missing Fields Flow",
      requiredFields: ["issue", "category", "customerName"],
    });

    const partialData: Partial<SupportTicketData> = {
      issue: "Test issue",
    };

    const missingFields = flow.getMissingRequiredFields(partialData);
    assert(missingFields.includes("category"), "Should identify missing category field");
    assert(missingFields.includes("customerName"), "Should identify missing customerName field");
    assert(!missingFields.includes("issue"), "Should not include present issue field");
    assertEqual(missingFields.length, 2, "Should have exactly 2 missing fields");
  });
}

// Main test runner
async function runAllAgentTests() {
  try {
    await testAgentCreationAndConfiguration();
    await testAgentResponseGeneration();
    await testAgentBackwardCompatibility();
    await testAgentGuidelinesAndTerms();
    await testAgentLevelDataCollection();
    console.log("\n🎉 All Agent tests passed!");
  } catch (error) {
    console.error("\n❌ Agent tests failed:", error);
    process.exit(1);
  }
}

// Run tests if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runAllAgentTests().catch(console.error);
}

/**
 * Property 2: Generated Flow IDs use the `flow_` prefix
 * Validates: Requirements 5.1, 5.2
 */
describe("generateFlowId", () => {
  test("should produce IDs with the flow_ prefix", () => {
    expect(generateFlowId("Foo")).toMatch(/^flow_/);
  });
});
