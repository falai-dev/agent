/**
 * Tool system type definitions
 */

import type { Event, StateRef } from "./index";

/**
 * Context provided to tool handlers
 */
export interface ToolContext<TContext = unknown, TExtracted = unknown> {
  /** The agent's context data */
  context: TContext;
  /** Update the agent's context (triggers lifecycle hooks if configured) */
  updateContext: (updates: Partial<TContext>) => Promise<void>;
  /** Current state reference (if in a route) */
  state?: StateRef;
  /** Interaction history */
  history: Event[];
  /** Data extracted so far in the current route */
  extracted?: Partial<TExtracted>;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Result returned by a tool
 */
export interface ToolResult<
  TData = unknown,
  TContext = unknown,
  TExtracted = unknown
> {
  /** The result data */
  data: TData;
  /** Optional context update to be merged with current context */
  contextUpdate?: Partial<TContext>;
  /** Optional extracted data update to be merged with session state */
  extractedUpdate?: Partial<TExtracted>;
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
  TExtracted = unknown
> = (
  context: ToolContext<TContext, TExtracted>,
  ...args: TArgs
) =>
  | Promise<ToolResult<TResult, TContext, TExtracted>>
  | ToolResult<TResult, TContext, TExtracted>;

/**
 * Reference to a defined tool
 */
export interface ToolRef<
  TContext,
  TArgs extends unknown[],
  TResult,
  TExtracted = unknown
> {
  /** Tool identifier */
  id: string;
  /** Tool name */
  name: string;
  /** Tool handler function */
  handler: ToolHandler<TContext, TArgs, TResult, TExtracted>;
  /** Description of what the tool does */
  description?: string;
  /** Parameter schema or description */
  parameters?: unknown;
  /** Domain this tool belongs to (set when added via agent.addDomain) */
  domainName?: string;
}
