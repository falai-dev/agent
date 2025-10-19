/**
 * Event utilities and helpers
 */

import type {
  Event,
  EmittedEvent,
  MessageEventData,
  ToolEventData,
  HistoryMessage,
  MessageData,
  HistoryItem,
  History,
} from "../types";
import { EventKind, MessageRole } from "../types";

/**
 * Convert a simple JSON history message to an internal Event
 */
export function convertHistoryMessage<TData = unknown>(
  message: HistoryMessage<TData>
): Event<MessageEventData> {
  return {
    kind: EventKind.MESSAGE,
    source: message.role,
    data: {
      participant: {
        display_name: message.name || getDefaultName(message.role),
      },
      message: message.content,
      session: message.session,
    },
    timestamp: message.timestamp || new Date().toISOString(),
    id: message.metadata?.id as string,
  };
}

/**
 * Get default participant name for a role
 */
function getDefaultName(role: MessageRole): string {
  switch (role) {
    case MessageRole.USER:
      return "User";
    case MessageRole.ASSISTANT:
      return "Assistant";
    case MessageRole.SYSTEM:
      return "System";
    default:
      return "Unknown";
  }
}

/**
 * Convert an array of history messages to Events
 */
export function convertHistoryToEvents<TData = unknown>(
  history: HistoryMessage<TData>[]
): Event[] {
  return history.map(convertHistoryMessage);
}

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

  const sourceMap: Record<MessageRole, string> = {
    [MessageRole.USER]: "user",
    [MessageRole.ASSISTANT]: "assistant",
    [MessageRole.AGENT]: "agent",
    [MessageRole.SYSTEM]: "system",
  };

  return JSON.stringify({
    event_kind: e.kind,
    event_source: sourceMap[e.source],
    data,
  });
}

/**
 * Convert MessageData to HistoryItem
 */
export function convertMessageDataToHistoryItem(
  message: MessageData
): HistoryItem {
  switch (message.role) {
    case MessageRole.USER:
      return {
        role: "user",
        content: message.content,
      };
    case MessageRole.ASSISTANT:
      return {
        role: "assistant",
        content: message.content,
        tool_calls: message.toolCalls?.map((tc, index) => ({
          id: `call_${index}`, // Generate an ID since MessageData doesn't have tool call IDs
          name: tc.toolName,
          arguments: tc.arguments,
        })),
      };
    case MessageRole.AGENT:
      // Agent role typically represents tool execution results
      // Since we don't have tool_call_id in MessageData, we'll use a placeholder
      return {
        role: "tool",
        tool_call_id: "unknown", // MessageData doesn't store tool call IDs
        name: "unknown_tool",
        content: message.content,
      };
    case MessageRole.SYSTEM:
      return {
        role: "system",
        content: message.content,
      };
    default:
      // Fallback for unknown roles
      return {
        role: "system",
        content: message.content,
      };
  }
}

/**
 * Convert an array of MessageData to History (HistoryItem[])
 */
export function convertMessagesToHistory(messages: MessageData[]): History {
  return messages.map(convertMessageDataToHistoryItem);
}
