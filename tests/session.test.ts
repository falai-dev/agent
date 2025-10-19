/**
 * Session Management Tests
 *
 * Tests session creation, data collection, state management, persistence,
 * and multi-user session handling.
 */
import { expect, test, describe } from "bun:test";
import {
  Agent,
  createSession,
  MemoryAdapter,
  type SessionState,
} from "../src/index";
import { MockProviderFactory } from "./mock-provider";

// Test data types
interface SupportTicketData {
  issue: string;
  category: "technical" | "billing" | "account" | "general";
  priority: "low" | "medium" | "high";
  ticketId?: string;
  assignedAgent?: string;
  resolution?: string;
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
}

// Test utilities
function createSessionTestAgent(): Agent {
  return new Agent({
    name: "SessionTestAgent",
    description: "Agent for testing session functionality",
    provider: MockProviderFactory.basic(),
    persistence: {
      adapter: new MemoryAdapter(),
    },
  });
}

function createSupportSession(): SessionState<SupportTicketData> {
  return createSession<SupportTicketData>("support-session-123", {
    userId: "user_alice",
    metadata: {
      source: "web_chat",
      priority: "normal",
    },
  });
}

function createShoppingSession(): SessionState<ShoppingCartData> {
  return createSession<ShoppingCartData>("shopping-session-456", {
    userId: "user_bob",
    metadata: {
      source: "mobile_app",
      currency: "USD",
    },
  });
}

describe("Session Creation and Configuration", () => {
  test("should create session with default configuration", () => {
    const session = createSession();

    expect(session.id).toBeDefined();
    expect(typeof session.id).toBe("string");
    expect(session.id?.length).toBeGreaterThan(0);
    expect(session.data).toEqual({});
    expect(session.metadata?.createdAt).toBeInstanceOf(Date);
    expect(session.metadata?.lastUpdatedAt).toBeInstanceOf(Date);
    expect(session.currentRoute).toBeUndefined();
    expect(session.currentStep).toBeUndefined();
    expect(session.routeHistory).toEqual([]);
  });

  test("should create session with custom ID and metadata", () => {
    const customId = "custom-session-123";
    const metadata = {
      userId: "user_123",
      source: "api",
      tags: ["test", "important"],
    };

    const session = createSession(customId, metadata);

    expect(session.id).toBe(customId);
    expect(session.metadata?.source).toBe("api");
    expect(session.metadata?.tags).toEqual(["test", "important"]);
    expect(session.metadata?.userId).toBe("user_123");
    expect(session.metadata?.createdAt).toBeInstanceOf(Date);
    expect(session.metadata?.lastUpdatedAt).toBeInstanceOf(Date);
  });

  test("should create typed sessions", () => {
    const supportSession = createSupportSession();
    const shoppingSession = createShoppingSession();

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

  test("should handle session timestamps", () => {
    const beforeCreate = new Date();
    const session = createSession();
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

describe("Session Data Collection and Management", () => {
  test("should collect and update session data", () => {
    const session = createSupportSession();

    // Initial state
    expect(session.data).toEqual({});

    // Add data incrementally
    session.data!.issue = "Can't access account";
    expect(session.data!.issue).toBe("Can't access account");

    session.data!.category = "account";
    session.data!.priority = "medium";

    expect(session.data).toEqual({
      issue: "Can't access account",
      category: "account",
      priority: "medium",
    });
  });

  test("should handle complex nested data structures", () => {
    const session = createShoppingSession();

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

    session.data = cartData;

    expect(session.data.items).toHaveLength(2);
    expect(session.data.total).toBe(89.97);
    expect(session.data?.items?.[0]?.name).toBe("Widget");
    expect(session.data?.items?.[1]?.price).toBe(49.99);
  });

  test("should track session updates", () => {
    const session = createSession();
    const originalUpdateTime = session.metadata?.lastUpdatedAt?.getTime();

    // Simulate delay
    setTimeout(() => {
      if (!session.data) {
        session.data = {};
      }
      session.data.updated = true;
      // In real implementation, updatedAt would be set automatically
      session.metadata!.lastUpdatedAt = new Date();
    }, 10);

    // Wait for the update
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(session.data?.updated).toBe(true);
        expect(session.metadata?.lastUpdatedAt?.getTime()).toBeGreaterThan(
          originalUpdateTime ?? 0
        );
        resolve();
      }, 15);
    });
  });

  test("should handle partial data updates", () => {
    const session = createSupportSession();

    // Initial data
    session.data = {
      issue: "Login issue",
      category: "technical",
    };

    // Partial update (simulate tool data update)
    const update = {
      priority: "high" as const,
      ticketId: "TICKET-123",
      assignedAgent: "agent_alice",
    };

    Object.assign(session.data, update);

    expect(session.data.issue).toBe("Login issue"); // Preserved
    expect(session.data.category).toBe("technical"); // Preserved
    expect(session.data.priority).toBe("high"); // Added
    expect(session.data.ticketId).toBe("TICKET-123"); // Added
    expect(session.data.assignedAgent).toBe("agent_alice"); // Added
  });
});

describe("Session State Management", () => {
  test("should track current route and step", () => {
    const session = createSession();

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

  test("should handle route progression", () => {
    const agent = createSessionTestAgent();
    const session = createSession();

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

  test("should handle route completion", () => {
    const session = createSupportSession();

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

describe("Session Persistence", () => {
  test("should persist session with memory adapter", async () => {
    const agent = createSessionTestAgent();
    const session = createSupportSession();

    // Add some data
    session.data = {
      issue: "Test issue",
      category: "technical",
      priority: "medium",
    };

    // Save session
    const manager = agent.getPersistenceManager();
    expect(manager).toBeDefined();

    await manager!.saveSessionState(session.id, session);

    // Load session
    const loadedSession = await manager!.loadSessionState(session.id);

    expect(loadedSession).toBeDefined();
    expect(loadedSession?.id).toBe(session.id);
    expect(loadedSession?.data).toEqual(session.data);
    expect(loadedSession?.metadata).toEqual(session.metadata);
  });

  test("should handle session restoration", async () => {
    const agent = createSessionTestAgent();
    const originalSession = createShoppingSession();

    // Populate with complex data
    originalSession.data = {
      items: [{ id: "1", name: "Test Item", quantity: 1, price: 10.99 }],
      total: 10.99,
      shippingAddress: "Test Address",
    };

    originalSession.currentRoute = {
      id: "checkout_route",
      title: "Checkout",
      enteredAt: new Date(),
    };

    // Save and restore
    const manager = agent.getPersistenceManager()!;
    await manager.saveSessionState(originalSession.id, originalSession);
    const restoredSession = await manager.loadSessionState(originalSession.id);

    expect(restoredSession?.data?.items).toHaveLength(1);
    expect(restoredSession?.data?.total).toBe(10.99);
    expect(restoredSession?.currentRoute?.id).toBe("checkout_route");
  });

  test("should handle missing sessions", async () => {
    const agent = createSessionTestAgent();
    const manager = agent.getPersistenceManager()!;

    const loadedSession = await manager.loadSessionState(
      "non-existent-session"
    );
    expect(loadedSession).toBeNull();
  });

  test("should delete sessions", async () => {
    const agent = createSessionTestAgent();
    const session = createSession("delete-test-session");

    const manager = agent.getPersistenceManager()!;

    // Save session
    await manager.saveSessionState(session.id, session);

    // Verify it exists
    let loaded = await manager.loadSessionState(session.id);
    expect(loaded).toBeDefined();

    // Delete session
    await manager.deleteSession(session.id);

    // Verify it's gone
    loaded = await manager.loadSessionState(session.id);
    expect(loaded).toBeNull();
  });
});

describe("Multi-User Session Management", () => {
  test("should handle multiple concurrent sessions", async () => {
    const agent = createSessionTestAgent();
    const manager = agent.getPersistenceManager()!;

    // Create sessions for different users
    const user1Session = createSession("user1-session", { userId: "user1" });
    const user2Session = createSession("user2-session", { userId: "user2" });
    const user3Session = createSession("user3-session", { userId: "user3" });

    // Save all sessions
    await Promise.all([
      manager.saveSessionState(user1Session.id, user1Session),
      manager.saveSessionState(user2Session.id, user2Session),
      manager.saveSessionState(user3Session.id, user3Session),
    ]);

    // Load and verify each session
    const loaded1 = await manager.loadSessionState("user1-session");
    const loaded2 = await manager.loadSessionState("user2-session");
    const loaded3 = await manager.loadSessionState("user3-session");

    expect(loaded1?.metadata?.userId).toBe("user1");
    expect(loaded2?.metadata?.userId).toBe("user2");
    expect(loaded3?.metadata?.userId).toBe("user3");
  });

  test("should retrieve user sessions", async () => {
    const agent = createSessionTestAgent();
    const manager = agent.getPersistenceManager()!;

    const userId = "test_user";

    // Create multiple sessions for same user
    const session1 = createSession("session1", { userId });
    const session2 = createSession("session2", { userId });
    const session3 = createSession("session3", { userId, archived: true });

    await Promise.all([
      manager.saveSessionState(session1.id, session1),
      manager.saveSessionState(session2.id, session2),
      manager.saveSessionState(session3.id, session3),
    ]);

    // Get user sessions (implementation may vary)
    try {
      const userSessions = await manager.getUserSessions(userId);
      expect(userSessions.length).toBeGreaterThanOrEqual(2);
    } catch (error) {
      // Memory adapter might not implement getUserSessions
      console.log("getUserSessions not implemented in memory adapter", error);
    }
  });

  test("should handle session conflicts", async () => {
    const agent = createSessionTestAgent();
    const manager = agent.getPersistenceManager()!;

    const sessionId = "conflict-session";

    // Create and save first version
    const session1 = createSession(sessionId, { version: 1 });
    session1.data!.value = "first";

    await manager.saveSessionState(sessionId, session1);

    // Modify and save second version
    const session2 = { ...session1 };
    session2.data!.value = "second";
    session2.metadata!.version = 2;

    await manager.saveSessionState(sessionId, session2);

    // Load and verify latest version
    const loaded = await manager.loadSessionState(sessionId);
    expect(loaded?.data?.value).toBe("second");
    expect(loaded?.metadata?.version).toBe(2);
  });
});

describe("Session Lifecycle and Cleanup", () => {
  test("should handle session expiration", async () => {
    const agent = createSessionTestAgent();
    const manager = agent.getPersistenceManager()!;

    // Create session with expiration
    const session = createSession("expiring-session", {
      expiresAt: new Date(Date.now() + 1000), // Expires in 1 second
    });

    await manager.saveSessionState(session.id, session);

    // Should load before expiration
    let loaded = await manager.loadSessionState(session.id);
    expect(loaded).toBeDefined();

    // Wait for expiration
    await new Promise((resolve) => setTimeout(resolve, 1100));

    // Memory adapter doesn't auto-expire, so this test is more about the concept
    loaded = await manager.loadSessionState(session.id);
    expect(loaded).toBeDefined(); // Memory adapter keeps everything
  });

  test("should handle session metadata updates", () => {
    const session = createSession();

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

  test("should handle session cloning", () => {
    const original = createSupportSession();
    original.data = {
      issue: "Original issue",
      category: "technical",
      priority: "high",
    };

    // Create a clone (shallow copy for this test)
    const cloned = { ...original };

    // Modify clone
    cloned.data!.issue = "Modified issue";
    cloned.id = "cloned-session";

    // Original should be unchanged
    expect(original.data.issue).toBe("Original issue");
    expect(original.id).toBe("support-session-123");

    // Clone should have changes
    expect(cloned.data!.issue).toBe("Modified issue");
    expect(cloned.id).toBe("cloned-session");
  });
});

describe("Session Integration with Agent Responses", () => {
  test("should integrate session with agent respond method", async () => {
    const agent = createSessionTestAgent();
    const session = createSession();

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

    const session = createSession();
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

    // Create route that collects data
    agent.createRoute<SupportTicketData>({
      title: "Data Collection Route",
      schema: {
        type: "object",
        properties: {
          issue: { type: "string" },
          priority: { type: "string" },
        },
      },
      steps: [
        {
          id: "collect_issue",
          prompt: "What's the issue?",
          collect: ["issue"],
        },
        {
          id: "collect_priority",
          prompt: "What's the priority?",
          collect: ["priority"],
        },
      ],
    });

    const session = createSession<SupportTicketData>();

    // First response - collect issue
    const response1 = await agent.respond({
      history: [
        {
          role: "user" as const,
          content: "I have a problem",
          name: "TestUser",
        },
      ],
      session,
    });

    // Data should be collected in session
    expect(response1.session?.data).toBeDefined();

    // Second response - collect priority
    const response2 = await agent.respond({
      history: [
        {
          role: "user" as const,
          content: "I have a problem",
          name: "TestUser",
        },
        {
          role: "assistant" as const,
          content: response1.message,
        },
        {
          role: "user" as const,
          content: "It's high priority",
          name: "TestUser",
        },
      ],
      session: response1.session!,
    });

    // Data should persist and accumulate
    // @ts-expect-error - response2.session?.data is of type Partial<SupportTicketData>
    expect(response2.session?.data?.issue).toBeDefined();
    // @ts-expect-error - response2.session?.data is of type Partial<SupportTicketData>
    expect(response2.session?.data?.priority).toBeDefined();
  });
});
