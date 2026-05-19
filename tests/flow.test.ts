/**
 * Flow Functionality Tests
 *
 * Tests flow creation, execution, step progression, and data collection.
 * Covers sequential flows, branching, schema validation, and flow completion.
 */
import { expect, test, describe } from "bun:test";
import {
  Agent,
  createSession,
  type Tool,
} from "../src/index";
import { MockProviderFactory } from "./mock-provider";
import { createTemplateContext } from "../src/utils";

// Test data types for agent-level data collection
interface OrderData {
  item: string;
  quantity: number;
  deliveryAddress: string;
  paymentMethod: "credit_card" | "paypal" | "bank_transfer";
  total: number;
  customerName?: string;
  email?: string;
  orderId?: string;
}

// interface FeedbackData {
//   rating: number;
//   comments: string;
//   wouldRecommend: boolean;
//   customerName?: string;
//   email?: string;
//   orderReference?: string;
// }

interface SupportTicketData {
  issue: string;
  category: "technical" | "billing" | "account" | "general";
  priority: "low" | "medium" | "high";
  resolution?: string;
  field1?: string;
  field2?: string;
  input?: string;
  customerName?: string;
  email?: string;
  ticketId?: string;
  billing_issue?: string;
}

// Test utilities
function createFlowTestAgent<TData = unknown>(): Agent<unknown, TData> {
  return new Agent<unknown, TData>({
    name: "FlowTestAgent",
    description: "Agent for testing flow functionality",
    provider: MockProviderFactory.basic(),
  });
}

function createOrderTestAgent<TContext = any>(): Agent<TContext, OrderData> {
  return new Agent<TContext, OrderData>({
    name: "OrderTestAgent",
    description: "Agent for testing order functionality",
    provider: MockProviderFactory.basic(),
    schema: {
      type: "object",
      properties: {
        item: { type: "string" },
        quantity: { type: "number", minimum: 1 },
        deliveryAddress: { type: "string" },
        paymentMethod: {
          type: "string",
          enum: ["credit_card", "paypal", "bank_transfer"],
        },
        total: { type: "number", minimum: 0 },
        customerName: { type: "string" },
        email: { type: "string", format: "email" },
        orderId: { type: "string" },
      },
      required: ["item", "quantity", "deliveryAddress", "paymentMethod"],
    },
  });
}

function createOrderFulfillmentFlow(agent: Agent<unknown, OrderData>) {
  return agent.createFlow({
    title: "Order Fulfillment",
    description: "Complete customer order process",
    when: ["Customer wants to place an order", "Shopping inquiry"],
    requiredFields: ["item", "quantity", "deliveryAddress", "paymentMethod"],
    optionalFields: ["total"],
    steps: [
      {
        id: "select_item",
        description: "Ask customer what they want to order",
        prompt: "What would you like to order?",
        collect: ["item"],
      },
      {
        id: "specify_quantity",
        description: "Ask for quantity",
        prompt: "How many would you like?",
        collect: ["quantity"],
        requires: ["item"],
      },
      {
        id: "get_address",
        description: "Get delivery address",
        prompt: "Where should we deliver this?",
        collect: ["deliveryAddress"],
        requires: ["quantity"],
      },
      {
        id: "payment_method",
        description: "Choose payment method",
        prompt: "How would you like to pay?",
        collect: ["paymentMethod"],
        requires: ["deliveryAddress"],
      },
      {
        id: "calculate_total",
        description: "Calculate order total",
        prompt: "Let me calculate your total...",
        tools: [
          {
            id: "calculate_order_total",
            description: "Calculate total price for order",
            parameters: {
              type: "object",
              properties: {
                item: { type: "string" },
                quantity: { type: "number" },
              },
            },
            handler: ({ data }) => {
              const orderData = data as Partial<OrderData>;
              const pricePerItem = 10; // Mock price
              const total = (orderData.quantity || 1) * pricePerItem;
              return {
                data: total,
                dataUpdate: { total },
              };
            },
          },
        ],
        requires: ["paymentMethod"],
      },
      {
        id: "confirm_order",
        description: "Confirm the order",
        prompt: "Your order is ready! Should I process it?",
        finalize: {
          id: "process_order",
          description: "Process the customer order",
          parameters: { type: "object", properties: {} },
          handler: ({ data }) => {
            console.log(`Processing order: ${JSON.stringify(data)}`);
            return {
              data: "Order processed successfully",
            };
          },
        },
        requires: ["total"],
      },
    ],
  });
}

describe("Flow Creation and Configuration", () => {
  test("should create flow with basic configuration", () => {
    const agent = createFlowTestAgent<OrderData>();

    const flow = agent.createFlow({
      title: "Simple Flow",
      description: "A simple test flow",
      when: ["Test condition"],
    });

    expect(flow.title).toBe("Simple Flow");
    expect(flow.description).toBe("A simple test flow");
    expect(flow.when).toEqual(["Test condition"]);
    expect(flow.requiredFields).toBeUndefined();
    expect(flow.optionalFields).toBeUndefined();
  });

  test("should create flow with required and optional fields", () => {
    const agent = createOrderTestAgent();

    const flow = agent.createFlow({
      title: "Complex Order Flow",
      description: "Flow with required and optional fields",
      requiredFields: ["item", "quantity"],
      optionalFields: ["total", "customerName"],
    });

    expect(flow.requiredFields).toEqual(["item", "quantity"]);
    expect(flow.optionalFields).toEqual(["total", "customerName"]);
  });

  test("should validate required fields against agent schema", () => {
    const agent = createOrderTestAgent();

    // Valid fields should work
    const validFlow = agent.createFlow({
      title: "Valid Flow",
      requiredFields: ["item", "quantity"], // These exist in schema
      optionalFields: ["total"], // This exists in schema
    });

    expect(validFlow.requiredFields).toEqual(["item", "quantity"]);

    // Invalid fields should throw error
    expect(() => {
      agent.createFlow({
        title: "Invalid Flow",
        requiredFields: ["nonExistentField"] as any,
      });
    }).toThrow("Invalid required fields");

    expect(() => {
      agent.createFlow({
        title: "Invalid Optional Flow",
        optionalFields: ["invalidOptional"] as any,
      });
    }).toThrow("Invalid optional fields");
  });

  test("should create flow with sequential steps", () => {
    const agent = createOrderTestAgent();

    const flow = createOrderFulfillmentFlow(agent);

    expect(flow.getAllSteps()).toHaveLength(6);
    expect(flow.getAllSteps()[0].id).toBe("select_item");
    expect(flow.getAllSteps()[5].id).toBe("confirm_order");
  });

  test("should handle flow step requirements", () => {
    const agent = new Agent<unknown, SupportTicketData>({
      name: "RequirementTestAgent",
      description: "Agent for testing step requirements",
      provider: MockProviderFactory.basic(),
      schema: {
        type: "object",
        properties: {
          field1: { type: "string" },
          field2: { type: "string" },
          issue: { type: "string" },
          category: { type: "string" },
        },
      },
    });

    const flow = agent.createFlow({
      title: "Requirement Test",
      steps: [
        {
          id: "step1",
          prompt: "First step",
          collect: ["field1"],
        },
        {
          id: "step2",
          prompt: "Second step",
          collect: ["field2"],
          requires: ["field1"],
        },
      ],
    });

    const steps = flow.getAllSteps();
    expect(steps[1].requires).toEqual(["field1"]);
  });
});

describe("Flow Execution and Step Progression", () => {
  test("should execute flow steps sequentially", async () => {
    const agent = createOrderTestAgent();
    const flow = createOrderFulfillmentFlow(agent);

    let session = createSession<OrderData>();
    // Pre-select the flow and step to test step execution
    session.currentFlow = {
      id: flow.id,
      title: flow.title,
      enteredAt: new Date(),
    };
    session.currentStep = { id: "select_item", enteredAt: new Date() };

    // Mock provider for step responses
    const provider = MockProviderFactory.basic();
    const agentWithProvider = new Agent<unknown, OrderData>({
      name: "FlowTestAgent",
      provider,
      schema: {
        type: "object",
        properties: {
          item: { type: "string" },
          quantity: { type: "number", minimum: 1 },
          deliveryAddress: { type: "string" },
          paymentMethod: {
            type: "string",
            enum: ["credit_card", "paypal", "bank_transfer"],
          },
          total: { type: "number", minimum: 0 },
          customerName: { type: "string" },
          email: { type: "string", format: "email" },
          orderId: { type: "string" },
        },
        required: ["item", "quantity", "deliveryAddress", "paymentMethod"],
      },
    });

    // Step 1: Execute first step
    const response1 = await agentWithProvider.respond({
      history: [
        {
          role: "user" as const,
          content: "I want to place an order",
          name: "Customer",
        },
      ],
      session,
    });

    expect(response1.message).toBeDefined();
    expect(response1.session?.currentFlow?.title).toBe("Order Fulfillment");
    expect(response1.session?.currentStep?.id).toBe("select_item");

    session = response1.session!;
  });

  test("should collect data at each step", () => {
    const agent = createOrderTestAgent();
    const flow = createOrderFulfillmentFlow(agent);

    // Simulate step progression with data collection
    const steps = flow.getAllSteps();

    // Manually test data collection logic (simplified)
    expect(steps[0].collect).toEqual(["item"]);
    expect(steps[1].collect).toEqual(["quantity"]);
    expect(steps[2].collect).toEqual(["deliveryAddress"]);
  });

  test("should handle step prerequisites", () => {
    const agent = new Agent<any, SupportTicketData>({
      name: "PrerequisiteTestAgent",
      description: "Agent for testing step prerequisites",
      provider: MockProviderFactory.basic(),
      schema: {
        type: "object",
        properties: {
          field1: { type: "string" },
          field2: { type: "string" },
          issue: { type: "string" },
          category: { type: "string" },
        },
      },
    });

    const flow = agent.createFlow({
      title: "Prerequisite Test",
      steps: [
        {
          id: "step1",
          prompt: "First step",
          collect: ["field1"],
        },
        {
          id: "step2",
          prompt: "Second step",
          collect: ["field2"],
          requires: ["field1"],
          skip: (ctx) => !ctx.data?.field1,
        },
      ],
    });

    const steps = flow.getAllSteps();
    expect(steps[1].requires).toEqual(["field1"]);
    expect(typeof steps[1].skip).toBe("function");
  });

  test("should complete flow when all steps finished", async () => {
    interface QuickFlowData {
      start?: boolean;
    }

    const agent = new Agent<unknown, QuickFlowData>({
      name: "QuickFlowAgent",
      description: "Agent for testing quick flow completion",
      provider: MockProviderFactory.basic(),
      schema: {
        type: "object",
        properties: {
          start: { type: "boolean" },
        },
      },
    });

    // Create a simple flow that ends
    const flow = agent.createFlow({
      title: "Quick Flow",
      when: ["Start quick flow"],
      steps: [
        {
          prompt: "This is the only step",
          skip: (params) => !!params.data?.start,
        },
      ],
      initialData: {
        start: true,
      },
    });
    // No further steps — initialStep is the implicit terminus

    const session = createSession<QuickFlowData>();

    const response = await agent.respond({
      history: [
        {
          role: "user" as const,
          content: "Start quick flow",
          name: "User",
        },
      ],
      session,
    });



    // The flow should complete
    expect(response.isFlowComplete).toBe(true);
  });
});

describe("Flow Branching and Conditional Logic", () => {
  test("should create branching flows", () => {
    const agent = new Agent<unknown, SupportTicketData>({
      name: "BranchingTestAgent",
      description: "Agent for testing branching flows",
      provider: MockProviderFactory.basic(),
      schema: {
        type: "object",
        properties: {
          issue: { type: "string" },
          billing_issue: { type: "string" },
          category: { type: "string" },
          priority: { type: "string" },
        },
      },
    });

    const flow = agent.createFlow({
      title: "Support Flow",
      description: "Customer support with branching",
    });

    // Create branching from initial step
    const branches = flow.initialStep.branch([
      {
        name: "technical",
        id: "tech_support",
        step: {
          prompt: "What technical issue are you experiencing?",
          collect: ["issue"],
        },
      },
      {
        name: "billing",
        id: "billing_support",
        step: {
          prompt: "What billing issue can I help you with?",
          collect: ["billing_issue"],
        },
      },
      {
        name: "general",
        step: {
          prompt: "How can I help you today?",
        },
      },
    ]);

    expect(branches).toHaveProperty("technical");
    expect(branches).toHaveProperty("billing");
    expect(branches).toHaveProperty("general");

    // Test that branches can be extended
    branches.technical.nextStep({
      prompt: "Have you tried restarting?",
    });

    branches.billing.nextStep({
      prompt: "Can you provide your account number?",
    });
  });

  test("should handle conditional step skipping", async () => {
    const agent = new Agent<any, SupportTicketData>({
      name: "ConditionalTestAgent",
      description: "Agent for testing conditional step skipping",
      provider: MockProviderFactory.basic(),
      schema: {
        type: "object",
        properties: {
          issue: { type: "string" },
          category: { type: "string", enum: ["technical", "billing", "account", "general"] },
          priority: { type: "string", enum: ["low", "medium", "high"] },
        },
      },
    });

    const flow = agent.createFlow({
      title: "Conditional Flow",
      steps: [
        {
          id: "ask_issue",
          prompt: "What's your issue?",
          collect: ["issue"],
        },
        {
          id: "ask_category",
          prompt: "What category?",
          collect: ["category"],
          skip: (ctx) =>
            ctx.context?.category === "general",
        },
        {
          id: "ask_priority",
          prompt: "What's the priority?",
          collect: ["priority"],
          skip: (ctx) =>
            ctx.context?.category === "general",
        },
      ],
    });

    const steps = flow.getAllSteps();

    // Test skip conditions
    expect(typeof steps[1].skip).toBe("function");
    expect(typeof steps[2].skip).toBe("function");

    // Test skip logic using new evaluation system
    const skipContext = createTemplateContext({
      context: { category: "general" as const },
      data: { category: "general" as const },
    });
    const skipResult1 = await steps[1].evaluateSkip(skipContext);
    const skipResult2 = await steps[2].evaluateSkip(skipContext);
    expect(skipResult1.shouldSkip).toBe(true);
    expect(skipResult2.shouldSkip).toBe(true);

    const dontSkipContext = createTemplateContext({
      context: { category: "technical" as const },
      data: { category: "technical" as const },
    });
    const dontSkipResult1 = await steps[1].evaluateSkip(dontSkipContext);
    const dontSkipResult2 = await steps[2].evaluateSkip(dontSkipContext);
    expect(dontSkipResult1.shouldSkip).toBe(false);
    expect(dontSkipResult2.shouldSkip).toBe(false);
  });
});

describe("Flow Tools and Finalization", () => {
  test("should execute step-level tools", () => {
    const agent = createFlowTestAgent();

    const tool: Tool = {
      id: "test_tool",
      description: "A test tool",
      parameters: {
        type: "object",
        properties: {
          input: { type: "string" },
        },
      },
      handler: ({ data }) => ({
        data: `Processed: ${(data as Partial<{ input: string }>)?.input || "nothing"
          }`,
      }),
    };

    const flow = agent.createFlow({
      title: "Tool Flow",
      steps: [
        {
          id: "tool_step",
          prompt: "Running tool...",
          tools: [tool],
        },
      ],
    });

    expect(flow.getAllSteps()[0].tools).toContain(tool);
  });

  test("should add tools to flow using new addTool method", () => {
    const agent = createOrderTestAgent();

    const flow = agent.createFlow({
      title: "Flow with Tools",
      description: "Testing flow tool addition",
    });

    // Test that flow has addTool method
    expect(typeof flow.addTool).toBe("function");

    // Add tool to flow using new method
    flow.addTool({
      id: "flow_specific_tool",
      description: "Tool specific to this flow",
      handler: async (context) => {
        return `Flow tool result for order: ${context.data.item || "none"}`;
      },
    });

    // Verify tool was added to flow
    const flowTools = flow.getTools();
    const addedTool = flowTools.find(t => t.id === "flow_specific_tool");
    expect(addedTool).toBeDefined();
    expect(addedTool?.description).toBe("Tool specific to this flow");
  });

  test("should access ToolManager through flow's parent agent", () => {
    const agent = createOrderTestAgent<{ userId: string; }>();

    const flow = agent.createFlow({
      title: "ToolManager Access Flow",
    });

    // Flow should be able to access agent's ToolManager
    expect(agent.tool).toBeDefined();

    // Register a tool through agent's ToolManager
    agent.tool.register({
      id: "shared_flow_tool",
      description: "Tool shared across flows",
      handler: async (context) => {
        return `Shared tool for ${context.context?.userId || "user"}`;
      },
    });

    // Tool should be findable through ToolManager
    const foundTool = agent.tool.find("shared_flow_tool");
    expect(foundTool).toBeDefined();
    expect(foundTool?.id).toBe("shared_flow_tool");

    // Tool should appear in available tools
    const availableTools = agent.tool.getAvailable();
    expect(availableTools.some(t => t.id === "shared_flow_tool")).toBe(true);
  });

  test("should handle flow finalization", () => {
    const agent = createFlowTestAgent();

    const finalizeTool: Tool = {
      id: "finalize_order",
      description: "Finalize the order process",
      parameters: { type: "object", properties: {} },
      handler: () => ({ data: "Order finalized" }),
    };

    const flow = agent.createFlow({
      title: "Finalize Flow",
      steps: [
        {
          id: "final_step",
          prompt: "Finalizing...",
          finalize: finalizeTool,
        },
      ],
    });

    expect(flow.getAllSteps()[0].finalize).toBe(finalizeTool);
  });

  test("last step in steps array is the implicit terminus", () => {
    const agent = createFlowTestAgent();

    const flow = agent.createFlow({
      title: "End Flow Test",
      steps: [
        {
          id: "middle_step",
          prompt: "Middle step",
        },
        {
          id: "final_step",
          prompt: "Final step",
        },
      ],
    });

    const steps = flow.getAllSteps();
    expect(steps).toHaveLength(2);
    // Last step has no transitions — implicit terminus
    expect(steps[1].getTransitions()).toHaveLength(0);
  });
});

describe("Flow Data Collection and Validation", () => {
  test("should validate flow fields against agent schema", () => {
    const agent = createOrderTestAgent();

    const flow = agent.createFlow({
      title: "Validation Flow",
      requiredFields: ["quantity", "paymentMethod"],
      optionalFields: ["total", "customerName"],
    });

    expect(flow.requiredFields).toEqual(["quantity", "paymentMethod"]);
    expect(flow.optionalFields).toEqual(["total", "customerName"]);
  });

  test("should handle flow completion logic with agent-level data", () => {
    const agent = createOrderTestAgent();

    const flow = agent.createFlow({
      title: "Completion Flow",
      requiredFields: ["item", "quantity"],
      optionalFields: ["total"],
    });

    // Test completion logic
    const incompleteData: Partial<OrderData> = { item: "Widget" };
    expect(flow.isComplete(incompleteData)).toBe(false);
    expect(flow.getMissingRequiredFields(incompleteData)).toEqual(["quantity"]);
    expect(flow.getCompletionProgress(incompleteData)).toBe(0.5);

    const completeData: Partial<OrderData> = { item: "Widget", quantity: 2 };
    expect(flow.isComplete(completeData)).toBe(true);
    expect(flow.getMissingRequiredFields(completeData)).toEqual([]);
    expect(flow.getCompletionProgress(completeData)).toBe(1);
  });

  test("should handle cross-flow data sharing", () => {
    const agent = createOrderTestAgent();

    // Create two flows that share data fields
    const customerFlow = agent.createFlow({
      title: "Customer Info",
      requiredFields: ["customerName", "email"],
      optionalFields: ["deliveryAddress"],
    });

    const orderFlow = agent.createFlow({
      title: "Order Details",
      requiredFields: ["item", "quantity"],
      optionalFields: ["total"],
    });

    // Test that both flows can work with the same agent-level data
    const sharedData: Partial<OrderData> = {
      customerName: "John Doe",
      email: "john@example.com",
      item: "Widget",
      quantity: 2,
      deliveryAddress: "123 Main St",
    };

    // Customer flow should be complete with name and email
    expect(customerFlow.isComplete(sharedData)).toBe(true);
    expect(customerFlow.getMissingRequiredFields(sharedData)).toEqual([]);

    // Order flow should be complete with item and quantity
    expect(orderFlow.isComplete(sharedData)).toBe(true);
    expect(orderFlow.getMissingRequiredFields(sharedData)).toEqual([]);
  });

  test("should reject invalid field references", () => {
    const agent = createOrderTestAgent();

    expect(() => {
      agent.createFlow({
        title: "Invalid Flow",
        requiredFields: ["invalidField"] as any,
      });
    }).toThrow("Invalid required fields");

    expect(() => {
      agent.createFlow({
        title: "Invalid Optional Flow",
        optionalFields: ["invalidOptional"] as any,
      });
    }).toThrow("Invalid optional fields");
  });

  test("should handle flows with no required fields", () => {
    const agent = createOrderTestAgent();

    const flow = agent.createFlow({
      title: "Optional Only Flow",
      optionalFields: ["customerName", "email"],
    });

    // Flow with only optional fields (no required fields) is NOT complete based on data
    // Optional-only flows complete when the last step finishes (implicit terminus)
    expect(flow.isComplete({})).toBe(false);
    expect(flow.getMissingRequiredFields({})).toEqual([]);
    expect(flow.getCompletionProgress({})).toBe(0);
  });
});

describe("Flow Guidelines and Context", () => {
  test("should apply flow-specific instructions", () => {
    const agent = createFlowTestAgent();

    const flow = agent.createFlow({
      title: "Instruction Flow",
      instructions: [
        {
          when: "User is frustrated",
          prompt: "Offer immediate assistance and escalate if needed",
          enabled: true,
          tags: ["escalation", "empathy"],
        },
        {
          when: "Technical issue detected",
          prompt: "Gather system information before proceeding",
          enabled: true,
          tags: ["technical"],
        },
      ],
    });

    expect(flow.getInstructions()).toHaveLength(2);
    expect(flow.getInstructions()[0].tags).toEqual(["escalation", "empathy"]);
  });

  test("should handle flow-level tools", () => {
    const agent = createFlowTestAgent();

    const flowTool: Tool = {
      id: "flow_tool",
      description: "Available throughout the flow",
      parameters: { type: "object", properties: {} },
      handler: () => ({ data: "Flow tool executed" }),
    };

    const flow = agent.createFlow({
      title: "Tool Flow",
      tools: [flowTool],
    });

    expect(flow.getTools()).toContain(flowTool);
  });
});

describe("Complex Flow Scenarios", () => {
  test("should handle multi-step order fulfillment", () => {
    // Create agent with extended schema for this test
    const agent = new Agent<unknown, OrderData & { orderId?: string }>({
      name: "ExtendedOrderAgent",
      provider: MockProviderFactory.basic(),
      schema: {
        type: "object",
        properties: {
          item: { type: "string" },
          quantity: { type: "number" },
          deliveryAddress: { type: "string" },
          paymentMethod: { type: "string" },
          total: { type: "number" },
          orderId: { type: "string" },
        },
        required: ["item", "quantity", "deliveryAddress", "paymentMethod"],
      },
    });

    const flow = agent.createFlow({
      title: "Complete Order Flow",
      description: "Full order fulfillment process",
      requiredFields: ["item", "quantity", "deliveryAddress", "paymentMethod"],
      optionalFields: ["total", "orderId"],
      steps: [
        {
          id: "item_selection",
          prompt: "What would you like to order?",
          collect: ["item"],
        },
        {
          id: "quantity_selection",
          prompt: "How many units?",
          collect: ["quantity"],
          requires: ["item"],
        },
        {
          id: "address_collection",
          prompt: "Delivery address?",
          collect: ["deliveryAddress"],
          requires: ["quantity"],
        },
        {
          id: "payment_selection",
          prompt: "Payment method?",
          collect: ["paymentMethod"],
          requires: ["deliveryAddress"],
        },
        {
          id: "order_calculation",
          prompt: "Calculating total...",
          tools: [
            {
              id: "calculate_total",
              description: "Calculate order total",
              parameters: {
                type: "object",
                properties: {
                  item: { type: "string" },
                  quantity: { type: "number" },
                },
              },
              handler: ({ data }) => {
                const order = data as Partial<OrderData>;
                const total = (order.quantity || 1) * 25.99;
                return {
                  data: total,
                  dataUpdate: { total, orderId: `ORD-${Date.now()}` },
                };
              },
            },
          ],
          requires: ["paymentMethod"],
        },
        {
          id: "order_confirmation",
          prompt: "Confirm your order?",
          finalize: {
            id: "place_order",
            description: "Place the final order",
            parameters: { type: "object", properties: {} },
            handler: ({ data }) => {
              const order = data as OrderData;
              return {
                data: `Order for ${order.item} placed successfully for $${order.total}`,
              };
            },
          },
          requires: ["total"],
        },
      ],
    });

    expect(flow.getAllSteps()).toHaveLength(6);
    expect(flow.requiredFields).toEqual([
      "item",
      "quantity",
      "deliveryAddress",
      "paymentMethod",
    ]);
    expect(flow.optionalFields).toEqual(["total", "orderId"]);
  });

  test("should handle branching support scenarios", () => {
    // Create agent with support ticket schema
    const agent = new Agent<unknown, SupportTicketData>({
      name: "SupportAgent",
      provider: MockProviderFactory.basic(),
      schema: {
        type: "object",
        properties: {
          issue: { type: "string" },
          category: {
            type: "string",
            enum: ["technical", "billing", "account", "general"],
          },
          priority: { type: "string", enum: ["low", "medium", "high"] },
          resolution: { type: "string" },
          field1: { type: "string" },
          input: { type: "string" },
        },
        required: ["issue", "category"],
      },
    });

    const flow = agent.createFlow({
      title: "Advanced Support",
      description: "Complex support with branching logic",
      when: ["User needs help", "Support request"],
      requiredFields: ["issue", "category"],
      optionalFields: ["priority", "resolution"],
      instructions: [
        {
          when: "High priority issue",
          prompt: "Escalate immediately and provide direct contact",
          enabled: true,
          tags: ["urgent", "escalation"],
        },
      ],
      tools: [
        {
          id: "escalate_ticket",
          description: "Escalate ticket to senior support",
          parameters: {
            type: "object",
            properties: {
              ticketId: { type: "string" },
              priority: { type: "string" },
            },
          },
          handler: () => {
            return {
              data: `Ticket escalated to senior support`,
            };
          },
        },
      ],
    });

    // Create branching logic
    const branches = flow.initialStep.branch([
      {
        name: "technical",
        id: "tech_branch",
        step: {
          prompt: "Technical issue - have you tried restarting?",
          collect: ["issue"],
        },
      },
      {
        name: "billing",
        id: "billing_branch",
        step: {
          prompt: "Billing issue - account number?",
          collect: ["issue"],
        },
      },
    ]);

    // Extend branches
    branches.technical.nextStep({
      prompt: "Can you describe the technical problem?",
      collect: ["category"],
    });

    branches.billing.nextStep({
      prompt: "What billing issue are you facing?",
      collect: ["category"],
    });

    expect(flow.getInstructions()).toHaveLength(1);
    expect(flow.getTools()).toHaveLength(1);
  });
});
