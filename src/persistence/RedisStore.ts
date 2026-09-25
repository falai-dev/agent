/**
 * Redis Store over an ioredis-shaped client.
 *
 * One hash per session at `${keyPrefix}session:${id}` with the fields
 * `version`, `blob` (the v4 session as JSON text), `createdAt`, `updatedAt`.
 * The compare-and-swap is one Lua script, so two writers on a shared client
 * cannot interleave between the read and the write (3.x checked, then set;
 * WATCH/MULTI would not do either, since WATCH is per connection).
 */

import { SessionConflictError } from "../types/errors.js";
import type { Session, Store } from "../types/session.js";
import { readBlob, toBlob } from "./sessionRow.js";

/** Matches ioredis. node-redis users wrap `eval` to this positional form. */
export interface RedisClient {
  hgetall(key: string): Promise<Record<string, string>>;
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  quit(): Promise<string>;
}

export interface RedisStoreOptions {
  redis: RedisClient;
  /** Prefix of every key. Default `agent:`. */
  keyPrefix?: string;
  /** Seconds a session lives after its last save; `0` keeps it forever. Default 7 days. Keep it above your longest wait: an expired session loses its parked runs and claims. */
  sessionTTL?: number;
}

/**
 * KEYS[1] the session hash; ARGV: expected version, next version, blob, now, ttl.
 * Returns nil on success, the stored version on a conflict, `missing` when
 * the hash is gone.
 */
const CAS_SCRIPT = `
local current = redis.call('HGET', KEYS[1], 'version')
if ARGV[1] == '0' then
  if current then return current end
elseif current ~= ARGV[1] then
  return current or 'missing'
end
redis.call('HSET', KEYS[1], 'version', ARGV[2], 'blob', ARGV[3], 'updatedAt', ARGV[4])
redis.call('HSETNX', KEYS[1], 'createdAt', ARGV[4])
if tonumber(ARGV[5]) > 0 then redis.call('EXPIRE', KEYS[1], ARGV[5]) end
return nil
`;

export class RedisStore<D = unknown> implements Store<D> {
  private readonly redis: RedisClient;
  private readonly keyPrefix: string;
  private readonly ttl: number;

  constructor(options: RedisStoreOptions) {
    this.redis = options.redis;
    this.keyPrefix = options.keyPrefix ?? "agent:";
    this.ttl = options.sessionTTL ?? 7 * 24 * 60 * 60;
  }

  async disconnect(): Promise<void> {
    await this.redis.quit();
  }

  async load(id: string): Promise<Session<D> | null> {
    const row = await this.redis.hgetall(this.key(id));
    if (Object.keys(row).length === 0) return null;
    return readBlob<D>(row.blob, id);
  }

  async save(session: Session<D>, expectedVersion: number): Promise<Session<D>> {
    const next = expectedVersion + 1;
    const blob = toBlob(session, next);
    const result = await this.redis.eval(
      CAS_SCRIPT,
      1,
      this.key(session.id),
      String(expectedVersion),
      String(next),
      JSON.stringify(blob),
      new Date().toISOString(),
      String(this.ttl),
    );
    if (result === null || result === undefined) return blob;
    const actual = typeof result === "string" && result !== "missing" ? Number(result) : undefined;
    throw new SessionConflictError(session.id, expectedVersion, actual);
  }

  private key(id: string): string {
    return `${this.keyPrefix}session:${id}`;
  }
}
