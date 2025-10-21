/* eslint @typescript-eslint/no-explicit-any: "off"*/
/**
 * Tool system type definitions
 */

import type { Event, StepRef, ValidationResult } from "./index";

/**
 * Context provided to tool handlers
 */
export interface ToolContext<TContext = any, TData = any> {
  /** The agent's context data */
  context: TContext;
  /** Complete agent-level data collected so far */
  data: Partial<TData>;
  /** Interaction history */
  history: Event[];
  /** Current step reference (if in a route) */
  step?: StepRef;
  /** Additional metadata */
  metadata?: Record<string, unknown>;

  /** Update the agent's context (triggers lifecycle hooks if configured) */
  updateContext: (updates: Partial<TContext>) => Promise<void>;
  /** Update the agent's collected data (triggers lifecycle hooks if configured) */
  updateData: (updates: Partial<TData>) => Promise<void>;
  /** Get a specific field from collected data */
  getField<K extends keyof TData>(key: K): TData[K] | undefined;
  /** Set a specific field in collected data */
  setField<K extends keyof TData>(key: K, value: TData[K]): Promise<void>;
  /** Check if a field exists in collected data */
  hasField<K extends keyof TData>(key: K): boolean;
}

/**
 * Result returned by a tool
 */
export interface ToolResult<
  TResultData = any,
  TContext = any,
  TData = any
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
  TContext = any,
  TData = any,
  TResult = any
> = (
  context: ToolContext<TContext, TData>,
  args?: Record<string, unknown>
) =>
    | Promise<TResult | ToolResult<TResult, TContext, TData>>
    | TResult
    | ToolResult<TResult, TContext, TData>;

/**
 * Tool definition - plain object interface
 */
export interface Tool<
  TContext = any,
  TData = any,
  TResult = any
> {
  /** Tool identifier */
  id: string;
  /** Tool display name (shown to AI models) */
  name?: string;
  /** Tool handler function */
  handler: ToolHandler<TContext, TData, TResult>;
  /** Description of what the tool does (for AI discovery) */
  description?: string;
  /** Parameter schema or description */
  parameters?: unknown;
}



/**
 * Tool execution result
 */
export interface ToolExecutionResult {
  success: boolean;
  data?: unknown;
  error?: string;
  contextUpdate?: Record<string, unknown>;
  dataUpdate?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

/**
 * Tool scope enumeration
 */
export enum ToolScope {
  AGENT = 'agent',
  ROUTE = 'route',
  STEP = 'step',
  REGISTERED = 'registered',
  ALL = 'all'
}



/**
 * Configuration for data enrichment tools
 */
export interface DataEnrichmentConfig<TContext, TData, TFields extends keyof TData> {
  id: string;
  name?: string;
  description?: string;
  fields: TFields[];
  enricher: (
    context: TContext,
    data: Pick<TData, TFields>
  ) => Promise<Partial<TData>> | Partial<TData>;
}

/**
 * Configuration for validation tools
 */
export interface ValidationConfig<TContext, TData, TFields extends keyof TData> {
  id: string;
  name?: string;
  description?: string;
  fields: TFields[];
  validator: (
    context: TContext,
    data: Pick<TData, TFields>
  ) => Promise<ValidationResult> | ValidationResult;
}

/**
 * Configuration for API call tools
 */
export interface ApiCallConfig<TContext, TData, TResult> {
  id: string;
  name?: string;
  description?: string;
  endpoint: string | ((context: TContext, data: Partial<TData>) => string);
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  headers?: Record<string, string> | ((context: TContext) => Record<string, string>);
  body?: (context: TContext, data: Partial<TData>, args?: Record<string, unknown>) => unknown;
  transform?: (response: unknown) => TResult;
}

/**
 * Configuration for computation tools
 */
export interface ComputationConfig<TContext, TData, TResult> {
  id: string;
  name?: string;
  description?: string;
  inputs: (keyof TData)[];
  compute: (
    context: TContext,
    inputs: Partial<TData>,
    args?: Record<string, unknown>
  ) => Promise<TResult> | TResult;
}
