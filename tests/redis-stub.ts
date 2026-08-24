/**
 * In-memory Redis stub covering exactly the RedisClient surface RedisAdapter
 * uses. TTLs and persistence are intentionally ignored. Shared by the adapter
 * unit tests and the cross-adapter contract suite.
 */
import type { RedisClient } from "../src/adapters/RedisAdapter";

export function createRedisStub(): RedisClient {
  const strings = new Map<string, string>();
  const hashes = new Map<string, Map<string, string>>();

  return {
    async get(key) {
      return strings.get(key) ?? null;
    },
    async set(key, value) {
      strings.set(key, value);
      return "OK";
    },
    async setex(key, _seconds, value) {
      strings.set(key, value);
      return "OK";
    },
    async del(...keys) {
      let count = 0;
      for (const key of keys) {
        if (strings.delete(key)) count++;
      }
      return count;
    },
    async keys(pattern) {
      const prefix = pattern.replace(/\*$/, "");
      return [...strings.keys()].filter((key) => key.startsWith(prefix));
    },
    async hgetall(key) {
      return Object.fromEntries(hashes.get(key) ?? []);
    },
    async hset(key, field, value) {
      const hash = hashes.get(key) ?? new Map<string, string>();
      const isNew = !hash.has(field);
      hash.set(field, value);
      hashes.set(key, hash);
      return isNew ? 1 : 0;
    },
    async hdel(key, field) {
      return hashes.get(key)?.delete(field) ? 1 : 0;
    },
    async expire() {
      return 1;
    },
    async quit() {
      return "OK";
    },
  };
}
