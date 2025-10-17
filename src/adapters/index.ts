/**
 * Database adapters for persistence
 */

export { PrismaAdapter } from "./PrismaAdapter";
export type {
  PrismaClient,
  FieldMappings,
  PrismaAdapterOptions,
} from "./PrismaAdapter";

export { RedisAdapter } from "./RedisAdapter";
export type { RedisClient, RedisAdapterOptions } from "./RedisAdapter";

export { MongoAdapter } from "./MongoAdapter";
export type {
  MongoClient,
  MongoDatabase,
  MongoCollection,
  MongoAdapterOptions,
} from "./MongoAdapter";

export { PostgreSQLAdapter } from "./PostgreSQLAdapter";
export type {
  PgClient,
  PgQueryResult,
  PostgreSQLAdapterOptions,
} from "./PostgreSQLAdapter";

export { SQLiteAdapter } from "./SQLiteAdapter";
export type {
  SqliteDatabase,
  SqliteStepment,
  SQLiteAdapterOptions,
} from "./SQLiteAdapter";

export { MemoryAdapter } from "./MemoryAdapter";

export { OpenSearchAdapter } from "./OpenSearchAdapter";
export type {
  OpenSearchClient,
  OpenSearchAdapterOptions,
} from "./OpenSearchAdapter";
