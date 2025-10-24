import { expect, test, describe, beforeEach } from "bun:test";
import { ConditionTemplate, TemplateContext } from "../src/types/template";
import { ConditionEvaluator, extractAIContextStrings, hasProgrammaticConditions } from "../src/utils/condition";
import { createTemplateContext } from "../src/utils";

interface TestData {
  name?: string;
  hasPayment?: boolean;
  isComplete?: boolean;
}

interface TestContext {
  userType?: string;
}

describe("ConditionEvaluator", () => {
  const mockTemplateContext: TemplateContext<TestContext, TestData> = createTemplateContext({
    context: { userType: "premium" },
    data: { name: "John", hasPayment: true, isComplete: false },
    session: {
      id: "test-session",
      data: { name: "John", hasPayment: true, isComplete: false },
    },
    history: []
  });

  let evaluator: ConditionEvaluator<TestContext, TestData>;

  beforeEach(() => {
    evaluator = new ConditionEvaluator(mockTemplateContext);
  });

  test("should evaluate string conditions as AI context only", async () => {
    const condition: ConditionTemplate<TestContext, TestData> = "user wants to book";
    const result = await evaluator.evaluateCondition(condition, 'AND');
    
    expect(result.programmaticResult).toBe(true); // AND logic default for strings
    expect(result.aiContextStrings).toEqual(["user wants to book"]);
    expect(result.hasProgrammaticConditions).toBe(false);
  });

  test("should evaluate function conditions programmatically", async () => {
    const condition: ConditionTemplate<TestContext, TestData> = 
      (ctx) => ctx.data?.hasPayment === true;
    
    const result = await evaluator.evaluateCondition(condition, 'AND');
    
    expect(result.programmaticResult).toBe(true);
    expect(result.aiContextStrings).toEqual([]);
    expect(result.hasProgrammaticConditions).toBe(true);
  });

  test("should evaluate array conditions with AND logic", async () => {
    const condition: ConditionTemplate<TestContext, TestData> = [
      "user wants to book",
      (ctx) => ctx.data?.hasPayment === true,
      (ctx) => ctx.context?.userType === "premium"
    ];
    
    const result = await evaluator.evaluateCondition(condition, 'AND');
    
    expect(result.programmaticResult).toBe(true); // Both functions return true
    expect(result.aiContextStrings).toEqual(["user wants to book"]);
    expect(result.hasProgrammaticConditions).toBe(true);
  });

  test("should evaluate array conditions with OR logic", async () => {
    const condition: ConditionTemplate<TestContext, TestData> = [
      "booking already confirmed",
      (ctx) => ctx.data?.isComplete === true, // false
      (ctx) => ctx.data?.hasPayment === true  // true
    ];
    
    const result = await evaluator.evaluateCondition(condition, 'OR');
    
    expect(result.programmaticResult).toBe(true); // One function returns true
    expect(result.aiContextStrings).toEqual(["booking already confirmed"]);
    expect(result.hasProgrammaticConditions).toBe(true);
  });

  test("should handle function errors gracefully", async () => {
    const condition: ConditionTemplate<TestContext, TestData> = 
      () => { throw new Error("Test error"); };
    
    const result = await evaluator.evaluateCondition(condition, 'AND');
    
    expect(result.programmaticResult).toBe(false);
    expect(result.hasProgrammaticConditions).toBe(true);
  });

  test("should handle empty conditions", async () => {
    const result = await evaluator.evaluateCondition(undefined as any, 'AND');
    
    expect(result.programmaticResult).toBe(true); // AND default
    expect(result.aiContextStrings).toEqual([]);
    expect(result.hasProgrammaticConditions).toBe(false);
  });

  test("should handle null conditions", async () => {
    const result = await evaluator.evaluateCondition(null as any, 'AND');
    
    expect(result.programmaticResult).toBe(true); // AND default
    expect(result.aiContextStrings).toEqual([]);
    expect(result.hasProgrammaticConditions).toBe(false);
  });

  test("should handle empty array conditions", async () => {
    const condition: ConditionTemplate<TestContext, TestData> = [];
    const result = await evaluator.evaluateCondition(condition, 'AND');
    
    expect(result.programmaticResult).toBe(true); // AND default for empty array
    expect(result.aiContextStrings).toEqual([]);
    expect(result.hasProgrammaticConditions).toBe(false);
  });

  test("should handle nested array conditions", async () => {
    const condition: ConditionTemplate<TestContext, TestData> = [
      "user wants to book",
      [
        "payment required",
        (ctx) => ctx.data?.hasPayment === true
      ]
    ];
    
    const result = await evaluator.evaluateCondition(condition, 'AND');
    
    expect(result.programmaticResult).toBe(true);
    expect(result.aiContextStrings).toEqual(["user wants to book", "payment required"]);
    expect(result.hasProgrammaticConditions).toBe(true);
  });

  test("should handle async function conditions", async () => {
    const condition: ConditionTemplate<TestContext, TestData> = 
      async (ctx) => {
        await new Promise(resolve => setTimeout(resolve, 10));
        return ctx.data?.hasPayment === true;
      };
    
    const result = await evaluator.evaluateCondition(condition, 'AND');
    
    expect(result.programmaticResult).toBe(true);
    expect(result.hasProgrammaticConditions).toBe(true);
  });

  test("should handle mixed array with all strings (no programmatic conditions)", async () => {
    const condition: ConditionTemplate<TestContext, TestData> = [
      "user wants to book",
      "payment required",
      "address provided"
    ];
    
    const result = await evaluator.evaluateCondition(condition, 'AND');
    
    expect(result.programmaticResult).toBe(true); // AND default when no functions
    expect(result.aiContextStrings).toEqual(["user wants to book", "payment required", "address provided"]);
    expect(result.hasProgrammaticConditions).toBe(false);
  });

  test("should handle OR logic with all strings", async () => {
    const condition: ConditionTemplate<TestContext, TestData> = [
      "booking cancelled",
      "user left",
      "timeout occurred"
    ];
    
    const result = await evaluator.evaluateCondition(condition, 'OR');
    
    expect(result.programmaticResult).toBe(false); // OR default when no functions
    expect(result.aiContextStrings).toEqual(["booking cancelled", "user left", "timeout occurred"]);
    expect(result.hasProgrammaticConditions).toBe(false);
  });

  test("should handle AND logic with failing functions", async () => {
    const condition: ConditionTemplate<TestContext, TestData> = [
      "user wants to book",
      (ctx) => ctx.data?.hasPayment === true, // true
      (ctx) => ctx.data?.isComplete === true  // false
    ];
    
    const result = await evaluator.evaluateCondition(condition, 'AND');
    
    expect(result.programmaticResult).toBe(false); // One function fails
    expect(result.aiContextStrings).toEqual(["user wants to book"]);
    expect(result.hasProgrammaticConditions).toBe(true);
  });

  test("should handle OR logic with one succeeding function", async () => {
    const condition: ConditionTemplate<TestContext, TestData> = [
      "booking cancelled",
      (ctx) => ctx.data?.isComplete === true,  // false
      (ctx) => ctx.data?.hasPayment === true   // true
    ];
    
    const result = await evaluator.evaluateCondition(condition, 'OR');
    
    expect(result.programmaticResult).toBe(true); // One function succeeds
    expect(result.aiContextStrings).toEqual(["booking cancelled"]);
    expect(result.hasProgrammaticConditions).toBe(true);
  });
  test("should handle malformed conditions gracefully", async () => {
    // Test with invalid types
    const invalidCondition = 123 as any;
    const result = await evaluator.evaluateCondition(invalidCondition, 'AND');
    
    expect(result.programmaticResult).toBe(true); // AND default
    expect(result.aiContextStrings).toEqual([]);
    expect(result.hasProgrammaticConditions).toBe(false);
  });

  test("should provide detailed evaluation information", async () => {
    const condition: ConditionTemplate<TestContext, TestData> = [
      "user wants to book",
      (ctx) => ctx.data?.hasPayment === true
    ];
    
    const result = await evaluator.evaluateCondition(condition, 'AND');
    
    expect(result.evaluationDetails).toBeDefined();
    expect(result.evaluationDetails?.length).toBeGreaterThan(0);
    expect(result.evaluationDetails?.[0].type).toBe('array');
  });
});

describe("Utility Functions", () => {
  test("extractAIContextStrings should extract strings from mixed conditions", () => {
    const condition: ConditionTemplate = [
      "user wants to book",
      () => true,
      "payment required"
    ];
    
    const strings = extractAIContextStrings(condition);
    expect(strings).toEqual(["user wants to book", "payment required"]);
  });

  test("extractAIContextStrings should handle nested arrays", () => {
    const condition: ConditionTemplate = [
      "user wants to book",
      [
        "payment required",
        () => true,
        "address provided"
      ]
    ];
    
    const strings = extractAIContextStrings(condition);
    expect(strings).toEqual(["user wants to book", "payment required", "address provided"]);
  });

  test("extractAIContextStrings should handle empty conditions", () => {
    expect(extractAIContextStrings(undefined as any)).toEqual([]);
    expect(extractAIContextStrings(null as any)).toEqual([]);
    expect(extractAIContextStrings([])).toEqual([]);
  });

  test("extractAIContextStrings should ignore functions", () => {
    const condition: ConditionTemplate = [
      () => true,
      () => false,
      "only string"
    ];
    
    const strings = extractAIContextStrings(condition);
    expect(strings).toEqual(["only string"]);
  });

  test("hasProgrammaticConditions should detect functions", () => {
    const stringCondition: ConditionTemplate = "user wants to book";
    const functionCondition: ConditionTemplate = () => true;
    const mixedCondition: ConditionTemplate = ["string", () => true];
    
    expect(hasProgrammaticConditions(stringCondition)).toBe(false);
    expect(hasProgrammaticConditions(functionCondition)).toBe(true);
    expect(hasProgrammaticConditions(mixedCondition)).toBe(true);
  });

  test("hasProgrammaticConditions should handle nested arrays", () => {
    const nestedCondition: ConditionTemplate = [
      "string",
      [
        "another string",
        () => true
      ]
    ];
    
    expect(hasProgrammaticConditions(nestedCondition)).toBe(true);
  });

  test("hasProgrammaticConditions should handle empty conditions", () => {
    expect(hasProgrammaticConditions(undefined as any)).toBe(false);
    expect(hasProgrammaticConditions(null as any)).toBe(false);
    expect(hasProgrammaticConditions([])).toBe(false);
  });
});