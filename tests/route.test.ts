/**
 * Route Functionality Tests
 *
 * Tests route creation, execution, step progression, and data collection.
 * Covers sequential flows, branching, schema validation, and route completion.
 */
import { expect, test, describe } from "bun:test";
import {
  Agent,
  createSession,
  END_ROUTE,
  END_ROUTE_ID,
  type Tool,
} from "../src/index";
import { MockProviderFactory } from "./mock-provider";

// Test data types
interface OrderData {
  item: string;
  quantity: number;
  deliveryAddress: string;
  paymentMethod: "credit_card" | "paypal" | "bank_transfer";
  total: number;
}

interface FeedbackData {
  rating: number;
  comments: string;
  wouldRecommend: boolean;
}

interface SupportTicketData {
  issue: string;
  category: "technical" | "billing" | "account" | "general";
  priority: "low" | "medium" | "high";
  resolution?: string;
  field1?: string;
  input?: string;
}

// Test utilities
function createRouteTestAgent(): Agent {
  return new Agent({
    name: "RouteTestAgent",
    description: "Agent for testing route functionality",
    provider: MockProviderFactory.basic(),
  });
}

function createOrderFulfillmentRoute(agent: Agent) {
  return agent.createRoute<OrderData>({
    title: "Order Fulfillment",
    description: "Complete customer order process",
    conditions: ["Customer wants to place an order", "Shopping inquiry"],
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
      },
      required: ["item", "quantity", "deliveryAddress", "paymentMethod"],
    },
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

describe("Route Creation and Configuration", () => {
  test("should create route with basic configuration", () => {
    const agent = createRouteTestAgent();

    const route = agent.createRoute({
      title: "Simple Route",
      description: "A simple test route",
      conditions: ["Test condition"],
    });

    expect(route.title).toBe("Simple Route");
    expect(route.description).toBe("A simple test route");
    expect(route.conditions).toHaveLength(1);
    expect(route.schema).toBeUndefined();
  });

  test("should create route with complex schema", () => {
    const agent = createRouteTestAgent();

    const route = agent.createRoute<OrderData>({
      title: "Complex Order Route",
      description: "Route with complex schema",
      schema: {
        type: "object",
        properties: {
          item: { type: "string", minLength: 1 },
          quantity: { type: "number", minimum: 1, maximum: 100 },
          total: { type: "number" },
        },
        required: ["item", "quantity"],
      },
    });

    const schema = route.schema;
    expect(schema).toBeDefined();
    expect(schema?.required).toEqual(["item", "quantity"]);
  });

  test("should create route with sequential steps", () => {
    const agent = createRouteTestAgent();

    const route = createOrderFulfillmentRoute(agent);

    expect(route.getAllSteps()).toHaveLength(6);
    expect(route.getAllSteps()[0].id).toBe("select_item");
    expect(route.getAllSteps()[5].id).toBe("confirm_order");
  });

  test("should handle route step requirements", () => {
    const agent = createRouteTestAgent();

    const route = agent.createRoute({
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

    const steps = route.getAllSteps();
    expect(steps[1].requires).toEqual(["field1"]);
  });
});

describe("Route Execution and Step Progression", () => {
  test("should execute route steps sequentially", async () => {
    // Mock provider that routes to our order route
    const provider = MockProviderFactory.forRoute(
      "Order Fulfillment",
      "select_item"
    );
    const agentWithProvider = new Agent({
      name: "RouteTestAgent",
      provider,
    });

    let session = createSession<OrderData>();

    // Step 1: Start order process
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

    expect(response1.message).toContain("order");
    expect(response1.session?.currentRoute?.title).toBe("Order Fulfillment");
    expect(response1.session?.currentStep?.id).toBe("select_item");

    session = response1.session!;
  });

  test("should collect data at each step", () => {
    const agent = createRouteTestAgent();
    const route = createOrderFulfillmentRoute(agent);

    // Simulate step progression with data collection
    const steps = route.getAllSteps();

    // Manually test data collection logic (simplified)
    expect(steps[0].collect).toEqual(["item"]);
    expect(steps[1].collect).toEqual(["quantity"]);
    expect(steps[2].collect).toEqual(["deliveryAddress"]);
  });

  test("should handle step prerequisites", () => {
    const agent = createRouteTestAgent();

    const route = agent.createRoute<SupportTicketData>({
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
          skipIf: (data) => !data.field1,
        },
      ],
    });

    const steps = route.getAllSteps();
    expect(steps[1].requires).toEqual(["field1"]);
    expect(typeof steps[1].skipIf).toBe("function");
  });

  test("should complete route when all steps finished", async () => {
    const agent = createRouteTestAgent();

    // Create a simple route that ends
    agent.createRoute({
      title: "Quick Route",
      steps: [
        {
          id: "only_step",
          prompt: "This is the only step",
          finalize: {
            id: "end_route",
            description: "End the route",
            parameters: { type: "object", properties: {} },
            handler: () => ({ data: "Route completed" }),
          },
        },
      ],
    });

    const session = createSession();

    const response = await agent.respond({
      history: [
        {
          role: "user" as const,
          content: "Start quick route",
          name: "User",
        },
      ],
      session,
    });

    // The route should complete
    expect(response.isRouteComplete).toBe(true);
  });
});

describe("Route Branching and Conditional Logic", () => {
  test("should create branching routes", () => {
    const agent = createRouteTestAgent();

    const route = agent.createRoute({
      title: "Support Route",
      description: "Customer support with branching",
    });

    // Create branching from initial step
    const branches = route.initialStep.branch([
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

  test("should handle conditional step skipping", () => {
    const agent = createRouteTestAgent();

    const route = agent.createRoute<SupportTicketData>({
      title: "Conditional Route",
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
          skipIf: (data: Partial<SupportTicketData>) =>
            data.category === "general",
        },
        {
          id: "ask_priority",
          prompt: "What's the priority?",
          collect: ["priority"],
          skipIf: (data: Partial<SupportTicketData>) =>
            data.category === "general",
        },
      ],
    });

    const steps = route.getAllSteps();

    // Test skip conditions
    expect(typeof steps[1].skipIf).toBe("function");
    expect(typeof steps[2].skipIf).toBe("function");

    // Test skip logic
    const skipBillingData: Partial<SupportTicketData> = {
      category: "general" as const,
    };
    expect(steps[1].skipIf!(skipBillingData)).toBe(true);
    expect(steps[2].skipIf!(skipBillingData)).toBe(true);

    const dontSkipData: Partial<SupportTicketData> = {
      category: "technical" as const,
    };
    expect(steps[1].skipIf!(dontSkipData)).toBe(false);
    expect(steps[2].skipIf!(dontSkipData)).toBe(false);
  });
});

describe("Route Tools and Finalization", () => {
  test("should execute step-level tools", () => {
    const agent = createRouteTestAgent();

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
        data: `Processed: ${
          (data as Partial<{ input: string }>)?.input || "nothing"
        }`,
      }),
    };

    const route = agent.createRoute({
      title: "Tool Route",
      steps: [
        {
          id: "tool_step",
          prompt: "Running tool...",
          tools: [tool],
        },
      ],
    });

    expect(route.getAllSteps()[0].tools).toContain(tool);
  });

  test("should handle route finalization", () => {
    const agent = createRouteTestAgent();

    const finalizeTool: Tool = {
      id: "finalize_order",
      description: "Finalize the order process",
      parameters: { type: "object", properties: {} },
      handler: () => ({ data: "Order finalized" }),
    };

    const route = agent.createRoute({
      title: "Finalize Route",
      steps: [
        {
          id: "final_step",
          prompt: "Finalizing...",
          finalize: finalizeTool,
        },
      ],
    });

    expect(route.getAllSteps()[0].finalize).toBe(finalizeTool);
  });

  test("should handle END_ROUTE termination", () => {
    const agent = createRouteTestAgent();

    const route = agent.createRoute({
      title: "End Route Test",
      steps: [
        {
          id: "middle_step",
          prompt: "Middle step",
        },
        END_ROUTE,
      ],
    });

    const steps = route.getAllSteps();
    expect(steps).toHaveLength(2);
    expect(steps[1].id).toBe(END_ROUTE_ID);
  });
});

describe("Route Data Collection and Validation", () => {
  test("should validate data against schema", () => {
    const agent = createRouteTestAgent();

    const route = agent.createRoute<OrderData>({
      title: "Validation Route",
      schema: {
        type: "object",
        properties: {
          quantity: { type: "number", minimum: 1, maximum: 100 },
          paymentMethod: {
            type: "string",
            enum: ["credit_card", "paypal", "bank_transfer"],
          },
        },
        required: ["quantity", "paymentMethod"],
      },
    });

    const schema = route.schema;
    expect(schema).toBeDefined();
    expect(schema?.required).toEqual(["quantity", "paymentMethod"]);
  });

  test("should handle default values in schema", () => {
    const agent = createRouteTestAgent();

    const route = agent.createRoute<FeedbackData>({
      title: "Feedback Route",
      schema: {
        type: "object",
        properties: {
          rating: { type: "number", minimum: 1, maximum: 5 },
          wouldRecommend: { type: "boolean", default: true },
          comments: { type: "string", default: "" },
        },
        required: ["rating"],
      },
    });

    const schema = route.schema;
    expect(schema?.properties?.wouldRecommend?.default).toBe(true);
    expect(schema?.properties?.comments?.default).toBe("");
  });
});

describe("Route Guidelines and Context", () => {
  test("should apply route-specific guidelines", () => {
    const agent = createRouteTestAgent();

    const route = agent.createRoute({
      title: "Guideline Route",
      guidelines: [
        {
          condition: "User is frustrated",
          action: "Offer immediate assistance and escalate if needed",
          enabled: true,
          tags: ["escalation", "empathy"],
        },
        {
          condition: "Technical issue detected",
          action: "Gather system information before proceeding",
          enabled: true,
          tags: ["technical"],
        },
      ],
    });

    expect(route.getGuidelines()).toHaveLength(2);
    expect(route.getGuidelines()[0].tags).toEqual(["escalation", "empathy"]);
  });

  test("should handle route-level tools", () => {
    const agent = createRouteTestAgent();

    const routeTool: Tool = {
      id: "route_tool",
      description: "Available throughout the route",
      parameters: { type: "object", properties: {} },
      handler: () => ({ data: "Route tool executed" }),
    };

    const route = agent.createRoute({
      title: "Tool Route",
      tools: [routeTool],
    });

    expect(route.getTools()).toContain(routeTool);
  });
});

describe("Complex Route Scenarios", () => {
  test("should handle multi-step order fulfillment", () => {
    const agent = createRouteTestAgent();

    const route = agent.createRoute<OrderData>({
      title: "Complete Order Flow",
      description: "Full order fulfillment process",
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

    expect(route.getAllSteps()).toHaveLength(6);
    expect(route.schema?.required).toEqual([
      "item",
      "quantity",
      "deliveryAddress",
      "paymentMethod",
    ]);
  });

  test("should handle branching support scenarios", () => {
    const agent = createRouteTestAgent();

    const route = agent.createRoute<SupportTicketData>({
      title: "Advanced Support",
      description: "Complex support with branching logic",
      conditions: ["User needs help", "Support request"],
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
        },
        required: ["issue", "category"],
      },
      guidelines: [
        {
          condition: "High priority issue",
          action: "Escalate immediately and provide direct contact",
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
    const branches = route.initialStep.branch([
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

    expect(route.getGuidelines()).toHaveLength(1);
    expect(route.getTools()).toHaveLength(1);
  });
});
