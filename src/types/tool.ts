/**
 * Tool system type definitions
 */

import type { Event, StateRef } from "./index";

/**
 * Context provided to tool handlers
 */
export interface ToolContext<TContext = unknown> {
  /** The agent's context data */
  context: TContext;
  /** Current state reference (if in a route) */
  state?: StateRef;
  /** Interaction history */
  history: Event[];
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Result returned by a tool
 */
export interface ToolResult<TData = unknown> {
  /** The result data */
  data: TData;
  /** Optional metadata about the execution */
  meta?: Record<string, unknown>;
}

/**
 * Handler function for a tool
 */
export type ToolHandler<TContext, TArgs extends unknown[], TResult> = (
  context: ToolContext<TContext>,
  ...args: TArgs
) => Promise<ToolResult<TResult>> | ToolResult<TResult>;

/**
 * Reference to a defined tool
 */
export interface ToolRef<TContext, TArgs extends unknown[], TResult> {
  /** Tool identifier */
  id: string;
  /** Tool name */
  name: string;
  /** Tool handler function */
  handler: ToolHandler<TContext, TArgs, TResult>;
  /** Description of what the tool does */
  description?: string;
  /** Parameter schema or description */
  parameters?: unknown;
}
