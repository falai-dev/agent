/**
 * Memory adapter for persistence
 * In-memory storage for testing and development (no database required)
 */

import type {
  CollectedStateData,
  MessageData,
  MessageRepository,
  PersistenceAdapter,
  SessionData,
  SessionRepository,
  SessionStatus,
  CreateSessionData,
} from "../types";
import { cloneDeep } from "../utils/clone";

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
 *   provider: provider,
 *   persistence: {
 *     adapter: new MemoryAdapter(),
 *     userId: "user_123",
 *   },
 * });
 * ```
 */
export class MemoryAdapter<TData = Record<string, unknown>>
  implements PersistenceAdapter<TData>
{
  public readonly sessionRepository: SessionRepository<TData>;
  public readonly messageRepository: MessageRepository;
  private sessions: Map<string, SessionData<TData>>;
  private messages: Map<string, MessageData>;

  constructor() {
    this.sessions = new Map();
    this.messages = new Map();

    this.sessionRepository = new MemorySessionRepository<TData>(this.sessions);
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
    sessions: SessionData<TData>[];
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
class MemorySessionRepository<TData = Record<string, unknown>>
  implements SessionRepository<TData>
{
  constructor(private sessions: Map<string, SessionData<TData>>) {}

  create(data: CreateSessionData<TData>): Promise<SessionData<TData>> {
    const id =
      data.id || `session_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const now = new Date();

    const session: SessionData<TData> = {
      ...data,
      id,
      status: data.status || "active",
      messageCount: data.messageCount || 0,
      createdAt: now,
      updatedAt: now,
    };

    this.sessions.set(id, cloneDeep(session));
    return Promise.resolve(cloneDeep(session));
  }

  findById(id: string): Promise<SessionData<TData> | null> {
    const session = this.sessions.get(id);
    return Promise.resolve(session ? cloneDeep(session) : null);
  }

  async findActiveByUserId(userId: string): Promise<SessionData<TData> | null> {
    const sessions = Array.from(this.sessions.values())
      .filter((s) => s.userId === userId && s.status === "active")
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    return Promise.resolve(sessions[0] || null);
  }

  async findByUserId(
    userId: string,
    limit = 100
  ): Promise<SessionData<TData>[]> {
    const sessions = Array.from(this.sessions.values())
      .filter((s) => s.userId === userId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
    return Promise.resolve(sessions);
  }

  async update(
    id: string,
    data: Partial<Omit<SessionData<TData>, "id" | "createdAt">>
  ): Promise<SessionData<TData> | null> {
    const existing = this.sessions.get(id);
    if (!existing) return null;

    const updated: SessionData<TData> = {
      ...existing,
      ...data,
      updatedAt: new Date(),
    };

    this.sessions.set(id, cloneDeep(updated));
    return Promise.resolve(cloneDeep(updated));
  }

  async updateStatus(
    id: string,
    status: SessionStatus,
    completedAt?: Date
  ): Promise<SessionData<TData> | null> {
    const session = this.sessions.get(id);
    if (session) {
      session.status = status;
      if (completedAt) {
        session.completedAt = completedAt;
      }
      this.sessions.set(id, cloneDeep(session));
      return Promise.resolve(cloneDeep(session));
    }
    return Promise.resolve(null);
  }

  async updateCollectedData(
    id: string,
    collectedData: CollectedStateData<TData>
  ): Promise<SessionData<TData> | null> {
    const session = this.sessions.get(id);
    if (session) {
      session.collectedData = collectedData;
      this.sessions.set(id, cloneDeep(session));
      return Promise.resolve(cloneDeep(session));
    }
    return Promise.resolve(null);
  }

  async updateRouteStep(
    id: string,
    route?: string,
    step?: string
  ): Promise<SessionData<TData> | null> {
    const session = this.sessions.get(id);
    if (session) {
      session.currentRoute = route;
      session.currentStep = step;
      this.sessions.set(id, cloneDeep(session));
      return Promise.resolve(cloneDeep(session));
    }
    return Promise.resolve(null);
  }

  async incrementMessageCount(id: string): Promise<SessionData<TData> | null> {
    const session = this.sessions.get(id);
    if (session) {
      session.messageCount = (session.messageCount || 0) + 1;
      this.sessions.set(id, cloneDeep(session));
      return Promise.resolve(cloneDeep(session));
    }
    return Promise.resolve(null);
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
