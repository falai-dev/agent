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
  createSession,
  MemoryAdapter,
  type Tool,
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

interface PaymentData {
  orderId: string;
  paymentMethod: "credit_card" | "paypal" | "bank_transfer";
  amount: number;
  confirmed: boolean;
}

// Tools for order processing
const createOrder: Tool<unknown, [], string, OrderData> = {
  id: "create_order",
  description: "Create a new order from the collected order data",
  parameters: {
    type: "object",
    properties: {},
  },
  handler: ({ data }) => {
    const orderId = `ORD-${Date.now()}`;
    const orderData = data as Partial<OrderData>;
    console.log(`Creating order ${orderId} for ${orderData?.customerName}`);

    return {
      data: `Order ${orderId} created successfully!`,
      dataUpdate: {
        orderId,
      },
    };
  },
};

const processPayment: Tool<unknown, [], string, PaymentData> = {
  id: "process_payment",
  description: "Process payment for an order",
  parameters: {
    type: "object",
    properties: {},
  },
  handler: ({ data }) => {
    const paymentData = data as Partial<PaymentData>;
    console.log(`Processing payment for order ${paymentData?.orderId}`);

    // Simulate payment processing
    const success = Math.random() > 0.1; // 90% success rate

    if (success) {
      return {
        data: `Payment processed successfully! Order ${paymentData?.orderId} is now confirmed.`,
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

// Create agent with persistence
const agent = new Agent({
  name: "OrderBot",
  description:
    "A bot that handles multi-step order processing with session management",
  provider: new GeminiProvider({
    apiKey: process.env.GEMINI_API_KEY!,
    model: "models/gemini-2.5-flash",
  }),
  persistence: {
    adapter: new MemoryAdapter(), // In production, use RedisAdapter, PrismaAdapter, etc.
  },
});

// Order collection route with sequential steps
agent.createRoute<OrderData>({
  title: "Product Order",
  description: "Collect order details and create an order",
  schema: {
    type: "object",
    properties: {
      customerName: { type: "string" },
      productType: { type: "string", enum: ["laptop", "phone", "tablet"] },
      budget: { type: "number", minimum: 100 },
      preferredColor: { type: "string" },
      urgentDelivery: { type: "boolean" },
      orderId: { type: "string" },
    },
    required: ["customerName", "productType", "budget"],
  },
  // Sequential steps for order collection
  steps: [
    {
      id: "ask_name",
      description: "Ask for customer name",
      prompt: "Hi! I'd like to help you place an order. What's your name?",
      collect: ["customerName"],
      skipIf: (data: Partial<OrderData>) => !!data.customerName,
    },
    {
      id: "ask_product",
      description: "Ask for product type",
      prompt: "What would you like to order? (laptop, phone, or tablet)",
      collect: ["productType"],
      requires: ["customerName"],
      skipIf: (data: Partial<OrderData>) => !!data.productType,
    },
    {
      id: "ask_budget",
      description: "Ask for budget",
      prompt: "What's your budget for this purchase?",
      collect: ["budget"],
      requires: ["customerName", "productType"],
      skipIf: (data: Partial<OrderData>) => data.budget !== undefined,
    },
    {
      id: "ask_color",
      description: "Ask for preferred color",
      prompt: "Do you have a preferred color?",
      collect: ["preferredColor"],
      requires: ["customerName", "productType", "budget"],
      skipIf: (data: Partial<OrderData>) => !!data.preferredColor,
    },
    {
      id: "ask_urgent",
      description: "Ask about urgent delivery",
      prompt: "Do you need urgent delivery?",
      collect: ["urgentDelivery"],
      requires: ["customerName", "productType", "budget"],
      skipIf: (data: Partial<OrderData>) => data.urgentDelivery !== undefined,
    },
    {
      id: "create_order",
      description: "Create the order",
      prompt: "Great! Let me create your order.",
      tools: [createOrder],
      requires: ["customerName", "productType", "budget"],
    },
  ],
  onComplete: {
    nextStep: "Payment Processing",
    condition: "Order has been created successfully",
  },
});

// Payment route with sequential steps
agent.createRoute<PaymentData>({
  title: "Payment Processing",
  description: "Process payment for an order",
  schema: {
    type: "object",
    properties: {
      orderId: { type: "string" },
      paymentMethod: {
        type: "string",
        enum: ["credit_card", "paypal", "bank_transfer"],
      },
      amount: { type: "number" },
      confirmed: { type: "boolean" },
    },
    required: ["orderId", "paymentMethod", "amount"],
  },
  // Sequential steps for payment processing
  steps: [
    {
      id: "ask_payment_method",
      description: "Ask for payment method",
      prompt:
        "Now let's process payment for your order. What payment method would you prefer?",
      collect: ["paymentMethod"],
      skipIf: (data: Partial<PaymentData>) => !!data.paymentMethod,
    },
    {
      id: "ask_amount",
      description: "Ask for payment amount",
      prompt: "What's the payment amount?",
      collect: ["amount"],
      requires: ["paymentMethod"],
      skipIf: (data: Partial<PaymentData>) => data.amount !== undefined,
    },
    {
      id: "process_payment",
      description: "Process the payment",
      prompt: "Processing your payment...",
      tools: [processPayment],
      requires: ["orderId", "paymentMethod", "amount"],
    },
  ],
  onComplete: "Order Complete", // End conversation when payment is complete
});

// Demonstration of session management across multiple turns
async function demonstrateSessionManagement() {
  console.log("=== Session Management Demo ===\n");

  // Turn 1: Start order process
  console.log("Turn 1: Starting order process");
  console.log("User: Hi, I'm Alice and I want to buy a laptop");

  const response1 = await agent.respond({
    history: [
      {
        role: "user",
        content: "Hi, I'm Alice and I want to buy a laptop",
        name: "Alice",
      },
    ],
  });

  console.log("Bot:", response1.message);
  console.log(
    "Session data:",
    JSON.stringify(
      response1.session?.data as Partial<OrderData | PaymentData>,
      null,
      2
    )
  );
  console.log("Current route:", response1.session?.currentRoute?.title);
  console.log("Current step:", response1.session?.currentStep?.id);
  console.log();

  // Turn 2: Provide budget
  console.log("Turn 2: Providing budget");
  console.log("User: My budget is $1500");

  const response2 = await agent.respond({
    history: [
      {
        role: "user",
        content: "Hi, I'm Alice and I want to buy a laptop",
        name: "Alice",
      },
      {
        role: "assistant",
        content: response1.message,
      },
      {
        role: "user",
        content: "My budget is $1500",
        name: "Alice",
      },
    ],
    session: response1.session,
  });

  console.log("Bot:", response2.message);
  console.log(
    "Session data:",
    JSON.stringify(
      response2.session?.data as Partial<OrderData | PaymentData>,
      null,
      2
    )
  );
  console.log("Current route:", response2.session?.currentRoute?.title);
  console.log("Current step:", response2.session?.currentStep?.id);
  console.log();

  // Turn 3: Complete order details and trigger transition
  console.log("Turn 3: Completing order and transitioning to payment");
  console.log("User: I want black color and urgent delivery please");

  const response3 = await agent.respond({
    history: [
      {
        role: "user",
        content: "Hi, I'm Alice and I want to buy a laptop",
        name: "Alice",
      },
      {
        role: "assistant",
        content: response1.message,
      },
      {
        role: "user",
        content: "My budget is $1500",
        name: "Alice",
      },
      {
        role: "assistant",
        content: response2.message,
      },
      {
        role: "user",
        content: "I want black color and urgent delivery please",
        name: "Alice",
      },
    ],
    session: response2.session,
  });

  console.log("Bot:", response3.message);
  console.log(
    "Session data:",
    JSON.stringify(
      response3.session?.data as Partial<OrderData | PaymentData>,
      null,
      2
    )
  );
  console.log("Current route:", response3.session?.currentRoute?.title);
  console.log("Current step:", response3.session?.currentStep?.id);
  console.log("Route complete:", response3.isRouteComplete);
  console.log();

  // Turn 4: Process payment in new route
  console.log("Turn 4: Processing payment in transitioned route");
  console.log("User: I'll pay with credit card, amount is $1599");

  const response4 = await agent.respond({
    history: [
      {
        role: "user",
        content: "Hi, I'm Alice and I want to buy a laptop",
        name: "Alice",
      },
      {
        role: "assistant",
        content: response1.message,
      },
      {
        role: "user",
        content: "My budget is $1500",
        name: "Alice",
      },
      {
        role: "assistant",
        content: response2.message,
      },
      {
        role: "user",
        content: "I want black color and urgent delivery please",
        name: "Alice",
      },
      {
        role: "assistant",
        content: response3.message,
      },
      {
        role: "user",
        content: "I'll pay with credit card, amount is $1599",
        name: "Alice",
      },
    ],
    session: response3.session,
  });

  console.log("Bot:", response4.message);
  console.log(
    "Session data:",
    JSON.stringify(
      response4.session?.data as Partial<OrderData | PaymentData>,
      null,
      2
    )
  );
  console.log("Current route:", response4.session?.currentRoute?.title);
  console.log("Current step:", response4.session?.currentStep?.id);
  console.log("Route complete:", response4.isRouteComplete);
}

// Demonstrate session persistence and restoration
async function demonstrateSessionPersistence() {
  console.log("\n=== Session Persistence Demo ===\n");

  // Create a session manually for demonstration
  const sessionId = "demo-session-123";
  const initialSession = createSession<OrderData>(sessionId, {
    createdAt: new Date(),
    userId: "user_alice",
  });

  console.log("Created session:", sessionId);

  // Use the session in conversation
  const response1 = await agent.respond({
    history: [
      {
        role: "user",
        content: "I want to buy a phone for $800",
        name: "Alice",
      },
    ],
    session: initialSession,
  });

  console.log("After first interaction:");
  console.log(
    "Session data:",
    JSON.stringify(
      response1.session?.data as Partial<OrderData | PaymentData>,
      null,
      2
    )
  );

  // Simulate session persistence (in real app, this would auto-save)
  if (agent.hasPersistence() && response1.session?.id) {
    await agent
      .getPersistenceManager()
      ?.saveSessionState(response1.session.id, response1.session);
    console.log("Session saved to persistence");
  }

  // Simulate restoring session later (e.g., user returns after some time)
  console.log("\nRestoring session...");
  let restoredSession;
  if (agent.hasPersistence() && sessionId) {
    restoredSession = await agent
      .getPersistenceManager()
      ?.loadSessionState(sessionId);
    console.log("Session restored from persistence");
    console.log(
      "Restored data:",
      JSON.stringify(restoredSession?.data, null, 2)
    );
  }

  // Continue conversation with restored session
  if (restoredSession) {
    const response2 = await agent.respond({
      history: [
        {
          role: "user",
          content: "I want to buy a phone for $800",
          name: "Alice",
        },
        {
          role: "assistant",
          content: response1.message,
        },
        {
          role: "user",
          content: "Actually, make it urgent delivery",
          name: "Alice",
        },
      ],
      session: restoredSession,
    });

    console.log("\nAfter continuing with restored session:");
    console.log(
      "Session data:",
      JSON.stringify(response2.session?.data, null, 2)
    );
  }
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
