/**
 * Example: Custom Database Integration (Manual Session Step Management)
 *
 * This example shows how to manually manage session step when using your own
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
  END_ROUTE,
} from "../src/index";

/**
 * Example: Your existing database structure
 * This could be any ORM (Prisma, TypeORM, Drizzle) or query builder
 */
interface CustomDatabaseSession {
  id: string;
  userId: string;
  currentRoute?: string;
  currentStep?: string;
  collectedData?: {
    data?: Record<string, unknown>;
    dataByRoute?: Record<string, Partial<unknown>>;
    routeHistory?: unknown[];
    currentRouteTitle?: string;
    currentStepDescription?: string;
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
  step?: string;
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
    provider: new GeminiProvider({
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
    schema: {
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

  // Define steps with custom IDs
  onboardingRoute.initialStep
    .nextStep({
      id: "ask_name",
      instructions: "Ask for full name",
      collect: ["fullName"],
      skipIf: (data) => !!data.fullName,
    })
    .nextStep({
      id: "ask_email",
      instructions: "Ask for email address",
      collect: ["email"],
      skipIf: (data) => !!data.email,
    })
    .nextStep({
      id: "ask_company",
      instructions: "Ask for company name",
      collect: ["companyName"],
      skipIf: (data) => !!data.companyName,
    })
    .nextStep({
      id: "ask_phone",
      instructions: "Ask for phone number (optional)",
      collect: ["phoneNumber"],
    })
    .nextStep({
      id: "ask_industry",
      instructions: "Ask for industry",
      collect: ["industry"],
    })
    .nextStep({
      id: "confirm_details",
      instructions: "Confirm all details",
      requires: ["fullName", "email", "companyName"],
    })
    .nextStep({
      id: "complete_onboarding",
      instructions:
        "Thank you! Your account is set up. You will receive a confirmation email shortly.",
    })
    .nextStep({ step: END_ROUTE });

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
      currentStep: dbSession.currentStep
        ? {
            id: dbSession.currentStep,
            description: dbSession.collectedData?.currentStepDescription,
            enteredAt: new Date(),
          }
        : undefined,
      data: (dbSession.collectedData?.data as Partial<OnboardingData>) || {},
      dataByRoute:
        (dbSession.collectedData?.dataByRoute as Record<
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
      currentStep: agentSession.currentStep?.id,
      data: agentSession.data,
    });
  } else {
    // Create new session step
    console.log("🆕 Creating new session step...");

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
  console.log("📊 Data so far:", response1.session?.data);

  // Save agent message to database
  await db.createMessage({
    sessionId: dbSession.id,
    userId,
    role: "agent",
    content: response1.message,
    route: response1.session?.currentRoute?.id,
    step: response1.session?.currentStep?.id,
  });

  // Manually save session step back to database
  await db.updateSession(dbSession.id, {
    currentRoute: response1.session?.currentRoute?.id,
    currentStep: response1.session?.currentStep?.id,
    collectedData: {
      data: response1.session?.data,
      routeHistory: response1.session?.routeHistory,
      currentRouteTitle: response1.session?.currentRoute?.title,
      currentStepDescription: response1.session?.currentStep?.description,
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
  console.log("📊 Data so far:", response2.session?.data);

  await db.createMessage({
    sessionId: dbSession.id,
    userId,
    role: "agent",
    content: response2.message,
    route: response2.session?.currentRoute?.id,
    step: response2.session?.currentStep?.id,
  });

  // Save session step
  await db.updateSession(dbSession.id, {
    currentRoute: response2.session?.currentRoute?.id,
    currentStep: response2.session?.currentStep?.id,
    collectedData: {
      data: response2.session?.data,
      routeHistory: response2.session?.routeHistory,
      currentRouteTitle: response2.session?.currentRoute?.title,
      currentStepDescription: response2.session?.currentStep?.description,
      metadata: response2.session?.metadata,
    },
  });

  console.log("💾 Session saved to database");

  // Check for route completion
  if (response2.isRouteComplete) {
    console.log("\n✅ Onboarding Complete!");
    // In a real app, you would now trigger the next steps,
    // like sending a welcome email, creating an account, etc.
    await processOnboarding(response2.session?.data);
  }

  /**
   * Demonstrate session recovery
   */
  console.log("\n--- Session Recovery ---");
  console.log("Simulating app restart...\n");

  // Load session from database again
  const reloadedDbSession = await db.findSession(dbSession.id);
  if (!reloadedDbSession) throw new Error("Session not found");

  // Reconstruct session step
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
    currentStep: reloadedDbSession.currentStep
      ? {
          id: reloadedDbSession.currentStep,
          description: reloadedDbSession.collectedData?.currentStepDescription,
          enteredAt: new Date(),
        }
      : undefined,
    data:
      (reloadedDbSession.collectedData?.data as Partial<OnboardingData>) || {},
    dataByRoute:
      (reloadedDbSession.collectedData?.dataByRoute as Record<
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
    currentStep: recoveredSession.currentStep?.id,
    data: recoveredSession.data,
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
    provider: new GeminiProvider({
      apiKey: process.env.GEMINI_API_KEY!,
      model: "models/gemini-2.0-flash-exp",
    }),
    hooks: {
      // Validate and enrich collected data
      onDataUpdate: async (data, previous) => {
        console.log("🔄 Data collected, validating...");

        // Normalize email
        if (data.email) {
          data.email = data.email.toLowerCase().trim();
        }

        // Normalize phone
        if (data.phoneNumber) {
          data.phoneNumber = data.phoneNumber.replace(/\D/g, "");
        }

        return data;
      },
    },
  });

  const route = agent.createRoute<OnboardingData>({
    title: "Onboarding",
    schema: {
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

  route.initialStep.nextStep({
    id: "collect_all",
    instructions: "Collect all information",
    collect: ["fullName", "email", "companyName", "phoneNumber"],
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
  console.log("📊 Normalized data:", response.session?.data);
  // Shows: { email: "alice@example.com", phoneNumber: "5551234567", ... }

  // Save to database
  await db.updateSession(dbSession.id, {
    currentRoute: response.session?.currentRoute?.id,
    currentStep: response.session?.currentStep?.id,
    collectedData: {
      data: response.session?.data,
      routeHistory: response.session?.routeHistory,
      currentRouteTitle: response.session?.currentRoute?.title,
      currentStepDescription: response.session?.currentStep?.description,
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
