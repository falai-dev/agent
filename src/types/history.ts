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

export type UserHistoryItem = {
  role: "user";
  content: string;
  name?: string;
};

export type AssistantHistoryItem = {
  role: "assistant";
  content: string | null;
  tool_calls?: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }>;
  /** What the model thought before it called those tools. A thinking provider
   *  rejects the next round without it. Set by the framework on its own tool
   *  rounds; a host building history by hand leaves it out. */
  reasoning?: string;
  /** The same thing in the normalized shape OpenRouter sends. Replayed
   *  verbatim, under the name the gateway gave it. */
  reasoningDetails?: unknown[];
};
export type ToolHistoryItem = {
  role: "tool";
  tool_call_id: string;
  name: string;
  content: unknown;
};

export type SystemHistoryItem = {
  role: "system";
  content: string;
};

/**
 * Simplified history item for developer-friendly API
 */
export type HistoryItem =
  | UserHistoryItem
  | AssistantHistoryItem
  | ToolHistoryItem
  | SystemHistoryItem;

/**
 * Simplified history array type
 */
export type History = HistoryItem[];

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
