/**
 * PostgreSQL Store over a `pg` client or pool.
 *
 * One row per session: `id`, `version`, `blob` (the v4 session as JSONB),
 * `created_at`, `updated_at`. The compare-and-swap is the statement itself:
 * `INSERT … ON CONFLICT DO NOTHING` for a first save, `UPDATE … WHERE
 * version = $n` after; no row back means someone else got there first.
 *
 * A 3.x `agent_sessions` table has different columns. Point `tables.sessions`
 * at a fresh table; 3.x blobs move through `migrateSession` at the host's
 * choke point, not through this table.
 */

import { SessionConflictError } from "../types/errors.js";
import type { Session, Store } from "../types/session.js";
import { readBlob, toBlob } from "./sessionRow.js";

export interface PgQueryResult<T = Record<string, unknown>> {
  rows: T[];
  rowCount?: number | null;
}

/** Matches `pg`'s Client and Pool. */
export interface PgClient {
  query<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<PgQueryResult<T>>;
  end(): Promise<void>;
}

export interface PostgresStoreOptions {
  client: PgClient;
  /** Table name. Default `agent_sessions`. */
  tables?: { sessions?: string };
}

export class PostgresStore<D = unknown> implements Store<D> {
  private readonly client: PgClient;
  private readonly table: string;

  constructor(options: PostgresStoreOptions) {
    this.client = options.client;
    this.table = options.tables?.sessions ?? "agent_sessions";
  }

  /** Create the table when it is missing. */
  async initialize(): Promise<void> {
    await this.client.query(
      `CREATE TABLE IF NOT EXISTS ${this.table} (
        id VARCHAR(255) PRIMARY KEY,
        version INTEGER NOT NULL,
        blob JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
    );
  }

  async disconnect(): Promise<void> {
    await this.client.end();
  }

  async load(id: string): Promise<Session<D> | null> {
    const { rows } = await this.client.query(`SELECT blob FROM ${this.table} WHERE id = $1`, [id]);
    return rows.length > 0 ? readBlob<D>(rows[0].blob, id) : null;
  }

  async save(session: Session<D>, expectedVersion: number): Promise<Session<D>> {
    const next = expectedVersion + 1;
    const blob = toBlob(session, next);
    const json = JSON.stringify(blob);
    const { rows } =
      expectedVersion === 0
        ? await this.client.query(
            `INSERT INTO ${this.table} (id, version, blob) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING RETURNING version`,
            [session.id, next, json],
          )
        : await this.client.query(
            `UPDATE ${this.table} SET version = $2, blob = $3, updated_at = NOW() WHERE id = $1 AND version = $4 RETURNING version`,
            [session.id, next, json, expectedVersion],
          );
    if (rows.length === 0) throw new SessionConflictError(session.id, expectedVersion, await this.storedVersion(session.id));
    return blob;
  }

  private async storedVersion(id: string): Promise<number | undefined> {
    const { rows } = await this.client.query(`SELECT version FROM ${this.table} WHERE id = $1`, [id]);
    const version = rows[0]?.version;
    return typeof version === "number" ? version : undefined;
  }
}
