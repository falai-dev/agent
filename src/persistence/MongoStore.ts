/**
 * MongoDB Store over the official driver's client.
 *
 * One document per session: `_id` (the session id), `version`, `blob`,
 * `createdAt`, `updatedAt`. A first save is `insertOne`, and the duplicate
 * key error is the conflict; later saves are `updateOne` filtered on
 * `{ _id, version }`, and `matchedCount === 0` is the conflict.
 */

import { isRecord } from "../utils/json.js";
import { SessionConflictError } from "../types/errors.js";
import type { Session, Store } from "../types/session.js";
import { readBlob, toBlob } from "./sessionRow.js";

/** Matches the mongodb driver's Collection. */
export interface MongoCollection<T = Record<string, unknown>> {
  insertOne(doc: T): Promise<unknown>;
  findOne(filter: Record<string, unknown>): Promise<T | null>;
  updateOne(filter: Record<string, unknown>, update: Record<string, unknown>): Promise<{ matchedCount: number }>;
}

export interface MongoDatabase {
  collection<T = Record<string, unknown>>(name: string): MongoCollection<T>;
}

export interface MongoClient {
  db(name?: string): MongoDatabase;
  close(): Promise<void>;
}

export interface MongoStoreOptions {
  client: MongoClient;
  databaseName: string;
  /** Collection name. Default `agent_sessions`. */
  collections?: { sessions?: string };
}

export class MongoStore<D = unknown> implements Store<D> {
  private readonly client: MongoClient;
  private readonly sessions: MongoCollection;

  constructor(options: MongoStoreOptions) {
    this.client = options.client;
    this.sessions = options.client.db(options.databaseName).collection(options.collections?.sessions ?? "agent_sessions");
  }

  async disconnect(): Promise<void> {
    await this.client.close();
  }

  async load(id: string): Promise<Session<D> | null> {
    const doc = await this.sessions.findOne({ _id: id });
    return doc ? readBlob<D>(doc.blob, id) : null;
  }

  async save(session: Session<D>, expectedVersion: number): Promise<Session<D>> {
    const next = expectedVersion + 1;
    const blob = toBlob(session, next);
    // ponytail: the blob is stored as JSON text, not a sub-document, because
    // claim keys carry channel message ids and those may contain dots, which
    // older servers reject in field names. Upgrade: a sub-document once keys
    // are escaped, for queries on runs and claims.
    const json = JSON.stringify(blob);
    const now = new Date();
    if (expectedVersion === 0) {
      try {
        await this.sessions.insertOne({ _id: session.id, version: next, blob: json, createdAt: now, updatedAt: now });
      } catch (error) {
        if (!isDuplicateKey(error)) throw error;
        throw new SessionConflictError(session.id, 0, await this.storedVersion(session.id));
      }
      return blob;
    }
    const { matchedCount } = await this.sessions.updateOne(
      { _id: session.id, version: expectedVersion },
      { $set: { version: next, blob: json, updatedAt: now } },
    );
    if (matchedCount === 0) throw new SessionConflictError(session.id, expectedVersion, await this.storedVersion(session.id));
    return blob;
  }

  private async storedVersion(id: string): Promise<number | undefined> {
    const doc = await this.sessions.findOne({ _id: id });
    return typeof doc?.version === "number" ? doc.version : undefined;
  }
}

/** The driver's `MongoServerError` for a unique index hit. */
const isDuplicateKey = (error: unknown): boolean => isRecord(error) && error.code === 11000;
