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
