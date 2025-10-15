/**
 * Example: Using OpenSearch for Persistence with Session State
 *
 * OpenSearch provides powerful persistence with:
 * - Full-text search across conversations
 * - Analytics and aggregations on extracted data
 * - Time-series analysis of sessions
 * - Compatible with Elasticsearch 7.x
 */

import {
  Agent,
  GeminiProvider,
  OpenSearchAdapter,
  createMessageEvent,
  EventSource,
  MessageEventData,
  Event,
} from "../src/index";
// @ts-ignore
import { Client } from "@opensearch-project/opensearch";

/**
 * Setup Steps:
 *
 * 1. Install OpenSearch and client:
 *    brew install opensearch (macOS) or docker run opensearch
 *    npm install @opensearch-project/opensearch
 *
 * 2. Start OpenSearch:
 *    opensearch or docker start opensearch
 *
 * 3. Run this example
 */

interface ConversationContext {
  userId: string;
  userName: string;
  department: string;
}

interface ComplaintData {
  category: string;
  severity: "low" | "medium" | "high" | "critical";
  description: string;
  affectedService?: string;
  requestedResolution?: string;
}

async function example() {
  // Initialize OpenSearch client
  const client = new Client({
    node: process.env.OPENSEARCH_URL || "https://localhost:9200",
    ssl: {
      rejectUnauthorized: false, // For development only
    },
    auth: {
      username: "admin",
      password: "admin",
    },
  });

  const userId = "user_123";

  // Create adapter
  const adapter = new OpenSearchAdapter(client, {
    indices: {
      sessions: "agent_sessions",
      messages: "agent_messages",
    },
    autoCreateIndices: true,
    refresh: "wait_for", // Ensure searchability immediately
  });

  // Initialize indices
  await adapter.initialize();

  // Create agent with OpenSearch persistence
  const agent = new Agent<ConversationContext>({
    name: "Customer Service Agent",
    description: "Handle customer complaints with full-text search",
    goal: "Resolve customer issues efficiently",
    ai: new GeminiProvider({
      apiKey: process.env.GEMINI_API_KEY!,
      model: "models/gemini-2.0-flash-exp",
    }),
    context: {
      userId,
      userName: "Alice",
      department: "customer_service",
    },
    persistence: {
      adapter,
      autoSave: true, // Auto-save session state with extracted data
      userId,
    },
  });

  // Create complaint handling route
  const complaintRoute = agent.createRoute<ComplaintData>({
    title: "Handle Customer Complaint",
    description: "Process and resolve customer complaints",
    conditions: [
      "User has a complaint",
      "User reports an issue or problem",
      "User is dissatisfied",
    ],
    gatherSchema: {
      type: "object",
      properties: {
        category: {
          type: "string",
          description: "Complaint category",
        },
        severity: {
          type: "string",
          enum: ["low", "medium", "high", "critical"],
          default: "medium",
          description: "Severity level",
        },
        description: {
          type: "string",
          description: "Detailed complaint description",
        },
        affectedService: {
          type: "string",
          description: "Which service is affected",
        },
        requestedResolution: {
          type: "string",
          description: "What resolution the customer wants",
        },
      },
      required: ["category", "severity", "description"],
    },
  });

  // State flow
  complaintRoute.initialState
    .transitionTo({
      chatState: "Understand the complaint",
      gather: ["category", "severity", "description"],
      skipIf: (data) => !!data.description,
    })
    .transitionTo({
      chatState: "Identify affected service",
      gather: ["affectedService"],
      skipIf: (data) => !!data.affectedService,
      requiredData: ["description"],
    })
    .transitionTo({
      chatState: "Ask for desired resolution",
      gather: ["requestedResolution"],
      skipIf: (data) => !!data.requestedResolution,
      requiredData: ["category", "description"],
    })
    .transitionTo({
      chatState: "Propose solution and close complaint",
      requiredData: ["category", "description"],
    });

  const persistence = agent.getPersistenceManager();
  if (!persistence) return;

  // Create session with state
  const { sessionData, sessionState } =
    await persistence.createSessionWithState<ComplaintData>({
      userId,
      agentName: "Customer Service Agent",
      initialData: {
        severity: "medium",
      },
    });

  console.log("✨ Session created in OpenSearch:", sessionData.id);

  // Conversation flow
  const history: Event<MessageEventData>[] = [];
  let session = sessionState;

  // Turn 1
  console.log("\n--- Turn 1 ---");
  const message1 = createMessageEvent(
    EventSource.CUSTOMER,
    "Alice",
    "I'm very upset! Your app keeps crashing when I try to make a payment. This is critical!"
  );
  history.push(message1);

  const response1 = await agent.respond({ history, session });

  console.log("🤖 Agent:", response1.message);
  console.log("📊 Extracted:", response1.session?.extracted);

  await persistence.saveMessage({
    sessionId: sessionData.id,
    role: "user",
    content: message1.data.message,
    event: message1,
  });

  await persistence.saveMessage({
    sessionId: sessionData.id,
    role: "agent",
    content: response1.message,
    route: response1.session?.currentRoute?.id,
    state: response1.session?.currentState?.id,
  });

  session = response1.session!;

  // Turn 2
  console.log("\n--- Turn 2 ---");
  history.push(
    createMessageEvent(EventSource.AI_AGENT, "Agent", response1.message)
  );

  const message2 = createMessageEvent(
    EventSource.CUSTOMER,
    "Alice",
    "It's the payment service. I want a full refund and compensation!"
  );
  history.push(message2);

  const response2 = await agent.respond({ history, session });

  console.log("🤖 Agent:", response2.message);
  console.log("📊 Extracted:", response2.session?.extracted);

  await persistence.saveMessage({
    sessionId: sessionData.id,
    role: "user",
    content: message2.data.message,
  });

  await persistence.saveMessage({
    sessionId: sessionData.id,
    role: "agent",
    content: response2.message,
  });

  // Load session from OpenSearch
  console.log("\n--- Loading Session from OpenSearch ---");
  const loadedSession = await persistence.loadSessionState<ComplaintData>(
    sessionData.id
  );

  console.log("📥 Loaded session:", {
    currentRoute: loadedSession?.currentRoute?.title,
    extracted: loadedSession?.extracted,
  });

  // Demonstrate full-text search
  console.log("\n--- Full-Text Search Example ---");
  const searchResults = await client.search({
    index: "agent_messages",
    body: {
      query: {
        match: {
          content: "payment crash",
        },
      },
    },
  });

  console.log(
    `🔍 Found ${searchResults.body.hits.total.value} messages matching "payment crash"`
  );

  // Demonstrate aggregations
  console.log("\n--- Analytics Example ---");
  const aggResults = await client.search({
    index: "agent_sessions",
    body: {
      size: 0,
      aggs: {
        by_status: {
          terms: { field: "status.keyword" },
        },
        by_agent: {
          terms: { field: "agentName.keyword" },
        },
      },
    },
  });

  console.log("📊 Session statistics:", aggResults.body.aggregations);

  // Complete session
  await persistence.completeSession(sessionData.id);
  console.log("\n✅ Session completed and indexed!");

  // Cleanup
  if (adapter.disconnect) {
    await adapter.disconnect();
  }
}

/**
 * Advanced Example: Search and Analytics on Extracted Data
 */
async function analyticsExample() {
  const client = new Client({
    node: process.env.OPENSEARCH_URL || "https://localhost:9200",
    ssl: { rejectUnauthorized: false },
    auth: { username: "admin", password: "admin" },
  });

  const adapter = new OpenSearchAdapter(client, {
    indices: {
      sessions: "support_sessions",
      messages: "support_messages",
    },
    autoCreateIndices: true,
  });

  await adapter.initialize();

  interface TicketData {
    ticketType: string;
    priority: string;
    tags: string[];
  }

  const agent = new Agent({
    name: "Support Analyzer",
    ai: new GeminiProvider({
      apiKey: process.env.GEMINI_API_KEY!,
      model: "models/gemini-2.0-flash-exp",
    }),
    persistence: {
      adapter,
      autoSave: true,
      userId: "analyst_001",
    },
  });

  const ticketRoute = agent.createRoute<TicketData>({
    title: "Analyze Support Ticket",
    gatherSchema: {
      type: "object",
      properties: {
        ticketType: { type: "string" },
        priority: { type: "string" },
        tags: {
          type: "array",
          items: { type: "string" },
        },
      },
      required: ["ticketType", "priority"],
    },
  });

  ticketRoute.initialState.transitionTo({
    chatState: "Analyze and categorize ticket",
    gather: ["ticketType", "priority", "tags"],
  });

  const persistence = agent.getPersistenceManager()!;

  // Create multiple sessions
  for (let i = 0; i < 3; i++) {
    const { sessionData, sessionState } =
      await persistence.createSessionWithState<TicketData>({
        userId: "analyst_001",
        agentName: "Support Analyzer",
      });

    const response = await agent.respond({
      history: [
        createMessageEvent(
          EventSource.CUSTOMER,
          "User",
          `Support ticket ${i + 1}: ${
            ["Billing issue", "Technical problem", "Feature request"][i]
          }`
        ),
      ],
      session: sessionState,
    });

    await persistence.saveMessage({
      sessionId: sessionData.id,
      role: "agent",
      content: response.message,
    });

    await persistence.completeSession(sessionData.id);
  }

  // Search across all sessions
  console.log("\n--- Search All Sessions ---");
  const allSessions = await client.search({
    index: "support_sessions",
    body: {
      query: { match_all: {} },
    },
  });

  console.log(
    `📊 Total sessions indexed: ${allSessions.body.hits.total.value}`
  );

  // Analyze extracted data patterns
  console.log("\n--- Analyze Extracted Data ---");
  const sessions = allSessions.body.hits.hits;

  sessions.forEach((hit: any) => {
    const collectedData = hit._source.collectedData;
    console.log(`Session ${hit._id}:`, {
      extracted: collectedData?.extracted,
      route: hit._source.currentRoute,
    });
  });

  console.log("✅ Analytics complete!");

  if (adapter.disconnect) {
    await adapter.disconnect();
  }
}

/**
 * Time-Series Analysis Example
 */
async function timeSeriesExample() {
  const client = new Client({
    node: process.env.OPENSEARCH_URL || "https://localhost:9200",
    ssl: { rejectUnauthorized: false },
    auth: { username: "admin", password: "admin" },
  });

  const adapter = new OpenSearchAdapter(client);
  await adapter.initialize();

  const agent = new Agent({
    name: "Metrics Agent",
    ai: new GeminiProvider({
      apiKey: process.env.GEMINI_API_KEY!,
      model: "models/gemini-2.0-flash-exp",
    }),
    persistence: { adapter, userId: "metrics_user" },
  });

  const persistence = agent.getPersistenceManager()!;

  // Query sessions over time
  const timeQuery = await client.search({
    index: "agent_sessions",
    body: {
      size: 0,
      aggs: {
        sessions_over_time: {
          date_histogram: {
            field: "createdAt",
            calendar_interval: "day",
          },
        },
        avg_message_count: {
          avg: { field: "messageCount" },
        },
      },
    },
  });

  console.log("📈 Time-series metrics:", timeQuery.body.aggregations);
  console.log("✅ Time-series analysis complete!");

  if (adapter.disconnect) {
    await adapter.disconnect();
  }
}

// Run the example
if (require.main === module) {
  example().catch(console.error);
}

export { example, analyticsExample, timeSeriesExample };
