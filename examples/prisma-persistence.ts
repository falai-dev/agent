/**
 * Example: Using Prisma ORM for Persistence with Session State
 *
 * This example shows how to use @falai/agent with Prisma for automatic
 * session state persistence - with the new data-driven architecture!
 */

import {
  Agent,
  GeminiProvider,
  PrismaAdapter,
  createMessageEvent,
  EventSource,
  END_STATE,
} from "../src/index";

// @ts-ignore
import { PrismaClient } from "@prisma/client";

/**
 * Setup Steps:
 *
 * 1. Install dependencies:
 *    npm install prisma @prisma/client
 *
 * 2. Initialize Prisma:
 *    npx prisma init
 *
 * 3. Copy schema from examples/prisma-schema.example.prisma
 *    to your prisma/schema.prisma file
 *
 * 4. Generate Prisma client:
 *    npx prisma generate
 *
 * 5. Run migrations:
 *    npx prisma migrate dev --name init
 */

// Example context type
interface ConversationContext {
  userId: string;
  userName: string;
  currentBooking?: {
    destination?: string;
    departureDate?: string;
    returnDate?: string;
    passengers?: number;
  };
}

// Extracted data type for flight booking
interface FlightBookingData {
  destination: string;
  departureDate: string;
  returnDate?: string;
  passengers: number;
  cabinClass: "economy" | "premium" | "business" | "first";
}

// Extracted data type for onboarding
interface OnboardingData {
  fullName: string;
  email: string;
  phoneNumber: string;
  country: string;
}

// Extracted data type for contact form
interface ContactFormData {
  name: string;
  email: string;
  message: string;
}

async function example() {
  // Initialize Prisma client
  const prisma = new PrismaClient();

  const userId = "user_123";

  /**
   * Create Agent with Persistence - New Session-Based Pattern! ✨
   */
  const agent = new Agent<ConversationContext>({
    name: "Travel Assistant",
    description: "A helpful travel booking assistant",
    goal: "Help users book flights with ease",
    ai: new GeminiProvider({
      apiKey: process.env.GEMINI_API_KEY!,
      model: "models/gemini-2.0-flash-exp",
    }),
    context: {
      userId,
      userName: "Alice",
    },
    // ✨ Just pass the adapter - that's it!
    persistence: {
      adapter: new PrismaAdapter({ prisma }),
      autoSave: true, // Auto-saves session state after each response
      userId,
    },
  });

  /**
   * Create a route with data extraction schema
   */
  const flightRoute = agent.createRoute<FlightBookingData>({
    title: "Book a Flight",
    description: "Help user book a flight ticket",
    conditions: [
      "User wants to book a flight",
      "User mentions travel, flying, or booking tickets",
    ],
    extractionSchema: {
      type: "object",
      properties: {
        destination: {
          type: "string",
          description: "Destination city or airport",
        },
        departureDate: {
          type: "string",
          description: "Departure date (YYYY-MM-DD)",
        },
        returnDate: {
          type: "string",
          description: "Return date (YYYY-MM-DD)",
        },
        passengers: {
          type: "number",
          minimum: 1,
          maximum: 9,
          description: "Number of passengers",
        },
        cabinClass: {
          type: "string",
          enum: ["economy", "premium", "business", "first"],
          default: "economy",
          description: "Cabin class preference",
        },
      },
      required: ["destination", "departureDate", "passengers", "cabinClass"],
    },
  });

  // State flow with smart data gathering and custom IDs
  const askDestination = flightRoute.initialState.transitionTo({
    id: "ask_destination", // Custom state ID for easier tracking
    chatState: "Ask where they want to fly",
    gather: ["destination"],
    skipIf: (extracted) => !!extracted.destination,
  });

  const askDates = askDestination.transitionTo({
    id: "ask_dates", // Custom state ID
    chatState: "Ask about travel dates",
    gather: ["departureDate", "returnDate"],
    skipIf: (extracted) => !!extracted.departureDate,
    requiredData: ["destination"],
  });

  const askPassengers = askDates.transitionTo({
    id: "ask_passengers", // Custom state ID
    chatState: "Ask how many passengers",
    gather: ["passengers"],
    skipIf: (extracted) => !!extracted.passengers,
    requiredData: ["destination", "departureDate"],
  });

  const askCabinClass = askPassengers.transitionTo({
    id: "ask_cabin_class", // Custom state ID
    chatState: "Ask about cabin class preference",
    gather: ["cabinClass"],
    skipIf: (extracted) => !!extracted.cabinClass,
    requiredData: ["destination", "departureDate", "passengers"],
  });

  const confirmBooking = askCabinClass.transitionTo({
    id: "confirm_booking", // Custom state ID
    chatState: "Present options and confirm booking details",
    requiredData: ["destination", "departureDate", "passengers", "cabinClass"],
  });

  confirmBooking.transitionTo({ state: END_STATE });

  /**
   * Get persistence manager from agent
   */
  const persistence = agent.getPersistenceManager();

  if (!persistence) {
    throw new Error("Persistence not configured");
  }

  /**
   * Create or find a session - New Pattern!
   */
  let sessionResult =
    await persistence.createSessionWithState<FlightBookingData>({
      userId,
      agentName: "Travel Assistant",
      initialData: {
        cabinClass: "economy", // Default value
      },
    });

  let session = sessionResult.sessionState;
  const dbSessionId = sessionResult.sessionData.id;

  console.log("✨ Created new session:", dbSessionId);
  console.log("📊 Session metadata:", {
    sessionId: session.metadata?.sessionId, // Same as dbSessionId
    createdAt: session.metadata?.createdAt,
  });
  console.log("📊 Initial session state:", {
    currentRoute: session.currentRoute,
    extracted: session.extracted,
  });

  /**
   * Load conversation history
   */
  const history = await persistence.loadSessionHistory(dbSessionId);
  console.log(`📜 Loaded ${history.length} messages from history`);

  /**
   * Turn 1: User provides multiple fields at once
   */
  console.log("\n--- Turn 1 ---");
  const userMessage1 = createMessageEvent(
    EventSource.CUSTOMER,
    "Alice",
    "I want to fly to Paris on June 15 with 2 people"
  );

  history.push(userMessage1);

  const response1 = await agent.respond({
    history,
    session, // Pass session state
  });

  console.log("🤖 Agent:", response1.message);
  console.log("📊 Session state after turn 1:", {
    sessionId: response1.session?.metadata?.sessionId,
    currentRoute: response1.session?.currentRoute?.title,
    currentStateId: response1.session?.currentState?.id, // Custom ID like "ask_destination"
    currentStateDescription: response1.session?.currentState?.description,
    extracted: response1.session?.extracted,
  });

  // Save user message
  await persistence.saveMessage({
    sessionId: dbSessionId,
    userId,
    role: "user",
    content: userMessage1.data.message,
    event: userMessage1,
  });

  // Save agent message (session state is auto-saved by Agent!)
  await persistence.saveMessage({
    sessionId: dbSessionId,
    userId,
    role: "agent",
    content: response1.message,
    route: response1.session?.currentRoute?.id,
    state: response1.session?.currentState?.id,
  });

  // Update session for next turn
  session = response1.session!;

  /**
   * Turn 2: User changes their mind
   */
  console.log("\n--- Turn 2 ---");
  const userMessage2 = createMessageEvent(
    EventSource.CUSTOMER,
    "Alice",
    "Actually, make that Tokyo instead, and premium class"
  );

  history.push(
    createMessageEvent(
      EventSource.AI_AGENT,
      "Travel Assistant",
      response1.message
    )
  );
  history.push(userMessage2);

  const response2 = await agent.respond({
    history,
    session, // Pass updated session
  });

  console.log("🤖 Agent:", response2.message);
  console.log("📊 Session state after turn 2:", {
    currentRoute: response2.session?.currentRoute?.title,
    currentState: response2.session?.currentState?.id,
    extracted: response2.session?.extracted,
  });

  // Save messages
  await persistence.saveMessage({
    sessionId: dbSessionId,
    userId,
    role: "user",
    content: userMessage2.data.message,
    event: userMessage2,
  });

  await persistence.saveMessage({
    sessionId: dbSessionId,
    userId,
    role: "agent",
    content: response2.message,
    route: response2.session?.currentRoute?.id,
    state: response2.session?.currentState?.id,
  });

  session = response2.session!;

  if (response2.isRouteComplete) {
    console.log("\n✅ Flight booking complete!");
    await sendFlightConfirmation(
      agent.getExtractedData(session.id) as FlightBookingData
    );
  }

  /**
   * Load session state from database (demonstrates persistence)
   */
  console.log("\n--- Loading Session from Database ---");
  const loadedSession = await persistence.loadSessionState<FlightBookingData>(
    dbSessionId
  );

  console.log("📥 Loaded session state:", {
    currentRoute: loadedSession?.currentRoute?.title,
    currentState: loadedSession?.currentState?.id,
    extracted: loadedSession?.extracted,
  });

  /**
   * Query sessions and messages
   */
  const userSessions = await persistence.getUserSessions(userId);
  console.log(`\n👤 User has ${userSessions.length} total sessions`);

  const messages = await persistence.getSessionMessages(dbSessionId);
  console.log(`💬 Session has ${messages.length} messages`);

  /**
   * Complete the session
   */
  await persistence.completeSession(dbSessionId);
  console.log("✅ Session completed");

  /**
   * Cleanup
   */
  await prisma.$disconnect();
}

/**
 * Advanced Example: Session State with Lifecycle Hooks
 */
async function advancedExample() {
  const prisma = new PrismaClient();
  const userId = "user_456";

  interface UserContext {
    userId: string;
    userName: string;
    preferences: {
      currency: string;
      language: string;
    };
  }

  const agent = new Agent<UserContext>({
    name: "Onboarding Assistant",
    description: "Help new users get started",
    ai: new GeminiProvider({
      apiKey: process.env.GEMINI_API_KEY!,
      model: "models/gemini-2.0-flash-exp",
    }),
    context: {
      userId,
      userName: "Bob",
      preferences: {
        currency: "USD",
        language: "en",
      },
    },
    // Lifecycle hooks for session state enrichment
    hooks: {
      // Enrich extracted data before saving
      onExtractedUpdate: async (extracted, previous) => {
        console.log("🔄 Extracted data updated:", { extracted, previous });

        // Normalize phone numbers
        if (extracted.phoneNumber) {
          extracted.phoneNumber = extracted.phoneNumber.replace(/\D/g, "");
        }

        // Validate email
        if (extracted.email && !extracted.email.includes("@")) {
          console.warn("⚠️ Invalid email detected");
        }

        return extracted;
      },

      // Update context when session state changes
      onContextUpdate: async (newContext, oldContext) => {
        console.log("🔄 Context updated:", { newContext, oldContext });
      },
    },
    persistence: {
      adapter: new PrismaAdapter({ prisma }),
      autoSave: true,
      userId,
    },
  });

  // Create onboarding route
  const onboardingRoute = agent.createRoute<OnboardingData>({
    title: "User Onboarding",
    description: "Collect user information for account setup",
    extractionSchema: {
      type: "object",
      properties: {
        fullName: { type: "string" },
        email: { type: "string" },
        phoneNumber: { type: "string" },
        country: { type: "string" },
      },
      required: ["fullName", "email", "country"],
    },
  });

  onboardingRoute.initialState
    .transitionTo({
      chatState: "Welcome and ask for name",
      gather: ["fullName"],
      skipIf: (data) => !!data.fullName,
    })
    .transitionTo({
      chatState: "Ask for email",
      gather: ["email"],
      skipIf: (data) => !!data.email,
    })
    .transitionTo({
      chatState: "Ask for phone number (optional)",
      gather: ["phoneNumber"],
    })
    .transitionTo({
      chatState: "Ask for country",
      gather: ["country"],
      skipIf: (data) => !!data.country,
    })
    .transitionTo({
      chatState: "Confirm and complete onboarding",
    })
    .transitionTo({ state: END_STATE });

  const persistence = agent.getPersistenceManager()!;

  // Create session with state
  const { sessionData, sessionState } =
    await persistence.createSessionWithState<OnboardingData>({
      userId,
      agentName: "Onboarding Assistant",
    });

  console.log("✨ Created onboarding session:", sessionData.id);

  // Simulate conversation
  const history = [];
  let session = sessionState;

  const response = await agent.respond({
    history: [
      createMessageEvent(EventSource.CUSTOMER, "Bob", "Hi, I'm new here!"),
    ],
    session,
  });

  console.log("🤖 Agent:", response.message);
  console.log("📊 Extracted so far:", response.session?.extracted);

  await persistence.saveMessage({
    sessionId: sessionData.id,
    userId,
    role: "agent",
    content: response.message,
  });

  if (response.isRouteComplete) {
    console.log("\n✅ Onboarding complete!");
    await sendOnboardingEmail(
      agent.getExtractedData(sessionData.id) as OnboardingData
    );
  }

  console.log("✅ Session state automatically saved to database!");

  await prisma.$disconnect();
}

/**
 * Minimal Example - Quick Start
 */
async function quickStart() {
  const prisma = new PrismaClient();

  const agent = new Agent({
    name: "Support Agent",
    ai: new GeminiProvider({
      apiKey: process.env.GEMINI_API_KEY!,
      model: "models/gemini-2.0-flash-exp",
    }),
    persistence: {
      adapter: new PrismaAdapter({ prisma }),
      userId: "user_789",
      autoSave: true, // ✨ Automatically saves session state!
    },
  });

  // Create a simple contact form route
  const contactRoute = agent.createRoute<ContactFormData>({
    title: "Contact Form",
    extractionSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        email: { type: "string" },
        message: { type: "string" },
      },
      required: ["name", "email", "message"],
    },
  });

  contactRoute.initialState
    .transitionTo({
      chatState: "Collect all information",
      gather: ["name", "email", "message"],
    })
    .transitionTo({
      chatState: "Confirm submission",
    })
    .transitionTo({ state: END_STATE });

  const persistence = agent.getPersistenceManager()!;

  // Create session with state support
  const { sessionData, sessionState } =
    await persistence.createSessionWithState<ContactFormData>({
      userId: "user_789",
      agentName: "Support Agent",
    });

  // Chat!
  const response = await agent.respond({
    history: [
      createMessageEvent(
        EventSource.CUSTOMER,
        "User",
        "I need help, my name is John and my email is john@example.com"
      ),
    ],
    session: sessionState,
  });

  console.log("✅ Response:", response.message);
  console.log("📊 Extracted:", response.session?.extracted);

  if (response.isRouteComplete) {
    console.log("\n✅ Contact form submitted!");
    await logContactForm(
      agent.getExtractedData(sessionData.id) as ContactFormData
    );
  }

  console.log("💾 Session state auto-saved to Prisma!");

  await prisma.$disconnect();
}

/**
 * Mock function to send a flight confirmation email.
 * @param data - The flight booking data.
 */
async function sendFlightConfirmation(
  data: Partial<FlightBookingData> | undefined
) {
  console.log("\n" + "=".repeat(60));
  console.log("🚀 Sending Flight Confirmation...");
  console.log("=".repeat(60));
  console.log("Booking Details:", JSON.stringify(data, null, 2));
  console.log(
    `   - Sending confirmation for ${data?.passengers} passengers to ${data?.destination}.`
  );
  await new Promise((resolve) => setTimeout(resolve, 1000));
  console.log("✨ Confirmation sent!");
}

/**
 * Mock function to send an onboarding email.
 * @param data - The onboarding data.
 */
async function sendOnboardingEmail(data: Partial<OnboardingData> | undefined) {
  console.log("\n" + "=".repeat(60));
  console.log("🚀 Sending Onboarding Email...");
  console.log("=".repeat(60));
  console.log("Onboarding Details:", JSON.stringify(data, null, 2));
  console.log(`   - Sending welcome email to ${data?.email}.`);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  console.log("✨ Email sent!");
}

/**
 * Mock function to log a contact form submission.
 * @param data - The contact form data.
 */
async function logContactForm(data: Partial<ContactFormData> | undefined) {
  console.log("\n" + "=".repeat(60));
  console.log("📝 Logging Contact Form Submission...");
  console.log("=".repeat(60));
  console.log("Submission Details:", JSON.stringify(data, null, 2));
  console.log(`   - Logging message from ${data?.name}.`);
  await new Promise((resolve) => setTimeout(resolve, 500));
  console.log("✨ Submission logged!");
}

// Run the example
if (require.main === module) {
  example().catch(console.error);
}

export { example, advancedExample, quickStart };
