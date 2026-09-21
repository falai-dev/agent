/**
 * In-memory Redis stub covering exactly the RedisClient surface RedisStore
 * uses. TTLs are ignored. The stub cannot run Lua, so `eval` re-implements
 * the store's CAS script, decision for decision, on the same hash fields.
 */
import type { RedisClient } from "../src/persistence/RedisStore.js";

export interface RedisStub extends RedisClient {
  /** The raw hashes, for tests that corrupt a row behind the store's back. */
  hashes: Map<string, Map<string, string>>;
  /** Every `eval` call's args, for shape assertions. */
  evals: Array<{ script: string; numKeys: number; args: string[] }>;
}

export function createRedisStub(): RedisStub {
  const hashes = new Map<string, Map<string, string>>();
  const evals: RedisStub["evals"] = [];

  return {
    hashes,
    evals,
    async hgetall(key) {
      return Object.fromEntries(hashes.get(key) ?? []);
    },
    async eval(script, numKeys, ...rawArgs) {
      const args = rawArgs.map(String);
      evals.push({ script, numKeys, args });
      const [key, expected, next, blob, now] = args;
      const hash = hashes.get(key);
      const current = hash?.get("version");
      if (expected === "0") {
        if (current !== undefined) return current;
      } else if (current !== expected) {
        return current ?? "missing";
      }
      const row = hash ?? new Map<string, string>();
      row.set("version", next);
      row.set("blob", blob);
      row.set("updatedAt", now);
      if (!row.has("createdAt")) row.set("createdAt", now);
      hashes.set(key, row);
      return null;
    },
    async quit() {
      return "OK";
    },
  };
}
