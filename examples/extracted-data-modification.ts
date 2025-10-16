/**
 * Example: Modifying Extracted Data with Tools and Hooks
 *
 * This demonstrates:
 * 1. Schema-first data extraction with JSON Schema
 * 2. Tools that modify extracted data (validation, enrichment)
 * 3. Lifecycle hooks for data validation and business logic
 * 4. Data-driven state flows with code-based logic (skipIf, requiredData)
 * 5. Three-phase pipeline: PREPARATION → ROUTING → RESPONSE
 */

import {
  Agent,
  createSession,
  EventSource,
  createMessageEvent,
  END_STATE,
  OpenAIProvider,
} from "../src";
import type { Event } from "../src/types";
import type { ToolRef } from "../src/types/tool";

// ==============================================================================
// CONTEXT & EXTRACTED DATA TYPES
// ==============================================================================

interface FlightBookingContext {
  availableFlights?: Array<{
    flightNumber: string;
    price: number;
    departure: string;
    arrival: string;
  }>;
  airportCodes?: Record<string, string>;
}

interface FlightData {
  destination: string;
  destinationCode?: string; // Enriched by tool
  departureDate: string;
  departureDateParsed?: string; // Enriched by tool
  passengers: number;
  cabinClass: "economy" | "business" | "first";
  shouldSearchFlights?: boolean; // Trigger flag
}

// ==============================================================================
// TOOLS: Data Enrichment (PREPARATION Phase)
// ==============================================================================

// Tool 1: Convert city names to airport codes
const enrichDestinationTool: ToolRef<
  FlightBookingContext,
  [],
  void,
  FlightData
> = {
  id: "enrich_destination",
  name: "Enrich Destination",
  description: "Convert city names to IATA airport codes",
  handler: async (context) => {
    const { extracted } = context;
    const destination = (extracted as Partial<FlightData>)?.destination;

    if (!destination) {
      return { data: undefined };
    }

    // Simulate airport code lookup
    const airportCodes: Record<string, string> = {
      Paris: "CDG",
      London: "LHR",
      "New York": "JFK",
      Tokyo: "NRT",
      "Los Angeles": "LAX",
    };

    const destinationCode = airportCodes[destination];

    console.log(`[Tool] Enriched: ${destination} → ${destinationCode}`);

    return {
      data: undefined,
      extractedUpdate: {
        destinationCode,
      } as Partial<FlightData>,
    };
  },
};

// Tool 2: Parse and validate dates
const validateDateTool: ToolRef<FlightBookingContext, [], void, FlightData> = {
  id: "validate_date",
  name: "Validate Date",
  description:
    "Parse relative dates (today, tomorrow) to ISO format and validate",
  handler: async (context) => {
    const { extracted } = context;
    const departureDate = (extracted as Partial<FlightData>)?.departureDate;

    if (!departureDate) {
      return { data: undefined };
    }

    let parsedDate: string;
    const today = new Date();

    // Parse relative dates
    if (departureDate.toLowerCase() === "today") {
      parsedDate = today.toISOString().split("T")[0];
    } else if (departureDate.toLowerCase() === "tomorrow") {
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);
      parsedDate = tomorrow.toISOString().split("T")[0];
    } else if (departureDate.toLowerCase().startsWith("next ")) {
      // Handle "next week", "next month", etc.
      const nextWeek = new Date(today);
      nextWeek.setDate(nextWeek.getDate() + 7);
      parsedDate = nextWeek.toISOString().split("T")[0];
    } else {
      // Assume it's already in a proper format
      parsedDate = departureDate;
    }

    // Validate that date isn't in the past
    const parsedDateObj = new Date(parsedDate);
    if (parsedDateObj < today) {
      console.warn(`[Tool] Warning: Date ${parsedDate} is in the past`);
      // You could throw an error here or set a flag
    }

    console.log(`[Tool] Parsed date: ${departureDate} → ${parsedDate}`);

    return {
      data: undefined,
      extractedUpdate: {
        departureDateParsed: parsedDate,
      } as Partial<FlightData>,
    };
  },
};

// Tool 3: Search for flights (triggered by flag)
const searchFlightsTool: ToolRef<FlightBookingContext, [], void, FlightData> = {
  id: "search_flights",
  name: "Search Flights",
  description: "Search for available flights based on gathered data",
  handler: async (context) => {
    const { extracted } = context;
    const flightData = extracted as Partial<FlightData>;

    if (!flightData?.destinationCode || !flightData?.departureDateParsed) {
      console.log("[Tool] Cannot search flights: missing required data");
      return { data: undefined };
    }

    // Simulate flight search API call
    const flights = [
      {
        flightNumber: "UA123",
        price: 450,
        departure: "08:00",
        arrival: "14:30",
      },
      {
        flightNumber: "DL456",
        price: 520,
        departure: "10:30",
        arrival: "16:45",
      },
    ];

    console.log(
      `[Tool] Found ${flights.length} flights to ${flightData.destinationCode}`
    );

    return {
      data: undefined,
      contextUpdate: {
        availableFlights: flights,
      },
      extractedUpdate: {
        shouldSearchFlights: false, // Clear the flag to prevent re-execution
      } as Partial<FlightData>,
    };
  },
};

// Tool 4: Book the flight
const bookFlightTool: ToolRef<FlightBookingContext, [], void, FlightData> = {
  id: "book_flight",
  name: "Book Flight",
  description: "Finalize the flight booking",
  handler: async (context) => {
    const { extracted } = context;
    const flightData = extracted as Partial<FlightData>;
    console.log("[Tool] Booking flight with data:", flightData);
    // Simulate booking API call
    return { data: undefined };
  },
};

// ==============================================================================
// LIFECYCLE HOOKS: Data Validation & Business Logic (RESPONSE Phase)
// ==============================================================================

async function onExtractedUpdate(
  extracted: Record<string, unknown>,
  previousExtracted: Record<string, unknown>
): Promise<Record<string, unknown>> {
  console.log("[Hook] onExtractedUpdate called");
  console.log("  Previous:", previousExtracted);
  console.log("  New:", extracted);

  // Example: Validate passenger count
  const passengers = extracted.passengers as number | undefined;
  if (typeof passengers === "number") {
    if (passengers < 1) {
      console.warn("[Hook] Invalid passengers count, setting to 1");
      extracted.passengers = 1;
    }
    if (passengers > 9) {
      console.warn("[Hook] Too many passengers, capping at 9");
      extracted.passengers = 9;
    }
  }

  // Example: Normalize cabin class
  const cabinClass = extracted.cabinClass as string | undefined;
  if (typeof cabinClass === "string") {
    extracted.cabinClass = cabinClass.toLowerCase();
  }

  // Example: Auto-trigger flight search when we have enough data
  const hasDestination = extracted.destinationCode || extracted.destination;
  const hasDate = extracted.departureDateParsed || extracted.departureDate;
  const hasPassengers = typeof passengers === "number";

  if (
    hasDestination &&
    hasDate &&
    hasPassengers &&
    !extracted.shouldSearchFlights
  ) {
    console.log("[Hook] All required data gathered, triggering flight search");
    extracted.shouldSearchFlights = true;
  }

  return extracted;
}

// ==============================================================================
// AGENT SETUP
// ==============================================================================

const agent = new Agent<FlightBookingContext>({
  name: "Flight Booking Agent",
  goal: "Help users book flights efficiently",
  description: "I help you find and book flights",
  ai: new OpenAIProvider({
    apiKey: process.env.OPENAI_API_KEY || "your-api-key-here",
    model: "gpt-5o-mini",
  }),
  context: {},
  hooks: {
    onExtractedUpdate, // Validation & enrichment hook
  },
});

// Define route with data extraction
const bookingRoute = agent.createRoute<FlightData>({
  title: "Book Flight",
  description: "Help user book a flight",
  conditions: [
    "User wants to book a flight",
    "User mentions flying, traveling, or booking",
  ],
  extractionSchema: {
    type: "object",
    properties: {
      destination: {
        type: "string",
        description: "City or airport the user wants to fly to",
      },
      destinationCode: {
        type: "string",
        description: "IATA airport code (enriched by tool)",
      },
      departureDate: {
        type: "string",
        description: "When the user wants to depart",
      },
      departureDateParsed: {
        type: "string",
        description: "Parsed ISO date (enriched by tool)",
      },
      passengers: {
        type: "number",
        minimum: 1,
        maximum: 9,
      },
      cabinClass: {
        type: "string",
        enum: ["economy", "business", "first"],
        default: "economy",
      },
      shouldSearchFlights: {
        type: "boolean",
        description: "Flag to trigger flight search",
      },
    },
    required: ["destination", "departureDate", "passengers"],
  },
});

// State 1: Gather destination
const gatherDestination = bookingRoute.initialState.transitionTo({
  chatState: "Ask where they want to fly",
  gather: ["destination"],
  skipIf: (data) => !!data.destination,
});

// State 2: Enrich destination (tool execution)
const enrichDestination = gatherDestination.transitionTo({
  toolState: enrichDestinationTool,
  requiredData: ["destination"],
});

// State 3: Gather date
const gatherDate = enrichDestination.transitionTo({
  chatState: "Ask when they want to depart",
  gather: ["departureDate"],
  skipIf: (data) => !!data.departureDate,
});

// State 4: Validate/parse date (tool execution)
const validateDate = gatherDate.transitionTo({
  toolState: validateDateTool,
  requiredData: ["departureDate"],
});

// State 5: Gather passengers
const gatherPassengers = validateDate.transitionTo({
  chatState: "Ask how many passengers",
  gather: ["passengers"],
  skipIf: (data) => !!data.passengers,
});

// State 6: Search flights (triggered by hook setting shouldSearchFlights)
const searchFlights = gatherPassengers.transitionTo({
  toolState: searchFlightsTool,
  // This state is entered when shouldSearchFlights is true
  // The hook automatically sets this flag when all data is gathered
});

// State 7: Present results
const presentResults = searchFlights.transitionTo({
  chatState: "Present available flights to the user",
});

// State 8: Confirm booking
const confirmBooking = presentResults.transitionTo({
  chatState: "Ask user to confirm the booking",
  requiredData: ["destinationCode", "departureDateParsed", "passengers"],
});

// State 9: Finalize booking
const finalizeBooking = confirmBooking.transitionTo({
  toolState: bookFlightTool,
  condition: "User confirms the booking",
});

// State 10: End of conversation
finalizeBooking.transitionTo({ state: END_STATE });

// ==============================================================================
// USAGE EXAMPLE: Three-Phase Pipeline Demonstration
// ==============================================================================

async function main() {
  let session = createSession<FlightData>();

  // Turn 1: User provides everything at once
  const history: Event[] = [
    createMessageEvent(
      EventSource.CUSTOMER,
      "User",
      "I want to fly to Paris tomorrow with 2 passengers"
    ),
  ];

  const response = await agent.respond({ history, session });

  console.log("\n=== RESPONSE ===");
  console.log("Message:", response.message);
  console.log("Extracted:", response.session?.extracted);
  console.log("Context:", agent["context"]);

  if (response.isRouteComplete) {
    console.log("\n✅ Flight booking complete!");
    await sendBookingConfirmation(response.session?.extracted);
  }

  /*
   * Expected flow:
   * 1. AI extracts: { destination: "Paris", departureDate: "tomorrow", passengers: 2 }
   * 2. Hook validates passengers ✓
   * 3. Hook detects all data present, sets shouldSearchFlights: true
   * 4. State machine:
   *    - Skips gatherDestination (has destination)
   *    - Runs enrichDestination tool → adds destinationCode: "CDG"
   *    - Skips gatherDate (has departureDate)
   *    - Runs validateDate tool → adds departureDateParsed: "2025-10-16"
   *    - Skips gatherPassengers (has passengers)
   *    - Runs searchFlights tool → updates context with flights, clears flag
   *    - Enters presentResults state
   * 5. AI generates response with flight options
   */
}

/**
 * Mock function to send a booking confirmation.
 * @param data - The flight booking data.
 */
async function sendBookingConfirmation(data: Partial<FlightData> | undefined) {
  console.log("\n" + "=".repeat(60));
  console.log("🚀 Sending Booking Confirmation...");
  console.log("=".repeat(60));
  console.log("Booking Details:", JSON.stringify(data, null, 2));
  console.log(
    `   - Sending confirmation for flight to ${data?.destinationCode} on ${
      data?.departureDateParsed ?? ""
    }.`
  );
  await new Promise((resolve) => setTimeout(resolve, 1000));
  console.log("✨ Confirmation sent!");
}

// ==============================================================================
// KEY TAKEAWAYS: Architecture Principles Demonstrated
// ==============================================================================

/*
 * 1. SCHEMA-FIRST DATA EXTRACTION
 *    - Define data contracts upfront with JSON Schema
 *    - Type-safe extraction throughout the conversation
 *    - Predictable data structure every time
 *
 * 2. CODE-BASED STATE LOGIC
 *    - Use TypeScript functions (skipIf, requiredData) instead of LLM conditions
 *    - Deterministic flow based on extracted data
 *    - No fuzzy LLM interpretation of state logic
 *
 * 3. TOOLS ENRICH EXTRACTED DATA (PREPARATION Phase)
 *    - Tools modify extracted data via `extractedUpdate`
 *    - Great for: validation, enrichment, normalization, computed fields
 *    - Execute before AI sees the conversation
 *
 * 4. LIFECYCLE HOOKS (RESPONSE Phase)
 *    - onExtractedUpdate runs after each data extraction
 *    - Cross-cutting logic: validation, business rules, auto-triggering
 *    - Return modified extracted data
 *
 * 5. THREE-PHASE PIPELINE
 *    - PREPARATION: Tools execute and enrich context/data
 *    - ROUTING: AI scores routes based on current state
 *    - RESPONSE: AI generates message with schema-enforced extraction
 *
 * 6. SESSION STATE MANAGEMENT
 *    - Extracted data persists across conversation turns
 *    - Always-on routing respects user intent changes
 *    - State recovery enables conversation resumption
 */

if (require.main === module) {
  main().catch(console.error);
}
