/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
/**
 * Example: Using Redis for Persistence with Session Step
 *
 * Fast, in-memory persistence perfect for:
 * - High-throughput applications
 * - Session caching with collected data
 * - Real-time chat applications
 * - Temporary conversation storage
 */

import {
  Agent,
  GeminiProvider,
  RedisAdapter,
  END_ROUTE,
  MessageRole,
  type HistoryItem,
} from "../../src";
// @ts-expect-error - Redis is not typed
import Redis from "ioredis";

/**
 * Setup Steps:
 *
 * 1. Install Redis and client:
 *    brew install redis (macOS) or apt-get install redis (Linux)
 *    npm install ioredis
 *
 * 2. Start Redis:
 *    redis-server
 *
 * 3. Run this example
 */

interface ChatContext {
  userId: string;
  userName: string;
  chatType: "support" | "sales" | "general";
}

interface SupportTicketData {
  issue: string;
  category: "technical" | "billing" | "account" | "other";
  priority: "low" | "medium" | "high";
  description: string;
}

interface QuickChatData {
  topic: string;
  sentiment: "positive" | "neutral" | "negative";
}

interface OrderData {
  productId: string;
  quantity: number;
  shippingAddress: string;
}

async function example() {
  // Initialize Redis client

  const redis = new Redis();

  const userId = "user_123";

  // Define support ticket schema
  const supportTicketSchema = {
    type: "object",
    properties: {
      issue: { type: "string" },
      category: { type: "string", enum: ["technical", "billing", "account", "other"] },
      priority: { type: "string", enum: ["low", "medium", "high"] },
      description: { type: "string" },
    },
    required: ["issue", "category", "priority", "description"],
  };

  // Create agent with Redis persistence
  const agent = new Agent<ChatContext, SupportTicketData>({
    name: "Support Assistant",
    description: "Fast, real-time support assistant",
    goal: "Help users resolve issues quickly",
    provider: new GeminiProvider({
      apiKey: process.env.GEMINI_API_KEY!,
      model: "models/gemini-2.5-flash",
    }),
    context: {
      userId,
      userName: "Alice",
      chatType: "support",
    },
    // NEW: Agent-level schema
    schema: supportTicketSchema,
    // ✨ Redis adapter with custom options
    persistence: {
      adapter: new RedisAdapter<ChatContext>({
        redis,
        keyPrefix: "support:", // Custom prefix
        sessionTTL: 24 * 60 * 60, // 24 hours
        messageTTL: 7 * 24 * 60 * 60, // 7 days
      }),
      autoSave: true, // Auto-save session step
      userId,
    },
  });

  // Create support ticket route with data collecting
  const ticketRoute = agent.createRoute({
    title: "Create Support Ticket",
    description: "Help user create and track support tickets",
    conditions: [
      "User needs help with an issue",
      "User wants to report a problem",
      "User mentions support, help, or issue",
    ],
    // NEW: Required fields for route completion
    requiredFields: ["issue", "category", "description"],
    // NEW: Optional fields that enhance the experience
    optionalFields: ["priority"],
  });

  // Step flow
  ticketRoute.initialStep
    .nextStep({
      prompt: "Ask what the issue is",
      collect: ["issue", "category"],
      skipIf: (data) => !!data.issue && !!data.category,
    })
    .nextStep({
      prompt: "Ask for priority",
      collect: ["priority"],
      skipIf: (data) => !!data.priority,
      requires: ["issue", "category"],
    })
    .nextStep({
      prompt: "Ask for detailed description",
      collect: ["description"],
      skipIf: (data) => !!data.description,
      requires: ["issue", "category"],
    })
    .nextStep({
      prompt: "Confirm and create ticket",
      requires: ["issue", "category", "description"],
    })
    .nextStep({ step: END_ROUTE });

  // Session is automatically managed by the agent with Redis persistence
  console.log("✨ Session ready:", agent.session.id);

  // Set initial data
  await agent.session.setData({ priority: "medium" });

  console.log("📊 Initial data:", agent.session.getData());

  // Turn 1: User provides issue
  console.log("\n--- Turn 1 ---");

  await agent.session.addMessage(
    "user",
    "I can't log into my account, it's a technical issue and it's urgent!",
    "Alice"
  );
  const history = agent.session.getHistory();

  const response1 = await agent.respond({
    history,
  });

  console.log("🤖 Agent:", response1.message);

  await agent.session.addMessage("assistant", response1.message);
  console.log("📊 Collected data:", agent.session.getData());

  // Turn 2: Provide more details
  console.log("\n--- Turn 2 ---");

  await agent.session.addMessage(
    "user",
    "I keep getting 'Invalid credentials' error even though I reset my password",
    "Alice"
  );

  const response2 = await agent.respond({
    history: agent.session.getHistory(),
  });

  console.log("🤖 Agent:", response2.message);
  console.log("📊 Collected data:", agent.session.getData());

  await agent.session.addMessage("assistant", response2.message);

  if (response2.isRouteComplete) {
    console.log("\n✅ Support ticket route complete!");
    await fileSupportTicket(agent.session.getData() as SupportTicketData);
  }

  // Demonstrate session recovery with new agent instance
  console.log("\n--- Session Recovery Example ---");
  const sessionId = agent.session.id;

  const recoveredAgent = new Agent<ChatContext, SupportTicketData>({
    name: "Support Assistant",
    provider: new GeminiProvider({
      apiKey: process.env.GEMINI_API_KEY!,
      model: "models/gemini-2.5-flash",
    }),
    context: {
      userId,
      userName: "Alice",
      chatType: "support",
    },
    // NEW: Agent-level schema (same as original agent)
    schema: supportTicketSchema,
    persistence: {
      adapter: new RedisAdapter<ChatContext>({
        redis,
        keyPrefix: "support:",
        sessionTTL: 24 * 60 * 60,
        messageTTL: 7 * 24 * 60 * 60,
      }),
      autoSave: true,
    },
    sessionId, // Same sessionId - will load existing session
  });

  // Recreate the same route on recovered agent
  recoveredAgent.createRoute({
    title: "Create Support Ticket",
    description: "Help user create and track support tickets",
    conditions: [
      "User needs help with an issue",
      "User wants to report a problem",
      "User mentions support, help, or issue",
    ],
    // NEW: Required fields for route completion
    requiredFields: ["issue", "category", "description"],
    // NEW: Optional fields that enhance the experience
    optionalFields: ["priority"],
  });

  console.log("📥 Recovered session:", {
    sessionId: recoveredAgent.session.id,
    historyLength: recoveredAgent.session.getHistory().length,
    data: recoveredAgent.session.getData(),
  });

  console.log("✅ Session recovery complete!");

  // Cleanup

  await redis.quit();
}

/**
 * Advanced Example: High-Throughput Chat with Session Step
 */
async function highThroughputExample() {
  const redis = new Redis();

  // Define quick chat schema
  const quickChatSchema = {
    type: "object",
    properties: {
      topic: { type: "string" },
      sentiment: { type: "string", enum: ["positive", "neutral", "negative"] },
    },
    required: ["topic", "sentiment"],
  };

  const agent = new Agent<unknown, QuickChatData>({
    name: "Chat Bot",
    description: "Fast chat responses",
    provider: new GeminiProvider({
      apiKey: process.env.GEMINI_API_KEY!,
      model: "models/gemini-2.5-flash",
    }),
    // NEW: Agent-level schema
    schema: quickChatSchema,
    persistence: {
      adapter: new RedisAdapter<unknown>({
        redis,
        keyPrefix: "chat:",
        sessionTTL: 60 * 60, // 1 hour for quick chats
      }),
      autoSave: true,
      userId: "user_456",
    },
  });

  // Simple chat route that extracts topic and sentiment
  const chatRoute = agent.createRoute({
    title: "General Chat",
    // NEW: Required fields for route completion
    requiredFields: ["topic", "sentiment"],
  });

  chatRoute.initialStep
    .nextStep({
      prompt: "Chat and extract topic/sentiment",
      collect: ["topic", "sentiment"],
    })
    .nextStep({ step: END_ROUTE });

  // Session is automatically managed by the agent
  console.log("✨ Session ready:", agent.session.id);

  // Quick chat interaction
  await agent.session.addMessage("user", "I'm loving the new features you added!", "User");

  const response = await agent.respond({
    history: agent.session.getHistory(),
  });

  console.log("🤖 Response:", response.message);
  console.log("📊 Data:", agent.session.getData());

  await agent.session.addMessage("assistant", response.message);

  if (response.isRouteComplete) {
    console.log("\n✅ Chat analytics route complete!");
    await logChatAnalytics(agent.session.getData() as QuickChatData);
  }

  console.log("💾 Session automatically saved to Redis!");

  await redis.quit();
}

/**
 * Session Recovery Example
 * Shows how to resume conversations from Redis
 */
async function sessionRecoveryExample() {
  const redis = new Redis();

  // Define order schema
  const orderSchema = {
    type: "object",
    properties: {
      productId: { type: "string" },
      quantity: { type: "number", minimum: 1 },
      shippingAddress: { type: "string" },
    },
    required: ["productId", "quantity", "shippingAddress"],
  };

  const agent = new Agent<unknown, OrderData>({
    name: "Order Assistant",
    provider: new GeminiProvider({
      apiKey: process.env.GEMINI_API_KEY!,
      model: "models/gemini-2.5-flash",
    }),
    // NEW: Agent-level schema
    schema: orderSchema,
    persistence: {
      adapter: new RedisAdapter<unknown>({ redis }),
      autoSave: true,
      userId: "user_789",
    },
  });

  const orderRoute = agent.createRoute({
    title: "Place Order",
    // NEW: Required fields for route completion
    requiredFields: ["productId", "quantity", "shippingAddress"],
  });

  orderRoute.initialStep
    .nextStep({
      prompt: "Ask what to order",
      collect: ["productId", "quantity"],
    })
    .nextStep({
      prompt: "Ask for shipping address",
      collect: ["shippingAddress"],
    })
    .nextStep({ step: END_ROUTE });

  // Session is automatically managed by the agent
  const sessionId = agent.session.id;
  console.log("✨ New order session:", sessionId);

  // First interaction
  await agent.session.addMessage("user", "I want to order product ABC123, 2 units", "User");

  const response1 = await agent.respond({
    history: agent.session.getHistory(),
  });

  console.log("🤖 Response:", response1.message);
  console.log("📊 Data so far:", agent.session.getData());

  await agent.session.addMessage("assistant", response1.message);

  // --- Simulate user disconnecting and reconnecting ---
  console.log("\n--- User Reconnects ---");

  // Create new agent instance with same sessionId (simulates reconnection)
  const reconnectedAgent = new Agent<unknown, OrderData>({
    name: "Order Assistant",
    provider: new GeminiProvider({
      apiKey: process.env.GEMINI_API_KEY!,
      model: "models/gemini-2.5-flash",
    }),
    // NEW: Agent-level schema (same as original agent)
    schema: orderSchema,
    persistence: {
      adapter: new RedisAdapter<unknown>({ redis }),
      autoSave: true,
    },
    sessionId, // Same sessionId - will load existing session
  });

  console.log("📥 Recovered session:", {
    sessionId: reconnectedAgent.session.id,
    historyLength: reconnectedAgent.session.getHistory().length,
    data: reconnectedAgent.session.getData(),
  });

  // Continue conversation
  await reconnectedAgent.session.addMessage("user", "Ship to 123 Main St, New York", "User");

  const response2 = await reconnectedAgent.respond({
    history: reconnectedAgent.session.getHistory(),
  });

  console.log("🤖 Response:", response2.message);
  console.log("📊 Final collected data:", reconnectedAgent.session.getData());

  await reconnectedAgent.session.addMessage("assistant", response2.message);

  if (response2.isRouteComplete) {
    console.log("\n✅ Order placement complete!");
    await processOrder(reconnectedAgent.session.getData() as OrderData);
  }

  console.log("✅ Order complete with recovered session!");

  await redis.quit();
}

/**
 * Mock function to file a support ticket.
 */
async function fileSupportTicket(data: SupportTicketData | undefined) {
  console.log("\n" + "=".repeat(60));
  console.log("🎫 Filing Support Ticket...");
  console.log("=".repeat(60));
  console.log("Ticket Details:", JSON.stringify(data, null, 2));
  console.log(
    `   - Filing ticket for issue: ${data?.issue} with priority: ${data?.priority}`
  );
  await new Promise((resolve) => setTimeout(resolve, 1000));
  console.log("✨ Ticket filed successfully!");
}

/**
 * Mock function to log chat analytics.
 * @param data - The chat data.
 */
async function logChatAnalytics(data: QuickChatData) {
  console.log("\n" + "=".repeat(60));
  console.log("📊 Logging Chat Analytics...");
  console.log("=".repeat(60));
  console.log("Chat Details:", JSON.stringify(data, null, 2));
  console.log(`   - Logging chat with topic: ${data.topic}`);
  await new Promise((resolve) => setTimeout(resolve, 500));
  console.log("✨ Analytics logged!");
}

/**
 * Mock function to process an order.
 */
async function processOrder(data: OrderData | undefined) {
  console.log("\n" + "=".repeat(60));
  console.log("📦 Processing Order...");
  console.log("=".repeat(60));
  console.log("Order Details:", JSON.stringify(data, null, 2));
  console.log(`   - Processing order for product: ${data?.productId}`);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  console.log("✨ Order processed successfully!");
}

// Run the example
if (require.main === module) {
  example().catch(console.error);
}

export { example, highThroughputExample, sessionRecoveryExample };
