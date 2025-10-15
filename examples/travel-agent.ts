/**
 * Travel agent example with session state management
 * Demonstrates data-driven conversations with schema extraction and state progression
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
  async ({
    context,
    extracted,
  }: ToolContext<TravelContext, FlightBookingData>) => {
    if (!extracted?.destination) {
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
      extractedUpdate: {
        destinationCode: codes[extracted.destination],
      },
    };
  },
  {
    description: "Convert destination name to airport code",
  }
);

const searchFlights = defineTool(
  "search_flights",
  async ({
    context,
    extracted,
  }: ToolContext<TravelContext, FlightBookingData>) => {
    if (!extracted?.destination || !extracted?.departureDate) {
      return { data: [] };
    }

    // Simulate flight search based on extracted data
    const flights = [
      `Flight 123 - ${extracted.departureDate}, 9:00 AM, $${
        800 + Math.floor(Math.random() * 200)
      }`,
      `Flight 321 - ${extracted.departureDate}, 2:30 PM, $${
        700 + Math.floor(Math.random() * 200)
      }`,
      `Flight 987 - ${extracted.departureDate}, 6:45 PM, $${
        600 + Math.floor(Math.random() * 200)
      }`,
    ];

    return {
      data: flights,
      extractedUpdate: {
        shouldSearchFlights: false, // Clear the flag
      },
    };
  },
  {
    description: "Search for flights based on extracted travel data",
  }
);

const bookFlight = defineTool(
  "book_flight",
  async ({
    context,
    extracted,
  }: ToolContext<TravelContext, FlightBookingData>) => {
    if (!extracted) {
      return { data: "Please provide flight details" };
    }

    const confirmationNumber = `TRV-${new Date()
      .toISOString()
      .slice(0, 10)
      .replace(/-/g, "")}-001`;

    return {
      data: `Flight booked for ${context.customerName} to ${extracted.destination}. Confirmation: ${confirmationNumber}`,
    };
  },
  {
    description: "Book a flight using extracted travel data",
  }
);

const getBookingStatus = defineTool<
  TravelContext,
  [],
  { status: string; details: string; notes?: string }
>(
  "get_booking_status",
  async ({
    context,
    extracted,
  }: ToolContext<TravelContext, BookingStatusData>) => {
    if (!extracted?.confirmationNumber) {
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
        details: `Flight booking ${extracted.confirmationNumber} is confirmed.`,
        notes: "Check-in opens 24 hours before departure.",
      },
    };
  },
  {
    description: "Get booking status using extracted confirmation number",
  }
);

// Initialize agent
async function createTravelAgent() {
  const provider = new OpenRouterProvider({
    apiKey: process.env.OPENROUTER_API_KEY || "test-key",
    model: "google/gemini-2.0-flash-exp",
    backupModels: ["anthropic/claude-sonnet-4-5", "openai/gpt-5"],
    siteUrl: "https://github.com/gusnips/falai",
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
    ai: provider,
    context: {
      customerId: "test-123",
      customerName: "Test Customer",
    },
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
  const flightBookingRoute = agent.createRoute<FlightBookingData>({
    title: "Book a Flight",
    description:
      "Helps the customer find and book a flight to their desired destination.",
    conditions: ["The customer wants to book a flight"],
    gatherSchema: {
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

  // Build the route flow with data extraction and smart state progression
  const askDestination = flightBookingRoute.initialState.transitionTo(
    {
      chatState: "Ask about the destination",
      gather: ["destination"],
      skipIf: (extracted) => !!extracted.destination,
    },
    "Customer needs to specify their travel destination"
  );

  const enrichDestination = askDestination.transitionTo(
    {
      toolState: lookupDestinationCode,
      requiredData: ["destination"],
    },
    "Destination provided, lookup airport code"
  );

  const askDates = enrichDestination.transitionTo(
    {
      chatState: "Ask about preferred travel dates",
      gather: ["departureDate"],
      skipIf: (extracted) => !!extracted.departureDate,
      requiredData: ["destination"],
    },
    "Destination confirmed, need travel dates"
  );

  const askPassengers = askDates.transitionTo(
    {
      chatState: "Ask for number of passengers",
      gather: ["passengers"],
      skipIf: (extracted) => !!extracted.passengers,
      requiredData: ["destination", "departureDate"],
    },
    "Dates confirmed, need passenger count"
  );

  const searchFlightsState = askPassengers.transitionTo(
    {
      toolState: searchFlights,
      // Triggered when shouldSearchFlights flag is set by hook
    },
    "All basic info gathered, search for available flights"
  );

  const presentFlights = searchFlightsState.transitionTo(
    {
      chatState: "Present available flights and ask which one works for them",
    },
    "Flight search complete, present options to customer"
  );

  // Happy path: customer selects a flight
  const confirmBooking = presentFlights.transitionTo(
    {
      chatState: "Confirm booking details before proceeding",
      gather: ["cabinClass", "urgency"], // Additional optional data
    },
    "Customer interested in a flight, confirm booking details"
  );

  const bookFlightState = confirmBooking.transitionTo(
    {
      toolState: bookFlight,
    },
    "Customer confirmed, proceed with booking"
  );

  const provideConfirmation = bookFlightState.transitionTo(
    {
      chatState: "Provide confirmation number and booking summary",
    },
    "Booking completed successfully"
  );

  provideConfirmation.transitionTo(
    { state: END_ROUTE },
    "Customer has confirmation, booking flow complete"
  );

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
    gatherSchema: {
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

  const askConfirmation = bookingStatusRoute.initialState.transitionTo(
    {
      chatState: "Ask for the confirmation number or booking reference",
      gather: ["confirmationNumber"],
      skipIf: (extracted) => !!extracted.confirmationNumber,
    },
    "Customer wants to check booking status but hasn't provided confirmation number"
  );

  const checkStatus = askConfirmation.transitionTo(
    {
      toolState: getBookingStatus,
      requiredData: ["confirmationNumber"],
    },
    "Confirmation number provided, look up booking details"
  );

  const provideStatus = checkStatus.transitionTo(
    {
      chatState: "Provide booking status and relevant information",
    },
    "Booking status retrieved successfully"
  );

  provideStatus.transitionTo(
    { state: END_ROUTE },
    "Booking information provided to customer"
  );

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

// Example usage with session state
async function main() {
  const agent = await createTravelAgent();

  // Initialize session state
  let session = createSession<FlightBookingData | BookingStatusData>();

  // Simulate a conversation
  const history = [
    createMessageEvent(
      EventSource.CUSTOMER,
      "Alice",
      "Hi, I want to book a flight to Paris next week with 2 passengers"
    ),
  ];

  console.log("Agent:", agent.name);
  console.log("Description:", agent.description);

  // Turn 1 - Agent extracts data and starts booking flow
  const response1 = await agent.respond({ history, session });
  console.log("\n=== TURN 1 ===");
  console.log("Agent:", response1.message);
  console.log("Route:", response1.session?.currentRoute?.title);
  console.log("State:", response1.session?.currentState?.id);
  console.log("Extracted:", response1.session?.extracted);

  // Session state updated with progress
  session = response1.session!;

  // Turn 2 - Continue with session state
  if (response1.session?.currentRoute?.title === "Book a Flight") {
    const history2 = [
      ...history,
      createMessageEvent(EventSource.AI_AGENT, "Agent", response1.message),
      createMessageEvent(EventSource.CUSTOMER, "Alice", "Economy class please"),
    ];

    const response2 = await agent.respond({ history: history2, session });
    console.log("\n=== TURN 2 ===");
    console.log("Agent:", response2.message);
    console.log("Updated extracted:", response2.session?.extracted);
    console.log("Current state:", response2.session?.currentState?.id);
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
  console.log("\n=== BOOKING STATUS CHECK ===");
  console.log("Agent:", statusResponse.message);
  console.log("Route:", statusResponse.session?.currentRoute?.title);
  console.log("Extracted:", statusResponse.session?.extracted);

  // Show session state management benefits
  console.log("\n=== SESSION STATE BENEFITS ===");
  console.log("✅ Always-on routing - respects user intent changes");
  console.log("✅ Data persistence - extracted data survives across turns");
  console.log(
    "✅ State progression - intelligent flow based on collected data"
  );
  console.log("✅ Context awareness - router sees current progress");
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}

export { createTravelAgent };
