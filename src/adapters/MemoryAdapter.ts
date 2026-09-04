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
  SessionUpdateOptions,
  CreateSessionData,
} from "../types/index.js";
import { SessionConflictError } from "../types/errors.js";
import { cloneDeep } from "../utils/clone.js";
import { createSessionId } from "../utils/index.js";

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
export class MemoryAdapter<TData = Record<string, unknown>> implements PersistenceAdapter<TData> {
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
  implements SessionRepository<TData> {
  constructor(private sessions: Map<string, SessionData<TData>>) { }

  create(data: CreateSessionData<TData>): Promise<SessionData<TData>> {
    const id =
      data.id || createSessionId();
    const now = new Date();

    const session: SessionData<TData> = {
      ...data,
      id,
      status: data.status || "active",
      messageCount: data.messageCount || 0,
      version: data.version ?? 1,
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
    data: Partial<Omit<SessionData<TData>, "id" | "createdAt">>,
    options?: SessionUpdateOptions
  ): Promise<SessionData<TData> | null> {
    const existing = this.sessions.get(id);
    if (!existing) return null;

    // Compare-and-swap: rows without a stored version (pre-2.4) are accepted
    if (
      options?.expectedVersion !== undefined &&
      existing.version !== undefined &&
      existing.version !== options.expectedVersion
    ) {
      throw new SessionConflictError(id, options.expectedVersion, existing.version);
    }

    const updated: SessionData<TData> = {
      ...existing,
      ...data,
      version: (existing.version ?? options?.expectedVersion ?? 0) + 1,
      updatedAt: new Date(),
    };

    this.sessions.set(id, cloneDeep(updated));
    return Promise.resolve(cloneDeep(updated));
  }

  // Derived updaters route through update() so every state write shares one
  // semantic across adapters: version bump + updatedAt refresh (the SQL
  // adapters delegate to their update() the same way).

  async updateStatus(
    id: string,
    status: SessionStatus,
    completedAt?: Date
  ): Promise<SessionData<TData> | null> {
    // An undefined completedAt must be omitted, not spread — update() writes
    // whatever keys it receives, and SQL skips undefined columns.
    return this.update(id, completedAt ? { status, completedAt } : { status });
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
    // Mirror SQL's conditional column assembly: only defined values are written.
    return this.update(id, {
      ...(flow !== undefined && { currentFlow: flow }),
      ...(step !== undefined && { currentStep: step }),
    });
  }

  async incrementMessageCount(id: string): Promise<SessionData<TData> | null> {
    // Bookkeeping write, deliberately NOT routed through update(): count bumps
    // run alongside saveSessionState's version CAS every turn, so they must not
    // move `version` (matches the SQL adapters' dedicated statement).
    const session = this.sessions.get(id);
    if (!session) return Promise.resolve(null);
    const updated: SessionData<TData> = {
      ...session,
      messageCount: (session.messageCount || 0) + 1,
      lastMessageAt: new Date(),
      updatedAt: new Date(),
    };
    this.sessions.set(id, cloneDeep(updated));
    return Promise.resolve(cloneDeep(updated));
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
  constructor(private messages: Map<string, MessageData>) { }

  async create(
    data: Omit<MessageData, "id" | "createdAt">
  ): Promise<MessageData> {
    const id = `msg_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const message: MessageData = {
      ...data,
      id,
      createdAt: new Date(),
    };

    // Clone on store and on return so callers can't mutate the stored row —
    // same isolation the session repository provides.
    this.messages.set(id, cloneDeep(message));
    return Promise.resolve(cloneDeep(message));
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
