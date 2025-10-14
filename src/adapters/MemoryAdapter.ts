/**
 * Memory adapter for persistence
 * In-memory storage for testing and development (no database required)
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
 * Memory Adapter - Provider-style API for in-memory persistence
 *
 * Perfect for:
 * - Testing
 * - Development
 * - Prototyping
 * - No database setup required
 *
 * @example
 * ```typescript
 * import { Agent, MemoryAdapter } from '@falai/agent';
 *
 * const agent = new Agent({
 *   name: "My Agent",
 *   ai: provider,
 *   persistence: {
 *     adapter: new MemoryAdapter(),
 *     userId: "user_123",
 *   },
 * });
 * ```
 */
export class MemoryAdapter implements PersistenceAdapter {
  public readonly sessionRepository: SessionRepository;
  public readonly messageRepository: MessageRepository;
  private sessions: Map<string, SessionData>;
  private messages: Map<string, MessageData>;

  constructor() {
    this.sessions = new Map();
    this.messages = new Map();

    this.sessionRepository = new MemorySessionRepository(this.sessions);
    this.messageRepository = new MemoryMessageRepository(this.messages);
  }

  /**
   * Clear all data (useful for testing)
   */
  clear(): void {
    this.sessions.clear();
    this.messages.clear();
  }

  /**
   * Get data snapshot (useful for debugging)
   */
  getSnapshot(): {
    sessions: SessionData[];
    messages: MessageData[];
  } {
    return {
      sessions: Array.from(this.sessions.values()),
      messages: Array.from(this.messages.values()),
    };
  }
}

/**
 * Memory Session Repository
 */
class MemorySessionRepository implements SessionRepository {
  constructor(private sessions: Map<string, SessionData>) {}

  async create(
    data: Omit<SessionData, "id" | "createdAt" | "updatedAt">
  ): Promise<SessionData> {
    const id = `session_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const now = new Date();

    const session: SessionData = {
      ...data,
      id,
      status: data.status || "active",
      messageCount: data.messageCount || 0,
      createdAt: now,
      updatedAt: now,
    };

    this.sessions.set(id, session);
    return Promise.resolve(session);
  }

  async findById(id: string): Promise<SessionData | null> {
    const session = this.sessions.get(id) || null;
    return Promise.resolve(session);
  }

  async findActiveByUserId(userId: string): Promise<SessionData | null> {
    const sessions = Array.from(this.sessions.values())
      .filter((s) => s.userId === userId && s.status === "active")
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    return Promise.resolve(sessions[0] || null);
  }

  async findByUserId(userId: string, limit = 100): Promise<SessionData[]> {
    const sessions = Array.from(this.sessions.values())
      .filter((s) => s.userId === userId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
    return Promise.resolve(sessions);
  }

  async update(
    id: string,
    data: Partial<Omit<SessionData, "id" | "createdAt">>
  ): Promise<SessionData | null> {
    const existing = this.sessions.get(id);
    if (!existing) return null;

    const updated: SessionData = {
      ...existing,
      ...data,
      updatedAt: new Date(),
    };

    this.sessions.set(id, updated);
    return Promise.resolve(updated);
  }

  async updateStatus(
    id: string,
    status: SessionStatus,
    completedAt?: Date
  ): Promise<SessionData | null> {
    return await this.update(id, { status, completedAt });
  }

  async updateCollectedData(
    id: string,
    collectedData: Record<string, unknown>
  ): Promise<SessionData | null> {
    return await this.update(id, { collectedData });
  }

  async updateRouteState(
    id: string,
    route?: string,
    state?: string
  ): Promise<SessionData | null> {
    return await this.update(id, {
      currentRoute: route,
      currentState: state,
    });
  }

  async incrementMessageCount(id: string): Promise<SessionData | null> {
    const session = this.sessions.get(id);
    if (!session) return null;

    return await this.update(id, {
      messageCount: (session.messageCount || 0) + 1,
      lastMessageAt: new Date(),
    });
  }

  async delete(id: string): Promise<boolean> {
    const result = this.sessions.delete(id);
    return Promise.resolve(result);
  }
}

/**
 * Memory Message Repository
 */
class MemoryMessageRepository implements MessageRepository {
  constructor(private messages: Map<string, MessageData>) {}

  async create(
    data: Omit<MessageData, "id" | "createdAt">
  ): Promise<MessageData> {
    const id = `msg_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const message: MessageData = {
      ...data,
      id,
      createdAt: new Date(),
    };

    this.messages.set(id, message);
    return Promise.resolve(message);
  }

  async findById(id: string): Promise<MessageData | null> {
    const message = this.messages.get(id) || null;
    return Promise.resolve(message);
  }

  async findBySessionId(
    sessionId: string,
    limit = 1000
  ): Promise<MessageData[]> {
    const messages = Array.from(this.messages.values())
      .filter((m) => m.sessionId === sessionId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .slice(0, limit);
    return Promise.resolve(messages);
  }

  async findByUserId(userId: string, limit = 100): Promise<MessageData[]> {
    const messages = Array.from(this.messages.values())
      .filter((m) => m.userId === userId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
    return Promise.resolve(messages);
  }

  async delete(id: string): Promise<boolean> {
    const result = this.messages.delete(id);
    return Promise.resolve(result);
  }

  async deleteBySessionId(sessionId: string): Promise<number> {
    const toDelete = Array.from(this.messages.values()).filter(
      (m) => m.sessionId === sessionId
    );

    toDelete.forEach((m) => this.messages.delete(m.id));
    return Promise.resolve(toDelete.length);
  }

  async deleteByUserId(userId: string): Promise<number> {
    const toDelete = Array.from(this.messages.values()).filter(
      (m) => m.userId === userId
    );

    toDelete.forEach((m) => this.messages.delete(m.id));
    return Promise.resolve(toDelete.length);
  }
}
