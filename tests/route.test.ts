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
function createRouteTestAgent<TData = unknown>(): Agent<unknown, TData> {
  return new Agent<unknown, TData>({
    name: "RouteTestAgent",
    description: "Agent for testing route functionality",
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

function createOrderFulfillmentRoute(agent: Agent<unknown, OrderData>) {
  return agent.createRoute({
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

describe("Route Creation and Configuration", () => {
  test("should create route with basic configuration", () => {
    const agent = createRouteTestAgent<OrderData>();

    const route = agent.createRoute({
      title: "Simple Route",
      description: "A simple test route",
      when: ["Test condition"],
    });

    expect(route.title).toBe("Simple Route");
    expect(route.description).toBe("A simple test route");
    expect(route.when).toEqual(["Test condition"]);
    expect(route.requiredFields).toBeUndefined();
    expect(route.optionalFields).toBeUndefined();
  });

  test("should create route with required and optional fields", () => {
    const agent = createOrderTestAgent();

    const route = agent.createRoute({
      title: "Complex Order Route",
      description: "Route with required and optional fields",
      requiredFields: ["item", "quantity"],
      optionalFields: ["total", "customerName"],
    });

    expect(route.requiredFields).toEqual(["item", "quantity"]);
    expect(route.optionalFields).toEqual(["total", "customerName"]);
  });

  test("should validate required fields against agent schema", () => {
    const agent = createOrderTestAgent();

    // Valid fields should work
    const validRoute = agent.createRoute({
      title: "Valid Route",
      requiredFields: ["item", "quantity"], // These exist in schema
      optionalFields: ["total"], // This exists in schema
    });

    expect(validRoute.requiredFields).toEqual(["item", "quantity"]);

    // Invalid fields should throw error
    expect(() => {
      agent.createRoute({
        title: "Invalid Route",
        requiredFields: ["nonExistentField"] as any,
      });
    }).toThrow("Invalid required fields");

    expect(() => {
      agent.createRoute({
        title: "Invalid Optional Route",
        optionalFields: ["invalidOptional"] as any,
      });
    }).toThrow("Invalid optional fields");
  });

  test("should create route with sequential steps", () => {
    const agent = createOrderTestAgent();

    const route = createOrderFulfillmentRoute(agent);

    expect(route.getAllSteps()).toHaveLength(6);
    expect(route.getAllSteps()[0].id).toBe("select_item");
    expect(route.getAllSteps()[5].id).toBe("confirm_order");
  });

  test("should handle route step requirements", () => {
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
    const agent = createOrderTestAgent();
    const route = createOrderFulfillmentRoute(agent);

    let session = createSession<OrderData>();
    // Pre-select the route and step to test step execution
    session.currentRoute = {
      id: route.id,
      title: route.title,
      enteredAt: new Date(),
    };
    session.currentStep = { id: "select_item", enteredAt: new Date() };

    // Mock provider for step responses
    const provider = MockProviderFactory.basic();
    const agentWithProvider = new Agent<unknown, OrderData>({
      name: "RouteTestAgent",
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
    expect(response1.session?.currentRoute?.title).toBe("Order Fulfillment");
    expect(response1.session?.currentStep?.id).toBe("select_item");

    session = response1.session!;
  });

  test("should collect data at each step", () => {
    const agent = createOrderTestAgent();
    const route = createOrderFulfillmentRoute(agent);

    // Simulate step progression with data collection
    const steps = route.getAllSteps();

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

    const route = agent.createRoute({
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
          skipIf: (data) => !data.context.field1,
        },
      ],
    });

    const steps = route.getAllSteps();
    expect(steps[1].requires).toEqual(["field1"]);
    expect(typeof steps[1].skipIf).toBe("function");
  });

  test("should complete route when all steps finished", async () => {
    interface QuickRouteData {
      start?: boolean;
    }

    const agent = new Agent<unknown, QuickRouteData>({
      name: "QuickRouteAgent",
      description: "Agent for testing quick route completion",
      provider: MockProviderFactory.basic(),
      schema: {
        type: "object",
        properties: {
          start: { type: "boolean" },
        },
      },
    });

    // Create a simple route that ends
    const route = agent.createRoute({
      title: "Quick Route",
      when: ["Start quick route"],
      initialStep: {
        prompt: "This is the only step",
        skipIf: (params) => !!params.data?.start,
      },
      initialData: {
        start: true,
      },
    });
    route.initialStep.endRoute();

    const session = createSession<QuickRouteData>();

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
    const agent = new Agent<unknown, SupportTicketData>({
      name: "BranchingTestAgent",
      description: "Agent for testing branching routes",
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

    const route = agent.createRoute({
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
          skipIf: (ctx) =>
            ctx.context?.category === "general",
        },
        {
          id: "ask_priority",
          prompt: "What's the priority?",
          collect: ["priority"],
          skipIf: (ctx) =>
            ctx.context?.category === "general",
        },
      ],
    });

    const steps = route.getAllSteps();

    // Test skip conditions
    expect(typeof steps[1].skipIf).toBe("function");
    expect(typeof steps[2].skipIf).toBe("function");

    // Test skip logic using new evaluation system
    const skipContext = createTemplateContext({
      context: { category: "general" as const },
      data: { category: "general" as const },
    });
    const skipResult1 = await steps[1].evaluateSkipIf(skipContext);
    const skipResult2 = await steps[2].evaluateSkipIf(skipContext);
    expect(skipResult1.shouldSkip).toBe(true);
    expect(skipResult2.shouldSkip).toBe(true);

    const dontSkipContext = createTemplateContext({
      context: { category: "technical" as const },
      data: { category: "technical" as const },
    });
    const dontSkipResult1 = await steps[1].evaluateSkipIf(dontSkipContext);
    const dontSkipResult2 = await steps[2].evaluateSkipIf(dontSkipContext);
    expect(dontSkipResult1.shouldSkip).toBe(false);
    expect(dontSkipResult2.shouldSkip).toBe(false);
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
        data: `Processed: ${(data as Partial<{ input: string }>)?.input || "nothing"
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

  test("should add tools to route using new addTool method", () => {
    const agent = createOrderTestAgent();

    const route = agent.createRoute({
      title: "Route with Tools",
      description: "Testing route tool addition",
    });

    // Test that route has addTool method
    expect(typeof route.addTool).toBe("function");

    // Add tool to route using new method
    route.addTool({
      id: "route_specific_tool",
      description: "Tool specific to this route",
      handler: async (context) => {
        return `Route tool result for order: ${context.data.item || "none"}`;
      },
    });

    // Verify tool was added to route
    const routeTools = route.getTools();
    const addedTool = routeTools.find(t => t.id === "route_specific_tool");
    expect(addedTool).toBeDefined();
    expect(addedTool?.description).toBe("Tool specific to this route");
  });

  test("should access ToolManager through route's parent agent", () => {
    const agent = createOrderTestAgent<{ userId: string; }>();

    const route = agent.createRoute({
      title: "ToolManager Access Route",
    });

    // Route should be able to access agent's ToolManager
    expect(agent.tool).toBeDefined();

    // Register a tool through agent's ToolManager
    agent.tool.register({
      id: "shared_route_tool",
      description: "Tool shared across routes",
      handler: async (context) => {
        return `Shared tool for ${context.context?.userId || "user"}`;
      },
    });

    // Tool should be findable through ToolManager
    const foundTool = agent.tool.find("shared_route_tool");
    expect(foundTool).toBeDefined();
    expect(foundTool?.id).toBe("shared_route_tool");

    // Tool should appear in available tools
    const availableTools = agent.tool.getAvailable();
    expect(availableTools.some(t => t.id === "shared_route_tool")).toBe(true);
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
  test("should validate route fields against agent schema", () => {
    const agent = createOrderTestAgent();

    const route = agent.createRoute({
      title: "Validation Route",
      requiredFields: ["quantity", "paymentMethod"],
      optionalFields: ["total", "customerName"],
    });

    expect(route.requiredFields).toEqual(["quantity", "paymentMethod"]);
    expect(route.optionalFields).toEqual(["total", "customerName"]);
  });

  test("should handle route completion logic with agent-level data", () => {
    const agent = createOrderTestAgent();

    const route = agent.createRoute({
      title: "Completion Route",
      requiredFields: ["item", "quantity"],
      optionalFields: ["total"],
    });

    // Test completion logic
    const incompleteData: Partial<OrderData> = { item: "Widget" };
    expect(route.isComplete(incompleteData)).toBe(false);
    expect(route.getMissingRequiredFields(incompleteData)).toEqual(["quantity"]);
    expect(route.getCompletionProgress(incompleteData)).toBe(0.5);

    const completeData: Partial<OrderData> = { item: "Widget", quantity: 2 };
    expect(route.isComplete(completeData)).toBe(true);
    expect(route.getMissingRequiredFields(completeData)).toEqual([]);
    expect(route.getCompletionProgress(completeData)).toBe(1);
  });

  test("should handle cross-route data sharing", () => {
    const agent = createOrderTestAgent();

    // Create two routes that share data fields
    const customerRoute = agent.createRoute({
      title: "Customer Info",
      requiredFields: ["customerName", "email"],
      optionalFields: ["deliveryAddress"],
    });

    const orderRoute = agent.createRoute({
      title: "Order Details",
      requiredFields: ["item", "quantity"],
      optionalFields: ["total"],
    });

    // Test that both routes can work with the same agent-level data
    const sharedData: Partial<OrderData> = {
      customerName: "John Doe",
      email: "john@example.com",
      item: "Widget",
      quantity: 2,
      deliveryAddress: "123 Main St",
    };

    // Customer route should be complete with name and email
    expect(customerRoute.isComplete(sharedData)).toBe(true);
    expect(customerRoute.getMissingRequiredFields(sharedData)).toEqual([]);

    // Order route should be complete with item and quantity
    expect(orderRoute.isComplete(sharedData)).toBe(true);
    expect(orderRoute.getMissingRequiredFields(sharedData)).toEqual([]);
  });

  test("should reject invalid field references", () => {
    const agent = createOrderTestAgent();

    expect(() => {
      agent.createRoute({
        title: "Invalid Route",
        requiredFields: ["invalidField"] as any,
      });
    }).toThrow("Invalid required fields");

    expect(() => {
      agent.createRoute({
        title: "Invalid Optional Route",
        optionalFields: ["invalidOptional"] as any,
      });
    }).toThrow("Invalid optional fields");
  });

  test("should handle routes with no required fields", () => {
    const agent = createOrderTestAgent();

    const route = agent.createRoute({
      title: "Optional Only Route",
      optionalFields: ["customerName", "email"],
    });

    // Route with no required fields should always be complete
    expect(route.isComplete({})).toBe(true);
    expect(route.getMissingRequiredFields({})).toEqual([]);
    expect(route.getCompletionProgress({})).toBe(1);
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

    const route = agent.createRoute({
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

    expect(route.getAllSteps()).toHaveLength(6);
    expect(route.requiredFields).toEqual([
      "item",
      "quantity",
      "deliveryAddress",
      "paymentMethod",
    ]);
    expect(route.optionalFields).toEqual(["total", "orderId"]);
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

    const route = agent.createRoute({
      title: "Advanced Support",
      description: "Complex support with branching logic",
      when: ["User needs help", "Support request"],
      requiredFields: ["issue", "category"],
      optionalFields: ["priority", "resolution"],
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
