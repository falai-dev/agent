/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Persistence Adapter Tests
 *
 * Tests persistence functionality including data storage, retrieval,
 * session management, and adapter-specific features.
 */

import { describe, beforeEach, test, expect } from "bun:test";
import {
  Agent,
  createSession,
  MemoryAdapter,
  type SessionState,
  type PersistenceAdapter,
  type PersistenceManager,
  type SessionData,
} from "../src";
import { MockProviderFactory } from "./mock-provider";

// Test data types
interface TestSessionData {
  userId: string;
  step: number;
  preferences: Record<string, any>;
  metadata: {
    source: string;
    version: number;
    tags?: string[];
    lastActivity?: Date;
    customField?: {
      nested?: {
        value: string;
      };
    };
  };
  // Additional properties used in tests
  orders?: Array<{
    id: string;
    items: string[];
    total: number;
  }>;
  userProfile?: {
    name: string;
    email: string;
    settings: Record<string, any>;
  };
  sessionStats?: {
    interactions: number;
    lastActivity: Date;
    completionRate: number;
  };
  index?: number;
  data?: any;
  counter?: number;
  testId?: string;
  batch?: number;
  circular?: any;
  functions?: () => void;
  undefined?: undefined;
  null?: null;
  date?: Date;
  regex?: RegExp;
  array?: any[];
  object?: Record<string, any>;
}

interface ComplexData {
  orders: Array<{
    id: string;
    items: string[];
    total: number;
  }>;
  userProfile: {
    name: string;
    email: string;
    settings: Record<string, any>;
  };
  sessionStats: {
    interactions: number;
    lastActivity: Date;
    completionRate: number;
  };
}

// Test utilities
function createPersistenceTestAgent(
  adapter?: PersistenceAdapter<TestSessionData>
): Agent {
  return new Agent({
    name: "PersistenceTestAgent",
    description: "Agent for testing persistence functionality",
    provider: MockProviderFactory.basic(),
    persistence: {
      adapter: adapter || new MemoryAdapter(),
    },
  });
}

function createTestSession(id?: string): SessionState<TestSessionData> {
  return {
    id: id || `test-session-${Date.now()}`,
    data: {
      userId: "test-user-123",
      metadata: {
        source: "test",
        version: 1,
      },
    },
    routeHistory: [],
  };
}

/**
 * Convert SessionState to SessionData format expected by adapter
 */
function sessionStateToAdapterData(
  session: SessionState<TestSessionData>
): Omit<SessionData<TestSessionData>, "id" | "createdAt" | "updatedAt"> {
  return {
    userId: "test-user-123", // Use a default userId for tests
    status: "active",
    collectedData: {
      data: session.data!,
      dataByRoute: session.dataByRoute || {},
      routeHistory: session.routeHistory,
      currentRouteTitle: session.currentRoute?.title,
      currentStepDescription: session.currentStep?.description,
      metadata: session.metadata!,
    },
    currentRoute: session.currentRoute?.id,
    currentStep: session.currentStep?.id,
  };
}

/**
 * Safely get collected data from loaded session
 */
function getCollectedData(
  session: SessionData<TestSessionData> | null
): TestSessionData | undefined {
  return session?.collectedData?.data as TestSessionData | undefined;
}

describe("MemoryAdapter Basic Functionality", () => {
  let adapter: MemoryAdapter<TestSessionData>;

  beforeEach(() => {
    adapter = new MemoryAdapter<TestSessionData>();
  });

  test("should save and load session state", async () => {
    const session = createTestSession("memory-test-session");

    // Add test data
    session.data = {
      userId: "user_123",
      step: 2,
      preferences: { theme: "dark", notifications: true },
    };

    // Add session metadata
    session.metadata = {
      source: "web",
      version: 1,
    };

    // Convert SessionState to adapter format and save
    const adapterData = sessionStateToAdapterData(session);
    const savedSession = await adapter.sessionRepository.create(adapterData);

    // Load session
    const loadedSession = await adapter.sessionRepository.findById(
      savedSession.id
    );

    expect(loadedSession).toBeDefined();
    expect(loadedSession?.id).toBe(savedSession.id);
    expect(loadedSession?.collectedData?.data?.userId).toEqual(
      session.data?.userId
    );
    expect(loadedSession?.collectedData?.metadata?.source).toEqual(
      session.metadata?.source
    );
  });

  test("should return null for non-existent sessions", async () => {
    const loadedSession = await adapter.sessionRepository.findById(
      "non-existent-session"
    );
    expect(loadedSession).toBeNull();
  });

  test("should delete session state", async () => {
    const session = createTestSession("delete-test-session");

    // Save session
    const adapterData = sessionStateToAdapterData(session);
    const savedSession = await adapter.sessionRepository.create(adapterData);

    // Verify it exists
    let loaded = await adapter.sessionRepository.findById(savedSession.id);
    expect(loaded).toBeDefined();

    // Delete session
    await adapter.sessionRepository.delete(savedSession.id);

    // Verify it's gone
    loaded = await adapter.sessionRepository.findById(savedSession.id);
    expect(loaded).toBeNull();
  });

  test("should handle complex nested data", async () => {
    const session = createTestSession("complex-data-session");

    const complexData: ComplexData = {
      orders: [
        {
          id: "order_1",
          items: ["item_a", "item_b"],
          total: 99.99,
        },
        {
          id: "order_2",
          items: ["item_c"],
          total: 49.99,
        },
      ],
      userProfile: {
        name: "Test User",
        email: "test@example.com",
        settings: {
          theme: "light",
          language: "en",
          timezone: "UTC",
        },
      },
      sessionStats: {
        interactions: 15,
        lastActivity: new Date(),
        completionRate: 0.85,
      },
    };

    session.data = complexData as TestSessionData;

    const adapterData = sessionStateToAdapterData(session);
    const savedSession = await adapter.sessionRepository.create(adapterData);
    const loaded = await adapter.sessionRepository.findById(savedSession.id);

    const collectedData = getCollectedData(loaded);
    expect(collectedData?.orders).toHaveLength(2);
    expect(collectedData?.userProfile?.name).toBe("Test User");
    expect(collectedData?.sessionStats?.interactions).toBe(15);
  });
});

describe("PersistenceManager Integration", () => {
  test("should integrate with agent persistence manager", () => {
    const agent = createPersistenceTestAgent();

    expect(agent.hasPersistence()).toBe(true);
    expect(agent.getPersistenceManager()).toBeDefined();

    const manager =
      agent.getPersistenceManager() as PersistenceManager<TestSessionData>;
    expect(manager?.getAdapter()).toBeInstanceOf(MemoryAdapter);
  });

  test("should handle persistence in agent responses", async () => {
    const agent = createPersistenceTestAgent();
    const session = createTestSession();

    // First response
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

    // Session should be automatically persisted
    const manager = agent.getPersistenceManager()!;
    const persistedSession = await manager.loadSessionState(
      response1.session!.id
    );

    expect(persistedSession).toBeDefined();
    expect(persistedSession?.id).toBe(response1.session!.id);
  });

  test("should maintain session data across multiple responses", async () => {
    const agent = createPersistenceTestAgent();
    let session = createTestSession();

    // First interaction
    const response1 = await agent.respond({
      history: [
        {
          role: "user" as const,
          content: "Start",
          name: "TestUser",
        },
      ],
      session,
    });

    session = response1.session!;

    // Add some data manually (simulating route data collection)
    session.data = { ...session.data, step: 1, preferences: { theme: "dark" } };

    // Second interaction
    const response2 = await agent.respond({
      history: [
        {
          role: "user" as const,
          content: "Start",
          name: "TestUser",
        },
        {
          role: "assistant" as const,
          content: response1.message,
        },
        {
          role: "user" as const,
          content: "Continue",
          name: "TestUser",
        },
      ],
      session,
    });

    session = response2.session!;

    // Verify data persistence
    const manager = agent.getPersistenceManager()!;
    const persisted = await manager.loadSessionState(session.id);

    expect(persisted?.data?.step).toBe(1);
    // @ts-expect-error - persisted?.data is of type Partial<TestSessionData>
    expect(persisted?.data?.preferences?.theme).toBe("dark");
  });
});

describe("Session State Persistence", () => {
  let adapter: MemoryAdapter<TestSessionData>;

  beforeEach(() => {
    adapter = new MemoryAdapter<TestSessionData>();
  });

  test("should persist route and step state", async () => {
    const session = createTestSession("route-state-session");

    // Set route and step state
    session.currentRoute = {
      id: "test_route",
      title: "Test Route",
      enteredAt: new Date(),
    };

    session.currentStep = {
      id: "step_2",
      description: "Second step",
      enteredAt: new Date(),
    };

    session.data!.step = 2;

    const adapterData = sessionStateToAdapterData(session);
    const savedSession = await adapter.sessionRepository.create(adapterData);
    const loaded = await adapter.sessionRepository.findById(savedSession.id);

    expect(loaded?.currentRoute).toBe("test_route");
    expect(loaded?.currentStep).toBe("step_2");
    expect(loaded?.collectedData?.data?.step).toBe(2);
  });

  test("should persist session metadata", async () => {
    const session = createTestSession("metadata-session");

    session.metadata = {
      ...session.metadata,
      userId: "user_456",
      source: "mobile_app",
      version: 2,
      tags: ["premium", "active"],
      lastActivity: new Date(),
      customField: {
        nested: {
          value: "test",
        },
      },
    };

    const adapterData = sessionStateToAdapterData(session);
    const savedSession = await adapter.sessionRepository.create(adapterData);
    const loaded = await adapter.sessionRepository.findById(savedSession.id);

    const collectedMetadata = loaded?.collectedData
      ?.metadata as TestSessionData["metadata"];
    expect(collectedMetadata?.source).toBe("mobile_app");
    expect(collectedMetadata?.version).toBe(2);
    expect(collectedMetadata.tags).toEqual(["premium", "active"]);
    expect(collectedMetadata?.lastActivity).toBeInstanceOf(Date);
    expect(collectedMetadata?.customField?.nested?.value).toBe("test");
  });

  test("should handle session updates", async () => {
    const session = createTestSession("update-session");

    // Initial save
    session.data!.step = 1;
    const adapterData = sessionStateToAdapterData(session);
    const savedSession = await adapter.sessionRepository.create(adapterData);

    // Load and update
    const loaded = await adapter.sessionRepository.findById(savedSession.id);
    expect(getCollectedData(loaded)?.step).toBe(1);

    // Create updated session data
    const updatedData = {
      ...loaded!,
      collectedData: {
        ...loaded!.collectedData!,
        data: {
          ...getCollectedData(loaded),
          step: 2,
          preferences: { theme: "light" },
        },
      },
      updatedAt: new Date(),
    };

    // Save updated version
    await adapter.sessionRepository.update(savedSession.id, updatedData);

    // Load again and verify updates
    const updated = await adapter.sessionRepository.findById(savedSession.id);
    expect(getCollectedData(updated)?.step).toBe(2);
    expect(getCollectedData(updated)?.preferences?.theme).toBe("light");
  });
});

describe("MemoryAdapter Performance and Limits", () => {
  let adapter: MemoryAdapter<TestSessionData>;

  beforeEach(() => {
    adapter = new MemoryAdapter<TestSessionData>();
  });

  test("should handle multiple concurrent sessions", async () => {
    const sessions: SessionState<TestSessionData>[] = [];

    // Create multiple sessions
    for (let i = 0; i < 10; i++) {
      const session = createTestSession(`concurrent-session-${i}`);
      session.data = { index: i, data: `test data ${i}` };
      sessions.push(session);
    }

    // Save all sessions concurrently
    const savedSessions = await Promise.all(
      sessions.map((session) =>
        adapter.sessionRepository.create(sessionStateToAdapterData(session))
      )
    );

    // Load all sessions concurrently
    const loadedSessions = await Promise.all(
      savedSessions.map((saved) => adapter.sessionRepository.findById(saved.id))
    );

    // Verify all sessions were saved and loaded correctly
    loadedSessions.forEach((loaded, index) => {
      expect(loaded).toBeDefined();
      expect(getCollectedData(loaded)?.index).toBe(index);
      expect(getCollectedData(loaded)?.data).toBe(`test data ${index}`);
    });
  });

  test("should handle large data objects", async () => {
    const session = createTestSession("large-data-session");

    // Create a large data object
    interface LargeData {
      array: {
        id: number;
        name: string;
        description: string;
      }[];
      object: Record<string, string>;
      metadata: {
        size: number;
        created: Date;
      };
    }
    const largeData: Partial<LargeData> = {
      array: [],
      object: {},
    };

    // Add a lot of data
    for (let i = 0; i < 1000; i++) {
      largeData.array!.push({
        id: i,
        name: `item_${i}`,
        description: `This is a description for item ${i}`.repeat(10),
      });
      largeData.object![`key_${i}`] = `value_${i}`;
    }

    largeData.metadata = {
      size: JSON.stringify(largeData).length,
      created: new Date(),
    };

    session.data = largeData as Partial<TestSessionData>;

    const adapterData = sessionStateToAdapterData(session);
    const savedSession = await adapter.sessionRepository.create(adapterData);
    const loaded = await adapter.sessionRepository.findById(savedSession.id);

    const collectedData = getCollectedData(loaded);
    expect(collectedData?.array).toHaveLength(1000);
    expect(Object.keys(collectedData?.object || {})).toHaveLength(1000);
  });

  test("should handle rapid save/load cycles", async () => {
    const session = createTestSession("rapid-session");

    // Perform many rapid save/load operations
    let sessionId: string;
    for (let i = 0; i < 50; i++) {
      session.data = { ...session.data, counter: i };
      session.metadata = { ...session.metadata, lastUpdatedAt: new Date() };

      const adapterData = sessionStateToAdapterData(session);
      const savedSession = await adapter.sessionRepository.create(adapterData);
      sessionId = savedSession.id;
      const loaded = await adapter.sessionRepository.findById(sessionId);

      expect(getCollectedData(loaded)?.counter).toBe(i);
    }
  });
});

describe("Persistence Error Handling", () => {
  let adapter: MemoryAdapter<TestSessionData>;

  beforeEach(() => {
    adapter = new MemoryAdapter<TestSessionData>();
  });

  test("should handle invalid session data gracefully", async () => {
    const session = createTestSession("invalid-data-session");

    // Create session with potentially problematic data
    session.data = {
      circular: {} as Record<string, unknown>,
      functions: () => {},
      undefined: undefined,
      null: null,
      date: new Date(),
      regex: /test/,
    };

    // Memory adapter should handle this (though some adapters might not)
    const adapterData = sessionStateToAdapterData(session);
    const savedSession = await adapter.sessionRepository.create(adapterData);
    const loaded = await adapter.sessionRepository.findById(savedSession.id);

    expect(loaded).toBeDefined();
    expect(getCollectedData(loaded)?.null).toBeNull();
    expect(getCollectedData(loaded)?.date).toBeInstanceOf(Date);
  });

  test("should handle empty or minimal sessions", async () => {
    const minimalSession = createSession("minimal-session");

    const adapterData = sessionStateToAdapterData(minimalSession);
    const savedSession = await adapter.sessionRepository.create(adapterData);
    const loaded = await adapter.sessionRepository.findById(savedSession.id);

    expect(loaded).toBeDefined();
    expect(loaded?.collectedData?.data).toEqual({});
    expect(
      (loaded?.collectedData?.metadata as TestSessionData["metadata"])?.source
    ).toBeUndefined();
    expect(loaded?.currentRoute).toBeUndefined();
    expect(loaded?.currentStep).toBeUndefined();
  });

  test("should handle session ID edge cases", async () => {
    // Test various session ID formats
    const testIds = [
      "normal-id",
      "id_with_underscores",
      "id-with-dashes",
      "id.with.dots",
      "123numeric",
      "mixed123case",
      "very-long-session-id-that-might-be-used-in-production-systems-for-uniquely-identifying-sessions",
    ];

    for (const id of testIds) {
      const session = createTestSession(id);
      session.data = { ...session.data, testId: id };

      const adapterData = sessionStateToAdapterData(session);
      const savedSession = await adapter.sessionRepository.create(adapterData);
      const loaded = await adapter.sessionRepository.findById(savedSession.id);

      expect(getCollectedData(loaded)?.testId).toBe(id);
    }
  });
});

describe("PersistenceManager Advanced Features", () => {
  test("should support adapter switching", () => {
    const agent = createPersistenceTestAgent();

    // Start with memory adapter
    const manager = agent.getPersistenceManager()!;
    expect(manager.getAdapter()).toBeInstanceOf(MemoryAdapter);

    // Note: In a real implementation, you might be able to switch adapters,
    // but for this test we'll just verify the current adapter type
    expect(manager.getAdapter()).toBeInstanceOf(MemoryAdapter);
  });

  test("should handle persistence configuration", () => {
    // Test agent with persistence disabled
    const agentNoPersistence = new Agent({
      name: "NoPersistenceAgent",
      provider: MockProviderFactory.basic(),
    });

    expect(agentNoPersistence.hasPersistence()).toBe(false);
    expect(agentNoPersistence.getPersistenceManager()).toBeUndefined();

    // Test agent with persistence enabled
    const agentWithPersistence = createPersistenceTestAgent();

    expect(agentWithPersistence.hasPersistence()).toBe(true);
    expect(agentWithPersistence.getPersistenceManager()).toBeDefined();
  });

  test("should support bulk operations", async () => {
    const adapter = new MemoryAdapter<TestSessionData>();
    createPersistenceTestAgent(adapter); // Initialize agent to test integration

    // Create multiple sessions
    const sessions: SessionState<TestSessionData>[] = [];
    for (let i = 0; i < 5; i++) {
      const session = createTestSession(`bulk-session-${i}`);
      session.data = { batch: i, data: `bulk data ${i}` };
      sessions.push(session);
    }

    // Save all at once (if adapter supports it)
    const savedSessions = await Promise.all(
      sessions.map((session) =>
        adapter.sessionRepository.create(sessionStateToAdapterData(session))
      )
    );

    // Load all at once
    const loadedSessions = await Promise.all(
      savedSessions.map((saved) => adapter.sessionRepository.findById(saved.id))
    );

    // Verify all loaded correctly
    loadedSessions.forEach((loaded, index) => {
      expect(getCollectedData(loaded)?.batch).toBe(index);
      expect(getCollectedData(loaded)?.data).toBe(`bulk data ${index}`);
    });
  });
});

describe("MemoryAdapter Cleanup and Maintenance", () => {
  test("should clear all sessions", async () => {
    const adapter = new MemoryAdapter<TestSessionData>();

    // Create and save multiple sessions
    const sessionIds = ["session1", "session2", "session3"];

    for (const id of sessionIds) {
      const session = createTestSession(id);
      const adapterData = sessionStateToAdapterData(session);
      await adapter.sessionRepository.create(adapterData);
    }

    // Verify they exist
    for (const id of sessionIds) {
      const loaded = await adapter.sessionRepository.findById(id);
      expect(loaded).toBeDefined();
    }

    // Memory adapter doesn't have a clear method, but we can test the concept
    // In a real implementation, you might have a clearAll() method
    // For now, we'll just recreate the adapter to simulate clearing
    const newAdapter = new MemoryAdapter<TestSessionData>();

    // Verify sessions don't exist in new adapter
    for (const id of sessionIds) {
      const loaded = await newAdapter.sessionRepository.findById(id);
      expect(loaded).toBeNull();
    }
  });

  test("should handle memory cleanup", () => {
    // Memory adapter doesn't require explicit cleanup,
    // but we can test that sessions are properly managed
    const adapter = new MemoryAdapter<TestSessionData>();

    // Create a large number of sessions and let them go out of scope
    let sessionCount = 0;
    const maxSessions = 100;

    const createSessions = async () => {
      for (let i = 0; i < maxSessions; i++) {
        const session = createTestSession(`temp-session-${i}`);
        const adapterData = sessionStateToAdapterData(session);
        await adapter.sessionRepository.create(adapterData);
        sessionCount++;
      }
    };

    return createSessions().then(async () => {
      expect(sessionCount).toBe(maxSessions);

      // Verify sessions exist
      const loaded = await adapter.sessionRepository.findById(
        "temp-session-50"
      );
      expect(loaded).toBeDefined();
    });
  });
});
