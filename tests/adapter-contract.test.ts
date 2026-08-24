/**
 * Adapter contract suite — ONE parameterized contract run against BOTH
 * MemoryAdapter and SQLiteAdapter, so future adapters slot in by adding a
 * single `runAdapterContract(...)` line at the bottom.
 *
 * Source of truth for the semantics: src/types/persistence.ts docs — in
 * particular the SessionRepository.update docstring, which pins the
 * compare-and-swap behavior of `options.expectedVersion`:
 *   - reject with SessionConflictError when the stored version differs
 *   - accept rows with NO stored version (written by pre-2.4)
 *   - every successful update increments `version` by one
 *
 * The SQLite backend uses bun:sqlite (structurally compatible with the
 * adapter's better-sqlite3-shaped SqliteDatabase seam). better-sqlite3 is NOT
 * imported — it NAPI-panics under Bun 1.3.x.
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { MemoryAdapter } from "../src/adapters/MemoryAdapter";
import {
  SQLiteAdapter,
  type SqliteDatabase,
} from "../src/adapters/SQLiteAdapter";
import { PersistenceManager } from "../src/core/PersistenceManager";
import { SessionConflictError } from "../src/types/errors";
import { EventKind, MessageRole } from "../src/types/history";
import type {
  CollectedStateData,
  PersistenceAdapter,
  SessionData,
  SessionState,
} from "../src/types/persistence";

/** Complex TData shape used across the contract (nested objects/arrays/nulls). */
interface TestData {
  name: string;
  age?: number;
  vip?: boolean;
  nickname?: string | null;
  tags?: string[];
  address?: {
    city: string;
    zip: string | null;
    geo?: { lat: number; lng: number };
  };
}

/** Everything a contract test may use, plus adapter-specific escape hatches. */
interface AdapterUnderTest {
  adapter: PersistenceAdapter<TestData>;
  /**
   * Simulate a pre-2.4 row: remove the stored optimistic-concurrency version
   * behind the adapter's back (raw db exec / Memory internals).
   */
  stripStoredVersion(sessionId: string): Promise<void>;
}

type MakeAdapter = () => Promise<AdapterUnderTest>;

function makeMemoryHarness(): Promise<AdapterUnderTest> {
  const adapter = new MemoryAdapter<TestData>();
  return Promise.resolve({
    adapter,
    stripStoredVersion: (id) => {
      // Reach into MemoryAdapter's private session store to simulate a row
      // written by pre-2.4 (no version). Test-double cast, permitted in tests.
      const sessions = (
        adapter as unknown as {
          sessions: Map<string, SessionData<TestData>>;
        }
      ).sessions;
      const row = sessions.get(id);
      if (row) sessions.set(id, { ...row, version: undefined });
      return Promise.resolve();
    },
  });
}

async function makeSQLiteHarness(): Promise<AdapterUnderTest> {
  const db = new Database(":memory:");
  // Justification for the double cast: bun:sqlite is structurally compatible
  // with the adapter's better-sqlite3-shaped SqliteDatabase seam (verified
  // working end-to-end including CAS), and better-sqlite3 itself cannot be
  // imported here — it NAPI-panics under Bun 1.3.x.
  const adapter = new SQLiteAdapter<TestData>({
    db: db as unknown as SqliteDatabase,
  });
  await adapter.initialize();
  return {
    adapter,
    stripStoredVersion: async (id) => {
      await db
        .prepare("UPDATE agent_sessions SET version = NULL WHERE id = ?")
        .run(id);
    },
  };
}

/** Distinct-millisecond timestamps: ordering assertions need strictly increasing createdAt. */
const tick = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 4));

/** Narrow a nullable repository result or fail loudly with context. */
function expectFound<T>(value: T | null, what: string): T {
  if (value === null) {
    throw new Error(`expected ${what} to be found, got null`);
  }
  return value;
}

/**
 * Run the full adapter contract under `label`. Every scenario below is the
 * contract; adapters conforming to PersistenceAdapter must pass all of it.
 */
function runAdapterContract(label: string, make: MakeAdapter): void {
  describe(label, () => {
    test(
      "contract #1 round-trip fidelity: create → findById returns all fields",
      async () => {
        await withHarness(make, async ({ adapter }) => {
          const collected: CollectedStateData<TestData> = {
            data: {
              name: "Gus",
              age: 30,
              vip: true,
              nickname: null,
              tags: ["a", "b"],
              address: {
                city: "Recife",
                zip: null,
                geo: { lat: -8.05, lng: -34.9 },
              },
            },
            flowHistory: [{ flowId: "support", completed: false }],
            metadata: {},
          };

          await adapter.sessionRepository.create({
            id: "sess_full",
            userId: "user_1",
            agentName: "ContractAgent",
            status: "active",
            currentFlow: "support",
            currentStep: "ask_email",
            collectedData: collected,
            messageCount: 0,
          });

          const loaded = expectFound(
            await adapter.sessionRepository.findById("sess_full"),
            "created session"
          );

          expect(loaded.id).toBe("sess_full");
          expect(loaded.userId).toBe("user_1");
          expect(loaded.agentName).toBe("ContractAgent");
          expect(loaded.status).toBe("active");
          expect(loaded.currentFlow).toBe("support");
          expect(loaded.currentStep).toBe("ask_email");
          expect(loaded.messageCount).toBe(0);
          expect(loaded.version).toBe(1);
          expect(loaded.createdAt).toBeInstanceOf(Date);
          expect(loaded.updatedAt).toBeInstanceOf(Date);
          expect(loaded.collectedData).toEqual(collected);
        });
      }
    );

    test("contract #2a update() increments version by one", async () => {
      await withHarness(make, async ({ adapter }) => {
        const repo = adapter.sessionRepository;
        await repo.create({ id: "sess_ver", userId: "user_v", status: "active" });

        const afterFirst = expectFound(
          await repo.update("sess_ver", { messageCount: 3 }),
          "first update"
        );
        expect(afterFirst.version).toBe(2);
        expect(afterFirst.messageCount).toBe(3);

        const afterSecond = expectFound(
          await repo.update("sess_ver", { status: "completed" }),
          "second update"
        );
        expect(afterSecond.version).toBe(3);
        expect(afterSecond.status).toBe("completed");

        const stored = expectFound(
          await repo.findById("sess_ver"),
          "updated session"
        );
        expect(stored.version).toBe(3);
        expect(stored.messageCount).toBe(3);
      });
    });

    test(
      "contract #2b CAS: matching expectedVersion succeeds, stale throws SessionConflictError without mutating",
      async () => {
        await withHarness(make, async ({ adapter }) => {
          const repo = adapter.sessionRepository;
          await repo.create({
            id: "sess_cas",
            userId: "user_c",
            status: "active",
          });

          const matched = expectFound(
            await repo.update(
              "sess_cas",
              { currentFlow: "flow_a" },
              { expectedVersion: 1 }
            ),
            "CAS update with matching version"
          );
          expect(matched.version).toBe(2);
          expect(matched.currentFlow).toBe("flow_a");

          let thrown: unknown;
          try {
            await repo.update(
              "sess_cas",
              { status: "abandoned" },
              { expectedVersion: 1 }
            );
          } catch (error) {
            thrown = error;
          }
          expect(thrown).toBeInstanceOf(SessionConflictError);

          // A rejected CAS must leave the row untouched (no partial write).
          const unchanged = expectFound(
            await repo.findById("sess_cas"),
            "session after rejected CAS"
          );
          expect(unchanged.status).toBe("active");
          expect(unchanged.currentFlow).toBe("flow_a");
          expect(unchanged.version).toBe(2);
        });
      }
    );

    test(
      "contract #2c CAS accepts rows without a stored version (pre-2.4) and adopts expectedVersion as base",
      async () => {
        await withHarness(make, async (harness) => {
          const repo = harness.adapter.sessionRepository;
          await repo.create({
            id: "sess_pre24",
            userId: "user_p",
            status: "active",
          });
          await harness.stripStoredVersion("sess_pre24");

          const legacy = expectFound(
            await repo.findById("sess_pre24"),
            "stripped session"
          );
          expect(legacy.version).toBeUndefined();

          const updated = expectFound(
            await repo.update(
              "sess_pre24",
              { currentFlow: "legacy_flow" },
              { expectedVersion: 7 }
            ),
            "CAS update over version-less row"
          );
          expect(updated.version).toBe(8);
          expect(updated.currentFlow).toBe("legacy_flow");
        });
      }
    );

    test(
      "contract #3 collectedData survives complex TData payloads verbatim (JSON-shaped)",
      async () => {
        await withHarness(make, async ({ adapter }) => {
          const repo = adapter.sessionRepository;
          await repo.create({
            id: "sess_data",
            userId: "user_d",
            status: "active",
          });

          // JSON-safe by construction: strings, numbers, booleans, nulls,
          // nested arrays/objects — no Dates or undefined values.
          const rich: CollectedStateData<TestData> = {
            schemaVersion: 3,
            data: {
              name: "Ana",
              age: 0,
              vip: false,
              nickname: null,
              tags: [],
              address: {
                city: "São Paulo",
                zip: null,
                geo: { lat: -23.55, lng: -46.63 },
              },
            },
            flowHistory: [
              { flowId: "onboarding", completed: true },
              { flowId: "support", completed: false },
            ],
            history: [{ role: "user", content: "olá" }],
            currentFlowTitle: "Support",
            currentStepDescription: "Collect e-mail",
            metadata: { source: "web", attempts: 2, flags: { dark: true } },
          };

          await repo.updateCollectedData("sess_data", rich);

          const stored = expectFound(
            await repo.findById("sess_data"),
            "session with rich collectedData"
          );
          expect(stored.collectedData).toEqual(rich);
        });
      }
    );

    test(
      "contract #4 history with assistant(tool_calls)+tool pairs round-trips through PersistenceManager save/load",
      async () => {
        await withHarness(make, async ({ adapter }) => {
          // Mirror the real SessionManager loop: saveSessionState → later
          // loadSessionState, letting the manager drive the version CAS.
          const pm = new PersistenceManager<TestData>({ adapter });

          const state: SessionState<TestData> = {
            id: "sess_hist",
            data: { name: "Túlio" },
            flowHistory: [{ flowId: "order", completed: false }],
            currentFlow: { id: "order", title: "Order tracking" },
            history: [
              { role: "user", content: "Where is my order?" },
              {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call_1",
                    name: "lookup_order",
                    arguments: { orderId: "A-77" },
                  },
                ],
              },
              {
                role: "tool",
                tool_call_id: "call_1",
                name: "lookup_order",
                content: { status: "shipped", etaDays: 3 },
              },
              { role: "assistant", content: "It shipped — ETA 3 days." },
            ],
            metadata: {},
          };

          // First save hits the create path; the manager stamps the saved
          // version back onto the in-memory step.
          await pm.saveSessionState("sess_hist", state);
          expect(state.version).toBe(1);

          // Second save hits the CAS update path with the propagated version.
          state.data = { name: "Túlio", age: 41 };
          await pm.saveSessionState("sess_hist", state);

          const restored = expectFound(
            await pm.loadSessionState("sess_hist"),
            "restored session state"
          );
          expect(restored.history).toEqual(state.history);
          expect(restored.data).toEqual(state.data);
          expect(restored.flowHistory).toEqual([
            { flowId: "order", completed: false },
          ]);
          expect(restored.version).toBe(2);
        });
      }
    );

    test("contract #5 delete removes the row: findById → null afterwards", async () => {
      await withHarness(make, async ({ adapter }) => {
        const repo = adapter.sessionRepository;
        await repo.create({
          id: "sess_gone",
          userId: "user_g",
          status: "active",
        });

        expect(await repo.delete("sess_gone")).toBe(true);
        expect(await repo.findById("sess_gone")).toBeNull();
        expect(await repo.delete("sess_gone")).toBe(false);
      });
    });

    test(
      "contract #6 findByUserId filters by user newest-first and respects limit; findActiveByUserId skips non-active",
      async () => {
        await withHarness(make, async ({ adapter }) => {
          const repo = adapter.sessionRepository;

          await repo.create({ id: "s_a1", userId: "user_a", status: "active" });
          await tick();
          await repo.create({ id: "s_a2", userId: "user_a", status: "active" });
          await tick();
          await repo.create({ id: "s_a3", userId: "user_a", status: "active" });
          await repo.create({ id: "s_b1", userId: "user_b", status: "active" });

          const all = await repo.findByUserId("user_a");
          expect(all.map((s) => s.id)).toEqual(["s_a3", "s_a2", "s_a1"]);

          const limited = await repo.findByUserId("user_a", 2);
          expect(limited.map((s) => s.id)).toEqual(["s_a3", "s_a2"]);
          expect(limited.every((s) => s.userId === "user_a")).toBe(true);

          const active = await repo.findActiveByUserId("user_a");
          expect(active?.id).toBe("s_a3");

          await repo.updateStatus("s_a3", "completed");
          const nextActive = await repo.findActiveByUserId("user_a");
          expect(nextActive?.id).toBe("s_a2");

          expect(await repo.findActiveByUserId("user_nobody")).toBeNull();
        });
      }
    );

    test(
      "contract #7 messageRepository append + list round-trips order, roles, content, toolCalls and event",
      async () => {
        await withHarness(make, async ({ adapter }) => {
          await adapter.sessionRepository.create({
            id: "sess_msg",
            userId: "user_m",
            status: "active",
          });
          const messages = adapter.messageRepository;

          const m1 = await messages.create({
            sessionId: "sess_msg",
            userId: "user_m",
            role: MessageRole.USER,
            content: "hello",
          });
          await tick();
          const m2 = await messages.create({
            sessionId: "sess_msg",
            userId: "user_m",
            role: MessageRole.ASSISTANT,
            content: "looking it up",
            toolCalls: [
              { toolName: "lookup", arguments: { q: "order A-77" } },
            ],
          });
          await tick();
          const m3 = await messages.create({
            sessionId: "sess_msg",
            userId: "user_m",
            role: MessageRole.USER,
            content: "thanks!",
            flow: "support",
            step: "done",
            event: {
              kind: EventKind.MESSAGE,
              source: MessageRole.USER,
              data: {
                participant: { display_name: "Gus" },
                message: "thanks!",
              },
            },
          });

          const list = await messages.findBySessionId("sess_msg");
          expect(list.map((m) => m.id)).toEqual([m1.id, m2.id, m3.id]);
          expect(list.map((m) => m.role)).toEqual([
            MessageRole.USER,
            MessageRole.ASSISTANT,
            MessageRole.USER,
          ]);
          expect(list.map((m) => m.content)).toEqual([
            "hello",
            "looking it up",
            "thanks!",
          ]);
          expect(list[1].toolCalls).toEqual([
            { toolName: "lookup", arguments: { q: "order A-77" } },
          ]);
          expect(list[2].flow).toBe("support");
          expect(list[2].step).toBe("done");
          expect(list[2].event).toEqual({
            kind: EventKind.MESSAGE,
            source: MessageRole.USER,
            data: {
              participant: { display_name: "Gus" },
              message: "thanks!",
            },
          });
          for (const message of list) {
            expect(message.createdAt).toBeInstanceOf(Date);
          }

          const limited = await messages.findBySessionId("sess_msg", 2);
          expect(limited.map((m) => m.id)).toEqual([m1.id, m2.id]);
        });
      }
    );
  });
}

/** Fresh adapter per test; disconnects whatever the backend opened. */
async function withHarness(
  make: MakeAdapter,
  run: (harness: AdapterUnderTest) => Promise<void>
): Promise<void> {
  const harness = await make();
  try {
    await run(harness);
  } finally {
    await harness.adapter.disconnect?.();
  }
}

runAdapterContract("MemoryAdapter contract", makeMemoryHarness);
runAdapterContract("SQLiteAdapter contract", makeSQLiteHarness);
