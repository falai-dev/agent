/* eslint-disable @typescript-eslint/no-explicit-any,  */
/**
 * Tool Functionality Tests
 *
 * Tests tool creation, execution, parameter validation, context access,
 * and integration with agents and routes.
 */
import { expect, test, describe } from "bun:test";
import {
  Agent,
  createSession,
  type Tool,
  type ToolContext,
  type ToolResult,
} from "../src/index";
import { MockProviderFactory } from "./mock-provider";

// Test data types for agent-level data collection
interface UserProfile {
  userId: string;
  name: string;
  email: string;
  preferences: {
    theme: "light" | "dark";
    notifications: boolean;
  };
  location?: string;
  rawOrder?: OrderData;
  apiResponse?: {
    status: number;
    data: Record<string, unknown>;
  };
}

interface OrderData {
  product: string;
  qty: number;
  cost: number;
  orderId: string;
  items: Array<{ name: string; quantity: number; price: number }>;
  total: number;
  status: "pending" | "processing" | "shipped" | "delivered";
  customerName?: string;
  email?: string;
}

// Test utilities
function createToolTestAgent(): Agent<UserProfile, OrderData> {
  return new Agent<UserProfile, OrderData>({
    name: "ToolTestAgent",
    description: "Agent for testing tool functionality",
    context: {
      userId: "test-user-123",
      name: "Test User",
      email: "test@example.com",
      preferences: {
        theme: "light",
        notifications: true,
      },
    },
    provider: MockProviderFactory.basic(),
    schema: {
      type: "object",
      properties: {
        product: { type: "string" },
        qty: { type: "number", minimum: 1 },
        cost: { type: "number", minimum: 0 },
        orderId: { type: "string" },
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              quantity: { type: "number" },
              price: { type: "number" },
            },
          },
        },
        total: { type: "number", minimum: 0 },
        status: { type: "string", enum: ["pending", "processing", "shipped", "delivered"] },
        customerName: { type: "string" },
        email: { type: "string", format: "email" },
      },
      required: ["product", "qty"],
    },
  });
}

function createMockToolContext<TContext = unknown, TData = unknown>(
  context?: TContext,
  data?: Partial<TData>
): ToolContext<TContext, TData> {
  return {
    context: context || ({} as TContext),
    updateContext: async () => { },
    updateData: async () => { },
    history: [],
    data: data || {},
  };
}

async function executeToolForTest<
  TContext = unknown,
  TData = unknown,
  TArgs extends unknown[] = unknown[],
  TResult = unknown
>(
  tool: Tool<TContext, TData, TArgs, TResult>,
  args: TArgs,
  context?: TContext,
  data?: Partial<TData>
): Promise<ToolResult<TResult, TContext, TData>> {
  const toolContext = createMockToolContext(context, data);
  return await tool.handler(toolContext, ...args);
}

describe("Tool Creation and Configuration", () => {
  test("should create tool with basic configuration", () => {
    const tool: Tool<unknown, { input?: string }, [input: string], string> = {
      id: "basic_tool",
      description: "A basic test tool",
      parameters: {
        type: "object",
        properties: {
          input: { type: "string" },
        },
        required: ["input"],
      },
      handler: (toolContext, ...args) => ({
        data: `Processed: ${args[0]}`,
      }),
    };

    expect(tool.id).toBe("basic_tool");
    expect(tool.description).toBe("A basic test tool");
    expect((tool.parameters as { required: string[] }).required).toEqual([
      "input",
    ]);
  });

  test("should create tool with complex parameter schema", () => {
    const tool: Tool<
      unknown,
      any,
      [userId: string, orderData: any, options?: any],
      string
    > = {
      id: "complex_tool",
      description: "Tool with complex parameters",
      parameters: {
        type: "object",
        properties: {
          userId: { type: "string" },
          orderData: {
            type: "object",
            properties: {
              items: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    quantity: { type: "number", minimum: 1 },
                    price: { type: "number", minimum: 0 },
                  },
                  required: ["name", "quantity"],
                },
              },
              total: { type: "number" },
            },
            required: ["items"],
          },
          options: {
            type: "object",
            properties: {
              priority: {
                type: "string",
                enum: ["low", "medium", "high"],
                default: "medium",
              },
              notify: { type: "boolean", default: true },
            },
          },
        },
        required: ["userId", "orderData"],
      },
      handler: (
        _toolContext,
        userId: string,
        _orderData: any,
        _options?: any
      ) => ({
        data: `Processed order for user ${userId}`,
      }),
    };

    expect(
      (tool.parameters as { properties: { orderData: { type: string } } })
        .properties.orderData.type
    ).toBe("object");
    expect(
      (
        tool.parameters as {
          properties: {
            options: { properties: { priority: { enum: string[] } } };
          };
        }
      ).properties.options.properties.priority.enum
    ).toEqual(["low", "medium", "high"]);
  });

  test("should create tool with no parameters", () => {
    const tool: Tool<unknown, object, [], string> = {
      id: "no_params_tool",
      description: "Tool with no parameters",
      parameters: {
        type: "object",
        properties: {},
      },
      handler: (_toolContext) => ({
        data: "No parameters needed",
      }),
    };

    expect(
      (tool.parameters as { properties: Record<string, unknown> }).properties
    ).toEqual({});
  });
});

describe("Tool Execution", () => {
  test("should execute tool and return data", async () => {
    const tool: Tool<
      unknown,
      { message?: string },
      [message?: string],
      string
    > = {
      id: "echo_tool",
      description: "Echoes input data",
      parameters: {
        type: "object",
        properties: {
          message: { type: "string" },
        },
      },
      handler: (_toolContext, message?: string) => ({
        data: `Echo: ${message}`,
      }),
    };

    const result = await executeToolForTest(tool, ["Hello World"]);
    expect(result.data).toBe("Echo: Hello World");
  });

  test("should execute tool with data updates", async () => {
    const tool: Tool<unknown, Partial<OrderData>, [], string> = {
      id: "order_processor",
      description: "Processes orders",
      parameters: {
        type: "object",
        properties: {},
      },
      handler: (_toolContext) => ({
        data: "Order processed",
        dataUpdate: {
          orderId: "ORD-123",
          status: "processing" as const,
          total: 99.99,
        },
      }),
    };

    const result = await executeToolForTest(tool, []);
    expect(result.data).toBe("Order processed");
    expect(result.dataUpdate).toEqual({
      orderId: "ORD-123",
      status: "processing",
      total: 99.99,
    });
  });

  test("should handle tool execution errors", () => {
    const tool: Tool<unknown, unknown, [], unknown> = {
      id: "error_tool",
      description: "Tool that throws errors",
      parameters: {
        type: "object",
        properties: {},
      },
      handler: (_toolContext) => {
        throw new Error("Tool execution failed");
      },
    };

    expect(executeToolForTest(tool, [])).rejects.toThrow(
      "Tool execution failed"
    );
  });

  test("should execute async tools", async () => {
    const asyncTool: Tool<
      unknown,
      { delay?: number },
      [delay?: number],
      string
    > = {
      id: "async_tool",
      description: "Asynchronous tool",
      parameters: {
        type: "object",
        properties: {
          delay: { type: "number" },
        },
      },
      handler: async (_toolContext, delay: number = 100) => {
        await new Promise((resolve) => setTimeout(resolve, delay));
        return {
          data: `Delayed response after ${delay}ms`,
        };
      },
    };

    const startTime = Date.now();
    const result = await executeToolForTest(asyncTool, [50]);
    const endTime = Date.now();

    expect(result.data).toBe("Delayed response after 50ms");
    expect(endTime - startTime).toBeGreaterThanOrEqual(45); // Allow some margin
  });
});

describe("Tool Context Access", () => {
  test("should access context in tool execution", async () => {
    const agent = createToolTestAgent();

    const contextTool: Tool<UserProfile, object, [], string> = {
      id: "context_reader",
      description: "Reads user context",
      parameters: {
        type: "object",
        properties: {},
      },
      handler: (toolContext) => ({
        data: `Hello ${toolContext.context?.name}, your email is ${toolContext.context?.email}`,
      }),
    };

    const context = await agent.getContext();
    const result = await executeToolForTest(contextTool, [], context);
    expect(result.data).toBe("Hello Test User, your email is test@example.com");
  });

  test("should access nested context properties", async () => {
    const agent = createToolTestAgent();

    const preferenceTool: Tool<UserProfile, object, [], string> = {
      id: "preference_reader",
      description: "Reads user preferences",
      parameters: {
        type: "object",
        properties: {},
      },
      handler: (toolContext) => ({
        data: `Theme: ${toolContext.context?.preferences.theme}, Notifications: ${toolContext.context?.preferences.notifications}`,
      }),
    };

    const context = await agent.getContext();
    const result = await executeToolForTest(preferenceTool, [], context);
    expect(result.data).toBe("Theme: light, Notifications: true");
  });

  test("should handle missing context gracefully", async () => {
    const contextTool: Tool<UserProfile | undefined, object, [], string> = {
      id: "safe_context_tool",
      description: "Handles missing context",
      parameters: {
        type: "object",
        properties: {},
      },
      handler: (toolContext) => ({
        data: `User: ${toolContext.context?.name || "Unknown"}`,
      }),
    };

    const result = await executeToolForTest(contextTool, [], undefined);
    expect(result.data).toBe("User: Unknown");
  });
});

describe("Tool Parameter Validation", () => {
  test("should validate required parameters", async () => {
    const tool: Tool<
      unknown,
      { requiredField?: string; optionalField?: number },
      [requiredField: string, optionalField?: number],
      string
    > = {
      id: "validation_tool",
      description: "Requires specific parameters",
      parameters: {
        type: "object",
        properties: {
          requiredField: { type: "string" },
          optionalField: { type: "number" },
        },
        required: ["requiredField"],
      },
      handler: (
        _toolContext,
        requiredField: string,
        optionalField?: number
      ) => ({
        data: `Required: ${requiredField}, Optional: ${optionalField ?? "not provided"
          }`,
      }),
    };

    // Valid call
    const validResult = await executeToolForTest(tool, ["test", 42]);
    expect(validResult.data).toBe("Required: test, Optional: 42");

    // Call with missing required field (validation would happen at schema level)
    const invalidResult = await executeToolForTest(tool, [
      undefined as any,
      42,
    ]);
    expect(invalidResult.data).toBe("Required: undefined, Optional: 42");
  });

  test("should handle array parameters", async () => {
    const tool: Tool<unknown, { items?: string[] }, [items: string[]], string> =
    {
      id: "array_tool",
      description: "Processes arrays",
      parameters: {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: { type: "string" },
          },
        },
        required: ["items"],
      },
      handler: (toolContext, items: string[]) => ({
        data: `Processed ${items.length} items: ${items.join(", ")}`,
      }),
    };

    const result = await executeToolForTest(tool, [
      ["item1", "item2", "item3"],
    ]);
    expect(result.data).toBe("Processed 3 items: item1, item2, item3");
  });

  test("should handle enum parameters", async () => {
    const tool: Tool<
      unknown,
      { priority?: string },
      [priority: "low" | "medium" | "high"],
      string
    > = {
      id: "enum_tool",
      description: "Validates enum values",
      parameters: {
        type: "object",
        properties: {
          priority: {
            type: "string",
            enum: ["low", "medium", "high"],
          },
        },
        required: ["priority"],
      },
      handler: (_toolContext, priority: "low" | "medium" | "high") => ({
        data: `Priority set to: ${priority}`,
      }),
    };

    const result = await executeToolForTest(tool, ["high"]);
    expect(result.data).toBe("Priority set to: high");
  });
});

describe("Tool Integration with Agents", () => {
  test("should add tools to agent", () => {
    const agent = createToolTestAgent();

    const tool1: Tool<UserProfile, OrderData, [], string> = {
      id: "tool1",
      description: "First tool",
      parameters: { type: "object", properties: {} },
      handler: () => ({ data: "Tool 1 executed" }),
    };

    const tool2: Tool<UserProfile, OrderData, [], string> = {
      id: "tool2",
      description: "Second tool",
      parameters: { type: "object", properties: {} },
      handler: () => ({ data: "Tool 2 executed" }),
    };

    agent.createTool(tool1);
    agent.createTool(tool2);

    const tools = agent.getTools();
    expect(tools).toHaveLength(2);
    expect(tools.map((t) => t.id)).toEqual(["tool1", "tool2"]);
  });

  test("should execute agent tools with agent-level data", async () => {
    const agent = createToolTestAgent();

    const calculatorTool: Tool<UserProfile, OrderData, [], string> = {
      id: "calculator",
      description: "Performs calculations",
      parameters: {
        type: "object",
        properties: {
          operation: {
            type: "string",
            enum: ["add", "subtract", "multiply", "divide"],
          },
          a: { type: "number" },
          b: { type: "number" },
        },
        required: ["operation", "a", "b"],
      },
      handler: ({ data }) => {
        const { operation, a, b } = data as {
          operation: string;
          a: number;
          b: number;
        };
        let result: number;

        switch (operation) {
          case "add":
            result = a + b;
            break;
          case "subtract":
            result = a - b;
            break;
          case "multiply":
            result = a * b;
            break;
          case "divide":
            result = a / b;
            break;
          default:
            throw new Error("Invalid operation");
        }

        return {
          data: `Result: ${result}`,
          dataUpdate: { total: result }, // Update agent-level data
        };
      },
    };

    agent.createTool(calculatorTool);

    // Simulate tool execution through agent response
    const provider = MockProviderFactory.withToolCalls([
      {
        toolName: "calculator",
        arguments: { operation: "add", a: 5, b: 3 },
      },
    ]);

    const agentWithProvider = new Agent<UserProfile, OrderData>({
      name: "Calculator Agent",
      context: await agent.getContext(),
      schema: await agent.getSchema(),
      provider,
      tools: [calculatorTool],
    });

    const session = createSession<OrderData>();
    const response = await agentWithProvider.respond({
      history: [
        {
          role: "user" as const,
          content: "Calculate 5 + 3",
          name: "User",
        },
      ],
      session,
    });

    expect(response.toolCalls).toBeDefined();
    expect(response.toolCalls![0].toolName).toBe("calculator");
  });

  test("should handle multiple tool calls with agent-level data", async () => {
    const agent = createToolTestAgent();

    const tools: Tool<UserProfile, OrderData, [], string>[] = [
      {
        id: "get_weather",
        description: "Gets weather information",
        parameters: {
          type: "object",
          properties: { location: { type: "string" } },
        },
        handler: ({ context }) => ({
          data: `Weather for ${context?.name}: Sunny, 72°F`,
          dataUpdate: { customerName: context?.name }, // Update agent data
        }),
      },
      {
        id: "get_time",
        description: "Gets current time",
        parameters: { type: "object", properties: {} },
        handler: () => ({
          data: `Current time: ${new Date().toLocaleTimeString()}`,
        }),
      },
    ];

    tools.forEach((tool) => agent.createTool(tool));

    const provider = MockProviderFactory.withToolCalls([
      {
        toolName: "get_weather",
        arguments: { location: "New York" },
      },
      {
        toolName: "get_time",
        arguments: {},
      },
    ]);

    const agentWithProvider2 = new Agent<UserProfile, OrderData>({
      name: "Weather and Time Agent",
      context: await agent.getContext(),
      schema: agent.getSchema(),
      provider,
      tools,
    });

    const session = createSession<OrderData>();
    const response = await agentWithProvider2.respond({
      history: [
        {
          role: "user" as const,
          content: "What's the weather and time?",
          name: "User",
        },
      ],
      session,
    });

    expect(response.toolCalls).toHaveLength(2);
    expect(response.toolCalls![0].toolName).toBe("get_weather");
    expect(response.toolCalls![1].toolName).toBe("get_time");
  });
});

describe("Tool Integration with Routes", () => {
  test("should add tools to route steps", () => {
    const agent = createToolTestAgent();

    const stepTool: Tool = {
      id: "step_tool",
      description: "Tool for route steps",
      parameters: { type: "object", properties: {} },
      handler: () => ({ data: "Step tool executed" }),
    };

    const route = agent.createRoute({
      title: "Tool Route",
      steps: [
        {
          id: "tool_step",
          prompt: "Executing tool...",
          tools: [stepTool],
        },
      ],
    });

    expect(route.getSteps()[0].tools).toContain(stepTool);
  });

  test("should add tools to entire route", () => {
    const agent = createToolTestAgent();

    const routeTool: Tool = {
      id: "route_tool",
      description: "Available throughout route",
      parameters: { type: "object", properties: {} },
      handler: () => ({ data: "Route tool executed" }),
    };

    const route = agent.createRoute({
      title: "Route Tool Test",
      tools: [routeTool],
      steps: [
        {
          id: "step1",
          prompt: "First step",
        },
        {
          id: "step2",
          prompt: "Second step with tool",
          tools: [
            {
              id: "step_specific_tool",
              description: "Tool for this specific step",
              parameters: { type: "object", properties: {} },
              handler: () => ({ data: "Step-specific tool" }),
            },
          ],
        },
      ],
    });

    expect(route.getTools()).toContain(routeTool);
    expect(route.getSteps()[1].tools).toHaveLength(1);
  });

  test("should handle tool execution in route finalization", () => {
    const agent = createToolTestAgent();

    const finalizeTool: Tool = {
      id: "finalize_tool",
      description: "Finalizes the route",
      parameters: { type: "object", properties: {} },
      handler: () => ({
        data: "Route finalized successfully",
        dataUpdate: { completed: true },
      }),
    };

    const route = agent.createRoute({
      title: "Finalization Route",
      steps: [
        {
          id: "final_step",
          prompt: "Finalizing...",
          finalize: finalizeTool,
        },
      ],
    });

    expect(route.getSteps()[0].finalize).toBe(finalizeTool);
  });
});

describe("Complex Tool Scenarios", () => {
  test("should handle data transformation tools", async () => {
    const agent = createToolTestAgent();

    const transformTool: Tool<UserProfile, unknown, unknown[], unknown> = {
      id: "data_transformer",
      description: "Transforms raw data into structured format",
      parameters: {
        type: "object",
        properties: {
          rawOrder: {
            type: "object",
            properties: {
              product: { type: "string" },
              qty: { type: "number" },
              cost: { type: "number" },
            },
          },
        },
      },
      handler: (_toolContext, ...args: unknown[]) => {
        const rawOrder = args[0] as OrderData;
        const transformed: Partial<OrderData> = {
          orderId: `ORD-${Date.now()}`,
          items: [
            {
              name: rawOrder?.product ?? "Unknown",
              quantity: rawOrder?.qty ?? 0,
              price: rawOrder?.cost ?? 0,
            },
          ],
          total:
            rawOrder?.qty && rawOrder?.cost ? rawOrder.qty * rawOrder.cost : 0,
          status: "pending" as const,
        };

        return {
          data: "Order data transformed",
          dataUpdate: transformed,
        };
      },
    } as Tool<UserProfile, unknown, unknown[], unknown>;

    agent.createTool(transformTool);

    const result = await executeToolForTest(
      transformTool,
      [
        {
          product: "Widget",
          qty: 5,
          cost: 10.99,
        } as OrderData,
      ] as unknown[],
      undefined,
      {}
    );

    expect(result.data).toBe("Order data transformed");
    expect((result.dataUpdate as Partial<OrderData>)?.total).toBe(54.95);
    expect((result.dataUpdate as Partial<OrderData>)?.items?.[0].name).toBe(
      "Widget"
    );
  });

  test("should handle API integration tools", async () => {
    const agent = createToolTestAgent();

    const apiTool: Tool<UserProfile, unknown, unknown[], unknown> = {
      id: "api_integrator",
      description: "Makes external API calls",
      parameters: {
        type: "object",
        properties: {
          endpoint: { type: "string" },
          method: { type: "string", enum: ["GET", "POST", "PUT", "DELETE"] },
          payload: { type: "object" },
        },
        required: ["endpoint", "method"],
      },
      handler: async (_toolContext, ...args: unknown[]) => {
        const endpoint = args[0] as string;
        const method = args[1] as string;
        const payload = args[2] as Record<string, unknown> | undefined;

        // Mock API call

        // Simulate API delay
        await new Promise((resolve) => setTimeout(resolve, 50));

        return {
          data: `API ${method} ${endpoint} completed`,
          dataUpdate: {
            apiResponse: {
              status: 200,
              data: { success: true, ...payload },
            },
          },
        };
      },
    } as Tool<UserProfile, unknown, unknown[], unknown>;

    agent.createTool(apiTool);

    const result = await executeToolForTest(
      apiTool,
      [
        "/users",
        "POST",
        { name: "New User", email: "user@example.com" },
      ] as unknown[],
      undefined,
      {}
    );

    expect(result.data).toBe("API POST /users completed");
    expect(
      (result.dataUpdate as Partial<{ apiResponse: { status: number } }>)
        ?.apiResponse?.status
    ).toBe(200);
  });

  test("should handle conditional tool logic", async () => {
    const agent = createToolTestAgent();

    const conditionalTool: Tool<UserProfile, unknown, unknown[], unknown> = {
      id: "conditional_processor",
      description: "Processes data based on conditions",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string" },
          data: { type: "object" },
        },
        required: ["action"],
      },
      handler: (toolContext, ...args: unknown[]) => {
        const action = args[0] as string;
        const userPrefs = toolContext.context?.preferences;

        let result: string;

        switch (action) {
          case "send_notification":
            if (userPrefs?.notifications) {
              result = "Notification sent";
            } else {
              result = "Notifications disabled";
            }
            break;
          case "apply_theme":
            result = `Applied ${userPrefs?.theme} theme`;
            break;
          default:
            result = "Unknown action";
        }

        return {
          data: result,
        };
      },
    } as Tool<UserProfile, unknown, unknown[], unknown>;

    agent.createTool(conditionalTool);

    const context = await agent.getContext();

    // Test with notifications enabled
    const result1 = await executeToolForTest(
      conditionalTool,
      ["send_notification"] as unknown[],
      context
    );
    expect(result1.data).toBe("Notification sent");

    // Test theme application
    const result2 = await executeToolForTest(
      conditionalTool,
      ["apply_theme"] as unknown[],
      context
    );
    expect(result2.data).toBe("Applied light theme");
  });
});
