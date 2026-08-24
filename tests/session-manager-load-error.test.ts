/**
 * SessionManager.getOrCreate must distinguish "session not found" (null →
 * create a new row) from "load FAILED" (throw → propagate). Regression test
 * for the swallow-all catch that saved a blank session over the existing row
 * after any transient DB error, erasing the user's conversation.
 */
import { describe, expect, test } from "bun:test";

import { SessionManager } from "../src/core/SessionManager";
import type { PersistenceManager } from "../src/core/PersistenceManager";
import type { SessionState } from "../src/types/session";

describe("SessionManager.getOrCreate load-error handling", () => {
  test("a failed load THROWS instead of clobbering the session", async () => {
    let saves = 0;
    // Stub PersistenceManager: load always fails; save must never run.
    const failing = {
      async loadSessionState(): Promise<SessionState<Record<string, unknown>> | null> {
        throw new Error("db down");
      },
      async saveSessionState(): Promise<void> {
        saves++;
      },
    };

    const manager = new SessionManager(
      failing as unknown as PersistenceManager<Record<string, unknown>>
    );

    await expect(manager.getOrCreate("sess_existing")).rejects.toThrow("db down");
    expect(saves).toBe(0); // the blank-session overwrite can no longer happen
  });

  test("a missing session (null) still falls through to create + save", async () => {
    const savedIds: string[] = [];
    const empty = {
      async loadSessionState(): Promise<SessionState<Record<string, unknown>> | null> {
        return null;
      },
      async saveSessionState(id: string): Promise<void> {
        savedIds.push(id);
      },
    };

    const manager = new SessionManager(
      empty as unknown as PersistenceManager<Record<string, unknown>>
    );

    const session = await manager.getOrCreate("sess_new");
    expect(session.id).toBe("sess_new");
    expect(savedIds).toEqual(["sess_new"]);
  });

  test("concurrent getOrCreate calls for one id are coalesced into ONE load", async () => {
    let loads = 0;
    // Slow-ish load so both calls genuinely overlap.
    const counting = {
      async loadSessionState(): Promise<SessionState<Record<string, unknown>> | null> {
        loads++;
        await new Promise((r) => setTimeout(r, 5));
        return null;
      },
      async saveSessionState(): Promise<void> {},
    };

    const manager = new SessionManager(
      counting as unknown as PersistenceManager<Record<string, unknown>>
    );

    const [a, b] = await Promise.all([
      manager.getOrCreate("sess_race"),
      manager.getOrCreate("sess_race"),
    ]);

    expect(loads).toBe(1);
    expect(a).toBe(b); // same object — no competing sessions
  });
});
