/**
 * Tools: typed functions the AI may call while it speaks.
 *
 * A tool returns `{ value?, data? }`: `value` is what the model reads back,
 * `data` is written to the session's collected data. Nothing else; movement
 * between steps belongs to the flow, not to tools.
 */

import type { History } from "./history.js";
import type { StructuredSchema } from "./schema.js";
import type { Run } from "./session.js";

export interface ToolResult<D = unknown> {
  /** What the model sees as the tool's answer. */
  value?: unknown;
  /** Collected data to write. */
  data?: Partial<D>;
}

export interface ToolCtx<C = unknown, D = unknown> {
  context: C;
  data: Partial<D>;
  history: History;
  /** The run that is speaking, when one is. */
  run?: Run;
  now: Date;
}

export interface ToolValidationResult {
  valid: boolean;
  error?: string;
  /** Suggested corrected input. */
  correctedInput?: Record<string, unknown>;
}

export interface ToolPermissionResult {
  allowed: boolean;
  reason?: string;
}

export interface Tool<C = unknown, D = unknown> {
  id: string;
  description?: string;
  parameters?: StructuredSchema;
  handler(args: Record<string, unknown>, ctx: ToolCtx<C, D>): ToolResult<D> | Promise<ToolResult<D>>;

  /** Safe to run alongside other concurrency-safe tools in one round. */
  isConcurrencySafe?(input: Record<string, unknown>): boolean;
  /** Reads only; no side effects. */
  isReadOnly?(input: Record<string, unknown>): boolean;
  /** Irreversible; never run speculatively. */
  isDestructive?(input: Record<string, unknown>): boolean;
  /** Characters of the result kept before truncation. */
  maxResultSizeChars?: number;
  /** Check the model's arguments before the handler runs. */
  validateInput?(
    input: Record<string, unknown>,
    ctx: ToolCtx<C, D>,
  ): ToolValidationResult | Promise<ToolValidationResult>;
  /** When denied, the handler is not invoked and the model is told why. */
  checkPermissions?(
    input: Record<string, unknown>,
    ctx: ToolCtx<C, D>,
  ): ToolPermissionResult | Promise<ToolPermissionResult>;
}
