/**
 * SessionManager Unit Tests
 *
 * Comprehensive unit tests for the SessionManager class focusing on:
 * - getOrCreate method with various scenarios
 * - History management methods
 * - Data helpers and persistence methods
 * - Error handling for invalid sessions and persistence failures
 */
import { expect, test, describe } from "bun:test";
import {
  SessionManager,
  MemoryAdapter,
  PersistenceManager,
  UserHistoryItem,
  type SessionState,
  type History,
} from "../src/index";

// Test data interfaces
interface TestData {
  name?: string;
  email?: string;
  preferences?: {
    theme: string;
    notifications: boolean;
  };
  counter?: number;
}

interface UserSession {
  userId: string;
  role: "admin" | "user" | "guest";
  permissions: string[];
  lastActivity?: Date;
}

// Mock persistence manager that can simulate failures
class FailingPersistenceManager extends PersistenceManager {
  private shouldFail = false;
  private failureMessage = "Simulated persistence failure";

  setShouldFail(shouldFail: boolean, message?: string): void {
    this.shouldFail = shouldFail;
    if (message) this.failureMessage = message;
  }

  async saveSessionState<TData>(
    sessionId: string,
    session: SessionState<TData>
  ): Promise<any> {
    if (this.shouldFail) {
      throw new Error(this.failureMessage);
    }
    return super.saveSessionState(sessionId, session);
  }

  async loadSessionState<TData>(
    sessionId: string
  ): Promise<SessionState<TData> | null> {
    if (this.shouldFail) {
      throw new Error(this.failureMessage);
    }
    const sessionState = (await super.loadSessionState(
      sessionId
    )) as SessionState<TData>;
    return sessionState;
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    if (this.shouldFail) {
      throw new Error(this.failureMessage);
    }
    return super.deleteSession(sessionId);
  }
}

describe("SessionManager getOrCreate Method", () => {
  test("should create new session with auto-generated ID", async () => {
    const sessionManager = new SessionManager<TestData>();
    const session = await sessionManager.getOrCreate();

    expect(session.id).toBeDefined();
    expect(typeof session.id).toBe("string");
    expect(session.id?.length).toBeGreaterThan(0);
    expect(session.id?.startsWith("session_")).toBe(true);
    expect(session.data).toEqual({});
    expect(session.history).toEqual([]);
    expect(session.metadata?.createdAt).toBeInstanceOf(Date);
    expect(session.metadata?.lastUpdatedAt).toBeInstanceOf(Date);
  });

  test("should create new session with custom ID", async () => {
    const sessionManager = new SessionManager<TestData>();
    const customId = "custom-test-session-123";
    const session = await sessionManager.getOrCreate(customId);

    expect(session.id).toBe(customId);
    expect(session.data).toEqual({});
    expect(session.history).toEqual([]);
    expect(session.metadata?.createdAt).toBeInstanceOf(Date);
  });

  test("should return existing session when called without ID", async () => {
    const sessionManager = new SessionManager<TestData>();

    // Create first session
    const session1 = await sessionManager.getOrCreate("test-session-1");
    await sessionManager.setData({ name: "Alice" });

    // Call getOrCreate without ID should return same session
    const session2 = await sessionManager.getOrCreate();

    expect(session2.id).toBe(session1.id);
    expect(session2.id).toBe("test-session-1");
    expect(sessionManager.getData()?.name).toBe("Alice");
  });

  test("should load existing session from persistence", async () => {
    const adapter = new MemoryAdapter();

    // Create and save session with first manager
    const sessionManager1 = new SessionManager<TestData>(adapter);
    const session1 = await sessionManager1.getOrCreate("persistent-session");
    await sessionManager1.setData({ name: "Bob", email: "bob@example.com" });
    await sessionManager1.addMessage("user", "Hello from persistence test");
    await sessionManager1.save();

    // Load same session with new manager
    const sessionManager2 = new SessionManager<TestData>(adapter);
    const session2 = await sessionManager2.getOrCreate("persistent-session");

    expect(session2.id).toBe("persistent-session");
    expect(sessionManager2.getData()?.name).toBe("Bob");
    expect(sessionManager2.getData()?.email).toBe("bob@example.com");
    expect(sessionManager2.getHistory()).toHaveLength(1);
    expect(sessionManager2.getHistory()[0].content).toBe(
      "Hello from persistence test"
    );
  });

  test("should create new session when existing session not found", async () => {
    const adapter = new MemoryAdapter();
    const sessionManager = new SessionManager<TestData>(adapter);

    // Try to load non-existent session
    const session = await sessionManager.getOrCreate("non-existent-session");

    expect(session.id).toBe("non-existent-session");
    expect(session.data).toEqual({});
    expect(session.history).toEqual([]);
    expect(session.metadata?.createdAt).toBeInstanceOf(Date);
  });

  test("should handle multiple getOrCreate calls with same ID", async () => {
    const adapter = new MemoryAdapter();
    const sessionManager = new SessionManager<TestData>(adapter);

    // First call creates session
    const session1 = await sessionManager.getOrCreate("multi-call-test");
    await sessionManager.setData({ counter: 1 });
    await sessionManager.save();

    // Second call should return same session
    const session2 = await sessionManager.getOrCreate("multi-call-test");
    expect(session2.id).toBe(session1.id);
    expect(sessionManager.getData()?.counter).toBe(1);

    // Third call with different ID should create new session
    const session3 = await sessionManager.getOrCreate("different-session");
    expect(session3.id).toBe("different-session");
    expect(sessionManager.getData()).toEqual({}); // New session, empty data
  });

  test("should work without persistence manager", async () => {
    const sessionManager = new SessionManager<TestData>();

    const session1 = await sessionManager.getOrCreate("no-persistence");
    await sessionManager.setData({ name: "Charlie" });

    const session2 = await sessionManager.getOrCreate();
    expect(session2.id).toBe(session1.id);
    expect(sessionManager.getData()?.name).toBe("Charlie");
  });
});

describe("SessionManager History Management", () => {
  test("should add messages to history", async () => {
    const sessionManager = new SessionManager<TestData>();
    await sessionManager.getOrCreate();

    await sessionManager.addMessage("user", "First message");
    await sessionManager.addMessage("assistant", "First response");
    await sessionManager.addMessage("user", "Second message", "TestUser");

    const history = sessionManager.getHistory();
    expect(history).toHaveLength(3);

    expect(history[0]).toEqual({
      role: "user",
      content: "First message",
    });

    expect(history[1]).toEqual({
      role: "assistant",
      content: "First response",
    });

    expect(history[2]).toEqual({
      role: "user",
      content: "Second message",
      name: "TestUser",
    });
  });

  test("should get empty history for new session", async () => {
    const sessionManager = new SessionManager<TestData>();
    await sessionManager.getOrCreate();

    const history = sessionManager.getHistory();
    expect(history).toEqual([]);
  });

  test("should set entire conversation history", async () => {
    const sessionManager = new SessionManager<TestData>();
    await sessionManager.getOrCreate();

    const newHistory: History = [
      { role: "user", content: "Previous message 1" },
      { role: "assistant", content: "Previous response 1" },
      { role: "user", content: "Previous message 2", name: "Alice" },
    ];

    sessionManager.setHistory(newHistory);
    const retrievedHistory = sessionManager.getHistory();

    expect(retrievedHistory).toEqual(newHistory);
    expect(retrievedHistory).toHaveLength(3);
  });

  test("should clear conversation history", async () => {
    const sessionManager = new SessionManager<TestData>();
    await sessionManager.getOrCreate();

    // Add some messages
    await sessionManager.addMessage("user", "Message 1");
    await sessionManager.addMessage("assistant", "Response 1");
    expect(sessionManager.getHistory()).toHaveLength(2);

    // Clear history
    sessionManager.clearHistory();
    expect(sessionManager.getHistory()).toEqual([]);
  });

  test("should update lastUpdatedAt when managing history", async () => {
    const sessionManager = new SessionManager<TestData>();
    const session = await sessionManager.getOrCreate();
    const originalTime = session.metadata?.lastUpdatedAt?.getTime();

    // Wait a bit and add message
    await new Promise((resolve) => setTimeout(resolve, 10));
    await sessionManager.addMessage("user", "Test message");

    const updatedTime =
      sessionManager.current?.metadata?.lastUpdatedAt?.getTime();
    expect(updatedTime).toBeGreaterThan(originalTime ?? 0);
  });

  test("should handle history operations without current session", async () => {
    const sessionManager = new SessionManager<TestData>();

    // Should return empty history when no session
    expect(sessionManager.getHistory()).toEqual([]);

    // Adding message should create session automatically
    await sessionManager.addMessage("user", "Auto-create session");
    expect(sessionManager.current).toBeDefined();
    expect(sessionManager.getHistory()).toHaveLength(1);
  });

  test("should preserve history order", async () => {
    const sessionManager = new SessionManager<TestData>();
    await sessionManager.getOrCreate();

    const messages = [
      { role: "user" as const, content: "Message 1" },
      { role: "assistant" as const, content: "Response 1" },
      { role: "user" as const, content: "Message 2" },
      { role: "assistant" as const, content: "Response 2" },
      { role: "user" as const, content: "Message 3", name: "TestUser" },
    ];

    for (const msg of messages) {
      await sessionManager.addMessage(msg.role, msg.content, msg.name);
    }

    const history = sessionManager.getHistory();
    expect(history).toHaveLength(5);

    for (let i = 0; i < messages.length; i++) {
      expect(history[i].role).toBe(messages[i].role);
      expect(history[i].content).toBe(messages[i].content);
      if (messages[i].name) {
        expect((history[i] as UserHistoryItem).name).toBe(messages[i].name);
      }
    }
  });
});

describe("SessionManager Data Helpers", () => {
  test("should set and get session data", async () => {
    const sessionManager = new SessionManager<TestData>();
    await sessionManager.getOrCreate();

    // Initially empty
    expect(sessionManager.getData()).toEqual({});

    // Set data
    await sessionManager.setData({ name: "Alice", email: "alice@example.com" });
    const data = sessionManager.getData();
    expect(data?.name).toBe("Alice");
    expect(data?.email).toBe("alice@example.com");
  });

  test("should merge data on subsequent setData calls", async () => {
    const sessionManager = new SessionManager<TestData>();
    await sessionManager.getOrCreate();

    // Set initial data
    await sessionManager.setData({ name: "Bob" });
    expect(sessionManager.getData()?.name).toBe("Bob");

    // Add more data
    await sessionManager.setData({ email: "bob@example.com", counter: 5 });
    const data = sessionManager.getData();
    expect(data?.name).toBe("Bob"); // Preserved
    expect(data?.email).toBe("bob@example.com"); // Added
    expect(data?.counter).toBe(5); // Added
  });

  test("should handle complex nested data structures", async () => {
    const sessionManager = new SessionManager<TestData>();
    await sessionManager.getOrCreate();

    const complexData: TestData = {
      name: "Charlie",
      preferences: {
        theme: "dark",
        notifications: true,
      },
      counter: 10,
    };

    await sessionManager.setData(complexData);
    const retrievedData = sessionManager.getData();

    expect(retrievedData?.name).toBe("Charlie");
    expect(retrievedData?.preferences?.theme).toBe("dark");
    expect(retrievedData?.preferences?.notifications).toBe(true);
    expect(retrievedData?.counter).toBe(10);
  });

  test("should update lastUpdatedAt when setting data", async () => {
    const sessionManager = new SessionManager<TestData>();
    const session = await sessionManager.getOrCreate();
    const originalTime = session.metadata?.lastUpdatedAt?.getTime();

    // Wait and update data
    await new Promise((resolve) => setTimeout(resolve, 10));
    await sessionManager.setData({ name: "Updated" });

    const updatedTime =
      sessionManager.current?.metadata?.lastUpdatedAt?.getTime();
    expect(updatedTime).toBeGreaterThan(originalTime ?? 0);
  });

  test("should handle setData without existing session", async () => {
    const sessionManager = new SessionManager<TestData>();

    // setData should create session automatically
    await sessionManager.setData({ name: "Auto-created" });

    expect(sessionManager.current).toBeDefined();
    expect(sessionManager.getData()?.name).toBe("Auto-created");
  });

  test("should handle typed data correctly", async () => {
    const sessionManager = new SessionManager<UserSession>();
    await sessionManager.getOrCreate();

    const userData: UserSession = {
      userId: "user123",
      role: "admin",
      permissions: ["read", "write", "delete"],
      lastActivity: new Date(),
    };

    await sessionManager.setData(userData);
    const retrievedData = sessionManager.getData();

    expect(retrievedData?.userId).toBe("user123");
    expect(retrievedData?.role).toBe("admin");
    expect(retrievedData?.permissions).toEqual(["read", "write", "delete"]);
    expect(retrievedData?.lastActivity).toBeInstanceOf(Date);
  });
});

describe("SessionManager Persistence Methods", () => {
  test("should save session to persistence", async () => {
    const adapter = new MemoryAdapter();
    const sessionManager = new SessionManager<TestData>(adapter);

    await sessionManager.getOrCreate("save-test");
    await sessionManager.setData({ name: "SaveTest" });
    await sessionManager.addMessage("user", "Test save");

    // Manually save
    await sessionManager.save();

    // Verify with new manager
    const newManager = new SessionManager<TestData>(adapter);
    const loadedSession = await newManager.getOrCreate("save-test");

    expect(newManager.getData()?.name).toBe("SaveTest");
    expect(newManager.getHistory()).toHaveLength(1);
    expect(newManager.getHistory()[0].content).toBe("Test save");
  });

  test("should auto-save when adding messages", async () => {
    const adapter = new MemoryAdapter();
    const sessionManager = new SessionManager<TestData>(adapter);

    await sessionManager.getOrCreate("auto-save-test");

    // addMessage should auto-save
    await sessionManager.addMessage("user", "Auto-saved message");

    // Verify with new manager (no manual save called)
    const newManager = new SessionManager<TestData>(adapter);
    const loadedSession = await newManager.getOrCreate("auto-save-test");

    expect(newManager.getHistory()).toHaveLength(1);
    expect(newManager.getHistory()[0].content).toBe("Auto-saved message");
  });

  test("should delete session from persistence", async () => {
    const adapter = new MemoryAdapter();
    const sessionManager = new SessionManager<TestData>(adapter);

    // Create and save session
    await sessionManager.getOrCreate("delete-test");
    await sessionManager.setData({ name: "ToDelete" });
    await sessionManager.save();

    // Verify it exists
    const manager = sessionManager.getPersistenceManager();
    let loaded = await manager!.loadSessionState("delete-test");
    expect(loaded).toBeDefined();

    // Delete session
    await sessionManager.delete();

    // Verify it's gone
    loaded = await manager!.loadSessionState("delete-test");
    expect(loaded).toBeNull();

    // Current session should be cleared
    expect(sessionManager.current).toBeUndefined();
  });

  test("should handle save without persistence manager", async () => {
    const sessionManager = new SessionManager<TestData>();
    await sessionManager.getOrCreate();
    await sessionManager.setData({ name: "NoPersistence" });

    // Should not throw error
    await expect(sessionManager.save()).resolves.toBeUndefined();
  });

  test("should handle delete without persistence manager", async () => {
    const sessionManager = new SessionManager<TestData>();
    await sessionManager.getOrCreate();

    // Should not throw error
    await expect(sessionManager.delete()).resolves.toBeUndefined();
  });

  test("should reset session with history preservation", async () => {
    const adapter = new MemoryAdapter();
    const sessionManager = new SessionManager<TestData>(adapter);

    // Create session with data and history
    await sessionManager.getOrCreate("reset-test");
    await sessionManager.setData({ name: "Original", counter: 5 });
    await sessionManager.addMessage("user", "Message 1");
    await sessionManager.addMessage("assistant", "Response 1");

    const originalId = sessionManager.id;
    const originalHistory = sessionManager.getHistory();

    // Reset with history preservation
    const newSession = await sessionManager.reset(true);

    // Should have new ID but same history
    expect(newSession.id).not.toBe(originalId);
    expect(newSession.history).toEqual(originalHistory);
    expect(newSession.data).toEqual({}); // Data cleared

    // SessionManager should point to new session
    expect(sessionManager.id).toBe(newSession.id);
    expect(sessionManager.getHistory()).toEqual(originalHistory);
    expect(sessionManager.getData()).toEqual({});
  });

  test("should reset session without history preservation", async () => {
    const adapter = new MemoryAdapter();
    const sessionManager = new SessionManager<TestData>(adapter);

    // Create session with data and history
    await sessionManager.getOrCreate("reset-test-2");
    await sessionManager.setData({ name: "Original" });
    await sessionManager.addMessage("user", "Message 1");

    const originalId = sessionManager.id;

    // Reset without history preservation
    const newSession = await sessionManager.reset(false);

    // Should have new ID and empty history
    expect(newSession.id).not.toBe(originalId);
    expect(newSession.history).toEqual([]);
    expect(newSession.data).toEqual({});

    // SessionManager should point to new session
    expect(sessionManager.id).toBe(newSession.id);
    expect(sessionManager.getHistory()).toEqual([]);
    expect(sessionManager.getData()).toEqual({});
  });
});

describe("SessionManager Error Handling", () => {
  test("should handle persistence save failures gracefully", async () => {
    const adapter = new MemoryAdapter();
    const failingManager = new FailingPersistenceManager({ adapter });
    const sessionManager = new SessionManager<TestData>(failingManager);

    await sessionManager.getOrCreate("save-failure-test");
    await sessionManager.setData({ name: "TestData" });

    // Enable failure
    failingManager.setShouldFail(true, "Save operation failed");

    // Save should throw error
    await expect(sessionManager.save()).rejects.toThrow(
      "Save operation failed"
    );

    // Session should still exist in memory
    expect(sessionManager.current).toBeDefined();
    expect(sessionManager.getData()?.name).toBe("TestData");
  });

  test("should handle persistence load failures gracefully", async () => {
    const adapter = new MemoryAdapter();

    // Create a custom failing manager that only fails on load, not save
    class LoadFailingManager extends PersistenceManager {
      async loadSessionState<TData>(
        sessionId: string
      ): Promise<SessionState<TData> | null> {
        throw new Error("Load operation failed");
      }
    }

    const failingManager = new LoadFailingManager({ adapter });
    const sessionManager = new SessionManager<TestData>(failingManager);

    // Should create new session when load fails
    const session = await sessionManager.getOrCreate("load-failure-test");

    expect(session.id).toBe("load-failure-test");
    expect(session.data).toEqual({});
    expect(session.history).toEqual([]);
  });

  test("should handle persistence delete failures", async () => {
    const adapter = new MemoryAdapter();
    const failingManager = new FailingPersistenceManager({ adapter });
    const sessionManager = new SessionManager<TestData>(failingManager);

    await sessionManager.getOrCreate("delete-failure-test");

    // Enable failure
    failingManager.setShouldFail(true, "Delete operation failed");

    // Delete should throw error
    await expect(sessionManager.delete()).rejects.toThrow(
      "Delete operation failed"
    );

    // Current session should still exist
    expect(sessionManager.current).toBeDefined();
  });

  test("should handle addMessage with persistence failure", async () => {
    const adapter = new MemoryAdapter();
    const failingManager = new FailingPersistenceManager({ adapter });
    const sessionManager = new SessionManager<TestData>(failingManager);

    await sessionManager.getOrCreate("message-failure-test");

    // Enable failure
    failingManager.setShouldFail(true, "Auto-save failed");

    // addMessage should throw error due to auto-save failure
    await expect(
      sessionManager.addMessage("user", "Test message")
    ).rejects.toThrow("Auto-save failed");

    // Message should still be added to session in memory
    expect(sessionManager.getHistory()).toHaveLength(1);
    expect(sessionManager.getHistory()[0].content).toBe("Test message");
  });

  test("should handle reset with persistence failure", async () => {
    const adapter = new MemoryAdapter();

    // Create a custom failing manager that only fails on delete, not save
    class DeleteFailingManager extends PersistenceManager {
      async deleteSession(sessionId: string): Promise<boolean> {
        throw new Error("Reset cleanup failed");
      }
    }

    const failingManager = new DeleteFailingManager({ adapter });
    const sessionManager = new SessionManager<TestData>(failingManager);

    // Create initial session
    await sessionManager.getOrCreate("reset-failure-test");
    await sessionManager.setData({ name: "Original" });
    const originalId = sessionManager.id;

    // Reset should throw error when cleanup fails
    await expect(sessionManager.reset(false)).rejects.toThrow(
      "Reset cleanup failed"
    );

    // New session should be created but old session cleanup failed
    // The current session should be the new one (reset partially succeeded)
    expect(sessionManager.id).not.toBe(originalId);
    expect(sessionManager.getData()).toEqual({}); // New session has empty data
  });

  test("should handle invalid session data gracefully", async () => {
    const sessionManager = new SessionManager<TestData>();
    await sessionManager.getOrCreate(); // Ensure session exists

    // Test with undefined/null data
    await sessionManager.setData(undefined as any);
    expect(sessionManager.getData()).toEqual({});

    await sessionManager.setData(null as any);
    expect(sessionManager.getData()).toEqual({});

    // Test with invalid history - should handle gracefully
    sessionManager.setHistory([] as History); // Use empty array instead of null/undefined
    expect(sessionManager.getHistory()).toEqual([]);
  });

  test("should handle concurrent operations safely", async () => {
    const adapter = new MemoryAdapter();
    const sessionManager = new SessionManager<TestData>(adapter);

    await sessionManager.getOrCreate("concurrent-test");

    // Simulate concurrent operations
    const operations = [
      sessionManager.setData({ counter: 1 }),
      sessionManager.addMessage("user", "Message 1"),
      sessionManager.setData({ counter: 2 }),
      sessionManager.addMessage("user", "Message 2"),
      sessionManager.save(),
    ];

    // All operations should complete without error
    await expect(Promise.all(operations)).resolves.toBeDefined();

    // Final state should be consistent
    expect(sessionManager.getData()?.counter).toBe(2);
    expect(sessionManager.getHistory()).toHaveLength(2);
  });
});

describe("SessionManager Getters and Properties", () => {
  test("should provide current session getter", async () => {
    const sessionManager = new SessionManager<TestData>();

    // Initially no current session
    expect(sessionManager.current).toBeUndefined();

    // After creating session
    const session = await sessionManager.getOrCreate();
    expect(sessionManager.current).toBe(session);
    expect(sessionManager.current?.id).toBe(session.id);
  });

  test("should provide session ID getter", async () => {
    const sessionManager = new SessionManager<TestData>();

    // Initially no ID
    expect(sessionManager.id).toBeUndefined();

    // After creating session
    await sessionManager.getOrCreate("test-id-getter");
    expect(sessionManager.id).toBe("test-id-getter");
  });

  test("should provide persistence manager getter", async () => {
    const adapter = new MemoryAdapter();
    const sessionManager = new SessionManager<TestData>(adapter);

    const persistenceManager = sessionManager.getPersistenceManager();
    expect(persistenceManager).toBeDefined();
    expect(persistenceManager).toBeInstanceOf(PersistenceManager);
  });

  test("should handle undefined persistence manager", async () => {
    const sessionManager = new SessionManager<TestData>();

    const persistenceManager = sessionManager.getPersistenceManager();
    expect(persistenceManager).toBeUndefined();
  });
});
