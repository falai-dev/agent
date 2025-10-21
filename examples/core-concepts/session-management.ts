/**
 * Session Management Example
 *
 * This example demonstrates how to manage conversation state across multiple turns
 * using session management, persistence, and state restoration.
 *
 * Key concepts:
 * - Session state management
 * - Multi-turn conversations
 * - Data persistence across turns
 * - Session restoration
 * - Route transitions with session state
 */

import {
  Agent,
  GeminiProvider,
  MemoryAdapter,
  type Tool,
  ValidationError,
} from "../../src/index";

// Define data types for our multi-step process
interface OrderData {
  customerName: string;
  productType: "laptop" | "phone" | "tablet";
  budget: number;
  preferredColor?: string;
  urgentDelivery: boolean;
  orderId?: string;
}

interface OrderContext {
  userId: string;
  userName: string;
  isVip: boolean;
}

interface PaymentData {
  orderId?: string; // Make this optional to match OrderData
  paymentMethod: "credit_card" | "paypal" | "bank_transfer";
  amount: number;
  confirmed: boolean;
}

// Tools for order processing - using unified Tool interface
const createOrderTool: Tool<unknown, UnifiedOrderData> = {
  id: "create_order",
  description: "Create a new order from the collected order data",
  parameters: {
    type: "object",
    properties: {},
  },
  handler: (context, args) => {
    const orderId = `ORD-${Date.now()}`;
    console.log(`Creating order ${orderId} for ${context.data?.customerName}`);

    return {
      data: `Order ${orderId} created successfully!`,
      dataUpdate: {
        orderId,
      },
    };
  },
};

const processPaymentTool: Tool<unknown, UnifiedOrderData> = {
  id: "process_payment",
  description: "Process payment for an order",
  parameters: {
    type: "object",
    properties: {},
  },
  handler: (context, args) => {
    console.log(`Processing payment for order ${context.data?.orderId}`);

    // Simulate payment processing
    const success = Math.random() > 0.1; // 90% success rate

    if (success) {
      return {
        data: `Payment processed successfully! Order ${context.data?.orderId} is now confirmed.`,
        dataUpdate: {
          confirmed: true,
        },
      };
    } else {
      return {
        data: "Payment failed. Please try again or contact support.",
        dataUpdate: {
          confirmed: false,
        },
      };
    }
  },
};

// Define unified data schema for all order-related interactions
interface UnifiedOrderData extends OrderData, PaymentData {}

const orderSchema = {
  type: "object",
  properties: {
    // Order fields
    customerName: { type: "string" },
    productType: { type: "string", enum: ["laptop", "phone", "tablet"] },
    budget: { type: "number", minimum: 100 },
    preferredColor: { type: "string" },
    urgentDelivery: { type: "boolean" },
    orderId: { type: "string" },
    // Payment fields
    paymentMethod: {
      type: "string",
      enum: ["credit_card", "paypal", "bank_transfer"],
    },
    amount: { type: "number" },
    confirmed: { type: "boolean" },
  },
};

// Create agent with persistence and agent-level schema
const agent = new Agent<unknown, UnifiedOrderData>({
  name: "OrderBot",
  description:
    "A bot that handles multi-step order processing with session management",
  provider: new GeminiProvider({
    apiKey: process.env.GEMINI_API_KEY!,
    model: "models/gemini-2.5-flash",
  }),
  // NEW: Agent-level schema
  schema: orderSchema,
  persistence: {
    adapter: new MemoryAdapter(), // In production, use RedisAdapter, PrismaAdapter, etc.
  },
});

// Demonstrate different tool registration patterns

// Method 1: Register tools for ID-based reference in steps
agent.tool.register(createOrderTool);
agent.tool.register(processPaymentTool);

// Method 2: Create specialized validation tool
const orderValidationTool = agent.tool.createValidation({
  id: "validate_order",
  fields: ["customerName", "productType", "budget"] as const,
  validator: async (context, data) => {
    const errors: ValidationError[] = [];
    if (!data.customerName || data.customerName.length < 2) {
      errors.push({ 
        field: "customerName", 
        value: data.customerName,
        message: "Customer name must be at least 2 characters",
        schemaPath: "customerName"
      });
    }
    if (!data.budget || data.budget < 100) {
      errors.push({ 
        field: "budget", 
        value: data.budget,
        message: "Budget must be at least $100",
        schemaPath: "budget"
      });
    }
    return {
      valid: errors.length === 0,
      errors,
      warnings: [],
    };
  },
});

// Method 3: Create data enrichment tool
const orderEnrichmentTool = agent.tool.createDataEnrichment({
  id: "enrich_order",
  fields: ["productType", "budget"] as const,
  enricher: async (context, data) => {
    // Enrich with fields that exist in UnifiedOrderData
    const urgentDelivery = data.budget > 1000; // Premium orders get urgent delivery
    const preferredColor = data.productType === "laptop" ? "silver" : "black";
    
    return {
      urgentDelivery,
      preferredColor,
    };
  },
});

// Order collection route with sequential steps
agent.createRoute({
  title: "Product Order",
  description: "Collect order details and create an order",
  // NEW: Required fields for route completion
  requiredFields: ["customerName", "productType", "budget"],
  // NEW: Optional fields that enhance the experience
  optionalFields: ["preferredColor", "urgentDelivery", "orderId"],
  // Sequential steps for order collection
  steps: [
    {
      id: "ask_name",
      description: "Ask for customer name",
      prompt: "Hi! I'd like to help you place an order. What's your name?",
      collect: ["customerName"],
      skipIf: (data: Partial<UnifiedOrderData>) => !!data.customerName,
    },
    {
      id: "ask_product",
      description: "Ask for product type",
      prompt: "What would you like to order? (laptop, phone, or tablet)",
      collect: ["productType"],
      requires: ["customerName"],
      skipIf: (data: Partial<UnifiedOrderData>) => !!data.productType,
    },
    {
      id: "ask_budget",
      description: "Ask for budget",
      prompt: "What's your budget for this purchase?",
      collect: ["budget"],
      requires: ["customerName", "productType"],
      skipIf: (data: Partial<UnifiedOrderData>) => data.budget !== undefined,
    },
    {
      id: "ask_color",
      description: "Ask for preferred color",
      prompt: "Do you have a preferred color?",
      collect: ["preferredColor"],
      requires: ["customerName", "productType", "budget"],
      skipIf: (data: Partial<UnifiedOrderData>) => !!data.preferredColor,
    },
    {
      id: "ask_urgent",
      description: "Ask about urgent delivery",
      prompt: "Do you need urgent delivery?",
      collect: ["urgentDelivery"],
      requires: ["customerName", "productType", "budget"],
      skipIf: (data: Partial<UnifiedOrderData>) => data.urgentDelivery !== undefined,
    },
    {
      id: "create_order",
      description: "Create the order",
      prompt: "Great! Let me create your order.",
      tools: ["create_order"], // Reference by ID
      requires: ["customerName", "productType", "budget"],
    },
  ],
  onComplete: {
    nextStep: "Payment Processing",
    condition: "Order has been created successfully",
  },
});

// Payment route with sequential steps
agent.createRoute({
  title: "Payment Processing",
  description: "Process payment for an order",
  // NEW: Required fields for route completion
  requiredFields: ["orderId", "paymentMethod", "amount"],
  // NEW: Optional fields
  optionalFields: ["confirmed"],
  // Sequential steps for payment processing
  steps: [
    {
      id: "ask_payment_method",
      description: "Ask for payment method",
      prompt:
        "Now let's process payment for your order. What payment method would you prefer?",
      collect: ["paymentMethod"],
      skipIf: (data: Partial<UnifiedOrderData>) => !!data.paymentMethod,
    },
    {
      id: "ask_amount",
      description: "Ask for payment amount",
      prompt: "What's the payment amount?",
      collect: ["amount"],
      requires: ["paymentMethod"],
      skipIf: (data: Partial<UnifiedOrderData>) => data.amount !== undefined,
    },
    {
      id: "process_payment",
      description: "Process the payment",
      prompt: "Processing your payment...",
      tools: ["process_payment"], // Reference by ID
      requires: ["orderId", "paymentMethod", "amount"],
    },
  ],
  onComplete: "Order Complete", // End conversation when payment is complete
});

// Demonstration of automatic session management
async function demonstrateSessionManagement() {
  console.log("=== Automatic Session Management Demo ===\n");

  // Create agent with automatic session management
  const sessionAgent = new Agent<unknown, UnifiedOrderData>({
    name: "OrderBot",
    description: "A bot that handles multi-step order processing",
    provider: new GeminiProvider({
      apiKey: process.env.GEMINI_API_KEY!,
      model: "models/gemini-2.5-flash",
    }),
    // NEW: Agent-level schema
    schema: orderSchema,
    persistence: {
      adapter: new MemoryAdapter(),
    },
    sessionId: "user-alice-123", // Automatically creates/loads this session
  });

  // Copy routes to the session agent
  agent.getRoutes().forEach(route => {
    sessionAgent.createRoute(route);
  });

  // Turn 1: Start order process - simple message API
  console.log("Turn 1: Starting order process");
  console.log("User: Hi, I'm Alice and I want to buy a laptop");

  const response1 = await sessionAgent.chat("Hi, I'm Alice and I want to buy a laptop");

  console.log("Bot:", response1.message);
  console.log("Session ID:", sessionAgent.session.id);
  console.log("Session data:", JSON.stringify(sessionAgent.session.getData(), null, 2));
  console.log("History length:", sessionAgent.session.getHistory().length);
  console.log();

  // Turn 2: Provide budget - session automatically maintained
  console.log("Turn 2: Providing budget");
  console.log("User: My budget is $1500");

  const response2 = await sessionAgent.chat("My budget is $1500");

  console.log("Bot:", response2.message);
  console.log("Session data:", JSON.stringify(sessionAgent.session.getData(), null, 2));
  console.log("History length:", sessionAgent.session.getHistory().length);
  console.log();

  // Turn 3: Complete order details - session automatically updated
  console.log("Turn 3: Completing order and transitioning to payment");
  console.log("User: I want black color and urgent delivery please");

  const response3 = await sessionAgent.chat("I want black color and urgent delivery please");

  console.log("Bot:", response3.message);
  console.log("Session data:", JSON.stringify(sessionAgent.session.getData(), null, 2));
  console.log("Route complete:", response3.isRouteComplete);
  console.log("History length:", sessionAgent.session.getHistory().length);
  console.log();

  // Turn 4: Process payment - automatic route transition
  console.log("Turn 4: Processing payment in transitioned route");
  console.log("User: I'll pay with credit card, amount is $1599");

  const response4 = await sessionAgent.chat("I'll pay with credit card, amount is $1599");

  console.log("Bot:", response4.message);
  console.log("Session data:", JSON.stringify(sessionAgent.session.getData(), null, 2));
  console.log("Route complete:", response4.isRouteComplete);
  console.log("Final history length:", sessionAgent.session.getHistory().length);
}

// Demonstrate automatic session persistence and restoration
async function demonstrateSessionPersistence() {
  console.log("\n=== Automatic Session Persistence Demo ===\n");

  // Create agent with specific sessionId for demonstration
  const sessionId = "demo-session-456";
  const persistentAgent = new Agent<OrderContext, UnifiedOrderData>({
    name: "Order Assistant",
    description: "Help customers place orders with automatic persistence",
    provider: new GeminiProvider({
      apiKey: process.env.GEMINI_API_KEY!,
      model: "models/gemini-2.5-flash",
    }),
    context: {
      userId: "user_alice",
      userName: "Alice",
      isVip: false,
    },
    // NEW: Agent-level schema
    schema: orderSchema,
    persistence: {
      adapter: new MemoryAdapter(),
      autoSave: true, // Automatic persistence
    },
    sessionId, // Agent automatically loads or creates this session
  });

  // Copy routes to the persistent agent
  agent.getRoutes().forEach(route => {
    persistentAgent.createRoute(route);
  });

  console.log("Session ready:", persistentAgent.session.id);

  // Start conversation - session automatically managed
  const response1 = await persistentAgent.chat("I want to buy a phone for $800");

  console.log("After first interaction:");
  console.log("🤖 Agent:", response1.message);
  console.log("Session data:", JSON.stringify(persistentAgent.session.getData(), null, 2));
  console.log("History length:", persistentAgent.session.getHistory().length);
  console.log("Session automatically saved to persistence ✓");

  // Simulate server restart - create new agent instance with same sessionId
  console.log("\n🔄 Simulating server restart - creating new agent instance...");

  const restoredAgent = new Agent<OrderContext, UnifiedOrderData>({
    name: "Order Assistant",
    provider: new GeminiProvider({
      apiKey: process.env.GEMINI_API_KEY!,
      model: "models/gemini-2.5-flash",
    }),
    context: {
      userId: "user_alice",
      userName: "Alice",
      isVip: false,
    },
    // NEW: Agent-level schema
    schema: orderSchema,
    persistence: {
      adapter: new MemoryAdapter(), // Same adapter instance for demo
      autoSave: true,
    },
    sessionId, // Same sessionId - automatically loads existing session
  });

  // Copy routes to the restored agent
  agent.getRoutes().forEach(route => {
    restoredAgent.createRoute(route);
  });

  console.log("Session automatically restored:");
  console.log("- Session ID:", restoredAgent.session.id);
  console.log("- History length:", restoredAgent.session.getHistory().length);
  console.log("- Restored data:", JSON.stringify(restoredAgent.session.getData(), null, 2));

  // Continue conversation seamlessly
  const response2 = await restoredAgent.chat("Actually, make it urgent delivery");

  console.log("\nAfter continuing with restored session:");
  console.log("🤖 Agent:", response2.message);
  console.log("Session data:", JSON.stringify(restoredAgent.session.getData(), null, 2));
  console.log("History length:", restoredAgent.session.getHistory().length);
  console.log("Session automatically saved again ✓");
}

// Run demonstrations
async function main() {
  try {
    await demonstrateSessionManagement();
    await demonstrateSessionPersistence();
  } catch (error) {
    console.error("Error:", error);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}
