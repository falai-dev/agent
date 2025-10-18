/**
 * Persistence Manager
 * Handles optional persistence of sessions and messages
 */

import type {
  PersistenceConfig,
  SessionData,
  MessageData,
  CreateSessionOptions,
  SaveMessageOptions,
  SessionStatus,
  SessionRepository,
  MessageRepository,
  Event,
  SessionState,
} from "../types";
import { createSession, sessionStepToData, sessionDataToStep } from "../utils";

/**
 * Manager for handling persistence operations
 * Provides a clean interface for optional database persistence
 */
export class PersistenceManager {
  private config: PersistenceConfig;
  private sessionRepository: SessionRepository;
  private messageRepository: MessageRepository;

  constructor(config: PersistenceConfig) {
    this.config = {
      autoSave: true,
      ...config,
    };
    this.sessionRepository = config.adapter.sessionRepository;
    this.messageRepository = config.adapter.messageRepository;
  }

  /**
   * Create a new session
   */
  async createSession(options: CreateSessionOptions): Promise<SessionData> {
    const userId = options.userId || this.config.userId;

    return await this.sessionRepository.create({
      userId,
      agentName: options.agentName,
      status: "active",
      collectedData: options.initialData || {},
      messageCount: 0,
    });
  }

  /**
   * Get session by ID
   */
  async getSession(sessionId: string): Promise<SessionData | null> {
    return await this.sessionRepository.findById(sessionId);
  }

  /**
   * Find active session for a user
   */
  async findActiveSession(userId?: string): Promise<SessionData | null> {
    const effectiveUserId = userId || this.config.userId;
    if (!effectiveUserId) {
      throw new Error(
        "userId must be provided or configured in PersistenceConfig"
      );
    }
    return await this.sessionRepository.findActiveByUserId(effectiveUserId);
  }

  /**
   * Get all sessions for a user
   */
  async getUserSessions(
    userId?: string,
    limit?: number
  ): Promise<SessionData[]> {
    const effectiveUserId = userId || this.config.userId;
    if (!effectiveUserId) {
      throw new Error(
        "userId must be provided or configured in PersistenceConfig"
      );
    }
    return await this.sessionRepository.findByUserId(effectiveUserId, limit);
  }

  /**
   * Update session status
   */
  async updateSessionStatus(
    sessionId: string,
    status: SessionStatus,
    completedAt?: Date
  ): Promise<SessionData | null> {
    return await this.sessionRepository.updateStatus(
      sessionId,
      status,
      completedAt
    );
  }

  /**
   * Update collected data in session
   */
  async updateCollectedData(
    sessionId: string,
    collectedData: Record<string, unknown>
  ): Promise<SessionData | null> {
    return await this.sessionRepository.updateCollectedData(
      sessionId,
      collectedData
    );
  }

  /**
   * Update current route and step
   */
  async updateRouteStep(
    sessionId: string,
    route?: string,
    step?: string
  ): Promise<SessionData | null> {
    return await this.sessionRepository.updateRouteStep(sessionId, route, step);
  }

  /**
   * Save a message
   */
  async saveMessage(options: SaveMessageOptions): Promise<MessageData> {
    const userId = options.userId || this.config.userId;

    const message = await this.messageRepository.create({
      sessionId: options.sessionId,
      userId,
      role: options.role,
      content: options.content,
      route: options.route,
      step: options.step,
      toolCalls: options.toolCalls,
      event: options.event,
    });

    // Increment message count in session if autoSave is enabled
    if (this.config.autoSave) {
      await this.sessionRepository.incrementMessageCount(options.sessionId);
    }

    return message;
  }

  /**
   * Get all messages for a session
   */
  async getSessionMessages(
    sessionId: string,
    limit?: number
  ): Promise<MessageData[]> {
    return await this.messageRepository.findBySessionId(sessionId, limit);
  }

  /**
   * Get messages for a user
   */
  async getUserMessages(
    userId?: string,
    limit?: number
  ): Promise<MessageData[]> {
    const effectiveUserId = userId || this.config.userId;
    if (!effectiveUserId) {
      throw new Error(
        "userId must be provided or configured in PersistenceConfig"
      );
    }
    return await this.messageRepository.findByUserId(effectiveUserId, limit);
  }

  /**
   * Delete a session and all its messages
   */
  async deleteSession(sessionId: string): Promise<boolean> {
    // Delete all messages first
    await this.messageRepository.deleteBySessionId(sessionId);

    // Then delete the session
    return await this.sessionRepository.delete(sessionId);
  }

  /**
   * Complete a session
   */
  async completeSession(sessionId: string): Promise<SessionData | null> {
    return await this.updateSessionStatus(sessionId, "completed", new Date());
  }

  /**
   * Abandon a session
   */
  async abandonSession(sessionId: string): Promise<SessionData | null> {
    return await this.updateSessionStatus(sessionId, "abandoned");
  }

  /**
   * Helper: Convert message data to Event format
   */
  messageToEvent(message: MessageData): Event | undefined {
    return message.event;
  }

  /**
   * Helper: Load history from session messages
   */
  async loadSessionHistory(sessionId: string): Promise<Event[]> {
    const messages = await this.getSessionMessages(sessionId);
    return messages
      .map((m) => this.messageToEvent(m))
      .filter((e): e is Event => e !== undefined);
  }

  /**
   * Save SessionState to database
   * Converts SessionState to SessionData and persists it
   */
  async saveSessionState<TData = Record<string, unknown>>(
    sessionId: string,
    sessionStep: SessionState<TData>
  ): Promise<SessionData | null> {
    const persistenceData = sessionStepToData(sessionStep);

    return await this.sessionRepository.update(sessionId, {
      currentRoute: persistenceData.currentRoute,
      currentStep: persistenceData.currentStep,
      collectedData: persistenceData.collectedData,
      lastMessageAt: new Date(),
    });
  }

  /**
   * Load SessionState from database
   * Converts SessionData to SessionState
   */
  async loadSessionState<TData = Record<string, unknown>>(
    sessionId: string
  ): Promise<SessionState<TData> | null> {
    const sessionData = await this.sessionRepository.findById(sessionId);

    if (!sessionData) {
      return null;
    }

    const stepData = sessionDataToStep<TData>(sessionId, {
      currentRoute: sessionData.currentRoute,
      currentStep: sessionData.currentStep,
      collectedData: sessionData.collectedData,
    });

    // Create a full session step with the loaded data
    const session = createSession<TData>(sessionId, {
      createdAt: sessionData.createdAt,
      lastUpdatedAt: sessionData.updatedAt,
    });

    return {
      ...session,
      ...stepData,
    };
  }

  /**
   * Create session with SessionState support
   * Returns both SessionData and initialized SessionState
   */
  async createSessionWithStep<TData = Record<string, unknown>>(
    options: CreateSessionOptions
  ): Promise<{
    sessionData: SessionData;
    sessionStep: SessionState<TData>;
  }> {
    const sessionData = await this.createSession(options);

    // Create SessionState with database session ID
    const sessionStep = createSession<TData>(sessionData.id, {
      createdAt: sessionData.createdAt,
      lastUpdatedAt: sessionData.updatedAt,
    });

    // If initial data was provided, merge it as collected data
    if (options.initialData) {
      sessionStep.data = options.initialData as Partial<TData>;
    }

    return { sessionData, sessionStep };
  }
}
