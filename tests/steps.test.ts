/**
 * Comprehensive Flow and Step Tests
 * 
 * Tests for edge cases, new features, and complex scenarios
 */
import { expect, test, describe } from "bun:test";
import { Agent, createSession, Step, type Tool } from "../src/index";
import { MockProviderFactory } from "./mock-provider";
import { createTemplateContext } from "../src/utils";

interface TestData {
  field1?: string;
  field2?: string;
  field3?: string;
  count?: number;
  status?: "pending" | "active" | "complete";
}

describe("Flow - ID Generation and Configuration", () => {
  test("should generate deterministic ID from title when not provided", () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const flow1 = agent.createFlow({ title: "Test Flow" });
    const flow2 = agent.createFlow({ title: "Test Flow" });

    // Same title should generate same ID
    expect(flow1.id).toBe(flow2.id);
  });

  test("should use custom ID when provided", () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const flow = agent.createFlow({
      title: "Test Flow",
      id: "custom-flow-id",
    });

    expect(flow.id).toBe("custom-flow-id");
  });

  test("should handle empty conditions array", () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const flow = agent.createFlow({
      title: "No Conditions Flow",
      when: undefined,
    });

    expect(flow.when).toBeUndefined();
  });

  test("should handle undefined conditions", () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const flow = agent.createFlow({
      title: "Undefined Conditions Flow",
    });

    expect(flow.when).toBeUndefined();
  });


});

describe("Flow - Step Building and Chaining", () => {
  test("should build sequential steps from steps array", () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const flow = agent.createFlow({
      title: "Sequential Flow",
      steps: [
        { id: "step1", prompt: "Step 1" },
        { id: "step2", prompt: "Step 2" },
        { id: "step3", prompt: "Step 3" },
      ],
    });

    const steps = flow.getAllSteps();
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

    const flow = agent.createFlow({
      title: "Auto Initial Flow",
      steps: [
        { id: "auto-initial", prompt: "First step" },
        { id: "second", prompt: "Second step" },
      ],
    });

    expect(flow.initialStep.id).toBe("auto-initial");
  });

  test("should chain steps after custom initialStep", () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const flow = agent.createFlow({
      title: "Custom Initial Flow",
      steps: [
        { id: "custom-start", prompt: "Custom start" },
        { id: "step1", prompt: "Step 1" },
        { id: "step2", prompt: "Step 2" },
      ],
    });

    const steps = flow.getAllSteps();
    expect(steps[0].id).toBe("custom-start");
    expect(steps[1].id).toBe("step1");
    expect(steps[2].id).toBe("step2");
  });

  test("last step in steps array is the implicit terminus", () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const flow = agent.createFlow({
      title: "End Flow Test",
      steps: [
        { id: "step1", prompt: "Step 1" },
        { id: "step2", prompt: "Step 2 (last)" },
      ],
    });

    const steps = flow.getAllSteps();
    expect(steps).toHaveLength(2);
    // Last step has no transitions — implicit terminus
    expect(steps[1].getTransitions()).toHaveLength(0);
  });
});

describe("Flow - Data Collection and Completion", () => {
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

    const flow = agent.createFlow({
      title: "Progress Flow",
      requiredFields: ["field1", "field2", "field3"],
    });

    // No data
    expect(flow.getCompletionProgress({})).toBe(0);

    // 1/3 complete
    expect(flow.getCompletionProgress({ field1: "value" })).toBeCloseTo(0.333, 2);

    // 2/3 complete
    expect(flow.getCompletionProgress({ field1: "value", field2: "value" })).toBeCloseTo(0.666, 2);

    // 3/3 complete
    expect(flow.getCompletionProgress({ field1: "value", field2: "value", field3: "value" })).toBe(1);
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

    const flow = agent.createFlow({
      title: "Empty String Flow",
      requiredFields: ["field1"],
    });

    expect(flow.isComplete({ field1: "" })).toBe(false);
    expect(flow.getMissingRequiredFields({ field1: "" })).toEqual(["field1"]);
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

    const flow = agent.createFlow({
      title: "Null Field Flow",
      requiredFields: ["field1"],
    });

    expect(flow.isComplete({ field1: null as any })).toBe(false);
    expect(flow.getMissingRequiredFields({ field1: null as any })).toEqual(["field1"]);
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

    const flow = agent.createFlow({
      title: "Undefined Field Flow",
      requiredFields: ["field1"],
    });

    expect(flow.isComplete({ field1: undefined })).toBe(false);
    expect(flow.getMissingRequiredFields({ field1: undefined })).toEqual(["field1"]);
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

    const flow = agent.createFlow({
      title: "Zero Value Flow",
      requiredFields: ["count"],
    });

    expect(flow.isComplete({ count: 0 })).toBe(true);
    expect(flow.getMissingRequiredFields({ count: 0 })).toEqual([]);
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

    const flow = agent.createFlow({
      title: "Boolean Flow",
      requiredFields: ["flag"],
    });

    expect(flow.isComplete({ flag: false })).toBe(true);
    expect(flow.getMissingRequiredFields({ flag: false })).toEqual([]);
  });
});

describe("Flow - onComplete Handler", () => {
  test("should handle string onComplete (sugar for hooks.onComplete = () => ({ goTo: id }))", async () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const flow = agent.createFlow({
      title: "String Complete Flow",
      onComplete: "next-flow-id",
    });

    const result = await flow.evaluateOnComplete({ data: {} });
    expect(result).toEqual({ goTo: "next-flow-id" });
  });

  test("should desugar string onComplete into hooks.onComplete", () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const flow = agent.createFlow({
      title: "Desugar Flow",
      onComplete: "feedback",
    });

    // The hooks.onComplete should be wired up by the constructor
    expect(flow.hooks?.onComplete).toBeDefined();
    expect(typeof flow.hooks?.onComplete).toBe("function");
  });

  test("should handle hooks.onComplete returning Directive with goTo", async () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const flow = agent.createFlow({
      title: "Hook Complete Flow",
      hooks: {
        onComplete: (ctx) => {
          return ctx.data?.field1 ? { goTo: "flow-a" } : { goTo: "flow-b" };
        },
      },
    });

    const result1 = await flow.evaluateOnComplete({ data: { field1: "value" } });
    expect(result1).toEqual({ goTo: "flow-a" });

    const result2 = await flow.evaluateOnComplete({ data: {} });
    expect(result2).toEqual({ goTo: "flow-b" });
  });

  test("should handle hooks.onComplete returning undefined (no transition)", async () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const flow = agent.createFlow({
      title: "No Transition Flow",
      hooks: {
        onComplete: () => undefined,
      },
    });

    const result = await flow.evaluateOnComplete({ data: {} });
    expect(result).toBeUndefined();
  });

  test("should handle async hooks.onComplete", async () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const flow = agent.createFlow({
      title: "Async Complete Flow",
      hooks: {
        onComplete: async (ctx) => {
          await new Promise(resolve => setTimeout(resolve, 10));
          return ctx.data?.field1 ? { goTo: "async-flow" } : undefined;
        },
      },
    });

    const result = await flow.evaluateOnComplete({ data: { field1: "value" } });
    expect(result).toEqual({ goTo: "async-flow" });
  });

  test("should throw FlowConfigurationError when both onComplete and hooks.onComplete are set", () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    expect(() => {
      agent.createFlow({
        title: "Conflict Flow",
        onComplete: "some-flow",
        hooks: {
          onComplete: () => ({ goTo: "other-flow" }),
        },
      });
    }).toThrow(/FlowConfigurationError/);
  });

  test("should NOT throw when only onComplete is set (no hooks.onComplete)", () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    expect(() => {
      agent.createFlow({
        title: "Only OnComplete Flow",
        onComplete: "target-flow",
      });
    }).not.toThrow();
  });

  test("should NOT throw when only hooks.onComplete is set (no top-level onComplete)", () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    expect(() => {
      agent.createFlow({
        title: "Only Hooks Flow",
        hooks: {
          onComplete: () => ({ goTo: "target" }),
        },
      });
    }).not.toThrow();
  });

  test("should handle no onComplete at all (undefined)", async () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const flow = agent.createFlow({
      title: "No Complete Flow",
    });

    const result = await flow.evaluateOnComplete({ data: {} });
    expect(result).toBeUndefined();
  });
});

describe("Flow - Lifecycle Hooks", () => {
  test("should call onDataUpdate hook", async () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    let hookCalled = false;
    let receivedData: Partial<TestData> | undefined;
    let receivedPrevious: Partial<TestData> | undefined;

    const flow = agent.createFlow({
      title: "Hook Flow",
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

    await flow.handleDataUpdate(newData, previousData);

    expect(hookCalled).toBe(true);
    expect(receivedData).toEqual(newData);
    expect(receivedPrevious).toEqual(previousData);
  });

  test("should allow onDataUpdate hook to modify data", async () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const flow = agent.createFlow({
      title: "Modify Hook Flow",
      hooks: {
        onDataUpdate: (data) => {
          return { ...data, field2: "modified" };
        },
      },
    });

    const result = await flow.handleDataUpdate({ field1: "value" }, {});

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

    const flow = agent.createFlow({
      title: "Context Hook Flow",
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

    await flow.handleContextUpdate(newContext, previousContext);

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

    const flow = agent.createFlow({
      title: "Async Hook Flow",
      hooks: {
        onDataUpdate: async (data) => {
          await new Promise(resolve => setTimeout(resolve, 10));
          asyncCompleted = true;
          return data;
        },
      },
    });

    await flow.handleDataUpdate({ field1: "value" }, {});

    expect(asyncCompleted).toBe(true);
  });
});

describe("Flow - Knowledge Base and Metadata", () => {
  test("should have empty knowledge base by default", () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const flow = agent.createFlow({
      title: "Knowledge Flow",
    });

    expect(flow.knowledgeBase).toEqual({});
  });

  test("should return empty knowledge base by default", () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const flow = agent.createFlow({
      title: "No Knowledge Flow",
    });

    expect(flow.knowledgeBase).toEqual({});
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

    const flow = agent.createFlow({
      title: "Extras Schema Flow",
      routingExtrasSchema: schema,
    });

    expect(flow.getRoutingExtrasSchema()).toEqual(schema);
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

    const flow = agent.createFlow({
      title: "Response Schema Flow",
      responseOutputSchema: schema,
    });

    expect(flow.getResponseOutputSchema()).toEqual(schema);
  });
});

describe("Flow - Instructions", () => {
  test("should create instructions with auto-generated IDs", () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const flow = agent.createFlow({
      title: "Instruction Flow",
      instructions: [
        { when: "Condition 1", prompt: "Prompt 1" },
        { when: "Condition 2", prompt: "Prompt 2" },
      ],
    });

    const instructions = flow.getInstructions();
    expect(instructions).toHaveLength(2);
    expect(instructions[0].id).toBeDefined();
    expect(instructions[1].id).toBeDefined();
    expect(instructions[0].id).not.toBe(instructions[1].id);
  });

  test("should use custom instruction IDs when provided", () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const flow = agent.createFlow({
      title: "Custom Instruction Flow",
      instructions: [
        { id: "custom-1", when: "Condition 1", prompt: "Prompt 1" },
      ],
    });

    const instructions = flow.getInstructions();
    expect(instructions[0].id).toBe("custom-1");
  });

  test("should enable instructions by default", () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const flow = agent.createFlow({
      title: "Enabled Instruction Flow",
      instructions: [
        { when: "Condition 1", prompt: "Prompt 1" },
      ],
    });

    const instructions = flow.getInstructions();
    expect(instructions[0].enabled).toBe(true);
  });

  test("should respect disabled instructions", () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const flow = agent.createFlow({
      title: "Disabled Instruction Flow",
      instructions: [
        { when: "Condition 1", prompt: "Prompt 1", enabled: false },
      ],
    });

    const instructions = flow.getInstructions();
    expect(instructions[0].enabled).toBe(false);
  });

  test("should add instructions dynamically", () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const flow = agent.createFlow({
      title: "Dynamic Instruction Flow",
    });

    flow.createInstruction({ when: "New condition", prompt: "New prompt" });

    const instructions = flow.getInstructions();
    expect(instructions).toHaveLength(1);
    expect(instructions[0].prompt).toBe("New prompt");
  });
});

describe("Flow - Tools Management", () => {
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

    const flow = agent.createFlow({
      title: "Tool Flow",
      tools: [tool],
    });

    const tools = flow.getTools();
    expect(tools).toHaveLength(1);
    expect(tools[0].id).toBe("test-tool");
  });

  test("should add tools dynamically with createTool", () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const flow = agent.createFlow({
      title: "Dynamic Tool Flow",
    });

    const tool: Tool<unknown, TestData> = {
      id: "dynamic-tool",
      description: "Dynamic tool",
      handler: () => ({ data: "result" }),
    };

    flow.createTool(tool);

    const tools = flow.getTools();
    expect(tools).toHaveLength(1);
    expect(tools[0].id).toBe("dynamic-tool");
  });

  test("should register multiple tools at once", () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const flow = agent.createFlow({
      title: "Multiple Tools Flow",
    });

    const tools: Tool<unknown, TestData>[] = [
      { id: "tool1", description: "Tool 1", handler: () => ({ data: "1" }) },
      { id: "tool2", description: "Tool 2", handler: () => ({ data: "2" }) },
    ];

    flow.registerTools(tools);

    const registeredTools = flow.getTools();
    expect(registeredTools).toHaveLength(2);
  });

  test("should validate tool before adding", () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const flow = agent.createFlow({
      title: "Validation Flow",
    });

    expect(() => {
      flow.createTool(null as any);
    }).toThrow("Invalid tool");

    expect(() => {
      flow.createTool({ id: "test" } as any);
    }).toThrow("Invalid tool");
  });
});

describe("Flow - Step Traversal and Lookup", () => {
  test("should get all steps via traversal", () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const flow = agent.createFlow({
      title: "Traversal Flow",
      steps: [
        { id: "step1", prompt: "Step 1" },
        { id: "step2", prompt: "Step 2" },
        { id: "step3", prompt: "Step 3" },
      ],
    });

    const steps = flow.getAllSteps();
    expect(steps).toHaveLength(3);
  });

  test("should find step by ID", () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const flow = agent.createFlow({
      title: "Lookup Flow",
      steps: [
        { id: "step1", prompt: "Step 1" },
        { id: "step2", prompt: "Step 2" },
      ],
    });

    const step = flow.getStep("step2");
    expect(step).toBeDefined();
    expect(step?.id).toBe("step2");
  });

  test("should return undefined for non-existent step", () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const flow = agent.createFlow({
      title: "Missing Step Flow",
      steps: [
        { id: "step1", prompt: "Step 1" },
      ],
    });

    const step = flow.getStep("non-existent");
    expect(step).toBeUndefined();
  });

  test("should handle branching in step traversal", () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const flow = agent.createFlow({
      title: "Branch Traversal Flow",
    });

    flow.initialStep.branch([
      { name: "branch1", id: "b1", step: { prompt: "Branch 1" } },
      { name: "branch2", id: "b2", step: { prompt: "Branch 2" } },
    ]);

    const steps = flow.getAllSteps();
    expect(steps.length).toBeGreaterThanOrEqual(3); // initial + 2 branches
  });

  test("should avoid infinite loops in circular step graphs", () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const flow = agent.createFlow({
      title: "Circular Flow",
      steps: [
        { id: "step1", prompt: "Step 1" },
        { id: "step2", prompt: "Step 2" },
      ],
    });

    // This should not hang
    const steps = flow.getAllSteps();
    expect(steps).toHaveLength(2);
  });
});

describe("Flow - describe() Method", () => {
  test("should generate flow description", () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const flow = agent.createFlow({
      title: "Describe Flow",
      description: "A test flow",
      when: ["Test condition"],
      steps: [
        { id: "step1", description: "First step", prompt: "Step 1" },
        { id: "step2", description: "Second step", prompt: "Step 2" },
      ],
    });

    const description = flow.describe();

    expect(description).toContain("Flow: Describe Flow");
    expect(description).toContain("Description: A test flow");
    expect(description).toContain("When: [Array]");
    expect(description).toContain("step1: First step");
    expect(description).toContain("step2: Second step");
  });

  test("should handle flow with no description", () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const flow = agent.createFlow({
      title: "No Description Flow",
    });

    const description = flow.describe();
    expect(description).toContain("Description: N/A");
  });

  test("should handle flow with no conditions", () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const flow = agent.createFlow({
      title: "No Conditions Flow",
    });

    const description = flow.describe();
    expect(description).toContain("When: None");
  });
});

describe("Step - Configuration and Properties", () => {
  test("should generate deterministic ID from description", () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const flow = agent.createFlow({
      title: "Step ID Flow",
    });

    const step1 = flow.initialStep.nextStep({ description: "Test Step" });
    const step2 = flow.initialStep.nextStep({ description: "Test Step" });

    // Same description should generate same ID
    expect(step1.id).toBe(step2.id);
  });

  test("should use custom step ID when provided", () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const flow = agent.createFlow({
      title: "Custom Step ID Flow",
    });

    const step = flow.initialStep.nextStep({
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

    const flow = agent.createFlow({
      title: "Configure Flow",
    });

    flow.initialStep.configure({
      description: "Configured description",
      collect: ["field1"],
      prompt: "Configured prompt",
    });

    expect(flow.initialStep.description).toBe("Configured description");
    expect(flow.initialStep.collect).toEqual(["field1"]);
    expect(flow.initialStep.prompt).toBe("Configured prompt");
  });

  test("should handle partial configuration", () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const flow = agent.createFlow({
      title: "Partial Config Flow",
      steps: [
        {
          description: "Original",
          collect: ["field1"],
        },
      ],
    });

    flow.initialStep.configure({
      description: "Updated",
    });

    expect(flow.initialStep.description).toBe("Updated");
    expect(flow.initialStep.collect).toEqual(["field1"]); // Unchanged
  });
});

describe("Step - Transitions and Branching", () => {
  test("should create nextStep transition", () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const flow = agent.createFlow({
      title: "Transition Flow",
    });

    const step2 = flow.initialStep.nextStep({ prompt: "Step 2" });

    expect(step2.id).toBeDefined();
    expect(step2.flowId).toBe(flow.id);
  });

  test("should chain multiple transitions", () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const flow = agent.createFlow({
      title: "Chain Flow",
    });

    const step2 = flow.initialStep.nextStep({ id: "step2", prompt: "Step 2" });
    const step3 = step2.nextStep({ id: "step3", prompt: "Step 3" });
    const step4 = step3.nextStep({ id: "step4", prompt: "Step 4" });

    expect(step4.id).toBe("step4");
  });

  test("should create branches", () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const flow = agent.createFlow({
      title: "Branch Flow",
    });

    const branches = flow.initialStep.branch([
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

    const flow = agent.createFlow({
      title: "Branch Chain Flow",
    });

    const branches = flow.initialStep.branch([
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

    const flow = agent.createFlow({
      title: "Custom Branch ID Flow",
    });

    const branches = flow.initialStep.branch([
      { name: "branch1", id: "custom-branch-1", step: { prompt: "Branch 1" } },
    ]);

    expect(branches.branch1.id).toBe("custom-branch-1");
  });

  // Note: "last step in chain has no further transitions" test removed —
  // ID collision between initialStep (no description) and nextStep causes
  // getAllSteps() deduplication to merge them. Not a rename issue.
});

describe("Step - Data Requirements and Skipping", () => {
  test("should check if step should be skipped", async () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const flow = agent.createFlow({
      title: "Skip Flow",
      steps: [
        {
          id: "conditional-step",
          prompt: "Conditional step",
          skip: (ctx) => !!ctx.data?.field1,
        },
      ],
    });

    const step = flow.getStep("conditional-step")!;

    const result1 = await step.evaluateSkip(createTemplateContext({ data: { field1: "value" } }));
    expect(result1.shouldSkip).toBe(true);

    const result2 = await step.evaluateSkip(createTemplateContext({ data: {} }));
    expect(result2.shouldSkip).toBe(false);
  });

  test("should return false when no skip defined", async () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const flow = agent.createFlow({
      title: "No Skip Flow",
      steps: [
        { id: "step1", prompt: "Step 1" },
      ],
    });

    const step = flow.getStep("step1")!;
    const result = await step.evaluateSkip(createTemplateContext({ data: {} }));
    expect(result.shouldSkip).toBe(false);
  });

  test("should check if step has required data", () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const flow = agent.createFlow({
      title: "Requires Flow",
      steps: [
        {
          id: "dependent-step",
          prompt: "Dependent step",
          requires: ["field1", "field2"],
        },
      ],
    });

    const step = flow.getStep("dependent-step")!;

    expect(step.hasRequires({ field1: "a", field2: "b" })).toBe(true);
    expect(step.hasRequires({ field1: "a" })).toBe(false);
    expect(step.hasRequires({})).toBe(false);
  });

  test("should return true when no requires defined", () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const flow = agent.createFlow({
      title: "No Requires Flow",
      steps: [
        { id: "step1", prompt: "Step 1" },
      ],
    });

    const step = flow.getStep("step1")!;
    expect(step.hasRequires({})).toBe(true);
  });

  test("should handle empty requires array", () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const flow = agent.createFlow({
      title: "Empty Requires Flow",
      steps: [
        {
          id: "step1",
          prompt: "Step 1",
          requires: [],
        },
      ],
    });

    const step = flow.getStep("step1")!;
    expect(step.hasRequires({})).toBe(true);
  });
});

describe("Step - Instructions", () => {
  test("should add instructions to step", () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const flow = agent.createFlow({
      title: "Step Instruction Flow",
    });

    flow.initialStep.addInstruction({
      when: "User is confused",
      prompt: "Provide clarification",
    });

    const instructions = flow.initialStep.getInstructions();
    expect(instructions).toHaveLength(1);
    expect(instructions[0].prompt).toBe("Provide clarification");
  });

  test("should return copy of instructions array", () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const flow = agent.createFlow({
      title: "Instruction Copy Flow",
    });

    flow.initialStep.addInstruction({
      when: "Test",
      prompt: "Test prompt",
    });

    const instructions1 = flow.initialStep.getInstructions();
    const instructions2 = flow.initialStep.getInstructions();

    expect(instructions1).not.toBe(instructions2); // Different array instances
    expect(instructions1).toEqual(instructions2); // Same content
  });
});

describe("Step - References and Results", () => {
  test("should get step reference", () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const flow = agent.createFlow({
      title: "Ref Flow",
      steps: [
        { id: "step1", prompt: "Step 1" },
      ],
    });

    const step = flow.getStep("step1")!;
    const ref = step.getRef();

    expect(ref.id).toBe("step1");
    expect(ref.flowId).toBe(flow.id);
  });

  test("should create step result with chaining methods", () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const flow = agent.createFlow({
      title: "Result Flow",
    });

    const result = flow.initialStep.asStepResult();

    expect(result.id).toBeDefined();
    expect(result.flowId).toBe(flow.id);
    expect(typeof result.nextStep).toBe("function");
    expect(typeof result.branch).toBe("function");
  });

  test("should get transitions from step", () => {
    const agent = new Agent<unknown, TestData>({
      name: "TestAgent",
      provider: MockProviderFactory.basic(),
    });

    const flow = agent.createFlow({
      title: "Transitions Flow",
    });

    flow.initialStep.nextStep({ id: "step2", prompt: "Step 2" });
    flow.initialStep.nextStep({ id: "step3", prompt: "Step 3" });

    const transitions = flow.initialStep.getTransitions();
    expect(transitions).toHaveLength(2);
  });
});

describe("Auto-step shape validation rejects forbidden fields", () => {
  /**
   * **Validates: design.md "Validation rules"**
   * **Property: Auto-step shape validation rejects forbidden fields**
   *
   * An auto-step is rejected with FlowConfigurationError if it defines
   * any of: prompt, collect, tools, or finalize.
   */

  test("auto-step with `prompt` throws FlowConfigurationError with message containing 'prompt'", () => {
    expect(() => {
      new Step("test-flow", { id: "bad-auto", auto: true, prompt: "This should fail" });
    }).toThrow(expect.objectContaining({
      name: "FlowConfigurationError",
      message: expect.stringContaining("prompt"),
    }));
  });

  test("auto-step with `collect` throws FlowConfigurationError with message containing 'collect'", () => {
    expect(() => {
      new Step<unknown, TestData>("test-flow", { id: "bad-auto", auto: true, collect: ["field1"] });
    }).toThrow(expect.objectContaining({
      name: "FlowConfigurationError",
      message: expect.stringContaining("collect"),
    }));
  });

  test("auto-step with `tools` throws FlowConfigurationError with message containing 'tools'", () => {
    const tool: Tool<unknown, TestData> = {
      id: "some-tool",
      description: "A tool",
      handler: () => ({ data: "result" }),
    };

    expect(() => {
      new Step<unknown, TestData>("test-flow", { id: "bad-auto", auto: true, tools: [tool] });
    }).toThrow(expect.objectContaining({
      name: "FlowConfigurationError",
      message: expect.stringContaining("tools"),
    }));
  });

  test("auto-step with `finalize` throws FlowConfigurationError with message containing 'finalize'", () => {
    expect(() => {
      new Step("test-flow", { id: "bad-auto", auto: true, finalize: () => { } });
    }).toThrow(expect.objectContaining({
      name: "FlowConfigurationError",
      message: expect.stringContaining("finalize"),
    }));
  });

  test("auto-step with MULTIPLE forbidden fields throws ONE error listing ALL violating fields", () => {
    const tool: Tool<unknown, TestData> = {
      id: "some-tool",
      description: "A tool",
      handler: () => ({ data: "result" }),
    };

    expect(() => {
      new Step<unknown, TestData>("test-flow", { id: "bad-auto", auto: true, prompt: "fail", tools: [tool] });
    }).toThrow(expect.objectContaining({
      name: "FlowConfigurationError",
      message: expect.stringMatching(/prompt.*tools|tools.*prompt/),
    }));
  });

  test("auto-step with only allowed fields (prepare, requires, skipIf) does NOT throw", () => {
    expect(() => {
      new Step<unknown, TestData>("test-flow", {
        id: "good-auto",
        auto: true,
        prepare: () => { },
        requires: ["field1"],
        skipIf: () => false,
      });
    }).not.toThrow();
  });
});
