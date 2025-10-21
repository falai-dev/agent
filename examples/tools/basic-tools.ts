/**
 * Basic Tools Example
 *
 * This example demonstrates the fundamentals of creating and using tools
 * with the unified Tool interface. Shows different patterns for tool creation,
 * execution, error handling, and integration with conversation flows.
 *
 * Key concepts:
 * - Multiple ways to create and use tools with unified interface
 * - Different tool handler patterns and return types
 * - Tool registration and scoping approaches
 * - Error handling in tools
 * - Tool results and data flow
 */

import { Agent, GeminiProvider, Tool, ToolContext } from "../../src/index";

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

// Example 1: Inline Tool Definition (most common pattern)
// This shows creating a tool object directly without explicit typing
const calculatorTool = {
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
  handler: async (context: ToolContext<{ preferences?: { theme: string; language: string } }, UnifiedToolData>, args?: Record<string, unknown>) => {
    const expression = args?.expression as string;
    if (!expression) {
      throw new Error("No expression provided");
    }

    try {
      // Simple expression evaluation (in production, use a safe math library)
      // WARNING: eval is unsafe - use a proper math evaluation library in production
      const result = eval(expression);

      if (typeof result !== "number" || isNaN(result)) {
        throw new Error("Invalid calculation result");
      }

      return {
        data: `The result of ${expression} is ${result}`,
        dataUpdate: {
          expression,
          result,
          operation: expression,
        },
      };
    } catch (error) {
      throw new Error(
        `Error calculating ${expression}: ${error instanceof Error ? error.message : "Unknown error"
        }`
      );
    }
  },
};

// Example 2: Explicitly Typed Tool (for better IDE support and type safety)
const weatherTool: Tool<{ preferences?: { theme: string; language: string } }, UnifiedToolData> = {
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
  handler: async (context, args) => {
    const location = args?.location as string;
    if (!location) {
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

    const weather = mockWeather[location] || {
      temp: 70,
      condition: "Unknown",
      forecast: "Weather data unavailable",
    };

    return {
      data: `Weather in ${location}: ${weather.temp}°F and ${weather.condition}. ${weather.forecast}`,
      dataUpdate: {
        location,
        temperature: weather.temp,
        condition: weather.condition,
        forecast: weather.forecast,
      },
    };
  },
};

// Example 3: Simple Return Value (just return a string for simple tools)
const searchTool = {
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
  handler: async (context: ToolContext<any, any>, args?: Record<string, unknown>) => {
    const query = args?.query as string;
    if (!query) {
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

    const results = mockResults[query.toLowerCase()] || [
      `Search results for "${query}"`,
      "This is a simulated search result",
      "In a real implementation, this would connect to a search API",
      "Such as Google Custom Search, Bing Web Search, or Elasticsearch",
    ];

    // Simple return - just the message (no dataUpdate needed for this example)
    return `Search results for "${query}":\n${results
      .map((r, i) => `${i + 1}. ${r}`)
      .join("\n")}`;
  },
};

// Example 4: ToolResult Return Type (for complex tools that need context/data updates)
const updatePreferencesTool = {
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
  handler: async (toolContext: ToolContext<{ preferences?: { theme: string; language: string } }, UnifiedToolData>, args?: Record<string, unknown>) => {
    if (!toolContext.context) {
      throw new Error("No context available");
    }

    const newPreferences = {
      theme: (args?.theme as string) || toolContext.context.preferences?.theme || "light",
      language: (args?.language as string) || toolContext.context.preferences?.language || "en",
    };

    // Return ToolResult for complex updates
    return {
      data: `Preferences updated: Theme is now ${newPreferences.theme}, Language is ${newPreferences.language}`,
      contextUpdate: {
        preferences: newPreferences,
      },
      dataUpdate: {
        theme: newPreferences.theme,
        language: newPreferences.language,
      },
    };
  },
};

// Example 5: Function-style Tool Creation (for dynamic tools)
function createValidationTool(fieldName: string) {
  return {
    id: `validate_${fieldName}`,
    name: `${fieldName} Validator`,
    description: `Validate the ${fieldName} field`,
    parameters: {
      type: "object",
      properties: {
        value: { type: "string", description: `Value to validate for ${fieldName}` },
      },
      required: ["value"],
    },
    handler: (context: ToolContext<any, any>, args?: Record<string, unknown>) => {
      const value = args?.value as string;
      const isValid = value && value.length > 0;

      if (isValid) {
        return `${fieldName} validation passed: ${value}`;
      } else {
        throw new Error(`${fieldName} validation failed: empty or invalid value`);
      }
    },
  };
}

// Example 6: Class-based Tool (for complex stateful tools)
class ApiCallTool {
  constructor(private baseUrl: string, private apiKey: string) { }

  createTool() {
    return {
      id: "api_call",
      name: "API Call Tool",
      description: "Make API calls to external services",
      parameters: {
        type: "object",
        properties: {
          endpoint: { type: "string", description: "API endpoint to call" },
          method: { type: "string", enum: ["GET", "POST", "PUT", "DELETE"], default: "GET" },
        },
        required: ["endpoint"],
      },
      handler: async (_context: ToolContext<any, any>, args?: Record<string, unknown>) => {
        const endpoint = args?.endpoint as string;
        const method = (args?.method as string) || "GET";

        // Simulate API call
        console.log(`Making ${method} request to ${this.baseUrl}${endpoint}`);

        return {
          data: `API call successful: ${method} ${this.baseUrl}${endpoint}`,
          dataUpdate: {
            source: `API: ${this.baseUrl}${endpoint}`,
          },
        };
      },
    };
  }
}

// Define unified data schema for all tool interactions
interface UnifiedToolData extends CalculatorData, WeatherData, SearchData {
  theme?: string;
  language?: string;
}

const unifiedToolSchema = {
  type: "object",
  properties: {
    // Calculator fields
    expression: { type: "string" },
    result: { type: "number" },
    operation: { type: "string" },
    // Weather fields
    location: { type: "string" },
    temperature: { type: "number" },
    condition: { type: "string" },
    forecast: { type: "string" },
    // Search fields
    query: { type: "string" },
    results: { type: "array", items: { type: "string" } },
    source: { type: "string" },
    // Preferences fields
    theme: { type: "string", enum: ["light", "dark"] },
    language: { type: "string", enum: ["en", "es", "fr"] },
  },
};

// Create agent with tools using new ToolManager API
const agent = new Agent<{ preferences?: { theme: string; language: string } }, UnifiedToolData>({
  name: "ToolBot",
  description: "An agent demonstrating various tool capabilities",
  provider: new GeminiProvider({
    apiKey: process.env.GEMINI_API_KEY!,
    model: "models/gemini-2.5-flash",
  }),
  // NEW: Agent-level schema
  schema: unifiedToolSchema,
});

// Demonstrate ALL the different ways to add tools with the unified interface

// Method 1: Direct addTool() - most common for individual tools
agent.addTool(calculatorTool);
agent.addTool(weatherTool);

// Method 2: tool.register() - register for later reference by ID
agent.tool.register(searchTool);
agent.tool.register(updatePreferencesTool);

// Method 3: tool.registerMany() - register multiple tools at once
agent.tool.registerMany([
  createValidationTool("email"),
  createValidationTool("phone"),
]);

// Method 4: tool.create() - create and register in one step
const greetingTool = agent.tool.create({
  id: "greeting_tool",
  description: "Generate personalized greetings",
  handler: (context) => {
    const name = context.context?.preferences?.language === "es" ? "Hola" : "Hello";
    return `${name}! How can I help you today?`;
  },
});

// Method 5: tool.createDataEnrichment() - specialized for data enrichment
const dataEnrichmentTool = agent.tool.createDataEnrichment({
  id: "enrich_user_data",
  fields: ["expression", "location"] as const,
  enricher: async (context, data) => {
    // Enrich the data with additional information that matches UnifiedToolData
    return {
      source: "basic-tools-example", // This matches the 'source' field in UnifiedToolData
    };
  },
});

// Method 6: tool.createValidation() - specialized for validation
const validationTool = agent.tool.createValidation({
  id: "validate_input",
  fields: ["expression"] as const,
  validator: async (context, data) => {
    if (!data.expression || data.expression.length < 1) {
      return {
        valid: false,
        errors: [{ 
          field: "expression", 
          value: data.expression,
          message: "Expression cannot be empty",
          schemaPath: "expression"
        }],
        warnings: [],
      };
    }
    return {
      valid: true,
      errors: [],
      warnings: [],
    };
  },
});

// Method 7: Class-based tools with addTool
const apiTool = new ApiCallTool("https://api.example.com", "your-api-key");
agent.addTool(apiTool.createTool());

// Create routes that use different tools (now referencing registered tools by ID)
agent.createRoute({
  title: "Calculator",
  description: "Mathematical calculations",
  // NEW: Required fields for route completion
  requiredFields: ["expression"],
  // NEW: Optional fields that enhance the experience
  optionalFields: ["result", "operation"],
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
      tools: ["calculator"], // Reference registered tool by ID
      requires: ["expression"],
    },
  ],
});

agent.createRoute({
  title: "Weather",
  description: "Weather information",
  // NEW: Required fields for route completion
  requiredFields: ["location"],
  // NEW: Optional fields that enhance the experience
  optionalFields: ["temperature", "condition", "forecast"],
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
      tools: ["get_weather"], // Reference registered tool by ID
      requires: ["location"],
    },
  ],
});

agent.createRoute({
  title: "Web Search",
  description: "Information search",
  // NEW: Required fields for route completion
  requiredFields: ["query"],
  // NEW: Optional fields that enhance the experience
  optionalFields: ["results", "source"],
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
      tools: ["web_search"], // Reference registered tool by ID
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
      tools: ["update_preferences"], // Reference registered tool by ID
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
    calcResponse.session?.data?.result
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
    temperature: (weatherResponse.session?.data as Partial<UnifiedToolData>)
      ?.temperature,
    condition: (weatherResponse.session?.data as Partial<UnifiedToolData>)
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
    (searchResponse.session?.data as Partial<UnifiedToolData>)?.results?.length
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
    (response1.session?.data as Partial<UnifiedToolData>)?.expression
  );
  console.log(
    "   Tool result:",
    (response1.session?.data as Partial<UnifiedToolData>)?.result
  );
  console.log(
    "   Operation stored:",
    (response1.session?.data as Partial<UnifiedToolData>)?.operation
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
    (response2.session?.data as Partial<UnifiedToolData>)?.result
  );
  console.log("   Bot response:", response2.message);
}

// Show tool definition patterns
function demonstrateToolPatterns() {
  console.log("\n=== Tool Definition Patterns ===\n");

  console.log("1. Multiple Tool Creation Patterns:");
  console.log(`
// Pattern A: Inline tool definition (most common)
const myTool = {
  id: "tool_name",
  description: "What this tool does",
  handler: (context, args) => "Simple result"
};

// Pattern B: Explicitly typed tool (better IDE support)
const typedTool: Tool<MyContext, MyData> = {
  id: "typed_tool",
  description: "Typed tool with full IntelliSense",
  handler: (context, args) => ({
    data: "Result with updates",
    dataUpdate: { field: "value" },
    contextUpdate: { setting: "new" }
  })
};

// Pattern C: Function factory for dynamic tools
function createTool(name: string) {
  return {
    id: name,
    handler: () => \`Tool \${name} executed\`
  };
}

// Pattern D: Class-based tools for complex logic
class MyToolClass {
  createTool() {
    return {
      id: "class_tool",
      handler: (context, args) => this.processData(args)
    };
  }
  
  private processData(args: any) {
    return "Processed data from class method";
  }
}
  `);

  console.log("2. Multiple Return Types Supported:");
  console.log(`
// Return Type A: Simple string (for basic tools)
handler: () => "Simple result message"

// Return Type B: ToolResult object (for complex tools)
handler: (context, args) => ({
  data: "User message",
  dataUpdate: { field: "value" },
  contextUpdate: { setting: "new" }
})

// Return Type C: Promise for async operations
handler: async (context, args) => {
  const result = await apiCall();
  return \`Got: \${result}\`;
}

// Return Type D: Mixed - can return string OR ToolResult
handler: (context, args) => {
  if (simple) return "Quick result";
  return { data: "Complex result", dataUpdate: {...} };
}
  `);

  console.log("3. All Available Tool Registration Methods:");
  console.log(`
// Method 1: Direct addition (most common)
agent.addTool(myTool);

// Method 2: Register for ID-based reference
agent.tool.register(myTool);

// Method 3: Register multiple tools at once
agent.tool.registerMany([tool1, tool2, tool3]);

// Method 4: Create and register in one step
const tool = agent.tool.create({
  id: "my_tool",
  handler: () => "result"
});

// Method 5: Specialized data enrichment tools
const enricher = agent.tool.createDataEnrichment({
  id: "enrich_data",
  fields: ["field1", "field2"],
  enricher: async (context, data) => ({ enriched: true })
});

// Method 6: Specialized validation tools
const validator = agent.tool.createValidation({
  id: "validate_data", 
  fields: ["field1"],
  validator: async (context, data) => data.field1 !== undefined
});

// Method 7: Route-scoped tools
route.addTool(routeSpecificTool);

// Method 8: Step-level tools
step.addTool(stepSpecificTool);

// Usage in steps - multiple patterns
route.step({
  tools: ["tool_id"],           // By ID (from register)
  tools: [toolObject],          // Direct object
  tools: ["id1", obj2, "id3"]   // Mixed approaches
});
  `);

  console.log("4. Unified Interface Benefits & Flexibility:");
  console.log("   • Single Tool interface supports ALL patterns");
  console.log("   • Choose the right pattern for your use case:");
  console.log("     - Inline objects for simple tools");
  console.log("     - Typed interfaces for complex tools");
  console.log("     - Functions for dynamic tool generation");
  console.log("     - Classes for stateful/complex logic");
  console.log("   • Flexible return types (string OR ToolResult)");
  console.log("   • Optional typing - use as much or as little as needed");
  console.log("   • Consistent handler signature across all patterns");
  console.log("   • Tool resolution across scopes (step → route → agent)");
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
