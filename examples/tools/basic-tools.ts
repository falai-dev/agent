/**
 * Basic Tools Example
 *
 * This example demonstrates the fundamentals of creating and using tools
 * in conversational agents. Shows tool definition, execution, error handling,
 * and integration with conversation flows.
 *
 * Key concepts:
 * - Tool definition with Tool<TContext, TArgs, TResult, TData> interface
 * - Tool context and parameters
 * - Tool execution in conversation flows
 * - Error handling in tools
 * - Tool results and data flow
 */

import { Agent, GeminiProvider, type Tool } from "../../src/index";

// Define data types for our examples
interface CalculatorData {
  expression: string;
  result?: number;
  operation?: string;
}

interface WeatherData {
  location: string;
  temperature?: number;
  condition?: string;
  forecast?: string;
}

interface SearchData {
  query: string;
  results?: string[];
  source?: string;
}

// Example 1: Simple Calculator Tool
const calculatorTool: Tool<unknown, [], string, CalculatorData> = {
  id: "calculator",
  name: "Math Calculator",
  description: "Evaluate mathematical expressions and return results",
  parameters: {
    type: "object",
    properties: {
      expression: {
        type: "string",
        description: "Mathematical expression to evaluate",
      },
    },
    required: ["expression"],
  },
  handler: ({ data }) => {
    const calcData = data as Partial<CalculatorData>;
    if (!calcData?.expression) {
      throw new Error("No expression provided");
    }

    try {
      // Simple expression evaluation (in production, use a safe math library)
      // WARNING: eval is unsafe - use a proper math evaluation library in production
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const result = eval(calcData.expression);

      if (typeof result !== "number" || isNaN(result)) {
        throw new Error("Invalid calculation result");
      }

      return {
        data: `The result of ${calcData.expression} is ${result}`,
        dataUpdate: {
          result,
          operation: calcData.expression,
        },
      };
    } catch (error) {
      throw new Error(
        `Error calculating ${calcData.expression}: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
    }
  },
};

// Example 2: Weather Tool with External API Simulation
const weatherTool: Tool<unknown, [], string, WeatherData> = {
  id: "get_weather",
  name: "Weather Lookup",
  description: "Get current weather and forecast for a location",
  parameters: {
    type: "object",
    properties: {
      location: { type: "string", description: "City name for weather lookup" },
    },
    required: ["location"],
  },
  handler: async ({ data }) => {
    const weatherData = data as Partial<WeatherData>;
    if (!weatherData?.location) {
      throw new Error("No location provided");
    }

    // Simulate API call delay
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Mock weather data based on location
    const mockWeather: Record<
      string,
      { temp: number; condition: string; forecast: string }
    > = {
      "New York": {
        temp: 72,
        condition: "Sunny",
        forecast: "Clear skies all week",
      },
      London: { temp: 55, condition: "Rainy", forecast: "Showers expected" },
      Tokyo: {
        temp: 78,
        condition: "Cloudy",
        forecast: "Partly cloudy with showers",
      },
      Sydney: {
        temp: 68,
        condition: "Clear",
        forecast: "Beautiful weather ahead",
      },
    };

    const weather = mockWeather[weatherData.location] || {
      temp: 70,
      condition: "Unknown",
      forecast: "Weather data unavailable",
    };

    return {
      data: `Weather in ${weatherData.location}: ${weather.temp}°F and ${weather.condition}. ${weather.forecast}`,
      dataUpdate: {
        temperature: weather.temp,
        condition: weather.condition,
        forecast: weather.forecast,
      },
    };
  },
};

// Example 3: Search Tool with Multiple Results
const searchTool: Tool<unknown, [], string, SearchData> = {
  id: "web_search",
  name: "Web Search",
  description: "Search the web for information on a given query",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query to look up" },
    },
    required: ["query"],
  },
  handler: async ({ data }) => {
    const searchData = data as Partial<SearchData>;
    if (!searchData?.query) {
      throw new Error("No search query provided");
    }

    // Simulate search API call
    await new Promise((resolve) => setTimeout(resolve, 800));

    // Mock search results
    const mockResults: Record<string, string[]> = {
      "artificial intelligence": [
        "AI is transforming industries worldwide",
        "Machine learning algorithms power modern AI",
        "Neural networks are the foundation of deep learning",
        "AI ethics and responsible development are crucial",
      ],
      "climate change": [
        "Global temperatures are rising at an unprecedented rate",
        "Renewable energy adoption is accelerating",
        "Biodiversity loss is a major concern",
        "International cooperation is essential for climate action",
      ],
      "space exploration": [
        "Mars missions are advancing rapidly",
        "Private companies are leading space innovation",
        "International Space Station continues operations",
        "Lunar exploration plans are being developed",
      ],
    };

    const results = mockResults[searchData.query.toLowerCase()] || [
      `Search results for "${searchData.query}"`,
      "This is a simulated search result",
      "In a real implementation, this would connect to a search API",
      "Such as Google Custom Search, Bing Web Search, or Elasticsearch",
    ];

    return {
      data: `Search results for "${searchData.query}":\n${results
        .map((r, i) => `${i + 1}. ${r}`)
        .join("\n")}`,
      dataUpdate: {
        results,
        source: "Mock Search API",
      },
    };
  },
};

// Example 4: Tool that Modifies Context (Advanced)
const updatePreferencesTool: Tool<
  { preferences?: { theme: string; language: string } },
  [],
  string,
  { theme?: string; language?: string }
> = {
  id: "update_preferences",
  name: "Update Preferences",
  description: "Update user preferences and settings",
  parameters: {
    type: "object",
    properties: {
      theme: { type: "string", enum: ["light", "dark"] },
      language: { type: "string", enum: ["en", "es", "fr"] },
    },
  },
  handler: ({ context, data }) => {
    if (!context) {
      throw new Error("No context available");
    }

    const newPreferences = {
      theme: data?.theme || context.preferences?.theme || "light",
      language: data?.language || context.preferences?.language || "en",
    };

    return {
      data: `Preferences updated: Theme is now ${newPreferences.theme}, Language is ${newPreferences.language}`,
      contextUpdate: {
        preferences: newPreferences,
      },
    };
  },
};

// Create agent with tools
const agent = new Agent<{ preferences?: { theme: string; language: string } }>({
  name: "ToolBot",
  description: "An agent demonstrating various tool capabilities",
  provider: new GeminiProvider({
    apiKey: process.env.GEMINI_API_KEY!,
    model: "models/gemini-2.5-flash",
  }),
});

// Create routes that use different tools
agent.createRoute<CalculatorData>({
  title: "Calculator",
  description: "Mathematical calculations",
  schema: {
    type: "object",
    properties: {
      expression: { type: "string" },
      result: { type: "number" },
      operation: { type: "string" },
    },
    required: ["expression"],
  },
  steps: [
    {
      id: "get_expression",
      description: "Ask for mathematical expression",
      prompt:
        "I can help you with calculations. What would you like to calculate?",
      collect: ["expression"],
    },
    {
      id: "calculate",
      description: "Perform the calculation",
      prompt: "Let me calculate that for you.",
      tools: [calculatorTool],
      requires: ["expression"],
    },
  ],
});

agent.createRoute<WeatherData>({
  title: "Weather",
  description: "Weather information",
  schema: {
    type: "object",
    properties: {
      location: { type: "string" },
      temperature: { type: "number" },
      condition: { type: "string" },
      forecast: { type: "string" },
    },
    required: ["location"],
  },
  steps: [
    {
      id: "get_location",
      description: "Ask for location",
      prompt:
        "I can check the weather for you. Which city are you interested in?",
      collect: ["location"],
    },
    {
      id: "get_weather",
      description: "Fetch weather data",
      prompt: "Let me check the weather for you.",
      tools: [weatherTool],
      requires: ["location"],
    },
  ],
});

agent.createRoute<SearchData>({
  title: "Web Search",
  description: "Information search",
  schema: {
    type: "object",
    properties: {
      query: { type: "string" },
      results: { type: "array", items: { type: "string" } },
      source: { type: "string" },
    },
    required: ["query"],
  },
  steps: [
    {
      id: "get_query",
      description: "Ask for search query",
      prompt:
        "I can search for information on the web. What would you like to search for?",
      collect: ["query"],
    },
    {
      id: "perform_search",
      description: "Execute the search",
      prompt: "Let me search for that information.",
      tools: [searchTool],
      requires: ["query"],
    },
  ],
});

// Create a route for preferences management
agent.createRoute({
  title: "Preferences",
  description: "Update user preferences",
  steps: [
    {
      id: "update_prefs",
      description: "Update user preferences",
      prompt: "I can help you update your preferences.",
      tools: [updatePreferencesTool],
    },
  ],
});

// Demonstrate basic tool usage
async function demonstrateBasicTools() {
  console.log("=== Basic Tools Demo ===\n");

  // Calculator tool
  console.log("1. Calculator Tool:");
  console.log("User: Calculate 15 * 23 + 7");
  const calcResponse = await agent.respond({
    history: [],
  });
  console.log("Bot:", calcResponse.message);
  console.log(
    "Calculated result:",
    (calcResponse.session?.data as Partial<CalculatorData>)?.result
  );
  console.log();

  // Weather tool
  console.log("2. Weather Tool:");
  console.log("User: What's the weather like in Tokyo?");
  const weatherResponse = await agent.respond({
    history: [{ role: "user", content: "What's the weather like in Tokyo?" }],
  });
  console.log("Bot:", weatherResponse.message);
  console.log("Weather data:", {
    temperature: (weatherResponse.session?.data as Partial<WeatherData>)
      ?.temperature,
    condition: (weatherResponse.session?.data as Partial<WeatherData>)
      ?.condition,
  });
  console.log();

  // Search tool
  console.log("3. Search Tool:");
  console.log("User: Search for information about artificial intelligence");
  const searchResponse = await agent.respond({
    history: [
      {
        role: "user",
        content: "Search for information about artificial intelligence",
      },
    ],
  });
  console.log("Bot:", searchResponse.message);
  console.log(
    "Search results count:",
    (searchResponse.session?.data as Partial<SearchData>)?.results?.length
  );
}

// Demonstrate tool error handling
async function demonstrateToolErrors() {
  console.log("\n=== Tool Error Handling Demo ===\n");

  // Invalid calculation
  console.log("1. Invalid Calculation:");
  console.log("User: Calculate xyz + 123");
  const errorResponse1 = await agent.respond({
    history: [],
  });
  console.log("Bot:", errorResponse1.message);
  console.log();

  // Missing location for weather
  console.log("2. Missing Parameters:");
  console.log("User: What's the weather?"); // No location specified
  const errorResponse2 = await agent.respond({
    history: [],
  });
  console.log("Bot:", errorResponse2.message);
  console.log();

  // Empty search query
  console.log("3. Empty Search Query:");
  console.log("User: Search for"); // Empty query
  const errorResponse3 = await agent.respond({
    history: [{ role: "user", content: "Search for" }],
  });
  console.log("Bot:", errorResponse3.message);
}

// Demonstrate tool data flow
async function demonstrateToolDataFlow() {
  console.log("\n=== Tool Data Flow Demo ===\n");

  console.log("Showing how tool results flow through the conversation...");

  // Start with calculation
  const response1 = await agent.respond({
    history: [],
  });

  console.log("1. Initial calculation:");
  console.log(
    "   User input collected:",
    (response1.session?.data as Partial<CalculatorData>)?.expression
  );
  console.log(
    "   Tool result:",
    (response1.session?.data as Partial<CalculatorData>)?.result
  );
  console.log(
    "   Operation stored:",
    (response1.session?.data as Partial<CalculatorData>)?.operation
  );

  // Follow up question using previous result
  const response2 = await agent.respond({
    history: [
      { role: "user", content: "Now add 100 to that result", name: "Alice" },
    ],
    session: response1.session,
  });

  console.log("\n2. Follow-up calculation:");
  console.log(
    "   Previous result available:",
    (response2.session?.data as Partial<CalculatorData>)?.result
  );
  console.log("   Bot response:", response2.message);
}

// Show tool definition patterns
function demonstrateToolPatterns() {
  console.log("\n=== Tool Definition Patterns ===\n");

  console.log("1. Basic Tool Pattern:");
  console.log(`
const myTool: Tool<ContextType, [], ResultType, DataType> = {
  id: "tool_name",                    // Unique identifier
  description: "What this tool does", // AI uses this to decide when to call
  parameters: {                       // JSON Schema for tool parameters
    type: "object",
    properties: { /* parameter definitions */ }
  },
  handler: ({ data, context, updateContext }) => {
    // Tool logic here - throw errors for failures
    return {
      data: "Result message",          // User-facing result
      dataUpdate: { /* session data updates */ },
      contextUpdate: { /* context updates */ },
    };
  },
};
  `);

  console.log("2. Tool Context Parameters:");
  console.log(`
interface ToolContext<TContext, TData> {
  context: TContext;           // Agent context
  updateContext: Function;     // Update context function
  history;            // Conversation history
  data: Partial<TData>;        // Currently collected data
}
  `);

  console.log("3. Tool Result Structure:");
  console.log(`
interface ToolResult {
  data: unknown;               // Primary result (string for AI)
  dataUpdate?: Record<string, unknown>;    // Update collected data
  contextUpdate?: Record<string, unknown>; // Update agent context
  success: boolean;            // Whether tool succeeded
  error?: string;              // Error message if failed
}
  `);

  console.log("4. Common Tool Patterns:");
  console.log("   • Data Fetching: API calls to external services");
  console.log("   • Calculations: Mathematical or logical operations");
  console.log("   • Data Processing: Transform or analyze collected data");
  console.log("   • State Updates: Modify conversation state");
  console.log("   • External Actions: Send emails, create records, etc.");
}

// Run demonstrations
async function main() {
  try {
    demonstrateToolPatterns();
    await demonstrateBasicTools();
    await demonstrateToolErrors();
    await demonstrateToolDataFlow();
  } catch (error) {
    console.error("Error:", error);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}
