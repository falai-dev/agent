/**
 * Example: Modern Streaming API
 * 
 * This example demonstrates the new agent.stream() method introduced in the
 * ResponseModal refactor. The modern API provides automatic session management
 * and a simpler interface compared to the legacy respondStream() method.
 */

import {
  Agent,
  AnthropicProvider,
  OpenAIProvider,
} from "../../src/index";

// Context type for our examples
interface UserContext {
  userId: string;
  preferences: {
    language?: string;
    verbosity: "concise" | "detailed";
  };
}

async function basicModernStreaming() {
  console.log("\n🚀 Example 1: Basic Modern Streaming API\n");

  const provider = new AnthropicProvider({
    apiKey: process.env.ANTHROPIC_API_KEY || "",
    model: "claude-sonnet-4-5",
  });

  const agent = new Agent<UserContext, unknown>({
    name: "ModernStreamingAgent",
    description: "Demonstrates the new stream() API",
    context: {
      userId: "user123",
      preferences: {
        language: "English",
        verbosity: "concise",
      },
    },
    provider,
  });

  try {
    console.log("📤 Using modern stream() API...\n");
    console.log("Response: ");

    // NEW: Simple streaming with automatic session management
    for await (const chunk of agent.stream("What is machine learning?")) {
      if (chunk.delta) {
        process.stdout.write(chunk.delta);
      }

      if (chunk.done) {
        console.log("\n\n✅ Stream complete!");
        console.log(`📊 Session has ${agent.session.getHistory().length} messages`);
        console.log("💡 Session history was automatically managed!");
      }
    }
  } catch (error) {
    console.error("❌ Error:", error);
  }
}

async function streamingWithOptions() {
  console.log("\n🚀 Example 2: Streaming with Options\n");

  const provider = new OpenAIProvider({
    apiKey: process.env.OPENAI_API_KEY || "",
    model: "gpt-4",
  });

  const agent = new Agent<UserContext, unknown>({
    name: "OptionsStreamingAgent",
    description: "Demonstrates streaming with options",
    context: {
      userId: "user456",
      preferences: {
        language: "English",
        verbosity: "detailed",
      },
    },
    provider,
  });

  try {
    console.log("📤 Streaming with context override and abort signal...\n");
    console.log("Response: ");

    // Create abort controller for cancellation
    const abortController = new AbortController();
    
    // Cancel after 10 seconds
    setTimeout(() => {
      console.log("\n⚠️ Aborting stream...");
      abortController.abort();
    }, 10000);

    // Stream with options
    for await (const chunk of agent.stream("Explain quantum computing in detail", {
      contextOverride: {
        preferences: { verbosity: "concise" } // Override to be more concise
      },
      signal: abortController.signal
    })) {
      if (chunk.delta) {
        process.stdout.write(chunk.delta);
      }

      if (chunk.done) {
        console.log("\n\n✅ Stream complete!");
        console.log("💡 Context was overridden for this response only");
        clearTimeout();
      }
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      console.log("\n🛑 Stream was successfully aborted!");
    } else {
      console.error("❌ Error:", error);
    }
  }
}

async function conversationFlow() {
  console.log("\n🚀 Example 3: Multi-turn Conversation Flow\n");

  const provider = new AnthropicProvider({
    apiKey: process.env.ANTHROPIC_API_KEY || "",
    model: "claude-sonnet-4-5",
  });

  const agent = new Agent<UserContext, unknown>({
    name: "ConversationAgent",
    description: "Demonstrates multi-turn conversations",
    context: {
      userId: "user789",
      preferences: {
        language: "English",
        verbosity: "detailed",
      },
    },
    provider,
  });

  const messages = [
    "What is TypeScript?",
    "How is it different from JavaScript?",
    "Can you give me a simple example?",
    "Thank you for the explanation!"
  ];

  try {
    console.log("📤 Multi-turn conversation with automatic session management...\n");

    for (let i = 0; i < messages.length; i++) {
      console.log(`\n${"=".repeat(60)}`);
      console.log(`💬 Turn ${i + 1}: ${messages[i]}`);
      console.log(`${"=".repeat(60)}`);
      console.log("Response: ");

      // Each stream() call automatically manages the session
      for await (const chunk of agent.stream(messages[i])) {
        if (chunk.delta) {
          process.stdout.write(chunk.delta);
        }

        if (chunk.done) {
          console.log(`\n📊 Session now has ${agent.session.getHistory().length} messages`);
        }
      }
    }

    console.log("\n✅ Conversation complete!");
    console.log("💡 All session management was handled automatically");
    console.log(`📊 Final session has ${agent.session.getHistory().length} messages`);

  } catch (error) {
    console.error("❌ Error:", error);
  }
}

async function migrationComparison() {
  console.log("\n🚀 Example 4: Migration from respondStream() to stream()\n");

  const provider = new AnthropicProvider({
    apiKey: process.env.ANTHROPIC_API_KEY || "",
    model: "claude-sonnet-4-5",
  });

  const agent = new Agent<UserContext, unknown>({
    name: "MigrationAgent",
    description: "Shows migration from old to new API",
    context: {
      userId: "migration-user",
      preferences: {
        language: "English",
        verbosity: "concise",
      },
    },
    provider,
  });

  const userMessage = "What are the benefits of TypeScript?";

  try {
    // ========================================================================
    // OLD WAY: respondStream() - Manual session management
    // ========================================================================
    console.log("🔸 OLD WAY: Using respondStream() with manual session management");
    console.log("Code: agent.respondStream({ history: agent.session.getHistory() })");
    console.log("Response: ");

    // Manual session management required
    await agent.session.addMessage("user", userMessage);
    
    let oldResponse = "";
    for await (const chunk of agent.respondStream({ 
      history: agent.session.getHistory() 
    })) {
      if (chunk.delta) {
        process.stdout.write(chunk.delta);
        oldResponse += chunk.delta;
      }

      if (chunk.done) {
        // Manual history update required
        await agent.session.addMessage("assistant", oldResponse);
        console.log("\n   ✅ Manual session update completed");
      }
    }

    console.log("\n" + "=".repeat(60));

    // ========================================================================
    // NEW WAY: stream() - Automatic session management
    // ========================================================================
    console.log("🔸 NEW WAY: Using stream() with automatic session management");
    console.log("Code: agent.stream('message')");
    console.log("Response: ");

    // Automatic session management - just pass the message!
    for await (const chunk of agent.stream("Can you elaborate on the type safety benefits?")) {
      if (chunk.delta) {
        process.stdout.write(chunk.delta);
      }

      if (chunk.done) {
        console.log("\n   ✅ Automatic session update - no manual work needed!");
      }
    }

    console.log("\n📊 Migration Benefits:");
    console.log("   ✅ Simpler API: agent.stream('message') vs complex parameters");
    console.log("   ✅ Automatic session management - no manual addMessage() calls");
    console.log("   ✅ Same performance and features as respondStream()");
    console.log("   ✅ Backward compatibility - respondStream() still works");
    console.log("   ✅ Consistent with chat() API patterns");

    console.log(`\n📊 Final session has ${agent.session.getHistory().length} messages`);

  } catch (error) {
    console.error("❌ Error:", error);
  }
}

async function main() {
  console.log("🚀 Modern Streaming API Examples");
  console.log("=".repeat(60));

  const examples = [
    { name: "Basic Modern Streaming", fn: basicModernStreaming },
    { name: "Streaming with Options", fn: streamingWithOptions },
    { name: "Multi-turn Conversation", fn: conversationFlow },
    { name: "Migration Comparison", fn: migrationComparison },
  ];

  console.log("\nAvailable Examples:");
  examples.forEach((ex, i) => {
    console.log(`  ${i + 1}. ${ex.name}`);
  });

  console.log("\n💡 Key Benefits of Modern stream() API:");
  console.log("   - Simple interface: agent.stream('message')");
  console.log("   - Automatic session management");
  console.log("   - No manual history updates needed");
  console.log("   - Same performance as respondStream()");
  console.log("   - Full backward compatibility maintained");

  console.log("\n" + "=".repeat(60));

  // Run examples if API key is available
  if (process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY) {
    await basicModernStreaming();
    await migrationComparison();
  } else {
    console.log(
      "\n⚠️  Set ANTHROPIC_API_KEY or OPENAI_API_KEY to run examples."
    );
  }
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}

export { main };