/**
 * Session state types for tracking conversation progress
 */

/**
 * Session state tracks the current position in the conversation flow
 * and data extracted during the route progression
 */
export interface SessionState<TExtracted = Record<string, unknown>> {
  /** Current route the conversation is in */
  currentRoute?: {
    id: string;
    title: string;
    enteredAt: Date;
  };

  /** Current state within the route */
  currentState?: {
    id: string;
    description?: string;
    enteredAt: Date;
  };

  /** Data extracted during the current route */
  extracted: Partial<TExtracted>;

  /** History of routes visited in this session */
  routeHistory: Array<{
    routeId: string;
    enteredAt: Date;
    exitedAt?: Date;
    completed: boolean;
  }>;

  /** Session metadata */
  metadata?: {
    sessionId?: string;
    createdAt?: Date;
    lastUpdatedAt?: Date;
    [key: string]: unknown;
  };
}

/**
 * Helper to create a new session
 */
export function createSession<TExtracted = Record<string, unknown>>(
  metadata?: SessionState<TExtracted>["metadata"]
): SessionState<TExtracted> {
  return {
    extracted: {},
    routeHistory: [],
    metadata: {
      ...metadata,
      createdAt: new Date(),
      lastUpdatedAt: new Date(),
    },
  };
}

/**
 * Helper to update session with new route
 */
export function enterRoute<TExtracted = Record<string, unknown>>(
  session: SessionState<TExtracted>,
  routeId: string,
  routeTitle: string
): SessionState<TExtracted> {
  // Exit current route if exists
  const routeHistory = [...session.routeHistory];
  if (session.currentRoute) {
    const lastRouteIndex = routeHistory.findIndex(
      (r) => r.routeId === session.currentRoute?.id && !r.exitedAt
    );
    if (lastRouteIndex >= 0) {
      routeHistory[lastRouteIndex].exitedAt = new Date();
    }
  }

  // Enter new route
  const now = new Date();
  return {
    ...session,
    currentRoute: {
      id: routeId,
      title: routeTitle,
      enteredAt: now,
    },
    currentState: undefined,
    extracted: {}, // Reset extracted data for new route
    routeHistory: [
      ...routeHistory,
      {
        routeId,
        enteredAt: now,
        completed: false,
      },
    ],
    metadata: {
      ...session.metadata,
      lastUpdatedAt: now,
    },
  };
}

/**
 * Helper to update session with new state
 */
export function enterState<TExtracted = Record<string, unknown>>(
  session: SessionState<TExtracted>,
  stateId: string,
  stateDescription?: string
): SessionState<TExtracted> {
  return {
    ...session,
    currentState: {
      id: stateId,
      description: stateDescription,
      enteredAt: new Date(),
    },
    metadata: {
      ...session.metadata,
      lastUpdatedAt: new Date(),
    },
  };
}

/**
 * Helper to merge extracted data into session
 */
export function mergeExtracted<TExtracted = Record<string, unknown>>(
  session: SessionState<TExtracted>,
  extracted: Partial<TExtracted>
): SessionState<TExtracted> {
  return {
    ...session,
    extracted: {
      ...session.extracted,
      ...extracted,
    },
    metadata: {
      ...session.metadata,
      lastUpdatedAt: new Date(),
    },
  };
}

/**
 * Helper to convert SessionState to persistence-friendly format
 * Used when saving to database
 */
export function sessionStateToData<TExtracted = Record<string, unknown>>(
  session: SessionState<TExtracted>
): {
  currentRoute?: string;
  currentState?: string;
  collectedData: Record<string, unknown>;
} {
  return {
    currentRoute: session.currentRoute?.id,
    currentState: session.currentState?.id,
    collectedData: {
      extracted: session.extracted,
      routeHistory: session.routeHistory,
      currentRouteTitle: session.currentRoute?.title,
      currentStateDescription: session.currentState?.description,
      metadata: session.metadata,
    },
  };
}

/**
 * Helper to convert database SessionData back to SessionState
 * Used when loading from database
 */
export function sessionDataToState<TExtracted = Record<string, unknown>>(data: {
  currentRoute?: string;
  currentState?: string;
  collectedData?: Record<string, unknown>;
}): Partial<SessionState<TExtracted>> {
  const collectedData = data.collectedData || {};

  return {
    currentRoute: data.currentRoute
      ? {
          id: data.currentRoute,
          title:
            (collectedData.currentRouteTitle as string) || data.currentRoute,
          enteredAt: new Date(),
        }
      : undefined,
    currentState: data.currentState
      ? {
          id: data.currentState,
          description:
            (collectedData.currentStateDescription as string) || undefined,
          enteredAt: new Date(),
        }
      : undefined,
    extracted: (collectedData.extracted as Partial<TExtracted>) || {},
    routeHistory:
      (collectedData.routeHistory as SessionState<TExtracted>["routeHistory"]) ||
      [],
    metadata:
      (collectedData.metadata as SessionState<TExtracted>["metadata"]) || {},
  };
}
