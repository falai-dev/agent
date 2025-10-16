/**
 * Persistent multi-turn onboarding agent example
 * Updated for v2 architecture with session state management and schema-first data extraction
 */

import {
  Agent,
  defineTool,
  GeminiProvider,
  END_STATE,
  END_STATE_ID,
  EventSource,
  createMessageEvent,
  createSession,
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

// Data extraction types for onboarding
interface OnboardingData {
  businessName?: string;
  businessDescription?: string;
  industry?: string;
  contactEmail?: string;
}

interface OnboardingContext {
  sessionId: string;
  userId: string;
  userName?: string;
  collectedData: OnboardingData;
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
  const hooks = {
    // Called after data extraction - validate and enrich extracted data
    onExtractedUpdate: async (extracted, previousExtracted) => {
      console.log("🔄 Processing extracted data...");

      // Update completed steps based on what's been extracted
      const completedSteps: string[] = [];
      if (extracted.businessName) completedSteps.push("business_info");
      if (extracted.businessDescription)
        completedSteps.push("business_description");
      if (extracted.industry) completedSteps.push("industry");
      if (extracted.contactEmail) completedSteps.push("contact");

      // Persist to database
      await db.sessions.update(sessionId, {
        collectedData: extracted,
        completedSteps,
      });

      return extracted;
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
    // Context is loaded fresh from database on each respond() call
    contextProvider: async () => {
      console.log("🔄 Loading fresh context from database...");
      const freshSession = await db.sessions.findById(sessionId);

      if (!freshSession) {
        throw new Error(`Session ${sessionId} not found`);
      }

      return {
        sessionId: freshSession.sessionId,
        userId: freshSession.userId,
        collectedData: freshSession.collectedData,
        completedSteps: freshSession.completedSteps,
      };
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
  // ONBOARDING ROUTE WITH DATA EXTRACTION
  // ============================================================================

  const onboardingRoute = agent.createRoute<OnboardingData>({
    title: "Business Onboarding",
    description: "Guide user through business information collection",
    conditions: ["User is onboarding their business"],
    extractionSchema: {
      type: "object",
      properties: {
        businessName: {
          type: "string",
          description: "Name of the business",
        },
        businessDescription: {
          type: "string",
          description: "Brief description of what the business does",
        },
        industry: {
          type: "string",
          description: "Industry the business operates in",
        },
        contactEmail: {
          type: "string",
          description: "Contact email for the business",
        },
      },
      required: ["businessName", "businessDescription"],
    },
  });

  // State 1: Gather business name and description
  const gatherBusinessInfo = onboardingRoute.initialState.transitionTo({
    chatState: "Ask for business name and a brief description",
    gather: ["businessName", "businessDescription"],
    skipIf: (extracted) =>
      !!extracted.businessName && !!extracted.businessDescription,
    condition: "Need to collect basic business information first",
  });

  // State 2: Save business info (tool execution)
  const saveBusiness = gatherBusinessInfo.transitionTo({
    toolState: saveBusinessInfo,
    requiredData: ["businessName", "businessDescription"],
    condition: "Business name and description provided, save to database",
  });

  // State 3: Gather industry
  const gatherIndustry = saveBusiness.transitionTo({
    chatState: "Ask what industry the business operates in",
    gather: ["industry"],
    skipIf: (extracted) => !!extracted.industry,
  });

  // State 4: Save industry (tool execution)
  const saveIndustryStep = gatherIndustry.transitionTo({
    toolState: saveIndustry,
    requiredData: ["industry"],
  });

  // State 5: Gather contact email
  const gatherContact = saveIndustryStep.transitionTo({
    chatState: "Ask for their contact email",
    gather: ["contactEmail"],
    skipIf: (extracted) => !!extracted.contactEmail,
  });

  // State 6: Save contact (tool execution)
  const saveContact = gatherContact.transitionTo({
    toolState: saveContactEmail,
    requiredData: ["contactEmail"],
  });

  // State 7: Confirmation
  const confirm = saveContact.transitionTo({
    chatState: "Summarize all collected information and ask for confirmation",
  });

  confirm.transitionTo({ state: END_STATE });

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

  // Create agent with fresh context loading
  const agent = await createPersistentOnboardingAgent(sessionId);

  console.log("=== MULTI-TURN CONVERSATION SIMULATION ===\n");

  // Initialize session state for multi-turn conversation
  let session = createSession<OnboardingData>();

  // Turn 1: Start onboarding
  console.log("📱 Turn 1: User starts onboarding");
  const response1 = await agent.respond({
    history: [
      createMessageEvent(
        EventSource.CUSTOMER,
        "Alice",
        "Hi, I want to onboard my business"
      ),
    ],
    session,
  });
  console.log("🤖 Bot:", response1.message);
  console.log("📊 Extracted after turn 1:", response1.session?.extracted);
  console.log("📊 Route:", response1.session?.currentRoute?.title);

  // Check route completion after turn 1
  console.log("🔍 Route Completion Check (Turn 1):");
  if (response1.isRouteComplete) {
    console.log("   ✅ Route completed after turn 1!");
  } else {
    console.log("   ⏳ Route still in progress after turn 1");
  }

  console.log();

  // Update session with progress
  session = response1.session!;

  // Turn 2: User provides business info
  console.log("📱 Turn 2: User provides business info");
  const history2 = [
    createMessageEvent(
      EventSource.CUSTOMER,
      "Alice",
      "Hi, I want to onboard my business"
    ),
    createMessageEvent(EventSource.AI_AGENT, "Agent", response1.message),
    createMessageEvent(
      EventSource.CUSTOMER,
      "Alice",
      "My business is called 'TechFlow' and we build AI-powered workflow automation tools"
    ),
  ];
  const response2 = await agent.respond({ history: history2, session });
  console.log("🤖 Bot:", response2.message);
  console.log("📊 Extracted after turn 2:", response2.session?.extracted);

  // Check route completion after turn 2
  console.log("🔍 Route Completion Check (Turn 2):");
  if (response2.isRouteComplete) {
    console.log("   ✅ Route completed after turn 2!");
  } else {
    console.log("   ⏳ Route still in progress after turn 2");
  }

  console.log();

  // Update session again
  session = response2.session!;

  // Turn 3: User provides industry
  console.log("📱 Turn 3: User provides industry");
  const history3 = [
    ...history2,
    createMessageEvent(EventSource.AI_AGENT, "Agent", response2.message),
    createMessageEvent(
      EventSource.CUSTOMER,
      "Alice",
      "We're in the SaaS industry"
    ),
  ];
  const response3 = await agent.respond({ history: history3, session });
  console.log("🤖 Bot:", response3.message);
  console.log("📊 Extracted after turn 3:", response3.session?.extracted);

  // Check route completion after turn 3
  console.log("🔍 Route Completion Check (Turn 3):");
  if (response3.isRouteComplete) {
    console.log("   ✅ Route completed after turn 3!");
  } else {
    console.log("   ⏳ Route still in progress after turn 3");
  }

  console.log();

  // Update session again
  session = response3.session!;

  // Turn 4: User provides contact email, completing the flow
  console.log("📱 Turn 4: User provides contact email");
  const history4 = [
    ...history3,
    createMessageEvent(EventSource.AI_AGENT, "Agent", response3.message),
    createMessageEvent(
      EventSource.CUSTOMER,
      "Alice",
      "Our contact email is contact@techflow.ai"
    ),
  ];
  const response4 = await agent.respond({ history: history4, session });
  console.log("🤖 Bot:", response4.message);
  console.log("📊 Extracted after turn 4:", response4.session?.extracted);

  // Check for route completion
  if (response4.isRouteComplete) {
    console.log("\n✅ Onboarding complete!");
    await finalizeOnboarding(
      agent.getExtractedData(response4.session?.id) as unknown as OnboardingData
    );
  }

  // Verify persistence
  console.log("=== PERSISTENCE VERIFICATION ===");
  const finalSession = await db.sessions.findById(sessionId);
  console.log(
    "💾 Final persisted session:",
    JSON.stringify(finalSession, null, 2)
  );
}

// ============================================================================
// KEY PATTERNS DEMONSTRATED (V2 Architecture)
// ============================================================================

/*
 * ✅ PATTERN 1: Session State Management (Core v2 pattern)
 *    - createSession<T>(): Initialize typed session state
 *    - Pass session to respond() calls
 *    - Session tracks extracted data across turns
 *    - Always-on routing respects intent changes
 *
 * ✅ PATTERN 2: Schema-First Data Extraction
 *    - extractionSchema: Define data contracts upfront
 *    - Type-safe extraction throughout conversation
 *    - skipIf functions for deterministic state logic
 *    - requiredData arrays for prerequisites
 *
 * ✅ PATTERN 3: Context Provider (For external data sources)
 *    - contextProvider: Load fresh context from database/API
 *    - Runs before each respond() call
 *    - Perfect for real-time external data
 *
 * ✅ PATTERN 4: Lifecycle Hooks (Data validation & enrichment)
 *    - onExtractedUpdate: Process extracted data after extraction
 *    - Validate, enrich, and persist extracted data
 *    - Return modified extracted data
 *
 * ✅ PATTERN 5: Tool Integration (Enhanced context access)
 *    - Tools access extracted data via context parameter
 *    - Can return extractedUpdate to modify extracted data
 *    - Perfect for data validation and enrichment
 *
 * ✅ PATTERN 6: State Progression (Code-based logic)
 *    - skipIf: Deterministic functions instead of fuzzy conditions
 *    - requiredData: Prerequisites for state transitions
 *    - No more LLM interpretation of state logic
 */

/**
 * Mock function to finalize the onboarding process.
 * @param data - The complete onboarding data.
 */
async function finalizeOnboarding(data: OnboardingData) {
  console.log("\n" + "=".repeat(60));
  console.log("🚀 Finalizing Onboarding...");
  console.log("=".repeat(60));
  console.log("Onboarding Details:", JSON.stringify(data, null, 2));
  console.log(`   - Sending welcome email to ${data.contactEmail}...`);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  console.log("   - Scheduling follow-up call...");
  await new Promise((resolve) => setTimeout(resolve, 500));
  console.log("✨ Onboarding finalized!");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}

export { createPersistentOnboardingAgent, createOnboardingAgentWithProvider };
