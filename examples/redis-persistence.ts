/**
 * Example: Using Redis for Persistence
 *
 * Fast, in-memory persistence perfect for:
 * - High-throughput applications
 * - Session caching
 * - Real-time chat applications
 * - Temporary conversation storage
 */

import { Agent, GeminiProvider, RedisAdapter } from "../src/index";
// @ts-ignore
import Redis from "ioredis";

/**
 * Setup Steps:
 *
 * 1. Install Redis and client:
 *    brew install redis (macOS) or apt-get install redis (Linux)
 *    npm install ioredis
 *
 * 2. Start Redis:
 *    redis-server
 *
 * 3. Run this example
 */

async function example() {
  // Initialize Redis client
  const redis = new Redis();

  // Create agent with Redis persistence
  const agent = new Agent({
    name: "Chat Assistant",
    description: "Fast, real-time chat assistant",
    ai: new GeminiProvider({
      apiKey: process.env.GEMINI_API_KEY!,
      model: "models/gemini-2.0-flash-exp",
    }),
    // ✨ Redis adapter with custom options
    persistence: {
      adapter: new RedisAdapter({
        redis,
        keyPrefix: "chat:", // Custom prefix
        sessionTTL: 24 * 60 * 60, // 24 hours
        messageTTL: 7 * 24 * 60 * 60, // 7 days
      }),
      autoSave: true,
      userId: "user_123",
    },
  });

  const persistence = agent.getPersistenceManager();
  if (!persistence) return;

  // Create session
  const session = await persistence.createSession({
    userId: "user_123",
    agentName: "Chat Assistant",
    initialData: { chatType: "support" },
  });

  console.log("✨ Session created in Redis:", session.id);

  // Save a message
  await persistence.saveMessage({
    sessionId: session.id,
    role: "user",
    content: "Hello! I need help",
  });

  // Load messages
  const messages = await persistence.getSessionMessages(session.id);
  console.log(`💬 ${messages.length} messages in session`);

  // Complete session
  await persistence.completeSession(session.id);
  console.log("✅ Session completed");

  // Cleanup
  await redis.quit();
}

// Run the example
if (require.main === module) {
  example().catch(console.error);
}

export { example };
