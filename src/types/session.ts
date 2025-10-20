/**
 * Session step types for tracking conversation progress
 */

import type { History } from "./history";

/**
 * Pending route transition information
 */
export interface PendingTransition {
  /** Target route ID to transition to */
  targetRouteId: string;
  /** Optional AI-evaluated condition for the transition */
  condition?: string;
  /** Reason for the transition */
  reason: "route_complete" | "manual";
}

/**
 * Session state tracks the current position in the conversation flow
 * and data collected at the agent level across all routes
 */
export interface SessionState<TData = unknown> {
  /** Unique session identifier (useful for persistence) */
  id: string;

  /** Current route the conversation is in */
  currentRoute?: {
    id: string;
    title: string;
    enteredAt?: Date;
  };

  /** Current step within the route */
  currentStep?: {
    id: string;
    description?: string;
    enteredAt?: Date;
  };

  /**
   * Agent-level data collected across all routes
   * This is the single source of truth for all collected data
   * Routes can access and contribute to this shared data structure
   */
  data: Partial<TData>;

  /** History of routes visited in this session */
  routeHistory?: Array<{
    routeId: string;
    enteredAt?: Date;
    exitedAt?: Date;
    completed: boolean;
  }>;

  /**
   * Pending route transition after completion
   * Set when a route completes with onComplete handler
   */
  pendingTransition?: PendingTransition;

  /**
   * Conversation history managed by the session
   * Contains the full conversation between user and assistant
   */
  history?: History;

  /** Session metadata */
  metadata?: {
    createdAt?: Date;
    lastUpdatedAt?: Date;
    [key: string]: unknown;
  };
}
