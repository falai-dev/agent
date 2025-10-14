/**
 * Persistence-related type definitions
 * Support for optional database persistence (Prisma, etc.)
 */

import type { Event } from "./history";

/**
 * Session status enum
 */
export type SessionStatus = "active" | "completed" | "abandoned";

/**
 * Message role enum
 */
export type MessageRole = "user" | "agent" | "system";

/**
 * Base session data structure
 */
export interface SessionData {
  id: string;
  userId?: string;
  agentName?: string;
  status: SessionStatus;
  currentRoute?: string;
  currentState?: string;
  collectedData?: Record<string, unknown>;
  messageCount?: number;
  lastMessageAt?: Date;
  completedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
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
  route?: string;
  state?: string;
  toolCalls?: Array<{ toolName: string; arguments: Record<string, unknown> }>;
  event?: Event; // Optional: store full event data
  createdAt: Date;
}

/**
 * Repository interface for sessions
 * Implement this interface with your database of choice
 */
export interface SessionRepository {
  /**
   * Create a new session
   */
  create(
    data: Omit<SessionData, "id" | "createdAt" | "updatedAt">
  ): Promise<SessionData>;

  /**
   * Find session by ID
   */
  findById(id: string): Promise<SessionData | null>;

  /**
   * Find active session by user ID
   */
  findActiveByUserId(userId: string): Promise<SessionData | null>;

  /**
   * Find all sessions for a user
   */
  findByUserId(userId: string, limit?: number): Promise<SessionData[]>;

  /**
   * Update session
   */
  update(
    id: string,
    data: Partial<Omit<SessionData, "id" | "createdAt">>
  ): Promise<SessionData | null>;

  /**
   * Update session status
   */
  updateStatus(
    id: string,
    status: SessionStatus,
    completedAt?: Date
  ): Promise<SessionData | null>;

  /**
   * Update collected data
   */
  updateCollectedData(
    id: string,
    collectedData: Record<string, unknown>
  ): Promise<SessionData | null>;

  /**
   * Update current route and state
   */
  updateRouteState(
    id: string,
    route?: string,
    state?: string
  ): Promise<SessionData | null>;

  /**
   * Increment message count
   */
  incrementMessageCount(id: string): Promise<SessionData | null>;

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
export interface PersistenceAdapter {
  /**
   * Session repository
   */
  readonly sessionRepository: SessionRepository;

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
export interface PersistenceConfig {
  /**
   * Persistence adapter instance (e.g., PrismaAdapter)
   */
  adapter: PersistenceAdapter;

  /**
   * Whether to auto-save messages (default: true)
   */
  autoSave?: boolean;

  /**
   * User ID to associate with sessions/messages
   * Can also be provided per-call in methods
   */
  userId?: string;
}

/**
 * Options for creating a session
 */
export interface CreateSessionOptions {
  userId?: string;
  agentName?: string;
  initialData?: Record<string, unknown>;
}

/**
 * Options for saving a message
 */
export interface SaveMessageOptions {
  sessionId: string;
  userId?: string;
  role: MessageRole;
  content: string;
  route?: string;
  state?: string;
  toolCalls?: Array<{ toolName: string; arguments: Record<string, unknown> }>;
  event?: Event;
}
