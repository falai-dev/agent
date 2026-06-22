/**
 * Shared pre-execution gates for tool calls.
 *
 * A tool's `validateInput` and `checkPermissions` hooks must be applied
 * identically regardless of how the call is executed. Previously the gates
 * lived only in `ToolManager.executeTool` (the sequential `generate()`/
 * `respond()` path), so the streaming path (`StreamingToolExecutor`, used by
 * `stream()`) invoked handlers without them — a documented authorization gate
 * ("when denied, handler is NOT invoked") was silently a no-op on one
 * transport. Centralizing the logic here keeps both executors in lockstep.
 */
import type { Tool, ToolContext, ToolExecutionResult } from "../types/tool";
import { logger } from "../utils";

/**
 * Run a tool's pre-execution gates in order: `validateInput`, then
 * `checkPermissions`. Returns a failed `ToolExecutionResult` when a gate
 * blocks the call (the handler must NOT be invoked), or `null` when both
 * gates pass.
 *
 * @param startTime - optional execution start time (ms from `Date.now()`).
 *   When provided, denial metadata includes `executionTime`, matching the
 *   sequential executor's result shape; omit it on the streaming path.
 */
export async function evaluateToolGates<TContext, TData>(
  tool: Tool<TContext, TData>,
  toolArguments: Record<string, unknown> | undefined,
  toolContext: ToolContext<TContext, TData>,
  startTime?: number
): Promise<ToolExecutionResult | null> {
  // Tool validation gate (Req 6.1, 6.7)
  if (typeof tool.validateInput === "function" && toolArguments) {
    const validation = await tool.validateInput(toolArguments, toolContext);
    if (!validation.valid) {
      logger.warn(
        `[DataValidationError] Tool "${tool.id}" input validation failed: ${validation.error}. Fix the tool call arguments to match the expected schema.`
      );
      return {
        success: false,
        error: `Validation failed: ${validation.error || "Invalid input"}`,
        metadata: {
          toolId: tool.id,
          ...(startTime !== undefined ? { executionTime: Date.now() - startTime } : {}),
          gate: "validateInput",
        },
      };
    }
  }

  // Tool permission gate (Req 6.7, 6.8)
  // When denied: do not invoke handler, do not process directives, do not apply state writes
  if (typeof tool.checkPermissions === "function" && toolArguments) {
    const permission = await tool.checkPermissions(toolArguments, toolContext);
    if (!permission.allowed) {
      logger.warn(
        `[ToolExecutionError] Tool "${tool.id}" permission denied: ${permission.reason}. The tool's checkPermissions hook rejected this call.`
      );
      return {
        success: false,
        error: `Permission denied: ${permission.reason || "Not allowed"}`,
        metadata: {
          toolId: tool.id,
          ...(startTime !== undefined ? { executionTime: Date.now() - startTime } : {}),
          gate: "checkPermissions",
          canOverride: permission.canOverride,
        },
      };
    }
  }

  return null;
}
