/**
 * Redis adapter for persistence
 * Uses Redis for fast session/message storage
 */

import type {
  SessionRepository,
  MessageRepository,
  SessionData,
  MessageData,
  SessionStatus,
  PersistenceAdapter,
} from "../types/persistence";

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
 *   ai: provider,
 *   persistence: {
 *     adapter: new RedisAdapter({ redis }),
 *     userId: "user_123",
 *   },
 * });
 * ```
 */
export class RedisAdapter implements PersistenceAdapter {
  public readonly sessionRepository: SessionRepository;
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

    this.sessionRepository = new RedisSessionRepository(
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
class RedisSessionRepository implements SessionRepository {
  constructor(
    private redis: RedisClient,
    private keyPrefix: string,
    private ttl: number
  ) {}

  private getKey(id: string): string {
    return `${this.keyPrefix}session:${id}`;
  }

  private getUserKey(userId: string): string {
    return `${this.keyPrefix}user:${userId}:sessions`;
  }

  async create(
    data: Omit<SessionData, "id" | "createdAt" | "updatedAt">
  ): Promise<SessionData> {
    const id = `session_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const now = new Date();
    const session: SessionData = {
      ...data,
      id,
      createdAt: now,
      updatedAt: now,
      status: data.status || "active",
      messageCount: data.messageCount || 0,
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

  async findById(id: string): Promise<SessionData | null> {
    const data = await this.redis.get(this.getKey(id));
    if (!data) return null;
    try {
      return JSON.parse(data) as SessionData;
    } catch (error) {
      console.error(`Error parsing session data for id ${id}:`, error);
      return null;
    }
  }

  async findActiveByUserId(userId: string): Promise<SessionData | null> {
    const sessionIds = await this.redis.hgetall(this.getUserKey(userId));

    for (const sessionId of Object.keys(sessionIds)) {
      const session = await this.findById(sessionId);
      if (session && session.status === "active") {
        return session;
      }
    }

    return null;
  }

  async findByUserId(userId: string, limit = 100): Promise<SessionData[]> {
    const sessionIds = await this.redis.hgetall(this.getUserKey(userId));
    const sessions: SessionData[] = [];

    for (const sessionId of Object.keys(sessionIds).slice(0, limit)) {
      const session = await this.findById(sessionId);
      if (session) {
        sessions.push(session);
      }
    }

    return sessions.sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime()
    );
  }

  async update(
    id: string,
    data: Partial<Omit<SessionData, "id" | "createdAt">>
  ): Promise<SessionData | null> {
    const existing = await this.findById(id);
    if (!existing) return null;

    const updated: SessionData = {
      ...existing,
      ...data,
      updatedAt: new Date(),
    };

    await this.redis.setex(this.getKey(id), this.ttl, JSON.stringify(updated));

    return updated;
  }

  async updateStatus(
    id: string,
    status: SessionStatus,
    completedAt?: Date
  ): Promise<SessionData | null> {
    return this.update(id, { status, completedAt });
  }

  async updateCollectedData(
    id: string,
    collectedData: Record<string, unknown>
  ): Promise<SessionData | null> {
    return this.update(id, { collectedData });
  }

  async updateRouteState(
    id: string,
    route?: string,
    state?: string
  ): Promise<SessionData | null> {
    return this.update(id, { currentRoute: route, currentState: state });
  }

  async incrementMessageCount(id: string): Promise<SessionData | null> {
    const session = await this.findById(id);
    if (!session) return null;

    return this.update(id, {
      messageCount: (session.messageCount || 0) + 1,
      lastMessageAt: new Date(),
    });
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.redis.del(this.getKey(id));
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
  ) {}

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
      return JSON.parse(data) as MessageData;
    } catch (error) {
      console.error(`Error parsing message data for id ${id}:`, error);
      return null;
    }
  }

  async findBySessionId(
    sessionId: string,
    limit = 1000
  ): Promise<MessageData[]> {
    const messageIds = await this.redis.hgetall(this.getSessionKey(sessionId));
    const messages: MessageData[] = [];

    for (const messageId of Object.keys(messageIds).slice(0, limit)) {
      const message = await this.findById(messageId);
      if (message) {
        messages.push(message);
      }
    }

    return messages.sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime()
    );
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
        const message: MessageData = JSON.parse(data) as MessageData;
        if (message.userId === userId) {
          messages.push(message);
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
