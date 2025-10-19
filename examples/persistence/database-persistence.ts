/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
/**
 * Example: Using Prisma ORM for Persistence with Session Step
 *
 * This example shows how to use @falai/agent with Prisma for automatic
 * session step persistence - with the new data-driven architecture!
 */

import {
  Agent,
  GeminiProvider,
  PrismaAdapter,
  END_ROUTE,
  HistoryItem,
  MessageRole,
} from "../../src";

// @ts-expect-error - PrismaClient is not typed
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

// Collected data type for flight booking
interface FlightBookingData {
  destination: string;
  departureDate: string;
  returnDate?: string;
  passengers: number;
  cabinClass: "economy" | "premium" | "business" | "first";
}

// Collected data type for onboarding
interface OnboardingData {
  fullName: string;
  email: string;
  phoneNumber: string;
  country: string;
}

// Collected data type for contact form
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
    provider: new GeminiProvider({
      apiKey: process.env.GEMINI_API_KEY!,
      model: "models/gemini-2.5-flash",
    }),
    context: {
      userId,
      userName: "Alice",
    },
    // ✨ Just pass the adapter - that's it!
    persistence: {
      adapter: new PrismaAdapter<ConversationContext>({ prisma }),
      autoSave: true, // Auto-saves session step after each response
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
    schema: {
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

  // Step flow with smart data collecting and custom IDs
  const askDestination = flightRoute.initialStep.nextStep({
    id: "ask_destination", // Custom step ID for easier tracking
    prompt: "Ask where they want to fly",
    collect: ["destination"],
    skipIf: (data: Partial<FlightBookingData>) => !!data.destination,
  });

  const askDates = askDestination.nextStep({
    id: "ask_dates", // Custom step ID
    prompt: "Ask about travel dates",
    collect: ["departureDate", "returnDate"],
    skipIf: (data: Partial<FlightBookingData>) => !!data.departureDate,
    requires: ["destination"],
  });

  const askPassengers = askDates.nextStep({
    id: "ask_passengers", // Custom step ID
    prompt: "Ask how many passengers",
    collect: ["passengers"],
    skipIf: (data: Partial<FlightBookingData>) => !!data.passengers,
    requires: ["destination", "departureDate"],
  });

  const askCabinClass = askPassengers.nextStep({
    id: "ask_cabin_class", // Custom step ID
    prompt: "Ask about cabin class preference",
    collect: ["cabinClass"],
    skipIf: (data: Partial<FlightBookingData>) => !!data.cabinClass,
    requires: ["destination", "departureDate", "passengers"],
  });

  const confirmBooking = askCabinClass.nextStep({
    id: "confirm_booking", // Custom step ID
    prompt: "Present options and confirm booking details",
    requires: ["destination", "departureDate", "passengers", "cabinClass"],
  });

  confirmBooking.nextStep({ step: END_ROUTE });

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
  const sessionResult = await persistence.createSessionWithStep({
    userId,
    agentName: "Travel Assistant",
    initialData: {
      cabinClass: "economy", // Default value
    },
  });

  let session = sessionResult.sessionStep;
  const dbSessionId = sessionResult.sessionData.id;

  console.log("✨ Created new session:", dbSessionId);
  console.log("📊 Session metadata:", {
    sessionId: session.metadata?.sessionId, // Same as dbSessionId
    createdAt: session.metadata?.createdAt,
  });
  console.log("📊 Initial session step:", {
    currentRoute: session.currentRoute,
    data: session.data,
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
  const userMessage1: HistoryItem = {
    role: "user",
    content: "I want to fly to Paris on June 15 with 2 people",
    name: "Alice",
  };

  history.push(userMessage1);

  const response1 = await agent.respond({
    history,
    session, // Pass session step
  });

  console.log("🤖 Agent:", response1.message);
  console.log("📊 Session step after turn 1:", {
    sessionId: response1.session?.metadata?.sessionId,
    currentRoute: response1.session?.currentRoute?.title,
    currentStepId: response1.session?.currentStep?.id, // Custom ID like "ask_destination"
    currentStepDescription: response1.session?.currentStep?.description,
    data: response1.session?.data,
  });

  // Save user message
  await persistence.saveMessage({
    sessionId: dbSessionId,
    userId,
    role: MessageRole.USER,
    content: userMessage1.content,
  });

  // Save agent message (session step is auto-saved by Agent!)
  await persistence.saveMessage({
    sessionId: dbSessionId,
    userId,
    role: MessageRole.ASSISTANT,
    content: response1.message,
    route: response1.session?.currentRoute?.id,
    step: response1.session?.currentStep?.id,
  });

  // Update session for next turn
  session = response1.session!;

  /**
   * Turn 2: User changes their mind
   */
  console.log("\n--- Turn 2 ---");
  const userMessage2 = {
    role: "user" as const,
    content: "Actually, make that Tokyo instead, and premium class",
    name: "Alice",
  };
  history.push(userMessage2);

  const response2 = await agent.respond({
    history,
    session, // Pass updated session
  });

  console.log("🤖 Agent:", response2.message);
  console.log("📊 Session step after turn 2:", {
    currentRoute: response2.session?.currentRoute?.title,
    currentStep: response2.session?.currentStep?.id,
    data: response2.session?.data,
  });

  // Save messages
  await persistence.saveMessage({
    sessionId: dbSessionId,
    userId,
    role: MessageRole.USER,
    content: userMessage2.content,
  });

  await persistence.saveMessage({
    sessionId: dbSessionId,
    userId,
    role: MessageRole.ASSISTANT,
    content: response2.message,
    route: response2.session?.currentRoute?.id,
    step: response2.session?.currentStep?.id,
  });

  session = response2.session!;

  if (response2.isRouteComplete) {
    console.log("\n✅ Flight booking complete!");
    await sendFlightConfirmation(
      agent.getData(session.id) as FlightBookingData
    );
  }

  /**
   * Load session step from database (demonstrates persistence)
   */
  console.log("\n--- Loading Session from Database ---");
  const loadedSession = await persistence.loadSessionState(dbSessionId);

  console.log("📥 Loaded session step:", {
    currentRoute: loadedSession?.currentRoute?.title,
    currentStep: loadedSession?.currentStep?.id,
    data: loadedSession?.data,
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
 * Advanced Example: Session Step with Lifecycle Hooks
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
    provider: new GeminiProvider({
      apiKey: process.env.GEMINI_API_KEY!,
      model: "models/gemini-2.5-flash",
    }),
    context: {
      userId,
      userName: "Bob",
      preferences: {
        currency: "USD",
        language: "en",
      },
    },
    // Lifecycle hooks for session step enrichment
    hooks: {
      // Enrich collected data before saving
      onDataUpdate: async (
        data: Partial<OnboardingData>,
        previous: Partial<OnboardingData>
      ) => {
        console.log("🔄 Collected data updated:", { data, previous });

        // Normalize phone numbers
        if (data.phoneNumber) {
          data.phoneNumber = data.phoneNumber.replace(/\D/g, "");
        }

        // Validate email
        if (data.email && !data.email.includes("@")) {
          console.warn("⚠️ Invalid email detected");
        }

        return Promise.resolve(data as OnboardingData);
      },

      // Update context when session step changes
      onContextUpdate: async (
        newContext: UserContext,
        oldContext: UserContext
      ) => {
        console.log("🔄 Context updated:", { newContext, oldContext });
        return Promise.resolve();
      },
    },
    persistence: {
      adapter: new PrismaAdapter<UserContext>({ prisma }),
      autoSave: true,
      userId,
    },
  });

  // Create onboarding route
  const onboardingRoute = agent.createRoute<OnboardingData>({
    title: "User Onboarding",
    description: "Collect user information for account setup",
    schema: {
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

  onboardingRoute.initialStep
    .nextStep({
      prompt: "Welcome and ask for name",
      collect: ["fullName"],
      skipIf: (data: Partial<OnboardingData>) => !!data.fullName,
    })
    .nextStep({
      prompt: "Ask for email",
      collect: ["email"],
      skipIf: (data: Partial<OnboardingData>) => !!data.email,
    })
    .nextStep({
      prompt: "Ask for phone number (optional)",
      collect: ["phoneNumber"],
    })
    .nextStep({
      prompt: "Ask for country",
      collect: ["country"],
      skipIf: (data: Partial<OnboardingData>) => !!data.country,
    })
    .nextStep({
      prompt: "Confirm and complete onboarding",
    })
    .nextStep({ step: END_ROUTE });

  const persistence = agent.getPersistenceManager()!;

  // Create session with step
  const { sessionData, sessionStep } = await persistence.createSessionWithStep({
    userId,
    agentName: "Onboarding Assistant",
  });

  console.log("✨ Created onboarding session:", sessionData.id);

  // Simulate conversation
  const session = sessionStep;

  const response = await agent.respond({
    history: [],
    session,
  });

  console.log("🤖 Agent:", response.message);
  console.log("📊 Data so far:", response.session?.data);

  await persistence.saveMessage({
    sessionId: sessionData.id,
    userId,
    role: MessageRole.ASSISTANT,
    content: response.message,
  });

  if (response.isRouteComplete) {
    console.log("\n✅ Onboarding complete!");
    await sendOnboardingEmail(agent.getData(sessionData.id) as OnboardingData);
  }

  console.log("✅ Session step automatically saved to database!");

  await prisma.$disconnect();
}

/**
 * Minimal Example - Quick Start
 */
async function quickStart() {
  const prisma = new PrismaClient();

  const agent = new Agent({
    name: "Support Agent",
    provider: new GeminiProvider({
      apiKey: process.env.GEMINI_API_KEY!,
      model: "models/gemini-2.5-flash",
    }),
    persistence: {
      adapter: new PrismaAdapter<ContactFormData>({ prisma }),
      autoSave: true, // ✨ Automatically saves session step!
      userId: "user_789",
    },
  });

  // Create a simple contact form route
  const contactRoute = agent.createRoute<ContactFormData>({
    title: "Contact Form",
    schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        email: { type: "string" },
        message: { type: "string" },
      },
      required: ["name", "email", "message"],
    },
  });

  contactRoute.initialStep
    .nextStep({
      prompt: "Collect all information",
      collect: ["name", "email", "message"],
    })
    .nextStep({
      prompt: "Confirm submission",
    })
    .nextStep({ step: END_ROUTE });

  const persistence = agent.getPersistenceManager()!;

  // Create session with step support
  const { sessionData, sessionStep } = await persistence.createSessionWithStep({
    userId: "user_789",
    agentName: "Support Agent",
  });

  // Chat!
  const response = await agent.respond({
    history: [
      {
        role: "user" as const,
        content:
          "I need help, my name is John and my email is john@example.com",
        name: "User",
      },
    ],
    session: sessionStep,
  });

  console.log("✅ Response:", response.message);
  console.log("📊 Data:", response.session?.data);

  if (response.isRouteComplete) {
    console.log("\n✅ Contact form submitted!");
    await logContactForm(agent.getData(sessionData.id) as ContactFormData);
  }

  console.log("💾 Session step auto-saved to Prisma!");

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
