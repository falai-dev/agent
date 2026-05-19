import { cloneDeep } from "./clone";
import type { SessionState } from "../types/session";
import type { Directive } from "../types/flow";
import type { CollectedStateData } from "../types/persistence";
import { logger } from "./logger";

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
      flowHistory: state.flowHistory ?? [],
      currentFlow: state.currentFlow,
      currentStep: state.currentStep,
      pendingDirective: state.pendingDirective,
      signals: state.signals,
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
    flowHistory: [],
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
 * Helper to update session with new flow
 * With agent-level data, flows share the same data structure
 */
export function enterFlow<TData = Record<string, unknown>>(
  session: SessionState<TData>,
  flowId: string,
  flowTitle: string
): SessionState<TData> {
  // Exit current flow if exists
  const flowHistory = [...(session.flowHistory || [])];
  if (session.currentFlow) {
    const lastFlowIndex = flowHistory.findIndex(
      (r) => r.flowId === session.currentFlow?.id && !r.exitedAt
    );
    if (lastFlowIndex >= 0) {
      flowHistory[lastFlowIndex].exitedAt = new Date();
    }
  }

  // Enter new flow - data persists across flows at agent level
  const now = new Date();
  return {
    ...session,
    currentFlow: {
      id: flowId,
      title: flowTitle,
      enteredAt: now,
    },
    currentStep: undefined,
    // data remains the same - shared across all flows
    flowHistory: [
      ...flowHistory,
      {
        flowId: flowId,
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
 * Helper to release the session to idle state on flow completion.
 *
 * Marks the active flow's `flowHistory` entry as completed (sets
 * `completed: true` and `exitedAt: <now>`), clears `currentFlow` and
 * `currentStep`, and (when `clearOwnedFields` is provided) removes those
 * fields from `session.data` to support `flow.reentrant` re-entry.
 *
 * Does **not** generate any message, copy, or LLM call. The framework
 * speaks no text of its own at the completion boundary — the developer
 * controls every word emitted to the user via flow steps.
 */
export function completeCurrentFlow<TData = Record<string, unknown>>(
  session: SessionState<TData>,
  options?: { clearOwnedFields?: ReadonlyArray<keyof TData> }
): SessionState<TData> {
  const now = new Date();
  const flowHistory = [...(session.flowHistory || [])];

  if (session.currentFlow) {
    const lastFlowIndex = flowHistory.findIndex(
      (entry) => entry.flowId === session.currentFlow?.id && !entry.exitedAt
    );
    if (lastFlowIndex >= 0) {
      flowHistory[lastFlowIndex] = {
        ...flowHistory[lastFlowIndex],
        exitedAt: now,
        completed: true,
      };
    }
  }

  let nextData = session.data;
  if (options?.clearOwnedFields && options.clearOwnedFields.length > 0) {
    const owned = new Set<keyof TData>(options.clearOwnedFields);
    const filtered: Partial<TData> = {};
    for (const key of Object.keys(session.data ?? {}) as (keyof TData)[]) {
      if (!owned.has(key)) {
        (filtered as Record<keyof TData, unknown>)[key] =
          (session.data as Record<keyof TData, unknown>)[key];
      }
    }
    nextData = filtered;
  }

  return {
    ...session,
    currentFlow: undefined,
    currentStep: undefined,
    flowHistory,
    data: nextData,
    metadata: {
      ...session.metadata,
      lastUpdatedAt: now,
    },
  };
}

/**
 * Returns true when the given flow id has a most-recent `flowHistory`
 * entry marked as completed within this session. Used by the router to
 * exclude completed flows from candidate scoring (unless the flow is
 * `reentrant`).
 */
export function isFlowCompletedThisSession<TData = Record<string, unknown>>(
  session: SessionState<TData>,
  flowId: string
): boolean {
  const history = session.flowHistory ?? [];
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i];
    if (entry.flowId === flowId) {
      return entry.completed === true;
    }
  }
  return false;
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
  currentFlow?: string;
  currentStep?: string;
  collectedData: CollectedStateData<TData>;
} {
  // Strip pre-LLM-only fields before persisting pendingDirective
  let pendingDirective: SessionState<TData>["pendingDirective"] | undefined;
  if (session.pendingDirective) {
    pendingDirective = stripPreDirectiveFields(session.pendingDirective);
  }

  const collectedData: CollectedStateData<TData> = {
    data: session.data || {},
    flowHistory: session.flowHistory,
    history: session.history,
    currentFlowTitle: session.currentFlow?.title,
    currentStepDescription: session.currentStep?.description,
    metadata: session.metadata,
  };

  // Only include pendingDirective when defined (omit key when undefined)
  if (pendingDirective !== undefined) {
    collectedData.pendingDirective = pendingDirective;
  }

  // Pass through signals bit-identical (reserved for v2.x)
  if (session.signals !== undefined) {
    collectedData.signals = session.signals;
  }

  return {
    currentFlow: session.currentFlow?.id,
    currentStep: session.currentStep?.id,
    collectedData,
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
    currentFlow?: string;
    currentStep?: string;
    collectedData?: CollectedStateData<TData>;
  }
): SessionState<TData> {
  const collectedData: CollectedStateData<TData> = data.collectedData || {
    data: {},
    flowHistory: [],
    history: [],
    metadata: {},
    currentFlowTitle: undefined,
    currentStepDescription: undefined,
  };

  const session: SessionState<TData> = {
    id: sessionId,
    currentFlow: data.currentFlow
      ? {
        id: data.currentFlow,
        title: collectedData.currentFlowTitle || data.currentFlow,
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
    flowHistory: collectedData.flowHistory || [],
    history: collectedData.history || [],
    metadata: collectedData.metadata || {},
  };

  // Restore pendingDirective if present (ignore any legacy pendingTransition — per Req 12.3)
  if (collectedData.pendingDirective !== undefined) {
    session.pendingDirective = collectedData.pendingDirective;
  }

  // Restore signals bit-identical (reserved for v2.x)
  if (collectedData.signals !== undefined) {
    session.signals = collectedData.signals;
  }

  return session;
}


/**
 * Strip pre-LLM-only fields from a directive before persistence.
 *
 * `appendPrompt`, `injectTools`, and `halt` are transient (one-turn lifetime)
 * and must not be serialized. This is a belt-and-suspenders safety net —
 * `Agent.dispatch` already strips before setting `pendingDirective`, and the
 * DirectiveBus's post-LLM drain strips from post-LLM emitters. This function
 * ensures the persistence layer never writes these fields regardless of the
 * upstream path.
 */
function stripPreDirectiveFields<TData>(
  directive: Directive<unknown, TData>
): Directive<unknown, TData> {
  const raw = directive as Record<string, unknown>;
  if (!raw.appendPrompt && !raw.injectTools && raw.halt === undefined) {
    return directive;
  }

  const { appendPrompt, injectTools, halt, ...rest } = raw;

  const droppedFields = [
    appendPrompt && "appendPrompt",
    injectTools && "injectTools",
    halt !== undefined && "halt",
  ].filter(Boolean);

  if (droppedFields.length > 0) {
    logger.warn(
      `[createPersistedState] Ignoring pre-LLM-only fields before persistence (these have no effect outside pre-LLM hooks): ${droppedFields.join(", ")}`
    );
  }

  return rest as Directive<unknown, TData>;
}

/**
 * Prepare a session state for persistence by stripping transient fields.
 *
 * This is the shared helper that every persistence adapter should call before
 * writing session state. It ensures:
 * - `pendingDirective` has pre-LLM-only fields (`appendPrompt`,
 *   `injectTools`, `halt`) stripped (these are one-turn-lifetime and not
 *   serializable across turns).
 * - `pendingDirective` is omitted from the result when `undefined` (adapters
 *   should not store a null/undefined key).
 * - `signals` is passed through bit-identical (reserved for v2.x Signals).
 * - Never writes `pendingTransition`.
 *
 * @param session - The in-memory session state to prepare for persistence.
 * @returns A new session state object safe for serialization.
 */
export function createPersistedState<TData = Record<string, unknown>>(
  session: SessionState<TData>
): SessionState<TData> {
  let pendingDirective: Directive<unknown, TData> | undefined =
    session.pendingDirective;

  if (pendingDirective) {
    pendingDirective = stripPreDirectiveFields(pendingDirective);
  }

  // Build the persisted state — omit pendingDirective key entirely when undefined
  const persisted: SessionState<TData> = {
    id: session.id,
    data: session.data,
    flowHistory: session.flowHistory,
    currentFlow: session.currentFlow,
    currentStep: session.currentStep,
    history: session.history,
    metadata: session.metadata,
  };

  if (pendingDirective !== undefined) {
    persisted.pendingDirective = pendingDirective;
  }

  // Pass through signals bit-identical (reserved for v2.x)
  if (session.signals !== undefined) {
    persisted.signals = session.signals;
  }

  return persisted;
}
