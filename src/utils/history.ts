/**
 * History normalization utilities
 * Convert simplified history format to internal Event format
 */

import type { Event, MessageEventData, ToolEventData, StatusEventData } from "../types";
import { EventKind, MessageRole } from "../types";
import type { History, HistoryItem, UserHistoryItem, AssistantHistoryItem, ToolHistoryItem } from "../types/history";

/**
 * Convert a simplified history item to an internal Event
 * @param item - The HistoryItem to convert
 * @returns Event with proper type-safe structure
 * @throws Error if the history item is malformed or has invalid data
 */
export function historyItemToEvent(item: HistoryItem): Event<MessageEventData | ToolEventData | StatusEventData> {
  if (!item || typeof item !== 'object') {
    throw new Error('Invalid history item: must be a non-null object');
  }

  if (!item.role || typeof item.role !== 'string') {
    throw new Error('Invalid history item: role is required and must be a string');
  }

  const timestamp = new Date().toISOString();

  switch (item.role) {
    case "user": {
      const userItem = item;
      if (typeof userItem.content !== 'string') {
        throw new Error('Invalid user history item: content must be a string');
      }
      
      return {
        kind: EventKind.MESSAGE,
        source: MessageRole.USER,
        timestamp,
        data: {
          participant: {
            display_name: userItem.name || "User",
          },
          message: userItem.content,
        },
      };
    }
    case "assistant": {
      const assistantItem = item;
      if (assistantItem.content !== null && typeof assistantItem.content !== 'string') {
        throw new Error('Invalid assistant history item: content must be a string or null');
      }

      const event: Event<MessageEventData> = {
        kind: EventKind.MESSAGE,
        source: MessageRole.ASSISTANT,
        timestamp,
        data: {
          participant: {
            display_name: "Assistant",
          },
          message: assistantItem.content || "",
        },
      };

      // If there are tool calls, validate and add them
      if (assistantItem.tool_calls && assistantItem.tool_calls.length > 0) {
        if (!Array.isArray(assistantItem.tool_calls)) {
          throw new Error('Invalid assistant history item: tool_calls must be an array');
        }
        
        for (const toolCall of assistantItem.tool_calls) {
          if (!toolCall.id || !toolCall.name || typeof toolCall.arguments !== 'object') {
            throw new Error('Invalid tool call: id, name, and arguments are required');
          }
        }
        
        event.data.toolCalls = assistantItem.tool_calls;
      }

      return event;
    }
    case "tool": {
      const toolItem = item;
      if (!toolItem.tool_call_id || typeof toolItem.tool_call_id !== 'string') {
        throw new Error('Invalid tool history item: tool_call_id is required and must be a string');
      }
      if (!toolItem.name || typeof toolItem.name !== 'string') {
        throw new Error('Invalid tool history item: name is required and must be a string');
      }

      return {
        kind: EventKind.TOOL,
        source: MessageRole.AGENT,
        timestamp,
        data: {
          tool_calls: [
            {
              tool_id: toolItem.tool_call_id,
              arguments: {}, // Tool results don't have arguments
              result: {
                data: toolItem.content,
              },
            },
          ],
        },
      };
    }
    case "system": {
      const systemItem = item;
      if (typeof systemItem.content !== 'string') {
        throw new Error('Invalid system history item: content must be a string');
      }
      
      return {
        kind: EventKind.MESSAGE,
        source: MessageRole.SYSTEM,
        timestamp,
        data: {
          participant: {
            display_name: "System",
          },
          message: systemItem.content,
        },
      };
    }
    default:
      throw new Error(`Invalid history item role: ${String((item as { role?: unknown }).role)}`);
  }
}

/**
 * Convert an array of HistoryItems to Events
 * @param history - Array of HistoryItems to convert
 * @returns Array of Events with proper type-safe structure
 * @throws Error if any history item is malformed
 */
export function historyToEvents(history: History): Event<MessageEventData | ToolEventData | StatusEventData>[] {
  if (!Array.isArray(history)) {
    throw new Error('Invalid history: must be an array');
  }
  
  return history.map((item, index) => {
    try {
      return historyItemToEvent(item);
    } catch (error) {
      throw new Error(`Error converting history item at index ${index}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  });
}

/**
 * Convert an Event back to a HistoryItem
 * @param event - The Event to convert
 * @returns HistoryItem with simplified structure
 * @throws Error if the event is malformed or has invalid data
 */
export function eventToHistoryItem(event: Event): HistoryItem {
  if (!event || typeof event !== 'object') {
    throw new Error('Invalid event: must be a non-null object');
  }

  if (!event.kind || !event.source || !event.data) {
    throw new Error('Invalid event: kind, source, and data are required');
  }

  switch (event.kind) {
    case EventKind.MESSAGE: {
      const messageData = event.data as MessageEventData;
      if (!messageData.message && messageData.message !== '') {
        throw new Error('Invalid message event: message is required');
      }

      switch (event.source) {
        case MessageRole.USER: {
          const userItem: UserHistoryItem = {
            role: "user",
            content: messageData.message,
          };
          
          if (messageData.participant?.display_name && messageData.participant.display_name !== "User") {
            userItem.name = messageData.participant.display_name;
          }
          
          return userItem;
        }
        case MessageRole.ASSISTANT: {
          const assistantItem: AssistantHistoryItem = {
            role: "assistant",
            content: messageData.message || null,
          };
          
          if (messageData.toolCalls && messageData.toolCalls.length > 0) {
            assistantItem.tool_calls = messageData.toolCalls;
          }
          
          return assistantItem;
        }
        case MessageRole.SYSTEM: {
          return {
            role: "system",
            content: messageData.message,
          };
        }
        default:
          throw new Error(`Unsupported message source for conversion: ${event.source}`);
      }
    }
    case EventKind.TOOL: {
      const toolData = event.data as ToolEventData;
      if (!toolData.tool_calls || !Array.isArray(toolData.tool_calls) || toolData.tool_calls.length === 0) {
        throw new Error('Invalid tool event: tool_calls array is required and must not be empty');
      }

      const firstToolCall = toolData.tool_calls[0];
      if (!firstToolCall.tool_id) {
        throw new Error('Invalid tool call: tool_id is required');
      }

      const toolItem: ToolHistoryItem = {
        role: "tool",
        tool_call_id: firstToolCall.tool_id,
        name: firstToolCall.tool_id, // Use tool_id as name for simplicity
        content: firstToolCall.result?.data,
      };
      
      return toolItem;
    }
    case EventKind.STATUS: {
      // Status events don't have a direct HistoryItem equivalent
      // Convert to system message for compatibility
      const statusData = event.data as StatusEventData;
      return {
        role: "system",
        content: statusData.status || "Status update",
      };
    }
    default:
      throw new Error(`Unsupported event kind for conversion: ${String(event.kind)}`);
  }
}

/**
 * Convert an array of Events back to HistoryItems
 * @param events - Array of Events to convert
 * @returns Array of HistoryItems with simplified structure
 * @throws Error if any event is malformed
 */
export function eventsToHistory(events: Event[]): History {
  if (!Array.isArray(events)) {
    throw new Error('Invalid events: must be an array');
  }
  
  return events.map((event, index) => {
    try {
      return eventToHistoryItem(event);
    } catch (error) {
      throw new Error(`Error converting event at index ${index}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  });
}

/**
 * Normalize a simplified history array to internal Event array
 * @deprecated Use historyToEvents instead
 */
export function normalizeHistory(history: History): Event[] {
  return historyToEvents(history);
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