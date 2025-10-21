/**
 * Session Management Tests
 *
 * Tests session creation, data collection, state management, persistence,
 * and multi-user session handling with the new SessionManager.
 */
import { expect, test, describe } from "bun:test";
import {
  Agent,
  MemoryAdapter,
  SessionManager,
  PersistenceManager,
  type SessionState,
} from "../src/index";
import { cloneDeep } from "../src/utils/clone";
import { MockProviderFactory } from "./mock-provider";

// Test data types for agent-level data collection
interface SupportTicketData {
  issue: string;
  category: "technical" | "billing" | "account" | "general";
  priority: "low" | "medium" | "high";
  ticketId?: string;
  assignedAgent?: string;
  resolution?: string;
  updated?: boolean;
  customerName?: string;
  email?: string;
}

interface UserInfoData {
  userInfo: {
    name?: string;
    email?: string;
  }
  progress?: {
    step?: number;
    completed?: boolean;
  };
}

interface ShoppingCartData {
  items: Array<{
    id: string;
    name: string;
    quantity: number;
    price: number;
  }>;
  total: number;
  shippingAddress?: string;
  paymentMethod?: string;
  orderId?: string;
  customerName?: string;
  email?: string;
}

// Test utilities
function createSessionTestAgent(): Agent<unknown, SupportTicketData> {
  return new Agent<unknown, SupportTicketData>({
    name: "SessionTestAgent",
    description: "Agent for testing session functionality",
    provider: MockProviderFactory.basic(),
    persistence: {
      adapter: new MemoryAdapter(),
    },
    schema: {
      type: "object",
      properties: {
        issue: { type: "string" },
        category: { type: "string", enum: ["technical", "billing", "account", "general"] },
        priority: { type: "string", enum: ["low", "medium", "high"] },
        ticketId: { type: "string" },
        assignedAgent: { type: "string" },
        resolution: { type: "string" },
        updated: { type: "boolean" },
        customerName: { type: "string" },
        email: { type: "string", format: "email" },
      },
      required: ["issue", "category"],
    },
  });
}

async function createSupportSession(sessionManager: SessionManager<SupportTicketData>): Promise<SessionState<SupportTicketData>> {
  const session = await sessionManager.getOrCreate("support-session-123");
  session.metadata = {
    ...session.metadata,
    userId: "user_alice",
    source: "web_chat",
    priority: "normal",
  };
  return session as SessionState<SupportTicketData>;
}

async function createShoppingSession(sessionManager: SessionManager<ShoppingCartData>): Promise<SessionState<ShoppingCartData>> {
  const session = await sessionManager.getOrCreate("shopping-session-456");
  session.metadata = {
    ...session.metadata,
    userId: "user_bob",
    source: "mobile_app",
    currency: "USD",
  };
  return session as SessionState<ShoppingCartData>;
}

describe("SessionManager Creation and Configuration", () => {
  test("should create session with default configuration", async () => {
    const sessionManager = new SessionManager<SupportTicketData>();
    const session = await sessionManager.getOrCreate();

    expect(session.id).toBeDefined();
    expect(typeof session.id).toBe("string");
    expect(session.id?.length).toBeGreaterThan(0);
    expect(session.data).toEqual({});
    expect(session.metadata?.createdAt).toBeInstanceOf(Date);
    expect(session.metadata?.lastUpdatedAt).toBeInstanceOf(Date);
    expect(session.currentRoute).toBeUndefined();
    expect(session.currentStep).toBeUndefined();
    expect(session.routeHistory).toEqual([]);
    expect(session.history).toEqual([]);
  });

  test("should create session with custom ID", async () => {
    const sessionManager = new SessionManager<SupportTicketData>();
    const customId = "custom-session-123";
    const session = await sessionManager.getOrCreate(customId);

    expect(session.id).toBe(customId);
    expect(session.metadata?.createdAt).toBeInstanceOf(Date);
    expect(session.metadata?.lastUpdatedAt).toBeInstanceOf(Date);
    expect(session.history).toEqual([]);
  });

  test("should create typed sessions", async () => {
    const sessionManager = new SessionManager<SupportTicketData>();
    const supportSession = await createSupportSession(sessionManager);

    const sessionManager2 = new SessionManager<ShoppingCartData>();
    const shoppingSession = await createShoppingSession(sessionManager2);

    expect(supportSession.data).toEqual({});
    expect(shoppingSession.data).toEqual({});

    // TypeScript should enforce the data types
    const supportData: SupportTicketData = {
      issue: "Login problem",
      category: "technical",
      priority: "high",
    };

    const shoppingData: ShoppingCartData = {
      items: [],
      total: 0,
    };

    supportSession.data = supportData;
    shoppingSession.data = shoppingData;

    expect(supportSession.data.issue).toBe("Login problem");
    expect(shoppingSession.data.items).toEqual([]);
  });

  test("should handle session timestamps", async () => {
    const beforeCreate = new Date();
    const sessionManager = new SessionManager<SupportTicketData>();
    const session = await sessionManager.getOrCreate();
    const afterCreate = new Date();

    expect(session.metadata?.createdAt?.getTime()).toBeGreaterThanOrEqual(
      beforeCreate.getTime()
    );
    expect(session.metadata?.createdAt?.getTime()).toBeLessThanOrEqual(
      afterCreate.getTime()
    );
    expect(session.metadata?.lastUpdatedAt?.getTime()).toBe(
      session.metadata?.createdAt?.getTime()
    );
  });
});

describe("SessionManager Data Collection and Management", () => {
  test("should collect and update session data", async () => {
    const sessionManager = new SessionManager<SupportTicketData>();
    const session = await createSupportSession(sessionManager);

    // Initial state
    expect(session.data).toEqual({});

    // Add data incrementally using SessionManager
    await sessionManager.setData({ issue: "Can't access account" });
    expect(sessionManager.getData()?.issue).toBe("Can't access account");

    await sessionManager.setData({ category: "account", priority: "medium" });

    const data = sessionManager.getData();
    expect(data).toEqual({
      issue: "Can't access account",
      category: "account",
      priority: "medium",
    });
  });

  test("should handle complex nested data structures", async () => {
    const sessionManager = new SessionManager<ShoppingCartData>();
    const session = await createShoppingSession(sessionManager);

    const cartData: ShoppingCartData = {
      items: [
        {
          id: "item_1",
          name: "Widget",
          quantity: 2,
          price: 19.99,
        },
        {
          id: "item_2",
          name: "Gadget",
          quantity: 1,
          price: 49.99,
        },
      ],
      total: 89.97,
      shippingAddress: "123 Main St, Anytown, USA",
      paymentMethod: "credit_card",
    };

    await sessionManager.setData(cartData);
    const data = sessionManager.getData();

    expect(data?.items).toHaveLength(2);
    expect(data?.total).toBe(89.97);
    expect(data?.items?.[0]?.name).toBe("Widget");
    expect(data?.items?.[1]?.price).toBe(49.99);
  });

  test("should track session updates", async () => {
    const sessionManager = new SessionManager<SupportTicketData>();
    const session = await sessionManager.getOrCreate();
    const originalUpdateTime = session.metadata?.lastUpdatedAt?.getTime();

    // Simulate delay and update
    await new Promise(resolve => setTimeout(resolve, 10));
    await sessionManager.setData({ updated: true });

    const updatedSession = sessionManager.current;
    expect(sessionManager.getData()?.updated).toBe(true);
    expect(updatedSession?.metadata?.lastUpdatedAt?.getTime()).toBeGreaterThan(
      originalUpdateTime ?? 0
    );
  });

  test("should handle partial data updates", async () => {
    const sessionManager = new SessionManager<SupportTicketData>();
    const session = await createSupportSession(sessionManager);

    // Initial data
    await sessionManager.setData({
      issue: "Login issue",
      category: "technical",
    });

    // Partial update (simulate tool data update)
    await sessionManager.setData({
      priority: "high" as const,
      ticketId: "TICKET-123",
      assignedAgent: "agent_alice",
    });

    const data = sessionManager.getData();
    expect(data?.issue).toBe("Login issue"); // Preserved
    expect(data?.category).toBe("technical"); // Preserved
    expect(data?.priority).toBe("high"); // Added
    expect(data?.ticketId).toBe("TICKET-123"); // Added
    expect(data?.assignedAgent).toBe("agent_alice"); // Added
  });
});

describe("SessionManager State Management", () => {
  test("should track current route and step", async () => {
    const sessionManager = new SessionManager<SupportTicketData>();
    const session = await sessionManager.getOrCreate();

    expect(session.currentRoute).toBeUndefined();
    expect(session.currentStep).toBeUndefined();

    // Simulate route activation
    session.currentRoute = {
      id: "support_route",
      title: "Customer Support",
      enteredAt: new Date(),
    };

    session.currentStep = {
      id: "gather_info",
      description: "Gather issue information",
      enteredAt: new Date(),
    };

    expect(session.currentRoute?.id).toBe("support_route");
    expect(session.currentStep?.id).toBe("gather_info");
  });

  test("should handle route progression", async () => {
    const agent = createSessionTestAgent();
    const sessionManager = new SessionManager<SupportTicketData>();
    const session = await sessionManager.getOrCreate();

    // Create a simple route
    const route = agent.createRoute({
      title: "Simple Route",
      steps: [
        {
          id: "step1",
          prompt: "First step",
        },
        {
          id: "step2",
          prompt: "Second step",
        },
        {
          id: "step3",
          prompt: "Final step",
        },
      ],
    });

    // Simulate progression through steps
    session.currentRoute = {
      id: route.id,
      title: route.title,
      enteredAt: new Date(),
    };

    // Step 1
    session.currentStep = {
      id: "step1",
      description: "First step",
      enteredAt: new Date(),
    };
    expect(session.currentStep?.id).toBe("step1");

    // Step 2
    session.currentStep = {
      id: "step2",
      description: "Second step",
      enteredAt: new Date(),
    };
    expect(session.currentStep?.id).toBe("step2");

    // Step 3
    session.currentStep = {
      id: "step3",
      description: "Final step",
      enteredAt: new Date(),
    };
    expect(session.currentStep?.id).toBe("step3");
  });

  test("should handle route completion", async () => {
    const sessionManager = new SessionManager<SupportTicketData>();
    const session = await createSupportSession(sessionManager);

    // Start with active route
    session.currentRoute = {
      id: "support_route",
      title: "Support",
      enteredAt: new Date(),
    };
    session.currentStep = {
      id: "final_step",
      description: "Final step",
      enteredAt: new Date(),
    };

    // Complete the route
    session.currentRoute = undefined;
    session.currentStep = undefined;

    expect(session.currentRoute).toBeUndefined();
    expect(session.currentStep).toBeUndefined();
  });
});

describe("SessionManager Persistence", () => {
  test("should persist session with memory adapter", async () => {
    const adapter = new MemoryAdapter();
    const sessionManager = new SessionManager(adapter);

    // Create session with data
    const session = await sessionManager.getOrCreate("test-session-123");
    await sessionManager.setData({
      issue: "Test issue",
      category: "technical",
      priority: "medium",
    });

    // Save session
    await sessionManager.save();

    // Create new session manager and load the same session
    const newSessionManager = new SessionManager(adapter);
    const loadedSession = await newSessionManager.getOrCreate("test-session-123");

    expect(loadedSession).toBeDefined();
    expect(loadedSession.id).toBe("test-session-123");
    expect(loadedSession.data).toEqual({
      issue: "Test issue",
      category: "technical",
      priority: "medium",
    });
  });

  test("should handle session restoration with history", async () => {
    const adapter = new MemoryAdapter();
    const sessionManager = new SessionManager<ShoppingCartData>(adapter);

    // Create session with complex data and history
    const session = await sessionManager.getOrCreate("shopping-session-456");
    await sessionManager.setData({
      items: [{ id: "1", name: "Test Item", quantity: 1, price: 10.99 }],
      total: 10.99,
      shippingAddress: "Test Address",
    });

    // Add conversation history
    await sessionManager.addMessage("user", "I want to buy something");
    await sessionManager.addMessage("assistant", "I can help you with that!");

    session.currentRoute = {
      id: "checkout_route",
      title: "Checkout",
      enteredAt: new Date(),
    };

    await sessionManager.save();

    // Create new session manager and load
    const newSessionManager = new SessionManager<ShoppingCartData>(adapter);
    const restoredSession = await newSessionManager.getOrCreate("shopping-session-456");

    expect(restoredSession.data?.items).toHaveLength(1);
    expect(restoredSession.data?.total).toBe(10.99);
    expect(restoredSession.currentRoute?.id).toBe("checkout_route");
    expect(restoredSession.history).toHaveLength(2);
    expect(restoredSession.history?.[0]?.content).toBe("I want to buy something");
    expect(restoredSession.history?.[1]?.content).toBe("I can help you with that!");
  });

  test("should handle missing sessions", async () => {
    const adapter = new MemoryAdapter();
    const sessionManager = new SessionManager(adapter);

    // Try to load non-existent session - should create new one
    const session = await sessionManager.getOrCreate("non-existent-session");
    expect(session).toBeDefined();
    expect(session.id).toBe("non-existent-session");
    expect(session.data).toEqual({});
    expect(session.history).toEqual([]);
  });

  test("should delete sessions", async () => {
    const adapter = new MemoryAdapter();
    const sessionManager = new SessionManager(adapter);

    // Create and save session
    const session = await sessionManager.getOrCreate("delete-test-session");
    await sessionManager.setData({ test: "data" });
    await sessionManager.save();

    // Verify it exists by checking persistence manager
    const manager = sessionManager.getPersistenceManager();
    expect(manager).toBeDefined();
    let loaded = await manager!.loadSessionState("delete-test-session");
    expect(loaded).toBeDefined();

    // Delete session
    await sessionManager.delete();

    // Verify it's gone
    loaded = await manager!.loadSessionState("delete-test-session");
    expect(loaded).toBeNull();
  });
});

describe("Multi-User SessionManager Management", () => {
  test("should handle multiple concurrent sessions", async () => {
    const adapter = new MemoryAdapter();

    // Create session managers for different users
    const sessionManager1 = new SessionManager(adapter);
    const sessionManager2 = new SessionManager(adapter);
    const sessionManager3 = new SessionManager(adapter);

    // Create sessions with user metadata
    const session1 = await sessionManager1.getOrCreate("user1-session");
    session1.metadata = { ...session1.metadata, userId: "user1" };

    const session2 = await sessionManager2.getOrCreate("user2-session");
    session2.metadata = { ...session2.metadata, userId: "user2" };

    const session3 = await sessionManager3.getOrCreate("user3-session");
    session3.metadata = { ...session3.metadata, userId: "user3" };

    // Save all sessions
    await Promise.all([
      sessionManager1.save(),
      sessionManager2.save(),
      sessionManager3.save(),
    ]);

    // Load and verify each session with new managers
    const newManager1 = new SessionManager(adapter);
    const newManager2 = new SessionManager(adapter);
    const newManager3 = new SessionManager(adapter);

    const loaded1 = await newManager1.getOrCreate("user1-session");
    const loaded2 = await newManager2.getOrCreate("user2-session");
    const loaded3 = await newManager3.getOrCreate("user3-session");

    expect(loaded1.metadata?.userId).toBe("user1");
    expect(loaded2.metadata?.userId).toBe("user2");
    expect(loaded3.metadata?.userId).toBe("user3");
  });

  test("should handle session conflicts", async () => {
    const adapter = new MemoryAdapter();
    const sessionId = "conflict-session";

    // Create and save first version
    const sessionManager1 = new SessionManager(adapter);
    const session1 = await sessionManager1.getOrCreate(sessionId);
    await sessionManager1.setData({ value: "first", version: 1 });
    await sessionManager1.save();

    // Create second manager and modify same session
    const sessionManager2 = new SessionManager(adapter);
    const session2 = await sessionManager2.getOrCreate(sessionId);
    await sessionManager2.setData({ value: "second", version: 2 });
    await sessionManager2.save();

    // Load with new manager and verify latest version
    const sessionManager3 = new SessionManager(adapter);
    const loaded = await sessionManager3.getOrCreate(sessionId);
    const data = sessionManager3.getData();

    expect(data?.value).toBe("second");
    expect(data?.version).toBe(2);
  });

  test("should isolate session data between managers", async () => {
    const adapter = new MemoryAdapter();

    const sessionManager1 = new SessionManager(adapter);
    const sessionManager2 = new SessionManager(adapter);

    // Create different sessions
    await sessionManager1.getOrCreate("session-1");
    await sessionManager2.getOrCreate("session-2");

    // Set different data
    await sessionManager1.setData({ user: "alice", role: "admin" });
    await sessionManager2.setData({ user: "bob", role: "user" });

    // Verify isolation
    const data1 = sessionManager1.getData();
    const data2 = sessionManager2.getData();

    expect(data1?.user).toBe("alice");
    expect(data1?.role).toBe("admin");
    expect(data2?.user).toBe("bob");
    expect(data2?.role).toBe("user");

    // Verify session IDs are different
    expect(sessionManager1.id).toBe("session-1");
    expect(sessionManager2.id).toBe("session-2");
  });
});

describe("SessionManager Lifecycle and Cleanup", () => {
  test("should handle session metadata updates", async () => {
    const sessionManager = new SessionManager<SupportTicketData>();
    const session = await sessionManager.getOrCreate();

    // Initial metadata should include timestamps
    expect(session.metadata?.createdAt).toBeInstanceOf(Date);
    expect(session.metadata?.lastUpdatedAt).toBeInstanceOf(Date);

    // Update metadata
    session.metadata!.lastActivity = new Date();
    session.metadata!.interactions = 5;
    session.metadata!.tags = ["active", "priority"];

    expect(session.metadata!.lastActivity).toBeInstanceOf(Date);
    expect(session.metadata!.interactions).toBe(5);
    expect(session.metadata!.tags).toEqual(["active", "priority"]);
  });

  test("should handle session cloning", async () => {
    const sessionManager = new SessionManager<SupportTicketData>();
    const original = await createSupportSession(sessionManager);

    await sessionManager.setData({
      issue: "Original issue",
      category: "technical",
      priority: "high",
    });

    // Create a clone (deep copy to avoid shared references)
    const cloned = cloneDeep(original);

    // Modify clone
    cloned.data!.issue = "Modified issue";
    cloned.id = "cloned-session";

    // Original should be unchanged
    expect(original.data?.issue).toBe("Original issue");
    expect(original.id).toBe("support-session-123");

    // Clone should have changes
    expect(cloned.data!.issue).toBe("Modified issue");
    expect(cloned.id).toBe("cloned-session");
  });

  test("should handle session reset", async () => {
    const sessionManager = new SessionManager<SupportTicketData>();

    // Create session with data and history
    await sessionManager.getOrCreate("reset-test-session");
    await sessionManager.setData({ issue: "Test issue", priority: "high" });
    await sessionManager.addMessage("user", "Hello");
    await sessionManager.addMessage("assistant", "Hi there!");

    const originalId = sessionManager.id;
    const originalHistory = sessionManager.getHistory();

    // Reset with history preservation
    const newSession = await sessionManager.reset(true);

    // Should have new session ID but same history
    expect(newSession.id).not.toBe(originalId);
    expect(newSession.history).toEqual(originalHistory);
    expect(newSession.data).toEqual({}); // Data should be cleared

    // SessionManager should now point to new session
    expect(sessionManager.id).toBe(newSession.id);
    expect(sessionManager.getHistory()).toEqual(originalHistory);
    expect(sessionManager.getData()).toEqual({});
  });

  test("should handle session reset without history preservation", async () => {
    const sessionManager = new SessionManager<SupportTicketData>();

    // Create session with data and history
    await sessionManager.getOrCreate("reset-test-session-2");
    await sessionManager.setData({ issue: "Test issue", priority: "high" });
    await sessionManager.addMessage("user", "Hello");
    await sessionManager.addMessage("assistant", "Hi there!");

    const originalId = sessionManager.id;

    // Reset without history preservation
    const newSession = await sessionManager.reset(false);

    // Should have new session ID and empty history
    expect(newSession.id).not.toBe(originalId);
    expect(newSession.history).toEqual([]);
    expect(newSession.data).toEqual({});

    // SessionManager should now point to new session
    expect(sessionManager.id).toBe(newSession.id);
    expect(sessionManager.getHistory()).toEqual([]);
    expect(sessionManager.getData()).toEqual({});
  });
});

describe("SessionManager Integration with Agent Responses", () => {
  test("should integrate session with agent respond method", async () => {
    const agent = createSessionTestAgent();
    const session = await agent.session.getOrCreate("test-integration-session");

    const response1 = await agent.respond({
      history: [
        {
          role: "user" as const,
          content: "Hello",
          name: "TestUser",
        },
      ],
      session,
    });

    expect(response1.session).toBeDefined();
    expect(response1.session?.id).toBe(session.id);

    // Continue conversation with returned session
    const response2 = await agent.respond({
      history: [
        {
          role: "user" as const,
          content: "Hello",
          name: "TestUser",
        },
        {
          role: "assistant" as const,
          content: response1.message,
        },
        {
          role: "user" as const,
          content: "How are you?",
          name: "TestUser",
        },
      ],
      session: response1.session!,
    });

    expect(response2.session?.id).toBe(session.id);
  });

  test("should handle route completion in sessions", async () => {
    const agent = createSessionTestAgent();

    // Create a simple route
    agent.createRoute({
      title: "Quick Route",
      steps: [
        {
          id: "only_step",
          prompt: "This completes immediately",
        },
      ],
    });

    const session = await agent.session.getOrCreate("route-completion-test");
    const response = await agent.respond({
      history: [
        {
          role: "user" as const,
          content: "Start route",
          name: "TestUser",
        },
      ],
      session,
    });

    // Check if route completed
    if (response.isRouteComplete) {
      expect(response.session?.currentRoute).toBeNull();
      expect(response.session?.currentStep).toBeNull();
    }
  });

  test("should persist session data across responses", async () => {
    const agent = createSessionTestAgent();
    const session = await agent.session.getOrCreate("data-persistence-test");

    // Set initial data directly on session
    session.data = { issue: "Test issue" };

    // First response - should preserve existing data
    const response1 = await agent.respond({
      history: [
        {
          role: "user" as const,
          content: "Hello",
          name: "TestUser",
        },
      ],
      session,
    });

    // Data should persist
    expect(response1.session?.data?.issue).toBe("Test issue");

    // Add more data to the session returned from first response
    if (response1.session) {
      response1.session.data = {
        ...response1.session.data,
        priority: "high",
      };
    }

    // Second response - should preserve accumulated data
    const response2 = await agent.respond({
      history: [
        {
          role: "user" as const,
          content: "Hello again",
          name: "TestUser",
        },
        {
          role: "assistant" as const,
          content: response1.message,
        },
        {
          role: "user" as const,
          content: "Update priority",
          name: "TestUser",
        },
      ],
      session: response1.session!,
    });

    // Data should persist and accumulate across responses
    expect(response2.session?.data?.issue).toBe("Test issue");
    expect(response2.session?.data?.priority).toBe("high");
  });
});

describe("SessionManager Integration with Agent", () => {
  test("should create and manage sessions automatically with agent-level data", async () => {
    const agent = new Agent<unknown, SupportTicketData>({
      name: "SessionManagerAgent",
      provider: MockProviderFactory.basic(),
      sessionId: "test-session-manager-123",
      schema: {
        type: "object",
        properties: {
          issue: { type: "string" },
          category: { type: "string" },
          priority: { type: "string" },
        },
      },
    });

    // Session should be created automatically
    const session = await agent.session.getOrCreate();
    expect(session.id).toBe("test-session-manager-123");
    expect(session.history).toEqual([]);
  });

  test("should manage conversation history automatically", async () => {
    const agent = new Agent({
      name: "HistoryAgent",
      provider: MockProviderFactory.basic(),
    });

    // Use the new chat method
    await agent.chat("Hello!");
    await agent.chat("How are you?");

    const history = agent.session.getHistory();
    expect(history).toHaveLength(4); // 2 user + 2 assistant messages
    expect(history[0].role).toBe("user");
    expect(history[0].content).toBe("Hello!");
    expect(history[1].role).toBe("assistant");
    expect(history[2].role).toBe("user");
    expect(history[2].content).toBe("How are you?");
    expect(history[3].role).toBe("assistant");
  });

  test("should persist session with history and agent-level data", async () => {
    const adapter = new MemoryAdapter();
    const agent = new Agent<unknown, SupportTicketData>({
      name: "PersistenceAgent",
      provider: MockProviderFactory.basic(),
      sessionId: "persist-test-session",
      persistence: { adapter },
      schema: {
        type: "object",
        properties: {
          issue: { type: "string" },
          category: { type: "string" },
          customerName: { type: "string" },
        },
      },
    });

    // Add conversation and agent-level data
    await agent.chat("Test message");
    await agent.updateCollectedData({ issue: "Test issue", category: "technical" });

    // Manually save
    await agent.session.save();

    // Create new agent with same session ID to verify persistence
    const newAgent = new Agent<unknown, SupportTicketData>({
      name: "PersistenceAgent2",
      provider: MockProviderFactory.basic(),
      sessionId: "persist-test-session",
      persistence: { adapter },
      schema: {
        type: "object",
        properties: {
          issue: { type: "string" },
          category: { type: "string" },
          customerName: { type: "string" },
        },
      },
    });

    // Load the session and check history
    const restoredSession = await newAgent.session.getOrCreate("persist-test-session");
    const restoredHistory = newAgent.session.getHistory();

    // The chat method should have added both user and assistant messages
    expect(restoredHistory.length).toBeGreaterThanOrEqual(1);
    // Check if we have the user message (could be first or second depending on order)
    const userMessage = restoredHistory.find(msg => msg.role === "user");
    expect(userMessage?.content).toBe("Test message");

    // Check that agent-level data was persisted
    expect(restoredSession.data?.issue).toBe("Test issue");
    expect(restoredSession.data?.category).toBe("technical");
  });

  test("should handle session data operations with agent-level data", async () => {
    const agent = new Agent<unknown, SupportTicketData>({
      name: "DataAgent",
      provider: MockProviderFactory.basic(),
      schema: {
        type: "object",
        properties: {
          customerName: { type: "string" },
          email: { type: "string" },
          issue: { type: "string" },
        },
      },
    });

    // Set some agent-level data
    await agent.session.setData({ customerName: "John", email: "john@example.com" });

    // Get data
    const data = agent.session.getData();
    expect(data).toEqual({ customerName: "John", email: "john@example.com" });

    // Session should have the data
    const session = await agent.session.getOrCreate();
    expect(session.data).toEqual({ customerName: "John", email: "john@example.com" });

    // Agent's collected data should also be updated
    const collectedData = agent.getCollectedData();
    expect(collectedData).toEqual({ customerName: "John", email: "john@example.com" });
  });

  test("should reset session while preserving history if requested", async () => {
    const agent = new Agent<unknown, SupportTicketData>({
      name: "ResetAgent",
      provider: MockProviderFactory.basic(),
      schema: {
        type: "object",
        properties: {
          issue: { type: "string" },
          important: { type: "string" },
          category: { type: "string" },
        },
      },
    });

    // Add some conversation and data
    await agent.chat("Hello");
    await agent.session.setData({ issue: "test issue", category: "technical" });

    const originalSessionId = agent.session.id;
    const originalHistory = agent.session.getHistory();

    // Reset with history preservation
    const newSession = await agent.session.reset(true);

    // Should have new session ID but same history
    expect(newSession.id).not.toBe(originalSessionId);
    expect(newSession.history).toEqual(originalHistory);
    expect(newSession.data).toEqual({}); // Data should be cleared
  });

  test("should handle history override in chat method", async () => {
    const agent = new Agent({
      name: "OverrideAgent",
      provider: MockProviderFactory.basic(),
    });

    // Add some conversation normally
    await agent.chat("Normal message");
    expect(agent.session.getHistory()).toHaveLength(2);

    // Use history override - should not affect session history
    await agent.chat(undefined, {
      history: [
        { role: "user", content: "Override message" },
      ]
    });

    // Session history should be unchanged
    const sessionHistory = agent.session.getHistory();
    expect(sessionHistory).toHaveLength(2);
    expect(sessionHistory[0].content).toBe("Normal message");
  });

  test("should handle cross-route data sharing in sessions", async () => {
    const agent = createSessionTestAgent();

    // Create routes that share agent-level data
    const infoRoute = agent.createRoute({
      title: "Customer Info",
      requiredFields: ["customerName", "email"],
      steps: [
        {
          prompt: "What's your name?",
          collect: ["customerName"],
        },
      ],
    });

    const ticketRoute = agent.createRoute({
      title: "Support Ticket",
      requiredFields: ["issue", "category"],
      steps: [
        {
          prompt: "What's the issue?",
          collect: ["issue"],
        },
      ],
    });

    // Simulate data collection across routes
    const session = await agent.session.getOrCreate();

    // Update agent-level data that both routes can use
    await agent.updateCollectedData({
      customerName: "John Doe",
      email: "john@example.com",
      issue: "Login problem",
      category: "technical",
    });

    // Both routes should be able to evaluate completion based on shared data
    const agentData = agent.getCollectedData();
    expect(infoRoute.isComplete(agentData)).toBe(true);
    expect(ticketRoute.isComplete(agentData)).toBe(true);
  });
});

describe("SessionManager History Management", () => {
  test("should add and retrieve conversation history", async () => {
    const sessionManager = new SessionManager<SupportTicketData>();
    await sessionManager.getOrCreate();

    // Add messages
    await sessionManager.addMessage("user", "Hello there!");
    await sessionManager.addMessage("assistant", "Hi! How can I help you?");
    await sessionManager.addMessage("user", "I need help with my account", "John");

    const history = sessionManager.getHistory();
    expect(history).toHaveLength(3);
    expect(history[0]).toEqual({
      role: "user",
      content: "Hello there!",
    });
    expect(history[1]).toEqual({
      role: "assistant",
      content: "Hi! How can I help you?",
    });
    expect(history[2]).toEqual({
      role: "user",
      content: "I need help with my account",
      name: "John",
    });
  });

  test("should set and clear conversation history", async () => {
    const sessionManager = new SessionManager<SupportTicketData>();
    await sessionManager.getOrCreate();

    // Set initial history
    const initialHistory = [
      { role: "user" as const, content: "Previous message 1" },
      { role: "assistant" as const, content: "Previous response 1" },
      { role: "user" as const, content: "Previous message 2" },
    ];

    sessionManager.setHistory(initialHistory);
    expect(sessionManager.getHistory()).toEqual(initialHistory);

    // Add new message
    await sessionManager.addMessage("assistant", "New response");
    expect(sessionManager.getHistory()).toHaveLength(4);

    // Clear history
    sessionManager.clearHistory();
    expect(sessionManager.getHistory()).toEqual([]);
  });

  test("should handle sessionId-based session creation and loading", async () => {
    const adapter = new MemoryAdapter();
    const manager = new PersistenceManager({ adapter: adapter })
    // Create session with specific ID
    const sessionManager1 = new SessionManager(manager);
    const session1 = await sessionManager1.getOrCreate("user-session-abc");
    await sessionManager1.addMessage("user", "First message");
    await sessionManager1.setData({ userId: "user123", preferences: { theme: "dark" } });
    await sessionManager1.save();

    // Load same session with different manager instance
    const sessionManager2 = new SessionManager(adapter);
    const session2 = await sessionManager2.getOrCreate("user-session-abc");

    expect(session2.id).toBe("user-session-abc");
    expect(session2.history).toHaveLength(1);
    expect(session2.history?.[0]?.content).toBe("First message");
    expect(sessionManager2.getData()).toEqual({
      userId: "user123",
      preferences: { theme: "dark" }
    });
  });

  test("should handle session data persistence with history", async () => {
    const adapter = new MemoryAdapter();
    const manager = new PersistenceManager({ adapter: adapter })
    const sessionManager = new SessionManager(manager);

    // Create session with data and history
    await sessionManager.getOrCreate("persistence-test");
    await sessionManager.setData({
      userInfo: { name: "Alice", email: "alice@example.com" },
      progress: { step: 3, completed: false }
    });

    await sessionManager.addMessage("user", "I want to update my profile");
    await sessionManager.addMessage("assistant", "I can help you with that. What would you like to update?");
    await sessionManager.addMessage("user", "Change my email address");

    // Save session
    await sessionManager.save();

    // Create new manager and load session
    const newSessionManager = new SessionManager<UserInfoData>(adapter);
    const loadedSession = await newSessionManager.getOrCreate("persistence-test");

    // Verify data persistence
    const data = newSessionManager.getData();
    expect(data?.userInfo?.name).toBe("Alice");
    expect(data?.userInfo?.email).toBe("alice@example.com");
    expect(data?.progress?.step).toBe(3);
    expect(data?.progress?.completed).toBe(false);

    // Verify history persistence
    const history = newSessionManager.getHistory();
    expect(history).toHaveLength(3);
    expect(history[0].content).toBe("I want to update my profile");
    expect(history[1].content).toBe("I can help you with that. What would you like to update?");
    expect(history[2].content).toBe("Change my email address");
  });

  test("should auto-save on message addition", async () => {
    const adapter = new MemoryAdapter();
    const manager = new PersistenceManager({ adapter: adapter })
    const sessionManager = new SessionManager(manager);

    await sessionManager.getOrCreate("auto-save-test");

    // Add message (should auto-save)
    await sessionManager.addMessage("user", "Test auto-save");

    // Create new manager and verify message was persisted
    const newSessionManager = new SessionManager(adapter);
    const session = await newSessionManager.getOrCreate("auto-save-test");

    expect(session.history).toHaveLength(1);
    expect(session.history?.[0]?.content).toBe("Test auto-save");
  });
});
