/**
 * SQLite Store over a better-sqlite3-shaped database (bun:sqlite fits too).
 *
 * One row per session: `id`, `version`, `blob` (the v4 session as JSON text),
 * `created_at`, `updated_at`. The compare-and-swap is the statement itself:
 * `INSERT OR IGNORE` for a first save, `UPDATE … WHERE version = ?` after,
 * and `changes === 0` means someone else got there first.
 *
 * A 3.x `agent_sessions` table has different columns. Point `tables.sessions`
 * at a fresh table; 3.x blobs move through `migrateSession` at the host's
 * choke point, not through this table.
 */

import { SessionConflictError } from "../types/errors.js";
import type { Session, Store } from "../types/session.js";
import { asPromise, readBlob, toBlob } from "./sessionRow.js";

/** Matches better-sqlite3 and bun:sqlite statements. */
export interface SqliteStatement {
  run(...params: unknown[]): { changes: number };
  get(...params: unknown[]): unknown;
}

/** Matches better-sqlite3 and bun:sqlite databases. */
export interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): unknown;
  close(): void;
}

export interface SQLiteStoreOptions {
  db: SqliteDatabase;
  /** Table name. Default `agent_sessions`. */
  tables?: { sessions?: string };
}

export class SQLiteStore<D = unknown> implements Store<D> {
  private readonly db: SqliteDatabase;
  private readonly table: string;

  constructor(options: SQLiteStoreOptions) {
    this.db = options.db;
    this.table = options.tables?.sessions ?? "agent_sessions";
  }

  /** Create the table when it is missing. */
  initialize(): Promise<void> {
    return asPromise(() => {
      this.db.exec(
        `CREATE TABLE IF NOT EXISTS ${this.table} (
          id TEXT PRIMARY KEY,
          version INTEGER NOT NULL,
          blob TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )`,
      );
    });
  }

  disconnect(): Promise<void> {
    return asPromise(() => this.db.close());
  }

  load(id: string): Promise<Session<D> | null> {
    return asPromise(() => {
      const row = this.db.prepare(`SELECT blob FROM ${this.table} WHERE id = ?`).get(id);
      if (row === undefined || row === null) return null;
      return readBlob<D>(column(row, "blob"), id);
    });
  }

  save(session: Session<D>, expectedVersion: number): Promise<Session<D>> {
    return asPromise(() => {
      const next = expectedVersion + 1;
      const blob = toBlob(session, next);
      const json = JSON.stringify(blob);
      const now = new Date().toISOString();
      const result =
        expectedVersion === 0
          ? this.db
              .prepare(
                `INSERT OR IGNORE INTO ${this.table} (id, version, blob, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
              )
              .run(session.id, next, json, now, now)
          : this.db
              .prepare(`UPDATE ${this.table} SET version = ?, blob = ?, updated_at = ? WHERE id = ? AND version = ?`)
              .run(next, json, now, session.id, expectedVersion);
      if (result.changes === 0) throw new SessionConflictError(session.id, expectedVersion, this.storedVersion(session.id));
      return blob;
    });
  }

  private storedVersion(id: string): number | undefined {
    const row = this.db.prepare(`SELECT version FROM ${this.table} WHERE id = ?`).get(id);
    const version = row === undefined || row === null ? undefined : column(row, "version");
    return typeof version === "number" ? version : undefined;
  }
}

function column(row: unknown, name: string): unknown {
  return typeof row === "object" && row !== null && name in row ? (row as Record<string, unknown>)[name] : undefined;
}
