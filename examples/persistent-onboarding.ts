/**
 * Persistent multi-turn onboarding agent example
 * Updated for v2 architecture with session step management and schema-first data extraction
 */

import {
  Agent,
  defineTool,
  GeminiProvider,
  END_ROUTE,
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
    findById(sessionId: string): SessionData | undefined {
      return database.get(sessionId);
    },

    update(sessionId: string, updates: Partial<SessionData>): void {
      const existing = database.get(sessionId);
      if (existing) {
        database.set(sessionId, {
          ...existing,
          ...updates,
          lastUpdated: new Date(),
        });
      }
    },

    create(sessionData: SessionData): void {
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
function createPersistentOnboardingAgent(sessionId: string) {
  // Load session from database
  const session = db.sessions.findById(sessionId);

  if (!session) {
    throw new Error(`Session ${sessionId} not found`);
  }

  // Define lifecycle hooks for automatic persistence
  const hooks = {
    // Called after data extraction - validate and enrich collected data
    onDataUpdate: (data: Partial<OnboardingData>) => {
      console.log("🔄 Processing collected data...");

      // Update completed steps based on what's been data
      const completedSteps: string[] = [];
      if (data.businessName) completedSteps.push("business_info");
      if (data.businessDescription) completedSteps.push("business_description");
      if (data.industry) completedSteps.push("industry");
      if (data.contactEmail) completedSteps.push("contact");

      // Persist to database
      db.sessions.update(sessionId, {
        collectedData: data,
        completedSteps,
      });

      return data;
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
    provider: provider,

    // Knowledge base with onboarding best practices
    knowledgeBase: {
      onboardingFlow: {
        stages: [
          "Business identification",
          "Industry classification",
          "Contact information collection",
          "Verification and confirmation",
        ],
        averageCompletion: "3-5 minutes",
        dropOffPoints: ["Contact email collection", "Industry classification"],
      },
      businessTypes: {
        retail: {
          commonIndustries: [
            "Fashion",
            "Electronics",
            "Home goods",
            "Food service",
          ],
          keyQuestions: ["Store location", "Target customers", "Peak hours"],
        },
        professional: {
          commonIndustries: ["Consulting", "Legal", "Accounting", "Healthcare"],
          keyQuestions: ["Service areas", "Certifications", "Client types"],
        },
        manufacturing: {
          commonIndustries: [
            "Electronics",
            "Automotive",
            "Food processing",
            "Textiles",
          ],
          keyQuestions: [
            "Production capacity",
            "Supply chain",
            "Quality standards",
          ],
        },
      },
      dataValidation: {
        email: "Must contain @ symbol and valid domain",
        businessName: "2-100 characters, no special characters",
        description: "10-500 characters, describes what the business does",
      },
      completionCriteria: [
        "Business name provided",
        "Business description provided",
        "Industry category selected",
        "Valid contact email provided",
      ],
    },
    // Context is loaded fresh from database on each respond() call
    contextProvider: () => {
      console.log("🔄 Loading fresh context from database...");
      const freshSession = db.sessions.findById(sessionId);

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
    (toolContext, name, description) => {
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
    schema: {
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
    endStep: {
      prompt:
        "Summarize all collected information warmly and confirm onboarding is complete",
    },
  });

  // Step 1: Collect business name and description
  const collectBusinessInfo = onboardingRoute.initialStep.nextStep({
    prompt: "Ask for business name and a brief description",
    collect: ["businessName", "businessDescription"],
    skipIf: (data) => !!data.businessName && !!data.businessDescription,
    when: "Need to collect basic business information first",
  });

  // Step 2: Save business info (tool execution)
  const saveBusiness = collectBusinessInfo.nextStep({
    tool: saveBusinessInfo,
    requires: ["businessName", "businessDescription"],
    when: "Business name and description provided, save to database",
  });

  // Step 3: Collect industry
  const collectIndustry = saveBusiness.nextStep({
    prompt: "Ask what industry the business operates in",
    collect: ["industry"],
    skipIf: (data) => !!data.industry,
  });

  // Step 4: Save industry (tool execution)
  const saveIndustryStep = collectIndustry.nextStep({
    tool: saveIndustry,
    requires: ["industry"],
  });

  // Step 5: Collect contact email
  const collectContact = saveIndustryStep.nextStep({
    prompt: "Ask for their contact email",
    collect: ["contactEmail"],
    skipIf: (data) => !!data.contactEmail,
  });

  // Step 6: Save contact (tool execution)
  const saveContact = collectContact.nextStep({
    tool: saveContactEmail,
    requires: ["contactEmail"],
  });

  // Step 7: Confirmation - uses route-level endStep
  saveContact.nextStep({ step: END_ROUTE });

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
function createOnboardingAgentWithProvider(sessionId: string) {
  const provider = new GeminiProvider({
    apiKey: process.env.GEMINI_API_KEY || "test-key",
    model: "models/gemini-2.5-flash",
  });

  const agent = new Agent<OnboardingContext>({
    name: "OnboardingBot",
    description: "A friendly assistant that helps businesses get started",
    provider: provider,

    // Context is always fetched fresh from database
    contextProvider: () => {
      const session = db.sessions.findById(sessionId);
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
      onContextUpdate: (newContext) => {
        db.sessions.update(sessionId, {
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
  db.sessions.create({
    sessionId,
    userId,
    collectedData: {},
    completedSteps: [],
    lastUpdated: new Date(),
  });

  // Create agent with fresh context loading
  const agent = createPersistentOnboardingAgent(sessionId);

  console.log("=== MULTI-TURN CONVERSATION SIMULATION ===\n");

  // Initialize session step for multi-turn conversation
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
  console.log("📊 Data after turn 1:", response1.session?.data);
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
  console.log("📊 Data after turn 2:", response2.session?.data);

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
  console.log("📊 Data after turn 3:", response3.session?.data);

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
  console.log("📊 Data after turn 4:", response4.session?.data);

  // Check for route completion
  if (response4.isRouteComplete) {
    console.log("\n✅ Onboarding complete!");
    await finalizeOnboarding(
      agent.getData(response4.session?.id) as unknown as OnboardingData
    );
  }

  // Verify persistence
  console.log("=== PERSISTENCE VERIFICATION ===");
  const finalSession = db.sessions.findById(sessionId);
  console.log(
    "💾 Final persisted session:",
    JSON.stringify(finalSession, null, 2)
  );
}

// ============================================================================
// KEY PATTERNS DEMONSTRATED (V2 Architecture)
// ============================================================================

/*
 * ✅ PATTERN 1: Session Step Management (Core v2 pattern)
 *    - createSession<T>(): Initialize typed session step
 *    - Pass session to respond() calls
 *    - Session tracks collected data across turns
 *    - Always-on routing respects intent changes
 *
 * ✅ PATTERN 2: Schema-First Data Extraction
 *    - schema: Define data contracts upfront
 *    - Type-safe extraction throughout conversation
 *    - skipIf functions for deterministic step logic
 *    - requires arrays for prerequisites
 *
 * ✅ PATTERN 3: Context Provider (For external data sources)
 *    - contextProvider: Load fresh context from database/API
 *    - Runs before each respond() call
 *    - Perfect for real-time external data
 *
 * ✅ PATTERN 4: Lifecycle Hooks (Data validation & enrichment)
 *    - onDataUpdate: Process collected data after extraction
 *    - Validate, enrich, and persist collected data
 *    - Return modified collected data
 *
 * ✅ PATTERN 5: Tool Integration (Enhanced context access)
 *    - Tools access collected data via context parameter
 *    - Can return dataUpdate to modify collected data
 *    - Perfect for data validation and enrichment
 *
 * ✅ PATTERN 6: Step Progression (Code-based logic)
 *    - skipIf: Deterministic functions instead of fuzzy conditions
 *    - requires: Prerequisites for step transitions
 *    - No more LLM interpretation of step logic
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
