/**
 * Persistent multi-turn onboarding agent example
 * Demonstrates context lifecycle management for stateful conversations
 */

import {
  Agent,
  defineTool,
  GeminiProvider,
  END_ROUTE,
  EventSource,
  createMessageEvent,
  type ContextLifecycleHooks,
} from "../src/index";

// ============================================================================
// DATABASE SIMULATION
// ============================================================================

interface SessionData {
  sessionId: string;
  userId: string;
  collectedData: {
    businessName?: string;
    businessDescription?: string;
    industry?: string;
    contactEmail?: string;
  };
  completedSteps: string[];
  lastUpdated: Date;
}

// Simple in-memory database simulation
const database = new Map<string, SessionData>();

const db = {
  sessions: {
    async findById(sessionId: string): Promise<SessionData | undefined> {
      return database.get(sessionId);
    },

    async update(
      sessionId: string,
      updates: Partial<SessionData>
    ): Promise<void> {
      const existing = database.get(sessionId);
      if (existing) {
        database.set(sessionId, {
          ...existing,
          ...updates,
          lastUpdated: new Date(),
        });
      }
    },

    async create(sessionData: SessionData): Promise<void> {
      database.set(sessionData.sessionId, sessionData);
    },
  },
};

// ============================================================================
// CONTEXT TYPE
// ============================================================================

interface OnboardingContext {
  sessionId: string;
  userId: string;
  userName?: string;
  collectedData: {
    businessName?: string;
    businessDescription?: string;
    industry?: string;
    contactEmail?: string;
  };
  completedSteps: string[];
}

// ============================================================================
// AGENT FACTORY WITH LIFECYCLE HOOKS
// ============================================================================

/**
 * Creates an onboarding agent with persistent context management
 *
 * PATTERN 1: Factory + Lifecycle Hooks
 * - Load fresh context from database before each response
 * - Persist context updates automatically after changes
 */
async function createPersistentOnboardingAgent(sessionId: string) {
  // Load session from database
  const session = await db.sessions.findById(sessionId);

  if (!session) {
    throw new Error(`Session ${sessionId} not found`);
  }

  // Define lifecycle hooks for automatic persistence
  const hooks: ContextLifecycleHooks<OnboardingContext> = {
    // Called before respond() - load fresh context from database
    beforeRespond: async (currentContext) => {
      console.log("🔄 Loading fresh context from database...");
      const freshSession = await db.sessions.findById(sessionId);

      if (!freshSession) {
        return currentContext; // Fallback to current
      }

      return {
        sessionId: freshSession.sessionId,
        userId: freshSession.userId,
        collectedData: freshSession.collectedData,
        completedSteps: freshSession.completedSteps,
      };
    },

    // Called after context updates - persist to database
    onContextUpdate: async (newContext) => {
      console.log("💾 Persisting context update to database...");
      await db.sessions.update(sessionId, {
        collectedData: newContext.collectedData,
        completedSteps: newContext.completedSteps,
      });
    },
  };

  const provider = new GeminiProvider({
    apiKey: process.env.GEMINI_API_KEY || "test-key",
    model: "models/gemini-2.5-flash",
  });

  const agent = new Agent<OnboardingContext>({
    name: "OnboardingBot",
    description: "A friendly assistant that helps businesses get started",
    goal: "Collect business information efficiently while being conversational",
    ai: provider,
    context: {
      sessionId: session.sessionId,
      userId: session.userId,
      collectedData: session.collectedData,
      completedSteps: session.completedSteps,
    },
    hooks, // Enable lifecycle hooks for persistence
  });

  // ============================================================================
  // TOOLS (with context updates)
  // ============================================================================

  // OPTION 1: Using contextUpdate in return value
  const saveBusinessInfo = defineTool<
    OnboardingContext,
    [name: string, description: string],
    boolean
  >(
    "save_business_info",
    async (toolContext, name, description) => {
      console.log(`📝 Saving business info: ${name}`);

      return {
        data: true,
        // Context update is automatically persisted via onContextUpdate hook
        contextUpdate: {
          collectedData: {
            ...toolContext.context.collectedData,
            businessName: name,
            businessDescription: description,
          },
          completedSteps: [
            ...toolContext.context.completedSteps,
            "business_info",
          ],
        },
      };
    },
    {
      description: "Save business name and description",
    }
  );

  // OPTION 2: Using updateContext method directly
  const saveIndustry = defineTool<
    OnboardingContext,
    [industry: string],
    boolean
  >(
    "save_industry",
    async (toolContext, industry) => {
      console.log(`🏭 Saving industry: ${industry}`);

      // Direct context update (triggers onContextUpdate hook)
      await toolContext.updateContext({
        collectedData: {
          ...toolContext.context.collectedData,
          industry,
        },
        completedSteps: [...toolContext.context.completedSteps, "industry"],
      });

      return { data: true };
    },
    {
      description: "Save business industry",
    }
  );

  const saveContactEmail = defineTool<
    OnboardingContext,
    [email: string],
    boolean
  >(
    "save_contact_email",
    async (toolContext, email) => {
      console.log(`📧 Saving contact email: ${email}`);

      await toolContext.updateContext({
        collectedData: {
          ...toolContext.context.collectedData,
          contactEmail: email,
        },
        completedSteps: [...toolContext.context.completedSteps, "contact"],
      });

      return { data: true };
    },
    {
      description: "Save contact email",
    }
  );

  // ============================================================================
  // ONBOARDING ROUTE
  // ============================================================================

  const onboardingRoute = agent.createRoute({
    title: "Business Onboarding",
    description: "Guide user through business information collection",
    conditions: ["User is onboarding their business"],
  });

  // Step 1: Collect business info
  const askBusinessInfo = onboardingRoute.initialState.transitionTo({
    chatState: "Ask for business name and a brief description",
  });

  const saveBusinessStep = askBusinessInfo.target.transitionTo({
    toolState: saveBusinessInfo,
  });

  // Step 2: Collect industry
  const askIndustry = saveBusinessStep.target.transitionTo({
    chatState: "Ask what industry the business operates in",
  });

  const saveIndustryStep = askIndustry.target.transitionTo({
    toolState: saveIndustry,
  });

  // Step 3: Collect contact
  const askContact = saveIndustryStep.target.transitionTo({
    chatState: "Ask for their contact email",
  });

  const saveContactStep = askContact.target.transitionTo({
    toolState: saveContactEmail,
  });

  // Step 4: Confirmation
  const confirm = saveContactStep.target.transitionTo({
    chatState: "Summarize all collected information and ask for confirmation",
  });

  confirm.target.transitionTo({ state: END_ROUTE });

  // Guidelines
  onboardingRoute.createGuideline({
    condition: "User provides invalid email format",
    action: "Politely ask for a valid email address",
    tags: ["validation"],
  });

  onboardingRoute.createGuideline({
    condition: "User wants to skip a step",
    action: "Explain why the information is important but allow them to skip",
    tags: ["flexibility"],
  });

  agent.createGuideline({
    condition: "User asks to start over",
    action:
      "Confirm they want to clear their progress, then restart the onboarding",
    tags: ["reset"],
  });

  return agent;
}

// ============================================================================
// ALTERNATIVE PATTERN: CONTEXT PROVIDER
// ============================================================================

/**
 * Creates an onboarding agent using the contextProvider pattern
 *
 * PATTERN 2: Context Provider (Always Fresh)
 * - Context is fetched fresh on every respond() call
 * - No need for beforeRespond hook
 * - Still use onContextUpdate for persistence
 */
async function createOnboardingAgentWithProvider(sessionId: string) {
  const provider = new GeminiProvider({
    apiKey: process.env.GEMINI_API_KEY || "test-key",
    model: "models/gemini-2.5-flash",
  });

  const agent = new Agent<OnboardingContext>({
    name: "OnboardingBot",
    description: "A friendly assistant that helps businesses get started",
    ai: provider,

    // Context is always fetched fresh from database
    contextProvider: async () => {
      const session = await db.sessions.findById(sessionId);
      if (!session) {
        throw new Error(`Session ${sessionId} not found`);
      }

      return {
        sessionId: session.sessionId,
        userId: session.userId,
        collectedData: session.collectedData,
        completedSteps: session.completedSteps,
      };
    },

    // Still persist updates
    hooks: {
      onContextUpdate: async (newContext) => {
        await db.sessions.update(sessionId, {
          collectedData: newContext.collectedData,
          completedSteps: newContext.completedSteps,
        });
      },
    },
  });

  // ... rest of agent setup (same as above)

  return agent;
}

// ============================================================================
// USAGE EXAMPLE
// ============================================================================

async function main() {
  const sessionId = "session_123";
  const userId = "user_456";

  // Initialize session in database
  await db.sessions.create({
    sessionId,
    userId,
    collectedData: {},
    completedSteps: [],
    lastUpdated: new Date(),
  });

  console.log("=== MULTI-TURN CONVERSATION SIMULATION ===\n");

  // Turn 1: Start onboarding
  console.log("📱 Turn 1: User starts onboarding");
  const agent1 = await createPersistentOnboardingAgent(sessionId);
  const response1 = await agent1.respond({
    history: [
      createMessageEvent(
        EventSource.CUSTOMER,
        "Alice",
        "Hi, I want to onboard my business"
      ),
    ],
  });
  console.log("🤖 Bot:", response1.message);
  console.log("📊 Context after turn 1:", agent1["context"]);
  console.log();

  // Turn 2: User provides business info
  // NOTE: We create a NEW agent instance - context is loaded from database
  console.log("📱 Turn 2: User provides business info");
  const agent2 = await createPersistentOnboardingAgent(sessionId);
  const response2 = await agent2.respond({
    history: [
      createMessageEvent(
        EventSource.CUSTOMER,
        "Alice",
        "My business is called 'TechFlow' and we build AI-powered workflow automation tools"
      ),
    ],
  });
  console.log("🤖 Bot:", response2.message);
  console.log("📊 Context after turn 2:", agent2["context"]);
  console.log();

  // Turn 3: User provides industry
  console.log("📱 Turn 3: User provides industry");
  const agent3 = await createPersistentOnboardingAgent(sessionId);
  const response3 = await agent3.respond({
    history: [
      createMessageEvent(
        EventSource.CUSTOMER,
        "Alice",
        "We're in the SaaS industry"
      ),
    ],
  });
  console.log("🤖 Bot:", response3.message);
  console.log("📊 Context after turn 3:", agent3["context"]);
  console.log();

  // Verify persistence
  console.log("=== PERSISTENCE VERIFICATION ===");
  const finalSession = await db.sessions.findById(sessionId);
  console.log(
    "💾 Final persisted session:",
    JSON.stringify(finalSession, null, 2)
  );
}

// ============================================================================
// KEY PATTERNS DEMONSTRATED
// ============================================================================

/*
 * ✅ PATTERN 1: Lifecycle Hooks (Recommended for most cases)
 *    - beforeRespond: Load fresh context before each response
 *    - onContextUpdate: Persist context after updates
 *    - Works with both static context and updates
 *
 * ✅ PATTERN 2: Context Provider (For always-fresh context)
 *    - contextProvider: Function that returns fresh context
 *    - onContextUpdate: Still needed for persistence
 *    - Best when context is always loaded from external source
 *
 * ✅ PATTERN 3: Tool Context Updates (Two options)
 *    - Option A: Return { data, contextUpdate } in tool result
 *    - Option B: Call toolContext.updateContext() directly
 *    - Both trigger onContextUpdate hook automatically
 *
 * ✅ PATTERN 4: Explicit Updates
 *    - agent.updateContext() for manual updates
 *    - Triggers onContextUpdate hook
 *    - Useful outside of tool execution
 *
 * ❌ ANTI-PATTERN: Caching Agents
 *    - DON'T cache agent instances across requests
 *    - DO recreate agents with fresh context
 *    - Context gets stale if agent is cached
 */

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}

export { createPersistentOnboardingAgent, createOnboardingAgentWithProvider };
