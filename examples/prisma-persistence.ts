/**
 * Example: Using Prisma ORM for Persistence
 *
 * This example shows how to use @falai/agent with Prisma for automatic
 * session and message persistence - as easy as using an AI provider!
 */

import {
  Agent,
  GeminiProvider,
  PrismaAdapter,
  createMessageEvent,
  EventSource,
} from "../src/index";

// @ts-ignore
import { PrismaClient } from "@prisma/client";

/**
 * Setup Steps:
 *
 * 1. Install dependencies:
 *    npm install prisma @prisma/client
 *
 * 2. Initialize Prisma:
 *    npx prisma init
 *
 * 3. Copy schema from examples/prisma-schema.example.prisma
 *    to your prisma/schema.prisma file
 *
 * 4. Generate Prisma client:
 *    npx prisma generate
 *
 * 5. Run migrations:
 *    npx prisma migrate dev --name init
 */

// Example context type
interface ConversationContext {
  userId: string;
  sessionId: string;
  userName: string;
  preferences: {
    language: string;
    theme: string;
  };
}

async function example() {
  // Initialize Prisma client
  const prisma = new PrismaClient();

  const userId = "user_123";

  /**
   * Create Agent with Persistence - Simple Provider Pattern! ✨
   */
  const agent = new Agent<ConversationContext>({
    name: "Shopping Assistant",
    description: "A helpful shopping assistant",
    ai: new GeminiProvider({
      apiKey: process.env.GEMINI_API_KEY!,
      model: "models/gemini-2.0-flash-exp",
    }),
    context: {
      userId,
      sessionId: "", // Will be set when we create/load a session
      userName: "Alice",
      preferences: {
        language: "en",
        theme: "light",
      },
    },
    // ✨ Just pass the adapter - that's it!
    persistence: {
      adapter: new PrismaAdapter({ prisma }),
      autoSave: true,
      userId,
    },
  });

  /**
   * Get persistence manager from agent
   */
  const persistence = agent.getPersistenceManager();

  if (!persistence) {
    throw new Error("Persistence not configured");
  }

  /**
   * Create or find a session
   */
  let session = await persistence.findActiveSession(userId);

  if (!session) {
    session = await persistence.createSession({
      userId,
      agentName: "Shopping Assistant",
      initialData: {
        language: "en",
        theme: "light",
      },
    });
    console.log("✨ Created new session:", session.id);
  } else {
    console.log("📂 Found active session:", session.id);
  }

  // Update context with session ID
  await agent.updateContext({
    sessionId: session.id,
  } as Partial<ConversationContext>);

  /**
   * Load conversation history
   */
  const history = await persistence.loadSessionHistory(session.id);
  console.log(`📜 Loaded ${history.length} messages from history`);

  /**
   * Send a message
   */
  const userMessage = createMessageEvent(
    EventSource.CUSTOMER,
    "Alice",
    "I'm looking for a winter jacket"
  );

  // Save user message
  await persistence.saveMessage({
    sessionId: session.id,
    userId,
    role: "user",
    content: "I'm looking for a winter jacket",
    event: userMessage,
  });

  history.push(userMessage);

  // Generate agent response
  const response = await agent.respond({ history });
  console.log("🤖 Agent:", response.message);

  // Save agent message
  await persistence.saveMessage({
    sessionId: session.id,
    userId,
    role: "agent",
    content: response.message,
    route: response.route?.id,
    state: response.state?.id,
    toolCalls: response.toolCalls,
  });

  /**
   * Query sessions and messages
   */
  const userSessions = await persistence.getUserSessions(userId);
  console.log(`👤 User has ${userSessions.length} total sessions`);

  const messages = await persistence.getSessionMessages(session.id);
  console.log(`💬 Session has ${messages.length} messages`);

  /**
   * Complete the session
   */
  await persistence.completeSession(session.id);
  console.log("✅ Session completed");

  /**
   * Cleanup
   */
  await prisma.$disconnect();
}

/**
 * Advanced Example: Using with Lifecycle Hooks
 */
async function advancedExample() {
  const prisma = new PrismaClient();
  const userId = "user_123";

  const agent = new Agent<ConversationContext>({
    name: "Smart Assistant",
    description: "An intelligent assistant with persistent state",
    ai: new GeminiProvider({
      apiKey: process.env.GEMINI_API_KEY!,
      model: "models/gemini-2.0-flash-exp",
    }),
    context: {
      userId,
      sessionId: "",
      userName: "Alice",
      preferences: {
        language: "en",
        theme: "light",
      },
    },
    // Lifecycle hooks for automatic context sync
    hooks: {
      // Load fresh context before each response
      beforeRespond: async (currentContext) => {
        const persistence = agent.getPersistenceManager();
        if (!persistence) return currentContext;

        const freshSession = await persistence.getSession(
          currentContext.sessionId
        );
        return {
          ...currentContext,
          preferences:
            (
              freshSession?.collectedData as {
                preferences?: typeof currentContext.preferences;
              }
            )?.preferences || currentContext.preferences,
        };
      },
      // Automatically persist context updates
      onContextUpdate: async (newContext) => {
        const persistence = agent.getPersistenceManager();
        if (!persistence) return;

        await persistence.updateCollectedData(newContext.sessionId, {
          preferences: newContext.preferences,
        });
      },
    },
    // ✨ Same simple adapter pattern!
    persistence: {
      adapter: new PrismaAdapter({ prisma }),
      autoSave: true,
      userId,
    },
  });

  // Create a session
  const persistence = agent.getPersistenceManager();
  const session = await persistence!.createSession({
    userId,
    agentName: "Smart Assistant",
  });

  await agent.updateContext({
    sessionId: session.id,
  } as Partial<ConversationContext>);

  // Now context updates are automatically persisted!
  await agent.updateContext({
    preferences: {
      language: "es",
      theme: "dark",
    },
  } as Partial<ConversationContext>);

  console.log("🎉 Context updates automatically saved to database!");

  await prisma.$disconnect();
}

/**
 * Minimal Example - Quick Start
 */
async function quickStart() {
  const prisma = new PrismaClient();

  // That's it! Just create the adapter and pass it
  const agent = new Agent({
    name: "My Agent",
    description: "A helpful assistant",
    ai: new GeminiProvider({
      apiKey: process.env.GEMINI_API_KEY!,
      model: "models/gemini-2.5-flash",
    }),
    persistence: {
      adapter: new PrismaAdapter({ prisma }), // ✨ Simple!
      userId: "user_123",
    },
  });

  // Get persistence manager
  const persistence = agent.getPersistenceManager();
  if (!persistence) return;

  // Create session
  const session = await persistence.createSession({
    userId: "user_123",
    agentName: "My Agent",
  });

  // Load history and respond
  const history = await persistence.loadSessionHistory(session.id);
  const response = await agent.respond({ history });

  // Save message
  await persistence.saveMessage({
    sessionId: session.id,
    role: "agent",
    content: response.message,
  });

  console.log("✅ Done! Messages automatically saved to Prisma.");

  await prisma.$disconnect();
}

// Run the example
if (require.main === module) {
  example().catch(console.error);
}

export { example, advancedExample, quickStart };
