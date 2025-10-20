/**
 * Example: Custom Database Integration with New Session Management
 *
 * This example shows how to integrate with existing database schemas
 * while leveraging the new SessionManager for simplified session handling.
 *
 * Key patterns demonstrated:
 * - Using SessionManager with custom database schemas
 * - Converting between SessionManager and custom database formats
 * - Maintaining backward compatibility with existing systems
 * - Session recovery and continuation patterns
 */

import {
  Agent,
  GeminiProvider,
  SessionState,
  END_ROUTE,
  History,
} from "../../src";

/**
 * Example: Your existing database structure
 * This could be any ORM (Prisma, TypeORM, Drizzle) or query builder
 */
interface CustomDatabaseSession {
  id: string;
  userId: string;
  currentRoute?: string;
  currentStep?: string;
  collectedData?: Record<string, unknown>;
  conversationHistory?: Array<{
    role: string;
    content: string;
    name?: string;
    timestamp?: string;
  }>;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

interface CustomDatabaseMessage {
  id: string;
  sessionId: string;
  userId: string;
  role: string;
  content: string;
  route?: string;
  step?: string;
  createdAt: Date;
}

// Mock database - replace with your actual database
class CustomDatabase {
  private sessions: Map<string, CustomDatabaseSession> = new Map();
  private messages: Map<string, CustomDatabaseMessage[]> = new Map();

  findSession(id: string): CustomDatabaseSession | null {
    return this.sessions.get(id) || null;
  }

  createSession(
    data: Omit<CustomDatabaseSession, "id" | "createdAt" | "updatedAt">
  ): CustomDatabaseSession {
    const session: CustomDatabaseSession = {
      id: `session_${Date.now()}`,
      ...data,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.sessions.set(session.id, session);
    return session;
  }

  updateSession(
    id: string,
    data: Partial<CustomDatabaseSession>
  ): CustomDatabaseSession | null {
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

  createMessage(
    data: Omit<CustomDatabaseMessage, "id" | "createdAt">
  ): CustomDatabaseMessage {
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

  getSessionMessages(sessionId: string): CustomDatabaseMessage[] {
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
  const sessionId = "session_user123_onboarding";

  // Define onboarding schema
  const onboardingSchema = {
    type: "object",
    properties: {
      fullName: { type: "string" },
      email: { type: "string" },
      companyName: { type: "string" },
      phoneNumber: { type: "string" },
      industry: { type: "string" },
    },
    required: ["fullName", "email", "companyName"],
  };

  // Create agent with SessionManager (no persistence adapter)
  const agent = new Agent<unknown, OnboardingData>({
    name: "Onboarding Assistant",
    description: "Help new customers get started",
    goal: "Collect customer information efficiently",
    provider: new GeminiProvider({
      apiKey: process.env.GEMINI_API_KEY!,
      model: "models/gemini-2.5-flash",
    }),
    // NEW: Agent-level schema
    schema: onboardingSchema,
    // No persistence - we'll sync manually with our database
  });

  // Create onboarding route
  const onboardingRoute = agent.createRoute({
    title: "Customer Onboarding",
    description: "Collect customer information",
    conditions: [
      "User is a new customer",
      "User needs to set up their account",
    ],
    // NEW: Required fields for route completion
    requiredFields: ["fullName", "email", "companyName"],
    // NEW: Optional fields that enhance the experience
    optionalFields: ["phoneNumber", "industry"],
  });

  // Define steps with custom IDs
  onboardingRoute.initialStep
    .nextStep({
      id: "ask_name",
      prompt: "Ask for full name",
      collect: ["fullName"],
      skipIf: (data: Partial<OnboardingData>) => !!data.fullName,
    })
    .nextStep({
      id: "ask_email",
      prompt: "Ask for email address",
      collect: ["email"],
      skipIf: (data: Partial<OnboardingData>) => !!data.email,
    })
    .nextStep({
      id: "ask_company",
      prompt: "Ask for company name",
      collect: ["companyName"],
      skipIf: (data: Partial<OnboardingData>) => !!data.companyName,
    })
    .nextStep({
      id: "ask_phone",
      prompt: "Ask for phone number (optional)",
      collect: ["phoneNumber"],
    })
    .nextStep({
      id: "ask_industry",
      prompt: "Ask for industry",
      collect: ["industry"],
    })
    .nextStep({
      id: "confirm_details",
      prompt: "Confirm all details",
      requires: ["fullName", "email", "companyName"],
    })
    .nextStep({
      id: "complete_onboarding",
      prompt:
        "Thank you! Your account is set up. You will receive a confirmation email shortly.",
    })
    .nextStep({ step: END_ROUTE });

  /**
   * Load or create session in your custom database
   */
  let dbSession = db.findSession(sessionId);

  if (!dbSession) {
    // Create new session in your database
    dbSession = db.createSession({
      userId,
      collectedData: {},
      conversationHistory: [],
    });
    console.log("✨ Created new database session:", dbSession.id);
  } else {
    console.log("📥 Found existing database session:", dbSession.id);
  }

  /**
   * Sync database session with SessionManager
   */
  // Create or load session in SessionManager
  const sessionState = await agent.session.getOrCreate(dbSession.id);

  // Restore conversation history from database
  if (dbSession.conversationHistory && dbSession.conversationHistory.length > 0) {
    const history = dbSession.conversationHistory.map(msg => {
      if (msg.role === 'user') {
        return {
          role: 'user' as const,
          content: msg.content,
          name: msg.name,
        };
      } else {
        return {
          role: 'assistant' as const,
          content: msg.content,
        };
      }
    });
    agent.session.setHistory(history);
    console.log(`📜 Restored ${history.length} messages from database`);
  }

  // Restore collected data from database
  if (dbSession.collectedData) {
    await agent.session.setData(dbSession.collectedData);
    console.log("📊 Restored session data from database");
  }

  console.log("✅ Session synchronized:", {
    sessionId: agent.session.id,
    historyLength: agent.session.getHistory().length,
    data: agent.session.getData(),
  });

  /**
   * Simulate conversation with automatic sync
   */
  console.log("\n--- Turn 1 ---");
  
  // Add user message to SessionManager
  await agent.session.addMessage("user", "Hi! I'm John Smith and my email is john@acme.com", "User");

  const response1 = await agent.respond({
    history: agent.session.getHistory(),
  });

  console.log("🤖 Agent:", response1.message);
  console.log("📊 Data collected:", agent.session.getData());

  // Add agent response to SessionManager
  await agent.session.addMessage("assistant", response1.message);

  // Sync SessionManager state back to your database
  await syncSessionToDatabase(agent, db, dbSession.id, userId);
  console.log("💾 Session synced to custom database");

  // Turn 2: User provides company
  console.log("\n--- Turn 2 ---");
  
  await agent.session.addMessage("user", "I work for Acme Corporation", "User");

  const response2 = await agent.respond({
    history: agent.session.getHistory(),
  });

  console.log("🤖 Agent:", response2.message);
  console.log("📊 Data collected:", agent.session.getData());

  await agent.session.addMessage("assistant", response2.message);

  // Sync to database again
  await syncSessionToDatabase(agent, db, dbSession.id, userId);
  console.log("💾 Session synced to custom database");

  // Check for route completion
  if (response2.isRouteComplete) {
    console.log("\n✅ Onboarding Complete!");
    await processOnboarding(agent.session.getData());
  }

  /**
   * Demonstrate session recovery with new Agent instance
   */
  console.log("\n--- Session Recovery (New Agent Instance) ---");
  
  // Create new agent instance (simulating app restart)
  const newAgent = new Agent({
    name: "Onboarding Assistant",
    provider: new GeminiProvider({
      apiKey: process.env.GEMINI_API_KEY!,
      model: "models/gemini-2.5-flash",
    }),
  });

  // Load session from database and sync to new SessionManager
  const reloadedDbSession = db.findSession(dbSession.id);
  if (!reloadedDbSession) throw new Error("Session not found");

  // Load session in new agent's SessionManager
  await newAgent.session.getOrCreate(reloadedDbSession.id);

  // Restore history and data
  if (reloadedDbSession.conversationHistory) {
    const history = reloadedDbSession.conversationHistory.map(msg => {
      if (msg.role === 'user') {
        return {
          role: 'user' as const,
          content: msg.content,
          name: msg.name,
        };
      } else {
        return {
          role: 'assistant' as const,
          content: msg.content,
        };
      }
    });
    newAgent.session.setHistory(history);
  }

  if (reloadedDbSession.collectedData) {
    await newAgent.session.setData(reloadedDbSession.collectedData);
  }

  console.log("✅ Session recovered in new agent:", {
    sessionId: newAgent.session.id,
    historyLength: newAgent.session.getHistory().length,
    data: newAgent.session.getData(),
  });

  // Continue conversation with recovered session
  await newAgent.session.addMessage("user", "Can you confirm my details?");
  
  const confirmResponse = await newAgent.respond({
    history: newAgent.session.getHistory(),
  });
  
  console.log("🤖 Confirmation:", confirmResponse.message);
  await newAgent.session.addMessage("assistant", confirmResponse.message);

  console.log("\n✅ Example complete!");
}

/**
 * Helper function to sync SessionManager state to custom database
 */
async function syncSessionToDatabase(
  agent: Agent<unknown, OnboardingData>,
  db: CustomDatabase,
  sessionId: string,
  userId: string
): Promise<void> {
  const sessionData = agent.session.getData();
  const history = agent.session.getHistory();

  // Convert SessionManager history to database format
  const conversationHistory = history.map(msg => ({
    role: msg.role,
    content: msg.role === 'assistant' ? (msg.content || '') : msg.content,
    name: msg.role === 'user' ? msg.name : undefined,
    timestamp: new Date().toISOString(),
  }));

  // Update database session
  db.updateSession(sessionId, {
    collectedData: sessionData,
    conversationHistory,
  });

  // Save individual messages to database (if needed for your schema)
  const existingMessages = db.getSessionMessages(sessionId);
  const newMessages = history.slice(existingMessages.length);

  for (const msg of newMessages) {
    db.createMessage({
      sessionId,
      userId,
      role: msg.role,
      content: msg.content,
    });
  }
}

/**
 * Mock function to simulate processing the completed onboarding data.
 */
async function processOnboarding(data: Partial<OnboardingData> | undefined) {
  console.log("\n🚀 Processing onboarding data...");
  console.log(
    `   - Creating account for ${data?.fullName} at ${data?.companyName}`
  );
  await new Promise((resolve) => setTimeout(resolve, 1000));
  console.log(`   - Sending welcome email to ${data?.email}`);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  console.log("✨ Onboarding processed successfully!");
}

/**
 * Advanced Example: SessionManager with Data Validation Hooks
 */
async function advancedExample() {
  const db = new CustomDatabase();
  const sessionId = "session_user456_smart_onboarding";

  const smartOnboardingSchema = {
    type: "object",
    properties: {
      fullName: { type: "string" },
      email: { type: "string" },
      companyName: { type: "string" },
      phoneNumber: { type: "string" },
    },
    required: ["fullName", "email", "companyName"],
  };

  const agent = new Agent<unknown, OnboardingData>({
    name: "Smart Onboarding",
    provider: new GeminiProvider({
      apiKey: process.env.GEMINI_API_KEY!,
      model: "models/gemini-2.5-flash",
    }),
    // NEW: Agent-level schema
    schema: smartOnboardingSchema,
    hooks: {
      // Validate and enrich collected data
      onDataUpdate: (data: Partial<OnboardingData>, _previous: Partial<OnboardingData>) => {
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

  const route = agent.createRoute({
    title: "Smart Onboarding",
    // NEW: Required fields for route completion
    requiredFields: ["fullName", "email", "companyName"],
    // NEW: Optional fields
    optionalFields: ["phoneNumber"],
  });

  route.initialStep.nextStep({
    id: "collect_all",
    prompt: "Collect all information",
    collect: ["fullName", "email", "companyName", "phoneNumber"],
  });

  // Create database session
  const dbSession = db.createSession({
    userId: "user_456",
    collectedData: {},
    conversationHistory: [],
  });

  // Load session in SessionManager
  await agent.session.getOrCreate(dbSession.id);

  // Add user message and respond
  await agent.session.addMessage(
    "user",
    "I'm Alice Johnson, alice@EXAMPLE.COM, working for TechCorp. Phone: (555) 123-4567",
    "User"
  );

  const response = await agent.respond({
    history: agent.session.getHistory(),
  });

  console.log("🤖 Agent:", response.message);
  console.log("📊 Normalized data:", agent.session.getData());
  // Shows: { email: "alice@example.com", phoneNumber: "5551234567", ... }

  await agent.session.addMessage("assistant", response.message);

  // Sync to custom database
  await syncSessionToDatabase(agent, db, dbSession.id, "user_456");

  console.log("✅ Validated data saved to custom database!");
}

/**
 * Server Endpoint Example: Express-style API with SessionManager
 */
async function serverEndpointExample() {
  const db = new CustomDatabase();

  // Simulate Express endpoint
  async function handleChatRequest(req: {
    sessionId?: string;
    userId: string;
    message: string;
  }) {
    const { sessionId, userId, message } = req;

    // Create agent with sessionId (loads existing or creates new)
    const agent = new Agent<unknown, OnboardingData>({
      name: "Customer Support",
      provider: new GeminiProvider({
        apiKey: process.env.GEMINI_API_KEY!,
        model: "models/gemini-2.5-flash",
      }),
    });

    // Load or create session
    const effectiveSessionId = sessionId || `session_${userId}_${Date.now()}`;
    await agent.session.getOrCreate(effectiveSessionId);

    // Try to load from database if session exists
    const dbSession = db.findSession(effectiveSessionId);
    if (dbSession && dbSession.conversationHistory) {
      const history = dbSession.conversationHistory.map(msg => {
        if (msg.role === 'user') {
          return {
            role: 'user' as const,
            content: msg.content,
            name: msg.name,
          };
        } else {
          return {
            role: 'assistant' as const,
            content: msg.content,
          };
        }
      });
      agent.session.setHistory(history);

      if (dbSession.collectedData) {
        await agent.session.setData(dbSession.collectedData);
      }
    }

    // Add user message and respond
    await agent.session.addMessage("user", message);
    
    const response = await agent.respond({
      history: agent.session.getHistory(),
    });

    await agent.session.addMessage("assistant", response.message);

    // Sync back to database
    if (!dbSession) {
      db.createSession({
        userId,
        collectedData: agent.session.getData(),
        conversationHistory: agent.session.getHistory().map(msg => ({
          role: msg.role,
          content: msg.role === 'assistant' ? (msg.content || '') : msg.content,
          name: msg.role === 'user' ? msg.name : undefined,
          timestamp: new Date().toISOString(),
        })),
      });
    } else {
      await syncSessionToDatabase(agent, db, effectiveSessionId, userId);
    }

    // Return API response
    return {
      message: response.message,
      sessionId: agent.session.id,
      isComplete: response.isRouteComplete,
      data: agent.session.getData(),
    };
  }

  // Simulate API calls
  console.log("🌐 Simulating server endpoint calls...");

  const response1 = await handleChatRequest({
    userId: "user_789",
    message: "I need help with my account",
  });
  console.log("📤 Response 1:", response1);

  const response2 = await handleChatRequest({
    sessionId: response1.sessionId,
    userId: "user_789",
    message: "I can't log in",
  });
  console.log("📤 Response 2:", response2);

  console.log("✅ Server endpoint example complete!");
}

// Run the example
if (require.main === module) {
  example().catch(console.error);
}

export { example, advancedExample, serverEndpointExample };
