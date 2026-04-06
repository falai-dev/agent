/**
 * Example: Streaming Responses
 * Updated for ResponseModal architecture with modern streaming APIs
 *
 * This example demonstrates both the new modern stream() API and the legacy
 * respondStream() method for streaming AI responses in real-time.
 * 
 * NEW: The modern stream() API provides automatic session management and
 * a simpler interface similar to chat() but with streaming.
 */

import {
  Agent,
  AnthropicProvider,
  OpenAIProvider,
  GeminiProvider,
  type EnhancedTool,
} from "../../src/index";

// Custom context type
interface ConversationContext {
  userId: string;
  sessionId: string;
  preferences: {
    streamingEnabled: boolean;
  };
}

async function modernStreamingWithAnthropic() {
  console.log("\n🤖 Example 1: Modern Streaming API with Anthropic (Claude)\n");

  // Initialize Anthropic provider
  const provider = new AnthropicProvider({
    apiKey: process.env.ANTHROPIC_API_KEY || "",
    model: "claude-sonnet-4-5",
    config: {
      temperature: 0.7,
      max_tokens: 1000,
    },
  });

  // Create agent
  const agent = new Agent<ConversationContext, unknown>({
    name: "StreamingAssistant",
    description: "An AI assistant that streams responses in real-time",
    goal: "Provide helpful information with streaming responses",
    context: {
      userId: "user123",
      sessionId: "session456",
      preferences: {
        streamingEnabled: true,
      },
    },
    provider: provider,
  });

  // Add guidelines
  agent.createGuideline({
    action: "Be concise but informative in your responses",
    enabled: true,
  });

  try {
    console.log("📤 Modern streaming API - automatic session management...\n");
    console.log("Response: ");

    // Session is automatically managed by the agent
    console.log("✨ Session ready:", agent.session.id);

    // NEW: Modern stream() API - automatically manages session history
    for await (const chunk of agent.stream("Explain quantum computing in simple terms.")) {
      // chunk.delta contains the new text
      // chunk.accumulated contains the full text so far
      // chunk.done indicates if this is the final chunk

      if (chunk.delta) {
        process.stdout.write(chunk.delta);
      }

      if (chunk.done) {
        console.log("\n\n✅ Stream complete!");
        console.log(`\n📊 Metadata:`);
        console.log(
          `   - Route: ${chunk.session?.currentRoute?.title || "None"}`
        );
        console.log(`   - Data:`, agent.session.getData() || "None");
        console.log(`   - Tool Calls: ${chunk.toolCalls?.length || 0}`);

        // Session history is automatically updated - no manual management needed!
        console.log(`   - Session Messages: ${agent.session.getHistory().length}`);
      }
    }

    console.log("\n💡 Benefits of modern stream() API:");
    console.log("   - Automatic session management");
    console.log("   - Simple interface: agent.stream('message')");
    console.log("   - No need to manually manage history");
    console.log("   - Same performance as respondStream()");

  } catch (error) {
    console.error("❌ Error:", error);
  }
}

async function legacyStreamingWithAnthropic() {
  console.log("\n🤖 Example 2: Legacy Streaming API (respondStream) - Still Supported\n");

  // Initialize Anthropic provider
  const provider = new AnthropicProvider({
    apiKey: process.env.ANTHROPIC_API_KEY || "",
    model: "claude-sonnet-4-5",
    config: {
      temperature: 0.7,
      max_tokens: 1000,
    },
  });

  // Create agent
  const agent = new Agent<ConversationContext, unknown>({
    name: "LegacyStreamingAssistant",
    description: "An AI assistant using legacy streaming API",
    goal: "Demonstrate backward compatibility",
    context: {
      userId: "user123",
      sessionId: "session456-legacy",
      preferences: {
        streamingEnabled: true,
      },
    },
    provider: provider,
  });

  try {
    console.log("📤 Legacy respondStream API - manual session management...\n");
    console.log("Response: ");

    // Session is automatically managed by the agent
    console.log("✨ Session ready:", agent.session.id);

    // Add user message to session history manually
    await agent.session.addMessage("user", "What's the weather like today?");

    // Legacy respondStream API - requires manual session management
    let fullMessage = "";
    for await (const chunk of agent.respondStream({
      history: agent.session.getHistory()
    })) {
      if (chunk.delta) {
        process.stdout.write(chunk.delta);
        fullMessage += chunk.delta;
      }

      if (chunk.done) {
        console.log("\n\n✅ Stream complete!");
        console.log(`\n📊 Metadata:`);
        console.log(
          `   - Route: ${chunk.session?.currentRoute?.title || "None"}`
        );
        console.log(`   - Data:`, agent.session.getData() || "None");
        console.log(`   - Tool Calls: ${chunk.toolCalls?.length || 0}`);

        // Manual session history management required
        await agent.session.addMessage("assistant", fullMessage);
        console.log(`   - Session Messages: ${agent.session.getHistory().length}`);
      }
    }

    console.log("\n💡 Legacy respondStream() API characteristics:");
    console.log("   - Manual session management required");
    console.log("   - More complex parameter structure");
    console.log("   - Full backward compatibility maintained");
    console.log("   - Still fully supported for existing code");

  } catch (error) {
    console.error("❌ Error:", error);
  }
}

async function modernStreamingWithOpenAI() {
  console.log("\n🤖 Example 3: Modern Streaming with OpenAI\n");

  const provider = new OpenAIProvider({
    apiKey: process.env.OPENAI_API_KEY || "",
    model: "gpt-4",
    config: {
      temperature: 0.8,
    },
  });

  const agent = new Agent<ConversationContext, unknown>({
    name: "CreativeAssistant",
    description: "A creative AI assistant",
    context: {
      userId: "user123",
      sessionId: "session789",
      preferences: {
        streamingEnabled: true,
      },
    },
    provider: provider,
  });

  try {
    console.log("📤 Modern streaming with OpenAI...\n");
    console.log("Response: ");

    // Session is automatically managed by the agent
    console.log("✨ Session ready:", agent.session.id);

    // NEW: Modern stream() API with context override
    for await (const chunk of agent.stream("Write a short poem about TypeScript", {
      contextOverride: { preferences: { streamingEnabled: true } }
    })) {
      if (chunk.delta) {
        process.stdout.write(chunk.delta);
      }

      if (chunk.done) {
        console.log("\n\n✅ Stream complete!");
        console.log(
          `   - Route: ${chunk.session?.currentRoute?.title || "None"}`
        );
        console.log(`   - Data:`, agent.session.getData() || "None");

        // Session automatically updated - no manual work needed!
        console.log(`   - Session Messages: ${agent.session.getHistory().length}`);
      }
    }
  } catch (error) {
    console.error("❌ Error:", error);
  }
}

async function modernStreamingComparison() {
  console.log("\n🤖 Example 4: Side-by-Side API Comparison\n");

  const provider = new GeminiProvider({
    apiKey: process.env.GEMINI_API_KEY || "",
    model: "models/gemini-2.5-flash",
    config: {
      temperature: 0.7,
    },
  });

  const agent = new Agent<ConversationContext, unknown>({
    name: "ComparisonAssistant",
    description: "Demonstrates API differences",
    context: {
      userId: "user123",
      sessionId: "session101",
      preferences: {
        streamingEnabled: true,
      },
    },
    provider: provider,
  });

  const userMessage = "What are the key differences between REST and GraphQL?";

  try {
    console.log("📤 Comparing old vs new streaming APIs...\n");

    // ========================================================================
    // OLD WAY: respondStream() - Manual session management
    // ========================================================================
    console.log("🔸 OLD WAY: respondStream() with manual session management");
    console.log("Response: ");

    // Manual session management
    await agent.session.addMessage("user", userMessage);

    let oldWayMessage = "";
    for await (const chunk of agent.respondStream({
      history: agent.session.getHistory()
    })) {
      if (chunk.delta) {
        process.stdout.write(chunk.delta);
        oldWayMessage += chunk.delta;
      }

      if (chunk.done) {
        // Manual history update required
        await agent.session.addMessage("assistant", oldWayMessage);
        console.log("\n   ✅ Manual session update completed");
      }
    }

    console.log("\n" + "=".repeat(60));

    // ========================================================================
    // NEW WAY: stream() - Automatic session management
    // ========================================================================
    console.log("🔸 NEW WAY: stream() with automatic session management");
    console.log("Response: ");

    // Automatic session management - just pass the message!
    for await (const chunk of agent.stream("Can you explain that in more detail?")) {
      if (chunk.delta) {
        process.stdout.write(chunk.delta);
      }

      if (chunk.done) {
        console.log("\n   ✅ Automatic session update - no manual work needed!");
        console.log(`   📊 Total messages in session: ${agent.session.getHistory().length}`);
      }
    }

    console.log("\n💡 Key Differences:");
    console.log("   OLD: agent.respondStream({ history: agent.session.getHistory() })");
    console.log("   NEW: agent.stream('message')");
    console.log("   ");
    console.log("   OLD: Manual session.addMessage() calls required");
    console.log("   NEW: Automatic session management");
    console.log("   ");
    console.log("   OLD: Complex parameter structure");
    console.log("   NEW: Simple message + optional options");

  } catch (error) {
    console.error("❌ Error:", error);
  }
}

async function modernStreamingWithRoutes() {
  console.log("\n🤖 Example 5: Modern Streaming with Routes and Steps\n");

  const provider = new AnthropicProvider({
    apiKey: process.env.ANTHROPIC_API_KEY || "",
    model: "claude-sonnet-4-5",
  });

  // Define feedback data schema
  interface FeedbackData {
    rating: number;
    comments: string;
  }

  const feedbackSchema = {
    type: "object",
    properties: {
      rating: { type: "number", minimum: 1, maximum: 5 },
      comments: { type: "string" },
    },
    required: ["rating"],
  };

  const agent = new Agent<ConversationContext, FeedbackData>({
    name: "SupportAgent",
    description: "A customer support agent with conversation routes",
    context: {
      userId: "user123",
      sessionId: "session202",
      preferences: {
        streamingEnabled: true,
      },
    },
    provider: provider,
    // NEW: Agent-level schema
    schema: feedbackSchema,
  });

  // Create a route
  const supportRoute = agent.createRoute({
    title: "Product Support",
    description: "Help users with product questions",
    when: ["User asks about product features or issues"],
  });

  supportRoute.initialStep.nextStep({
    prompt: "Understand the user's product question",
  });

  // Create a feedback route
  agent.createRoute({
    title: "Collect Feedback",
    description: "Collect user feedback on their support experience",
    when: ["User wants to provide feedback"],
    // NEW: Required fields for route completion
    requiredFields: ["rating"],
    // NEW: Optional fields
    optionalFields: ["comments"],
    steps: [
      {
        prompt: "How would you rate your support experience from 1 to 5?",
        collect: ["rating"],
      },
      {
        prompt: "Thanks for the rating! Any other comments?",
        collect: ["comments"],
      },
      {
        prompt: "We appreciate your feedback!",
      },
    ],
  });

  const history = [
    {
      role: "user" as const,
      content: "How do I reset my password?",
      name: "User",
    },
  ];

  try {
    console.log("📤 Streaming response with route detection...\n");
    console.log("Response: ");

    // Session is automatically managed by the agent
    console.log("✨ Session ready:", agent.session.id);

    // NEW: Modern stream() API with routes - automatic session management
    for await (const chunk of agent.stream("How do I reset my password?")) {
      if (chunk.delta) {
        process.stdout.write(chunk.delta);
      }

      if (chunk.done) {
        console.log("\n\n✅ Stream complete!");
        console.log(`\n📊 Metadata:`);
        console.log(
          `   - Route: ${chunk.session?.currentRoute?.title || "None"}`
        );
        console.log(`   - Data:`, agent.session.getData() || "None");

        // Check for route completion
        if (chunk.isRouteComplete) {
          console.log("\n✅ Route complete!");
          if (chunk.session?.currentRoute?.title === "Collect Feedback") {
            await logFeedback(agent.session.getData() as FeedbackData);
          }
        }

        // Session is automatically updated by the modern stream() API
      }
    }
  } catch (error) {
    console.error("❌ Error:", error);
  }
}

async function modernStreamingWithAbortSignal() {
  console.log("\n🤖 Example 6: Modern Streaming with Abort Control\n");

  const provider = new AnthropicProvider({
    apiKey: process.env.ANTHROPIC_API_KEY || "",
    model: "claude-sonnet-4-5",
  });

  const agent = new Agent<ConversationContext, unknown>({
    name: "Assistant",
    description: "An assistant that can be interrupted",
    context: {
      userId: "user123",
      sessionId: "session303",
      preferences: {
        streamingEnabled: true,
      },
    },
    provider: provider,
  });

  const history = [
    {
      role: "user" as const,
      content: "Tell me a very long story about space exploration.",
      name: "User",
    },
  ];

  // Create an AbortController to cancel the stream
  const abortController = new AbortController();

  // Automatically abort after 3 seconds
  const timeout = setTimeout(() => {
    console.log("\n\n⚠️  Aborting stream after 3 seconds...");
    abortController.abort();
  }, 3000);

  try {
    console.log("📤 Streaming response (will abort after 3s)...\n");
    console.log("Response: ");

    // Session is automatically managed by the agent
    console.log("✨ Session ready:", agent.session.id);

    // NEW: Modern stream() API with abort signal
    for await (const chunk of agent.stream("Tell me a very long story about space exploration.", {
      signal: abortController.signal,
    })) {
      if (chunk.delta) {
        process.stdout.write(chunk.delta);
      }

      if (chunk.done) {
        console.log("\n\n✅ Stream complete!");
        console.log(`\n📊 Metadata:`);
        console.log(
          `   - Route: ${chunk.session?.currentRoute?.title || "None"}`
        );
        console.log(`   - Data:`, agent.session.getData() || "None");

        // Session is automatically updated by the modern stream() API - no manual work needed!

        clearTimeout(timeout);
      }
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      console.log("\n\n🛑 Stream was aborted successfully!");
    } else {
      console.error("❌ Error:", error);
    }
    clearTimeout(timeout);
  }
}

/**
 * Mock function to log feedback.
 * @param data - The feedback data.
 */
async function logFeedback(data: { rating: number; comments: string }) {
  console.log("\n" + "=".repeat(60));
  console.log("📝 Logging Feedback...");
  console.log("=".repeat(60));
  console.log("Feedback Details:", JSON.stringify(data, null, 2));
  console.log(`   - Rating: ${data.rating}`);
  console.log(`   - Comments: ${data.comments}`);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  console.log("✨ Feedback logged successfully!");
}

async function streamingWithToolExecution() {
  console.log("\n🤖 Example 7: Streaming with Tool Execution\n");

  const provider = new AnthropicProvider({
    apiKey: process.env.ANTHROPIC_API_KEY || "",
    model: "claude-sonnet-4-5",
  });

  // Define EnhancedTools with concurrency metadata
  const readFileTool: EnhancedTool = {
    id: "read_file",
    name: "Read File",
    description: "Read a file from disk",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    handler: async (_ctx, args) => {
      await new Promise((r) => setTimeout(r, 200));
      return { data: `Contents of ${args?.path}`, success: true };
    },
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    interruptBehavior: () => "cancel",
  };

  const writeFileTool: EnhancedTool = {
    id: "write_file",
    name: "Write File",
    description: "Write content to a file",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
    handler: async (_ctx, args) => {
      await new Promise((r) => setTimeout(r, 150));
      return { data: `Wrote to ${args?.path}`, success: true };
    },
    isConcurrencySafe: () => false,
    isDestructive: () => true,
    interruptBehavior: () => "block",
    maxResultSizeChars: 1_000,
  };

  const agent = new Agent({
    name: "ToolStreamingAssistant",
    description: "Demonstrates streaming with concurrent tool execution",
    provider,
    tools: [readFileTool, writeFileTool],
  });

  try {
    console.log("📤 Streaming with tool execution...\n");
    console.log("When the LLM calls multiple read-only tools, they execute in parallel.");
    console.log("Write tools wait for exclusive access.\n");
    console.log("Response: ");

    for await (const chunk of agent.stream("Read index.ts and utils.ts, then write output.ts")) {
      if (chunk.delta) {
        process.stdout.write(chunk.delta);
      }

      if (chunk.done) {
        console.log("\n\n✅ Stream complete!");
        console.log(`   Tool Calls: ${chunk.toolCalls?.length || 0}`);
        console.log(`   Session Messages: ${agent.session.getHistory().length}`);
      }
    }
  } catch (error) {
    console.error("❌ Error:", error);
  }
}

async function main() {
  console.log("🚀 Starting Streaming Examples\n");
  console.log("=".repeat(60));

  const examples = [
    { name: "Modern Streaming API (Anthropic)", fn: modernStreamingWithAnthropic },
    { name: "Legacy Streaming API (Anthropic)", fn: legacyStreamingWithAnthropic },
    { name: "Modern Streaming (OpenAI)", fn: modernStreamingWithOpenAI },
    { name: "API Comparison (Gemini)", fn: modernStreamingComparison },
    { name: "Modern Streaming with Routes", fn: modernStreamingWithRoutes },
    { name: "Modern Streaming with Abort", fn: modernStreamingWithAbortSignal },
    { name: "Streaming with Tool Execution", fn: streamingWithToolExecution },
  ];

  console.log("\nAvailable Examples:");
  examples.forEach((ex, i) => {
    console.log(`  ${i + 1}. ${ex.name}`);
  });

  console.log("\n💡 Tips:");
  console.log("   - Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or GEMINI_API_KEY");
  console.log("   - NEW: Use agent.stream('message') for automatic session management");
  console.log("   - OLD: agent.respondStream() still supported for backward compatibility");
  console.log("   - Streaming provides real-time responses for better UX");
  console.log("   - Use AbortSignal to cancel long-running streams");
  console.log("   - Access chunk.route and chunk.step for flow information");
  console.log("   - NEW: EnhancedTool metadata enables parallel read-only tool execution");

  console.log("\n" + "=".repeat(60));

  // Run modern streaming example if API key is available
  if (process.env.ANTHROPIC_API_KEY) {
    await modernStreamingWithAnthropic();
  } else if (process.env.OPENAI_API_KEY) {
    await modernStreamingWithOpenAI();
  } else if (process.env.GEMINI_API_KEY) {
    await modernStreamingComparison();
  } else {
    console.log(
      "\n⚠️  No API keys found. Set one of the environment variables to run examples."
    );
  }
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}

export { main };
