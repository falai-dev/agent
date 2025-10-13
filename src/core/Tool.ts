/**
 * Tool definition and creation utilities
 */

import type {
  ToolContext,
  ToolHandler,
  ToolRef,
  ToolResult,
} from "../types/tool";
import { generateToolId } from "../utils/id";

/**
 * Define a new tool with type-safe context and arguments
 *
 * @param name - Name of the tool
 * @param handler - Handler function that executes the tool
 * @param options - Optional configuration
 * @returns A reference to the defined tool
 *
 * @example
 * ```ts
 * const getTool = defineTool<MyContext, [string, number], string>(
 *   'get_data',
 *   async ({ context }, id, count) => {
 *     return { data: `Retrieved ${count} items for ${id}` };
 *   }
 * );
 * ```
 */
export function defineTool<TContext, TArgs extends unknown[], TResult>(
  name: string,
  handler: ToolHandler<TContext, TArgs, TResult>,
  options?: {
    id?: string;
    description?: string;
    parameters?: unknown;
  }
): ToolRef<TContext, TArgs, TResult> {
  // Use provided ID or generate a deterministic one from the name
  const id = options?.id || generateToolId(name);

  return {
    id,
    name,
    handler,
    description: options?.description,
    parameters: options?.parameters,
  };
}

/**
 * Re-export types for convenience
 */
export type { ToolContext, ToolHandler, ToolRef, ToolResult };
