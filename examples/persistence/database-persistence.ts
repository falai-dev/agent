/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
/**
 * Example: Using Prisma ORM for Persistence with New Session Management
 *
 * This example demonstrates the new automatic session management features:
 * - Automatic session creation and loading with sessionId
 * - Built-in conversation history management
 * - Simplified server-side usage patterns
 * - SessionManager API for direct session control
 */

import {
  Agent,
  GeminiProvider,
  PrismaAdapter,
  END_ROUTE,
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

  /**
   * Server-Style Usage: Create Agent per request with sessionId
   * This is the recommended pattern for server environments
   */
  const sessionId = "session_user123_booking"; // Could be from request params

  const agent = new Agent<ConversationContext, FlightBookingData>({
    name: "Travel Assistant",
    description: "A helpful travel booking assistant",
    goal: "Help users book flights with ease",
    provider: new GeminiProvider({
      apiKey: process.env.GEMINI_API_KEY!,
      model: "models/gemini-2.5-flash",
    }),
    context: {
      userId: "user_123",
      userName: "Alice",
    },
    persistence: {
      adapter: new PrismaAdapter<ConversationContext>({ prisma }),
      autoSave: true, // Auto-saves session after each response
    },
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
    sessionId, // ✨ Agent will automatically load or create this session
  });

  /**
   * Create a route with data extraction schema
   */
  const flightRoute = agent.createRoute({
    title: "Book a Flight",
    description: "Help user book a flight ticket",
    conditions: [
      "User wants to book a flight",
      "User mentions travel, flying, or booking tickets",
    ],
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
   * Session is automatically loaded/created by Agent constructor
   * Access it through agent.session
   */
  console.log("✨ Session ready:", agent.session.id);
  console.log("📊 Session data:", agent.session.getData());
  console.log("📜 Conversation history:", agent.session.getHistory().length, "messages");

  // Set some initial data if this is a new session
  if (!agent.session.getData()?.cabinClass) {
    await agent.session.setData({ cabinClass: "economy" });
  }

  /**
   * Turn 1: Simple message-based conversation
   * SessionManager automatically handles history and persistence
   */
  console.log("\n--- Turn 1 ---");
  
  // Add user message to session history and get response
  await agent.session.addMessage("user", "I want to fly to Paris on June 15 with 2 people", "Alice");
  
  const response1 = await agent.respond({
    history: agent.session.getHistory(), // Use session-managed history
  });

  console.log("🤖 Agent:", response1.message);
  console.log("📊 Session after turn 1:", {
    sessionId: agent.session.id,
    currentRoute: response1.session?.currentRoute?.title,
    currentStepId: response1.session?.currentStep?.id,
    data: agent.session.getData(),
  });

  // Add agent response to session history
  await agent.session.addMessage("assistant", response1.message);

  /**
   * Turn 2: User changes their mind
   */
  console.log("\n--- Turn 2 ---");
  
  await agent.session.addMessage("user", "Actually, make that Tokyo instead, and premium class", "Alice");

  const response2 = await agent.respond({
    history: agent.session.getHistory(),
  });

  console.log("🤖 Agent:", response2.message);
  console.log("📊 Session after turn 2:", {
    currentRoute: response2.session?.currentRoute?.title,
    currentStep: response2.session?.currentStep?.id,
    data: agent.session.getData(),
  });

  await agent.session.addMessage("assistant", response2.message);

  if (response2.isRouteComplete) {
    console.log("\n✅ Flight booking complete!");
    await sendFlightConfirmation(agent.session.getData());
  }

  /**
   * Demonstrate session recovery - create new Agent instance with same sessionId
   */
  console.log("\n--- Session Recovery (New Agent Instance) ---");
  
  const newAgent = new Agent<ConversationContext, FlightBookingData>({
    name: "Travel Assistant",
    provider: new GeminiProvider({
      apiKey: process.env.GEMINI_API_KEY!,
      model: "models/gemini-2.5-flash",
    }),
    context: {
      userId: "user_123",
      userName: "Alice",
    },
    // NEW: Agent-level schema (same as original agent)
    schema: {
      type: "object",
      properties: {
        destination: { type: "string" },
        departureDate: { type: "string" },
        returnDate: { type: "string" },
        passengers: { type: "number", minimum: 1, maximum: 9 },
        cabinClass: { type: "string", enum: ["economy", "premium", "business", "first"] },
      },
      required: ["destination", "departureDate", "passengers", "cabinClass"],
    },
    persistence: {
      adapter: new PrismaAdapter<ConversationContext>({ prisma }),
    },
    sessionId, // Same sessionId - will load existing session
  });

  console.log("📥 Recovered session:", {
    sessionId: newAgent.session.id,
    historyLength: newAgent.session.getHistory().length,
    data: newAgent.session.getData(),
  });

  /**
   * Continue conversation with recovered session
   */
  await newAgent.session.addMessage("user", "Can you confirm my booking details?");
  
  const confirmResponse = await newAgent.respond({
    history: newAgent.session.getHistory(),
  });
  
  console.log("🤖 Confirmation:", confirmResponse.message);
  await newAgent.session.addMessage("assistant", confirmResponse.message);

  /**
   * Cleanup
   */
  await prisma.$disconnect();
}

/**
 * Advanced Example: SessionManager with History Management
 */
async function advancedExample() {
  const prisma = new PrismaClient();
  const sessionId = "session_user456_onboarding";

  interface UserContext {
    userId: string;
    userName: string;
    preferences: {
      currency: string;
      language: string;
    };
  }

  const agent = new Agent<UserContext, OnboardingData>({
    name: "Onboarding Assistant",
    description: "Help new users get started",
    provider: new GeminiProvider({
      apiKey: process.env.GEMINI_API_KEY!,
      model: "models/gemini-2.5-flash",
    }),
    context: {
      userId: "user_456",
      userName: "Bob",
      preferences: {
        currency: "USD",
        language: "en",
      },
    },
    // Lifecycle hooks for data enrichment
    hooks: {
      onDataUpdate: async (
        data: Partial<OnboardingData>,
        previous: Partial<OnboardingData>
      ) => {
        console.log("🔄 Data updated:", { data, previous });

        // Normalize phone numbers
        if (data.phoneNumber) {
          data.phoneNumber = data.phoneNumber.replace(/\D/g, "");
        }

        // Validate email
        if (data.email && !data.email.includes("@")) {
          console.warn("⚠️ Invalid email detected");
        }

        return data as OnboardingData;
      },

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
    },
    sessionId,
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

  // Create onboarding route
  const onboardingRoute = agent.createRoute({
    title: "User Onboarding",
    description: "Collect user information for account setup",
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

  console.log("✨ Onboarding session ready:", agent.session.id);

  // Demonstrate history override for context setting
  const contextHistory = [
    { role: "system" as const, content: "User is starting onboarding process" },
    { role: "user" as const, content: "I'd like to create an account" },
  ];

  const response = await agent.respond({
    history: contextHistory, // Override session history for this response
  });

  console.log("🤖 Agent:", response.message);
  console.log("📊 Data collected:", agent.session.getData());

  // Add to session history for future responses
  await agent.session.addMessage("user", "I'd like to create an account");
  await agent.session.addMessage("assistant", response.message);

  // Continue with session-managed history
  await agent.session.addMessage("user", "My name is Bob Johnson and email is bob@example.com");
  
  const response2 = await agent.respond({
    history: agent.session.getHistory(),
  });

  console.log("🤖 Agent:", response2.message);
  console.log("📊 Normalized data:", agent.session.getData());
  // Shows normalized phone and email

  if (response2.isRouteComplete) {
    console.log("\n✅ Onboarding complete!");
    await sendOnboardingEmail(agent.session.getData());
  }

  await prisma.$disconnect();
}

/**
 * Minimal Example - Server Endpoint Pattern
 */
async function serverEndpointExample() {
  const prisma = new PrismaClient();

  // Simulate server endpoint receiving request
  const requestData = {
    sessionId: "session_user789_support", // From client
    message: "I need help, my name is John and my email is john@example.com",
  };

  // Define contact form schema
  const contactFormSchema = {
    type: "object",
    properties: {
      name: { type: "string" },
      email: { type: "string" },
      message: { type: "string" },
    },
    required: ["name", "email", "message"],
  };

  // Create agent with sessionId (loads existing or creates new)
  const agent = new Agent<unknown, ContactFormData>({
    name: "Support Agent",
    provider: new GeminiProvider({
      apiKey: process.env.GEMINI_API_KEY!,
      model: "models/gemini-2.5-flash",
    }),
    // NEW: Agent-level schema
    schema: contactFormSchema,
    persistence: {
      adapter: new PrismaAdapter<unknown>({ prisma }),
      autoSave: true,
    },
    sessionId: requestData.sessionId, // ✨ Automatic session management
  });

  // Create a simple contact form route
  const contactRoute = agent.createRoute({
    title: "Contact Form",
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

  // Add user message and respond
  await agent.session.addMessage("user", requestData.message);
  
  const response = await agent.respond({
    history: agent.session.getHistory(),
  });

  await agent.session.addMessage("assistant", response.message);

  // Return response (like in a REST API)
  const apiResponse = {
    message: response.message,
    sessionId: agent.session.id,
    isComplete: response.isRouteComplete,
    data: agent.session.getData(),
  };

  console.log("✅ API Response:", apiResponse);

  if (response.isRouteComplete) {
    console.log("\n✅ Contact form submitted!");
    await logContactForm(agent.session.getData());
  }

  await prisma.$disconnect();
  return apiResponse;
}

/**
 * Mock function to send a flight confirmation email.
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

export { example, advancedExample, serverEndpointExample };
