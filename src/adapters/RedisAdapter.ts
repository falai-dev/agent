/**
 * Redis adapter for persistence
 * Uses Redis for fast session/message storage
 */

import type {
  MessageData,
  MessageRepository,
  PersistenceAdapter,
  SessionData,
  SessionRepository,
  SessionStatus,
  CollectedStateData,
  SessionUpdateOptions,
} from "../types";
import { SessionConflictError } from "../types/errors";
import { createSessionId, logger } from "../utils";

/**
 * Coerce a stored value into a Date. JSON round-trips turn Date fields into
 * ISO strings — same pattern as PostgreSQLAdapter.toDate.
 */
function toDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(value as string);
}

/**
 * Redis client interface - matches ioredis/redis clients
 */
export interface RedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<string | null>;
  setex(key: string, seconds: number, value: string): Promise<string>;
  del(...keys: string[]): Promise<number>;
  keys(pattern: string): Promise<string[]>;
  hgetall(key: string): Promise<Record<string, string>>;
  hset(key: string, field: string, value: string): Promise<number>;
  hdel(key: string, field: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  quit(): Promise<string>;
}

/**
 * Options for Redis adapter
 */
export interface RedisAdapterOptions {
  /**
   * Redis client instance (ioredis or node-redis)
   */
  redis: RedisClient;

  /**
   * Key prefix for all keys (default: "agent:")
   */
  keyPrefix?: string;

  /**
   * TTL in seconds for sessions (default: 7 days)
   */
  sessionTTL?: number;

  /**
   * TTL in seconds for messages (default: 30 days)
   */
  messageTTL?: number;
}

/**
 * Redis Adapter - Provider-style API for Redis persistence
 *
 * @example
 * ```typescript
 * import Redis from 'ioredis';
 * import { Agent, RedisAdapter } from '@falai/agent';
 *
 * const redis = new Redis();
 *
 * const agent = new Agent({
 *   name: "My Agent",
 *   provider: provider,
 *   persistence: {
 *     adapter: new RedisAdapter({ redis }),
 *     userId: "user_123",
 *   },
 * });
 * ```
 */
export class RedisAdapter<TData = Record<string, unknown>> implements PersistenceAdapter<TData> {
  public readonly sessionRepository: SessionRepository<TData>;
  public readonly messageRepository: MessageRepository;
  private redis: RedisClient;
  private keyPrefix: string;
  private sessionTTL: number;
  private messageTTL: number;

  constructor(options: RedisAdapterOptions) {
    this.redis = options.redis;
    this.keyPrefix = options.keyPrefix || "agent:";
    this.sessionTTL = options.sessionTTL || 7 * 24 * 60 * 60; // 7 days
    this.messageTTL = options.messageTTL || 30 * 24 * 60 * 60; // 30 days

    this.sessionRepository = new RedisSessionRepository<TData>(
      this.redis,
      this.keyPrefix,
      this.sessionTTL
    );

    this.messageRepository = new RedisMessageRepository(
      this.redis,
      this.keyPrefix,
      this.messageTTL
    );
  }

  async disconnect(): Promise<void> {
    await this.redis.quit();
  }
}

/**
 * Redis Session Repository
 */
class RedisSessionRepository<TData = Record<string, unknown>>
  implements SessionRepository<TData> {
  constructor(
    private redis: RedisClient,
    private keyPrefix: string,
    private ttl: number
  ) { }

  private getKey(id: string): string {
    return `${this.keyPrefix}session:${id}`;
  }

  private getUserKey(userId: string): string {
    return `${this.keyPrefix}user:${userId}:sessions`;
  }

  async create(
    data: Omit<SessionData<TData>, "createdAt" | "updatedAt"> & {
      id?: string;
    }
  ): Promise<SessionData<TData>> {
    const id = data.id || createSessionId();
    const now = new Date();
    const session: SessionData<TData> = {
      ...data,
      id,
      createdAt: now,
      updatedAt: now,
      status: data.status || "active",
      messageCount: data.messageCount || 0,
      version: data.version ?? 1,
    };

    await this.redis.setex(this.getKey(id), this.ttl, JSON.stringify(session));

    // Add to user's session list
    if (data.userId) {
      await this.redis.hset(
        this.getUserKey(data.userId),
        id,
        now.toISOString()
      );
    }

    return session;
  }

  async findById(id: string): Promise<SessionData<TData> | null> {
    const data = await this.redis.get(this.getKey(id));
    if (!data) return null;
    try {
      return JSON.parse(data) as SessionData<TData>;
    } catch (error) {
      logger.error(`Error parsing session data for id ${id}:`, error);
      return null;
    }
  }

  async findActiveByUserId(userId: string): Promise<SessionData<TData> | null> {
    const sessionIds = await this.redis.hgetall(this.getUserKey(userId));

    for (const sessionId of Object.keys(sessionIds)) {
      const session = await this.findById(sessionId);
      if (session && session.status === "active") {
        return session;
      }
    }

    return null;
  }

  async findByUserId(
    userId: string,
    limit = 100
  ): Promise<SessionData<TData>[]> {
    const sessionIds = await this.redis.hgetall(this.getUserKey(userId));
    const sessions: SessionData<TData>[] = [];

    for (const sessionId of Object.keys(sessionIds).slice(0, limit)) {
      const session = await this.findById(sessionId);
      if (session) {
        sessions.push(session);
      }
    }

    return sessions.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }

  async update(
    id: string,
    data: Partial<Omit<SessionData<TData>, "id" | "createdAt">>,
    options?: SessionUpdateOptions
  ): Promise<SessionData<TData> | null> {
    const existing = await this.findById(id);
    if (!existing) return null;

    // Check-then-set on the stored JSON — not fully atomic (no WATCH/MULTI)
    if (
      options?.expectedVersion !== undefined &&
      existing.version !== undefined &&
      existing.version !== options.expectedVersion
    ) {
      throw new SessionConflictError(
        id,
        options.expectedVersion,
        existing.version
      );
    }

    const updated: SessionData<TData> = {
      ...existing,
      ...data,
      version: (existing.version ?? options?.expectedVersion ?? 0) + 1,
      updatedAt: new Date(),
    };

    await this.redis.setex(this.getKey(id), this.ttl, JSON.stringify(updated));

    return updated;
  }

  async updateStatus(
    id: string,
    status: SessionStatus,
    completedAt?: Date
  ): Promise<SessionData<TData> | null> {
    return this.update(id, { status, completedAt });
  }

  async updateCollectedData(
    id: string,
    collectedData: CollectedStateData<TData>
  ): Promise<SessionData<TData> | null> {
    return this.update(id, { collectedData });
  }

  async updateFlowStep(
    id: string,
    flow?: string,
    step?: string
  ): Promise<SessionData<TData> | null> {
    return this.update(id, { currentFlow: flow, currentStep: step });
  }

  async incrementMessageCount(id: string): Promise<SessionData<TData> | null> {
    const session = await this.findById(id);
    if (!session) return null;

    return this.update(id, {
      messageCount: (session.messageCount || 0) + 1,
      lastMessageAt: new Date(),
    });
  }

  async delete(id: string): Promise<boolean> {
    // Look up first so the user index can be cleaned too — otherwise
    // findActiveByUserId/findByUserId chase dead ids forever.
    const existing = await this.findById(id);
    if (!existing) return false;

    const result = await this.redis.del(this.getKey(id));
    if (existing.userId) {
      await this.redis.hdel(this.getUserKey(existing.userId), id);
    }
    return result > 0;
  }
}

/**
 * Redis Message Repository
 */
class RedisMessageRepository implements MessageRepository {
  constructor(
    private redis: RedisClient,
    private keyPrefix: string,
    private ttl: number
  ) { }

  private getKey(id: string): string {
    return `${this.keyPrefix}message:${id}`;
  }

  private getSessionKey(sessionId: string): string {
    return `${this.keyPrefix}session:${sessionId}:messages`;
  }

  async create(
    data: Omit<MessageData, "id" | "createdAt">
  ): Promise<MessageData> {
    const id = `msg_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const message: MessageData = {
      ...data,
      id,
      createdAt: new Date(),
    };

    await this.redis.setex(this.getKey(id), this.ttl, JSON.stringify(message));
    await this.redis.hset(
      this.getSessionKey(data.sessionId),
      id,
      message.createdAt.toISOString()
    );

    return message;
  }

  async findById(id: string): Promise<MessageData | null> {
    const data = await this.redis.get(this.getKey(id));
    if (!data) return null;
    try {
      const message = JSON.parse(data) as MessageData;
      return { ...message, createdAt: toDate(message.createdAt) };
    } catch (error) {
      logger.error(`Error parsing message data for id ${id}:`, error);
      return null;
    }
  }

  async findBySessionId(
    sessionId: string,
    limit = 1000
  ): Promise<MessageData[]> {
    const messageIds = await this.redis.hgetall(this.getSessionKey(sessionId));
    const messages: MessageData[] = [];

    // Fetch ALL candidates first — limiting before sorting would keep an
    // arbitrary hash-order subset instead of the oldest messages.
    for (const messageId of Object.keys(messageIds)) {
      const message = await this.findById(messageId);
      if (message) {
        messages.push(message);
      }
    }

    // Chronological order (matches PostgreSQL/Mongo adapters); limit applies
    // only after sorting is meaningful.
    return messages
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .slice(0, limit);
  }

  async findByUserId(userId: string, limit = 100): Promise<MessageData[]> {
    // Redis doesn't have efficient user-level querying
    // This would require additional indexing
    const pattern = `${this.keyPrefix}message:*`;
    const keys = await this.redis.keys(pattern);
    const messages: MessageData[] = [];

    for (const key of keys.slice(0, limit)) {
      const data = await this.redis.get(key);
      if (data) {
        const parsed: MessageData = JSON.parse(data);
        if (parsed.userId === userId) {
          messages.push({ ...parsed, createdAt: toDate(parsed.createdAt) });
        }
      }
    }

    return messages.sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime()
    );
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.redis.del(this.getKey(id));
    return result > 0;
  }

  async deleteBySessionId(sessionId: string): Promise<number> {
    const messageIds = await this.redis.hgetall(this.getSessionKey(sessionId));
    const keys = Object.keys(messageIds).map((id) => this.getKey(id));

    if (keys.length === 0) return 0;

    const result = await this.redis.del(...keys);
    await this.redis.del(this.getSessionKey(sessionId));

    return result;
  }

  async deleteByUserId(userId: string): Promise<number> {
    const messages = await this.findByUserId(userId);
    const keys = messages.map((m) => this.getKey(m.id));

    if (keys.length === 0) return 0;

    return await this.redis.del(...keys);
  }
}
