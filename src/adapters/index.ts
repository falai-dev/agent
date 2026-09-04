/**
 * Database adapters for persistence
 */

export { PrismaAdapter } from "./PrismaAdapter.js";
export type {
  PrismaClient,
  FieldMappings,
  PrismaAdapterOptions,
} from "./PrismaAdapter.js";

export { RedisAdapter } from "./RedisAdapter.js";
export type { RedisClient, RedisAdapterOptions } from "./RedisAdapter.js";

export { MongoAdapter } from "./MongoAdapter.js";
export type {
  MongoClient,
  MongoDatabase,
  MongoCollection,
  MongoAdapterOptions,
} from "./MongoAdapter.js";

export { PostgreSQLAdapter } from "./PostgreSQLAdapter.js";
export type {
  PgClient,
  PgQueryResult,
  PostgreSQLAdapterOptions,
} from "./PostgreSQLAdapter.js";

export { SQLiteAdapter } from "./SQLiteAdapter.js";
export type {
  SqliteDatabase,
  SqliteStatement,
  SQLiteAdapterOptions,
} from "./SQLiteAdapter.js";

export { MemoryAdapter } from "./MemoryAdapter.js";

export { OpenSearchAdapter } from "./OpenSearchAdapter.js";
export type {
  OpenSearchClient,
  OpenSearchAdapterOptions,
} from "./OpenSearchAdapter.js";
