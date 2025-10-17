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
  /** Current step reference (if in a route) */
  step?: StepRef;
  /** Interaction history */
  history: Event[];
  /** Data collected so far in the current route */
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
  data: TResultData;
  /** Optional context update to be merged with current context */
  contextUpdate?: Partial<TContext>;
  /** Optional collected data update to be merged with session step */
  collectedUpdate?: Partial<TData>;
  /** Optional metadata about the execution */
  meta?: Record<string, unknown>;
}

/**
 * Handler function for a tool
 */
export type ToolHandler<
  TContext,
  TArgs extends unknown[],
  TResult,
  TData = unknown
> = (
  context: ToolContext<TContext, TData>,
  ...args: TArgs
) =>
  | Promise<ToolResult<TResult, TContext, TData>>
  | ToolResult<TResult, TContext, TData>;

/**
 * Reference to a defined tool
 */
export interface ToolRef<
  TContext,
  TArgs extends unknown[],
  TResult,
  TData = unknown
> {
  /** Tool identifier */
  id: string;
  /** Tool name */
  name: string;
  /** Tool handler function */
  handler: ToolHandler<TContext, TArgs, TResult, TData>;
  /** Description of what the tool does */
  description?: string;
  /** Parameter schema or description */
  parameters?: unknown;
  /** Domain this tool belongs to (set when added via agent.addDomain) */
  domainName?: string;
}
