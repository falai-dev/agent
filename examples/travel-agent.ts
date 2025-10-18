/**
 * Travel agent example with session step management
 * Demonstrates data-driven conversations with schema extraction and step progression
 */

import {
  Agent,
  defineTool,
  OpenRouterProvider,
  END_ROUTE,
  EventSource,
  createMessageEvent,
  createSession,
  type ToolContext,
} from "../src/index";

// Context type for travel agent
interface TravelContext {
  customerId: string;
  customerName: string;
}

// Data extraction types for travel booking
interface FlightBookingData {
  destination: string;
  destinationCode?: string; // Enriched by tools
  departureDate: string;
  returnDate?: string;
  passengers: number;
  cabinClass: "economy" | "business" | "first";
  urgency: "low" | "medium" | "high";
  shouldSearchFlights?: boolean; // Action flag
}

interface BookingStatusData {
  confirmationNumber: string;
  email?: string;
}

interface TravelFeedbackData {
  rating: number;
  bookingExperience?: string;
  recommendToFriend?: boolean;
}

// Tools with data access
const getAvailableDestinations = defineTool(
  "get_available_destinations",
  async ({ context }: ToolContext<TravelContext>) => {
    return {
      data: [
        "Paris, France",
        "Tokyo, Japan",
        "Bali, Indonesia",
        "New York, USA",
      ],
    };
  },
  {
    description: "Get list of available travel destinations",
  }
);

const lookupDestinationCode = defineTool(
  "lookup_destination_code",
  async ({ context, data }: ToolContext<TravelContext, FlightBookingData>) => {
    if (!data?.destination) {
      return { data: undefined };
    }

    // Simulate airport code lookup
    const codes: Record<string, string> = {
      "Paris, France": "CDG",
      "Tokyo, Japan": "NRT",
      "Bali, Indonesia": "DPS",
      "New York, USA": "JFK",
    };

    return {
      data: undefined,
      dataUpdate: {
        destinationCode: codes[data.destination],
      },
    };
  },
  {
    description: "Convert destination name to airport code",
  }
);

const searchFlights = defineTool(
  "search_flights",
  async ({ context, data }: ToolContext<TravelContext, FlightBookingData>) => {
    if (!data?.destination || !data?.departureDate) {
      return { data: [] };
    }

    // Simulate flight search based on collected data
    const flights = [
      `Flight 123 - ${data.departureDate}, 9:00 AM, $${
        800 + Math.floor(Math.random() * 200)
      }`,
      `Flight 321 - ${data.departureDate}, 2:30 PM, $${
        700 + Math.floor(Math.random() * 200)
      }`,
      `Flight 987 - ${data.departureDate}, 6:45 PM, $${
        600 + Math.floor(Math.random() * 200)
      }`,
    ];

    return {
      data: flights,
      dataUpdate: {
        shouldSearchFlights: false, // Clear the flag
      },
    };
  },
  {
    description: "Search for flights based on data travel data",
  }
);

const bookFlight = defineTool(
  "book_flight",
  async ({ context, data }: ToolContext<TravelContext, FlightBookingData>) => {
    if (!data) {
      return { data: "Please provide flight details" };
    }

    const confirmationNumber = `TRV-${new Date()
      .toISOString()
      .slice(0, 10)
      .replace(/-/g, "")}-001`;

    return {
      data: `Flight booked for ${context.customerName} to ${data.destination}. Confirmation: ${confirmationNumber}`,
    };
  },
  {
    description: "Book a flight using data travel data",
  }
);

const getBookingStatus = defineTool<
  TravelContext,
  [],
  { status: string; details: string; notes?: string }
>(
  "get_booking_status",
  async ({ context, data }: ToolContext<TravelContext, BookingStatusData>) => {
    if (!data?.confirmationNumber) {
      return {
        data: {
          status: "Error",
          details: "Please provide a confirmation number",
        },
      };
    }

    return {
      data: {
        status: "Confirmed",
        details: `Flight booking ${data.confirmationNumber} is confirmed.`,
        notes: "Check-in opens 24 hours before departure.",
      },
    };
  },
  {
    description: "Get booking status using data confirmation number",
  }
);

// Initialize agent
async function createTravelAgent() {
  const provider = new OpenRouterProvider({
    apiKey: process.env.OPENROUTER_API_KEY || "test-key",
    model: "google/gemini-2.0-flash-exp",
    backupModels: ["anthropic/claude-sonnet-4-5", "openai/gpt-5"],
    siteUrl: "https://github.com/falai-dev/agent",
    siteName: "Falai Travel Agent Example",
    retryConfig: {
      timeout: 60000,
      retries: 3,
    },
  });

  const agent = new Agent<TravelContext>({
    name: "Walker",
    description:
      "A knowledgeable travel agent who helps book flights, answer travel questions, and manage reservations.",
    goal: "Help customers book travel and manage their reservations",
    identity:
      "I am Walker, your friendly and knowledgeable travel companion. I've helped thousands of travelers find their perfect journeys and I'm here to make your travel dreams come true with expert guidance and personalized recommendations.",
    provider: provider,
    context: {
      customerId: "test-123",
      customerName: "Test Customer",
    },
    debug: true,
  });

  // Add domain glossary
  agent.createTerm({
    name: "Office Phone Number",
    description:
      "The phone number of our travel agency office, at +1-800-TRAVEL-1",
    synonyms: ["contact number", "customer service number", "support line"],
  });

  agent.createTerm({
    name: "Travel Insurance",
    description:
      "An optional service that provides coverage for trip cancellations, medical emergencies, lost luggage, and other travel-related issues.",
    synonyms: ["insurance", "trip protection", "travel protection"],
  });

  // Create flight booking route with data extraction
  // NEW: Added onComplete to automatically collect feedback after booking
  const flightBookingRoute = agent.createRoute<FlightBookingData>({
    title: "Book a Flight",
    description:
      "Helps the customer find and book a flight to their desired destination.",
    conditions: ["The customer wants to book a flight"],
    // NEW: Transition to feedback collection after successful booking
    onComplete: (session) => {
      // Dynamic logic: only collect feedback if destination is known
      if (session.data?.destination) {
        return "Travel Feedback";
      }
      return undefined; // No transition
    },
    schema: {
      type: "object",
      properties: {
        destination: {
          type: "string",
          description: "Travel destination",
        },
        destinationCode: {
          type: "string",
          description: "Airport code (enriched by tool)",
        },
        departureDate: {
          type: "string",
          description: "Departure date",
        },
        returnDate: {
          type: "string",
          description: "Return date (optional)",
        },
        passengers: {
          type: "number",
          minimum: 1,
          maximum: 9,
          description: "Number of passengers",
        },
        cabinClass: {
          type: "string",
          enum: ["economy", "business", "first"],
          default: "economy",
          description: "Cabin class preference",
        },
        urgency: {
          type: "string",
          enum: ["low", "medium", "high"],
          default: "medium",
          description: "Travel urgency level",
        },
        shouldSearchFlights: {
          type: "boolean",
          description: "Flag to trigger flight search",
        },
      },
      required: ["destination", "departureDate", "passengers"],
    },
  });

  // Build the route flow with data extraction and smart step progression
  const askDestination = flightBookingRoute.initialStep.nextStep({
    prompt: "Ask about the destination",
    collect: ["destination"],
    skipIf: (data) => !!data.destination,
    condition: "Customer needs to specify their travel destination",
  });

  const enrichDestination = askDestination.nextStep({
    tool: lookupDestinationCode,
    requires: ["destination"],
    condition: "Destination provided, lookup airport code",
  });

  const askDates = enrichDestination.nextStep({
    prompt: "Ask about preferred travel dates",
    collect: ["departureDate"],
    skipIf: (data) => !!data.departureDate,
    requires: ["destination"],
    condition: "Destination confirmed, need travel dates",
  });

  const askPassengers = askDates.nextStep({
    prompt: "Ask for number of passengers",
    collect: ["passengers"],
    skipIf: (data) => !!data.passengers,
    requires: ["destination", "departureDate"],
    condition: "Dates confirmed, need passenger count",
  });

  const searchFlightsStep = askPassengers.nextStep({
    tool: searchFlights,
    // Triggered when shouldSearchFlights flag is set by hook
    condition: "All basic info collected, search for available flights",
  });

  const presentFlights = searchFlightsStep.nextStep({
    prompt: "Present available flights and ask which one works for them",
    condition: "Flight search complete, present options to customer",
  });

  // Happy path: customer selects a flight
  const confirmBooking = presentFlights.nextStep({
    prompt: "Confirm booking details before proceeding",
    collect: ["cabinClass", "urgency"], // Additional optional data
    condition: "Customer interested in a flight, confirm booking details",
  });

  const bookFlightStep = confirmBooking.nextStep({
    tool: bookFlight,
    condition: "Customer confirmed, proceed with booking",
  });

  const provideConfirmation = bookFlightStep.nextStep({
    prompt: "Provide confirmation number and booking summary",
    condition: "Booking completed successfully",
  });

  provideConfirmation.nextStep({
    step: END_ROUTE,
    condition: "Customer has confirmation, booking flow complete",
  });

  // Add route-specific guidelines
  flightBookingRoute.createGuideline({
    condition:
      "The customer mentions they need to travel urgently or it's an emergency",
    action:
      "Direct them to call our office immediately for priority booking assistance",
  });

  flightBookingRoute.createGuideline({
    condition: "The customer asks about visa requirements",
    action:
      "Inform them that visa requirements vary by destination and nationality, and suggest they check with the embassy or consulate",
  });

  // Create booking status route with data extraction
  const bookingStatusRoute = agent.createRoute<BookingStatusData>({
    title: "Check Booking Status",
    description:
      "Retrieves the customer's booking status and provides relevant information.",
    conditions: ["The customer wants to check their booking status"],
    schema: {
      type: "object",
      properties: {
        confirmationNumber: {
          type: "string",
          description: "Booking confirmation number",
        },
        email: {
          type: "string",
          description: "Email address associated with booking (optional)",
        },
      },
      required: ["confirmationNumber"],
    },
  });

  const askConfirmation = bookingStatusRoute.initialStep.nextStep({
    prompt: "Ask for the confirmation number or booking reference",
    collect: ["confirmationNumber"],
    skipIf: (data) => !!data.confirmationNumber,
    condition:
      "Customer wants to check booking status but hasn't provided confirmation number",
  });

  const checkStatus = askConfirmation.nextStep({
    tool: getBookingStatus,
    requires: ["confirmationNumber"],
    condition: "Confirmation number provided, look up booking details",
  });

  const provideStatus = checkStatus.nextStep({
    prompt: "Provide booking status and relevant information",
    condition: "Booking status retrieved successfully",
  });

  provideStatus.nextStep({
    step: END_ROUTE,
    condition: "Booking information provided to customer",
  });

  // NEW: Travel Feedback route - collects feedback after booking
  const feedbackRoute = agent.createRoute<TravelFeedbackData>({
    title: "Travel Feedback",
    description: "Collects customer feedback after flight booking",
    conditions: ["Collect travel booking feedback"],
    schema: {
      type: "object",
      properties: {
        rating: {
          type: "number",
          description: "Overall booking experience rating 1-5",
        },
        bookingExperience: {
          type: "string",
          description: "Description of booking experience",
        },
        recommendToFriend: {
          type: "boolean",
          description: "Would they recommend us to a friend",
        },
      },
      required: ["rating"],
    },
  });

  const askFeedbackRating = feedbackRoute.initialStep.nextStep({
    prompt: "Ask for overall rating from 1 to 5 for the booking experience",
    collect: ["rating"],
    skipIf: (data) => !!data.rating,
  });

  const askRecommendation = askFeedbackRating.nextStep({
    prompt: "Ask if they would recommend our service to a friend (yes/no)",
    collect: ["recommendToFriend"],
  });

  const thankForFeedback = askRecommendation.nextStep({
    prompt: "Thank them for their feedback and wish them a great trip!",
  });

  thankForFeedback.nextStep({ step: END_ROUTE });

  // Global guidelines
  agent.createGuideline({
    condition: "The customer asks about travel insurance",
    action:
      "Explain our travel insurance options, coverage details, and pricing, then offer to add it to their booking",
  });

  agent.createGuideline({
    condition: "The customer asks to speak with a human agent",
    action:
      "Provide the office phone number and office hours, and offer to help them with anything else in the meantime",
  });

  agent.createGuideline({
    condition:
      "The customer inquires about something that has nothing to do with travel",
    action:
      "Kindly tell them you cannot assist with off-topic inquiries - do not engage with their request.",
  });

  return agent;
}

// Example usage with session step
async function main() {
  const agent = await createTravelAgent();

  // Initialize session step
  let session = createSession<FlightBookingData | BookingStatusData>();

  // Simulate a conversation
  const history = [
    createMessageEvent(
      EventSource.CUSTOMER,
      "Alice",
      "Hi, I want to book a flight to Paris next week with 2 passengers"
    ),
  ];

  console.info("Agent:", agent.name);
  console.info("Description:", agent.description);

  // Turn 1 - Agent extracts data and starts booking flow
  const response1 = await agent.respond({ history, session });
  console.info("\n=== TURN 1 ===");
  console.info("Agent:", response1.message);
  console.info("Route:", response1.session?.currentRoute?.title);
  console.info("Step:", response1.session?.currentStep?.id);
  console.info("Data:", response1.session?.data);

  // Session step updated with progress
  session = response1.session!;

  // Turn 2 - Continue with session step
  if (response1.session?.currentRoute?.title === "Book a Flight") {
    const history2 = [
      ...history,
      createMessageEvent(EventSource.AI_AGENT, "Agent", response1.message),
      createMessageEvent(EventSource.CUSTOMER, "Alice", "Economy class please"),
    ];

    const response2 = await agent.respond({ history: history2, session });
    console.info("\n=== TURN 2 ===");
    console.info("Agent:", response2.message);
    console.info("Updated data:", response2.session?.data);
    console.info("Current step:", response2.session?.currentStep?.id);
  }

  // Demonstrate booking status check
  const statusHistory = [
    createMessageEvent(
      EventSource.CUSTOMER,
      "Bob",
      "Can you check my booking status? Confirmation number TRV-20251015-001"
    ),
  ];

  let statusSession = createSession<BookingStatusData>();
  const statusResponse = await agent.respond({
    history: statusHistory,
    session: statusSession,
  });
  console.info("\n=== BOOKING STATUS CHECK ===");
  console.info("Agent:", statusResponse.message);
  console.info("Route:", statusResponse.session?.currentRoute?.title);
  console.info("Data:", statusResponse.session?.data);

  // Show session step management benefits
  console.info("\n=== SESSION STEP BENEFITS ===");
  console.info("✅ Always-on routing - respects user intent changes");
  console.info("✅ Data persistence - collected data survives across turns");
  console.info(
    "✅ Step progression - intelligent flow based on collected data"
  );
  console.info("✅ Context awareness - router sees current progress");

  if (statusResponse.isRouteComplete) {
    console.info("\n✅ Booking status check complete!");
    await logBookingStatusCheck(
      agent.getData(statusResponse.session?.id) as unknown as BookingStatusData
    );
  }
}

/**
 * Mock function to send a booking confirmation.
 * @param data - The flight booking data.
 */
async function sendBookingConfirmation(data: FlightBookingData) {
  console.info("\n" + "=".repeat(60));
  console.info("🚀 Sending Booking Confirmation...");
  console.info("=".repeat(60));
  console.info("Booking Details:", JSON.stringify(data, null, 2));
  console.info(
    `   - Sending confirmation for ${data.passengers} passengers to ${data.destination}.`
  );
  await new Promise((resolve) => setTimeout(resolve, 1000));
  console.info("✨ Confirmation sent!");
}

/**
 * Mock function to log a booking status check.
 * @param data - The booking status data.
 */
async function logBookingStatusCheck(data: BookingStatusData) {
  console.info("\n" + "=".repeat(60));
  console.info("📝 Logging Booking Status Check...");
  console.info("=".repeat(60));
  console.info("Check Details:", JSON.stringify(data, null, 2));
  console.info(
    `   - Logging status check for confirmation #${data.confirmationNumber}.`
  );
  await new Promise((resolve) => setTimeout(resolve, 500));
  console.info("✨ Status check logged!");
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => console.error(err));
}

export { createTravelAgent };
