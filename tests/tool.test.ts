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
  Event,
  MessageEventData,
  StatusEventData,
  StepRef,
  ToolEventData,
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
  status?: string;
  lastAction?: string;
  lastLogin?: number;
  timestamp?: number;
}

interface OrderData {
  name?: string;
  product: string;
  qty: number;
  cost: number;
  orderId: string;
  items: Array<{ name: string; quantity: number; price: number }>;
  total: number;
  status: "pending" | "processing" | "shipped" | "delivered";
  customerName?: string;
  email?: string;
  score?: number;
  fullProfile?: string;
  rawOrder?: unknown;
  lastInput?: unknown;
  enrichedAt?: string;
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

// Enhanced mock context that properly implements all ToolContext methods
class MockToolContext<TContext = unknown, TData = unknown> implements ToolContext<TContext, TData> {
  public context: TContext;
  public data: Partial<TData>;
  public history: Event[];
  public step?: StepRef;
  public metadata?: Record<string, unknown>;

  private contextUpdateCallbacks: Array<(updates: Partial<TContext>) => void> = [];
  private dataUpdateCallbacks: Array<(updates: Partial<TData>) => void> = [];

  constructor(
    context?: TContext,
    data?: Partial<TData>,
    history?: Event[],
    step?: StepRef,
    metadata?: Record<string, unknown>
  ) {
    this.context = context || ({} as TContext);
    this.data = data ? { ...data } : {};
    this.history = history || [];
    this.step = step;
    this.metadata = metadata;
  }

  async updateContext(updates: Partial<TContext>): Promise<void> {
    this.context = { ...this.context, ...updates };
    // Notify callbacks for testing
    this.contextUpdateCallbacks.forEach(callback => callback(updates));
  }

  async updateData(updates: Partial<TData>): Promise<void> {
    this.data = { ...this.data, ...updates };
    // Notify callbacks for testing
    this.dataUpdateCallbacks.forEach(callback => callback(updates));
  }

  getField<K extends keyof TData>(key: K): TData[K] | undefined {
    return this.data[key];
  }

  async setField<K extends keyof TData>(key: K, value: TData[K]): Promise<void> {
    this.data = { ...this.data, [key]: value };
  }

  hasField<K extends keyof TData>(key: K): boolean {
    return key in this.data && this.data[key] !== undefined;
  }

  // Test helper methods
  onContextUpdate(callback: (updates: Partial<TContext>) => void): void {
    this.contextUpdateCallbacks.push(callback);
  }

  onDataUpdate(callback: (updates: Partial<TData>) => void): void {
    this.dataUpdateCallbacks.push(callback);
  }

  // Reset for clean test state
  reset(context?: TContext, data?: Partial<TData>): void {
    this.context = context || ({} as TContext);
    this.data = data ? { ...data } : {};
    this.history = [];
    this.step = undefined;
    this.metadata = undefined;
    this.contextUpdateCallbacks = [];
    this.dataUpdateCallbacks = [];
  }
}

function createMockToolContext<TContext = unknown, TData = unknown>(
  context?: TContext,
  data?: Partial<TData>,
  history?: Event<MessageEventData | ToolEventData | StatusEventData>[],
  step?: StepRef,
  metadata?: Record<string, unknown>
): MockToolContext<TContext, TData> {
  return new MockToolContext(context, data, history, step, metadata);
}

async function executeToolForTest<
  TContext = any,
  TData = any,
  TResult = any
>(
  tool: Tool<TContext, TData, TResult>,
  args?: Record<string, any>,
  context?: TContext,
  data?: Partial<TData>
): Promise<TResult | ToolResult<TResult, TContext, TData>> {
  const toolContext = createMockToolContext(context, data);
  return await tool.handler(toolContext, args);
}

describe("Tool Creation and Configuration", () => {
  test("should create tool using direct Tool interface", () => {
    const tool: Tool<unknown, { input?: string }, string> = {
      id: "basic_tool",
      description: "A basic test tool",
      parameters: {
        type: "object",
        properties: {
          input: { type: "string" },
        },
        required: ["input"],
      },
      handler: (toolContext, args) => ({
        data: `Processed: ${args?.input}`,
      }),
    };

    expect(tool.id).toBe("basic_tool");
    expect(tool.description).toBe("A basic test tool");
    expect((tool.parameters as { required: string[] }).required).toEqual([
      "input",
    ]);
  });

  test("should create tool using ToolManager.create()", () => {
    const agent = createToolTestAgent();

    const tool = agent.tool.create({
      id: "toolmanager_created",
      description: "Created via ToolManager",
      handler: async (context, args) => {
        return `Hello ${context.context?.name}, input: ${args?.message}`;
      },
    });

    expect(tool.id).toBe("toolmanager_created");
    expect(tool.description).toBe("Created via ToolManager");
    expect(typeof tool.handler).toBe("function");
  });

  test("should create tool using agent.addTool() method", () => {
    const agent = createToolTestAgent();

    agent.addTool({
      id: "agent_added_tool",
      description: "Added directly to agent",
      handler: async (context, args) => {
        return `Agent tool: ${context.context?.userId}, data: ${args?.data}`;
      },
    });

    const tools = agent.getTools();
    const addedTool = tools.find(t => t.id === "agent_added_tool");
    expect(addedTool).toBeDefined();
    expect(addedTool?.description).toBe("Added directly to agent");
  });

  test("should create tool with simplified handler returning direct value", () => {
    const agent = createToolTestAgent();

    const tool = agent.tool.create({
      id: "simple_return",
      description: "Returns value directly",
      handler: async (context, args) => {
        // Direct return - no ToolResult wrapper needed
        return `Simple result: ${args?.input}`;
      },
    });

    expect(tool.id).toBe("simple_return");
    expect(typeof tool.handler).toBe("function");
  });

  test("should create tool with ToolResult return for complex updates", () => {
    const agent = createToolTestAgent();

    const tool = agent.tool.create({
      id: "complex_return",
      description: "Returns ToolResult with updates",
      handler: async (context, args) => {
        // ToolResult return for data/context updates
        return {
          data: `Processed: ${args?.input}`,
          dataUpdate: { lastProcessed: args?.input },
          contextUpdate: { lastAction: "process" },
        };
      },
    });

    expect(tool.id).toBe("complex_return");
    expect(typeof tool.handler).toBe("function");
  });

  test("should create tool with enhanced context helpers", () => {
    const agent = createToolTestAgent();

    const tool = agent.tool.create({
      id: "context_helper_tool",
      description: "Uses context helper methods",
      handler: async (context, args) => {
        // Use enhanced context methods
        const hasEmail = context.hasField("email");
        const currentEmail = context.getField("email");

        if (args?.newEmail) {
          await context.setField("email", args.newEmail as string);
        }

        return `Had email: ${hasEmail}, Current: ${currentEmail}`;
      },
    });

    expect(tool.id).toBe("context_helper_tool");
    expect(typeof tool.handler).toBe("function");
  });
});

describe("Tool Execution", () => {
  test("should execute tool with direct return value", async () => {
    const agent = createToolTestAgent();

    const tool = agent.tool.create({
      id: "direct_return_tool",
      description: "Returns value directly",
      handler: async (context, args) => {
        // Direct return - simpler pattern
        return `Echo: ${args?.message}`;
      },
    });

    const result = await executeToolForTest(tool, { message: "Hello World" });
    expect(result).toBe("Echo: Hello World");
  });

  test("should execute tool with ToolResult return", async () => {
    const agent = createToolTestAgent();

    const tool = agent.tool.create({
      id: "toolresult_return_tool",
      description: "Returns ToolResult object",
      handler: async (context, args) => {
        // ToolResult return for complex scenarios
        return {
          data: "Order processed",
          dataUpdate: {
            orderId: "ORD-123",
            status: "processing" as const,
            total: 99.99,
          },
          contextUpdate: {
            lastOrderId: "ORD-123"
          }
        };
      },
    });

    const result = await executeToolForTest(tool);
    expect((result as ToolResult<string>).data).toBe("Order processed");
    expect((result as ToolResult<string>).dataUpdate).toEqual({
      orderId: "ORD-123",
      status: "processing",
      total: 99.99,
    });
    expect((result as ToolResult<string>).contextUpdate).toEqual({
      lastOrderId: "ORD-123"
    });
  });

  test("should execute tool using context helper methods", async () => {
    const agent = createToolTestAgent();

    const tool = agent.tool.create({
      id: "context_helper_tool",
      description: "Uses enhanced context methods",
      handler: async (context, args) => {
        // Use new context helper methods
        await context.updateData({ email: args?.email as string });
        await context.updateContext({ lastAction: "updateEmail" });

        const hasEmail = context.hasField("email");
        const email = context.getField("email");

        return `Updated email: ${email}, has field: ${hasEmail}`;
      },
    });

    // Create enhanced mock context
    const mockContext = createMockToolContext<UserProfile, OrderData>(
      await agent.getContext(),
      {}
    );

    const result = await tool.handler(mockContext, { email: "test@example.com" });
    expect(result).toContain("Updated email: test@example.com");
    expect(result).toContain("has field: true");
  });

  test("should execute tool via ToolManager.execute()", async () => {
    const agent = createToolTestAgent();

    // Register tool first
    agent.tool.register({
      id: "registered_execution_tool",
      description: "Tool executed via ToolManager",
      handler: async (context, args) => {
        return `Executed via ToolManager: ${args?.input}`;
      },
    });

    // Execute via ToolManager
    const result = await agent.tool.execute("registered_execution_tool", { input: "test data" });

    expect(result.success).toBe(true);
    expect(result.data).toBe("Executed via ToolManager: test data");
  });

  test("should handle tool execution errors gracefully", async () => {
    const agent = createToolTestAgent();

    agent.tool.register({
      id: "error_tool",
      description: "Tool that throws errors",
      handler: (_context, _args) => {
        throw new Error("Tool execution failed");
      },
    });

    try {
      await agent.tool.execute("error_tool");
      expect(false).toBe(true); // Should not reach here
    } catch (error: any) {
      expect(error.name).toBe("ToolExecutionError");
      expect(error.message).toContain("Tool execution failed");
      expect(error.toolId).toBe("error_tool");
    }
  });

  test("should execute async tools with proper timing", async () => {
    const agent = createToolTestAgent();

    const tool = agent.tool.create({
      id: "async_tool",
      description: "Asynchronous tool",
      handler: async (context, args) => {
        const delay = args?.delay ? Number(args.delay) : 100;
        await new Promise((resolve) => setTimeout(resolve, delay));
        return `Delayed response after ${delay}ms`;
      },
    });

    const startTime = Date.now();
    const result = await executeToolForTest(tool, { delay: 50 });
    const endTime = Date.now();

    expect(result).toBe("Delayed response after 50ms");
    expect(endTime - startTime).toBeGreaterThanOrEqual(45); // Allow some margin
  });
});

describe("Tool Context Access", () => {
  test("should access context with direct return", async () => {
    const agent = createToolTestAgent();

    const tool = agent.tool.create({
      id: "context_reader",
      description: "Reads user context",
      handler: (context) => {
        // Direct return with context access
        return `Hello ${context.context?.name}, your email is ${context.context?.email}`;
      },
    });

    const agentContext = await agent.getContext();
    const result = await executeToolForTest(tool, undefined, agentContext);
    expect(result).toBe("Hello Test User, your email is test@example.com");
  });

  test("should use enhanced context helper methods", async () => {
    const agent = createToolTestAgent();

    const tool = agent.tool.create({
      id: "context_helper_tool",
      description: "Uses context helper methods",
      handler: async (context, args) => {
        // Use new helper methods
        const hasName = context.hasField("customerName");
        const currentName = context.getField("customerName");

        if (args?.newName) {
          await context.setField("customerName", args.newName as string);
        }

        // Update context using helper
        await context.updateContext({
          lastAction: "nameUpdate",
          timestamp: Date.now()
        });

        const updatedName = context.getField("customerName");
        return `Had name: ${hasName}, Current: ${currentName || "none"}, Updated: ${updatedName}`;
      },
    });

    // Use enhanced mock context
    const mockContext = createMockToolContext<UserProfile, OrderData>(
      await agent.getContext(),
      {}
    );

    const result = await tool.handler(mockContext, { newName: "John Doe" });
    expect(result).toContain("Had name: false");
    expect(result).toContain("Current: none");
    expect(result).toContain("Updated: John Doe");
  });

  test("should access nested context properties with type safety", async () => {
    const agent = createToolTestAgent();

    const tool = agent.tool.create({
      id: "preference_reader",
      description: "Reads user preferences with type safety",
      handler: (context) => {
        const prefs = context.context?.preferences;
        return {
          data: `Theme: ${prefs?.theme}, Notifications: ${prefs?.notifications}`,
          contextUpdate: { lastPreferenceCheck: Date.now() }
        };
      },
    });

    const agentContext = await agent.getContext();
    const result = await executeToolForTest(tool, undefined, agentContext);
    expect((result as ToolResult<string>).data).toBe("Theme: light, Notifications: true");
    expect((result as ToolResult<string>).contextUpdate).toHaveProperty("lastPreferenceCheck");
  });

  test("should handle missing context gracefully with fallbacks", async () => {
    const agent = createToolTestAgent();

    const tool = agent.tool.create({
      id: "safe_context_tool",
      description: "Handles missing context with fallbacks",
      handler: (context) => {
        const userName = context.context?.name || "Unknown User";
        const userEmail = context.context?.email || "no-email@example.com";

        return {
          data: `User: ${userName}`,
          dataUpdate: {
            fallbackUsed: !context.context?.name,
            contactEmail: userEmail
          }
        };
      },
    });

    const result = await executeToolForTest(tool, undefined, undefined);
    expect((result as ToolResult<string>).data).toBe("User: Unknown User");
    expect((result as ToolResult<string>).dataUpdate).toEqual({
      fallbackUsed: true,
      contactEmail: "no-email@example.com"
    });
  });

  test("should access history and metadata from context", async () => {
    const agent = createToolTestAgent();

    const tool = agent.tool.create({
      id: "history_reader",
      description: "Reads interaction history",
      handler: (context) => {
        const historyCount = context.history.length;
        const hasMetadata = !!context.metadata;
        const stepInfo = context.step ? `Step: ${context.step.id}` : "No step";

        return `History: ${historyCount} events, Metadata: ${hasMetadata}, ${stepInfo}`;
      },
    });

    // Create enhanced mock context with history, metadata, and step
    const mockContext = createMockToolContext<UserProfile, OrderData>(
      await agent.getContext(),
      {},
      [
        { role: "user", content: "Hello", timestamp: Date.now() },
        { role: "assistant", content: "Hi there", timestamp: Date.now() }
      ] as any[],
      { id: "test-step", routeId: "test-route" } as StepRef,
      { sessionId: "test-123", userId: "user-456" }
    );

    const result = await tool.handler(mockContext);
    expect(result).toContain("History: 2 events");
    expect(result).toContain("Metadata: true");
    expect(result).toContain("Step: test-step");
  });

  test("should handle context and data updates with callbacks", async () => {
    const agent = createToolTestAgent();

    const tool = agent.tool.create({
      id: "update_tracker",
      description: "Tracks context and data updates",
      handler: async (context, args) => {
        const initialData = { ...context.data };
        const initialContext = { ...context.context };

        // Make updates
        await context.updateData({ email: args?.email as string, score: 100 });
        await context.updateContext({ lastLogin: Date.now(), status: "active" });

        return {
          data: "Updates completed",
          initialDataKeys: Object.keys(initialData),
          finalDataKeys: Object.keys(context.data),
          contextUpdated: true
        };
      },
    });

    const mockContext = createMockToolContext<UserProfile, OrderData>(
      { userId: "test-123", name: "Test User", email: "old@example.com", preferences: { theme: "light", notifications: true } },
      { product: "Widget" }
    );

    // Track updates
    let contextUpdates: any[] = [];
    let dataUpdates: any[] = [];

    mockContext.onContextUpdate((updates) => contextUpdates.push(updates));
    mockContext.onDataUpdate((updates) => dataUpdates.push(updates));

    const result = await tool.handler(mockContext, { email: "new@example.com" });

    expect((result as ToolResult<string>).data).toBe("Updates completed");
    expect(contextUpdates).toHaveLength(1);
    expect(dataUpdates).toHaveLength(1);
    expect(contextUpdates[0]).toHaveProperty("lastLogin");
    expect(dataUpdates[0]).toEqual({ email: "new@example.com", score: 100 });
  });

  test("should test field operations comprehensively", async () => {
    const agent = createToolTestAgent();

    const tool = agent.tool.create({
      id: "field_operations",
      description: "Tests all field operations",
      handler: async (context, args) => {
        const operations: string[] = [];

        // Test hasField
        operations.push(`hasEmail: ${context.hasField("email")}`);
        operations.push(`hasProduct: ${context.hasField("product")}`);

        // Test getField
        const currentEmail = context.getField("email");
        operations.push(`currentEmail: ${currentEmail || "none"}`);

        // Test setField
        await context.setField("email", "test@example.com");
        await context.setField("status", "active" as any);

        // Verify changes
        operations.push(`hasEmailAfterSet: ${context.hasField("email")}`);
        operations.push(`emailAfterSet: ${context.getField("email")}`);

        return operations.join(", ");
      },
    });

    const mockContext = createMockToolContext<UserProfile, OrderData>(
      await agent.getContext(),
      { product: "Widget", qty: 5 } // Initial data
    );

    const result = await tool.handler(mockContext);
    expect(result).toContain("hasEmail: false");
    expect(result).toContain("hasProduct: true");
    expect(result).toContain("currentEmail: none");
    expect(result).toContain("hasEmailAfterSet: true");
    expect(result).toContain("emailAfterSet: test@example.com");
  });
});

describe("Tool Parameter Handling", () => {
  test("should handle parameters with validation schema", async () => {
    const agent = createToolTestAgent();

    const tool = agent.tool.create({
      id: "validation_tool",
      description: "Handles parameters with validation",
      parameters: {
        type: "object",
        properties: {
          requiredField: { type: "string" },
          optionalField: { type: "number" },
        },
        required: ["requiredField"],
      },
      handler: (context, args) => {
        // Simple parameter access with fallbacks
        const required = args?.requiredField || "missing";
        const optional = args?.optionalField ?? "not provided";
        return `Required: ${required}, Optional: ${optional}`;
      },
    });

    // Valid call
    const validResult = await executeToolForTest(tool, { requiredField: "test", optionalField: 42 });
    expect(validResult).toBe("Required: test, Optional: 42");

    // Call with missing required field
    const invalidResult = await executeToolForTest(tool, { optionalField: 42 });
    expect(invalidResult).toBe("Required: missing, Optional: 42");
  });

  test("should handle complex nested parameters", async () => {
    const agent = createToolTestAgent();

    const tool = agent.tool.create({
      id: "complex_params_tool",
      description: "Handles complex nested parameters",
      parameters: {
        type: "object",
        properties: {
          user: {
            type: "object",
            properties: {
              name: { type: "string" },
              preferences: {
                type: "object",
                properties: {
                  theme: { type: "string", enum: ["light", "dark"] },
                  notifications: { type: "boolean" }
                }
              }
            }
          },
          items: {
            type: "array",
            items: { type: "string" }
          }
        }
      },
      handler: (context, args) => {
        const user = args?.user as any;
        const items = args?.items as string[] || [];

        return {
          data: `User: ${user?.name}, Theme: ${user?.preferences?.theme}, Items: ${items.length}`,
          dataUpdate: {
            lastUser: user?.name,
            itemCount: items.length
          }
        };
      },
    });

    const complexArgs = {
      user: {
        name: "John Doe",
        preferences: { theme: "dark", notifications: true }
      },
      items: ["item1", "item2", "item3"]
    };

    const result = await executeToolForTest(tool, complexArgs);
    expect((result as ToolResult<string>).data).toBe("User: John Doe, Theme: dark, Items: 3");
    expect((result as ToolResult<string>).dataUpdate).toEqual({
      lastUser: "John Doe",
      itemCount: 3
    });
  });

  test("should handle array parameters with processing", async () => {
    const agent = createToolTestAgent();

    const tool = agent.tool.create({
      id: "array_processor",
      description: "Processes array parameters",
      handler: (context, args) => {
        const items = args?.items as string[] || [];
        const processed = items.map(item => item.toUpperCase());

        return {
          data: `Processed ${items.length} items`,
          dataUpdate: {
            originalItems: items,
            processedItems: processed,
            processingDate: new Date().toISOString()
          }
        };
      },
    });

    const result = await executeToolForTest(tool, { items: ["apple", "banana", "cherry"] });
    expect((result as ToolResult<string>).data).toBe("Processed 3 items");
    expect((result as ToolResult<string>).dataUpdate?.processedItems).toEqual(["APPLE", "BANANA", "CHERRY"]);
  });

  test("should handle enum parameters with type safety", async () => {
    const agent = createToolTestAgent();

    const tool = agent.tool.create({
      id: "enum_tool",
      description: "Handles enum parameters",
      parameters: {
        type: "object",
        properties: {
          priority: {
            type: "string",
            enum: ["low", "medium", "high"],
          },
          status: {
            type: "string",
            enum: ["pending", "processing", "completed"]
          }
        },
        required: ["priority"],
      },
      handler: (context, args) => {
        const priority = args?.priority as "low" | "medium" | "high";
        const status = args?.status as "pending" | "processing" | "completed" || "pending";

        return {
          data: `Priority: ${priority}, Status: ${status}`,
          dataUpdate: {
            currentPriority: priority,
            currentStatus: status,
            updatedAt: Date.now()
          }
        };
      },
    });

    const result = await executeToolForTest(tool, { priority: "high", status: "processing" });
    expect((result as ToolResult<string>).data).toBe("Priority: high, Status: processing");
    expect((result as ToolResult<string>).dataUpdate?.currentPriority).toBe("high");
  });

  test("should handle optional parameters with defaults", async () => {
    const agent = createToolTestAgent();

    const tool = agent.tool.create({
      id: "defaults_tool",
      description: "Handles parameters with defaults",
      handler: (context, args) => {
        // Provide sensible defaults
        const limit = args?.limit as number || 10;
        const sortBy = args?.sortBy as string || "name";
        const ascending = args?.ascending as boolean ?? true;

        return `Limit: ${limit}, Sort: ${sortBy}, Ascending: ${ascending}`;
      },
    });

    // Test with no parameters
    const result1 = await executeToolForTest(tool);
    expect(result1).toBe("Limit: 10, Sort: name, Ascending: true");

    // Test with partial parameters
    const result2 = await executeToolForTest(tool, { limit: 5, ascending: false });
    expect(result2).toBe("Limit: 5, Sort: name, Ascending: false");
  });
});

describe("Tool Integration with Agents", () => {
  test("should add tools using agent.addTool() method", () => {
    const agent = createToolTestAgent();

    // Method 1: Direct addTool with simple handler
    agent.addTool({
      id: "simple_tool",
      description: "Simple tool with direct return",
      handler: async (context) => {
        return `Hello ${context.context?.name}`;
      },
    });

    // Method 2: addTool with ToolResult return
    agent.addTool({
      id: "complex_tool",
      description: "Complex tool with data updates",
      handler: async (context, args) => {
        return {
          data: `Processed: ${args?.input}`,
          dataUpdate: { lastInput: args?.input },
          contextUpdate: { lastAction: "process" }
        };
      },
    });

    const tools = agent.getTools();
    expect(tools.length).toBeGreaterThanOrEqual(2);

    const simpleTool = tools.find(t => t.id === "simple_tool");
    const complexTool = tools.find(t => t.id === "complex_tool");

    expect(simpleTool).toBeDefined();
    expect(simpleTool?.description).toBe("Simple tool with direct return");
    expect(complexTool).toBeDefined();
    expect(complexTool?.description).toBe("Complex tool with data updates");
  });

  test("should create tools via ToolManager and register them", () => {
    const agent = createToolTestAgent();

    // Method 3: Create via ToolManager then register
    const tool1 = agent.tool.create({
      id: "created_tool",
      description: "Created via ToolManager",
      handler: async (context) => {
        return `ToolManager created: ${context.context?.userId}`;
      },
    });

    // Method 4: Register tool for ID-based reference
    const tool2 = agent.tool.register({
      id: "registered_tool",
      description: "Registered for reference",
      handler: async (context, args) => {
        return `Registered tool: ${args?.message}`;
      },
    });

    expect(tool1.id).toBe("created_tool");
    expect(tool2.id).toBe("registered_tool");
    expect(agent.tool.isRegistered("registered_tool")).toBe(true);
    expect(agent.tool.find("registered_tool")).toBe(tool2);
  });

  test("should use pattern helper methods", () => {
    const agent = createToolTestAgent();

    // Method 5: Data enrichment pattern
    const enrichmentTool = agent.tool.createDataEnrichment({
      id: "enrich_profile",
      fields: ["customerName", "email"],
      enricher: async (context, data) => ({
        fullProfile: `${data.customerName} <${data.email}>`,
        enrichedAt: new Date().toISOString()
      }),
    });

    // Method 6: Validation pattern
    const validationTool = agent.tool.createValidation({
      id: "validate_order",
      fields: ["product", "qty"],
      validator: async (context, data) => ({
        valid: !!(data.product && data.qty && data.qty > 0),
        errors: [],
        warnings: []
      }),
    });

    // Method 7: API call pattern
    const apiTool = agent.tool.createApiCall({
      id: "fetch_inventory",
      endpoint: "https://api.example.com/inventory",
      method: "GET",
      transform: (response) => response
    });

    expect(enrichmentTool.id).toBe("enrich_profile");
    expect(enrichmentTool.name).toBe("Data Enrichment: enrich_profile");
    expect(validationTool.id).toBe("validate_order");
    expect(validationTool.name).toBe("Validation: validate_order");
    expect(apiTool.id).toBe("fetch_inventory");
    expect(apiTool.name).toBe("API Call: fetch_inventory");
  });

  test("should handle tool execution through different methods", async () => {
    const agent = createToolTestAgent();

    // Register a tool for execution testing
    agent.tool.register({
      id: "execution_test_tool",
      description: "Tool for testing execution",
      handler: async (context, args) => {
        return {
          data: `Executed with: ${args?.input}`,
          dataUpdate: { lastExecution: Date.now() }
        };
      },
    });

    // Method 1: Find and execute manually (this works reliably)
    const tool = agent.tool.find("execution_test_tool");
    expect(tool).toBeDefined();

    const mockContext = createMockToolContext<UserProfile, OrderData>(await agent.getContext(), {});
    const result1 = await tool!.handler(mockContext, { input: "test1" });
    expect((result1 as ToolResult<string>).data).toBe("Executed with: test1");

    // Method 2: Verify tool is registered and available
    expect(agent.tool.isRegistered("execution_test_tool")).toBe(true);
    const availableTools = agent.tool.getAvailable();
    expect(availableTools.some(t => t.id === "execution_test_tool")).toBe(true);

    // Method 3: Test direct handler execution with different args
    const result2 = await tool!.handler(mockContext, { input: "test2" });
    expect((result2 as ToolResult<string>).data).toBe("Executed with: test2");
  });

  test("should support bulk tool operations", () => {
    const agent = createToolTestAgent();

    // Method 8: Register multiple tools at once
    const tools = agent.tool.registerMany([
      {
        id: "bulk_tool_1",
        handler: async () => "Result 1"
      },
      {
        id: "bulk_tool_2",
        handler: async () => "Result 2"
      },
      {
        id: "bulk_tool_3",
        handler: async () => "Result 3"
      }
    ]);

    expect(tools).toHaveLength(3);
    expect(agent.tool.isRegistered("bulk_tool_1")).toBe(true);
    expect(agent.tool.isRegistered("bulk_tool_2")).toBe(true);
    expect(agent.tool.isRegistered("bulk_tool_3")).toBe(true);

    // Test getting all available tools
    const available = agent.tool.getAvailable();
    expect(available.length).toBeGreaterThanOrEqual(3);
  });

  test("should maintain backward compatibility with createTool", () => {
    const agent = createToolTestAgent();

    // Legacy method should still work
    const legacyTool: Tool<UserProfile, OrderData, string> = {
      id: "legacy_tool",
      description: "Legacy tool format",
      parameters: { type: "object", properties: {} },
      handler: (context) => ({
        data: `Legacy: ${context.context?.name}`,
      }),
    };

    agent.createTool(legacyTool);

    const tools = agent.getTools();
    const addedTool = tools.find(t => t.id === "legacy_tool");
    expect(addedTool).toBeDefined();
    expect(addedTool?.description).toBe("Legacy tool format");
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

describe("ToolManager Integration Tests", () => {
  test("should create and use ToolManager through agent", () => {
    const agent = createToolTestAgent();

    // Test that agent has tool property
    expect(agent.tool).toBeDefined();
    expect(typeof agent.tool.create).toBe("function");
    expect(typeof agent.tool.register).toBe("function");
    expect(typeof agent.addTool).toBe("function");
  });

  test("should create tools using ToolManager", () => {
    const agent = createToolTestAgent();

    const tool = agent.tool.create({
      id: "toolmanager_test",
      description: "Test tool created via ToolManager",
      handler: async (context) => {
        return `Hello ${context.context?.name || "user"}`;
      },
    });

    expect(tool.id).toBe("toolmanager_test");
    expect(tool.description).toBe("Test tool created via ToolManager");
    expect(typeof tool.handler).toBe("function");
  });

  test("should register tools using ToolManager", () => {
    const agent = createToolTestAgent();

    const tool = agent.tool.register({
      id: "registered_test",
      description: "Registered test tool",
      handler: async (context) => {
        return `Registered for ${context.context?.name}`;
      },
    });

    expect(agent.tool.isRegistered("registered_test")).toBe(true);
    expect(agent.tool.getRegisteredTool("registered_test")).toBe(tool);
  });

  test("should use addTool method on agent", () => {
    const agent = createToolTestAgent();

    agent.addTool({
      id: "agent_added_tool",
      description: "Tool added via addTool method",
      handler: async (context) => {
        return `Added to agent: ${context.context?.userId}`;
      },
    });

    // Tool should be available in agent's tools
    const agentTools = agent.getTools();
    const addedTool = agentTools.find(t => t.id === "agent_added_tool");
    expect(addedTool).toBeDefined();
    expect(addedTool?.description).toBe("Tool added via addTool method");
  });

  test("should create pattern helper tools", () => {
    const agent = createToolTestAgent();

    // Test data enrichment tool
    const enrichmentTool = agent.tool.createDataEnrichment({
      id: "enrich_profile",
      fields: ["name", "email"],
      enricher: async (context, data) => ({
        name: `${data.name} (${context.preferences.theme} theme)`,
      }),
    });

    expect(enrichmentTool.id).toBe("enrich_profile");
    expect(enrichmentTool.name).toBe("Data Enrichment: enrich_profile");

    // Test validation tool
    const validationTool = agent.tool.createValidation({
      id: "validate_email",
      fields: ["email"],
      validator: async (context, data) => ({
        valid: data.email?.includes("@") || false,
        errors: [],
        warnings: [],
      }),
    });

    expect(validationTool.id).toBe("validate_email");
    expect(validationTool.name).toBe("Validation: validate_email");

    // Test computation tool
    const computeTool = agent.tool.createComputation({
      id: "compute_score",
      inputs: ["rawOrder"],
      compute: async (context, inputs) => {
        const order = inputs.rawOrder as OrderData;
        return order ? order.total * 1.1 : 0; // Add 10% markup
      },
    });

    expect(computeTool.id).toBe("compute_score");
    expect(computeTool.name).toBe("Computation: compute_score");
  });

  test("should find tools across scopes", () => {
    const agent = createToolTestAgent();

    // Register a tool
    agent.tool.register({
      id: "registry_tool",
      handler: async () => "registry result",
    });

    // Add a tool to agent
    agent.addTool({
      id: "agent_tool",
      handler: async () => "agent result",
    });

    // Test finding tools
    expect(agent.tool.find("registry_tool")).toBeDefined();
    expect(agent.tool.find("agent_tool")).toBeDefined();
    expect(agent.tool.find("nonexistent")).toBeUndefined();

    // Test getting available tools
    const available = agent.tool.getAvailable();
    expect(available.length).toBeGreaterThanOrEqual(2);
    expect(available.some(t => t.id === "registry_tool")).toBe(true);
    expect(available.some(t => t.id === "agent_tool")).toBe(true);
  });
});

describe("ToolManager Performance Tests", () => {
  test("should handle large number of registered tools efficiently", () => {
    const agent = createToolTestAgent();
    const toolCount = 1000;

    // Register many tools
    const startTime = Date.now();
    for (let i = 0; i < toolCount; i++) {
      agent.tool.register({
        id: `perf_tool_${i}`,
        handler: async () => `result_${i}`,
      });
    }
    const registrationTime = Date.now() - startTime;

    // Test lookup performance
    const lookupStart = Date.now();
    for (let i = 0; i < 100; i++) {
      const randomId = `perf_tool_${Math.floor(Math.random() * toolCount)}`;
      agent.tool.find(randomId);
    }
    const lookupTime = Date.now() - lookupStart;

    // Performance assertions (generous limits for CI environments)
    expect(registrationTime).toBeLessThan(5000); // 5 seconds for 1000 registrations
    expect(lookupTime).toBeLessThan(1000); // 1 second for 100 lookups
    expect(agent.tool.getRegisteredIds()).toHaveLength(toolCount);
  });

  test("should efficiently get available tools with many scopes", () => {
    const agent = createToolTestAgent();

    // Register tools in registry
    for (let i = 0; i < 50; i++) {
      agent.tool.register({
        id: `registry_${i}`,
        handler: async () => `registry_${i}`,
      });
    }

    // Add tools to agent
    for (let i = 0; i < 50; i++) {
      agent.addTool({
        id: `agent_${i}`,
        handler: async () => `agent_${i}`,
      });
    }

    const startTime = Date.now();
    const available = agent.tool.getAvailable();
    const getAvailableTime = Date.now() - startTime;

    expect(getAvailableTime).toBeLessThan(100); // Should be very fast
    expect(available.length).toBeGreaterThanOrEqual(100);
  });

  test("should handle memory cleanup efficiently", () => {
    const agent = createToolTestAgent();
    const initialMemory = process.memoryUsage().heapUsed;

    // Create and register many tools
    for (let i = 0; i < 500; i++) {
      agent.tool.register({
        id: `memory_tool_${i}`,
        handler: async () => `result_${i}`,
      });
    }

    // Clear registry
    agent.tool.clearRegistry();

    // Force garbage collection if available
    if (global.gc) {
      global.gc();
    }

    const finalMemory = process.memoryUsage().heapUsed;
    const memoryIncrease = finalMemory - initialMemory;

    // Memory should not increase significantly after cleanup
    expect(memoryIncrease).toBeLessThan(50 * 1024 * 1024); // Less than 50MB increase
    expect(agent.tool.getRegisteredIds()).toHaveLength(0);
  });
});

describe("Complex Tool Scenarios", () => {
  test("should handle data transformation tools", async () => {
    const agent = createToolTestAgent();

    const transformTool = agent.tool.create({
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
      handler: (_toolContext, args) => {
        const rawOrder = args?.rawOrder as OrderData;
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
    });

    const result = await executeToolForTest(
      transformTool,
      {
        rawOrder: {
          product: "Widget",
          qty: 5,
          cost: 10.99,
        } as OrderData,
      }
    );

    expect((result as ToolResult<string>).data).toBe("Order data transformed");
    expect(((result as ToolResult<string>).dataUpdate as Partial<OrderData>)?.total).toBe(54.95);
    expect(((result as ToolResult<string>).dataUpdate as Partial<OrderData>)?.items?.[0].name).toBe(
      "Widget"
    );
  });

  test("should handle API integration tools", async () => {
    const agent = createToolTestAgent();

    const apiTool = agent.tool.create({
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
      handler: async (_toolContext, args) => {
        const endpoint = args?.endpoint as string;
        const method = args?.method as string;
        const payload = args?.payload as Record<string, unknown> | undefined;

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
    });

    const result = await executeToolForTest(
      apiTool,
      {
        endpoint: "/users",
        method: "POST",
        payload: { name: "New User", email: "user@example.com" },
      }
    );

    expect((result as ToolResult<string>).data).toBe("API POST /users completed");
    expect(
      ((result as ToolResult<string>).dataUpdate as any)?.apiResponse?.status
    ).toBe(200);
  });

  test("should handle conditional tool logic", async () => {
    const agent = createToolTestAgent();

    const conditionalTool = agent.tool.create({
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
      handler: (toolContext, args) => {
        const action = args?.action as string;
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
    });

    const context = await agent.getContext();

    // Test with notifications enabled
    const result1 = await executeToolForTest(
      conditionalTool,
      { action: "send_notification" },
      context
    );
    expect((result1 as ToolResult<string>).data).toBe("Notification sent");

    // Test theme application
    const result2 = await executeToolForTest(
      conditionalTool,
      { action: "apply_theme" },
      context
    );
    expect((result2 as ToolResult<string>).data).toBe("Applied light theme");
  });
});
