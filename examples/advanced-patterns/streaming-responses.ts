/**
 * Example: Streaming Responses
 * Updated for v2 architecture with session step management
 *
 * This example demonstrates how to use the respondStream method
 * to stream AI responses in real-time for better user experience
 */

import {
  Agent,
  AnthropicProvider,
  OpenAIProvider,
  GeminiProvider,
} from "../../src/index";

// Custom context type
interface ConversationContext {
  userId: string;
  sessionId: string;
  preferences: {
    streamingEnabled: boolean;
  };
}

async function streamingWithAnthropic() {
  console.log("\n🤖 Example 1: Streaming with Anthropic (Claude)\n");

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

  // Create conversation history
  const history = [
    {
      role: "user" as const,
      content: "Explain quantum computing in simple terms.",
      name: "User",
    },
  ];

  try {
    console.log("📤 Streaming response from Claude...\n");
    console.log("Response: ");

    // Session is automatically managed by the agent
    console.log("✨ Session ready:", agent.session.id);

    // Add user message to session history
    await agent.session.addMessage("user", "What's the weather like today?");

    // Use respondStream for real-time streaming with session history
    let fullMessage = "";
    for await (const chunk of agent.respondStream({ 
      history: agent.session.getHistory() 
    })) {
      // chunk.delta contains the new text
      // chunk.accumulated contains the full text so far
      // chunk.done indicates if this is the final chunk

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

        console.log(`   - Full Message: ${fullMessage}`);
        
        // Add assistant response to session history
        await agent.session.addMessage("assistant", fullMessage);
      }
    }
  } catch (error) {
    console.error("❌ Error:", error);
  }
}

async function streamingWithOpenAI() {
  console.log("\n🤖 Example 2: Streaming with OpenAI\n");

  const provider = new OpenAIProvider({
    apiKey: process.env.OPENAI_API_KEY || "",
    model: "gpt-5",
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

  const history = [
    {
      role: "user" as const,
      content: "Write a short poem about TypeScript",
      name: "User",
    },
  ];

  try {
    console.log("📤 Streaming response from OpenAI...\n");
    console.log("Response: ");

    // Session is automatically managed by the agent
    console.log("✨ Session ready:", agent.session.id);

    // Add user message to session history
    await agent.session.addMessage("user", "What's the weather like today?");

    for await (const chunk of agent.respondStream({ 
      history: agent.session.getHistory() 
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

        // Add assistant response to session history
        await agent.session.addMessage("assistant", chunk.accumulated || "");
      }
    }
  } catch (error) {
    console.error("❌ Error:", error);
  }
}

async function streamingWithGemini() {
  console.log("\n🤖 Example 3: Streaming with Google Gemini\n");

  const provider = new GeminiProvider({
    apiKey: process.env.GEMINI_API_KEY || "",
    model: "models/gemini-2.5-flash",
    config: {
      temperature: 0.7,
    },
  });

  const agent = new Agent<ConversationContext, unknown>({
    name: "AnalyticalAssistant",
    description: "An analytical AI assistant",
    context: {
      userId: "user123",
      sessionId: "session101",
      preferences: {
        streamingEnabled: true,
      },
    },
    provider: provider,
  });

  const history = [
    {
      role: "user" as const,
      content: "What are the key differences between REST and GraphQL?",
      name: "User",
    },
  ];

  try {
    console.log("📤 Streaming response from Gemini...\n");
    console.log("Response: ");

    // Session is automatically managed by the agent
    console.log("✨ Session ready:", agent.session.id);

    // Add user message to session history
    await agent.session.addMessage("user", "What are the key differences between REST and GraphQL?");

    for await (const chunk of agent.respondStream({ 
      history: agent.session.getHistory() 
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

        // Add assistant response to session history
        await agent.session.addMessage("assistant", chunk.accumulated || "");
      }
    }
  } catch (error) {
    console.error("❌ Error:", error);
  }
}

async function streamingWithRoutes() {
  console.log("\n🤖 Example 4: Streaming with Routes and Steps\n");

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
    conditions: ["User asks about product features or issues"],
  });

  supportRoute.initialStep.nextStep({
    prompt: "Understand the user's product question",
  });

  // Create a feedback route
  agent.createRoute({
    title: "Collect Feedback",
    description: "Collect user feedback on their support experience",
    conditions: ["User wants to provide feedback"],
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

    // Add user message to session history
    await agent.session.addMessage("user", "How do I reset my password?");

    for await (const chunk of agent.respondStream({ 
      history: agent.session.getHistory() 
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

        // Check for route completion
        if (chunk.isRouteComplete) {
          console.log("\n✅ Route complete!");
          if (chunk.session?.currentRoute?.title === "Collect Feedback") {
            await logFeedback(agent.session.getData() as FeedbackData);
          }
        }

        // Session is automatically updated by the agent
      }
    }
  } catch (error) {
    console.error("❌ Error:", error);
  }
}

async function streamingWithAbortSignal() {
  console.log("\n🤖 Example 5: Streaming with Abort Control\n");

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

    // Add user message to session history
    await agent.session.addMessage("user", "Tell me a very long story about space exploration.");

    for await (const chunk of agent.respondStream({
      history: agent.session.getHistory(),
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

        // Add assistant response to session history
        await agent.session.addMessage("assistant", chunk.accumulated || "");

        // Session is automatically updated by the agent

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

async function main() {
  console.log("🚀 Starting Streaming Examples\n");
  console.log("=".repeat(60));

  const examples = [
    { name: "Anthropic Streaming", fn: streamingWithAnthropic },
    { name: "OpenAI Streaming", fn: streamingWithOpenAI },
    { name: "Gemini Streaming", fn: streamingWithGemini },
    { name: "Streaming with Routes", fn: streamingWithRoutes },
    { name: "Streaming with Abort", fn: streamingWithAbortSignal },
  ];

  console.log("\nAvailable Examples:");
  examples.forEach((ex, i) => {
    console.log(`  ${i + 1}. ${ex.name}`);
  });

  console.log("\n💡 Tips:");
  console.log("   - Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or GEMINI_API_KEY");
  console.log("   - Streaming provides real-time responses for better UX");
  console.log("   - Use AbortSignal to cancel long-running streams");
  console.log("   - Access chunk.route and chunk.step for flow information");

  console.log("\n" + "=".repeat(60));

  // Run first example if API key is available
  if (process.env.ANTHROPIC_API_KEY) {
    await streamingWithAnthropic();
  } else if (process.env.OPENAI_API_KEY) {
    await streamingWithOpenAI();
  } else if (process.env.GEMINI_API_KEY) {
    await streamingWithGemini();
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
