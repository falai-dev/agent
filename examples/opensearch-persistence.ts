/**
 * OpenSearch Persistence Example
 *
 * This example demonstrates how to use the OpenSearchAdapter for persistent storage.
 * Also compatible with Elasticsearch 7.x.
 *
 * Setup:
 * 1. Install the OpenSearch client: npm install @opensearch-project/opensearch
 * 2. Run OpenSearch locally:
 *    docker run -d -p 9200:9200 -p 9600:9600 -e "discovery.type=single-node" opensearchproject/opensearch:latest
 * 3. Run this example: bun run examples/opensearch-persistence.ts
 */

// @ts-ignore - OpenSearch is a peer dependency
import { Client } from "@opensearch-project/opensearch";
import {
  Agent,
  GeminiProvider,
  OpenSearchAdapter,
  defineTool,
  createMessageEvent,
  EventSource,
} from "../src/index.js";

// Initialize OpenSearch client
const client = new Client({
  node: process.env.OPENSEARCH_URL || "https://localhost:9200",
  auth: {
    username: process.env.OPENSEARCH_USERNAME || "admin",
    password: process.env.OPENSEARCH_PASSWORD || "admin",
  },
  ssl: {
    rejectUnauthorized: false, // For development only!
  },
});

// Create adapter with custom index names
const adapter = new OpenSearchAdapter(client, {
  indices: {
    sessions: "my_agent_sessions",
    messages: "my_agent_messages",
  },
  autoCreateIndices: true, // Automatically create indices with mappings
  refresh: "wait_for", // Wait for documents to be searchable (slower but consistent)
});

// Define context type
interface TravelContext {
  userId: string;
  userName: string;
}

// Define a simple tool
const bookFlight = defineTool<
  TravelContext,
  [destination: string, date: string],
  { success: boolean; confirmation: string }
>(
  "book_flight",
  async ({ context }, destination, date) => {
    console.log(`📝 Booking flight for ${context.userName}...`);
    return {
      data: {
        success: true,
        confirmation: `Flight to ${destination} booked for ${date}`,
      },
    };
  },
  {
    description: "Book a flight for the user",
    parameters: {
      type: "object",
      properties: {
        destination: { type: "string", description: "Destination city" },
        date: { type: "string", description: "Travel date" },
      },
      required: ["destination", "date"],
    },
  }
);

// Create agent with OpenSearch persistence
const agent = new Agent<TravelContext>({
  name: "Travel Assistant",
  description: "A helpful travel booking assistant",
  ai: new GeminiProvider({
    apiKey: process.env.GEMINI_API_KEY || "",
    model: "gemini-2.0-flash-exp",
  }),
  context: {
    userId: "user_123",
    userName: "Alex",
  },
  persistence: {
    adapter,
    autoSave: true,
    userId: "user_123",
  },
  capabilities: [
    {
      title: "Flight Booking",
      description: "Book flights for travel",
      tools: [bookFlight],
    },
  ],
});

async function main() {
  try {
    console.log("🚀 Starting OpenSearch persistence example...\n");

    // First conversation
    console.log("💬 User: I need to book a flight to Tokyo");
    const history1 = [
      createMessageEvent(
        EventSource.CUSTOMER,
        "Alex",
        "I need to book a flight to Tokyo"
      ),
    ];
    let response = await agent.respond({ history: history1 });
    console.log("🤖 Agent:", response.message);
    console.log();

    // Continue conversation (uses same session)
    console.log("💬 User: Make it for next Monday");
    const history2 = [
      ...history1,
      createMessageEvent(
        EventSource.AI_AGENT,
        "Travel Assistant",
        response.message
      ),
      createMessageEvent(
        EventSource.CUSTOMER,
        "Alex",
        "Make it for next Monday"
      ),
    ];
    response = await agent.respond({ history: history2 });
    console.log("🤖 Agent:", response.message);
    console.log();

    // Get persistence manager
    const pm = agent.getPersistenceManager();
    if (pm) {
      // Query sessions
      const sessions = await pm.getUserSessions("user_123");
      console.log(`📊 Found ${sessions.length} session(s) for user_123`);

      if (sessions.length > 0) {
        const session = sessions[0];
        console.log(`   Session ID: ${session.id}`);
        console.log(`   Status: ${session.status}`);
        console.log(`   Messages: ${session.messageCount || 0}`);
        console.log();

        // Query messages
        const messages = await pm.getSessionMessages(session.id);
        console.log(`📝 Session has ${messages.length} message(s):`);
        messages.forEach((msg, idx) => {
          console.log(
            `   ${idx + 1}. [${msg.role}] ${msg.content.substring(0, 50)}...`
          );
        });
      }
    }

    console.log("\n✅ OpenSearch persistence example completed!");
  } catch (error) {
    console.error("❌ Error:", error);
  }
}

main();
