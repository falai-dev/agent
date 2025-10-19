/**
 * Example: OpenAI Agent with multiple providers
 * Updated for v2 architecture with session step management and schema-first data extraction
 */

import {
  Agent,
  OpenAIProvider,
  type Tool,
  userMessage,
  createSession,
  END_ROUTE,
} from "../../src";

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

// Define a tool that can access collected data
const getWeather: Tool<CustomerContext, unknown[], unknown, WeatherData> = {
  id: "get_weather",
  description: "Get current weather for a location",
  parameters: {
    type: "object",
    properties: {
      location: { type: "string", description: "City name" },
    },
    required: ["location"],
  },
  handler: ({ data }, location) => {
    // Use data location if available, otherwise use args
    const weatherData = data as Partial<WeatherData>;
    const finalLocation = weatherData?.location || location;

    // Simulate API call
    return {
      data: {
        location: finalLocation,
        temperature: 72,
        condition: "Sunny",
      },
    };
  },
};

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
    identity:
      "I am the Assistant, an intelligent AI powered by OpenAI's advanced language models. With access to real-time information and deep reasoning capabilities, I'm here to help you with weather updates, questions, and any information you need.",
    context: {
      customerId: "user123",
      name: "Alice",
      preferences: ["concise answers", "weather updates"],
    },
    provider: openaiProvider,
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
    schema: {
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

  // Step 1: Collect location
  const askLocation = weatherRoute.initialStep.nextStep({
    prompt: "Ask which city they want weather for",
    collect: ["location"],
    skipIf: (data) => !!data.location,
  });

  // Step 2: Get weather data
  const fetchWeather = askLocation.nextStep({
    tools: [getWeather],
    requires: ["location"],
  });

  // Step 3: Present weather information
  const showWeather = fetchWeather.nextStep({
    prompt:
      "Present the weather information in a friendly way with temperature and condition",
  });

  showWeather.nextStep({ step: END_ROUTE });

  // Example conversation with session step management
  console.log("🤖 Starting OpenAI Agent Example\n");

  // Initialize session step for multi-turn conversation
  let session = createSession<WeatherData>();

  // Build history
  const history = [
    userMessage("What's the weather like in San Francisco?", "Alice"),
  ];

  try {
    // Turn 1: Process weather query with session step
    console.log("📤 Processing with session step...");
    const response = await agent.respond({ history, session });

    console.log("\n✅ Agent Configuration:");
    console.log(`   AI Provider: ${openaiProvider.name}`);

    console.log("\n🗺️  Route Configuration:");
    console.log(`   Title: ${weatherRoute.title}`);
    console.log(
      `   Steps: Initial → Ask Location → Fetch Weather → Show Weather`
    );

    console.log("\n💬 Conversation:");
    console.log(`   Customer: ${history[0].content}`);
    console.log(`   Agent: ${response.message}`);
    console.log(`   Route: ${response.session?.currentRoute?.title}`);
    console.log(`   Data:`, response.session?.data);

    // Update session with progress
    session = response.session!;

    // Check for route completion
    if (response.isRouteComplete) {
      console.log("\n✅ Weather route complete!");
      await logWeatherRequest(agent.getData(session.id) as WeatherData);
    }

    console.log("\n✨ Session step benefits:");
    console.log("   ✅ Data extraction tracked across turns");
    console.log("   ✅ Step progression managed automatically");
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
