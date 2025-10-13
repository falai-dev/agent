/**
 * Tool definition and creation utilities
 */

import type {
  ToolContext,
  ToolHandler,
  ToolRef,
  ToolResult,
} from "../types/tool";

let toolIdCounter = 0;

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
    description?: string;
    parameters?: unknown;
  }
): ToolRef<TContext, TArgs, TResult> {
  const id = `tool_${++toolIdCounter}_${name}`;

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
