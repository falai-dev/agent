/**
 * Persistence-related type definitions
 * Support for optional database persistence (Prisma, etc.)
 */

import type { Event, MessageRole } from "./history";
import type { SessionState } from "./session";

/**
 * Session status enum
 */
export type SessionStatus = "active" | "completed" | "abandoned";

/**
 * Base session data structure
 */
export interface SessionData<TData = Record<string, unknown>> {
  id: string;
  userId?: string;
  agentName?: string;
  status: SessionStatus;
  currentFlow?: string;
  currentStep?: string;
  collectedData?: CollectedStateData<TData>;
  messageCount?: number;
  lastMessageAt?: Date;
  completedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
  /**
   * Optimistic-concurrency version. Incremented by the repository on every
   * update. Undefined on rows written by pre-2.4 versions.
   */
  version?: number;
}

/**
 * Data for creating a new session (subset of SessionData)
 */
export type CreateSessionData<TData = Record<string, unknown>> = Omit<
  SessionData<TData>,
  "id" | "createdAt" | "updatedAt"
> & {
  id?: string;
};

/**
 * Structure for data collected during a session that needs to be persisted.
 * This is a subset of SessionState, stored within SessionData.
 */
export interface CollectedStateData<TData = Record<string, unknown>> {
  /**
   * User-defined schema version of the agent that wrote this state.
   * Set from `PersistenceConfig.schemaVersion` on save; checked on load so
   * `migrateSession` can upgrade state written by older agent deployments.
   */
  schemaVersion?: number;
  data: Partial<TData>;
  flowHistory: SessionState<TData>["flowHistory"];
  history?: SessionState<TData>["history"];
  currentFlowTitle?: string;
  currentStepDescription?: string;
  metadata: SessionState<TData>["metadata"];
  /** Pending directive — included only when a directive is actually present. */
  pendingDirective?: SessionState<TData>["pendingDirective"];
  /** Reserved for v2.x Signals. Passed through bit-identical. */
  signals?: SessionState<TData>["signals"];
}

/**
 * Base message data structure
 */
export interface MessageData {
  id: string;
  sessionId: string;
  userId?: string;
  role: MessageRole;
  content: string;
  flow?: string;
  step?: string;
  toolCalls?: Array<{ toolName: string; arguments: Record<string, unknown> }>;
  event?: Event; // Optional: store full event data
  createdAt: Date;
}

/**
 * Options for SessionRepository.update
 */
export interface SessionUpdateOptions {
  /**
   * Optimistic-concurrency guard. When set, the repository must reject the
   * update with SessionConflictError if the stored session's `version`
   * differs from this value.
   */
  expectedVersion?: number;
}

/**
 * Repository interface for sessions
 * Implement this interface with your database of choice
 */
export interface SessionRepository<TData = Record<string, unknown>> {
  /**
   * Create a new session
   */
  create(data: CreateSessionData<TData>): Promise<SessionData<TData>>;

  /**
   * Find session by ID
   */
  findById(id: string): Promise<SessionData<TData> | null>;

  /**
   * Find active session by user ID
   */
  findActiveByUserId(userId: string): Promise<SessionData<TData> | null>;

  /**
   * Find all sessions for a user
   */
  findByUserId(userId: string, limit?: number): Promise<SessionData<TData>[]>;

  /**
   * Update session.
   *
   * When `options.expectedVersion` is provided, the update is a compare-and-swap:
   * it must throw SessionConflictError if the stored `version` differs (rows with
   * no stored version — written by pre-2.4 — are accepted). Every successful
   * update increments `version` by one.
   */
  update(
    id: string,
    data: Partial<Omit<SessionData<TData>, "id" | "createdAt">>,
    options?: SessionUpdateOptions
  ): Promise<SessionData<TData> | null>;

  /**
   * Update session status
   */
  updateStatus(
    id: string,
    status: SessionStatus,
    completedAt?: Date
  ): Promise<SessionData<TData> | null>;

  /**
   * Update collected data
   */
  updateCollectedData(
    id: string,
    collectedData: CollectedStateData<TData>
  ): Promise<SessionData<TData> | null>;

  /**
   * Update current flow and step
   */
  updateFlowStep(
    id: string,
    flow?: string,
    step?: string
  ): Promise<SessionData<TData> | null>;

  /**
   * Increment message count
   */
  incrementMessageCount(id: string): Promise<SessionData<TData> | null>;

  /**
   * Delete session
   */
  delete(id: string): Promise<boolean>;
}

/**
 * Repository interface for messages
 * Implement this interface with your database of choice
 */
export interface MessageRepository {
  /**
   * Create a new message
   */
  create(data: Omit<MessageData, "id" | "createdAt">): Promise<MessageData>;

  /**
   * Find message by ID
   */
  findById(id: string): Promise<MessageData | null>;

  /**
   * Find all messages for a session
   */
  findBySessionId(sessionId: string, limit?: number): Promise<MessageData[]>;

  /**
   * Find messages for a user
   */
  findByUserId(userId: string, limit?: number): Promise<MessageData[]>;

  /**
   * Delete message by ID
   */
  delete(id: string): Promise<boolean>;

  /**
   * Delete all messages for a session
   */
  deleteBySessionId(sessionId: string): Promise<number>;

  /**
   * Delete all messages for a user
   */
  deleteByUserId(userId: string): Promise<number>;
}

/**
 * Persistence adapter interface
 * Implement this to create adapters for different databases
 */
export interface PersistenceAdapter<TData = Record<string, unknown>> {
  /**
   * Session repository
   */
  readonly sessionRepository: SessionRepository<TData>;

  /**
   * Message repository
   */
  readonly messageRepository: MessageRepository;

  /**
   * Initialize the adapter (create tables, indexes, etc.)
   * Called automatically when adapter is created
   */
  initialize?(): Promise<void>;

  /**
   * Disconnect/cleanup resources
   */
  disconnect?(): Promise<void>;
}

/**
 * Configuration for persistence
 */
export interface PersistenceConfig<TData = Record<string, unknown>> {
  /**
   * Persistence adapter instance (e.g., PrismaAdapter)
   */
  adapter: PersistenceAdapter<TData>;

  /**
   * Whether to auto-save messages (default: true)
   */
  autoSave?: boolean;

  /**
   * User ID to associate with sessions/messages
   * Can also be provided per-call in methods
   */
  userId?: string;

  /**
   * Version of the user-defined agent schema. Stamped onto persisted state on
   * save. When a loaded session carries a different (or missing) schemaVersion,
   * `migrateSession` is invoked to upgrade it; without a migrator, a warning is
   * logged and the state is used as-is.
   */
  schemaVersion?: number;

  /**
   * Migrate persisted session state written under an older schemaVersion.
   * Receives the stored state and the version it was written with
   * (undefined for pre-versioning rows); must return state valid for the
   * current schemaVersion.
   */
  migrateSession?: (
    collectedData: CollectedStateData<TData>,
    fromVersion: number | undefined
  ) => CollectedStateData<TData> | Promise<CollectedStateData<TData>>;
}

/**
 * Options for creating a session
 */
export interface CreateSessionOptions<TData = Record<string, unknown>> {
  userId?: string;
  agentName?: string;
  initialData?: Partial<TData>;
}

/**
 * Options for saving a message
 */
export interface SaveMessageOptions {
  sessionId: string;
  userId?: string;
  role: MessageRole;
  content: string;
  flow?: string;
  step?: string;
  toolCalls?: Array<{ toolName: string; arguments: Record<string, unknown> }>;
  event?: Event;
}
