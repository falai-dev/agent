/**
 * Example: Custom Database Integration (Manual Session State Management)
 *
 * This example shows how to manually manage session state when using your own
 * database structure instead of the built-in persistence adapters.
 *
 * Use this approach if you:
 * - Have an existing database schema you want to integrate with
 * - Need custom data structures beyond what adapters provide
 * - Want full control over database operations
 */

import {
  Agent,
  GeminiProvider,
  createMessageEvent,
  EventSource,
  createSession,
  SessionState,
  MessageEventData,
  Event,
  END_STATE,
} from "../src/index";

/**
 * Example: Your existing database structure
 * This could be any ORM (Prisma, TypeORM, Drizzle) or query builder
 */
interface CustomDatabaseSession {
  id: string;
  userId: string;
  currentRoute?: string;
  currentState?: string;
  collectedData?: {
    extracted?: Record<string, unknown>;
    extractedByRoute?: Record<string, Partial<unknown>>;
    routeHistory?: unknown[];
    currentRouteTitle?: string;
    currentStateDescription?: string;
    metadata?: Record<string, unknown>;
  };
  createdAt: Date;
  updatedAt: Date;
}

interface CustomDatabaseMessage {
  id: string;
  sessionId: string;
  userId: string;
  role: "user" | "agent" | "system";
  content: string;
  route?: string;
  state?: string;
  createdAt: Date;
}

// Mock database - replace with your actual database
class CustomDatabase {
  private sessions: Map<string, CustomDatabaseSession> = new Map();
  private messages: Map<string, CustomDatabaseMessage[]> = new Map();

  async findSession(id: string): Promise<CustomDatabaseSession | null> {
    return this.sessions.get(id) || null;
  }

  async createSession(
    data: Omit<CustomDatabaseSession, "id" | "createdAt" | "updatedAt">
  ): Promise<CustomDatabaseSession> {
    const session: CustomDatabaseSession = {
      id: `session_${Date.now()}`,
      ...data,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.sessions.set(session.id, session);
    return session;
  }

  async updateSession(
    id: string,
    data: Partial<CustomDatabaseSession>
  ): Promise<CustomDatabaseSession | null> {
    const session = this.sessions.get(id);
    if (!session) return null;

    const updated = {
      ...session,
      ...data,
      updatedAt: new Date(),
    };
    this.sessions.set(id, updated);
    return updated;
  }

  async createMessage(
    data: Omit<CustomDatabaseMessage, "id" | "createdAt">
  ): Promise<CustomDatabaseMessage> {
    const message: CustomDatabaseMessage = {
      id: `msg_${Date.now()}`,
      ...data,
      createdAt: new Date(),
    };

    const messages = this.messages.get(data.sessionId) || [];
    messages.push(message);
    this.messages.set(data.sessionId, messages);

    return message;
  }

  async getSessionMessages(
    sessionId: string
  ): Promise<CustomDatabaseMessage[]> {
    return this.messages.get(sessionId) || [];
  }
}

// Example data type for a customer onboarding route
interface OnboardingData {
  fullName: string;
  email: string;
  companyName: string;
  phoneNumber?: string;
  industry?: string;
}

async function example() {
  const db = new CustomDatabase();
  const userId = "user_123";

  // Create agent
  const agent = new Agent({
    name: "Onboarding Assistant",
    description: "Help new customers get started",
    goal: "Collect customer information efficiently",
    ai: new GeminiProvider({
      apiKey: process.env.GEMINI_API_KEY!,
      model: "models/gemini-2.0-flash-exp",
    }),
    // NOTE: No persistence adapter - we handle it manually!
  });

  // Create onboarding route
  const onboardingRoute = agent.createRoute<OnboardingData>({
    title: "Customer Onboarding",
    description: "Collect customer information",
    conditions: [
      "User is a new customer",
      "User needs to set up their account",
    ],
    extractionSchema: {
      type: "object",
      properties: {
        fullName: { type: "string" },
        email: { type: "string" },
        companyName: { type: "string" },
        phoneNumber: { type: "string" },
        industry: { type: "string" },
      },
      required: ["fullName", "email", "companyName"],
    },
  });

  // Define states with custom IDs
  onboardingRoute.initialState
    .transitionTo({
      id: "ask_name",
      chatState: "Ask for full name",
      gather: ["fullName"],
      skipIf: (data) => !!data.fullName,
    })
    .transitionTo({
      id: "ask_email",
      chatState: "Ask for email address",
      gather: ["email"],
      skipIf: (data) => !!data.email,
    })
    .transitionTo({
      id: "ask_company",
      chatState: "Ask for company name",
      gather: ["companyName"],
      skipIf: (data) => !!data.companyName,
    })
    .transitionTo({
      id: "ask_phone",
      chatState: "Ask for phone number (optional)",
      gather: ["phoneNumber"],
    })
    .transitionTo({
      id: "ask_industry",
      chatState: "Ask for industry",
      gather: ["industry"],
    })
    .transitionTo({
      id: "confirm_details",
      chatState: "Confirm all details",
      requiredData: ["fullName", "email", "companyName"],
    })
    .transitionTo({
      id: "complete_onboarding",
      chatState:
        "Thank you! Your account is set up. You will receive a confirmation email shortly.",
    })
    .transitionTo({ state: END_STATE });

  /**
   * Create or load session from your custom database
   */
  let dbSession = await db.findSession("existing_session_id");

  if (!dbSession) {
    // Create new session in your database
    dbSession = await db.createSession({
      userId,
      collectedData: {},
    });
    console.log("✨ Created new database session:", dbSession.id);
  }

  /**
   * Convert database session to agent SessionState
   */
  let agentSession: SessionState<OnboardingData>;

  if (dbSession.currentRoute && dbSession.collectedData) {
    // Restore existing session from database
    console.log("📥 Restoring session from database...");

    agentSession = {
      currentRoute: {
        id: dbSession.currentRoute,
        title:
          dbSession.collectedData?.currentRouteTitle || dbSession.currentRoute,
        enteredAt: new Date(),
      },
      currentState: dbSession.currentState
        ? {
            id: dbSession.currentState,
            description: dbSession.collectedData?.currentStateDescription,
            enteredAt: new Date(),
          }
        : undefined,
      extracted:
        (dbSession.collectedData?.extracted as Partial<OnboardingData>) || {},
      extractedByRoute:
        (dbSession.collectedData?.extractedByRoute as Record<
          string,
          Partial<OnboardingData>
        >) || {},
      routeHistory:
        (dbSession.collectedData
          ?.routeHistory as SessionState<OnboardingData>["routeHistory"]) || [],
      metadata: {
        sessionId: dbSession.id,
        userId,
        createdAt: dbSession.createdAt,
        lastUpdatedAt: dbSession.updatedAt,
        ...(dbSession.collectedData?.metadata as Record<string, unknown>),
      },
    };

    console.log("✅ Session restored:", {
      sessionId: agentSession.metadata?.sessionId,
      currentRoute: agentSession.currentRoute?.title,
      currentState: agentSession.currentState?.id,
      extracted: agentSession.extracted,
    });
  } else {
    // Create new session state
    console.log("🆕 Creating new session state...");

    agentSession = createSession<OnboardingData>(dbSession.id, {
      sessionId: dbSession.id,
      userId,
      createdAt: dbSession.createdAt,
    });
  }

  /**
   * Simulate conversation
   */
  const history: Event<MessageEventData>[] = [];

  // Turn 1: User provides name and email
  console.log("\n--- Turn 1 ---");
  const userMessage1 = createMessageEvent(
    EventSource.CUSTOMER,
    "User",
    "Hi! I'm John Smith and my email is john@acme.com"
  );
  history.push(userMessage1);

  // Save user message to database
  await db.createMessage({
    sessionId: dbSession.id,
    userId,
    role: "user",
    content: userMessage1.data.message,
  });

  const response1 = await agent.respond({
    history,
    session: agentSession,
  });

  console.log("🤖 Agent:", response1.message);
  console.log("📊 Extracted so far:", response1.session?.extracted);

  // Save agent message to database
  await db.createMessage({
    sessionId: dbSession.id,
    userId,
    role: "agent",
    content: response1.message,
    route: response1.session?.currentRoute?.id,
    state: response1.session?.currentState?.id,
  });

  // Manually save session state back to database
  await db.updateSession(dbSession.id, {
    currentRoute: response1.session?.currentRoute?.id,
    currentState: response1.session?.currentState?.id,
    collectedData: {
      extracted: response1.session?.extracted,
      routeHistory: response1.session?.routeHistory,
      currentRouteTitle: response1.session?.currentRoute?.title,
      currentStateDescription: response1.session?.currentState?.description,
      metadata: response1.session?.metadata,
    },
  });

  console.log("💾 Session saved to database");

  // Update session for next turn
  agentSession = response1.session!;

  // Turn 2: User provides company
  console.log("\n--- Turn 2 ---");
  history.push(
    createMessageEvent(EventSource.AI_AGENT, "Agent", response1.message)
  );

  const userMessage2 = createMessageEvent(
    EventSource.CUSTOMER,
    "User",
    "I work for Acme Corporation"
  );
  history.push(userMessage2);

  await db.createMessage({
    sessionId: dbSession.id,
    userId,
    role: "user",
    content: userMessage2.data.message,
  });

  const response2 = await agent.respond({
    history,
    session: agentSession,
  });

  console.log("🤖 Agent:", response2.message);
  console.log("📊 Extracted so far:", response2.session?.extracted);

  await db.createMessage({
    sessionId: dbSession.id,
    userId,
    role: "agent",
    content: response2.message,
    route: response2.session?.currentRoute?.id,
    state: response2.session?.currentState?.id,
  });

  // Save session state
  await db.updateSession(dbSession.id, {
    currentRoute: response2.session?.currentRoute?.id,
    currentState: response2.session?.currentState?.id,
    collectedData: {
      extracted: response2.session?.extracted,
      routeHistory: response2.session?.routeHistory,
      currentRouteTitle: response2.session?.currentRoute?.title,
      currentStateDescription: response2.session?.currentState?.description,
      metadata: response2.session?.metadata,
    },
  });

  console.log("💾 Session saved to database");

  // Check for route completion
  if (response2.isRouteComplete) {
    console.log("\n✅ Onboarding Complete!");
    // In a real app, you would now trigger the next steps,
    // like sending a welcome email, creating an account, etc.
    await processOnboarding(response2.session?.extracted);
  }

  /**
   * Demonstrate session recovery
   */
  console.log("\n--- Session Recovery ---");
  console.log("Simulating app restart...\n");

  // Load session from database again
  const reloadedDbSession = await db.findSession(dbSession.id);
  if (!reloadedDbSession) throw new Error("Session not found");

  // Reconstruct session state
  const recoveredSession: SessionState<OnboardingData> = {
    currentRoute: reloadedDbSession.currentRoute
      ? {
          id: reloadedDbSession.currentRoute,
          title:
            reloadedDbSession.collectedData?.currentRouteTitle ||
            reloadedDbSession.currentRoute,
          enteredAt: new Date(),
        }
      : undefined,
    currentState: reloadedDbSession.currentState
      ? {
          id: reloadedDbSession.currentState,
          description: reloadedDbSession.collectedData?.currentStateDescription,
          enteredAt: new Date(),
        }
      : undefined,
    extracted:
      (reloadedDbSession.collectedData?.extracted as Partial<OnboardingData>) ||
      {},
    extractedByRoute:
      (reloadedDbSession.collectedData?.extractedByRoute as Record<
        string,
        Partial<OnboardingData>
      >) || {},
    routeHistory:
      (reloadedDbSession.collectedData
        ?.routeHistory as SessionState<OnboardingData>["routeHistory"]) || [],
    metadata: {
      sessionId: reloadedDbSession.id,
      userId,
      createdAt: reloadedDbSession.createdAt,
      lastUpdatedAt: reloadedDbSession.updatedAt,
    },
  };

  console.log("✅ Session recovered from database:", {
    sessionId: recoveredSession.metadata?.sessionId,
    currentRoute: recoveredSession.currentRoute?.title,
    currentState: recoveredSession.currentState?.id,
    extracted: recoveredSession.extracted,
  });

  // Load message history
  const messages = await db.getSessionMessages(dbSession.id);
  console.log(`📜 Loaded ${messages.length} messages from history`);

  console.log("\n✅ Example complete!");
}

/**
 * Mock function to simulate processing the completed onboarding data.
 * @param data - The collected onboarding data.
 */
async function processOnboarding(data: Partial<OnboardingData> | undefined) {
  console.log("\n🚀 Processing onboarding data...");
  // Simulate creating a user account
  console.log(
    `   - Creating account for ${data?.fullName} at ${data?.companyName}`
  );
  await new Promise((resolve) => setTimeout(resolve, 1000));
  // Simulate sending a welcome email
  console.log(`   - Sending welcome email to ${data?.email}`);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  console.log("✨ Onboarding processed successfully!");
}

/**
 * Advanced Example: With validation hooks
 */
async function advancedExample() {
  const db = new CustomDatabase();
  const userId = "user_456";

  const agent = new Agent({
    name: "Smart Onboarding",
    ai: new GeminiProvider({
      apiKey: process.env.GEMINI_API_KEY!,
      model: "models/gemini-2.0-flash-exp",
    }),
    hooks: {
      // Validate and enrich extracted data
      onExtractedUpdate: async (extracted, previous) => {
        console.log("🔄 Data extracted, validating...");

        // Normalize email
        if (extracted.email) {
          extracted.email = extracted.email.toLowerCase().trim();
        }

        // Normalize phone
        if (extracted.phoneNumber) {
          extracted.phoneNumber = extracted.phoneNumber.replace(/\D/g, "");
        }

        return extracted;
      },
    },
  });

  const route = agent.createRoute<OnboardingData>({
    title: "Onboarding",
    extractionSchema: {
      type: "object",
      properties: {
        fullName: { type: "string" },
        email: { type: "string" },
        companyName: { type: "string" },
        phoneNumber: { type: "string" },
      },
      required: ["fullName", "email", "companyName"],
    },
  });

  route.initialState.transitionTo({
    id: "collect_all",
    chatState: "Collect all information",
    gather: ["fullName", "email", "companyName", "phoneNumber"],
  });

  // Create database session
  const dbSession = await db.createSession({
    userId,
    collectedData: {},
  });

  // Create agent session
  let agentSession = createSession<OnboardingData>(dbSession.id, {
    userId,
  });

  // Simulate conversation
  const response = await agent.respond({
    history: [
      createMessageEvent(
        EventSource.CUSTOMER,
        "User",
        "I'm Alice Johnson, alice@EXAMPLE.COM, working for TechCorp. Phone: (555) 123-4567"
      ),
    ],
    session: agentSession,
  });

  console.log("🤖 Agent:", response.message);
  console.log("📊 Normalized data:", response.session?.extracted);
  // Shows: { email: "alice@example.com", phoneNumber: "5551234567", ... }

  // Save to database
  await db.updateSession(dbSession.id, {
    currentRoute: response.session?.currentRoute?.id,
    currentState: response.session?.currentState?.id,
    collectedData: {
      extracted: response.session?.extracted,
      routeHistory: response.session?.routeHistory,
      currentRouteTitle: response.session?.currentRoute?.title,
      currentStateDescription: response.session?.currentState?.description,
      metadata: response.session?.metadata,
    },
  });

  console.log("✅ Validated data saved to custom database!");
}

// Run the example
if (require.main === module) {
  example().catch(console.error);
}

export { example, advancedExample };
