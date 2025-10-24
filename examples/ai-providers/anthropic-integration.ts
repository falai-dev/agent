/**
 * Anthropic Provider Integration Example
 *
 * This example demonstrates how to use the Anthropic provider with Claude models
 * for building conversational agents. Shows provider configuration, model selection,
 * and Claude-specific features.
 *
 * Key concepts:
 * - Anthropic provider setup
 * - Claude model configuration
 * - Temperature and other parameters
 * - Streaming responses
 * - Tool calling with Claude
 */

import { Agent, AnthropicProvider, type Tool } from "../../src";

// Define data types for our example
interface ResearchData {
  topic: string;
  depth: "overview" | "detailed" | "comprehensive";
  sources: number;
  format: "summary" | "bullet_points" | "structured";
  researchId?: string;
}

// Research tool that Claude can use
const conductResearch: Tool<unknown, ResearchData> = {
  id: "conduct_research",
  description: "Conduct comprehensive research on a given topic",
  parameters: {
    type: "object",
    properties: {},
  },
  handler: async (context, args) => {
    const data = context.data;
    console.log(
      `Conducting ${data?.depth} research on: ${data?.topic}`
    );

    const researchId = `RES-${Date.now()}`;

    // Simulate research process
    const findings = {
      overview: `Found ${data?.sources || 3} sources about ${
        data?.topic
      }`,
      key_points: [
        "Latest developments in the field",
        "Current trends and challenges",
        "Future outlook and predictions",
      ],
      sources: ["academic papers", "industry reports", "expert interviews"],
    };

    return {
      data: `Research completed (ID: ${researchId}). ${findings.overview}`,
      dataUpdate: {
        researchId,
      },
    };
  },
};

// Define research schema
const researchSchema = {
  type: "object",
  properties: {
    topic: { type: "string", description: "The research topic" },
    depth: {
      type: "string",
      enum: ["overview", "detailed", "comprehensive"],
      default: "detailed",
    },
    sources: {
      type: "number",
      minimum: 1,
      maximum: 20,
      default: 5,
      description: "Number of sources to analyze",
    },
    format: {
      type: "string",
      enum: ["summary", "bullet_points", "structured"],
      default: "structured",
      description: "Output format preference",
    },
    researchId: { type: "string" },
  },
  required: ["topic"],
};

// Create agent with Anthropic provider
const agent = new Agent<unknown, ResearchData>({
  name: "ClaudeResearcher",
  description: "A research assistant powered by Claude",
  provider: new AnthropicProvider({
    apiKey: process.env.ANTHROPIC_API_KEY!,
    model: "claude-sonnet-4-5", // Latest Claude model
    config: {
      temperature: 0.7, // Balanced creativity vs consistency
      max_tokens: 4096,
      top_p: 0.9,
    },
  }),
  // NEW: Agent-level schema
  schema: researchSchema,
});

// Create research route
const researchRoute = agent.createRoute({
  title: "Research Assistant",
  description: "Conduct research using Claude's analytical capabilities",
  // NEW: Required fields for route completion
  requiredFields: ["topic"],
  // NEW: Optional fields that enhance the experience
  optionalFields: ["depth", "sources", "format", "researchId"],
  identity: `You are Claude, an AI research assistant created by Anthropic.
               You have access to extensive knowledge and can conduct thorough research.
               Always be helpful, truthful, and provide well-reasoned analysis.`,
  initialStep: {
    prompt: `Hello! I'm Claude, your AI research assistant. I can help you research any topic thoroughly.

What would you like me to research today? For best results, include:
- The specific topic or question
- How deep you want the research (overview, detailed, or comprehensive)
- What format you'd prefer (summary, bullet points, or structured)

For example: "Research the impact of artificial intelligence on healthcare, comprehensive analysis, structured format"`,
    collect: ["topic"],
  },
});

// Build research conversation flow
const askTopic = researchRoute.initialStep.nextStep({
  prompt: "What topic would you like me to research?",
  collect: ["topic"],
  skipIf: (ctx) => !!ctx.data?.topic,
});

const askDepth = askTopic.nextStep({
  prompt:
    "How deep should I go with this research? (overview, detailed, or comprehensive)",
  collect: ["depth"],
  requires: ["topic"],
  skipIf: (ctx) => !!ctx.data?.depth,
});

const askSources = askDepth.nextStep({
  prompt: "How many sources should I analyze? (1-20, default is 5)",
  collect: ["sources"],
  requires: ["topic"],
  skipIf: (ctx) => ctx.data?.sources !== undefined,
});

const askFormat = askSources.nextStep({
  prompt:
    "What format would you prefer for the results? (summary, bullet_points, or structured)",
  collect: ["format"],
  requires: ["topic"],
  skipIf: (ctx) => !!ctx.data?.format,
});

askFormat.nextStep({
  prompt: ({ session }) => {
    const data = session?.data;
    return `I'll now conduct ${data?.depth || "detailed"} research on "${
      data?.topic
    }" using ${data?.sources || 5} sources. This may take a moment...`;
  },
  tools: ["conduct_research"],
  requires: ["topic"],
});

// Add the research tool to the agent
agent.addTool(conductResearch);

// Demonstrate Claude's research capabilities
async function demonstrateClaudeResearch() {
  console.log("=== Claude Research Assistant Demo ===\n");

  // Example 1: Comprehensive research request
  console.log("Example 1: Comprehensive AI research");
  console.log(
    "User: Research the impact of artificial intelligence on healthcare, comprehensive analysis, structured format"
  );

  const response1 = await agent.respond({
    history: [
      {
        role: "user",
        content:
          "Research the impact of artificial intelligence on healthcare, comprehensive analysis, structured format",
        name: "Researcher",
      },
    ],
  });

  console.log("Claude:", response1.message);
  console.log(
    "Collected data:",
    JSON.stringify(response1.session?.data, null, 2)
  );
  console.log();

  // Example 2: Step-by-step research configuration
  console.log("Example 2: Step-by-step configuration");
  console.log("User: I want to research renewable energy");

  const response2a = await agent.respond({
    history: [
      {
        role: "user",
        content: "I want to research renewable energy",
        name: "Student",
      },
    ],
  });

  console.log("Claude:", response2a.message);

  console.log("User: Make it detailed with 8 sources");
  const response2b = await agent.respond({
    history: [
      {
        role: "user",
        content: "I want to research renewable energy",
        name: "Student",
      },
      {
        role: "assistant",
        content: response2a.message,
      },
      {
        role: "user",
        content: "Make it detailed with 8 sources",
        name: "Student",
      },
    ],
    session: response2a.session,
  });

  console.log("Claude:", response2b.message);

  console.log("User: Use bullet points format");
  const response2c = await agent.respond({
    history: [
      {
        role: "user",
        content: "I want to research renewable energy",
        name: "Student",
      },
      {
        role: "assistant",
        content: response2a.message,
      },
      {
        role: "user",
        content: "Make it detailed with 8 sources",
        name: "Student",
      },
      {
        role: "assistant",
        content: response2b.message,
      },
      {
        role: "user",
        content: "Use bullet points format",
        name: "Student",
      },
    ],
    session: response2b.session,
  });

  console.log("Claude:", response2c.message);
  console.log(
    "Final collected data:",
    JSON.stringify(response2c.session?.data, null, 2)
  );
  console.log("Research complete:", response2c.isRouteComplete);
}

// Demonstrate streaming with Claude
async function demonstrateClaudeStreaming() {
  console.log("\n=== Claude Streaming Demo ===\n");

  console.log("User: Give me a comprehensive overview of quantum computing");

  let accumulatedResponse = "";
  for await (const chunk of agent.respondStream({
    history: [
      {
        role: "user",
        content: "Give me a comprehensive overview of quantum computing",
        name: "Scientist",
      },
    ],
  })) {
    // Show streaming in real-time
    process.stdout.write(chunk.delta);
    accumulatedResponse += chunk.delta;

    if (chunk.done) {
      console.log("\n\nStreaming complete!");
      console.log("Total length:", accumulatedResponse.length, "characters");
      console.log(
        "Session data:",
        JSON.stringify(chunk.session?.data, null, 2)
      );
      break;
    }
  }
}

// Show different Claude model configurations
function demonstrateModelConfigurations() {
  console.log("\n=== Claude Model Configurations ===\n");

  const configurations = [
    {
      name: "Creative Writing Assistant",
      model: "claude-sonnet-4.5",
      temperature: 0.9,
      maxTokens: 8192,
      useCase: "High creativity, long-form content",
    },
    {
      name: "Code Review Bot",
      model: "claude-haiku-4.5",
      temperature: 0.3,
      maxTokens: 4096,
      useCase: "Fast, consistent code analysis",
    },
    {
      name: "Data Analyst",
      model: "claude-sonnet-4.5",
      temperature: 0.1,
      maxTokens: 16384,
      useCase: "Precise analysis, complex reasoning",
    },
  ];

  configurations.forEach((config, index) => {
    console.log(`${index + 1}. ${config.name}`);
    console.log(`   Model: ${config.model}`);
    console.log(`   Temperature: ${config.temperature}`);
    console.log(`   Max Tokens: ${config.maxTokens}`);
    console.log(`   Use Case: ${config.useCase}`);
    console.log();
  });

  console.log("Example configuration code:");
  console.log(
    `
const creativeWriter = new AnthropicProvider({
  apiKey: process.env.ANTHROPIC_API_KEY!,
  model: "claude-sonnet-4.5",
  temperature: 0.9,  // High creativity
  maxTokens: 8192,   // Long responses
});

const codeReviewer = new AnthropicProvider({
  apiKey: process.env.ANTHROPIC_API_KEY!,
  model: "claude-haiku-4.5",
  temperature: 0.3,  // Low creativity, high consistency
  maxTokens: 4096,   // Shorter responses
});
  `.trim()
  );
}

// Run demonstrations
async function main() {
  try {
    demonstrateModelConfigurations();
    await demonstrateClaudeResearch();
    await demonstrateClaudeStreaming();
  } catch (error) {
    console.error("Error:", error);
    console.log(
      "\nNote: Make sure to set ANTHROPIC_API_KEY environment variable"
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}
