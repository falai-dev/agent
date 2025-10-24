import { expect, test, describe, beforeEach } from "bun:test";
import { Agent, Route, Step, Guideline, GuidelineMatch, ConditionTemplate, TemplateContext } from "../src/index";
import { MockProviderFactory } from "./mock-provider";
import { createTemplateContext } from "../src/utils";

interface TestData {
  userType?: "premium" | "basic";
  hasPayment?: boolean;
  isComplete?: boolean;
  priority?: "low" | "medium" | "high";
  issueType?: "technical" | "billing" | "general";
}

interface TestContext {
  userId?: string;
  sessionType?: "new" | "returning";
  userRole?: "admin" | "user";
}

describe("Guideline Condition Evaluation", () => {
  let agent: Agent<TestContext, TestData>;
  let mockTemplateContext: TemplateContext<TestContext, TestData>;

  beforeEach(() => {
    agent = new Agent<TestContext, TestData>({
      name: "GuidelineConditionTestAgent",
      description: "Agent for testing guideline condition evaluation",
      provider: MockProviderFactory.basic(),
      schema: {
        type: "object",
        properties: {
          userType: { type: "string", enum: ["premium", "basic"] },
          hasPayment: { type: "boolean" },
          isComplete: { type: "boolean" },
          priority: { type: "string", enum: ["low", "medium", "high"] },
          issueType: { type: "string", enum: ["technical", "billing", "general"] },
        },
      },
    });

    const sessionData = { userType: "premium" as const, hasPayment: true, isComplete: false };
    mockTemplateContext = createTemplateContext({
      context: { userId: "user123", sessionType: "returning", userRole: "user" },
      data: sessionData,
      session: {
        id: "test-session",
        data: sessionData,
      },
      history: []
    });
  });

  describe("Agent-level guideline condition evaluation", () => {
    test("should evaluate string condition guidelines", async () => {
      agent.createGuideline({
        id: "string-condition-guideline",
        condition: "user needs premium support",
        action: "Provide premium-level assistance and prioritize their request"
      });

      // Debug: Check if guideline was added
      const guidelines = agent.getGuidelines();
      expect(guidelines).toHaveLength(1);
      expect(guidelines[0].id).toBe("string-condition-guideline");

      const matches = await agent.evaluateGuidelines(
        mockTemplateContext.context,
        mockTemplateContext.session,
        mockTemplateContext.history
      );

      expect(matches).toHaveLength(1);
      expect(matches[0].guideline.id).toBe("string-condition-guideline");
      expect(matches[0].rationale).toBe("Condition met: user needs premium support");
    });

    test("should evaluate function condition guidelines", async () => {
      agent.createGuideline({
        id: "function-condition-guideline",
        condition: (ctx) => ctx.data?.userType === "premium",
        action: "Apply premium user benefits and faster response times"
      });

      const matches = await agent.evaluateGuidelines(
        mockTemplateContext.context,
        mockTemplateContext.session,
        mockTemplateContext.history
      );

      expect(matches).toHaveLength(1);
      expect(matches[0].guideline.id).toBe("function-condition-guideline");
      expect(matches[0].rationale).toBe("Programmatic condition evaluated to true");
    });

    test("should evaluate array condition guidelines with AND logic", async () => {
      agent.createGuideline({
        id: "array-condition-guideline",
        condition: [
          "premium user interaction",
          (ctx) => ctx.data?.userType === "premium",
          (ctx) => ctx.data?.hasPayment === true
        ],
        action: "Provide full premium service with payment processing"
      });

      const matches = await agent.evaluateGuidelines(
        mockTemplateContext.context,
        mockTemplateContext.session,
        mockTemplateContext.history
      );

      expect(matches).toHaveLength(1);
      expect(matches[0].guideline.id).toBe("array-condition-guideline");
      expect(matches[0].rationale).toBe("Condition met: premium user interaction");
    });

    test("should handle guidelines with failing conditions", async () => {
      agent.createGuideline({
        id: "failing-condition-guideline",
        condition: [
          "premium support needed",
          (ctx) => ctx.data?.userType === "premium", // true
          (ctx) => ctx.data?.isComplete === true      // false
        ],
        action: "Provide premium support"
      });

      const matches = await agent.evaluateGuidelines(
        mockTemplateContext.context,
        mockTemplateContext.session,
        mockTemplateContext.history
      );

      expect(matches).toHaveLength(0); // Should not match due to failing condition
    });

    test("should handle guidelines without conditions", async () => {
      agent.createGuideline({
        id: "always-active-guideline",
        action: "Always be helpful and professional"
        // No condition - always active
      });

      const matches = await agent.evaluateGuidelines(
        mockTemplateContext.context,
        mockTemplateContext.session,
        mockTemplateContext.history
      );

      expect(matches).toHaveLength(1);
      expect(matches[0].guideline.id).toBe("always-active-guideline");
      expect(matches[0].rationale).toBe("Always active (no conditions)");
    });

    test("should skip disabled guidelines", async () => {
      agent.createGuideline({
        id: "disabled-guideline",
        condition: "user needs help",
        action: "Provide assistance",
        enabled: false
      });

      const matches = await agent.evaluateGuidelines(
        mockTemplateContext.context,
        mockTemplateContext.session,
        mockTemplateContext.history
      );

      expect(matches).toHaveLength(0); // Should not match disabled guideline
    });

    test("should handle async function conditions", async () => {
      agent.createGuideline({
        id: "async-condition-guideline",
        condition: async (ctx) => {
          await new Promise(resolve => setTimeout(resolve, 10));
          return ctx.data?.userType === "premium";
        },
        action: "Provide async premium support"
      });

      const matches = await agent.evaluateGuidelines(
        mockTemplateContext.context,
        mockTemplateContext.session,
        mockTemplateContext.history
      );

      expect(matches).toHaveLength(1);
      expect(matches[0].guideline.id).toBe("async-condition-guideline");
      expect(matches[0].rationale).toBe("Programmatic condition evaluated to true");
    });
  });

  describe("Route-level guideline condition evaluation", () => {
    test("should evaluate route guideline conditions", async () => {
      const route = agent.createRoute({
        title: "Route with Guidelines",
        guidelines: [
          {
            id: "route-string-guideline",
            condition: "user is in booking flow",
            action: "Focus on booking completion and payment processing"
          },
          {
            id: "route-function-guideline",
            condition: (ctx) => ctx.data?.userType === "premium",
            action: "Apply premium booking benefits"
          }
        ]
      });

      const matches = await route.evaluateGuidelines(
        mockTemplateContext.context,
        mockTemplateContext.session,
        mockTemplateContext.history
      );

      expect(matches).toHaveLength(2);
      expect(matches[0].guideline.id).toBe("route-string-guideline");
      expect(matches[0].rationale).toBe("Condition met: user is in booking flow");
      expect(matches[1].guideline.id).toBe("route-function-guideline");
      expect(matches[1].rationale).toBe("Programmatic condition evaluated to true");
    });

    test("should handle route guidelines with mixed conditions", async () => {
      const route = agent.createRoute({
        title: "Mixed Condition Route",
        guidelines: [
          {
            id: "mixed-guideline",
            condition: [
              "premium booking process",
              (ctx) => ctx.data?.userType === "premium",
              "payment verification required",
              (ctx) => ctx.data?.hasPayment === true
            ],
            action: "Handle premium booking with payment verification"
          }
        ]
      });

      const matches = await route.evaluateGuidelines(
        mockTemplateContext.context,
        mockTemplateContext.session,
        mockTemplateContext.history
      );

      expect(matches).toHaveLength(1);
      expect(matches[0].guideline.id).toBe("mixed-guideline");
      expect(matches[0].rationale).toBe("Condition met: premium booking process AND payment verification required");
    });

    test("should dynamically add and evaluate route guidelines", async () => {
      const route = agent.createRoute({
        title: "Dynamic Guidelines Route"
      });

      // Add guideline dynamically
      route.createGuideline({
        id: "dynamic-route-guideline",
        condition: [
          "dynamic condition added",
          (ctx) => ctx.context?.sessionType === "returning"
        ],
        action: "Handle returning user with special care"
      });

      const matches = await route.evaluateGuidelines(
        mockTemplateContext.context,
        mockTemplateContext.session,
        mockTemplateContext.history
      );

      expect(matches).toHaveLength(1);
      expect(matches[0].guideline.id).toBe("dynamic-route-guideline");
      expect(matches[0].rationale).toBe("Condition met: dynamic condition added");
    });
  });

  describe("Step-level guideline condition evaluation", () => {
    test("should support guidelines in StepOptions", async () => {
      const route = agent.createRoute({
        title: "StepOptions Guidelines Route",
        steps: [
          {
            id: "step-with-options-guidelines",
            prompt: "Test step with guidelines in options",
            guidelines: [
              {
                id: "options-guideline",
                condition: "guideline from step options",
                action: "Handle guideline from step options"
              }
            ]
          }
        ]
      });

      const step = route.getStep("step-with-options-guidelines")!;
      const guidelines = step.getGuidelines();

      expect(guidelines).toHaveLength(1);
      expect(guidelines[0].id).toBe("options-guideline");
      expect(guidelines[0].condition).toBe("guideline from step options");
    });

    test("should evaluate step guideline conditions", async () => {
      const route = agent.createRoute({
        title: "Step Guidelines Route",
        steps: [
          {
            id: "step-with-guidelines",
            prompt: "Test step",
            guidelines: [
              {
                id: "step-string-guideline",
                condition: "user needs step-specific help",
                action: "Provide detailed step guidance"
              },
              {
                id: "step-function-guideline",
                condition: (ctx) => ctx.data?.priority === "high",
                action: "Prioritize this step for high-priority users"
              }
            ]
          }
        ]
      });

      const step = route.getStep("step-with-guidelines")!;
      
      // Update context to have high priority
      const highPriorityContext = {
        ...mockTemplateContext,
        data: { ...mockTemplateContext.data, priority: "high" as const },
        session: {
          ...mockTemplateContext.session!,
          data: { ...mockTemplateContext.data, priority: "high" as const }
        }
      };

      const matches = await step.evaluateGuidelines(
        highPriorityContext.context,
        highPriorityContext.session,
        highPriorityContext.history
      );

      expect(matches).toHaveLength(2);
      expect(matches[0].guideline.id).toBe("step-string-guideline");
      expect(matches[0].rationale).toBe("Condition met: user needs step-specific help");
      expect(matches[1].guideline.id).toBe("step-function-guideline");
      expect(matches[1].rationale).toBe("Programmatic condition evaluated to true");
    });

    test("should handle step guidelines with failing conditions", async () => {
      const route = agent.createRoute({
        title: "Failing Step Guidelines Route",
        steps: [
          {
            id: "failing-step-guidelines",
            prompt: "Test step",
            guidelines: [
              {
                id: "failing-step-guideline",
                condition: (ctx) => ctx.data?.priority === "high", // Will be undefined/falsy
                action: "Handle high priority"
              }
            ]
          }
        ]
      });

      const step = route.getStep("failing-step-guidelines")!;
      const matches = await step.evaluateGuidelines(
        mockTemplateContext.context,
        mockTemplateContext.session,
        mockTemplateContext.history
      );

      expect(matches).toHaveLength(0); // Should not match due to failing condition
    });
  });

  describe("AI context string collection from guideline conditions", () => {
    test("should collect AI context strings from guideline conditions", async () => {
      agent.createGuideline({
        id: "context-collection-guideline",
        condition: [
          "user is frustrated",
          (ctx) => ctx.data?.userType === "premium",
          "immediate assistance required",
          (ctx) => ctx.data?.hasPayment === true
        ],
        action: "Provide immediate premium support with empathy"
      });

      const matches = await agent.evaluateGuidelines(
        mockTemplateContext.context,
        mockTemplateContext.session,
        mockTemplateContext.history
      );

      expect(matches).toHaveLength(1);
      expect(matches[0].rationale).toBe("Condition met: user is frustrated AND immediate assistance required");
    });

    test("should handle nested arrays in guideline conditions", async () => {
      agent.createGuideline({
        id: "nested-context-guideline",
        condition: [
          "complex user interaction",
          [
            "premium user detected",
            (ctx) => ctx.data?.userType === "premium",
            "payment verification complete"
          ],
          (ctx) => ctx.data?.hasPayment === true
        ],
        action: "Handle complex premium interaction"
      });

      const matches = await agent.evaluateGuidelines(
        mockTemplateContext.context,
        mockTemplateContext.session,
        mockTemplateContext.history
      );

      expect(matches).toHaveLength(1);
      expect(matches[0].rationale).toBe("Condition met: complex user interaction AND premium user detected AND payment verification complete");
    });
  });

  describe("Guideline matching with mixed string/function conditions", () => {
    test("should handle guidelines with only string conditions", async () => {
      agent.createGuideline({
        id: "string-only-guideline",
        condition: [
          "user needs help",
          "support request detected",
          "assistance required"
        ],
        action: "Provide comprehensive support"
      });

      const matches = await agent.evaluateGuidelines(
        mockTemplateContext.context,
        mockTemplateContext.session,
        mockTemplateContext.history
      );

      expect(matches).toHaveLength(1);
      expect(matches[0].rationale).toBe("Condition met: user needs help AND support request detected AND assistance required");
    });

    test("should handle guidelines with only function conditions", async () => {
      agent.createGuideline({
        id: "function-only-guideline",
        condition: [
          (ctx) => ctx.data?.userType === "premium",
          (ctx) => ctx.data?.hasPayment === true,
          (ctx) => ctx.context?.sessionType === "returning"
        ],
        action: "Apply all premium benefits for returning user"
      });

      const matches = await agent.evaluateGuidelines(
        mockTemplateContext.context,
        mockTemplateContext.session,
        mockTemplateContext.history
      );

      expect(matches).toHaveLength(1);
      expect(matches[0].rationale).toBe("Programmatic condition evaluated to true");
    });

    test("should handle mixed string and function conditions", async () => {
      agent.createGuideline({
        id: "mixed-conditions-guideline",
        condition: [
          "premium user interaction",
          (ctx) => ctx.data?.userType === "premium",
          "payment processing needed",
          (ctx) => ctx.data?.hasPayment === true,
          "priority handling required"
        ],
        action: "Provide premium service with priority handling"
      });

      const matches = await agent.evaluateGuidelines(
        mockTemplateContext.context,
        mockTemplateContext.session,
        mockTemplateContext.history
      );

      expect(matches).toHaveLength(1);
      expect(matches[0].rationale).toBe("Condition met: premium user interaction AND payment processing needed AND priority handling required");
    });
  });

  describe("Integration with agent guideline system", () => {
    test("should integrate with agent-level guidelines", async () => {
      // Add agent-level guidelines
      agent.createGuideline({
        id: "agent-global-guideline",
        condition: "user needs assistance",
        action: "Always be helpful and professional"
      });

      // Create route with its own guidelines
      const route = agent.createRoute({
        title: "Integration Route",
        guidelines: [
          {
            id: "route-specific-guideline",
            condition: (ctx) => ctx.data?.userType === "premium",
            action: "Apply premium route benefits"
          }
        ]
      });

      // Test agent guidelines
      const agentMatches = await agent.evaluateGuidelines(
        mockTemplateContext.context,
        mockTemplateContext.session,
        mockTemplateContext.history
      );

      expect(agentMatches).toHaveLength(1);
      expect(agentMatches[0].guideline.id).toBe("agent-global-guideline");

      // Test route guidelines
      const routeMatches = await route.evaluateGuidelines(
        mockTemplateContext.context,
        mockTemplateContext.session,
        mockTemplateContext.history
      );

      expect(routeMatches).toHaveLength(1);
      expect(routeMatches[0].guideline.id).toBe("route-specific-guideline");
    });

    test("should handle multiple guidelines with different condition types", async () => {
      agent.createGuideline({
        id: "always-active",
        action: "Always be polite"
        // No condition
      });

      agent.createGuideline({
        id: "string-condition",
        condition: "user is confused",
        action: "Provide clear explanations"
      });

      agent.createGuideline({
        id: "function-condition",
        condition: (ctx) => ctx.data?.userType === "premium",
        action: "Apply premium benefits"
      });

      agent.createGuideline({
        id: "mixed-condition",
        condition: [
          "complex interaction",
          (ctx) => ctx.data?.hasPayment === true
        ],
        action: "Handle complex paid interaction"
      });

      const matches = await agent.evaluateGuidelines(
        mockTemplateContext.context,
        mockTemplateContext.session,
        mockTemplateContext.history
      );

      expect(matches).toHaveLength(4);
      expect(matches.map(m => m.guideline.id)).toEqual([
        "always-active",
        "string-condition", 
        "function-condition",
        "mixed-condition"
      ]);
    });
  });

  describe("Error handling", () => {
    test("should handle function errors in guideline conditions", async () => {
      agent.createGuideline({
        id: "error-guideline",
        condition: [
          "user needs help",
          () => { throw new Error("Test error"); }
        ],
        action: "Provide support despite errors"
      });

      const matches = await agent.evaluateGuidelines(
        mockTemplateContext.context,
        mockTemplateContext.session,
        mockTemplateContext.history
      );

      expect(matches).toHaveLength(0); // Should not match due to error
    });

    test("should handle malformed guideline conditions", async () => {
      agent.createGuideline({
        id: "malformed-guideline",
        condition: 123 as any, // Invalid condition type
        action: "Handle malformed condition"
      });

      const matches = await agent.evaluateGuidelines(
        mockTemplateContext.context,
        mockTemplateContext.session,
        mockTemplateContext.history
      );

      expect(matches).toHaveLength(1); // Should match due to AND default behavior
      expect(matches[0].rationale).toBe("Always active (no conditions)");
    });

    test("should handle empty condition arrays", async () => {
      agent.createGuideline({
        id: "empty-condition-guideline",
        condition: [], // Empty array
        action: "Handle empty conditions"
      });

      const matches = await agent.evaluateGuidelines(
        mockTemplateContext.context,
        mockTemplateContext.session,
        mockTemplateContext.history
      );

      expect(matches).toHaveLength(1); // Should match due to AND default for empty array
      expect(matches[0].rationale).toBe("Always active (no conditions)");
    });
  });

  describe("Complex scenarios", () => {
    test("should handle complex multi-level guideline evaluation", async () => {
      // Agent-level guideline
      agent.createGuideline({
        id: "agent-complex",
        condition: [
          "global user interaction",
          (ctx) => ctx.context?.userRole === "user"
        ],
        action: "Apply global user policies"
      });

      // Route with complex guidelines
      const route = agent.createRoute({
        title: "Complex Route",
        guidelines: [
          {
            id: "route-complex",
            condition: [
              "route-specific interaction",
              (ctx) => ctx.data?.userType === "premium",
              [
                "nested condition",
                (ctx) => ctx.data?.hasPayment === true,
                "payment verified"
              ]
            ],
            action: "Handle complex route interaction"
          }
        ],
        steps: [
          {
            id: "complex-step",
            prompt: "Complex step",
            guidelines: [
              {
                id: "step-complex",
                condition: [
                  "step-level interaction",
                  (ctx) => ctx.data?.isComplete === false
                ],
                action: "Handle incomplete step"
              }
            ]
          }
        ]
      });

      const step = route.getStep("complex-step")!;

      // Test all levels
      const agentMatches = await agent.evaluateGuidelines(
        mockTemplateContext.context,
        mockTemplateContext.session,
        mockTemplateContext.history
      );

      const routeMatches = await route.evaluateGuidelines(
        mockTemplateContext.context,
        mockTemplateContext.session,
        mockTemplateContext.history
      );

      const stepMatches = await step.evaluateGuidelines(
        mockTemplateContext.context,
        mockTemplateContext.session,
        mockTemplateContext.history
      );

      expect(agentMatches).toHaveLength(1);
      expect(routeMatches).toHaveLength(1);
      expect(stepMatches).toHaveLength(1);

      expect(agentMatches[0].guideline.id).toBe("agent-complex");
      expect(routeMatches[0].guideline.id).toBe("route-complex");
      expect(stepMatches[0].guideline.id).toBe("step-complex");
    });
  });
});