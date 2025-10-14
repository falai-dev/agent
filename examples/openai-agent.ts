/**
 * Example: OpenAI Agent with multiple providers
 *
 * This example demonstrates how to use the OpenAI provider
 * and how to switch between different AI providers
 */

import {
  Agent,
  OpenAIProvider,
  defineTool,
  createMessageEvent,
  EventSource,
} from "../src/index";

// Custom context type
interface CustomerContext {
  customerId: string;
  name: string;
  preferences: string[];
}

// Define a simple tool
const getWeather = defineTool<
  CustomerContext,
  [{ location: string }],
  { location: string; temperature: number; condition: string }
>(
  "get_weather",
  async (_context, args) => {
    // Simulate API call
    return {
      data: {
        location: args.location,
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

  // Create a simple route
  const weatherRoute = agent.createRoute({
    title: "Check Weather",
    description: "Help user check weather for a location",
    conditions: ["User wants to know the weather"],
  });

  // Add states and transitions
  const askLocation = weatherRoute.initialState.transitionTo({
    chatState: "Ask which city they want weather for",
  });

  const fetchWeather = askLocation.transitionTo(
    {
      toolState: getWeather,
    },
    "User provides a city name"
  );

  const showWeather = fetchWeather.transitionTo({
    chatState:
      "Present the weather information in a friendly way with temperature and condition",
  });

  // Simulate a conversation
  console.log("🤖 Starting OpenAI Agent Example\n");

  // Build history
  const history = [
    createMessageEvent(
      EventSource.CUSTOMER,
      "Alice",
      "What's the weather like in San Francisco?"
    ),
  ];

  try {
    // Generate response (this would call OpenAI)
    console.log("📤 Sending request to OpenAI...");

    // In a real scenario, you would call agent.generateMessage() or similar
    // For now, let's just show the structure:
    console.log("\n✅ Agent Configuration:");
    console.log(`   AI Provider: ${openaiProvider.name}`);

    console.log("\n🗺️  Route Configuration:");
    console.log(`   Title: ${weatherRoute.title}`);
    console.log(
      `   States: Initial → Ask Location → Fetch Weather → Show Weather`
    );

    console.log("\n💬 Conversation History:");
    history.forEach((event, i) => {
      console.log(`   ${i + 1}. ${event.source}: ${event.data.message}`);
    });

    console.log("\n✨ Ready to process with OpenAI provider!");
    console.log(
      "   (Set OPENAI_API_KEY environment variable to make actual API calls)"
    );
  } catch (error) {
    console.error("❌ Error:", error);
  }
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}

export { main };
