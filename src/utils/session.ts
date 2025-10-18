import type { SessionState } from "../types/session";

/**
 * Helper to create a new session
 * @param sessionId - Optional session ID (e.g., from database)
 * @param metadata - Optional metadata to attach
 */
export function createSession<TData = Record<string, unknown>>(
  sessionId?: string,
  metadata?: SessionState<TData>["metadata"]
): SessionState<TData> {
  return {
    id: sessionId,
    data: {},
    dataByRoute: {},
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
 * Preserves collected data per route in dataByRoute map
 */
export function enterRoute<TData = Record<string, unknown>>(
  session: SessionState<TData>,
  routeId: string,
  routeTitle: string
): SessionState<TData> {
  // Save current route's collected data before switching (if any)
  const dataByRoute = { ...session.dataByRoute };
  if (
    session.currentRoute &&
    session.data &&
    Object.keys(session.data).length > 0
  ) {
    dataByRoute[session.currentRoute.id] = session.data;
  }

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

  // Load collected data for new route (if resuming) or start fresh
  const newCollected = (dataByRoute[routeId] as Partial<TData>) || {};

  // Enter new route
  const now = new Date();
  return {
    ...session,
    currentRoute: {
      id: routeId,
      title: routeTitle,
      enteredAt: now,
    },
    currentStep: undefined,
    data: newCollected, // Load route's data or start fresh
    dataByRoute,
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
 * Helper to update session with new step
 */
export function enterStep<TData = Record<string, unknown>>(
  session: SessionState<TData>,
  stepId: string,
  stepDescription?: string
): SessionState<TData> {
  return {
    ...session,
    currentStep: {
      id: stepId,
      description: stepDescription,
      enteredAt: new Date(),
    },
    metadata: {
      ...session.metadata,
      lastUpdatedAt: new Date(),
    },
  };
}

/**
 * Helper to merge collected data into session
 * Updates both data and dataByRoute for current route
 */
export function mergeCollected<TData = Record<string, unknown>>(
  session: SessionState<TData>,
  data: Partial<unknown>
): SessionState<TData> {
  const newCollected = {
    ...session.data,
    ...data,
  } as Partial<TData>;

  // Also update the dataByRoute map for the current route
  const dataByRoute = { ...session.dataByRoute };
  if (session.currentRoute) {
    dataByRoute[session.currentRoute.id] = newCollected;
  }

  return {
    ...session,
    data: newCollected,
    dataByRoute,
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
export function sessionStepToData<TData = Record<string, unknown>>(
  session: SessionState<TData>
): {
  currentRoute?: string;
  currentStep?: string;
  collectedData: Record<string, unknown>;
} {
  return {
    currentRoute: session.currentRoute?.id,
    currentStep: session.currentStep?.id,
    collectedData: {
      data: session.data,
      dataByRoute: session.dataByRoute, // Include per-route data
      routeHistory: session.routeHistory,
      currentRouteTitle: session.currentRoute?.title,
      currentStepDescription: session.currentStep?.description,
      metadata: session.metadata,
    },
  };
}

/**
 * Helper to convert database SessionData back to SessionState
 * Used when loading from database
 * @param sessionId - The database session ID
 * @param data - The database session data
 */
export function sessionDataToStep<TData = Record<string, unknown>>(
  sessionId: string,
  data: {
    currentRoute?: string;
    currentStep?: string;
    collectedData?: Record<string, unknown>;
  }
): SessionState<TData> {
  const collectedData = data.collectedData || {};

  return {
    id: sessionId,
    currentRoute: data.currentRoute
      ? {
          id: data.currentRoute,
          title:
            (collectedData.currentRouteTitle as string) || data.currentRoute,
          enteredAt: new Date(),
        }
      : undefined,
    currentStep: data.currentStep
      ? {
          id: data.currentStep,
          description:
            (collectedData.currentStepDescription as string) || undefined,
          enteredAt: new Date(),
        }
      : undefined,
    data: (collectedData.data as Partial<TData>) || {},
    dataByRoute:
      (collectedData.dataByRoute as Record<string, Partial<unknown>>) || {}, // Restore per-route data
    routeHistory:
      (collectedData.routeHistory as SessionState<TData>["routeHistory"]) || [],
    metadata: (collectedData.metadata as SessionState<TData>["metadata"]) || {},
  };
}
