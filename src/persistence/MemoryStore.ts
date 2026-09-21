/**
 * In-memory Store: tests, the playground, prototypes. Nothing survives the
 * process. Rows are kept as JSON text and read back through the same check
 * every other store runs, so a session round-trips here exactly as it would
 * through PostgreSQL or Redis: Dates come back as text, `undefined` drops.
 */

import { SessionConflictError } from "../types/errors.js";
import type { Session, Store } from "../types/session.js";
import { asPromise, readBlob, toBlob } from "./sessionRow.js";

export class MemoryStore<D = unknown> implements Store<D> {
  private readonly rows = new Map<string, { version: number; blob: string }>();

  load(id: string): Promise<Session<D> | null> {
    return asPromise(() => {
      const row = this.rows.get(id);
      return row ? readBlob<D>(row.blob, id) : null;
    });
  }

  save(session: Session<D>, expectedVersion: number): Promise<Session<D>> {
    return asPromise(() => {
      const current = this.rows.get(session.id);
      const conflict = expectedVersion === 0 ? current !== undefined : current?.version !== expectedVersion;
      if (conflict) throw new SessionConflictError(session.id, expectedVersion, current?.version);
      const blob = toBlob(session, expectedVersion + 1);
      this.rows.set(session.id, { version: blob.version, blob: JSON.stringify(blob) });
      return blob;
    });
  }

  /** Drop every session. */
  clear(): void {
    this.rows.clear();
  }
}
