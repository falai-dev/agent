/**
 * Event history and interaction types
 */

/**
 * Message source enum - defines valid sources for messages and events
 */
export enum MessageRole {
  /** Message/event from user/customer */
  USER = "user",
  /** Conversational message from AI assistant */
  ASSISTANT = "assistant",
  /** Tool execution/action by AI agent */
  AGENT = "agent",
  /** System message/event */
  SYSTEM = "system",
}

export type MessageRoleType = MessageRole;

import type { SessionState } from "./session";

/**
 * Types of events in the interaction history
 */
export enum EventKind {
  /** A text message event */
  MESSAGE = "message",
  /** A tool execution event */
  TOOL = "tool",
  /** A status update event */
  STATUS = "status",
}

export type EventKindType = EventKind;

/**
 * Participant in a conversation
 */
export interface Participant {
  /** Display name */
  display_name: string;
  /** Unique identifier */
  id?: string;
}

/**
 * Role types for simplified history format
 */
export type Role = "user" | "assistant" | "tool" | "system";

/**
 * Simplified history item for developer-friendly API
 */
export type HistoryItem =
  | {
      role: "user";
      content: string;
      name?: string;
    }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: Array<{
        id: string;
        name: string;
        arguments: Record<string, unknown>;
      }>;
    }
  | {
      role: "tool";
      tool_call_id: string;
      name: string;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      content: any;
    }
  | {
      role: "system";
      content: string;
    };

/**
 * Simplified history array type
 */
export type History = HistoryItem[];

/**
 * Simple JSON format for history messages (developer-friendly)
 */
export interface HistoryMessage<TData = unknown> {
  /** Role of the message sender */
  role: MessageRole;
  /** Message content */
  content: string;
  /** Optional participant name */
  name?: string;
  /** Optional timestamp (ISO string) */
  timestamp?: string;
  /** Optional session state */
  session?: SessionState<TData>;
  /** Optional additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Data for a message event
 */
export interface MessageEventData {
  /** The participant who sent the message */
  participant: Participant;
  /** The message content */
  message: string;
  /** Whether the message was flagged/censored */
  flagged?: boolean;
  /** Tags/reasons if flagged */
  tags?: string[];
  /** Tool calls made by the assistant */
  toolCalls?: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }>;
  /** Session metadata attached to this message */
  session?: {
    routeId?: string;
    routeTitle?: string;
    stepId?: string;
    stepDescription?: string;
    data?: Record<string, unknown>;
  };
}

/**
 * Result of a tool execution
 */
export interface ToolResult<TData = unknown> {
  /** The result data */
  data: TData;
  /** Optional metadata */
  meta?: Record<string, unknown>;
}

/**
 * A single tool call within a tool event
 */
export interface ToolCall<TArgs = unknown, TResult = unknown> {
  /** Tool identifier */
  tool_id: string;
  /** Arguments passed to the tool */
  arguments: TArgs;
  /** Result returned by the tool */
  result: ToolResult<TResult>;
}

/**
 * Data for a tool event
 */
export interface ToolEventData {
  /** Array of tool calls executed */
  tool_calls: ToolCall[];
}

/**
 * Data for a status event
 */
export interface StatusEventData {
  /** Status message */
  status: string;
  /** Additional details */
  details?: Record<string, unknown>;
}

/**
 * Base event structure
 */
export interface Event<
  TData = MessageEventData | ToolEventData | StatusEventData
> {
  /** Type of event */
  kind: EventKind;
  /** Source of the event */
  source: MessageRole;
  /** Event-specific data */
  data: TData;
  /** Timestamp (ISO string) */
  timestamp?: string;
  /** Unique event identifier */
  id?: string;
}

/**
 * An emitted event (staged for inclusion)
 */
export interface EmittedEvent<
  TData = MessageEventData | ToolEventData | StatusEventData
> extends Event<TData> {
  /** Whether this event has been committed */
  committed?: boolean;
}
