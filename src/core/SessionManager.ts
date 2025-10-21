/**
 * SessionManager - Simplified session management with history
 *
 * Provides a clean, pragmatic API for managing sessions and conversation history
 * in both server and client environments.
 */

import type { SessionState } from "../types/session";
import type { History, HistoryItem } from "../types/history";
import { PersistenceManager } from "./PersistenceManager";
import type { PersistenceAdapter } from "../types/persistence";
import type { Agent } from "./Agent";

/**
 * SessionManager handles session lifecycle and conversation history
 */
export class SessionManager<TData = unknown> {
  private currentSession?: SessionState<TData>;
  private persistenceManager?: PersistenceManager<TData>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private agent?: Agent<any, TData>;
  private defaultSessionId?: string;

  constructor(
    persistenceManagerOrAdapter?:
      | PersistenceManager<TData>
      | PersistenceAdapter<TData>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    agent?: Agent<any, TData>
  ) {
    if (persistenceManagerOrAdapter) {
      // Check if it's a PersistenceManager or an adapter
      if ("saveSessionState" in persistenceManagerOrAdapter) {
        this.persistenceManager = persistenceManagerOrAdapter;
      } else {
        // It's an adapter, create a PersistenceManager
        this.persistenceManager = new PersistenceManager({
          adapter: persistenceManagerOrAdapter,
        });
      }
    }

    this.agent = agent;
  }

  /**
   * Set the default session ID to use when getOrCreate is called without parameters
   * @internal Used by Agent to set the sessionId from constructor options
   */
  setDefaultSessionId(sessionId: string): void {
    this.defaultSessionId = sessionId;
  }

  /**
   * Core method: getOrCreate handles both existing and new sessions
   * Works for sessionIds that exist, don't exist, or auto-generated IDs
   */
  async getOrCreate(sessionId?: string): Promise<SessionState<TData>> {
    // Use provided sessionId or fall back to default
    const effectiveSessionId = sessionId || this.defaultSessionId;

    // If we already have a session and no sessionId specified, return it
    if (this.currentSession && !effectiveSessionId) {
      return this.currentSession;
    }

    // If we have a session with the same ID, return it
    if (this.currentSession && this.currentSession.id === effectiveSessionId) {
      return this.currentSession;
    }

    // If sessionId provided, try to load it first
    if (effectiveSessionId && this.persistenceManager) {
      try {
        const session = await this.persistenceManager.loadSessionState(
          effectiveSessionId
        );
        if (session) {
          this.currentSession = session;
          return session;
        }
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
      } catch (_error) {
        // Session doesn't exist, will create new one with this ID
      }
    }

    // Create new session (with provided ID or auto-generated)
    return this.create(effectiveSessionId);
  }

  /**
   * Create a new session with optional custom ID
   */
  private async create(sessionId?: string): Promise<SessionState<TData>> {
    const id =
      sessionId ||
      `session_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    const session: SessionState<TData> = {
      id,
      data: {} as Partial<TData>, // Agent-level data structure
      routeHistory: [],
      history: [], // Session manages its own history
      metadata: {
        createdAt: new Date(),
        lastUpdatedAt: new Date(),
      },
    };

    this.currentSession = session;

    // Save to persistence if available
    if (this.persistenceManager) {
      await this.persistenceManager.saveSessionState(session.id, session);
    }

    return session;
  }

  /**
   * Add a message to the session history
   */
  async addMessage(
    role: "user" | "assistant",
    content: string,
    name?: string
  ): Promise<void> {
    const session = await this.getOrCreate();

    if (!session.history) {
      session.history = [];
    }

    const historyItem: HistoryItem = {
      role,
      content,
      ...(name && { name }),
    };

    session.history.push(historyItem);
    session.metadata!.lastUpdatedAt = new Date();

    // Ensure currentSession is updated
    this.currentSession = session;

    // Auto-save to persistence
    await this.save();
  }

  /**
   * Get the current conversation history
   */
  getHistory(): History {
    return this.currentSession?.history || [];
  }

  /**
   * Set the entire conversation history
   */
  setHistory(history: History): void {
    if (this.currentSession) {
      this.currentSession.history = history ? [...history] : [];
      this.currentSession.metadata!.lastUpdatedAt = new Date();
    }
  }

  /**
   * Clear all conversation history
   */
  clearHistory(): void {
    if (this.currentSession) {
      this.currentSession.history = [];
      this.currentSession.metadata!.lastUpdatedAt = new Date();
    }
  }

  /**
   * Save the current session to persistence
   */
  async save(): Promise<void> {
    if (this.currentSession && this.persistenceManager) {
      await this.persistenceManager.saveSessionState(
        this.currentSession.id,
        this.currentSession
      );
    }
  }

  /**
   * Delete the current session from persistence
   */
  async delete(): Promise<void> {
    if (this.currentSession && this.persistenceManager) {
      await this.persistenceManager.deleteSession(this.currentSession.id);
      this.currentSession = undefined;
    }
  }

  /**
   * Get the current session
   */
  get current(): SessionState<TData> | undefined {
    return this.currentSession;
  }

  /**
   * Get the current session ID
   */
  get id(): string | undefined {
    return this.currentSession?.id;
  }

  /**
   * Get agent-level collected data from the current session
   */
  getData(): Partial<TData> {
    return this.currentSession?.data || ({} as Partial<TData>);
  }

  /**
   * Set/merge agent-level data into the current session
   * This updates the single source of truth for all collected data
   */
  async setData(data: Partial<TData>): Promise<void> {
    // Ensure session exists
    await this.getOrCreate();

    if (this.currentSession && data) {
      this.currentSession.data = {
        ...this.currentSession.data,
        ...data,
      };
      this.currentSession.metadata!.lastUpdatedAt = new Date();

      // Synchronize with agent's collected data for bidirectional sync
      if (this.agent) {
        await this.agent.updateCollectedData(this.currentSession.data);
      }

      // Auto-save to persistence
      await this.save();
    }
  }

  /**
   * Update specific fields in the agent-level data
   * Provides a more explicit method for data updates
   */
  async updateData(updates: Partial<TData>): Promise<void> {
    await this.setData(updates);
  }

  /**
   * Clear all collected data while preserving session structure
   */
  async clearData(): Promise<void> {
    if (this.currentSession) {
      this.currentSession.data = {} as Partial<TData>;
      this.currentSession.metadata!.lastUpdatedAt = new Date();

      // Auto-save to persistence
      await this.save();
    }
  }

  /**
   * Reset the session (creates new session, optionally preserving history)
   */
  async reset(preserveHistory = false): Promise<SessionState<TData>> {
    const oldId = this.currentSession?.id;
    const history = preserveHistory ? this.currentSession?.history : [];

    // Create new session
    const newSession = await this.create();

    // Preserve history if requested
    if (preserveHistory && history) {
      newSession.history = [...history];
    }

    // Clean up old session from persistence
    if (oldId && this.persistenceManager) {
      await this.persistenceManager.deleteSession(oldId);
    }

    await this.save();
    return newSession;
  }

  /**
   * Get the persistence manager (for testing purposes)
   */
  getPersistenceManager(): PersistenceManager<TData> | undefined {
    return this.persistenceManager;
  }
}
