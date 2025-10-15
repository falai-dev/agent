/**
 * Example: Streaming Responses
 * Updated for v2 architecture with session state management
 *
 * This example demonstrates how to use the respondStream method
 * to stream AI responses in real-time for better user experience
 */

import {
  Agent,
  createMessageEvent,
  EventSource,
  AnthropicProvider,
  OpenAIProvider,
  GeminiProvider,
  createSession,
} from "../src/index";

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
  const agent = new Agent<ConversationContext>({
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
    ai: provider,
  });

  // Add guidelines
  agent.createGuideline({
    action: "Be concise but informative in your responses",
    enabled: true,
  });

  // Create conversation history
  const history = [
    createMessageEvent(
      EventSource.CUSTOMER,
      "User",
      "Explain quantum computing in simple terms."
    ),
  ];

  try {
    console.log("📤 Streaming response from Claude...\n");
    console.log("Response: ");

    // Initialize session state for streaming conversation
    let session = createSession();

    // Use respondStream for real-time streaming with session state
    let fullMessage = "";
    for await (const chunk of agent.respondStream({ history, session })) {
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
        console.log(`   - Extracted:`, chunk.session?.extracted || "None");
        console.log(`   - Tool Calls: ${chunk.toolCalls?.length || 0}`);

        // Update session with progress
        session = chunk.session!;
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

  const agent = new Agent<ConversationContext>({
    name: "CreativeAssistant",
    description: "A creative AI assistant",
    context: {
      userId: "user123",
      sessionId: "session789",
      preferences: {
        streamingEnabled: true,
      },
    },
    ai: provider,
  });

  const history = [
    createMessageEvent(
      EventSource.CUSTOMER,
      "User",
      "Write a short poem about TypeScript"
    ),
  ];

  try {
    console.log("📤 Streaming response from OpenAI...\n");
    console.log("Response: ");

    // Initialize session state for streaming conversation
    let session = createSession();

    for await (const chunk of agent.respondStream({ history, session })) {
      if (chunk.delta) {
        process.stdout.write(chunk.delta);
      }

      if (chunk.done) {
        console.log("\n\n✅ Stream complete!");
        console.log(
          `   - Route: ${chunk.session?.currentRoute?.title || "None"}`
        );
        console.log(`   - Extracted:`, chunk.session?.extracted || "None");

        // Update session with progress
        session = chunk.session!;
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
    model: "models/gemini-2.0-flash-exp",
    config: {
      temperature: 0.7,
    },
  });

  const agent = new Agent<ConversationContext>({
    name: "AnalyticalAssistant",
    description: "An analytical AI assistant",
    context: {
      userId: "user123",
      sessionId: "session101",
      preferences: {
        streamingEnabled: true,
      },
    },
    ai: provider,
  });

  const history = [
    createMessageEvent(
      EventSource.CUSTOMER,
      "User",
      "What are the key differences between REST and GraphQL?"
    ),
  ];

  try {
    console.log("📤 Streaming response from Gemini...\n");
    console.log("Response: ");

    // Initialize session state for streaming conversation
    let session = createSession();

    for await (const chunk of agent.respondStream({ history, session })) {
      if (chunk.delta) {
        process.stdout.write(chunk.delta);
      }

      if (chunk.done) {
        console.log("\n\n✅ Stream complete!");
        console.log(
          `   - Route: ${chunk.session?.currentRoute?.title || "None"}`
        );
        console.log(`   - Extracted:`, chunk.session?.extracted || "None");

        // Update session with progress
        session = chunk.session!;
      }
    }
  } catch (error) {
    console.error("❌ Error:", error);
  }
}

async function streamingWithRoutes() {
  console.log("\n🤖 Example 4: Streaming with Routes and States\n");

  const provider = new AnthropicProvider({
    apiKey: process.env.ANTHROPIC_API_KEY || "",
    model: "claude-sonnet-4-5",
  });

  const agent = new Agent<ConversationContext>({
    name: "SupportAgent",
    description: "A customer support agent with conversation routes",
    context: {
      userId: "user123",
      sessionId: "session202",
      preferences: {
        streamingEnabled: true,
      },
    },
    ai: provider,
  });

  // Create a route
  const supportRoute = agent.createRoute({
    title: "Product Support",
    description: "Help users with product questions",
    conditions: ["User asks about product features or issues"],
  });

  supportRoute.initialState.transitionTo({
    chatState: "Understand the user's product question",
  });

  const history = [
    createMessageEvent(
      EventSource.CUSTOMER,
      "User",
      "How do I reset my password?"
    ),
  ];

  try {
    console.log("📤 Streaming response with route detection...\n");
    console.log("Response: ");

    // Initialize session state for streaming conversation
    let session = createSession();

    for await (const chunk of agent.respondStream({ history, session })) {
      if (chunk.delta) {
        process.stdout.write(chunk.delta);
      }

      if (chunk.done) {
        console.log("\n\n✅ Stream complete!");
        console.log(`\n📊 Metadata:`);
        console.log(
          `   - Route: ${chunk.session?.currentRoute?.title || "None"}`
        );
        console.log(`   - Extracted:`, chunk.session?.extracted || "None");

        // Update session with progress
        session = chunk.session!;
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

  const agent = new Agent<ConversationContext>({
    name: "Assistant",
    description: "An assistant that can be interrupted",
    context: {
      userId: "user123",
      sessionId: "session303",
      preferences: {
        streamingEnabled: true,
      },
    },
    ai: provider,
  });

  const history = [
    createMessageEvent(
      EventSource.CUSTOMER,
      "User",
      "Tell me a very long story about space exploration."
    ),
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

    // Initialize session state for streaming conversation
    let session = createSession();

    for await (const chunk of agent.respondStream({
      history,
      session,
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
        console.log(`   - Extracted:`, chunk.session?.extracted || "None");

        // Update session with progress
        session = chunk.session!;

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
  console.log("   - Access chunk.route and chunk.state for flow information");

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
