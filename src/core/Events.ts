/**
 * Event utilities and helpers
 */

import type {
  Event,
  EmittedEvent,
  MessageEventData,
  ToolEventData,
  ToolCall,
} from "../types/history";
import { EventKind, EventSource } from "../types/history";

/**
 * Adapt an event for inclusion in prompts
 * Transforms event data into a serializable format
 */
export function adaptEvent(e: Event | EmittedEvent): string {
  let data: unknown = e.data;

  if (e.kind === EventKind.MESSAGE) {
    const messageData = e.data as MessageEventData;

    if (messageData.flagged) {
      data = {
        participant: messageData.participant.display_name,
        message: "<N/A>",
        censored: true,
        reasons: messageData.tags,
      };
    } else {
      data = {
        participant: messageData.participant.display_name,
        message: messageData.message,
      };
    }
  }

  if (e.kind === EventKind.TOOL) {
    const toolData = e.data as ToolEventData;

    data = {
      tool_calls: toolData.tool_calls.map((tc) => ({
        tool_id: tc.tool_id,
        arguments: tc.arguments,
        result: tc.result.data,
      })),
    };
  }

  const sourceMap: Record<EventSource, string> = {
    [EventSource.CUSTOMER]: "user",
    [EventSource.CUSTOMER_UI]: "frontend_application",
    [EventSource.HUMAN_AGENT]: "human_service_agent",
    [EventSource.HUMAN_AGENT_ON_BEHALF_OF_AI_AGENT]: "ai_agent",
    [EventSource.AI_AGENT]: "ai_agent",
    [EventSource.SYSTEM]: "system-provided",
  };

  return JSON.stringify({
    event_kind: e.kind,
    event_source: sourceMap[e.source],
    data,
  });
}

/**
 * Create a message event
 */
export function createMessageEvent(
  source: EventSource,
  participantName: string,
  message: string,
  options?: {
    timestamp?: string;
    session?: {
      routeId?: string;
      routeTitle?: string;
      stateId?: string;
      stateDescription?: string;
      extracted?: Record<string, unknown>;
    };
  }
): Event<MessageEventData>;
export function createMessageEvent(options: {
  source: EventSource;
  participantName: string;
  message: string;
  timestamp?: string;
  session?: {
    routeId?: string;
    routeTitle?: string;
    stateId?: string;
    stateDescription?: string;
    extracted?: Record<string, unknown>;
  };
}): Event<MessageEventData>;
export function createMessageEvent(
  sourceOrOptions:
    | EventSource
    | {
        source: EventSource;
        participantName: string;
        message: string;
        timestamp?: string;
        session?: {
          routeId?: string;
          routeTitle?: string;
          stateId?: string;
          stateDescription?: string;
          extracted?: Record<string, unknown>;
        };
      },
  participantName?: string,
  message?: string,
  options?: {
    timestamp?: string;
    session?: {
      routeId?: string;
      routeTitle?: string;
      stateId?: string;
      stateDescription?: string;
      extracted?: Record<string, unknown>;
    };
  }
): Event<MessageEventData> {
  if (typeof sourceOrOptions === "object") {
    // New signature: createMessageEvent(options)
    const {
      source,
      participantName: pName,
      message: msg,
      ...restOptions
    } = sourceOrOptions;
    return {
      kind: EventKind.MESSAGE,
      source,
      data: {
        participant: { display_name: pName },
        message: msg,
        session: restOptions.session,
      },
      timestamp: restOptions.timestamp || new Date().toISOString(),
    };
  } else {
    // Original signature: createMessageEvent(source, participantName, message, options)
    return {
      kind: EventKind.MESSAGE,
      source: sourceOrOptions,
      data: {
        participant: { display_name: participantName! },
        message: message!,
        session: options?.session,
      },
      timestamp: options?.timestamp || new Date().toISOString(),
    };
  }
}

/**
 * Create a tool event
 */
export function createToolEvent(
  source: EventSource,
  toolCalls: ToolCall[],
  timestamp?: string
): Event<ToolEventData> {
  return {
    kind: EventKind.TOOL,
    source,
    data: {
      tool_calls: toolCalls,
    },
    timestamp: timestamp || new Date().toISOString(),
  };
}
