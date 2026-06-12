/**
 * Session Concurrency & Persistence Versioning Tests
 *
 * Covers the optimistic-locking layer introduced around session persistence:
 * - Compare-and-swap version conflicts via MemoryAdapter (SessionConflictError)
 * - Legacy rows without a stored version are accepted
 * - Same-process save serialization (per-session save queue)
 * - version round-trip between save and load
 * - schemaVersion stamping + migrateSession upgrades on load
 * - Failed-turn rollback (no partial in-memory mutation)
 * - Pre-session staged data (initialData before a session exists)
 */
import { expect, test, describe } from "bun:test";
import {
  Agent,
  MemoryAdapter,
  PersistenceManager,
  createSession,
} from "../src/index";
import { SessionConflictError } from "../src/types/errors";
import { MockProvider } from "./mock-provider";

// Test data interfaces
interface TestData {
  name?: string;
  email?: string;
  counter?: number;
}

interface MigrationData {
  name?: string;
  fullName?: string;
}

interface TestContext {
  userId: string;
}

describe("Optimistic Locking via MemoryAdapter", () => {
  test("should reject stale save with SessionConflictError and expose error fields", async () => {
    const adapter = new MemoryAdapter<TestData>();
    const manager = new PersistenceManager<TestData>({ adapter });

    // Create the session row (version 1)
    const session = createSession<TestData>("conflict-test");
    session.data = { name: "Ada" };
    await manager.saveSessionState("conflict-test", session);

    // Load TWO independent copies — each carries the stored version
    const copyA = await manager.loadSessionState("conflict-test");
    const copyB = await manager.loadSessionState("conflict-test");
    expect(copyA?.version).toBe(1);
    expect(copyB?.version).toBe(1);

    // Save copy A — succeeds and bumps the version
    copyA!.data = { ...copyA!.data, counter: 1 };
    await manager.saveSessionState("conflict-test", copyA!);
    expect(copyA!.version).toBe(2);

    // Save copy B — stale version 1 vs stored version 2 → conflict
    copyB!.data = { ...copyB!.data, counter: 99 };
    let caught: unknown;
    try {
      await manager.saveSessionState("conflict-test", copyB!);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SessionConflictError);
    const conflict = caught as SessionConflictError;
    expect(conflict.sessionId).toBe("conflict-test");
    expect(conflict.expectedVersion).toBe(1);
    expect(conflict.actualVersion).toBe(2);
    expect(conflict.name).toBe("SessionConflictError");

    // The winning write is the one that persisted
    const stored = await adapter.sessionRepository.findById("conflict-test");
    expect(stored?.version).toBe(2);
    expect(stored?.collectedData?.data.counter).toBe(1);
  });

  test("should accept updates against rows without a stored version (pre-2.4 rows)", async () => {
    const adapter = new MemoryAdapter<TestData>();

    // repository.create always defaults `version` to 1 (data.version ?? 1), so a
    // versionless row cannot be created through the public create() input.
    // Simulate a pre-2.4 row by deleting `version` from the stored object —
    // getSnapshot() returns live references into the adapter's session map.
    const created = await adapter.sessionRepository.create({
      status: "active",
      collectedData: { data: { name: "Legacy" }, flowHistory: [], metadata: {} },
      messageCount: 0,
    });
    const storedRow = adapter
      .getSnapshot()
      .sessions.find((s) => s.id === created.id);
    expect(storedRow).toBeDefined();
    delete storedRow!.version;

    // Sanity: the stored row now has no version
    const versionless = await adapter.sessionRepository.findById(created.id);
    expect(versionless?.version).toBeUndefined();

    // A compare-and-swap update with an expectedVersion must be ACCEPTED
    // against a versionless row (no SessionConflictError)
    const updated = await adapter.sessionRepository.update(
      created.id,
      { currentFlow: "onboarding" },
      { expectedVersion: 7 }
    );

    expect(updated).not.toBeNull();
    expect(updated?.currentFlow).toBe("onboarding");
    // The row gains a version after the successful update
    expect(typeof updated?.version).toBe("number");
  });
});

describe("Same-Process Save Serialization", () => {
  test("should serialize 5 concurrent saves of the same session without conflicts", async () => {
    const adapter = new MemoryAdapter<TestData>();
    const manager = new PersistenceManager<TestData>({ adapter });

    // Create the session row first (version 1)
    const session = createSession<TestData>("serialize-test");
    session.data = { counter: 0 };
    await manager.saveSessionState("serialize-test", session);
    expect(session.version).toBe(1);

    // Fire 5 concurrent saves of the SAME in-memory session object
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => {
        session.data = { ...session.data, counter: i + 1 };
        return manager.saveSessionState("serialize-test", session);
      })
    );

    // All resolved — none threw SessionConflictError
    expect(results).toHaveLength(5);
    for (const result of results) {
      expect(result).not.toBeNull();
    }

    // Versions incremented once per save, in queue order: 1 (create) + 5 updates
    const versions = results.map((r) => r!.version);
    expect(versions).toEqual([2, 3, 4, 5, 6]);

    // Final stored version reflects all 5 serialized increments
    const stored = await adapter.sessionRepository.findById("serialize-test");
    expect(stored?.version).toBe(6);

    // The in-memory session tracks the final version
    expect(session.version).toBe(6);
  });
});

describe("Version Round-Trip", () => {
  test("should update in-memory version on save and return the same version on load", async () => {
    const adapter = new MemoryAdapter<TestData>();
    const manager = new PersistenceManager<TestData>({ adapter });

    const session = createSession<TestData>("roundtrip-test");
    session.data = { name: "Marie" };

    // Before any save the session has no version
    expect(session.version).toBeUndefined();

    // Create → version 1, propagated to the in-memory session
    await manager.saveSessionState("roundtrip-test", session);
    expect(session.version).toBe(1);

    // Update → version 2
    session.data = { ...session.data, email: "marie@example.com" };
    await manager.saveSessionState("roundtrip-test", session);
    expect(session.version).toBe(2);

    // loadSessionState returns the same stored version
    const loaded = await manager.loadSessionState("roundtrip-test");
    expect(loaded?.version).toBe(2);
    expect(loaded?.data).toEqual({ name: "Marie", email: "marie@example.com" });
  });
});

describe("schemaVersion Migration", () => {
  test("should migrate state written under schemaVersion 1 when loading with schemaVersion 2", async () => {
    const adapter = new MemoryAdapter<MigrationData>();

    // Write state under schemaVersion 1: { name }
    const managerV1 = new PersistenceManager<MigrationData>({
      adapter,
      schemaVersion: 1,
    });
    const session = createSession<MigrationData>("migration-test");
    session.data = { name: "Grace Hopper" };
    await managerV1.saveSessionState("migration-test", session);

    // The stored row is stamped with schemaVersion 1
    const storedV1 = await adapter.sessionRepository.findById("migration-test");
    expect(storedV1?.collectedData?.schemaVersion).toBe(1);

    // Load with a v2 manager whose migrator renames name → fullName
    let observedFromVersion: number | undefined;
    let migrateCalled = false;
    const managerV2 = new PersistenceManager<MigrationData>({
      adapter,
      schemaVersion: 2,
      migrateSession: (collectedData, fromVersion) => {
        migrateCalled = true;
        observedFromVersion = fromVersion;
        const { name, ...restData } = collectedData.data;
        return {
          ...collectedData,
          data: { ...restData, fullName: name },
        };
      },
    });

    const loaded = await managerV2.loadSessionState("migration-test");

    expect(migrateCalled).toBe(true);
    expect(observedFromVersion).toBe(1);
    expect(loaded?.data).toEqual({ fullName: "Grace Hopper" });

    // Saving the migrated state stamps schemaVersion 2 onto the stored row
    await managerV2.saveSessionState("migration-test", loaded!);
    const storedV2 = await adapter.sessionRepository.findById("migration-test");
    expect(storedV2?.collectedData?.schemaVersion).toBe(2);
    expect(storedV2?.collectedData?.data).toEqual({ fullName: "Grace Hopper" });
  });

  test("should load state as-is (warn only) when schemaVersion differs but no migrateSession is configured", async () => {
    const adapter = new MemoryAdapter<MigrationData>();

    const managerV1 = new PersistenceManager<MigrationData>({
      adapter,
      schemaVersion: 1,
    });
    const session = createSession<MigrationData>("no-migrator-test");
    session.data = { name: "Ada Lovelace" };
    await managerV1.saveSessionState("no-migrator-test", session);

    // v2 manager without a migrator: load must not throw, data unchanged
    const managerV2 = new PersistenceManager<MigrationData>({
      adapter,
      schemaVersion: 2,
    });
    const loaded = await managerV2.loadSessionState("no-migrator-test");

    expect(loaded).not.toBeNull();
    expect(loaded?.data).toEqual({ name: "Ada Lovelace" });

    // The stored row keeps its original schemaVersion (no stamp on load)
    const stored = await adapter.sessionRepository.findById("no-migrator-test");
    expect(stored?.collectedData?.schemaVersion).toBe(1);
  });
});

describe("Failed-Turn Rollback", () => {
  test("should restore pre-turn session state when the provider throws mid-turn", async () => {
    const adapter = new MemoryAdapter<TestData>();
    const provider = new MockProvider({ delayMs: 0 });

    const agent = new Agent<TestContext, TestData>({
      name: "RollbackAgent",
      description: "Agent for failed-turn rollback testing",
      context: { userId: "user-rollback" },
      provider,
      persistence: { adapter, userId: "user-rollback" },
    });

    // Establish a session with pre-turn state
    await agent.session.getOrCreate("rollback-test");
    await agent.updateCollectedData({ name: "Before", counter: 42 });
    await agent.session.save();

    const preTurnData = { ...agent.session.current!.data };
    const preTurnFlow = agent.session.current!.currentFlow;
    const preTurnStep = agent.session.current!.currentStep;
    const preTurnVersion = agent.session.current!.version!;
    const preTurnHistoryLength = agent.session.current!.history?.length ?? 0;

    // Make the provider throw mid-turn
    provider.updateConfig({
      shouldThrowError: true,
      errorMessage: "Provider exploded mid-turn",
    });

    let caught: unknown;
    try {
      await agent.chat("hello, this turn will fail");
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("Provider exploded mid-turn");

    // No partial mutation: data and flow state equal the pre-turn state
    expect(agent.session.current?.data).toEqual(preTurnData);
    expect(agent.session.current?.currentFlow).toEqual(preTurnFlow);
    expect(agent.session.current?.currentStep).toEqual(preTurnStep);

    // chat() appends the user message (with auto-save, bumping the version by
    // one) BEFORE respond() takes its rollback snapshot, so the restored state
    // includes the user message but nothing produced by the failed turn itself
    expect(agent.session.current?.history?.length).toBe(preTurnHistoryLength + 1);
    expect(agent.session.current?.version).toBe(preTurnVersion + 1);
  });
});

describe("Pre-Session Staged Data", () => {
  test("should stage initialData before a session exists and seed the first session with it", async () => {
    const provider = new MockProvider({ delayMs: 0 });

    const agent = new Agent<TestContext, TestData>({
      name: "StagedDataAgent",
      description: "Agent for pre-session staged data testing",
      context: { userId: "user-staged" },
      provider,
      initialData: { name: "Initial" },
    });

    // No session yet — getCollectedData reads the staging buffer
    expect(agent.session.current).toBeUndefined();
    expect(agent.getCollectedData()).toEqual({ name: "Initial" });

    // First session creation consumes the staged data into session.data
    const session = await agent.session.getOrCreate();
    expect(session.data).toEqual({ name: "Initial" });
    expect(agent.session.current?.data).toEqual({ name: "Initial" });

    // Subsequent updates write to session.data
    await agent.updateCollectedData({ email: "staged@example.com" });
    expect(agent.session.current?.data).toEqual({
      name: "Initial",
      email: "staged@example.com",
    });

    // getCollectedData now reads from the live session (returns a copy,
    // so assert deep equality with session.data)
    expect(agent.getCollectedData()).toEqual(agent.session.current!.data);
  });

  test("should route pre-session updateCollectedData writes into the staging buffer", async () => {
    const provider = new MockProvider({ delayMs: 0 });

    const agent = new Agent<TestContext, TestData>({
      name: "StagedUpdatesAgent",
      description: "Agent for pre-session update staging",
      context: { userId: "user-staged-2" },
      provider,
      initialData: { name: "Initial" },
    });

    // Pre-session update merges into the staging buffer
    await agent.updateCollectedData({ counter: 7 });
    expect(agent.session.current).toBeUndefined();
    expect(agent.getCollectedData()).toEqual({ name: "Initial", counter: 7 });

    // Session creation picks up the merged staged data
    const session = await agent.session.getOrCreate();
    expect(session.data).toEqual({ name: "Initial", counter: 7 });
    expect(agent.getCollectedData()).toEqual({ name: "Initial", counter: 7 });
  });
});
