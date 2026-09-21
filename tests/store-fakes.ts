/**
 * Fake clients for the stores whose real backend is a service: PostgreSQL,
 * Prisma, MongoDB, OpenSearch. Each keeps rows in a Map, answers the way its
 * driver does (including the driver's own conflict error), and records every
 * call so tests can assert the query, filter or script the store sent.
 */
import type { MongoClient } from "../src/persistence/MongoStore.js";
import type { OpenSearchClient } from "../src/persistence/OpenSearchStore.js";
import type { PgClient, PgQueryResult } from "../src/persistence/PostgresStore.js";
import type { PrismaClient, PrismaSessionModel } from "../src/persistence/PrismaStore.js";

type Row = Record<string, unknown>;

// ── PostgreSQL ──────────────────────────────────────────────────────────

export interface FakePg extends PgClient {
  rows: Map<string, { version: number; blob: string }>;
  calls: Array<{ sql: string; values?: unknown[] }>;
}

/**
 * Understands the five statements PostgresStore issues, by their first
 * words. JSONB comes back parsed, as node-postgres delivers it.
 */
export function createFakePg(): FakePg {
  const rows = new Map<string, { version: number; blob: string }>();
  const calls: FakePg["calls"] = [];
  const result = <T>(list: Row[]): PgQueryResult<T> => ({ rows: list as T[], rowCount: list.length });

  return {
    rows,
    calls,
    async query<T = Row>(sql: string, values: unknown[] = []): Promise<PgQueryResult<T>> {
      calls.push({ sql, values });
      const text = sql.replace(/\s+/g, " ").trim();
      const [id, arg2, arg3, arg4] = values as [string, unknown, unknown, unknown];
      if (text.startsWith("CREATE TABLE")) return result<T>([]);
      if (text.startsWith("SELECT blob")) {
        const row = rows.get(id);
        return result<T>(row ? [{ blob: JSON.parse(row.blob) as unknown }] : []);
      }
      if (text.startsWith("SELECT version")) {
        const row = rows.get(id);
        return result<T>(row ? [{ version: row.version }] : []);
      }
      if (text.startsWith("INSERT INTO")) {
        if (rows.has(id)) return result<T>([]);
        rows.set(id, { version: arg2 as number, blob: arg3 as string });
        return result<T>([{ version: arg2 }]);
      }
      if (text.startsWith("UPDATE")) {
        const row = rows.get(id);
        if (!row || row.version !== arg4) return result<T>([]);
        rows.set(id, { version: arg2 as number, blob: arg3 as string });
        return result<T>([{ version: arg2 }]);
      }
      throw new Error(`fake pg: unexpected statement ${text}`);
    },
    async end() {},
  };
}

// ── Prisma ──────────────────────────────────────────────────────────────

export interface FakePrisma extends PrismaClient {
  rows: Map<string, Row>;
  calls: Array<{ method: keyof PrismaSessionModel; params: unknown }>;
  disconnected: boolean;
}

/** Prisma throws `PrismaClientKnownRequestError` with `code` on a unique hit. */
class FakePrismaError extends Error {
  constructor(public readonly code: string) {
    super(`fake prisma: ${code}`);
  }
}

/** One model, keyed by the (possibly remapped) id and version field names. */
export function createFakePrisma(model = "agentSession", fields = { id: "id", version: "version" }): FakePrisma {
  const rows = new Map<string, Row>();
  const calls: FakePrisma["calls"] = [];
  const delegate: PrismaSessionModel = {
    async create({ data }) {
      calls.push({ method: "create", params: { data } });
      const id = data[fields.id] as string;
      if (rows.has(id)) throw new FakePrismaError("P2002");
      rows.set(id, { ...data });
      return { ...data };
    },
    async findUnique({ where }) {
      calls.push({ method: "findUnique", params: { where } });
      const row = rows.get(where[fields.id] as string);
      return row ? { ...row } : null;
    },
    async updateMany({ where, data }) {
      calls.push({ method: "updateMany", params: { where, data } });
      const row = rows.get(where[fields.id] as string);
      if (!row || row[fields.version] !== where[fields.version]) return { count: 0 };
      rows.set(where[fields.id] as string, { ...row, ...data });
      return { count: 1 };
    },
  };
  const fake: FakePrisma = {
    rows,
    calls,
    disconnected: false,
    [model]: delegate,
    async $disconnect() {
      fake.disconnected = true;
    },
  };
  return fake;
}

// ── MongoDB ─────────────────────────────────────────────────────────────

export interface FakeMongo extends MongoClient {
  docs: Map<string, Row>;
  calls: Array<{ method: "insertOne" | "findOne" | "updateOne"; args: unknown[] }>;
  collectionNames: string[];
  closed: boolean;
}

/** The driver's `MongoServerError` carries `code: 11000` on a duplicate key. */
class FakeMongoError extends Error {
  constructor(public readonly code: number) {
    super(`fake mongo: E${code} duplicate key`);
  }
}

export function createFakeMongo(): FakeMongo {
  const docs = new Map<string, Row>();
  const calls: FakeMongo["calls"] = [];
  const collectionNames: string[] = [];
  const fake: FakeMongo = {
    docs,
    calls,
    collectionNames,
    closed: false,
    db() {
      return {
        collection<T = Row>(name: string) {
          collectionNames.push(name);
          return {
            async insertOne(doc: T) {
              calls.push({ method: "insertOne", args: [doc] });
              const row = doc as Row;
              const id = row._id as string;
              if (docs.has(id)) throw new FakeMongoError(11000);
              docs.set(id, { ...row });
              return { insertedId: id };
            },
            async findOne(filter: Row) {
              calls.push({ method: "findOne", args: [filter] });
              const row = docs.get(filter._id as string);
              return row ? ({ ...row } as T) : null;
            },
            async updateOne(filter: Row, update: Row) {
              calls.push({ method: "updateOne", args: [filter, update] });
              const row = docs.get(filter._id as string);
              if (!row || row.version !== filter.version) return { matchedCount: 0 };
              docs.set(filter._id as string, { ...row, ...(update.$set as Row) });
              return { matchedCount: 1 };
            },
          };
        },
      };
    },
    async close() {
      fake.closed = true;
    },
  };
  return fake;
}

// ── OpenSearch ──────────────────────────────────────────────────────────

export interface FakeOpenSearch extends OpenSearchClient {
  docs: Map<string, Row>;
  calls: Array<{ method: "index" | "update" | "get" | "indices.exists" | "indices.create"; params: unknown }>;
  indexExists: boolean;
}

/** The client's `ResponseError` carries the HTTP status as `statusCode`. */
class FakeResponseError extends Error {
  constructor(public readonly statusCode: number) {
    super(`fake opensearch: ${statusCode}`);
  }
}

/**
 * Runs the store's painless script by hand: compare `version`, then either
 * noop or apply the params. Only that script is understood.
 */
export function createFakeOpenSearch(indexExists = false): FakeOpenSearch {
  const docs = new Map<string, Row>();
  const calls: FakeOpenSearch["calls"] = [];
  const fake: FakeOpenSearch = {
    docs,
    calls,
    indexExists,
    async index(params) {
      calls.push({ method: "index", params });
      if (params.op_type === "create" && docs.has(params.id)) throw new FakeResponseError(409);
      docs.set(params.id, { ...params.body });
      return { body: { result: "created" } };
    },
    async update(params) {
      calls.push({ method: "update", params });
      const doc = docs.get(params.id);
      if (!doc) throw new FakeResponseError(404);
      const script = params.body.script as { params: { expected: number; version: number; blob: unknown; updatedAt: string } };
      const { expected, version, blob, updatedAt } = script.params;
      if (doc.version !== expected) return { body: { result: "noop" } };
      docs.set(params.id, { ...doc, version, blob, updatedAt });
      return { body: { result: "updated" } };
    },
    async get(params) {
      calls.push({ method: "get", params });
      const doc = docs.get(params.id);
      if (!doc) throw new FakeResponseError(404);
      return { body: { _source: { ...doc } } };
    },
    indices: {
      async exists(params) {
        calls.push({ method: "indices.exists", params });
        return { body: fake.indexExists };
      },
      async create(params) {
        calls.push({ method: "indices.create", params });
        fake.indexExists = true;
        return { body: { acknowledged: true } };
      },
    },
  };
  return fake;
}
