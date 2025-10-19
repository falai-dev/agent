/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */
/**
 * Example: Using OpenSearch for Persistence with Session Step
 *
 * OpenSearch provides powerful persistence with:
 * - Full-text search across conversations
 * - Analytics and aggregations on collected data
 * - Time-series analysis of sessions
 * - Compatible with Elasticsearch 7.x
 */

import {
  Agent,
  GeminiProvider,
  OpenSearchAdapter,
  END_ROUTE,
} from "../../src";

// @ts-expect-error - Client is not typed
import { Client } from "@opensearch-project/opensearch";

const client = new Client({
  url:{}
})
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

interface AnalyticsContext {
  userId: string;
  department: string;
}

interface TicketData {
  ticketType: string;
  priority: string;
  tags: string[];
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
  const adapter = new OpenSearchAdapter<ConversationContext>(client, {
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
    provider: new GeminiProvider({
      apiKey: process.env.GEMINI_API_KEY!,
      model: "models/gemini-2.5-flash",
    }),
    context: {
      userId,
      userName: "Alice",
      department: "customer_service",
    },
    persistence: {
      adapter,
      autoSave: true, // Auto-save session step with collected data
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
    schema: {
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

  // Step flow
  complaintRoute.initialStep
    .nextStep({
      prompt: "Understand the complaint",
      collect: ["category", "severity", "description"],
      skipIf: (data: Partial<ComplaintData>) => !!data.description,
    })
    .nextStep({
      prompt: "Identify affected service",
      collect: ["affectedService"],
      skipIf: (data: Partial<ComplaintData>) => !!data.affectedService,
      requires: ["description"],
    })
    .nextStep({
      prompt: "Ask for desired resolution",
      collect: ["requestedResolution"],
      skipIf: (data: Partial<ComplaintData>) => !!data.requestedResolution,
      requires: ["category", "description"],
    })
    .nextStep({
      prompt: "Propose solution and close complaint",
      requires: ["category", "description"],
    })
    .nextStep({ step: END_ROUTE });

  // Session is automatically managed by the agent
  console.log("✨ Session ready:", agent.session.id);
  
  // Set initial data
  await agent.session.setData<ComplaintData>({ severity: "medium" });

  // Turn 1
  console.log("\n--- Turn 1 ---");
  
  await agent.session.addMessage(
    "user",
    "I'm very upset! Your app keeps crashing when I try to make a payment. This is critical!",
    "Alice"
  );

  const response1 = await agent.respond({ 
    history: agent.session.getHistory() 
  });

  console.log("🤖 Agent:", response1.message);
  console.log("📊 Data:", agent.session.getData<ComplaintData>());
  
  await agent.session.addMessage("assistant", response1.message);

  // Turn 2
  console.log("\n--- Turn 2 ---");
  
  await agent.session.addMessage(
    "user",
    "It's the payment service. I want a full refund and compensation!",
    "Alice"
  );

  const response2 = await agent.respond({ 
    history: agent.session.getHistory() 
  });

  console.log("🤖 Agent:", response2.message);
  console.log("📊 Data:", agent.session.getData<ComplaintData>());

  await agent.session.addMessage("assistant", response2.message);

  if (response2.isRouteComplete) {
    console.log("\n✅ Complaint route complete!");
    await createSupportTicket(agent.session.getData<ComplaintData>() as ComplaintData);
  }

  // Demonstrate session recovery with new agent instance
  console.log("\n--- Session Recovery Example ---");
  const sessionId = agent.session.id;
  
  const recoveredAgent = new Agent<ConversationContext>({
    name: "Customer Service Agent",
    provider: new GeminiProvider({
      apiKey: process.env.GEMINI_API_KEY!,
      model: "models/gemini-2.5-flash",
    }),
    context: {
      userId,
      userName: "Alice",
      department: "customer_service",
    },
    persistence: {
      adapter,
      autoSave: true,
    },
    sessionId, // Same sessionId - will load existing session
  });

  // Recreate the same route on recovered agent
  recoveredAgent.createRoute<ComplaintData>({
    title: "Handle Customer Complaint",
    description: "Process and resolve customer complaints",
    conditions: [
      "User has a complaint",
      "User reports an issue or problem",
      "User is dissatisfied",
    ],
    schema: {
      type: "object",
      properties: {
        category: { type: "string", description: "Complaint category" },
        severity: {
          type: "string",
          enum: ["low", "medium", "high", "critical"],
          default: "medium",
          description: "Severity level",
        },
        description: { type: "string", description: "Detailed complaint description" },
        affectedService: { type: "string", description: "Which service is affected" },
        requestedResolution: { type: "string", description: "What resolution the customer wants" },
      },
      required: ["category", "severity", "description"],
    },
  });

  console.log("📥 Recovered session:", {
    sessionId: recoveredAgent.session.id,
    historyLength: recoveredAgent.session.getHistory().length,
    data: recoveredAgent.session.getData<ComplaintData>(),
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
  console.log("\n✅ Session completed and indexed!");

  // Cleanup
  if (adapter.disconnect) {
    await adapter.disconnect();
  }
}

/**
 * Advanced Example: Search and Analytics on Collected data
 */
async function analyticsExample() {
  const client = new Client({
    node: process.env.OPENSEARCH_URL || "https://localhost:9200",
    ssl: { rejectUnauthorized: false },
    auth: { username: "admin", password: "admin" },
  });

  const adapter = new OpenSearchAdapter<ConversationContext>(client, {
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

  const agent = new Agent<ConversationContext>({
    name: "Support Analyzer",
    provider: new GeminiProvider({
      apiKey: process.env.GEMINI_API_KEY!,
      model: "models/gemini-2.5-flash",
    }),
    persistence: {
      adapter,
      autoSave: true,
      userId: "analyst_001",
    },
  });

  const ticketRoute = agent.createRoute<TicketData>({
    title: "Analyze Support Ticket",
    schema: {
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

  ticketRoute.initialStep.nextStep({
    prompt: "Analyze and categorize ticket",
    collect: ["ticketType", "priority", "tags"],
  });

  // Create multiple sessions with different agents
  for (let i = 0; i < 3; i++) {
    const sessionAgent = new Agent<AnalyticsContext>({
      name: "Support Analyzer",
      provider: new GeminiProvider({
        apiKey: process.env.GEMINI_API_KEY!,
        model: "models/gemini-2.5-flash",
      }),
      context: {
        userId: "analyst_001",
        department: "support",
      },
      persistence: {
        adapter: new OpenSearchAdapter<AnalyticsContext>(client),
        autoSave: true,
      },
    });

    // Create the ticket route on each agent
    sessionAgent.createRoute<TicketData>({
      title: "Analyze Support Ticket",
      schema: {
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

    const ticketContent = `Support ticket ${i + 1}: ${
      ["Billing issue", "Technical problem", "Feature request"][i]
    }`;

    await sessionAgent.session.addMessage("user", ticketContent, "User");

    const response = await sessionAgent.respond({
      history: sessionAgent.session.getHistory(),
    });

    await sessionAgent.session.addMessage("assistant", response.message);

    console.log(`✅ Processed ticket ${i + 1}: ${response.message}`);
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

  // Analyze collected data patterns
  console.log("\n--- Analyze Collected data ---");
  const sessions = allSessions.body.hits.hits;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sessions.forEach((hit: Record<string, any>) => {
    const collectedData = hit._source.collectedData;
    console.log(`Session ${hit._id}:`, {
      data: collectedData?.data,
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

  const adapter = new OpenSearchAdapter<ConversationContext>(client);
  await adapter.initialize();

  new Agent<ConversationContext>({
    name: "Metrics Agent",
    provider: new GeminiProvider({
      apiKey: process.env.GEMINI_API_KEY!,
      model: "models/gemini-2.5-flash",
    }),
    persistence: { adapter, userId: "metrics_user" },
  });

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

/**
 * Mock function to create a support ticket.
 */
async function createSupportTicket(data: ComplaintData | undefined) {
  console.log("\n" + "=".repeat(60));
  console.log("🎫 Creating Support Ticket...");
  console.log("=".repeat(60));
  console.log("Ticket Details:", JSON.stringify(data, null, 2));
  console.log(
    `   - Creating ticket for category: ${data?.category} with severity: ${data?.severity}`
  );
  await new Promise((resolve) => setTimeout(resolve, 1000));
  console.log("✨ Ticket created successfully!");
}

// Run the example
if (require.main === module) {
  example().catch(console.error);
}

export { example, analyticsExample, timeSeriesExample };
