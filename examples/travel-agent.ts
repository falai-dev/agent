/**
 * Travel agent example (abridged from Python version)
 * Demonstrates route DSL, tools, and guidelines
 */

import {
  Agent,
  defineTool,
  OpenRouterProvider,
  END_ROUTE,
  EventSource,
  createMessageEvent,
} from "../src/index";

// Context type for travel agent
interface TravelContext {
  customerId: string;
  customerName: string;
}

// Tools
const getAvailableDestinations = defineTool<TravelContext, [], string[]>(
  "get_available_destinations",
  async () => {
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

const getAvailableFlights = defineTool<
  TravelContext,
  [destination: string],
  string[]
>(
  "get_available_flights",
  async (_context, destination) => {
    return {
      data: [
        "Flight 123 - June 15, 9:00 AM, $850",
        "Flight 321 - June 16, 2:30 PM, $720",
        "Flight 987 - June 17, 6:45 PM, $680",
      ],
    };
  },
  {
    description: "Get available flights for a destination",
  }
);

const getAlternativeFlights = defineTool<
  TravelContext,
  [destination: string],
  string[]
>(
  "get_alternative_flights",
  async (_context, destination) => {
    return {
      data: [
        "Flight 485 - June 25, 11:00 AM, $920",
        "Flight 516 - July 2, 4:15 PM, $780",
      ],
    };
  },
  {
    description: "Get alternative flight options with different dates",
  }
);

const bookFlight = defineTool<TravelContext, [flightDetails: string], string>(
  "book_flight",
  async ({ context }, flightDetails) => {
    const confirmationNumber = `TRV-${new Date()
      .toISOString()
      .slice(0, 10)
      .replace(/-/g, "")}-001`;
    return {
      data: `Flight booked: ${flightDetails} for ${context.customerName}. Confirmation number: ${confirmationNumber}`,
    };
  },
  {
    description: "Book a flight with the provided details",
  }
);

const getBookingStatus = defineTool<
  TravelContext,
  [confirmationNumber: string],
  object
>(
  "get_booking_status",
  async (_context, confirmationNumber) => {
    return {
      data: {
        status: "Confirmed",
        details: "Flight to Paris on June 15, 9:00 AM. Seat 12A assigned.",
        notes: "Check-in opens 24 hours before departure.",
      },
    };
  },
  {
    description: "Get booking status by confirmation number",
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

  // Create flight booking route
  const flightBookingRoute = agent.createRoute({
    title: "Book a Flight",
    description:
      "Helps the customer find and book a flight to their desired destination.",
    conditions: ["The customer wants to book a flight"],
  });

  // Build the route flow
  const t0 = flightBookingRoute.initialState.transitionTo({
    chatState: "Ask about the destination",
  });

  const t1 = t0.transitionTo({
    chatState: "Ask about preferred travel dates",
  });

  const t2 = t1.transitionTo({
    toolState: getAvailableFlights,
  });

  const t3 = t2.transitionTo({
    chatState: "Present available flights and ask which one works for them",
  });

  // Happy path: customer selects a flight
  const t4 = t3.transitionTo(
    {
      chatState:
        "Collect passenger information and confirm booking details before proceeding",
    },
    "The customer selects a flight"
  );

  const t5 = t4.transitionTo(
    {
      toolState: bookFlight,
    },
    "The customer confirms the booking details"
  );

  const t6 = t5.transitionTo({
    chatState: "Provide confirmation number and booking summary",
  });

  t6.transitionTo({ state: END_ROUTE });

  // Alternative path: no flights work
  const t7 = t3.transitionTo(
    {
      toolState: getAlternativeFlights,
    },
    "None of the flights work for the customer"
  );

  const t8 = t7.transitionTo({
    chatState: "Present alternative flights and ask if any work",
  });

  // Link back to happy path
  t8.transitionTo(
    {
      state: t4,
    },
    "The customer selects a flight"
  );

  // No alternative flights work either
  const t9 = t8.transitionTo(
    {
      chatState:
        "Suggest calling our office or visiting our website for more options",
    },
    "None of the alternative flights work either"
  );

  t9.transitionTo({ state: END_ROUTE });

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

  // Create booking status route
  const bookingStatusRoute = agent.createRoute({
    title: "Check Booking Status",
    description:
      "Retrieves the customer's booking status and provides relevant information.",
    conditions: ["The customer wants to check their booking status"],
  });

  const s0 = bookingStatusRoute.initialState.transitionTo({
    chatState: "Ask for the confirmation number or booking reference",
  });

  const s1 = s0.transitionTo({
    toolState: getBookingStatus,
  });

  s1.transitionTo(
    {
      chatState:
        "Tell the customer that the booking could not be found and ask them to verify the confirmation number or call the office",
    },
    "The booking could not be found"
  );

  s1.transitionTo(
    {
      chatState:
        "Provide the booking details and confirm everything is in order",
    },
    "The booking is confirmed and all details are correct"
  );

  s1.transitionTo(
    {
      chatState:
        "Present the booking information and mention any issues or pending actions required",
    },
    "The booking has issues or requires customer action"
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

// Example usage
async function main() {
  const agent = await createTravelAgent();

  // Simulate a conversation
  const history = [
    createMessageEvent(
      EventSource.CUSTOMER,
      "Customer",
      "Hi, I want to book a flight to Paris"
    ),
  ];

  console.log("Agent:", agent.name);
  console.log("Description:", agent.description);
  console.log("\nRoutes:", agent.getRoutes().length);
  console.log("Terms:", agent.getTerms().length);
  console.log("Guidelines:", agent.getGuidelines().length);

  // Print route structure
  const routes = agent.getRoutes();
  for (const route of routes) {
    console.log("\n" + route.describe());
  }

  // Generate response (would need valid API key)
  // const response = await agent.respond({ history });
  // console.log('\nAgent response:', response.message);
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}

export { createTravelAgent };
