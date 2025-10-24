import { expect, test, describe, beforeEach } from "bun:test";
import { Agent, Step, ConditionTemplate, TemplateContext } from "../src/index";
import { MockProviderFactory } from "./mock-provider";

interface TestData {
  userType?: "premium" | "basic";
  hasPayment?: boolean;
  isComplete?: boolean;
  stepData?: string;
  priority?: "low" | "medium" | "high";
}

interface TestContext {
  userId?: string;
  sessionType?: "new" | "returning" | "expired";
}

describe("Step Condition Evaluation", () => {
  let agent: Agent<TestContext, TestData>;
  let mockTemplateContext: TemplateContext<TestContext, TestData>;

  beforeEach(() => {
    agent = new Agent<TestContext, TestData>({
      name: "StepConditionTestAgent",
      description: "Agent for testing step condition evaluation",
      provider: MockProviderFactory.basic(),
      schema: {
        type: "object",
        properties: {
          userType: { type: "string", enum: ["premium", "basic"] },
          hasPayment: { type: "boolean" },
          isComplete: { type: "boolean" },
          stepData: { type: "string" },
          priority: { type: "string", enum: ["low", "medium", "high"] },
        },
      },
    });

    mockTemplateContext = {
      context: { userId: "user123", sessionType: "returning" },
      data: { userType: "premium", hasPayment: true, isComplete: false },
      session: {
        id: "test-session",
        data: { userType: "premium", hasPayment: true, isComplete: false },
      },
      history: []
    };
  });

  describe("Step when condition evaluation", () => {
    test("should evaluate string when conditions", async () => {
      const route = agent.createRoute({
        title: "String When Step Route",
        steps: [
          {
            id: "string-when-step",
            prompt: "Test step",
            when: "user needs premium support"
          }
        ]
      });

      const step = route.getStep("string-when-step")!;
      const result = await step.evaluateWhen(mockTemplateContext);

      expect(result.shouldActivate).toBe(true);
      expect(result.aiContextStrings).toEqual(["user needs premium support"]);
      expect(result.hasProgrammaticConditions).toBe(false);
    });

    test("should evaluate function when conditions", async () => {
      const route = agent.createRoute({
        title: "Function When Step Route",
        steps: [
          {
            id: "function-when-step",
            prompt: "Test step",
            when: (ctx) => ctx.data?.userType === "premium"
          }
        ]
      });

      const step = route.getStep("function-when-step")!;
      const result = await step.evaluateWhen(mockTemplateContext);

      expect(result.shouldActivate).toBe(true);
      expect(result.aiContextStrings).toEqual([]);
      expect(result.hasProgrammaticConditions).toBe(true);
    });

    test("should evaluate array when conditions with AND logic", async () => {
      const route = agent.createRoute({
        title: "Array When Step Route",
        steps: [
          {
            id: "array-when-step",
            prompt: "Test step",
            when: [
              "premium support needed",
              (ctx) => ctx.data?.userType === "premium",
              (ctx) => ctx.data?.hasPayment === true
            ]
          }
        ]
      });

      const step = route.getStep("array-when-step")!;
      const result = await step.evaluateWhen(mockTemplateContext);

      expect(result.shouldActivate).toBe(true); // Both functions return true
      expect(result.aiContextStrings).toEqual(["premium support needed"]);
      expect(result.hasProgrammaticConditions).toBe(true);
    });

    test("should handle when condition with failing function", async () => {
      const route = agent.createRoute({
        title: "Failing When Step Route",
        steps: [
          {
            id: "failing-when-step",
            prompt: "Test step",
            when: [
              "support needed",
              (ctx) => ctx.data?.userType === "premium", // true
              (ctx) => ctx.data?.isComplete === true      // false
            ]
          }
        ]
      });

      const step = route.getStep("failing-when-step")!;
      const result = await step.evaluateWhen(mockTemplateContext);

      expect(result.shouldActivate).toBe(false); // One function fails
      expect(result.aiContextStrings).toEqual(["support needed"]);
      expect(result.hasProgrammaticConditions).toBe(true);
    });

    test("should handle undefined when condition", async () => {
      const route = agent.createRoute({
        title: "No When Step Route",
        steps: [
          {
            id: "no-when-step",
            prompt: "Test step"
            // No when condition
          }
        ]
      });

      const step = route.getStep("no-when-step")!;
      const result = await step.evaluateWhen(mockTemplateContext);

      expect(result.shouldActivate).toBe(true); // No condition means always activate
      expect(result.aiContextStrings).toEqual([]);
      expect(result.hasProgrammaticConditions).toBe(false);
    });

    test("should handle async function when conditions", async () => {
      const route = agent.createRoute({
        title: "Async When Step Route",
        steps: [
          {
            id: "async-when-step",
            prompt: "Test step",
            when: async (ctx) => {
              await new Promise(resolve => setTimeout(resolve, 10));
              return ctx.data?.userType === "premium";
            }
          }
        ]
      });

      const step = route.getStep("async-when-step")!;
      const result = await step.evaluateWhen(mockTemplateContext);

      expect(result.shouldActivate).toBe(true);
      expect(result.hasProgrammaticConditions).toBe(true);
    });
  });

  describe("Step skipIf condition evaluation", () => {
    test("should evaluate string skipIf conditions", async () => {
      const route = agent.createRoute({
        title: "String SkipIf Step Route",
        steps: [
          {
            id: "string-skipif-step",
            prompt: "Test step",
            skipIf: "step already completed"
          }
        ]
      });

      const step = route.getStep("string-skipif-step")!;
      const result = await step.evaluateSkipIf(mockTemplateContext);

      expect(result.shouldSkip).toBe(false); // OR default for strings
      expect(result.aiContextStrings).toEqual(["step already completed"]);
      expect(result.hasProgrammaticConditions).toBe(false);
    });

    test("should evaluate function skipIf conditions", async () => {
      const route = agent.createRoute({
        title: "Function SkipIf Step Route",
        steps: [
          {
            id: "function-skipif-step",
            prompt: "Test step",
            skipIf: (ctx) => ctx.data?.isComplete === true
          }
        ]
      });

      const step = route.getStep("function-skipif-step")!;
      const result = await step.evaluateSkipIf(mockTemplateContext);

      expect(result.shouldSkip).toBe(false); // isComplete is false
      expect(result.aiContextStrings).toEqual([]);
      expect(result.hasProgrammaticConditions).toBe(true);
    });

    test("should evaluate array skipIf conditions with OR logic", async () => {
      const route = agent.createRoute({
        title: "Array SkipIf Step Route",
        steps: [
          {
            id: "array-skipif-step",
            prompt: "Test step",
            skipIf: [
              "step not needed",
              (ctx) => ctx.data?.isComplete === true,      // false
              (ctx) => ctx.data?.priority === "low"        // undefined, falsy
            ]
          }
        ]
      });

      const step = route.getStep("array-skipif-step")!;
      const result = await step.evaluateSkipIf(mockTemplateContext);

      expect(result.shouldSkip).toBe(false); // All functions return false
      expect(result.aiContextStrings).toEqual(["step not needed"]);
      expect(result.hasProgrammaticConditions).toBe(true);
    });

    test("should handle skipIf condition with succeeding function", async () => {
      const route = agent.createRoute({
        title: "Succeeding SkipIf Step Route",
        steps: [
          {
            id: "succeeding-skipif-step",
            prompt: "Test step",
            skipIf: [
              "step not needed",
              (ctx) => ctx.data?.isComplete === true,    // false
              (ctx) => ctx.data?.hasPayment === true     // true
            ]
          }
        ]
      });

      const step = route.getStep("succeeding-skipif-step")!;
      const result = await step.evaluateSkipIf(mockTemplateContext);

      expect(result.shouldSkip).toBe(true); // One function succeeds
      expect(result.aiContextStrings).toEqual(["step not needed"]);
      expect(result.hasProgrammaticConditions).toBe(true);
    });

    test("should handle undefined skipIf condition", async () => {
      const route = agent.createRoute({
        title: "No SkipIf Step Route",
        steps: [
          {
            id: "no-skipif-step",
            prompt: "Test step"
            // No skipIf condition
          }
        ]
      });

      const step = route.getStep("no-skipif-step")!;
      const result = await step.evaluateSkipIf(mockTemplateContext);

      expect(result.shouldSkip).toBe(false); // No skipIf means never skip
      expect(result.aiContextStrings).toEqual([]);
      expect(result.hasProgrammaticConditions).toBe(false);
    });

    test("should handle async function skipIf conditions", async () => {
      const route = agent.createRoute({
        title: "Async SkipIf Step Route",
        steps: [
          {
            id: "async-skipif-step",
            prompt: "Test step",
            skipIf: async (ctx) => {
              await new Promise(resolve => setTimeout(resolve, 10));
              return ctx.data?.isComplete === true;
            }
          }
        ]
      });

      const step = route.getStep("async-skipif-step")!;
      const result = await step.evaluateSkipIf(mockTemplateContext);

      expect(result.shouldSkip).toBe(false); // isComplete is false
      expect(result.hasProgrammaticConditions).toBe(true);
    });
  });

  describe("AI context string collection", () => {
    test("should collect AI context strings from when conditions", async () => {
      const route = agent.createRoute({
        title: "When Context Step Route",
        steps: [
          {
            id: "when-context-step",
            prompt: "Test step",
            when: [
              "premium support required",
              (ctx) => ctx.data?.userType === "premium",
              "payment verification needed",
              (ctx) => ctx.data?.hasPayment === true
            ]
          }
        ]
      });

      const step = route.getStep("when-context-step")!;
      const result = await step.evaluateWhen(mockTemplateContext);

      expect(result.aiContextStrings).toEqual([
        "premium support required",
        "payment verification needed"
      ]);
    });

    test("should collect AI context strings from skipIf conditions", async () => {
      const route = agent.createRoute({
        title: "SkipIf Context Step Route",
        steps: [
          {
            id: "skipif-context-step",
            prompt: "Test step",
            skipIf: [
              "step already completed",
              (ctx) => ctx.data?.isComplete === true,
              "user session expired",
              (ctx) => ctx.context?.sessionType === "expired"
            ]
          }
        ]
      });

      const step = route.getStep("skipif-context-step")!;
      const result = await step.evaluateSkipIf(mockTemplateContext);

      expect(result.aiContextStrings).toEqual([
        "step already completed",
        "user session expired"
      ]);
    });

    test("should handle nested arrays in context collection", async () => {
      const route = agent.createRoute({
        title: "Nested Context Step Route",
        steps: [
          {
            id: "nested-context-step",
            prompt: "Test step",
            when: [
              "step activation needed",
              [
                "premium user detected",
                (ctx) => ctx.data?.userType === "premium",
                "payment ready"
              ]
            ]
          }
        ]
      });

      const step = route.getStep("nested-context-step")!;
      const result = await step.evaluateWhen(mockTemplateContext);

      expect(result.aiContextStrings).toEqual([
        "step activation needed",
        "premium user detected",
        "payment ready"
      ]);
    });
  });

  describe("Integration with routing logic", () => {
    test("should integrate when and skipIf evaluation", async () => {
      const route = agent.createRoute({
        title: "Integration Step Route",
        steps: [
          {
            id: "integration-step",
            prompt: "Test step",
            when: [
              "step needed",
              (ctx) => ctx.data?.userType === "premium"
            ],
            skipIf: [
              "step not applicable",
              (ctx) => ctx.data?.isComplete === true
            ]
          }
        ]
      });

      const step = route.getStep("integration-step")!;
      
      const whenResult = await step.evaluateWhen(mockTemplateContext);
      const skipResult = await step.evaluateSkipIf(mockTemplateContext);

      expect(whenResult.shouldActivate).toBe(true);
      expect(whenResult.aiContextStrings).toEqual(["step needed"]);

      expect(skipResult.shouldSkip).toBe(false);
      expect(skipResult.aiContextStrings).toEqual(["step not applicable"]);
    });

    test("should handle step with requires field", async () => {
      const route = agent.createRoute({
        title: "Requires Step Route",
        steps: [
          {
            id: "requires-step",
            prompt: "Test step",
            requires: ["userType", "hasPayment"],
            when: (ctx) => ctx.data?.userType === "premium"
          }
        ]
      });

      const step = route.getStep("requires-step")!;
      
      // Test that step has requires
      expect(step.requires).toEqual(["userType", "hasPayment"]);
      
      // Test condition evaluation still works
      const result = await step.evaluateWhen(mockTemplateContext);
      expect(result.shouldActivate).toBe(true);
    });

    test("should handle step with collect field", async () => {
      const route = agent.createRoute({
        title: "Collect Step Route",
        steps: [
          {
            id: "collect-step",
            prompt: "Test step",
            collect: ["stepData"],
            when: "data collection needed",
            skipIf: (ctx) => ctx.data?.stepData !== undefined
          }
        ]
      });

      const step = route.getStep("collect-step")!;
      
      // Test that step has collect
      expect(step.collect).toEqual(["stepData"]);
      
      // Test condition evaluation
      const whenResult = await step.evaluateWhen(mockTemplateContext);
      const skipResult = await step.evaluateSkipIf(mockTemplateContext);
      
      expect(whenResult.shouldActivate).toBe(true);
      expect(whenResult.aiContextStrings).toEqual(["data collection needed"]);
      
      expect(skipResult.shouldSkip).toBe(false); // stepData is undefined, so ctx.data?.stepData !== undefined is false
    });
  });

  describe("Error handling", () => {
    test("should handle function errors in when conditions", async () => {
      const route = agent.createRoute({
        title: "Error When Step Route",
        steps: [
          {
            id: "error-when-step",
            prompt: "Test step",
            when: [
              "step needed",
              () => { throw new Error("Test error"); }
            ]
          }
        ]
      });

      const step = route.getStep("error-when-step")!;
      const result = await step.evaluateWhen(mockTemplateContext);

      expect(result.shouldActivate).toBe(false); // Error defaults to false
      expect(result.aiContextStrings).toEqual(["step needed"]);
      expect(result.hasProgrammaticConditions).toBe(true);
    });

    test("should handle function errors in skipIf conditions", async () => {
      const route = agent.createRoute({
        title: "Error SkipIf Step Route",
        steps: [
          {
            id: "error-skipif-step",
            prompt: "Test step",
            skipIf: [
              "step not needed",
              () => { throw new Error("Test error"); }
            ]
          }
        ]
      });

      const step = route.getStep("error-skipif-step")!;
      const result = await step.evaluateSkipIf(mockTemplateContext);

      expect(result.shouldSkip).toBe(false); // Error defaults to false
      expect(result.aiContextStrings).toEqual(["step not needed"]);
      expect(result.hasProgrammaticConditions).toBe(true);
    });

    test("should handle malformed conditions gracefully", async () => {
      const route = agent.createRoute({
        title: "Malformed Step Route",
        steps: [
          {
            id: "malformed-step",
            prompt: "Test step",
            when: 123 as any // Invalid condition type
          }
        ]
      });

      const step = route.getStep("malformed-step")!;
      const result = await step.evaluateWhen(mockTemplateContext);

      expect(result.shouldActivate).toBe(true); // AND default
      expect(result.aiContextStrings).toEqual([]);
      expect(result.hasProgrammaticConditions).toBe(false);
    });
  });

  describe("Complex scenarios", () => {
    test("should handle complex mixed conditions", async () => {
      const route = agent.createRoute({
        title: "Complex Step Route",
        steps: [
          {
            id: "complex-step",
            prompt: "Test step",
            when: [
              "complex step activation",
              (ctx) => ctx.context?.sessionType === "returning",
              [
                "premium features needed",
                (ctx) => ctx.data?.userType === "premium",
                "payment verification complete"
              ],
              (ctx) => ctx.data?.hasPayment === true
            ]
          }
        ]
      });

      const step = route.getStep("complex-step")!;
      const result = await step.evaluateWhen(mockTemplateContext);

      expect(result.shouldActivate).toBe(true); // All functions should pass
      expect(result.aiContextStrings).toEqual([
        "complex step activation",
        "premium features needed",
        "payment verification complete"
      ]);
      expect(result.hasProgrammaticConditions).toBe(true);
    });

    test("should handle step with multiple condition types", async () => {
      const route = agent.createRoute({
        title: "Multi-Condition Step Route",
        steps: [
          {
            id: "multi-condition-step",
            prompt: "Test step",
            when: [
              "step activation required",
              (ctx) => ctx.data?.userType === "premium"
            ],
            skipIf: [
              "step should be skipped",
              (ctx) => ctx.data?.isComplete === true
            ],
            requires: ["userType"],
            collect: ["stepData"]
          }
        ]
      });

      const step = route.getStep("multi-condition-step")!;
      
      const whenResult = await step.evaluateWhen(mockTemplateContext);
      const skipResult = await step.evaluateSkipIf(mockTemplateContext);

      expect(whenResult.shouldActivate).toBe(true);
      expect(whenResult.aiContextStrings).toEqual(["step activation required"]);

      expect(skipResult.shouldSkip).toBe(false);
      expect(skipResult.aiContextStrings).toEqual(["step should be skipped"]);

      expect(step.requires).toEqual(["userType"]);
      expect(step.collect).toEqual(["stepData"]);
    });
  });

  describe("Backward compatibility", () => {
    test("should handle legacy function-only skipIf", async () => {
      const route = agent.createRoute({
        title: "Legacy SkipIf Step Route",
        steps: [
          {
            id: "legacy-skipif-step",
            prompt: "Test step",
            skipIf: (ctx) => ctx.data?.isComplete === true // Legacy function-only
          }
        ]
      });

      const step = route.getStep("legacy-skipif-step")!;
      const result = await step.evaluateSkipIf(mockTemplateContext);

      expect(result.shouldSkip).toBe(false); // isComplete is false
      expect(result.aiContextStrings).toEqual([]);
      expect(result.hasProgrammaticConditions).toBe(true);
    });

    test("should handle legacy string when conditions", async () => {
      const route = agent.createRoute({
        title: "Legacy When Step Route",
        steps: [
          {
            id: "legacy-when-step",
            prompt: "Test step",
            when: "step needed" // Legacy string
          }
        ]
      });

      const step = route.getStep("legacy-when-step")!;
      const result = await step.evaluateWhen(mockTemplateContext);

      expect(result.shouldActivate).toBe(true);
      expect(result.aiContextStrings).toEqual(["step needed"]);
      expect(result.hasProgrammaticConditions).toBe(false);
    });
  });
});