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

import { Agent, createSession, type Guideline, type Term } from "../src/index";
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

// interface SupportTicketData {
//   issue: string;
//   priority: "low" | "medium" | "high";
//   category: string;
// }

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

// function createSupportAgent(): Agent<TestContext> {
//   const agent = createTestAgent();

//   // Add guidelines
//   agent.createGuideline({
//     condition: "User asks for help",
//     action: "Provide helpful assistance",
//     enabled: true,
//   });

//   // Add terms
//   agent.createTerm({
//     name: "Support Ticket",
//     description: "A request for technical assistance",
//   });

//   // Add a support route
//   agent.createRoute<SupportTicketData>({
//     title: "Support Request",
//     description: "Handle customer support requests",
//     conditions: ["User needs help", "Technical issue"],
//     schema: {
//       type: "object",
//       properties: {
//         issue: { type: "string" },
//         priority: { type: "string", enum: ["low", "medium", "high"] },
//         category: { type: "string" },
//       },
//       required: ["issue"],
//     },
//     steps: [
//       {
//         prompt: "What's the issue you're experiencing?",
//         collect: ["issue"],
//       },
//       {
//         prompt: "How would you rate the priority?",
//         collect: ["priority"],
//         requires: ["issue"],
//       },
//     ],
//   });

//   return agent;
// }

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
      guidelines: [
        {
          condition: "Test condition",
          action: "Test action",
        },
      ],
    });

    // Test that full configuration works
    assert(agent !== undefined, "Agent should be created");
    assert(agent.getTerms().length === 1, "Should have 1 term");
    assert(agent.getGuidelines().length === 1, "Should have 1 guideline");
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
}

async function testAgentResponseGeneration() {
  console.log("=== Agent Response Generation Tests ===");

  await runTest("should generate basic response", async () => {
    const agent = createTestAgent();
    const session = createSession();

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
      response.isRouteComplete,
      false,
      "Route should not be complete"
    );
    assert(response.toolCalls === undefined, "Tool calls should be undefined");
  });

  await runTest("should handle provider errors gracefully", async () => {
    const errorProvider = MockProviderFactory.withError("Test error");
    const agent = createTestAgent(errorProvider);
    const session = createSession();

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
    let session = createSession();

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
    const session = createSession();

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
}

async function testAgentGuidelinesAndTerms() {
  console.log("=== Agent Guidelines and Terms Tests ===");

  await runTest("should manage guidelines", () => {
    const agent = createTestAgent();

    // Initially empty
    assert(
      agent.getGuidelines().length === 0,
      "Should start with no guidelines"
    );

    // Add guideline
    const guideline: Guideline = {
      condition: "User is confused",
      action: "Ask clarifying questions",
      enabled: true,
    };

    agent.createGuideline(guideline);
    assert(agent.getGuidelines().length === 1, "Should have 1 guideline");
    assertDeepEqual(
      agent.getGuidelines()[0],
      guideline,
      "Guideline should match"
    );
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
        (term.description as (context: TestContext) => string)(
          context as TestContext
        ),
        "Session for user test-user-123",
        "Dynamic description should work"
      );
    }
  );

  await runTest(
    "should handle dynamic guideline actions with context",
    async () => {
      const agent = createTestAgent();

      const dynamicGuideline: Guideline<TestContext> = {
        condition: "User needs personalized help",
        action: ({ context }) => `I'll help you, ${context?.userId}`,
        enabled: true,
      };

      agent.createGuideline(dynamicGuideline);
      const guidelines = agent.getGuidelines();
      assert(guidelines.length === 1, "Should have 1 guideline");

      // Test that the action function works
      const guideline = guidelines[0];
      assert(
        typeof guideline.action === "function",
        "Action should be a function"
      );
      const context = await agent.getContext();
      assertEqual(
        (guideline.action as (context: TestContext) => string)(
          context as TestContext
        ),
        "I'll help you, test-user-123",
        "Dynamic action should work"
      );
    }
  );
}

// Main test runner
async function runAllAgentTests() {
  try {
    await testAgentCreationAndConfiguration();
    await testAgentResponseGeneration();
    await testAgentGuidelinesAndTerms();
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
