/**
 * Session step types for tracking conversation progress
 */

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
 * Session step tracks the current position in the conversation flow
 * and data collected during the route progression
 */
export interface SessionState<TData = unknown> {
  /** Unique session identifier (useful for persistence) */
  id: string;

  /** Current route the conversation is in */
  currentRoute?: {
    id: string;
    title: string;
    enteredAt: Date;
  };

  /** Current step within the route */
  currentStep?: {
    id: string;
    description?: string;
    enteredAt: Date;
  };

  /**
   * Data collected during the current route
   * Convenience reference to dataByRoute[currentRoute.id]
   */
  data?: Partial<TData>;

  /**
   * Data collected organized by route ID
   * Persists data when switching between routes
   * Allows resuming incomplete routes where they left off
   */
  dataByRoute?: Record<string, Partial<TData>>;

  /** History of routes visited in this session */
  routeHistory: Array<{
    routeId: string;
    enteredAt: Date;
    exitedAt?: Date;
    completed: boolean;
  }>;

  /**
   * Pending route transition after completion
   * Set when a route completes with onComplete handler
   */
  pendingTransition?: PendingTransition;

  /** Session metadata */
  metadata?: {
    createdAt?: Date;
    lastUpdatedAt?: Date;
    [key: string]: unknown;
  };
}
