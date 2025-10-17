/**
 * MongoDB adapter for persistence
 * Document-based storage with flexible schema
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
 * MongoDB collection interface - matches mongodb driver
 */
export interface MongoCollection<T = Record<string, unknown>> {
  insertOne(doc: T): Promise<{ insertedId: unknown }>;
  findOne(filter: Record<string, unknown>): Promise<T | null>;
  find(filter: Record<string, unknown>): {
    sort(sort: Record<string, number>): {
      limit(limit: number): {
        toArray(): Promise<T[]>;
      };
    };
    toArray(): Promise<T[]>;
  };
  updateOne(
    filter: Record<string, unknown>,
    update: Record<string, unknown>
  ): Promise<{ matchedCount: number }>;
  deleteOne(filter: Record<string, unknown>): Promise<{ deletedCount: number }>;
  deleteMany(
    filter: Record<string, unknown>
  ): Promise<{ deletedCount: number }>;
}

/**
 * MongoDB database interface
 */
export interface MongoDatabase {
  collection<T = Record<string, unknown>>(name: string): MongoCollection<T>;
}

/**
 * MongoDB client interface
 */
export interface MongoClient {
  db(name?: string): MongoDatabase;
  close(): Promise<void>;
}

/**
 * Options for MongoDB adapter
 */
export interface MongoAdapterOptions {
  /**
   * MongoDB client instance
   */
  client: MongoClient;

  /**
   * Database name
   */
  databaseName: string;

  /**
   * Collection names (default: "agent_sessions" and "agent_messages")
   */
  collections?: {
    sessions?: string;
    messages?: string;
  };
}

/**
 * MongoDB Adapter - Provider-style API for MongoDB persistence
 *
 * @example
 * ```typescript
 * import { MongoClient } from 'mongodb';
 * import { Agent, MongoAdapter } from '@falai/agent';
 *
 * const client = new MongoClient('mongodb://localhost:27017');
 * await client.connect();
 *
 * const agent = new Agent({
 *   name: "My Agent",
 *   provider: provider,
 *   persistence: {
 *     adapter: new MongoAdapter({
 *       client,
 *       databaseName: 'myapp',
 *     }),
 *     userId: "user_123",
 *   },
 * });
 * ```
 */
export class MongoAdapter implements PersistenceAdapter {
  public readonly sessionRepository: SessionRepository;
  public readonly messageRepository: MessageRepository;
  private client: MongoClient;
  private db: MongoDatabase;

  constructor(options: MongoAdapterOptions) {
    this.client = options.client;
    this.db = options.client.db(options.databaseName);

    const sessionCollection = options.collections?.sessions || "agent_sessions";
    const messageCollection = options.collections?.messages || "agent_messages";

    this.sessionRepository = new MongoSessionRepository(
      this.db.collection(sessionCollection)
    );

    this.messageRepository = new MongoMessageRepository(
      this.db.collection(messageCollection)
    );
  }

  async disconnect(): Promise<void> {
    await this.client.close();
  }
}

/**
 * MongoDB Session Repository
 */
class MongoSessionRepository implements SessionRepository {
  constructor(private collection: MongoCollection<SessionData>) {}

  async create(
    data: Omit<SessionData, "id" | "createdAt" | "updatedAt">
  ): Promise<SessionData> {
    const now = new Date();
    const session: SessionData = {
      ...data,
      id: `session_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      status: data.status || "active",
      messageCount: data.messageCount || 0,
      createdAt: now,
      updatedAt: now,
    };

    await this.collection.insertOne(session);
    return session;
  }

  async findById(id: string): Promise<SessionData | null> {
    return await this.collection.findOne({ id });
  }

  async findActiveByUserId(userId: string): Promise<SessionData | null> {
    return await this.collection.findOne({ userId, status: "active" });
  }

  async findByUserId(userId: string, limit = 100): Promise<SessionData[]> {
    return await this.collection
      .find({ userId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();
  }

  async update(
    id: string,
    data: Partial<Omit<SessionData, "id" | "createdAt">>
  ): Promise<SessionData | null> {
    const result = await this.collection.updateOne(
      { id },
      { $set: { ...data, updatedAt: new Date() } }
    );

    if (result.matchedCount === 0) return null;
    return await this.findById(id);
  }

  async updateStatus(
    id: string,
    status: SessionStatus,
    completedAt?: Date
  ): Promise<SessionData | null> {
    const updateData: Record<string, unknown> = {
      status,
      updatedAt: new Date(),
    };
    if (completedAt) {
      updateData.completedAt = completedAt;
    }

    const result = await this.collection.updateOne(
      { id },
      { $set: updateData }
    );

    if (result.matchedCount === 0) return null;
    return await this.findById(id);
  }

  async updateCollectedData(
    id: string,
    collectedData: Record<string, unknown>
  ): Promise<SessionData | null> {
    return await this.update(id, { collectedData });
  }

  async updateRouteStep(
    id: string,
    route?: string,
    step?: string
  ): Promise<SessionData | null> {
    return await this.update(id, {
      currentRoute: route,
      currentStep: step,
    });
  }

  async incrementMessageCount(id: string): Promise<SessionData | null> {
    const result = await this.collection.updateOne(
      { id },
      {
        $inc: { messageCount: 1 },
        $set: { lastMessageAt: new Date(), updatedAt: new Date() },
      }
    );

    if (result.matchedCount === 0) return null;
    return await this.findById(id);
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.collection.deleteOne({ id });
    return result.deletedCount > 0;
  }
}

/**
 * MongoDB Message Repository
 */
class MongoMessageRepository implements MessageRepository {
  constructor(private collection: MongoCollection<MessageData>) {}

  async create(
    data: Omit<MessageData, "id" | "createdAt">
  ): Promise<MessageData> {
    const message: MessageData = {
      ...data,
      id: `msg_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      createdAt: new Date(),
    };

    await this.collection.insertOne(message);
    return message;
  }

  async findById(id: string): Promise<MessageData | null> {
    return await this.collection.findOne({ id });
  }

  async findBySessionId(
    sessionId: string,
    limit = 1000
  ): Promise<MessageData[]> {
    return await this.collection
      .find({ sessionId })
      .sort({ createdAt: 1 })
      .limit(limit)
      .toArray();
  }

  async findByUserId(userId: string, limit = 100): Promise<MessageData[]> {
    return await this.collection
      .find({ userId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.collection.deleteOne({ id });
    return result.deletedCount > 0;
  }

  async deleteBySessionId(sessionId: string): Promise<number> {
    const result = await this.collection.deleteMany({ sessionId });
    return result.deletedCount;
  }

  async deleteByUserId(userId: string): Promise<number> {
    const result = await this.collection.deleteMany({ userId });
    return result.deletedCount;
  }
}
