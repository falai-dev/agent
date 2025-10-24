/**
 * Memory Session Management Example
 *
 * This example demonstrates how to use in-memory session management for
 * conversational agents. Shows session creation, persistence, restoration,
 * and management without external databases.
 *
 * Key concepts:
 * - In-memory session storage
 * - Session lifecycle management
 * - Session restoration
 * - Multi-user session handling
 * - Session metadata
 * - Automatic cleanup
 */

import {
  Agent,
  GeminiProvider,
  MemoryAdapter,
  type Tool,
} from "../../src/index";

// Define data types
interface SupportTicketData {
  issue: string;
  category: "technical" | "billing" | "account" | "general";
  priority: "low" | "medium" | "high";
  status: "open" | "in_progress" | "resolved";
  ticketId?: string;
  assignedAgent?: string;
}

interface SupportContext {
  userId: string;
  userName: string;
  userTier: "standard" | "premium" | "enterprise";
}

// Support tools
const createTicket: Tool<unknown, SupportTicketData> = {
  id: "create_support_ticket",
  description: "Create a new support ticket",
  parameters: {
    type: "object",
    properties: {},
  },
  handler: (context, args) => {
    const ticketData = context.data;
    const ticketId = `TICKET-${Date.now()}`;
    console.log(
      `Creating ticket ${ticketId} for ${ticketData?.category} issue`
    );

    return {
      data: `Support ticket ${ticketId} created successfully.`,
      dataUpdate: {
        ticketId,
        status: "open" as const,
      },
    };
  },
};

// Define support ticket schema
const supportTicketSchema = {
  type: "object",
  properties: {
    issue: { type: "string" },
    category: {
      type: "string",
      enum: ["technical", "billing", "account", "general"],
    },
    priority: { type: "string", enum: ["low", "medium", "high"] },
    status: { type: "string", enum: ["open", "in_progress", "resolved"] },
    ticketId: { type: "string" },
    assignedAgent: { type: "string" },
  },
  required: ["issue"],
};

// Create agent with memory persistence
const agent = new Agent<unknown, SupportTicketData>({
  name: "SupportBot",
  description: "A support agent with memory-based session management",
  provider: new GeminiProvider({
    apiKey: process.env.GEMINI_API_KEY!,
    model: "models/gemini-2.5-flash",
  }),
  // NEW: Agent-level schema
  schema: supportTicketSchema,
  persistence: {
    adapter: new MemoryAdapter(),
  },
});

// Create support route with sequential steps
const supportRoute = agent.createRoute({
  title: "Customer Support",
  description: "Handle customer support requests with session persistence",
  // NEW: Required fields for route completion
  requiredFields: ["issue"],
  // NEW: Optional fields that enhance the experience
  optionalFields: ["category", "priority", "status", "ticketId", "assignedAgent"],
  // Sequential steps for support ticket creation
  steps: [
    {
      id: "ask_issue",
      description: "Ask for the issue description",
      prompt:
        "Hi! I'm here to help with your support request. What's the issue you're experiencing?",
      collect: ["issue"],
      skipIf: (ctx) => !!ctx.data?.issue,
    },
    {
      id: "ask_category",
      description: "Ask for issue category",
      prompt:
        "What category does this issue fall under? (technical, billing, account, or general)",
      collect: ["category"],
      requires: ["issue"],
      skipIf: (ctx) => !!ctx.data?.category,
    },
    {
      id: "ask_priority",
      description: "Ask for priority level",
      prompt:
        "How would you rate the priority of this issue? (low, medium, or high)",
      collect: ["priority"],
      requires: ["issue", "category"],
      skipIf: (ctx) => !!ctx.data?.priority,
    },
    {
      id: "create_ticket",
      description: "Create the support ticket",
      prompt: "I'll create a support ticket for you now.",
      tools: [createTicket],
      requires: ["issue", "category"],
    },
  ],
});

// Demonstrate session management
async function demonstrateSessionBasics() {
  console.log("=== Memory Session Basics Demo ===\n");

  // Create agent with specific sessionId
  const sessionId = "session-user-123";
  const sessionAgent = new Agent<SupportContext, SupportTicketData>({
    name: "Support Assistant",
    description: "Help users with technical issues",
    provider: new GeminiProvider({
      apiKey: process.env.GEMINI_API_KEY!,
      model: "models/gemini-2.5-flash",
    }),
    context: {
      userId: "user_123",
      userName: "Alice",
      userTier: "premium",
    },
    // NEW: Agent-level schema
    schema: supportTicketSchema,
    persistence: {
      adapter: new MemoryAdapter(),
      autoSave: true,
    },
    sessionId, // Agent will create or load this session
  });

  // Create the same route on the new agent
  sessionAgent.createRoute({
    title: "Customer Support",
    description: "Handle customer support requests with session persistence",
    // NEW: Required fields for route completion
    requiredFields: ["issue"],
    // NEW: Optional fields that enhance the experience
    optionalFields: ["category", "priority", "status", "ticketId", "assignedAgent"],
  });

  console.log("Session ready:", sessionAgent.session.id);

  // Use the session in conversation
  console.log("\nUser: I can't access my account");

  await sessionAgent.session.addMessage("user", "I can't access my account", "Alice");

  const response1 = await sessionAgent.respond({
    history: sessionAgent.session.getHistory(),
  });

  console.log("Bot:", response1.message);
  console.log(
    "Session data:",
    JSON.stringify(sessionAgent.session.getData(), null, 2)
  );

  await sessionAgent.session.addMessage("assistant", response1.message);

  // Continue the conversation with the returned session
  console.log("\nUser: It's a technical issue, high priority");
  const response2 = await agent.respond({
    history: [
      {
        role: "user" as const,
        content: "I can't access my account",
        name: "Alice",
      },
      {
        role: "assistant" as const,
        content: response1.message,
      },
      {
        role: "user" as const,
        content: "It's a technical issue, high priority",
        name: "Alice",
      },
    ],
    session: response1.session,
  });

  console.log("Bot:", response2.message);
  console.log(
    "Updated session data:",
    JSON.stringify(response2.session?.data, null, 2)
  );
  console.log("Session complete:", response2.isRouteComplete);
}

// Demonstrate session persistence and restoration
async function demonstrateSessionPersistence() {
  console.log("\n=== Session Persistence Demo ===\n");

  // Start a conversation
  const userId = "user_alice";
  console.log(`Starting conversation for user: ${userId}`);

  const response1 = await agent.respond({
    history: [
      {
        role: "user" as const,
        content: "I have a billing question",
        name: "Alice",
      },
    ],
  });

  console.log("First response - Session ID:", response1.session?.id);
  console.log(
    "Data collected:",
    JSON.stringify(response1.session?.data, null, 2)
  );

  // Simulate persistence (in real usage, this happens automatically)
  if (agent.hasPersistence() && response1.session?.id) {
    console.log("💾 Session auto-saved to memory");

    // Manually trigger save (normally automatic)
    await agent
      .getPersistenceManager()
      ?.saveSessionState(response1.session.id, response1.session);
  }

  // Continue conversation
  const response2 = await agent.respond({
    history: [
      {
        role: "user" as const,
        content: "I have a billing question",
        name: "Alice",
      },
      {
        role: "assistant" as const,
        content: response1.message,
      },
      {
        role: "user" as const,
        content: "My account is ACC-456",
        name: "Alice",
      },
    ],
    session: response1.session,
  });

  console.log("\nContinued conversation:");
  console.log(
    "Data collected:",
    JSON.stringify(response2.session?.data, null, 2)
  );

  // Demonstrate session restoration
  console.log("\n🔄 Simulating session restoration (e.g., user returns later)");
  if (response2.session?.id) {
    const restoredSession = await agent
      .getPersistenceManager()
      ?.loadSessionState(response2.session.id);

    console.log(
      "Restored session data:",
      JSON.stringify(restoredSession?.data, null, 2)
    );
    console.log("Session metadata preserved:", !!restoredSession?.metadata);
  }
}

// Demonstrate multi-user session management
async function demonstrateMultiUserSessions() {
  console.log("\n=== Multi-User Session Management Demo ===\n");

  // Simulate multiple users having concurrent conversations
  const users = [
    { id: "user_001", name: "Alice", issue: "Login problems" },
    { id: "user_002", name: "Bob", issue: "Billing dispute" },
    { id: "user_003", name: "Charlie", issue: "Account settings" },
  ];

  console.log("Managing concurrent sessions for multiple users...");

  for (const user of users) {
    console.log(`\n👤 Handling ${user.name}'s session (${user.id}):`);

    const response = await agent.respond({
      history: [
        {
          role: "user" as const,
          content: user.issue,
          name: user.name,
        },
      ],
    });

    console.log(`   Session ID: ${response.session?.id}`);
    console.log(
      `   Issue recorded: ${(response.session?.data as Partial<SupportTicketData>)?.issue
      }`
    );
  }

  // Show all active sessions
  console.log("\n📊 Active Sessions Summary:");
  try {
    const manager = agent.getPersistenceManager();
    if (manager) {
      for (const user of users) {
        const sessions = await manager.getUserSessions(user.id);
        console.log(`   ${user.name}: ${sessions.length} active session(s)`);
      }
    }
  } catch (error) {
    console.error("Error:", error);
    console.log(
      "   Could not retrieve session summary (normal for memory adapter)"
    );
  }
}

// Demonstrate session lifecycle
async function demonstrateSessionLifecycle() {
  console.log("\n=== Session Lifecycle Demo ===\n");

  // 1. Create agent with session
  console.log("1. 🆕 Creating new session");
  const sessionId = `lifecycle-demo-${Date.now()}`;

  const lifecycleAgent = new Agent<SupportContext, SupportTicketData>({
    name: "Support Assistant",
    provider: new GeminiProvider({
      apiKey: process.env.GEMINI_API_KEY!,
      model: "models/gemini-2.5-flash",
    }),
    context: {
      userId: "demo_user",
      userName: "Demo",
      userTier: "standard",
    },
    // NEW: Agent-level schema
    schema: supportTicketSchema,
    persistence: {
      adapter: new MemoryAdapter(),
      autoSave: true,
    },
    sessionId,
  });

  // Create the same route on the lifecycle agent
  lifecycleAgent.createRoute({
    title: "Customer Support",
    description: "Handle customer support requests with session persistence",
    // NEW: Required fields for route completion
    requiredFields: ["issue"],
    // NEW: Optional fields that enhance the experience
    optionalFields: ["category", "priority", "status", "ticketId", "assignedAgent"],
  });

  console.log(`   Created session: ${lifecycleAgent.session.id}`);

  // 2. Use session in conversation
  console.log("\n2. 💬 Using session in conversation");

  await lifecycleAgent.session.addMessage("user", "I need help with something", "Demo");

  const response1 = await lifecycleAgent.respond({
    history: lifecycleAgent.session.getHistory(),
  });

  console.log(`   Session data: ${JSON.stringify(lifecycleAgent.session.getData())}`);

  await lifecycleAgent.session.addMessage("assistant", response1.message);

  // 3. Complete the session
  console.log("\n3. ✅ Completing session");
  const response2 = await agent.respond({
    history: [
      {
        role: "user" as const,
        content: "I need help with something",
        name: "Demo",
      },
      {
        role: "assistant" as const,
        content: response1.message,
      },
      {
        role: "user" as const,
        content: "It's a general inquiry",
        name: "Demo",
      },
    ],
    session: response1.session,
  });

  console.log(`   Session completed: ${response2.isRouteComplete}`);
  console.log(`   Final data: ${JSON.stringify(response2.session?.data)}`);

  // 4. Clean up (optional - memory adapter doesn't need this)
  console.log("\n4. 🗑️  Session lifecycle complete");
  console.log("   (Memory sessions are automatically managed)");
}

// Show memory adapter characteristics
function demonstrateMemoryAdapter() {
  console.log("\n=== Memory Adapter Characteristics ===\n");

  console.log("MemoryAdapter features:");
  console.log("✅ Fast - No disk I/O or network calls");
  console.log("✅ Simple - No external dependencies");
  console.log("✅ Ephemeral - Data lost on process restart");
  console.log("✅ Concurrent - Supports multiple users");
  console.log("✅ Automatic - No manual session management needed");

  console.log("\nUse cases:");
  console.log("• Development and testing");
  console.log("• Short-lived conversations");
  console.log("• Prototyping new features");
  console.log("• CI/CD environments");
  console.log("• Applications where persistence isn't critical");

  console.log("\nWhen to use external persistence:");
  console.log("• Production applications");
  console.log("• Long-running conversations");
  console.log("• Multi-server deployments");
  console.log("• Data recovery requirements");
  console.log("• Analytics and reporting needs");

  console.log("\nCode example:");
  console.log(
    `
import { Agent, MemoryAdapter } from "@falai/agent";

const agent = new Agent({
  // ... other config
  persistence: {
    adapter: new MemoryAdapter(),
    // autoSave: true (default)
  },
});
  `.trim()
  );
}

// Run demonstrations
async function main() {
  try {
    demonstrateMemoryAdapter();
    await demonstrateSessionBasics();
    await demonstrateSessionPersistence();
    await demonstrateMultiUserSessions();
    await demonstrateSessionLifecycle();
  } catch (error) {
    console.error("Error:", error);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}
