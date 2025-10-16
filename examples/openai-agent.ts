/**
 * Example: OpenAI Agent with multiple providers
 * Updated for v2 architecture with session state management and schema-first data extraction
 */

import {
  Agent,
  OpenAIProvider,
  defineTool,
  createMessageEvent,
  EventSource,
  createSession,
  END_STATE,
} from "../src/index";

// Custom context type
interface CustomerContext {
  customerId: string;
  name: string;
  preferences: string[];
}

// Data extraction type for weather queries
interface WeatherData {
  location?: string;
  temperature?: number;
  condition?: string;
}

// Define a tool that can access extracted data
const getWeather = defineTool<
  CustomerContext,
  [{ location: string }],
  { location: string; temperature: number; condition: string }
>(
  "get_weather",
  async ({ context, extracted }, args) => {
    // Use extracted location if available, otherwise use args
    const location =
      (extracted as Partial<WeatherData>)?.location || args.location;

    // Simulate API call
    return {
      data: {
        location,
        temperature: 72,
        condition: "Sunny",
      },
    };
  },
  {
    description: "Get current weather for a location",
    parameters: {
      location: { type: "string", description: "City name" },
    },
  }
);

async function main() {
  // Initialize OpenAI provider
  const openaiProvider = new OpenAIProvider({
    apiKey: process.env.OPENAI_API_KEY || "",
    model: "gpt-5", // Latest model
    config: {
      temperature: 0.7,
      max_tokens: 1000,
    },
    // Optional: customize backup models
    backupModels: ["gpt-5-mini", "gpt-5-nano"],
    // Optional: customize retry config
    retryConfig: {
      timeout: 30000,
      retries: 2,
    },
  });

  // Create agent with OpenAI
  const agent = new Agent<CustomerContext>({
    name: "Assistant",
    description:
      "A helpful AI assistant that can check weather and answer questions",
    goal: "Assist users with information and weather queries",
    context: {
      customerId: "user123",
      name: "Alice",
      preferences: ["concise answers", "weather updates"],
    },
    ai: openaiProvider,
  });

  // Add domain knowledge
  agent
    .createTerm({
      name: "Weather Service",
      description: "Our real-time weather information service",
      synonyms: ["weather API", "forecast service"],
    })
    .createGuideline({
      action:
        "Always provide temperature in Fahrenheit and include the current condition",
      tags: ["weather", "formatting"],
      enabled: true,
    })
    .createGuideline({
      condition: "User asks for weather in multiple cities",
      action: "Offer to check weather for each city one by one",
      enabled: true,
    });

  // Create weather route with data extraction schema
  const weatherRoute = agent.createRoute<WeatherData>({
    title: "Check Weather",
    description: "Help user check weather for a location",
    conditions: ["User wants to know the weather"],
    extractionSchema: {
      type: "object",
      properties: {
        location: {
          type: "string",
          description: "City or location for weather check",
        },
        temperature: {
          type: "number",
          description: "Temperature in Fahrenheit",
        },
        condition: {
          type: "string",
          description: "Weather condition (sunny, cloudy, rainy, etc.)",
        },
      },
      required: ["location"],
    },
  });

  // State 1: Gather location
  const askLocation = weatherRoute.initialState.transitionTo({
    chatState: "Ask which city they want weather for",
    gather: ["location"],
    skipIf: (extracted) => !!extracted.location,
  });

  // State 2: Get weather data
  const fetchWeather = askLocation.transitionTo({
    toolState: getWeather,
    requiredData: ["location"],
  });

  // State 3: Present weather information
  const showWeather = fetchWeather.transitionTo({
    chatState:
      "Present the weather information in a friendly way with temperature and condition",
  });

  showWeather.transitionTo({ state: END_STATE });

  // Example conversation with session state management
  console.log("🤖 Starting OpenAI Agent Example\n");

  // Initialize session state for multi-turn conversation
  let session = createSession<WeatherData>();

  // Build history
  const history = [
    createMessageEvent(
      EventSource.CUSTOMER,
      "Alice",
      "What's the weather like in San Francisco?"
    ),
  ];

  try {
    // Turn 1: Process weather query with session state
    console.log("📤 Processing with session state...");
    const response = await agent.respond({ history, session });

    console.log("\n✅ Agent Configuration:");
    console.log(`   AI Provider: ${openaiProvider.name}`);

    console.log("\n🗺️  Route Configuration:");
    console.log(`   Title: ${weatherRoute.title}`);
    console.log(
      `   States: Initial → Ask Location → Fetch Weather → Show Weather`
    );

    console.log("\n💬 Conversation:");
    console.log(`   Customer: ${history[0].data.message}`);
    console.log(`   Agent: ${response.message}`);
    console.log(`   Route: ${response.session?.currentRoute?.title}`);
    console.log(`   Extracted:`, response.session?.extracted);

    // Update session with progress
    session = response.session!;

    // Check for route completion
    if (response.isRouteComplete) {
      console.log("\n✅ Weather route complete!");
      await logWeatherRequest(
        agent.getExtractedData(session.id) as WeatherData
      );
    }

    console.log("\n✨ Session state benefits:");
    console.log("   ✅ Data extraction tracked across turns");
    console.log("   ✅ State progression managed automatically");
    console.log("   ✅ Always-on routing respects intent changes");
    console.log(
      "   (Set OPENAI_API_KEY environment variable to make actual API calls)"
    );
  } catch (error) {
    console.error("❌ Error:", error);
  }
}

/**
 * Mock function to log the weather request for analytics.
 * @param data - The weather data from the completed route.
 */
async function logWeatherRequest(data: WeatherData) {
  console.log("\n" + "=".repeat(60));
  console.log("📊 Logging Weather Request for Analytics...");
  console.log("=".repeat(60));
  console.log("Request Details:", JSON.stringify(data, null, 2));
  console.log(`   - Logging request for location: ${data.location}`);
  await new Promise((resolve) => setTimeout(resolve, 500));
  console.log("✨ Request logged!");
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}

export { main };
