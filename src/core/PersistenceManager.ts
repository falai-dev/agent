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
  History,
  PersistenceAdapter,
  CollectedStateData,
} from "../types";
import { createSession, sessionStepToData, sessionDataToStep, logger } from "../utils";
import { SessionConflictError } from "../types/errors";
import { convertMessagesToHistory } from "./Events";

/**
 * Manager for handling persistence operations
 * Provides a clean interface for optional database persistence
 */
export class PersistenceManager<TData = Record<string, unknown>> {
  private config: PersistenceConfig<TData>;
  private sessionRepository: SessionRepository<TData>;
  private messageRepository: MessageRepository;
  /** Per-session in-process save queue; see saveSessionState. */
  private saveQueues = new Map<string, Promise<SessionData<TData> | null>>();

  constructor(config: PersistenceConfig<TData>) {
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
  async createSession(
    options: CreateSessionOptions<TData>
  ): Promise<SessionData<TData>> {
    const userId = options.userId || this.config.userId;

    return await this.sessionRepository.create({
      userId,
      agentName: options.agentName,
      status: "active",
      collectedData: {
        data: options.initialData || {},
        flowHistory: [],
        metadata: {},
      },
      messageCount: 0,
    });
  }

  /**
   * Get session by ID
   */
  async getSession(sessionId: string): Promise<SessionData<TData> | null> {
    return await this.sessionRepository.findById(sessionId);
  }

  /**
   * Find active session for a user
   */
  async findActiveSession(userId?: string): Promise<SessionData<TData> | null> {
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
  ): Promise<SessionData<TData>[]> {
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
  ): Promise<SessionData<TData> | null> {
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
    collectedData: CollectedStateData<TData>
  ): Promise<SessionData<TData> | null> {
    return await this.sessionRepository.updateCollectedData(
      sessionId,
      collectedData
    );
  }

  /**
   * Update current flow and step
   */
  async updateFlowStep(
    sessionId: string,
    flow?: string,
    step?: string
  ): Promise<SessionData<TData> | null> {
    return await this.sessionRepository.updateFlowStep(sessionId, flow, step);
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
      flow: options.flow,
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
  async completeSession(sessionId: string): Promise<SessionData<TData> | null> {
    return await this.updateSessionStatus(sessionId, "completed", new Date());
  }

  /**
   * Abandon a session
   */
  async abandonSession(sessionId: string): Promise<SessionData<TData> | null> {
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
  async loadSessionHistory(sessionId: string): Promise<History> {
    const messages = await this.getSessionMessages(sessionId);
    return convertMessagesToHistory(messages);
  }

  /**
   * Save SessionState to database
   * Converts SessionState to SessionData and persists it
   */
  async saveSessionState(
    sessionId: string,
    sessionStep: SessionState<TData>
  ): Promise<SessionData<TData> | null> {
    // Serialize same-process saves per session: concurrent saves of the same
    // in-memory session would otherwise race the version compare-and-swap and
    // spuriously conflict with each other. Cross-process conflicts (two
    // independently loaded copies) still throw SessionConflictError.
    const previous = this.saveQueues.get(sessionId) ?? Promise.resolve();
    const run = previous
      .catch(() => undefined)
      .then(() => this.doSaveSessionState(sessionId, sessionStep));
    this.saveQueues.set(sessionId, run);
    try {
      return await run;
    } finally {
      if (this.saveQueues.get(sessionId) === run) {
        this.saveQueues.delete(sessionId);
      }
    }
  }

  private async doSaveSessionState(
    sessionId: string,
    sessionStep: SessionState<TData>
  ): Promise<SessionData<TData> | null> {
    // Validate input parameters
    if (!sessionId || typeof sessionId !== 'string') {
      throw new Error('Session ID must be a non-empty string');
    }

    if (!sessionStep || typeof sessionStep !== 'object') {
      throw new Error('Session step must be a valid object');
    }

    // Validate session data structure
    if (sessionStep.data && typeof sessionStep.data !== 'object') {
      throw new Error('Session data must be an object');
    }

    let persistenceData;
    try {
      persistenceData = sessionStepToData(sessionStep);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to convert session step to persistence data: ${errorMessage}`);
    }

    // Stamp the configured schema version so loads can detect stale state
    if (this.config.schemaVersion !== undefined) {
      persistenceData.collectedData.schemaVersion = this.config.schemaVersion;
    }

    try {
      // First try to find existing session
      const existingSession = await this.sessionRepository.findById(sessionId);

      let saved: SessionData<TData> | null;
      if (existingSession) {
        // Compare-and-swap on the session's version: a concurrent writer
        // bumped it since we loaded, the adapter throws SessionConflictError
        saved = await this.sessionRepository.update(
          sessionId,
          {
            currentFlow: persistenceData.currentFlow,
            currentStep: persistenceData.currentStep,
            collectedData: persistenceData.collectedData,
            lastMessageAt: new Date(),
          },
          { expectedVersion: sessionStep.version }
        );
      } else {
        saved = await this.sessionRepository.create({
          id: sessionId,
          userId: persistenceData.collectedData.metadata?.userId
            ? JSON.stringify(persistenceData.collectedData.metadata?.userId)
            : this.config.userId,
          status: "active",
          currentFlow: persistenceData.currentFlow,
          currentStep: persistenceData.currentStep,
          collectedData: persistenceData.collectedData,
          messageCount: 0,
          version: 1,
        });
      }

      // Propagate the new version so the next save of this in-memory session
      // passes the compare-and-swap
      if (saved?.version !== undefined) {
        sessionStep.version = saved.version;
      }

      return saved;
    } catch (error) {
      if (error instanceof SessionConflictError) {
        throw error;
      }
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to save session state to persistence: ${errorMessage}`);
    }
  }

  /**
   * Load SessionState from database
   * Converts SessionData to SessionState
   */
  async loadSessionState(
    sessionId: string
  ): Promise<SessionState<TData> | null> {
    const sessionData = await this.sessionRepository.findById(sessionId);

    if (!sessionData) {
      return null;
    }

    // Upgrade state written under an older user schema before reconstructing
    if (
      this.config.schemaVersion !== undefined &&
      sessionData.collectedData &&
      sessionData.collectedData.schemaVersion !== this.config.schemaVersion
    ) {
      const fromVersion = sessionData.collectedData.schemaVersion;
      if (this.config.migrateSession) {
        sessionData.collectedData = await this.config.migrateSession(
          sessionData.collectedData,
          fromVersion
        );
        sessionData.collectedData.schemaVersion = this.config.schemaVersion;
      } else {
        logger.warn(
          `[PersistenceManager] Session "${sessionId}" was written with schemaVersion ` +
          `${fromVersion ?? 'none'} but the agent is configured with ${this.config.schemaVersion}, ` +
          `and no migrateSession is configured. Loading state as-is.`
        );
      }
    }

    // Reconstruct SessionState from SessionData
    const sessionState = sessionDataToStep<TData>(sessionId, sessionData);

    // Create a full session step with the loaded data
    const session = createSession<TData>(sessionId, {
      createdAt: sessionData.createdAt,
      lastUpdatedAt: sessionData.updatedAt,
    });

    return {
      ...session,
      ...sessionState,
      metadata: {
        ...session.metadata,
        ...sessionState.metadata,
      },
    };
  }

  /**
   * Get the underlying adapter
   */
  getAdapter(): PersistenceAdapter<TData> {
    return this.config.adapter;
  }

  /**
   * Create session with SessionState support
   * Returns both SessionData and initialized SessionState
   */
  async createSessionWithStep(options: CreateSessionOptions<TData>): Promise<{
    sessionData: SessionData<TData>;
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
      sessionStep.data = options.initialData;
    }

    return { sessionData, sessionStep };
  }
}
