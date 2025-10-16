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
export function defineTool<
  TContext = unknown,
  TArgs extends unknown[] = unknown[],
  TResult = unknown
>(
  name: string,
  handler: ToolHandler<TContext, TArgs, TResult>,
  options?: {
    id?: string;
    description?: string;
    parameters?: unknown;
  }
): ToolRef<TContext, TArgs, TResult>;
export function defineTool<
  TContext = unknown,
  TArgs extends unknown[] = unknown[],
  TResult = unknown
>(options: {
  name: string;
  handler: ToolHandler<TContext, TArgs, TResult>;
  id?: string;
  description?: string;
  parameters?: unknown;
}): ToolRef<TContext, TArgs, TResult>;
export function defineTool<
  TContext = unknown,
  TArgs extends unknown[] = unknown[],
  TResult = unknown
>(
  nameOrOptions:
    | string
    | {
        name: string;
        handler: ToolHandler<TContext, TArgs, TResult>;
        id?: string;
        description?: string;
        parameters?: unknown;
      },
  handler?: ToolHandler<TContext, TArgs, TResult>,
  options?: {
    id?: string;
    description?: string;
    parameters?: unknown;
  }
): ToolRef<TContext, TArgs, TResult> {
  if (typeof nameOrOptions === "string") {
    // Original signature: defineTool(name, handler, options)
    const name = nameOrOptions;
    const id = options?.id || generateToolId(name);

    return {
      id,
      name,
      handler: handler!,
      description: options?.description,
      parameters: options?.parameters,
    };
  } else {
    // New signature: defineTool(options)
    const {
      name,
      handler: newHandler,
      id,
      description,
      parameters,
    } = nameOrOptions;
    const toolId = id || generateToolId(name);

    return {
      id: toolId,
      name,
      handler: newHandler,
      description,
      parameters,
    };
  }
}

/**
 * Re-export types for convenience
 */
export type { ToolContext, ToolHandler, ToolRef, ToolResult };
