import { expect, test, describe, beforeEach } from "bun:test";
import { Agent, Route, ConditionTemplate, TemplateContext } from "../src/index";
import { MockProviderFactory } from "./mock-provider";

interface TestData {
  userType?: "premium" | "basic";
  hasPayment?: boolean;
  isComplete?: boolean;
  bookingStatus?: "pending" | "confirmed" | "cancelled";
}

interface TestContext {
  userId?: string;
  sessionType?: "new" | "returning" | "expired";
}

describe("Route Condition Evaluation", () => {
  let agent: Agent<TestContext, TestData>;
  let mockTemplateContext: TemplateContext<TestContext, TestData>;

  beforeEach(() => {
    agent = new Agent<TestContext, TestData>({
      name: "RouteConditionTestAgent",
      description: "Agent for testing route condition evaluation",
      provider: MockProviderFactory.basic(),
      schema: {
        type: "object",
        properties: {
          userType: { type: "string", enum: ["premium", "basic"] },
          hasPayment: { type: "boolean" },
          isComplete: { type: "boolean" },
          bookingStatus: { type: "string", enum: ["pending", "confirmed", "cancelled"] },
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

  describe("Route when condition evaluation", () => {
    test("should evaluate string when conditions", async () => {
      const route = agent.createRoute({
        title: "String When Route",
        when: "user wants to book a flight"
      });

      const result = await route.evaluateWhen(mockTemplateContext);

      expect(result.programmaticResult).toBe(true);
      expect(result.aiContextStrings).toEqual(["user wants to book a flight"]);
      expect(result.hasProgrammaticConditions).toBe(false);
    });

    test("should evaluate function when conditions", async () => {
      const route = agent.createRoute({
        title: "Function When Route",
        when: (ctx) => ctx.data?.userType === "premium"
      });

      const result = await route.evaluateWhen(mockTemplateContext);

      expect(result.programmaticResult).toBe(true);
      expect(result.aiContextStrings).toEqual([]);
      expect(result.hasProgrammaticConditions).toBe(true);
    });

    test("should evaluate array when conditions with AND logic", async () => {
      const route = agent.createRoute({
        title: "Array When Route",
        when: [
          "user wants premium service",
          (ctx) => ctx.data?.userType === "premium",
          (ctx) => ctx.data?.hasPayment === true
        ]
      });

      const result = await route.evaluateWhen(mockTemplateContext);

      expect(result.programmaticResult).toBe(true); // Both functions return true
      expect(result.aiContextStrings).toEqual(["user wants premium service"]);
      expect(result.hasProgrammaticConditions).toBe(true);
    });

    test("should handle when condition with failing function", async () => {
      const route = agent.createRoute({
        title: "Failing When Route",
        when: [
          "user wants service",
          (ctx) => ctx.data?.userType === "premium", // true
          (ctx) => ctx.data?.isComplete === true      // false
        ]
      });

      const result = await route.evaluateWhen(mockTemplateContext);

      expect(result.programmaticResult).toBe(false); // One function fails
      expect(result.aiContextStrings).toEqual(["user wants service"]);
      expect(result.hasProgrammaticConditions).toBe(true);
    });

    test("should handle undefined when condition", async () => {
      const route = agent.createRoute({
        title: "No When Route"
        // No when condition
      });

      const result = await route.evaluateWhen(mockTemplateContext);

      expect(result.programmaticResult).toBe(true); // No condition means always eligible
      expect(result.aiContextStrings).toEqual([]);
      expect(result.hasProgrammaticConditions).toBe(false);
    });

    test("should handle async function when conditions", async () => {
      const route = agent.createRoute({
        title: "Async When Route",
        when: async (ctx) => {
          await new Promise(resolve => setTimeout(resolve, 10));
          return ctx.data?.userType === "premium";
        }
      });

      const result = await route.evaluateWhen(mockTemplateContext);

      expect(result.programmaticResult).toBe(true);
      expect(result.hasProgrammaticConditions).toBe(true);
    });
  });

  describe("Route skipIf condition evaluation", () => {
    test("should evaluate string skipIf conditions", async () => {
      const route = agent.createRoute({
        title: "String SkipIf Route",
        skipIf: "booking already cancelled"
      });

      const result = await route.evaluateSkipIf(mockTemplateContext);

      expect(result.programmaticResult).toBe(false); // OR default for strings
      expect(result.aiContextStrings).toEqual(["booking already cancelled"]);
      expect(result.hasProgrammaticConditions).toBe(false);
    });

    test("should evaluate function skipIf conditions", async () => {
      const route = agent.createRoute({
        title: "Function SkipIf Route",
        skipIf: (ctx) => ctx.data?.isComplete === true
      });

      const result = await route.evaluateSkipIf(mockTemplateContext);

      expect(result.programmaticResult).toBe(false); // isComplete is false
      expect(result.aiContextStrings).toEqual([]);
      expect(result.hasProgrammaticConditions).toBe(true);
    });

    test("should evaluate array skipIf conditions with OR logic", async () => {
      const route = agent.createRoute({
        title: "Array SkipIf Route",
        skipIf: [
          "booking cancelled",
          (ctx) => ctx.data?.isComplete === true,      // false
          (ctx) => ctx.data?.bookingStatus === "cancelled" // undefined, falsy
        ]
      });

      const result = await route.evaluateSkipIf(mockTemplateContext);

      expect(result.programmaticResult).toBe(false); // All functions return false
      expect(result.aiContextStrings).toEqual(["booking cancelled"]);
      expect(result.hasProgrammaticConditions).toBe(true);
    });

    test("should handle skipIf condition with succeeding function", async () => {
      const route = agent.createRoute({
        title: "Succeeding SkipIf Route",
        skipIf: [
          "booking cancelled",
          (ctx) => ctx.data?.isComplete === true,    // false
          (ctx) => ctx.data?.hasPayment === true     // true
        ]
      });

      const result = await route.evaluateSkipIf(mockTemplateContext);

      expect(result.programmaticResult).toBe(true); // One function succeeds
      expect(result.aiContextStrings).toEqual(["booking cancelled"]);
      expect(result.hasProgrammaticConditions).toBe(true);
    });

    test("should handle undefined skipIf condition", async () => {
      const route = agent.createRoute({
        title: "No SkipIf Route"
        // No skipIf condition
      });

      const result = await route.evaluateSkipIf(mockTemplateContext);

      expect(result.programmaticResult).toBe(false); // No skipIf means never skip
      expect(result.aiContextStrings).toEqual([]);
      expect(result.hasProgrammaticConditions).toBe(false);
    });

    test("should handle async function skipIf conditions", async () => {
      const route = agent.createRoute({
        title: "Async SkipIf Route",
        skipIf: async (ctx) => {
          await new Promise(resolve => setTimeout(resolve, 10));
          return ctx.data?.isComplete === true;
        }
      });

      const result = await route.evaluateSkipIf(mockTemplateContext);

      expect(result.programmaticResult).toBe(false); // isComplete is false
      expect(result.hasProgrammaticConditions).toBe(true);
    });
  });

  describe("AI context string collection", () => {
    test("should collect AI context strings from when conditions", async () => {
      const route = agent.createRoute({
        title: "Context Collection Route",
        when: [
          "user wants premium booking",
          (ctx) => ctx.data?.userType === "premium",
          "payment information available",
          (ctx) => ctx.data?.hasPayment === true
        ]
      });

      const result = await route.evaluateWhen(mockTemplateContext);

      expect(result.aiContextStrings).toEqual([
        "user wants premium booking",
        "payment information available"
      ]);
    });

    test("should collect AI context strings from skipIf conditions", async () => {
      const route = agent.createRoute({
        title: "SkipIf Context Route",
        skipIf: [
          "booking already confirmed",
          (ctx) => ctx.data?.bookingStatus === "confirmed",
          "user session expired",
          (ctx) => ctx.context?.sessionType === "expired"
        ]
      });

      const result = await route.evaluateSkipIf(mockTemplateContext);

      expect(result.aiContextStrings).toEqual([
        "booking already confirmed",
        "user session expired"
      ]);
    });

    test("should handle nested arrays in context collection", async () => {
      const route = agent.createRoute({
        title: "Nested Context Route",
        when: [
          "user interaction",
          [
            "premium user detected",
            (ctx) => ctx.data?.userType === "premium",
            "payment ready"
          ]
        ]
      });

      const result = await route.evaluateWhen(mockTemplateContext);

      expect(result.aiContextStrings).toEqual([
        "user interaction",
        "premium user detected",
        "payment ready"
      ]);
    });
  });

  describe("Backward compatibility scenarios", () => {
    test("should handle legacy string array conditions", async () => {
      // Test that old-style string arrays still work
      const route = agent.createRoute({
        title: "Legacy Route",
        when: [
          "user wants to book",
          "payment required"
        ]
      });

      const result = await route.evaluateWhen(mockTemplateContext);

      expect(result.programmaticResult).toBe(true); // AND default for all strings
      expect(result.aiContextStrings).toEqual(["user wants to book", "payment required"]);
      expect(result.hasProgrammaticConditions).toBe(false);
    });

    test("should handle mixed legacy and new conditions", async () => {
      const route = agent.createRoute({
        title: "Mixed Legacy Route",
        when: [
          "user wants premium service", // legacy string
          (ctx) => ctx.data?.userType === "premium" // new function
        ]
      });

      const result = await route.evaluateWhen(mockTemplateContext);

      expect(result.programmaticResult).toBe(true);
      expect(result.aiContextStrings).toEqual(["user wants premium service"]);
      expect(result.hasProgrammaticConditions).toBe(true);
    });

    test("should handle single string conditions", async () => {
      const route = agent.createRoute({
        title: "Single String Route",
        when: "user needs help"
      });

      const result = await route.evaluateWhen(mockTemplateContext);

      expect(result.programmaticResult).toBe(true);
      expect(result.aiContextStrings).toEqual(["user needs help"]);
      expect(result.hasProgrammaticConditions).toBe(false);
    });

    test("should handle single function conditions", async () => {
      const route = agent.createRoute({
        title: "Single Function Route",
        when: (ctx) => ctx.data?.userType === "premium"
      });

      const result = await route.evaluateWhen(mockTemplateContext);

      expect(result.programmaticResult).toBe(true);
      expect(result.aiContextStrings).toEqual([]);
      expect(result.hasProgrammaticConditions).toBe(true);
    });
  });

  describe("Error handling", () => {
    test("should handle function errors in when conditions", async () => {
      const route = agent.createRoute({
        title: "Error When Route",
        when: [
          "user wants service",
          () => { throw new Error("Test error"); }
        ]
      });

      const result = await route.evaluateWhen(mockTemplateContext);

      expect(result.programmaticResult).toBe(false); // Error defaults to false
      expect(result.aiContextStrings).toEqual(["user wants service"]);
      expect(result.hasProgrammaticConditions).toBe(true);
    });

    test("should handle function errors in skipIf conditions", async () => {
      const route = agent.createRoute({
        title: "Error SkipIf Route",
        skipIf: [
          "booking cancelled",
          () => { throw new Error("Test error"); }
        ]
      });

      const result = await route.evaluateSkipIf(mockTemplateContext);

      expect(result.programmaticResult).toBe(false); // Error defaults to false
      expect(result.aiContextStrings).toEqual(["booking cancelled"]);
      expect(result.hasProgrammaticConditions).toBe(true);
    });

    test("should handle malformed conditions gracefully", async () => {
      const route = agent.createRoute({
        title: "Malformed Route",
        when: 123 as any // Invalid condition type
      });

      const result = await route.evaluateWhen(mockTemplateContext);

      expect(result.programmaticResult).toBe(true); // AND default
      expect(result.aiContextStrings).toEqual([]);
      expect(result.hasProgrammaticConditions).toBe(false);
    });
  });

  describe("Complex scenarios", () => {
    test("should handle complex mixed conditions", async () => {
      const route = agent.createRoute({
        title: "Complex Route",
        when: [
          "user interaction detected",
          (ctx) => ctx.context?.sessionType === "returning",
          [
            "premium features requested",
            (ctx) => ctx.data?.userType === "premium",
            "payment verification complete"
          ],
          (ctx) => ctx.data?.hasPayment === true
        ]
      });

      const result = await route.evaluateWhen(mockTemplateContext);

      expect(result.programmaticResult).toBe(true); // All functions should pass
      expect(result.aiContextStrings).toEqual([
        "user interaction detected",
        "premium features requested",
        "payment verification complete"
      ]);
      expect(result.hasProgrammaticConditions).toBe(true);
    });

    test("should handle route with both when and skipIf", async () => {
      const route = agent.createRoute({
        title: "When and SkipIf Route",
        when: [
          "user wants service",
          (ctx) => ctx.data?.userType === "premium"
        ],
        skipIf: [
          "service unavailable",
          (ctx) => ctx.data?.isComplete === true
        ]
      });

      const whenResult = await route.evaluateWhen(mockTemplateContext);
      const skipResult = await route.evaluateSkipIf(mockTemplateContext);

      expect(whenResult.programmaticResult).toBe(true);
      expect(whenResult.aiContextStrings).toEqual(["user wants service"]);

      expect(skipResult.programmaticResult).toBe(false);
      expect(skipResult.aiContextStrings).toEqual(["service unavailable"]);
    });
  });
});