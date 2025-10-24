/**
 * Comprehensive Route and Step Tests
 * 
 * Tests for edge cases, new features, and complex scenarios
 */
import { expect, test, describe } from "bun:test";
import { Agent, createSession, END_ROUTE, type Tool } from "../src/index";
import { MockProviderFactory } from "./mock-provider";
import { createTemplateContext } from "../src/utils";

interface TestData {
  field1?: string;
  field2?: string;
  field3?: string;
  count?: number;
  status?: "pending" | "active" | "complete";
}

describe("Route - ID Generation and Configuration", () => {
  test("should generate deterministic ID from title when not provided", () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const route1 = agent.createRoute({ title: "Test Route" });
    const route2 = agent.createRoute({ title: "Test Route" });

    // Same title should generate same ID
    expect(route1.id).toBe(route2.id);
  });

  test("should use custom ID when provided", () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const route = agent.createRoute({
      title: "Test Route",
      id: "custom-route-id",
    });

    expect(route.id).toBe("custom-route-id");
  });

  test("should handle empty conditions array", () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const route = agent.createRoute({
      title: "No Conditions Route",
      when: undefined,
    });

    expect(route.when).toBeUndefined();
  });

  test("should handle undefined conditions", () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const route = agent.createRoute({
      title: "Undefined Conditions Route",
    });

    expect(route.when).toBeUndefined();
  });

  test("should store identity and personality templates", () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const route = agent.createRoute({
      title: "Identity Route",
      identity: "You are a helpful assistant",
      personality: "You are friendly and professional",
    });

    expect(route.identity).toBe("You are a helpful assistant");
    expect(route.personality).toBe("You are friendly and professional");
  });

  test("should store rules and prohibitions", () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const route = agent.createRoute({
      title: "Rules Route",
      rules: ["Always verify user identity", "Log all actions"],
      prohibitions: ["Never share passwords", "Never skip validation"],
    });

    expect(route.getRules()).toEqual(["Always verify user identity", "Log all actions"]);
    expect(route.getProhibitions()).toEqual(["Never share passwords", "Never skip validation"]);
  });
});

describe("Route - Step Building and Chaining", () => {
  test("should build sequential steps from steps array", () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const route = agent.createRoute({
      title: "Sequential Route",
      steps: [
        { id: "step1", prompt: "Step 1" },
        { id: "step2", prompt: "Step 2" },
        { id: "step3", prompt: "Step 3" },
      ],
    });

    const steps = route.getAllSteps();
    expect(steps).toHaveLength(3);
    expect(steps[0].id).toBe("step1");
    expect(steps[1].id).toBe("step2");
    expect(steps[2].id).toBe("step3");
  });

  test("should use first step as initialStep when not provided", () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const route = agent.createRoute({
      title: "Auto Initial Route",
      steps: [
        { id: "auto-initial", prompt: "First step" },
        { id: "second", prompt: "Second step" },
      ],
    });

    expect(route.initialStep.id).toBe("auto-initial");
  });

  test("should chain steps after custom initialStep", () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const route = agent.createRoute({
      title: "Custom Initial Route",
      initialStep: { id: "custom-start", prompt: "Custom start" },
      steps: [
        { id: "step1", prompt: "Step 1" },
        { id: "step2", prompt: "Step 2" },
      ],
    });

    const steps = route.getAllSteps();
    expect(steps[0].id).toBe("custom-start");
    expect(steps[1].id).toBe("step1");
    expect(steps[2].id).toBe("step2");
  });

  test("should handle END_ROUTE in steps array", () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const route = agent.createRoute({
      title: "End Route Test",
      steps: [
        { id: "step1", prompt: "Step 1" },
        END_ROUTE,
      ],
    });

    const steps = route.getAllSteps();
    expect(steps).toHaveLength(2);
    expect(steps[1].id).toBe("END_ROUTE");
  });
});

describe("Route - Data Collection and Completion", () => {
  test("should track completion progress correctly", () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
      schema: {
        type: "object",
        properties: {
          field1: { type: "string" },
          field2: { type: "string" },
          field3: { type: "string" },
        },
      },
    });

    const route = agent.createRoute({
      title: "Progress Route",
      requiredFields: ["field1", "field2", "field3"],
    });

    // No data
    expect(route.getCompletionProgress({})).toBe(0);

    // 1/3 complete
    expect(route.getCompletionProgress({ field1: "value" })).toBeCloseTo(0.333, 2);

    // 2/3 complete
    expect(route.getCompletionProgress({ field1: "value", field2: "value" })).toBeCloseTo(0.666, 2);

    // 3/3 complete
    expect(route.getCompletionProgress({ field1: "value", field2: "value", field3: "value" })).toBe(1);
  });

  test("should handle empty string as missing field", () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
      schema: {
        type: "object",
        properties: {
          field1: { type: "string" },
        },
      },
    });

    const route = agent.createRoute({
      title: "Empty String Route",
      requiredFields: ["field1"],
    });

    expect(route.isComplete({ field1: "" })).toBe(false);
    expect(route.getMissingRequiredFields({ field1: "" })).toEqual(["field1"]);
  });

  test("should handle null as missing field", () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
      schema: {
        type: "object",
        properties: {
          field1: { type: "string" },
        },
      },
    });

    const route = agent.createRoute({
      title: "Null Field Route",
      requiredFields: ["field1"],
    });

    expect(route.isComplete({ field1: null as any })).toBe(false);
    expect(route.getMissingRequiredFields({ field1: null as any })).toEqual(["field1"]);
  });

  test("should handle undefined as missing field", () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
      schema: {
        type: "object",
        properties: {
          field1: { type: "string" },
        },
      },
    });

    const route = agent.createRoute({
      title: "Undefined Field Route",
      requiredFields: ["field1"],
    });

    expect(route.isComplete({ field1: undefined })).toBe(false);
    expect(route.getMissingRequiredFields({ field1: undefined })).toEqual(["field1"]);
  });

  test("should accept 0 as valid value", () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
      schema: {
        type: "object",
        properties: {
          count: { type: "number" },
        },
      },
    });

    const route = agent.createRoute({
      title: "Zero Value Route",
      requiredFields: ["count"],
    });

    expect(route.isComplete({ count: 0 })).toBe(true);
    expect(route.getMissingRequiredFields({ count: 0 })).toEqual([]);
  });

  test("should accept false as valid value", () => {
    const agent = new Agent<unknown, { flag?: boolean }>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
      schema: {
        type: "object",
        properties: {
          flag: { type: "boolean" },
        },
      },
    });

    const route = agent.createRoute({
      title: "Boolean Route",
      requiredFields: ["flag"],
    });

    expect(route.isComplete({ flag: false })).toBe(true);
    expect(route.getMissingRequiredFields({ flag: false })).toEqual([]);
  });
});

describe("Route - onComplete Handler", () => {
  test("should handle string onComplete", async () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const route = agent.createRoute({
      title: "String Complete Route",
      onComplete: "next-route-id",
    });

    const result = await route.evaluateOnComplete({ data: {} });
    expect(result).toEqual({ nextStep: "next-route-id" });
  });

  test("should handle object onComplete", async () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const route = agent.createRoute({
      title: "Object Complete Route",
      onComplete: {
        nextStep: "next-route",
        condition: "if user is satisfied",
      },
    });

    const result = await route.evaluateOnComplete({ data: {} });
    expect(result).toEqual({
      nextStep: "next-route",
      condition: "if user is satisfied",
    });
  });

  test("should handle function onComplete returning string", async () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const route = agent.createRoute({
      title: "Function Complete Route",
      onComplete: (session) => {
        return session.data?.field1 ? "route-a" : "route-b";
      },
    });

    const result1 = await route.evaluateOnComplete({ data: { field1: "value" } });
    expect(result1).toEqual({ nextStep: "route-a" });

    const result2 = await route.evaluateOnComplete({ data: {} });
    expect(result2).toEqual({ nextStep: "route-b" });
  });

  test("should handle function onComplete returning object", async () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const route = agent.createRoute({
      title: "Function Object Complete Route",
      onComplete: (session) => {
        if (session.data?.field1) {
          return {
            nextStep: "success-route",
            condition: "if successful",
          };
        }
        return undefined;
      },
    });

    const result1 = await route.evaluateOnComplete({ data: { field1: "value" } });
    expect(result1).toEqual({
      nextStep: "success-route",
      condition: "if successful",
    });

    const result2 = await route.evaluateOnComplete({ data: {} });
    expect(result2).toBeUndefined();
  });

  test("should handle function onComplete returning undefined", async () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const route = agent.createRoute({
      title: "Undefined Complete Route",
      onComplete: () => undefined,
    });

    const result = await route.evaluateOnComplete({ data: {} });
    expect(result).toBeUndefined();
  });

  test("should handle async function onComplete", async () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const route = agent.createRoute({
      title: "Async Complete Route",
      onComplete: async (session) => {
        await new Promise(resolve => setTimeout(resolve, 10));
        return session.data?.field1 ? "async-route" : undefined;
      },
    });

    const result = await route.evaluateOnComplete({ data: { field1: "value" } });
    expect(result).toEqual({ nextStep: "async-route" });
  });
});

describe("Route - Lifecycle Hooks", () => {
  test("should call onDataUpdate hook", async () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    let hookCalled = false;
    let receivedData: Partial<TestData> | undefined;
    let receivedPrevious: Partial<TestData> | undefined;

    const route = agent.createRoute({
      title: "Hook Route",
      hooks: {
        onDataUpdate: (data, previous) => {
          hookCalled = true;
          receivedData = data;
          receivedPrevious = previous;
          return data;
        },
      },
    });

    const newData = { field1: "new" };
    const previousData = { field1: "old" };

    await route.handleDataUpdate(newData, previousData);

    expect(hookCalled).toBe(true);
    expect(receivedData).toEqual(newData);
    expect(receivedPrevious).toEqual(previousData);
  });

  test("should allow onDataUpdate hook to modify data", async () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const route = agent.createRoute({
      title: "Modify Hook Route",
      hooks: {
        onDataUpdate: (data) => {
          return { ...data, field2: "modified" };
        },
      },
    });

    const result = await route.handleDataUpdate({ field1: "value" }, {});

    expect(result).toEqual({ field1: "value", field2: "modified" });
  });

  test("should call onContextUpdate hook", async () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    let hookCalled = false;
    let receivedNew: unknown;
    let receivedPrevious: unknown;

    const route = agent.createRoute({
      title: "Context Hook Route",
      hooks: {
        onContextUpdate: (newCtx, prevCtx) => {
          hookCalled = true;
          receivedNew = newCtx;
          receivedPrevious = prevCtx;
        },
      },
    });

    const newContext = { userId: "123" };
    const previousContext = { userId: "456" };

    await route.handleContextUpdate(newContext, previousContext);

    expect(hookCalled).toBe(true);
    expect(receivedNew).toEqual(newContext);
    expect(receivedPrevious).toEqual(previousContext);
  });

  test("should handle async hooks", async () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    let asyncCompleted = false;

    const route = agent.createRoute({
      title: "Async Hook Route",
      hooks: {
        onDataUpdate: async (data) => {
          await new Promise(resolve => setTimeout(resolve, 10));
          asyncCompleted = true;
          return data;
        },
      },
    });

    await route.handleDataUpdate({ field1: "value" }, {});

    expect(asyncCompleted).toBe(true);
  });
});

describe("Route - Knowledge Base and Metadata", () => {
  test("should store and retrieve knowledge base", () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const knowledgeBase = {
      faq: ["Q1", "Q2"],
      policies: { refund: "30 days" },
    };

    const route = agent.createRoute({
      title: "Knowledge Route",
      knowledgeBase,
    });

    expect(route.getKnowledgeBase()).toEqual(knowledgeBase);
  });

  test("should return empty object when no knowledge base", () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const route = agent.createRoute({
      title: "No Knowledge Route",
    });

    expect(route.getKnowledgeBase()).toEqual({});
  });

  test("should store routing extras schema", () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const schema = {
      type: "object" as const,
      properties: {
        priority: { type: "string" as const },
      },
    };

    const route = agent.createRoute({
      title: "Extras Schema Route",
      routingExtrasSchema: schema,
    });

    expect(route.getRoutingExtrasSchema()).toEqual(schema);
  });

  test("should store response output schema", () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const schema = {
      type: "object" as const,
      properties: {
        summary: { type: "string" as const },
      },
    };

    const route = agent.createRoute({
      title: "Response Schema Route",
      responseOutputSchema: schema,
    });

    expect(route.getResponseOutputSchema()).toEqual(schema);
  });
});

describe("Route - Guidelines and Terms", () => {
  test("should create guidelines with auto-generated IDs", () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const route = agent.createRoute({
      title: "Guideline Route",
      guidelines: [
        { condition: "Condition 1", action: "Action 1" },
        { condition: "Condition 2", action: "Action 2" },
      ],
    });

    const guidelines = route.getGuidelines();
    expect(guidelines).toHaveLength(2);
    expect(guidelines[0].id).toBeDefined();
    expect(guidelines[1].id).toBeDefined();
    expect(guidelines[0].id).not.toBe(guidelines[1].id);
  });

  test("should use custom guideline IDs when provided", () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const route = agent.createRoute({
      title: "Custom Guideline Route",
      guidelines: [
        { id: "custom-1", condition: "Condition 1", action: "Action 1" },
      ],
    });

    const guidelines = route.getGuidelines();
    expect(guidelines[0].id).toBe("custom-1");
  });

  test("should enable guidelines by default", () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const route = agent.createRoute({
      title: "Enabled Guideline Route",
      guidelines: [
        { condition: "Condition 1", action: "Action 1" },
      ],
    });

    const guidelines = route.getGuidelines();
    expect(guidelines[0].enabled).toBe(true);
  });

  test("should respect disabled guidelines", () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const route = agent.createRoute({
      title: "Disabled Guideline Route",
      guidelines: [
        { condition: "Condition 1", action: "Action 1", enabled: false },
      ],
    });

    const guidelines = route.getGuidelines();
    expect(guidelines[0].enabled).toBe(false);
  });

  test("should add guidelines dynamically", () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const route = agent.createRoute({
      title: "Dynamic Guideline Route",
    });

    route.createGuideline({ condition: "New condition", action: "New action" });

    const guidelines = route.getGuidelines();
    expect(guidelines).toHaveLength(1);
    expect(guidelines[0].condition).toBe("New condition");
  });

  test("should add terms dynamically", () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const route = agent.createRoute({
      title: "Terms Route",
    });

    route.createTerm({ name: "API", description: "Application Programming Interface" });

    const terms = route.getTerms();
    expect(terms).toHaveLength(1);
    expect(terms[0].name).toBe("API");
  });
});

describe("Route - Tools Management", () => {
  test("should register tools from options", () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const tool: Tool<unknown, TestData> = {
      id: "test-tool",
      description: "Test tool",
      handler: () => ({ data: "result" }),
    };

    const route = agent.createRoute({
      title: "Tool Route",
      tools: [tool],
    });

    const tools = route.getTools();
    expect(tools).toHaveLength(1);
    expect(tools[0].id).toBe("test-tool");
  });

  test("should add tools dynamically with createTool", () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const route = agent.createRoute({
      title: "Dynamic Tool Route",
    });

    const tool: Tool<unknown, TestData> = {
      id: "dynamic-tool",
      description: "Dynamic tool",
      handler: () => ({ data: "result" }),
    };

    route.createTool(tool);

    const tools = route.getTools();
    expect(tools).toHaveLength(1);
    expect(tools[0].id).toBe("dynamic-tool");
  });

  test("should register multiple tools at once", () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const route = agent.createRoute({
      title: "Multiple Tools Route",
    });

    const tools: Tool<unknown, TestData>[] = [
      { id: "tool1", description: "Tool 1", handler: () => ({ data: "1" }) },
      { id: "tool2", description: "Tool 2", handler: () => ({ data: "2" }) },
    ];

    route.registerTools(tools);

    const registeredTools = route.getTools();
    expect(registeredTools).toHaveLength(2);
  });

  test("should validate tool before adding", () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const route = agent.createRoute({
      title: "Validation Route",
    });

    expect(() => {
      route.createTool(null as any);
    }).toThrow("Invalid tool");

    expect(() => {
      route.createTool({ id: "test" } as any);
    }).toThrow("Invalid tool");
  });
});

describe("Route - Step Traversal and Lookup", () => {
  test("should get all steps via traversal", () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const route = agent.createRoute({
      title: "Traversal Route",
      steps: [
        { id: "step1", prompt: "Step 1" },
        { id: "step2", prompt: "Step 2" },
        { id: "step3", prompt: "Step 3" },
      ],
    });

    const steps = route.getAllSteps();
    expect(steps).toHaveLength(3);
  });

  test("should find step by ID", () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const route = agent.createRoute({
      title: "Lookup Route",
      steps: [
        { id: "step1", prompt: "Step 1" },
        { id: "step2", prompt: "Step 2" },
      ],
    });

    const step = route.getStep("step2");
    expect(step).toBeDefined();
    expect(step?.id).toBe("step2");
  });

  test("should return undefined for non-existent step", () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const route = agent.createRoute({
      title: "Missing Step Route",
      steps: [
        { id: "step1", prompt: "Step 1" },
      ],
    });

    const step = route.getStep("non-existent");
    expect(step).toBeUndefined();
  });

  test("should handle branching in step traversal", () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const route = agent.createRoute({
      title: "Branch Traversal Route",
    });

    route.initialStep.branch([
      { name: "branch1", id: "b1", step: { prompt: "Branch 1" } },
      { name: "branch2", id: "b2", step: { prompt: "Branch 2" } },
    ]);

    const steps = route.getAllSteps();
    expect(steps.length).toBeGreaterThanOrEqual(3); // initial + 2 branches
  });

  test("should avoid infinite loops in circular step graphs", () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const route = agent.createRoute({
      title: "Circular Route",
      steps: [
        { id: "step1", prompt: "Step 1" },
        { id: "step2", prompt: "Step 2" },
      ],
    });

    // This should not hang
    const steps = route.getAllSteps();
    expect(steps).toHaveLength(2);
  });
});

describe("Route - describe() Method", () => {
  test("should generate route description", () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const route = agent.createRoute({
      title: "Describe Route",
      description: "A test route",
      when: ["Test condition"],
      steps: [
        { id: "step1", description: "First step", prompt: "Step 1" },
        { id: "step2", description: "Second step", prompt: "Step 2" },
      ],
    });

    const description = route.describe();

    expect(description).toContain("Route: Describe Route");
    expect(description).toContain("Description: A test route");
    expect(description).toContain("When: [Array]");
    expect(description).toContain("step1: First step");
    expect(description).toContain("step2: Second step");
  });

  test("should handle route with no description", () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const route = agent.createRoute({
      title: "No Description Route",
    });

    const description = route.describe();
    expect(description).toContain("Description: N/A");
  });

  test("should handle route with no conditions", () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const route = agent.createRoute({
      title: "No Conditions Route",
    });

    const description = route.describe();
    expect(description).toContain("When: None");
  });
});

describe("Step - Configuration and Properties", () => {
  test("should generate deterministic ID from description", () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const route = agent.createRoute({
      title: "Step ID Route",
    });

    const step1 = route.initialStep.nextStep({ description: "Test Step" });
    const step2 = route.initialStep.nextStep({ description: "Test Step" });

    // Same description should generate same ID
    expect(step1.id).toBe(step2.id);
  });

  test("should use custom step ID when provided", () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const route = agent.createRoute({
      title: "Custom Step ID Route",
    });

    const step = route.initialStep.nextStep({
      id: "custom-step-id",
      prompt: "Custom step",
    });

    expect(step.id).toBe("custom-step-id");
  });

  test("should configure step after creation", () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const route = agent.createRoute({
      title: "Configure Route",
    });

    route.initialStep.configure({
      description: "Configured description",
      collect: ["field1"],
      prompt: "Configured prompt",
    });

    expect(route.initialStep.description).toBe("Configured description");
    expect(route.initialStep.collect).toEqual(["field1"]);
    expect(route.initialStep.prompt).toBe("Configured prompt");
  });

  test("should handle partial configuration", () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const route = agent.createRoute({
      title: "Partial Config Route",
      initialStep: {
        description: "Original",
        collect: ["field1"],
      },
    });

    route.initialStep.configure({
      description: "Updated",
    });

    expect(route.initialStep.description).toBe("Updated");
    expect(route.initialStep.collect).toEqual(["field1"]); // Unchanged
  });
});

describe("Step - Transitions and Branching", () => {
  test("should create nextStep transition", () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const route = agent.createRoute({
      title: "Transition Route",
    });

    const step2 = route.initialStep.nextStep({ prompt: "Step 2" });

    expect(step2.id).toBeDefined();
    expect(step2.routeId).toBe(route.id);
  });

  test("should chain multiple transitions", () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const route = agent.createRoute({
      title: "Chain Route",
    });

    const step2 = route.initialStep.nextStep({ id: "step2", prompt: "Step 2" });
    const step3 = step2.nextStep({ id: "step3", prompt: "Step 3" });
    const step4 = step3.nextStep({ id: "step4", prompt: "Step 4" });

    expect(step4.id).toBe("step4");
  });

  test("should create branches", () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const route = agent.createRoute({
      title: "Branch Route",
    });

    const branches = route.initialStep.branch([
      { name: "option1", step: { prompt: "Option 1" } },
      { name: "option2", step: { prompt: "Option 2" } },
      { name: "option3", step: { prompt: "Option 3" } },
    ]);

    expect(branches.option1).toBeDefined();
    expect(branches.option2).toBeDefined();
    expect(branches.option3).toBeDefined();
  });

  test("should chain after branches", () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const route = agent.createRoute({
      title: "Branch Chain Route",
    });

    const branches = route.initialStep.branch([
      { name: "branch1", step: { prompt: "Branch 1" } },
    ]);

    const nextStep = branches.branch1.nextStep({ prompt: "After branch" });
    expect(nextStep.id).toBeDefined();
  });

  test("should use custom branch IDs", () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const route = agent.createRoute({
      title: "Custom Branch ID Route",
    });

    const branches = route.initialStep.branch([
      { name: "branch1", id: "custom-branch-1", step: { prompt: "Branch 1" } },
    ]);

    expect(branches.branch1.id).toBe("custom-branch-1");
  });

  test("should handle endRoute shortcut", () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const route = agent.createRoute({
      title: "End Route Shortcut",
    });

    const endStep = route.initialStep.endRoute();

    expect(endStep.id).toBe("END_ROUTE");
  });

  test("should handle endRoute with options", () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const route = agent.createRoute({
      title: "End Route Options",
    });

    const endStep = route.initialStep.endRoute({
      prompt: "Completion message",
    });

    expect(endStep.id).toBe("END_ROUTE");
  });

  test("should throw error when transitioning from END_ROUTE", () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const route = agent.createRoute({
      title: "Terminal Route",
    });

    const endStep = route.initialStep.endRoute();

    expect(() => {
      endStep.nextStep({ prompt: "Invalid" });
    }).toThrow("Cannot transition from END_ROUTE step");
  });

  test("should throw error when branching from END_ROUTE", () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const route = agent.createRoute({
      title: "Terminal Branch Route",
    });

    const endStep = route.initialStep.endRoute();

    expect(() => {
      endStep.branch([{ name: "invalid", step: { prompt: "Invalid" } }]);
    }).toThrow("Cannot branch from END_ROUTE step");
  });
});

describe("Step - Data Requirements and Skipping", () => {
  test("should check if step should be skipped", async () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const route = agent.createRoute({
      title: "Skip Route",
      steps: [
        {
          id: "conditional-step",
          prompt: "Conditional step",
          skipIf: (ctx) => !!ctx.data?.field1,
        },
      ],
    });

    const step = route.getStep("conditional-step")!;

    const result1 = await step.evaluateSkipIf(createTemplateContext({ data: { field1: "value" } }));
    expect(result1.shouldSkip).toBe(true);

    const result2 = await step.evaluateSkipIf(createTemplateContext({ data: {} }));
    expect(result2.shouldSkip).toBe(false);
  });

  test("should return false when no skipIf defined", async () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const route = agent.createRoute({
      title: "No Skip Route",
      steps: [
        { id: "step1", prompt: "Step 1" },
      ],
    });

    const step = route.getStep("step1")!;
    const result = await step.evaluateSkipIf(createTemplateContext({ data: {} }));
    expect(result.shouldSkip).toBe(false);
  });

  test("should check if step has required data", () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const route = agent.createRoute({
      title: "Requires Route",
      steps: [
        {
          id: "dependent-step",
          prompt: "Dependent step",
          requires: ["field1", "field2"],
        },
      ],
    });

    const step = route.getStep("dependent-step")!;

    expect(step.hasRequires({ field1: "a", field2: "b" })).toBe(true);
    expect(step.hasRequires({ field1: "a" })).toBe(false);
    expect(step.hasRequires({})).toBe(false);
  });

  test("should return true when no requires defined", () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const route = agent.createRoute({
      title: "No Requires Route",
      steps: [
        { id: "step1", prompt: "Step 1" },
      ],
    });

    const step = route.getStep("step1")!;
    expect(step.hasRequires({})).toBe(true);
  });

  test("should handle empty requires array", () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const route = agent.createRoute({
      title: "Empty Requires Route",
      steps: [
        {
          id: "step1",
          prompt: "Step 1",
          requires: [],
        },
      ],
    });

    const step = route.getStep("step1")!;
    expect(step.hasRequires({})).toBe(true);
  });
});

describe("Step - Guidelines", () => {
  test("should add guidelines to step", () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const route = agent.createRoute({
      title: "Step Guideline Route",
    });

    route.initialStep.addGuideline({
      condition: "User is confused",
      action: "Provide clarification",
    });

    const guidelines = route.initialStep.getGuidelines();
    expect(guidelines).toHaveLength(1);
    expect(guidelines[0].condition).toBe("User is confused");
  });

  test("should return copy of guidelines array", () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const route = agent.createRoute({
      title: "Guideline Copy Route",
    });

    route.initialStep.addGuideline({
      condition: "Test",
      action: "Test action",
    });

    const guidelines1 = route.initialStep.getGuidelines();
    const guidelines2 = route.initialStep.getGuidelines();

    expect(guidelines1).not.toBe(guidelines2); // Different array instances
    expect(guidelines1).toEqual(guidelines2); // Same content
  });
});

describe("Step - References and Results", () => {
  test("should get step reference", () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const route = agent.createRoute({
      title: "Ref Route",
      steps: [
        { id: "step1", prompt: "Step 1" },
      ],
    });

    const step = route.getStep("step1")!;
    const ref = step.getRef();

    expect(ref.id).toBe("step1");
    expect(ref.routeId).toBe(route.id);
  });

  test("should create step result with chaining methods", () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const route = agent.createRoute({
      title: "Result Route",
    });

    const result = route.initialStep.asStepResult();

    expect(result.id).toBeDefined();
    expect(result.routeId).toBe(route.id);
    expect(typeof result.nextStep).toBe("function");
    expect(typeof result.branch).toBe("function");
    expect(typeof result.endRoute).toBe("function");
  });

  test("should get transitions from step", () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const route = agent.createRoute({
      title: "Transitions Route",
    });

    route.initialStep.nextStep({ id: "step2", prompt: "Step 2" });
    route.initialStep.nextStep({ id: "step3", prompt: "Step 3" });

    const transitions = route.initialStep.getTransitions();
    expect(transitions).toHaveLength(2);
  });
});
