/**
 * What every store writes and reads: the v4 session blob, and nothing else.
 * One place so the seven stores cannot drift on what a row means.
 * PostgreSQL hands JSONB back parsed, SQLite and Redis hand back text; both
 * arrive here.
 */

import { assertSession, InvalidSessionError } from "../core/Migrate.js";
import type { Session } from "../types/session.js";

/** The blob to persist, stamped with the version it is saved as. Optional keys are written only when set. */
export function toBlob<D>(session: Session<D>, version: number): Session<D> {
  const blob: Session<D> = {
    id: session.id,
    v: 4,
    version,
    data: session.data,
    runs: session.runs,
    claims: session.claims,
    inputs: session.inputs,
    metadata: session.metadata,
  };
  if (session.lastUserAt !== undefined) blob.lastUserAt = session.lastUserAt;
  if (session.lastAssistantAt !== undefined) blob.lastAssistantAt = session.lastAssistantAt;
  if (session.history !== undefined) blob.history = session.history;
  return blob;
}

/** A stored blob (parsed, or JSON text) back to a Session. Anything not v4-shaped throws. */
export function readBlob<D>(raw: unknown, sessionId: string): Session<D> {
  let blob: unknown = raw;
  if (typeof raw === "string") {
    try {
      blob = JSON.parse(raw);
    } catch {
      throw new InvalidSessionError(sessionId, "blob is not valid JSON");
    }
  }
  return assertSession<D>(blob, sessionId);
}

/** Runs synchronous store work as a promise, so a thrown error is a rejection like everywhere else. */
export function asPromise<T>(work: () => T): Promise<T> {
  return new Promise((resolve) => resolve(work()));
}
