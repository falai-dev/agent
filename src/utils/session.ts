import { cloneDeep } from "./clone";
import type { SessionState } from "../types/session";
import type { CollectedStateData } from "../types/persistence";

/**
 * Helper to create a new session
 *
 * Overload 1: Create with optional sessionId and metadata
 * @param sessionId - Optional session ID (e.g., from database)
 * @param metadata - Optional metadata to attach
 *
 * Overload 2: Create from a partial session state (merged with defaults)
 * @param state - Partial session state to merge with defaults
 */
export function createSession<TData = Record<string, unknown>>(
  sessionId?: string,
  metadata?: SessionState<TData>["metadata"]
): SessionState<TData>;
export function createSession<TData = Record<string, unknown>>(
  state: Partial<SessionState<TData>>
): SessionState<TData>;
export function createSession<TData = Record<string, unknown>>(
  sessionIdOrState?: string | Partial<SessionState<TData>>,
  metadata?: SessionState<TData>["metadata"]
): SessionState<TData> {
  // Overload 2: partial state object
  if (typeof sessionIdOrState === "object" && sessionIdOrState !== null) {
    const state = sessionIdOrState;
    const now = new Date();
    const id =
      state.id ||
      `session_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    return {
      id,
      data: state.data ?? ({} as Partial<TData>),
      routeHistory: state.routeHistory ?? [],
      currentRoute: state.currentRoute,
      currentStep: state.currentStep,
      pendingTransition: state.pendingTransition,
      history: state.history,
      metadata: {
        createdAt: now,
        lastUpdatedAt: now,
        ...state.metadata,
      },
    };
  }

  // Overload 1: sessionId + metadata
  const id =
    sessionIdOrState ||
    `session_${Date.now()}_${Math.random().toString(36).slice(2)}`;

  return {
    id,
    data: {} as Partial<TData>,
    routeHistory: [],
    metadata: {
      ...metadata,
      createdAt: new Date(),
      lastUpdatedAt: new Date(),
    },
  };
}

/**
 * Helper to create a new session ID
 */
export function createSessionId(): string {
  return `session_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}
/**
 * Clones a session to prevent mutation
 */
export function cloneSession<TData>(
  session: SessionState<TData>
): SessionState<TData> {
  return cloneDeep(session);
}

/**
 * Helper to update session with new route
 * With agent-level data, routes share the same data structure
 */
export function enterRoute<TData = Record<string, unknown>>(
  session: SessionState<TData>,
  routeId: string,
  routeTitle: string
): SessionState<TData> {
  // Exit current route if exists
  const routeHistory = [...(session.routeHistory || [])];
  if (session.currentRoute) {
    const lastRouteIndex = routeHistory.findIndex(
      (r) => r.routeId === session.currentRoute?.id && !r.exitedAt
    );
    if (lastRouteIndex >= 0) {
      routeHistory[lastRouteIndex].exitedAt = new Date();
    }
  }

  // Enter new route - data persists across routes at agent level
  const now = new Date();
  return {
    ...session,
    currentRoute: {
      id: routeId,
      title: routeTitle,
      enteredAt: now,
    },
    currentStep: undefined,
    // data remains the same - shared across all routes
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
 * Updates agent-level data structure
 */
export function mergeCollected<TData = Record<string, unknown>>(
  session: SessionState<TData>,
  data: Partial<unknown>
): SessionState<TData> {
  const newCollected = {
    ...session.data,
    ...data,
  } as Partial<TData>;

  return {
    ...session,
    data: newCollected, // Agent-level data update
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
  collectedData: CollectedStateData<TData>;
} {
  return {
    currentRoute: session.currentRoute?.id,
    currentStep: session.currentStep?.id,
    collectedData: {
      data: session.data || {},
      routeHistory: session.routeHistory,
      history: session.history, // Include conversation history
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
    collectedData?: CollectedStateData<TData>;
  }
): SessionState<TData> {
  const collectedData: CollectedStateData<TData> = data.collectedData || {
    data: {},
    routeHistory: [],
    history: [],
    metadata: {},
    currentRouteTitle: undefined,
    currentStepDescription: undefined,
  };

  return {
    id: sessionId,
    currentRoute: data.currentRoute
      ? {
        id: data.currentRoute,
        title: collectedData.currentRouteTitle || data.currentRoute,
        enteredAt: new Date(),
      }
      : undefined,
    currentStep: data.currentStep
      ? {
        id: data.currentStep,
        description: collectedData.currentStepDescription || undefined,
        enteredAt: new Date(),
      }
      : undefined,
    data: collectedData.data || {},
    routeHistory: collectedData.routeHistory || [],
    history: collectedData.history || [],
    metadata: collectedData.metadata || {},
  };
}
