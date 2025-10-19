/**
 * History normalization utilities
 * Convert simplified history format to internal Event format
 */

import type { Event, MessageEventData } from "../types";
import { EventKind, MessageRole } from "../types";
import type { History, HistoryItem } from "../types/history";

/**
 * Convert a simplified history item to an internal Event
 */
function convertHistoryItemToEvent(item: HistoryItem): Event {
  const timestamp = new Date().toISOString();

  switch (item.role) {
    case "user": {
      return {
        kind: EventKind.MESSAGE,
        source: MessageRole.USER,
        timestamp,
        data: {
          participant: {
            display_name: item.name || "User",
          },
          message: item.content,
        },
      };
    }
    case "assistant": {
      // Handle assistant message with optional tool calls
      const event: Event = {
        kind: EventKind.MESSAGE,
        source: MessageRole.ASSISTANT,
        timestamp,
        data: {
          participant: {
            display_name: "Assistant",
          },
          message: item.content || "",
        },
      };

      // If there are tool calls, we need to create a separate tool event
      // But for now, we'll just store the tool calls in the message data
      if (item.tool_calls && item.tool_calls.length > 0) {
        (event.data as MessageEventData).toolCalls = item.tool_calls;
      }

      return event;
    }
    case "tool": {
      return {
        kind: EventKind.TOOL,
        source: MessageRole.AGENT,
        timestamp,
        data: {
          tool_calls: [
            {
              tool_id: item.tool_call_id,
              arguments: {}, // Tool results don't have arguments
              result: {
                data: item.content,
              },
            },
          ],
        },
      };
    }
    case "system": {
      return {
        kind: EventKind.MESSAGE,
        source: MessageRole.SYSTEM,
        timestamp,
        data: {
          participant: {
            display_name: "System",
          },
          message: item.content,
        },
      };
    }
    default:
      // This should never happen due to TypeScript, but fallback just in case
      return {
        kind: EventKind.MESSAGE,
        source: MessageRole.SYSTEM,
        timestamp,
        data: {
          participant: {
            display_name: "Unknown",
          },
          message: "Unknown message type",
        },
      };
  }
}

/**
 * Normalize a simplified history array to internal Event array
 */
export function normalizeHistory(history: History): Event[] {
  return history.map(convertHistoryItemToEvent);
}

/**
 * Helper function to create a user message
 */
export function userMessage(content: string, name?: string): HistoryItem {
  return { role: "user", content, name };
}

/**
 * Helper function to create an assistant message
 */
export function assistantMessage(
  content: string | null,
  toolCalls?: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }>
): HistoryItem {
  return { role: "assistant", content, tool_calls: toolCalls };
}

/**
 * Helper function to create a tool message
 */
export function toolMessage(
  toolCallId: string,
  name: string,
  content: unknown
): HistoryItem {
  return { role: "tool", tool_call_id: toolCallId, name, content };
}

/**
 * Helper function to create a system message
 */
export function systemMessage(content: string): HistoryItem {
  return { role: "system", content };
}
