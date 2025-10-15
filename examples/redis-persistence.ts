/**
 * Example: Using Redis for Persistence with Session State
 *
 * Fast, in-memory persistence perfect for:
 * - High-throughput applications
 * - Session caching with extracted data
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

async function example() {
  // Initialize Redis client
  const redis = new Redis();

  const userId = "user_123";

  // Create agent with Redis persistence
  const agent = new Agent<ChatContext>({
    name: "Support Assistant",
    description: "Fast, real-time support assistant",
    goal: "Help users resolve issues quickly",
    ai: new GeminiProvider({
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
      autoSave: true, // Auto-save session state
      userId,
    },
  });

  // Create support ticket route with data gathering
  const ticketRoute = agent.createRoute<SupportTicketData>({
    title: "Create Support Ticket",
    description: "Help user create and track support tickets",
    conditions: [
      "User needs help with an issue",
      "User wants to report a problem",
      "User mentions support, help, or issue",
    ],
    gatherSchema: {
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

  // State flow
  ticketRoute.initialState
    .transitionTo({
      chatState: "Ask what the issue is",
      gather: ["issue", "category"],
      skipIf: (data) => !!data.issue && !!data.category,
    })
    .transitionTo({
      chatState: "Ask for priority",
      gather: ["priority"],
      skipIf: (data) => !!data.priority,
      requiredData: ["issue", "category"],
    })
    .transitionTo({
      chatState: "Ask for detailed description",
      gather: ["description"],
      skipIf: (data) => !!data.description,
      requiredData: ["issue", "category"],
    })
    .transitionTo({
      chatState: "Confirm and create ticket",
      requiredData: ["issue", "category", "description"],
    });

  const persistence = agent.getPersistenceManager();
  if (!persistence) return;

  // Create session with state support
  const { sessionData, sessionState } =
    await persistence.createSessionWithState<SupportTicketData>({
      userId,
      agentName: "Support Assistant",
      initialData: {
        priority: "medium", // Default priority
      },
    });

  console.log("✨ Session created in Redis:", sessionData.id);
  console.log("📊 Initial state:", {
    extracted: sessionState.extracted,
  });

  // Turn 1: User provides issue
  const history: Event<MessageEventData>[] = [];
  let session = sessionState;

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
  console.log("📊 Extracted data:", response1.session?.extracted);

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
    state: response1.session?.currentState?.id,
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
  console.log("📊 Extracted data:", response2.session?.extracted);

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

  // Load session state from Redis (demonstrates persistence)
  console.log("\n--- Loading Session from Redis ---");
  const loadedSession = await persistence.loadSessionState<SupportTicketData>(
    sessionData.id
  );

  console.log("📥 Loaded session:", {
    currentRoute: loadedSession?.currentRoute?.title,
    extracted: loadedSession?.extracted,
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
 * Advanced Example: High-Throughput Chat with Session State
 */
async function highThroughputExample() {
  const redis = new Redis();

  interface QuickChatData {
    topic: string;
    sentiment: "positive" | "neutral" | "negative";
  }

  const agent = new Agent({
    name: "Chat Bot",
    description: "Fast chat responses",
    ai: new GeminiProvider({
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
    gatherSchema: {
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

  chatRoute.initialState.transitionTo({
    chatState: "Chat and extract topic/sentiment",
    gather: ["topic", "sentiment"],
  });

  const persistence = agent.getPersistenceManager()!;

  // Create session
  const { sessionData, sessionState } =
    await persistence.createSessionWithState<QuickChatData>({
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
    session: sessionState,
  });

  console.log("🤖 Response:", response.message);
  console.log("📊 Extracted:", response.session?.extracted);
  console.log("💾 Session state cached in Redis!");

  await redis.quit();
}

/**
 * Session Recovery Example
 * Shows how to resume conversations from Redis
 */
async function sessionRecoveryExample() {
  const redis = new Redis();

  interface OrderData {
    productId: string;
    quantity: number;
    shippingAddress: string;
  }

  const agent = new Agent({
    name: "Order Assistant",
    ai: new GeminiProvider({
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
    gatherSchema: {
      type: "object",
      properties: {
        productId: { type: "string" },
        quantity: { type: "number", minimum: 1 },
        shippingAddress: { type: "string" },
      },
      required: ["productId", "quantity", "shippingAddress"],
    },
  });

  orderRoute.initialState
    .transitionTo({
      chatState: "Ask what to order",
      gather: ["productId", "quantity"],
    })
    .transitionTo({
      chatState: "Ask for shipping address",
      gather: ["shippingAddress"],
    });

  const persistence = agent.getPersistenceManager()!;

  // Start a new session
  const { sessionData, sessionState } =
    await persistence.createSessionWithState<OrderData>({
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
    session: sessionState,
  });

  console.log("🤖 Response:", response1.message);
  console.log("📊 Extracted so far:", response1.session?.extracted);

  // --- Simulate user disconnecting and reconnecting ---
  console.log("\n--- User Reconnects ---");

  // Load session from Redis
  const recoveredSession = await persistence.loadSessionState<OrderData>(
    sessionId
  );

  console.log("📥 Recovered session state:", {
    currentRoute: recoveredSession?.currentRoute?.title,
    extracted: recoveredSession?.extracted,
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
  console.log("📊 Final extracted data:", response2.session?.extracted);
  console.log("✅ Order complete with recovered session!");

  await redis.quit();
}

// Run the example
if (require.main === module) {
  example().catch(console.error);
}

export { example, highThroughputExample, sessionRecoveryExample };
