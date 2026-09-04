/**
 * Serialization utilities for tool results and other data
 */

import type { Directive } from "../types/flow.js";
import type { ToolResult } from "../types/tool.js";

/**
 * Decide whether a tool handler's return value is a ToolResult-shaped object.
 * Only SEMANTIC markers identify one — bare `{data}` / `{error}` shapes are
 * indistinguishable from ordinary business payloads (e.g. upstream API
 * envelopes) and must be wrapped as raw results instead. Shared by the
 * sequential (ToolManager) and concurrent (StreamingToolExecutor) paths so the
 * definition of "is a ToolResult" can't drift between them.
 */
export function isToolResultLike(result: unknown): result is ToolResult {
  return (
    result !== null &&
    typeof result === "object" &&
    (("success" in result &&
      typeof (result as Record<string, unknown>).success === "boolean") ||
      "directive" in result ||
      "directives" in result ||
      "dataUpdate" in result ||
      "contextUpdate" in result)
  );
}

/**
 * Collect a ToolResult's directives — `{directive}` (singular shorthand) and
 * `{directives}` both count. Singular merges FIRST so plural entries win reply
 * ties (last-wins merge), identical on both executor paths.
 */
export function extractResultDirectives<TContext = unknown, TData = unknown>(
  result: ToolResult<unknown, TContext, TData>
): Directive<TContext, TData>[] {
  const directives: Directive<TContext, TData>[] = [];
  if (result.directive) directives.push(result.directive);
  if (Array.isArray(result.directives)) directives.push(...result.directives);
  return directives;
}

/**
 * Serialize a tool execution result into a string suitable for conversation history.
 *
 * Priority:
 *   1. Failed result → error message
 *   2. String data   → returned as-is
 *   3. Object data   → JSON.stringify (with circular-reference safety)
 *   4. Primitive data → String()
 *   5. No data       → "Tool executed successfully"
 */
export function serializeToolResult(result: {
  success: boolean;
  data?: unknown;
  error?: string;
}): string {
  if (!result.success) {
    return `Tool execution failed: ${result.error || "Unknown error"}`;
  }

  if (result.data === undefined || result.data === null) {
    return "Tool executed successfully";
  }

  if (typeof result.data === "string") {
    return result.data;
  }

  // Primitives (number, boolean) are safe to stringify directly
  if (typeof result.data !== "object") {
    return JSON.stringify(result.data);
  }

  // Objects / arrays — guard against circular references
  try {
    return JSON.stringify(result.data);
  } catch {
    // Circular or otherwise un-serializable object: extract what we can
    const keys = Object.keys(result.data as Record<string, unknown>);
    if (keys.length > 0) {
      return `Tool returned object with keys: ${keys.join(", ")}`;
    }
    return "Tool executed successfully (result could not be serialized)";
  }
}
