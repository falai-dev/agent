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
  createMessageEvent,
  EventSource,
  MessageEventData,
  Event,
  END_ROUTE,
} from "../src/index";
// @ts-ignore
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

  // Create agent with Redis persistence
  const agent = new Agent<ChatContext>({
    name: "Support Assistant",
    description: "Fast, real-time support assistant",
    goal: "Help users resolve issues quickly",
    provider: new GeminiProvider({
      apiKey: process.env.GEMINI_API_KEY!,
      model: "models/gemini-2.0-flash-exp",
    }),
    context: {
      userId,
      userName: "Alice",
      chatType: "support",
    },
    // ✨ Redis adapter with custom options
    persistence: {
      adapter: new RedisAdapter({
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
  const ticketRoute = agent.createRoute<SupportTicketData>({
    title: "Create Support Ticket",
    description: "Help user create and track support tickets",
    conditions: [
      "User needs help with an issue",
      "User wants to report a problem",
      "User mentions support, help, or issue",
    ],
    schema: {
      type: "object",
      properties: {
        issue: {
          type: "string",
          description: "Brief summary of the issue",
        },
        category: {
          type: "string",
          enum: ["technical", "billing", "account", "other"],
          description: "Issue category",
        },
        priority: {
          type: "string",
          enum: ["low", "medium", "high"],
          default: "medium",
          description: "Issue priority",
        },
        description: {
          type: "string",
          description: "Detailed description of the issue",
        },
      },
      required: ["issue", "category", "description"],
    },
  });

  // Step flow
  ticketRoute.initialStep
    .nextStep({
      instructions: "Ask what the issue is",
      collect: ["issue", "category"],
      skipIf: (data) => !!data.issue && !!data.category,
    })
    .nextStep({
      instructions: "Ask for priority",
      collect: ["priority"],
      skipIf: (data) => !!data.priority,
      requires: ["issue", "category"],
    })
    .nextStep({
      instructions: "Ask for detailed description",
      collect: ["description"],
      skipIf: (data) => !!data.description,
      requires: ["issue", "category"],
    })
    .nextStep({
      instructions: "Confirm and create ticket",
      requires: ["issue", "category", "description"],
    })
    .nextStep({ step: END_ROUTE });

  const persistence = agent.getPersistenceManager();
  if (!persistence) return;

  // Create session with step support
  const { sessionData, sessionStep } =
    await persistence.createSessionWithStep<SupportTicketData>({
      userId,
      agentName: "Support Assistant",
      initialData: {
        priority: "medium", // Default priority
      },
    });

  console.log("✨ Session created in Redis:", sessionData.id);
  console.log("📊 Initial step:", {
    data: sessionStep.data,
  });

  // Turn 1: User provides issue
  const history: Event<MessageEventData>[] = [];
  let session = sessionStep;

  const message1 = createMessageEvent(
    EventSource.CUSTOMER,
    "Alice",
    "I can't log into my account, it's a technical issue and it's urgent!"
  );
  history.push(message1);

  const response1 = await agent.respond({
    history,
    session,
  });

  console.log("\n--- Turn 1 ---");
  console.log("🤖 Agent:", response1.message);
  console.log("📊 Collected data:", response1.session?.data);

  // Save messages
  await persistence.saveMessage({
    sessionId: sessionData.id,
    role: "user",
    content: message1.data.message,
  });

  await persistence.saveMessage({
    sessionId: sessionData.id,
    role: "agent",
    content: response1.message,
    route: response1.session?.currentRoute?.id,
    step: response1.session?.currentStep?.id,
  });

  session = response1.session!;

  // Turn 2: Provide more details
  history.push(
    createMessageEvent(
      EventSource.AI_AGENT,
      "Support Assistant",
      response1.message
    )
  );

  const message2 = createMessageEvent(
    EventSource.CUSTOMER,
    "Alice",
    "I keep getting 'Invalid credentials' error even though I reset my password"
  );
  history.push(message2);

  const response2 = await agent.respond({
    history,
    session,
  });

  console.log("\n--- Turn 2 ---");
  console.log("🤖 Agent:", response2.message);
  console.log("📊 Collected data:", response2.session?.data);

  await persistence.saveMessage({
    sessionId: sessionData.id,
    role: "user",
    content: message2.data.message,
  });

  await persistence.saveMessage({
    sessionId: sessionData.id,
    role: "agent",
    content: response2.message,
  });

  if (response2.isRouteComplete) {
    console.log("\n✅ Support ticket route complete!");
    await fileSupportTicket(agent.getData(session.id) as SupportTicketData);
  }

  // Load session step from Redis (demonstrates persistence)
  console.log("\n--- Loading Session from Redis ---");
  const loadedSession = await persistence.loadSessionState<SupportTicketData>(
    sessionData.id
  );

  console.log("📥 Loaded session:", {
    currentRoute: loadedSession?.currentRoute?.title,
    data: loadedSession?.data,
  });

  // Get messages
  const messages = await persistence.getSessionMessages(sessionData.id);
  console.log(`\n💬 ${messages.length} messages in session`);

  // Complete session
  await persistence.completeSession(sessionData.id);
  console.log("✅ Session completed");

  // Cleanup
  await redis.quit();
}

/**
 * Advanced Example: High-Throughput Chat with Session Step
 */
async function highThroughputExample() {
  const redis = new Redis();

  const agent = new Agent({
    name: "Chat Bot",
    description: "Fast chat responses",
    provider: new GeminiProvider({
      apiKey: process.env.GEMINI_API_KEY!,
      model: "models/gemini-2.0-flash-exp",
    }),
    persistence: {
      adapter: new RedisAdapter({
        redis,
        keyPrefix: "chat:",
        sessionTTL: 60 * 60, // 1 hour for quick chats
      }),
      autoSave: true,
      userId: "user_456",
    },
  });

  // Simple chat route that extracts topic and sentiment
  const chatRoute = agent.createRoute<QuickChatData>({
    title: "General Chat",
    schema: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          description: "Main topic of conversation",
        },
        sentiment: {
          type: "string",
          enum: ["positive", "neutral", "negative"],
          description: "User's sentiment",
        },
      },
      required: ["topic", "sentiment"],
    },
  });

  chatRoute.initialStep
    .nextStep({
      instructions: "Chat and extract topic/sentiment",
      collect: ["topic", "sentiment"],
    })
    .nextStep({ step: END_ROUTE });

  const persistence = agent.getPersistenceManager()!;

  // Create session
  const { sessionData, sessionStep } =
    await persistence.createSessionWithStep<QuickChatData>({
      userId: "user_456",
      agentName: "Chat Bot",
    });

  // Quick chat interaction
  const response = await agent.respond({
    history: [
      createMessageEvent(
        EventSource.CUSTOMER,
        "User",
        "I'm loving the new features you added!"
      ),
    ],
    session: sessionStep,
  });

  console.log("🤖 Response:", response.message);
  console.log("📊 Data:", response.session?.data);

  if (response.isRouteComplete) {
    console.log("\n✅ Chat analytics route complete!");
    await logChatAnalytics(agent.getData(sessionData.id) as QuickChatData);
  }

  console.log("💾 Session step cached in Redis!");

  await redis.quit();
}

/**
 * Session Recovery Example
 * Shows how to resume conversations from Redis
 */
async function sessionRecoveryExample() {
  const redis = new Redis();

  const agent = new Agent({
    name: "Order Assistant",
    provider: new GeminiProvider({
      apiKey: process.env.GEMINI_API_KEY!,
      model: "models/gemini-2.0-flash-exp",
    }),
    persistence: {
      adapter: new RedisAdapter({ redis }),
      autoSave: true,
      userId: "user_789",
    },
  });

  const orderRoute = agent.createRoute<OrderData>({
    title: "Place Order",
    schema: {
      type: "object",
      properties: {
        productId: { type: "string" },
        quantity: { type: "number", minimum: 1 },
        shippingAddress: { type: "string" },
      },
      required: ["productId", "quantity", "shippingAddress"],
    },
  });

  orderRoute.initialStep
    .nextStep({
      instructions: "Ask what to order",
      collect: ["productId", "quantity"],
    })
    .nextStep({
      instructions: "Ask for shipping address",
      collect: ["shippingAddress"],
    })
    .nextStep({ step: END_ROUTE });

  const persistence = agent.getPersistenceManager()!;

  // Start a new session
  const { sessionData, sessionStep } =
    await persistence.createSessionWithStep<OrderData>({
      userId: "user_789",
      agentName: "Order Assistant",
    });

  const sessionId = sessionData.id;

  console.log("✨ New order session:", sessionId);

  // First interaction
  const response1 = await agent.respond({
    history: [
      createMessageEvent(
        EventSource.CUSTOMER,
        "User",
        "I want to order product ABC123, 2 units"
      ),
    ],
    session: sessionStep,
  });

  console.log("🤖 Response:", response1.message);
  console.log("📊 Data so far:", response1.session?.data);

  // --- Simulate user disconnecting and reconnecting ---
  console.log("\n--- User Reconnects ---");

  // Load session from Redis
  const recoveredSession = await persistence.loadSessionState<OrderData>(
    sessionId
  );

  console.log("📥 Recovered session step:", {
    currentRoute: recoveredSession?.currentRoute?.title,
    data: recoveredSession?.data,
  });

  // Load message history
  const history = await persistence.loadSessionHistory(sessionId);
  console.log(`📜 Loaded ${history.length} messages from history`);

  // Continue conversation
  history.push(
    createMessageEvent(
      EventSource.CUSTOMER,
      "User",
      "Ship to 123 Main St, New York"
    )
  );

  const response2 = await agent.respond({
    history,
    session: recoveredSession!,
  });

  console.log("🤖 Response:", response2.message);
  console.log("📊 Final collected data:", response2.session?.data);

  if (response2.isRouteComplete) {
    console.log("\n✅ Order placement complete!");
    await processOrder(agent.getData(sessionId) as unknown as OrderData);
  }

  console.log("✅ Order complete with recovered session!");

  await redis.quit();
}

/**
 * Mock function to file a support ticket.
 * @param data - The support ticket data.
 */
async function fileSupportTicket(data: SupportTicketData) {
  console.log("\n" + "=".repeat(60));
  console.log("🎫 Filing Support Ticket...");
  console.log("=".repeat(60));
  console.log("Ticket Details:", JSON.stringify(data, null, 2));
  console.log(
    `   - Filing ticket for issue: ${data.issue} with priority: ${data.priority}`
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
 * @param data - The order data.
 */
async function processOrder(data: OrderData) {
  console.log("\n" + "=".repeat(60));
  console.log("📦 Processing Order...");
  console.log("=".repeat(60));
  console.log("Order Details:", JSON.stringify(data, null, 2));
  console.log(`   - Processing order for product: ${data.productId}`);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  console.log("✨ Order processed successfully!");
}

// Run the example
if (require.main === module) {
  example().catch(console.error);
}

export { example, highThroughputExample, sessionRecoveryExample };
