/**
 * One Store contract, run against every backend.
 *
 * In-process backends run for real: MemoryStore, SQLiteStore over bun:sqlite
 * (structurally the better-sqlite3 seam; better-sqlite3 itself NAPI-panics
 * under Bun), RedisStore over the stub. The four whose backend is a service
 * (PostgreSQL, Prisma, MongoDB, OpenSearch) run the same contract against
 * recording fakes, and then get their own tests on the exact statement,
 * filter or script each one sends and on how the driver's conflict maps to
 * SessionConflictError.
 *
 * Source of truth: design §5 (`Store`), §10 (the blob) and invariant I1.
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { InvalidSessionError } from "../src/core/Migrate.js";
import { MemoryStore } from "../src/persistence/MemoryStore.js";
import { MongoStore } from "../src/persistence/MongoStore.js";
import { OpenSearchStore } from "../src/persistence/OpenSearchStore.js";
import { PostgresStore } from "../src/persistence/PostgresStore.js";
import { PrismaStore } from "../src/persistence/PrismaStore.js";
import { RedisStore } from "../src/persistence/RedisStore.js";
import { SQLiteStore } from "../src/persistence/SQLiteStore.js";
import { SessionConflictError } from "../src/types/errors.js";
import type { Run, Session, Store } from "../src/types/session.js";
import { createRedisStub } from "./redis-stub.js";
import { createFakeMongo, createFakeOpenSearch, createFakePg, createFakePrisma } from "./store-fakes.js";

interface TestData {
  nome: string;
  tamanho: "1-10" | "11-50";
  orcamento: number;
  confirmado: boolean;
  tags: string[];
}

const AT = "2026-09-20T10:00:00.000Z";

const run: Run = {
  id: "triagem#m1",
  flowId: "triagem",
  anchor: "s1",
  dedupeKey: "triagem:s1:",
  stepId: "porte",
  status: "asking",
  trigger: { kind: "message", key: "m1" },
  hop: 0,
  startedAt: AT,
  asked: { orcamento: 1 },
  visits: { quem: 1, porte: 1 },
  outcomes: [{ runId: "triagem#m1", stepId: "quem", kind: "collect", status: "ok", at: AT, llmCalls: 1 }],
};

/** A fresh, never-saved session. `version: 0` is what a first turn hands the host. */
function session(id: string, over: Partial<Session<TestData>> = {}): Session<TestData> {
  return {
    id,
    v: 4,
    version: 0,
    data: { nome: "Ana", tags: ["quente"] },
    runs: [{ ...run, anchor: id, dedupeKey: `triagem:${id}:` }],
    claims: { [`triagem:${id}:`]: { at: AT } },
    inputs: ["m1"],
    metadata: { workspaceId: "ws_demo" },
    ...over,
  };
}

/** A store under test, plus a way to write a wrong-shaped row behind its back. */
interface Harness {
  store: Store<TestData>;
  /** Replace the stored blob with `blob`, serialised the way this backend stores it. Absent when only the store can write. */
  corrupt?: (id: string, blob: unknown) => Promise<void>;
}

const harnesses: Record<string, () => Promise<Harness>> = {
  MemoryStore: () => Promise.resolve({ store: new MemoryStore<TestData>() }),

  SQLiteStore: async () => {
    const db = new Database(":memory:");
    const store = new SQLiteStore<TestData>({ db });
    await store.initialize();
    return {
      store,
      corrupt: (id, blob) => {
        db.prepare("UPDATE agent_sessions SET blob = ? WHERE id = ?").run(JSON.stringify(blob), id);
        return Promise.resolve();
      },
    };
  },

  RedisStore: () => {
    const redis = createRedisStub();
    return Promise.resolve({
      store: new RedisStore<TestData>({ redis }),
      corrupt: (id, blob) => {
        redis.hashes.get(`agent:session:${id}`)?.set("blob", JSON.stringify(blob));
        return Promise.resolve();
      },
    });
  },

  PostgresStore: async () => {
    const client = createFakePg();
    const store = new PostgresStore<TestData>({ client });
    await store.initialize();
    return {
      store,
      corrupt: (id, blob) => {
        const row = client.rows.get(id);
        if (row) row.blob = JSON.stringify(blob);
        return Promise.resolve();
      },
    };
  },

  PrismaStore: () => {
    const prisma = createFakePrisma();
    return Promise.resolve({
      store: new PrismaStore<TestData>({ prisma }),
      corrupt: (id, blob) => {
        const row = prisma.rows.get(id);
        if (row) row.blob = blob;
        return Promise.resolve();
      },
    });
  },

  MongoStore: () => {
    const client = createFakeMongo();
    return Promise.resolve({
      store: new MongoStore<TestData>({ client, databaseName: "falai" }),
      corrupt: (id, blob) => {
        const doc = client.docs.get(id);
        if (doc) doc.blob = JSON.stringify(blob);
        return Promise.resolve();
      },
    });
  },

  OpenSearchStore: async () => {
    const client = createFakeOpenSearch();
    const store = new OpenSearchStore<TestData>({ client });
    await store.initialize();
    return {
      store,
      corrupt: (id, blob) => {
        const doc = client.docs.get(id);
        if (doc) doc.blob = blob;
        return Promise.resolve();
      },
    };
  },
};

for (const [name, make] of Object.entries(harnesses)) {
  describe(`Store contract: ${name}`, () => {
    test("load of an unknown id is null", async () => {
      const { store } = await make();
      expect(await store.load("nobody")).toBeNull();
    });

    test("expectedVersion 0 inserts, returns version 1 and leaves the argument alone", async () => {
      const { store } = await make();
      const fresh = session("s1");
      const saved = await store.save(fresh, 0);
      expect(saved.version).toBe(1);
      expect(saved).not.toBe(fresh);
      expect(fresh.version).toBe(0);
      expect(await store.load("s1")).toEqual({ ...fresh, version: 1 });
    });

    test("a save bumps the version and the next load sees it", async () => {
      const { store } = await make();
      const v1 = await store.save(session("s1"), 0);
      const v2 = await store.save({ ...v1, data: { ...v1.data, orcamento: 5000 } }, 1);
      expect(v2.version).toBe(2);
      const loaded = await store.load("s1");
      expect(loaded?.version).toBe(2);
      expect(loaded?.data.orcamento).toBe(5000);
    });

    test("a stale save throws SessionConflictError carrying the stored version", async () => {
      const { store } = await make();
      const v1 = await store.save(session("s1"), 0);
      await store.save(v1, 1);
      const error = await rejection(store.save(v1, 1), SessionConflictError);
      expect(error.sessionId).toBe("s1");
      expect(error.expectedVersion).toBe(1);
      expect(error.actualVersion).toBe(2);
      expect((await store.load("s1"))?.version).toBe(2);
    });

    test("an insert over an existing row is a conflict, not an overwrite", async () => {
      const { store } = await make();
      await store.save(session("s1"), 0);
      const error = await rejection(store.save(session("s1", { data: { nome: "Outra" } }), 0), SessionConflictError);
      expect(error.actualVersion).toBe(1);
      expect((await store.load("s1"))?.data.nome).toBe("Ana");
    });

    test("a save against a version nobody has yet (row missing) is a conflict with no actual version", async () => {
      const { store } = await make();
      const error = await rejection(store.save(session("ghost"), 3), SessionConflictError);
      expect(error.actualVersion).toBeUndefined();
      // A vanished row is not a race, and the message says so.
      expect(error.message).toContain('Session "ghost" is gone from the store: it was at version 3');
      expect(await store.load("ghost")).toBeNull();
    });

    test("concurrent saves from the same version: exactly one wins", async () => {
      const { store } = await make();
      const v1 = await store.save(session("s1"), 0);
      const attempts = [1, 2, 3, 4, 5].map((n) => store.save({ ...v1, data: { ...v1.data, orcamento: n } }, 1));
      const results = await Promise.allSettled(attempts);
      const won = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
      expect(won).toHaveLength(1);
      for (const r of results) {
        if (r.status === "rejected") {
          expect(r.reason).toBeInstanceOf(SessionConflictError);
          expect((r.reason as SessionConflictError).actualVersion).toBe(2);
        }
      }
      const loaded = await store.load("s1");
      expect(loaded?.version).toBe(2);
      expect(loaded?.data.orcamento).toBe(won[0].data.orcamento);
    });

    test("concurrent inserts: exactly one wins", async () => {
      const { store } = await make();
      const results = await Promise.allSettled([store.save(session("s1"), 0), store.save(session("s1"), 0)]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    });

    test("load round-trips the whole blob, optional keys included only when set", async () => {
      const { store } = await make();
      const bare = session("bare");
      await store.save(bare, 0);
      const loadedBare = await store.load("bare");
      expect(Object.keys(loadedBare ?? {}).sort()).toEqual(["claims", "data", "id", "inputs", "metadata", "runs", "v", "version"]);
      expect(loadedBare).not.toHaveProperty("history");
      expect(loadedBare).not.toHaveProperty("lastUserAt");

      const full = session("full", {
        lastUserAt: AT,
        lastAssistantAt: "2026-09-20T10:00:05.000Z",
        history: [
          { role: "user", content: "oi" },
          { role: "assistant", content: "Olá! Como posso ajudar?" },
        ],
        runs: [
          { ...run, anchor: "full", dedupeKey: "triagem:full:" },
          {
            ...run,
            id: "retomar#1",
            flowId: "retomar",
            anchor: "lead:1",
            dedupeKey: "retomar:lead:1:",
            stepId: "w1",
            status: "waiting",
            trigger: { kind: "silence", key: "1", payload: { nested: [1, "a", null] } },
            input: { campaignId: "c1" },
            waiting: { kind: "timer", key: "retomar#1:w1:1", until: AT, setAt: AT },
          },
        ],
        claims: { "triagem:full:": { at: AT }, "sempre:full:wamid.HBgN.abc": { at: AT } },
        inputs: ["m1", "m2"],
        metadata: { workspaceId: "ws", tags: ["a", "b"], nested: { deep: true } },
      });
      await store.save(full, 0);
      expect(await store.load("full")).toEqual({ ...full, version: 1 });
    });

    test("a save returns the blob it stored, nothing more", async () => {
      const { store } = await make();
      const saved = await store.save(session("s1"), 0);
      expect(Object.keys(saved).sort()).toEqual(["claims", "data", "id", "inputs", "metadata", "runs", "v", "version"]);
    });

    // MemoryStore has no raw seam: only the store writes it, so no row can be malformed.
    if (name !== "MemoryStore") {
      test("a row whose blob is not v4-shaped throws InvalidSessionError instead of loading", async () => {
        const { store, corrupt } = await make();
        await store.save(session("s1"), 0);
        await raw(corrupt)("s1", { nope: true });
        await expect(store.load("s1")).rejects.toBeInstanceOf(InvalidSessionError);
      });

      test("a 3.x blob in the store throws too: stores never migrate", async () => {
        const { store, corrupt } = await make();
        await store.save(session("s1"), 0);
        await raw(corrupt)("s1", { id: "s1", data: { nome: "Ana" }, currentFlow: { id: "f", title: "F" }, version: 3 });
        const error = await rejection(store.load("s1"), InvalidSessionError);
        expect(error.message).toContain('[InvalidSessionError] stored session "s1"');
      });

      test("a row whose id disagrees with the blob throws", async () => {
        const { store, corrupt } = await make();
        await store.save(session("s1"), 0);
        await raw(corrupt)("s1", { ...session("s2"), version: 1 });
        await expect(store.load("s1")).rejects.toBeInstanceOf(InvalidSessionError);
      });
    }
  });
}

function raw(corrupt: Harness["corrupt"]): NonNullable<Harness["corrupt"]> {
  if (!corrupt) throw new Error("this harness has no raw seam");
  return corrupt;
}

/** The typed rejection of a promise that must fail; anything else fails the test. */
async function rejection<E extends Error>(promise: Promise<unknown>, type: abstract new (...args: never[]) => E): Promise<E> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof type) return error;
    throw error;
  }
  throw new Error(`expected ${type.name}, but the promise resolved`);
}

// ── Backend-specific: the statement, filter or script each store sends ──

describe("PostgresStore statements", () => {
  test("initialize creates the table; insert and update are single CAS statements", async () => {
    const client = createFakePg();
    const store = new PostgresStore<TestData>({ client, tables: { sessions: "conversas" } });
    await store.initialize();
    expect(client.calls[0].sql).toMatch(/CREATE TABLE IF NOT EXISTS conversas/);

    await store.save(session("s1"), 0);
    const insert = client.calls[1];
    expect(insert.sql.replace(/\s+/g, " ")).toBe(
      "INSERT INTO conversas (id, version, blob) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING RETURNING version",
    );
    expect(insert.values?.slice(0, 2)).toEqual(["s1", 1]);
    expect(JSON.parse(insert.values?.[2] as string)).toEqual({ ...session("s1"), version: 1 });

    await store.save({ ...session("s1"), version: 1 }, 1);
    const update = client.calls[2];
    expect(update.sql.replace(/\s+/g, " ")).toBe(
      "UPDATE conversas SET version = $2, blob = $3, updated_at = NOW() WHERE id = $1 AND version = $4 RETURNING version",
    );
    expect(update.values?.[0]).toBe("s1");
    expect(update.values?.[1]).toBe(2);
    expect(update.values?.[3]).toBe(1);
  });

  test("no row back maps to SessionConflictError with the stored version read afterwards", async () => {
    const client = createFakePg();
    const store = new PostgresStore<TestData>({ client });
    await store.save(session("s1"), 0);
    await store.save({ ...session("s1"), version: 1 }, 1);
    const error = await rejection(store.save({ ...session("s1"), version: 1 }, 1), SessionConflictError);
    expect(error.actualVersion).toBe(2);
    expect(client.calls.at(-1)?.sql).toMatch(/SELECT version FROM agent_sessions WHERE id = \$1/);
  });

  test("disconnect ends the client", async () => {
    const client = createFakePg();
    let ended = false;
    client.end = () => {
      ended = true;
      return Promise.resolve();
    };
    await new PostgresStore<TestData>({ client }).disconnect();
    expect(ended).toBe(true);
  });
});

describe("PrismaStore delegates", () => {
  test("first save is create; later saves are updateMany filtered on id and version", async () => {
    const prisma = createFakePrisma();
    const store = new PrismaStore<TestData>({ prisma });
    await store.save(session("s1"), 0);
    const create = prisma.calls[0];
    expect(create.method).toBe("create");
    const data = (create.params as { data: Record<string, unknown> }).data;
    expect(data.id).toBe("s1");
    expect(data.version).toBe(1);
    expect(data.blob).toEqual({ ...session("s1"), version: 1 });
    expect(data.createdAt).toBeInstanceOf(Date);
    expect(data.updatedAt).toBeInstanceOf(Date);

    await store.save({ ...session("s1"), version: 1 }, 1);
    const update = prisma.calls[1];
    expect(update.method).toBe("updateMany");
    const params = update.params as { where: Record<string, unknown>; data: Record<string, unknown> };
    expect(params.where).toEqual({ id: "s1", version: 1 });
    expect(params.data.version).toBe(2);
    expect(params.data.updatedAt).toBeInstanceOf(Date);
    expect(params.data).not.toHaveProperty("createdAt");
  });

  test("P2002 on create and count 0 on updateMany both map to SessionConflictError", async () => {
    const prisma = createFakePrisma();
    const store = new PrismaStore<TestData>({ prisma });
    await store.save(session("s1"), 0);
    const onCreate = await rejection(store.save(session("s1"), 0), SessionConflictError);
    expect(onCreate.actualVersion).toBe(1);
    const onUpdate = await rejection(store.save(session("s1"), 7), SessionConflictError);
    expect(onUpdate.expectedVersion).toBe(7);
    expect(onUpdate.actualVersion).toBe(1);
  });

  test("a driver error that is not P2002 propagates", async () => {
    const prisma = createFakePrisma();
    const model = prisma.agentSession as { create: () => Promise<never> };
    model.create = () => Promise.reject(new Error("connection refused"));
    await expect(new PrismaStore<TestData>({ prisma }).save(session("s1"), 0)).rejects.toThrow("connection refused");
  });

  test("model name and field mappings are honoured", async () => {
    const prisma = createFakePrisma("conversa", { id: "chave", version: "rev" });
    const store = new PrismaStore<TestData>({
      prisma,
      tables: { sessions: "conversa" },
      fieldMappings: { sessions: { id: "chave", version: "rev", blob: "estado", createdAt: "criadoEm", updatedAt: "atualizadoEm" } },
    });
    const saved = await store.save(session("s1"), 0);
    const data = (prisma.calls[0].params as { data: Record<string, unknown> }).data;
    expect(Object.keys(data).sort()).toEqual(["atualizadoEm", "chave", "criadoEm", "estado", "rev"]);
    await store.save(saved, 1);
    const where = (prisma.calls[1].params as { where: Record<string, unknown> }).where;
    expect(where).toEqual({ chave: "s1", rev: 1 });
    expect((await store.load("s1"))?.version).toBe(2);
  });

  test("a client without the model fails at construction, naming the fix", () => {
    expect(() => new PrismaStore<TestData>({ prisma: createFakePrisma("other") })).toThrow(
      /\[TypeError\] PrismaStore cannot use model "agentSession".*tables\.sessions/,
    );
  });

  test("disconnect calls $disconnect", async () => {
    const prisma = createFakePrisma();
    await new PrismaStore<TestData>({ prisma }).disconnect();
    expect(prisma.disconnected).toBe(true);
  });
});

describe("MongoStore filters", () => {
  test("insertOne for a first save, updateOne filtered on _id and version after", async () => {
    const client = createFakeMongo();
    const store = new MongoStore<TestData>({ client, databaseName: "falai", collections: { sessions: "conversas" } });
    expect(client.collectionNames).toEqual(["conversas"]);

    await store.save(session("s1"), 0);
    const [doc] = client.calls[0].args as [Record<string, unknown>];
    expect(client.calls[0].method).toBe("insertOne");
    expect(doc._id).toBe("s1");
    expect(doc.version).toBe(1);
    expect(JSON.parse(doc.blob as string)).toEqual({ ...session("s1"), version: 1 });
    expect(doc.createdAt).toBeInstanceOf(Date);

    await store.save({ ...session("s1"), version: 1 }, 1);
    const [filter, update] = client.calls[1].args as [Record<string, unknown>, { $set: Record<string, unknown> }];
    expect(client.calls[1].method).toBe("updateOne");
    expect(filter).toEqual({ _id: "s1", version: 1 });
    expect(update.$set.version).toBe(2);
    expect(update.$set.updatedAt).toBeInstanceOf(Date);
    expect(update.$set).not.toHaveProperty("createdAt");
  });

  test("E11000 on insert and matchedCount 0 on update both map to SessionConflictError", async () => {
    const client = createFakeMongo();
    const store = new MongoStore<TestData>({ client, databaseName: "falai" });
    await store.save(session("s1"), 0);
    const onInsert = await rejection(store.save(session("s1"), 0), SessionConflictError);
    expect(onInsert.actualVersion).toBe(1);
    const onUpdate = await rejection(store.save(session("s1"), 9), SessionConflictError);
    expect(onUpdate.actualVersion).toBe(1);
    await store.disconnect();
    expect(client.closed).toBe(true);
  });
});

describe("OpenSearchStore requests", () => {
  test("initialize creates the index with its mappings only when missing", async () => {
    const missing = createFakeOpenSearch(false);
    await new OpenSearchStore<TestData>({ client: missing, indices: { sessions: "conversas" } }).initialize();
    expect(missing.calls.map((c) => c.method)).toEqual(["indices.exists", "indices.create"]);
    const create = missing.calls[1].params as { index: string; body: { mappings: { properties: Record<string, unknown> } } };
    expect(create.index).toBe("conversas");
    expect(create.body.mappings.properties.blob).toEqual({ type: "object", enabled: false });

    const present = createFakeOpenSearch(true);
    await new OpenSearchStore<TestData>({ client: present }).initialize();
    expect(present.calls.map((c) => c.method)).toEqual(["indices.exists"]);

    const off = createFakeOpenSearch(false);
    await new OpenSearchStore<TestData>({ client: off, autoCreateIndices: false }).initialize();
    expect(off.calls).toHaveLength(0);
  });

  test("first save is index with op_type create; later saves are a scripted CAS update", async () => {
    const client = createFakeOpenSearch(true);
    const store = new OpenSearchStore<TestData>({ client, refresh: "wait_for" });
    await store.save(session("s1"), 0);
    const index = client.calls[0].params as { id: string; op_type: string; refresh: unknown; body: Record<string, unknown> };
    expect(client.calls[0].method).toBe("index");
    expect(index.op_type).toBe("create");
    expect(index.refresh).toBe("wait_for");
    expect(index.body.version).toBe(1);
    expect(index.body.blob).toEqual({ ...session("s1"), version: 1 });

    await store.save({ ...session("s1"), version: 1 }, 1);
    const update = client.calls[1].params as {
      retry_on_conflict: number;
      body: { script: { lang: string; source: string; params: Record<string, unknown> } };
    };
    expect(client.calls[1].method).toBe("update");
    expect(update.retry_on_conflict).toBe(3);
    expect(update.body.script.lang).toBe("painless");
    expect(update.body.script.source).toContain("ctx._source.version != params.expected");
    expect(update.body.script.source).toContain("ctx.op = 'noop'");
    expect(update.body.script.params.expected).toBe(1);
    expect(update.body.script.params.version).toBe(2);
  });

  test("409 on create, noop on update and 404 on update all map to SessionConflictError", async () => {
    const client = createFakeOpenSearch(true);
    const store = new OpenSearchStore<TestData>({ client });
    await store.save(session("s1"), 0);
    const onCreate = await rejection(store.save(session("s1"), 0), SessionConflictError);
    expect(onCreate.actualVersion).toBe(1);
    const onNoop = await rejection(store.save(session("s1"), 5), SessionConflictError);
    expect(onNoop.actualVersion).toBe(1);
    const onMissing = await rejection(store.save(session("s2"), 5), SessionConflictError);
    expect(onMissing.actualVersion).toBeUndefined();
  });
});

describe("RedisStore script", () => {
  test("save runs one Lua CAS over the session hash and sets the TTL", async () => {
    const redis = createRedisStub();
    const store = new RedisStore<TestData>({ redis, keyPrefix: "x:", sessionTTL: 60 });
    await store.save(session("s1"), 0);
    const [call] = redis.evals;
    expect(call.numKeys).toBe(1);
    expect(call.args[0]).toBe("x:session:s1");
    expect(call.args[1]).toBe("0");
    expect(call.args[2]).toBe("1");
    expect(JSON.parse(call.args[3])).toEqual({ ...session("s1"), version: 1 });
    expect(call.args[5]).toBe("60");
    expect(call.script).toContain("HGET");
    expect(call.script).toContain("EXPIRE");
    const hash = redis.hashes.get("x:session:s1");
    expect(hash?.get("version")).toBe("1");
    expect(hash?.has("createdAt")).toBe(true);
  });
});
