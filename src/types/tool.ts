/**
 * Tool system type definitions
 */

import type { Event, StepRef } from "./index";

/**
 * Context provided to tool handlers
 */
export interface ToolContext<TContext = unknown, TData = unknown> {
  /** The agent's context data */
  context: TContext;
  /** Update the agent's context (triggers lifecycle hooks if configured) */
  updateContext: (updates: Partial<TContext>) => Promise<void>;
  /** Update the agent's collected data (triggers lifecycle hooks if configured) */
  updateData: (updates: Partial<TData>) => Promise<void>;
  /** Current step reference (if in a route) */
  step?: StepRef;
  /** Interaction history */
  history: Event[];
  /** Complete agent-level data collected so far */
  data?: Partial<TData>;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Result returned by a tool
 */
export interface ToolResult<
  TResultData = unknown,
  TContext = unknown,
  TData = unknown
> {
  /** The result data */
  data?: TResultData;
  /** Optional context update to be merged with current context */
  contextUpdate?: Partial<TContext>;
  /** Optional agent-level data update to be merged with collected data */
  dataUpdate?: Partial<TData>;
  /** Success indicator */
  success?: boolean;
  /** Error message if operation failed */
  error?: string;
  /** Optional metadata about the execution */
  meta?: Record<string, unknown>;
}

/**
 * Handler function for a tool
 */
export type ToolHandler<
  TContext,
  TData = unknown,
  TArgs extends unknown[] = unknown[],
  TResult = unknown
> = (
  context: ToolContext<TContext, TData>,
  ...args: TArgs
) =>
  | Promise<ToolResult<TResult, TContext, TData>>
  | ToolResult<TResult, TContext, TData>;

/**
 * Tool definition - plain object interface
 */
export interface Tool<
  TContext = unknown,
  TData = unknown,
  TArgs extends unknown[] = unknown[],
  TResult = unknown
> {
  /** Tool identifier */
  id: string;
  /** Tool display name (shown to AI models) */
  name?: string;
  /** Tool handler function */
  handler: ToolHandler<TContext, TData, TArgs, TResult>;
  /** Description of what the tool does (for AI discovery) */
  description?: string;
  /** Parameter schema or description */
  parameters?: unknown;
}
