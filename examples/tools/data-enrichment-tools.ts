/**
 * Example: Modifying Collected data with Tools and Hooks using ToolManager
 *
 * This demonstrates:
 * 1. Schema-first data extraction with JSON Schema
 * 2. Simplified tools that modify collected data (validation, enrichment)
 * 3. Lifecycle hooks for data validation and business logic
 * 4. Data-driven step flows with code-based logic (skipIf, requires)
 * 5. Three-phase pipeline: PREPARATION → ROUTING → RESPONSE
 * 6. NEW: ToolManager pattern helpers for common data operations
 */

import {
  Agent,
  END_ROUTE,
  OpenAIProvider,
  Tool,
  ToolContext,
  ValidationError,
} from "../../src";

// ==============================================================================
// CONTEXT & COLLECTED DATA TYPES
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

// Tool 1: Convert city names to airport codes using ToolManager pattern helper
const enrichDestinationConfig = {
  id: "enrich_destination",
  name: "Destination Code Lookup", 
  description: "Convert city names to IATA airport codes",
  fields: ["destination"] as const,
  enricher: async (context: FlightBookingContext, data: Pick<FlightData, "destination">) => {
    const destination = data.destination;

    if (!destination) {
      return {};
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
      destinationCode,
    } as Partial<FlightData>;
  },
};

// Tool 2: Parse and validate dates using ToolManager pattern helper
const validateDateConfig = {
  id: "validate_date",
  name: "Date Parser & Validator",
  description: "Parse relative dates (today, tomorrow) to ISO format and validate",
  fields: ["departureDate"] as const,
  enricher: async (context: FlightBookingContext, data: Pick<FlightData, "departureDate">) => {
    const departureDate = data.departureDate;

    if (!departureDate) {
      return {};
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
      departureDateParsed: parsedDate,
    } as Partial<FlightData>;
  },
};

// Tool 3: Search for flights (triggered by flag) using unified Tool interface
const searchFlightsTool: Tool<FlightBookingContext, FlightData> = {
  id: "search_flights",
  name: "Flight Availability Search",
  description: "Search for available flights based on collected data",
  parameters: {
    type: "object",
    properties: {},
  },
  handler: async (toolContext, args) => {
    const flightData = toolContext.data;

    if (!flightData?.destinationCode || !flightData?.departureDateParsed) {
      console.log("[Tool] Cannot search flights: missing required data");
      return { data: "Missing required data for flight search" };
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
      data: `Found ${flights.length} available flights`,
      contextUpdate: {
        availableFlights: flights,
      },
      dataUpdate: {
        shouldSearchFlights: false,
      },
    };
  },
};

// Tool 4: Book the flight using unified Tool interface
const bookFlightTool: Tool<FlightBookingContext, FlightData> = {
  id: "book_flight",
  name: "Flight Booking Processor",
  description: "Finalize the flight booking",
  parameters: {
    type: "object",
    properties: {},
  },
  handler: async (toolContext, args) => {
    const flightData = toolContext.data;
    console.log("[Tool] Booking flight with data:", flightData);
    // Simulate booking API call
    return { data: "Flight booking confirmed!" };
  },
};

// ==============================================================================
// LIFECYCLE HOOKS: Data Validation & Business Logic (RESPONSE Phase)
// ==============================================================================

function onDataUpdate(
  data: Record<string, unknown>,
  previousData: Record<string, unknown>
): Record<string, unknown> {
  console.log("[Hook] onDataUpdate called");
  console.log("  Previous:", previousData);
  console.log("  New:", data);

  // Example: Validate passenger count
  const passengers = data.passengers as number | undefined;
  if (typeof passengers === "number") {
    if (passengers < 1) {
      console.warn("[Hook] Invalid passengers count, setting to 1");
      data.passengers = 1;
    }
    if (passengers > 9) {
      console.warn("[Hook] Too many passengers, capping at 9");
      data.passengers = 9;
    }
  }

  // Example: Normalize cabin class
  const cabinClass = data.cabinClass as string | undefined;
  if (typeof cabinClass === "string") {
    data.cabinClass = cabinClass.toLowerCase();
  }

  // Example: Auto-trigger flight search when we have enough data
  const hasDestination = data.destinationCode || data.destination;
  const hasDate = data.departureDateParsed || data.departureDate;
  const hasPassengers = typeof passengers === "number";

  if (hasDestination && hasDate && hasPassengers && !data.shouldSearchFlights) {
    console.log("[Hook] All required data collected, triggering flight search");
    data.shouldSearchFlights = true;
  }

  return data;
}

// ==============================================================================
// AGENT SETUP
// ==============================================================================

// Define flight booking schema
const flightBookingSchema = {
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
};

const agent = new Agent<FlightBookingContext, FlightData>({
  name: "Flight Booking Agent",
  goal: "Help users book flights efficiently",
  description: "I help you find and book flights",
  provider: new OpenAIProvider({
    apiKey: process.env.OPENAI_API_KEY || "your-api-key-here",
    model: "gpt-4o-mini",
  }),
  context: {},
  // NEW: Agent-level schema
  schema: flightBookingSchema,
  hooks: {
    onDataUpdate, // Validation & enrichment hook
  },
});

// Pattern 1: Using the enrichDestinationConfig with inline tool creation
const enrichDestinationTool = {
  id: "enrich_destination",
  name: "Destination Code Lookup", 
  description: "Convert city names to IATA airport codes",
  parameters: {
    type: "object",
    properties: {},
  },
  handler: async (context: ToolContext<FlightBookingContext, FlightData>, args?: Record<string, unknown>) => {
    const destination = context.data.destination;

    if (!destination) {
      return { data: "No destination to enrich" };
    }

    // Use the original enricher function from the config
    const result = await enrichDestinationConfig.enricher(context.context, { destination });

    console.log(`[Tool] Enriched: ${destination} → ${result.destinationCode}`);

    return {
      data: `Destination code: ${result.destinationCode}`,
      dataUpdate: result,
    };
  },
};

// Pattern 2: Using the validateDateConfig with typed tool interface
const validateDateTool: Tool<FlightBookingContext, FlightData> = {
  id: "validate_date",
  name: "Date Parser & Validator",
  description: "Parse relative dates (today, tomorrow) to ISO format and validate",
  parameters: {
    type: "object",
    properties: {},
  },
  handler: async (context, args) => {
    const departureDate = context.data.departureDate;

    if (!departureDate) {
      return { data: "No departure date to validate" };
    }

    // Use the original enricher function from the config
    const result = await validateDateConfig.enricher(context.context, { departureDate });

    console.log(`[Tool] Parsed date: ${departureDate} → ${result.departureDateParsed}`);

    return {
      data: `Parsed date: ${result.departureDateParsed}`,
      dataUpdate: result,
    };
  },
};

// Demonstrate different registration methods for data enrichment tools

// Method 1: Register enrichment tools for ID-based reference
agent.tool.register(enrichDestinationTool);
agent.tool.register(validateDateTool);

// Method 2: Use registerMany for multiple tools
agent.tool.registerMany([searchFlightsTool, bookFlightTool]);

// Method 3: Create specialized data enrichment tools using the helper
const passengerEnrichmentTool = agent.tool.createDataEnrichment({
  id: "enrich_passenger_info",
  fields: ["passengers"] as const,
  enricher: async (context, data) => {
    // Add passenger type classification - return fields that exist in FlightData
    const cabinClass = data.passengers === 1 ? "business" : data.passengers <= 4 ? "economy" : "economy";
    return {
      cabinClass, // This matches the cabinClass field in FlightData
    };
  },
});

// Method 4: Create validation tool using the helper
const flightDataValidator = agent.tool.createValidation({
  id: "validate_flight_data",
  fields: ["destination", "departureDate", "passengers"] as const,
  validator: async (context, data) => {
    const errors: ValidationError[] = [];
    if (!data.destination) errors.push({ 
      field: "destination", 
      value: data.destination,
      message: "Destination is required",
      schemaPath: "destination"
    });
    if (!data.departureDate) errors.push({ 
      field: "departureDate", 
      value: data.departureDate,
      message: "Departure date is required",
      schemaPath: "departureDate"
    });
    if (!data.passengers || data.passengers < 1) errors.push({ 
      field: "passengers", 
      value: data.passengers,
      message: "At least 1 passenger required",
      schemaPath: "passengers"
    });
    
    return {
      valid: errors.length === 0,
      errors,
      warnings: [],
    };
  },
});

// Define route with data extraction
const bookingRoute = agent.createRoute({
  title: "Book Flight",
  description: "Help user book a flight",
  when: [
    "User wants to book a flight",
    "User mentions flying, traveling, or booking",
  ],
  // NEW: Required fields for route completion
  requiredFields: ["destination", "departureDate", "passengers"],
  // NEW: Optional fields that enhance the experience
  optionalFields: ["destinationCode", "departureDateParsed", "cabinClass", "shouldSearchFlights"],
});

// Method 5: Add route-scoped tools (only available in this route)
bookingRoute.addTool({
  id: "route_specific_tool",
  description: "Tool only available in booking route",
  handler: () => "This tool is scoped to the booking route only",
});

// Step 1: Collect destination
const collectDestination = bookingRoute.initialStep.nextStep({
  prompt: "Ask where they want to fly",
  collect: ["destination"],
  skipIf: (ctx) => !!ctx.data?.destination,
});

// Step 2: Enrich destination (tool execution)
const enrichDestination = collectDestination.nextStep({
  tools: ["enrich_destination"], // Reference by ID
  requires: ["destination"],
});

// Step 3: Collect date
const collectDate = enrichDestination.nextStep({
  prompt: "Ask when they want to depart",
  collect: ["departureDate"],
  skipIf: (ctx) => !!ctx.data?.departureDate,
});

// Step 4: Validate/parse date (tool execution)
const validateDate = collectDate.nextStep({
  tools: ["validate_date"], // Reference by ID
  requires: ["departureDate"],
});

// Step 5: Collect passengers
const collectPassengers = validateDate.nextStep({
  prompt: "Ask how many passengers",
  collect: ["passengers"],
  skipIf: (ctx) => !!ctx.data?.passengers,
});

// Step 6: Search flights (triggered by hook setting shouldSearchFlights)
const searchFlights = collectPassengers.nextStep({
  tools: ["search_flights"], // Reference by ID
  // This step is entered when shouldSearchFlights is true
  // The hook automatically sets this flag when all data is collected
});

// Step 7: Present results
const presentResults = searchFlights.nextStep({
  prompt: "Present available flights to the user",
});

// Step 8: Confirm booking
const confirmBooking = presentResults.nextStep({
  prompt: "Ask user to confirm the booking",
  requires: ["destinationCode", "departureDateParsed", "passengers"],
});

// Method 6: Step-scoped tools can be added via the step's tools array
// Note: Step-scoped tools are typically defined inline in the step configuration

// Step 9: Finalize booking
const finalizeBooking = confirmBooking.nextStep({
  tools: ["book_flight"], // Reference by ID
  when: "User confirms the booking",
});

// Step 10: End of conversation
finalizeBooking.nextStep({ step: END_ROUTE });

// ==============================================================================
// USAGE EXAMPLE: Three-Phase Pipeline Demonstration
// ==============================================================================

async function main() {
  // Session is automatically managed by the agent
  console.log("✨ Session ready:", agent.session.id);

  // Turn 1: User provides everything at once
  await agent.session.addMessage("user", "I want to fly to Paris tomorrow with 2 passengers");

  const response = await agent.respond({ 
    history: agent.session.getHistory() 
  });

  console.log("\n=== RESPONSE ===");
  console.log("Message:", response.message);
  console.log("Data:", agent.session.getData());
  console.log("Context:", agent["context"]);

  await agent.session.addMessage("assistant", response.message);

  if (response.isRouteComplete) {
    console.log("\n✅ Flight booking complete!");
    await sendBookingConfirmation(agent.session.getData());
  }

  /*
   * Expected flow:
   * 1. AI extracts: { destination: "Paris", departureDate: "tomorrow", passengers: 2 }
   * 2. Hook validates passengers ✓
   * 3. Hook detects all data present, sets shouldSearchFlights: true
   * 4. Step machine:
   *    - Skips collectDestination (has destination)
   *    - Runs enrichDestination tool → adds destinationCode: "CDG"
   *    - Skips collectDate (has departureDate)
   *    - Runs validateDate tool → adds departureDateParsed: "2025-10-16"
   *    - Skips collectPassengers (has passengers)
   *    - Runs searchFlights tool → updates context with flights, clears flag
   *    - Enters presentResults step
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
 * 2. CODE-BASED STEP LOGIC
 *    - Use TypeScript functions (skipIf, requires) instead of LLM conditions
 *    - Deterministic flow based on collected data
 *    - No fuzzy LLM interpretation of step logic
 *
 * 3. TOOLS ENRICH COLLECTED DATA (PREPARATION Phase)
 *    - Tools modify collected data via `dataUpdate`
 *    - Great for: validation, enrichment, normalization, computed fields
 *    - Execute before AI sees the conversation
 *
 * 4. LIFECYCLE HOOKS (RESPONSE Phase)
 *    - onDataUpdate runs after each data extraction
 *    - Cross-cutting logic: validation, business rules, auto-triggering
 *    - Return modified collected data
 *
 * 5. THREE-PHASE PIPELINE
 *    - PREPARATION: Tools execute and enrich context/data
 *    - ROUTING: AI scores routes based on current step
 *    - RESPONSE: AI generates message with schema-enforced extraction
 *
 * 6. SESSION STEP MANAGEMENT
 *    - Collected data persists across conversation turns
 *    - Always-on routing respects user intent changes
 *    - Step recovery enables conversation resumption
 */

if (require.main === module) {
  main().catch(console.error);
}
