/**
 * ToolExecutor - Simple utility for executing tools with context
 *
 * Tools execute BEFORE message generation to enrich context with data.
 * The LLM sees the enriched context when generating responses.
 */

import type { Event, Tool, ToolContext } from "../types";

export interface ToolExecutionResult {
  toolName: string;
  success: boolean;
  data?: unknown;
  contextUpdate?: Record<string, unknown>;
  dataUpdate?: Record<string, unknown>;
  error?: string;
}

export interface ExecuteToolParams<TContext = unknown, TData = unknown> {
  tool: Tool<TContext, unknown[], unknown>;
  context: TContext;
  updateContext: (updates: Partial<TContext>) => Promise<void>;
  history: Event[];
  data?: Partial<TData>;
}

export interface ExecuteToolsParams<TContext = unknown, TData = unknown> {
  tools: Array<Tool<TContext, unknown[], unknown>>;
  context: TContext;
  updateContext: (updates: Partial<TContext>) => Promise<void>;
  history: Event[];
  data?: Partial<TData>;
}

export class ToolExecutor<TContext = unknown, TData = unknown> {
  /**
   * Execute a single tool with context and collected data
   * @param params - Execution parameters
   */
  async executeTool(
    params: ExecuteToolParams<TContext, TData>
  ): Promise<ToolExecutionResult> {
    const { tool, context, updateContext, history, data } = params;
    try {
      // Build tool context with collected data
      const toolContext: ToolContext<TContext, TData> = {
        context,
        updateContext,
        history,
        data,
      };

      // Execute tool
      const result = await tool.handler(toolContext);

      // Return execution result
      return {
        toolName: tool.id || "unknown",
        success: true,
        data: result.data,
        contextUpdate: result.contextUpdate,
        dataUpdate: result.dataUpdate,
      };
    } catch (error) {
      return {
        toolName: tool.id || "unknown",
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Execute multiple tools in sequence
   * @param params - Execution parameters
   */
  async executeTools(
    params: ExecuteToolsParams<TContext, TData>
  ): Promise<ToolExecutionResult[]> {
    const { tools, context, updateContext, history, data } = params;
    const results: ToolExecutionResult[] = [];

    for (const tool of tools) {
      const result = await this.executeTool({
        tool,
        context,
        updateContext,
        history,
        data,
      });
      results.push(result);

      // If tool failed, stop execution chain
      if (!result.success) {
        console.error(
          `[ToolExecutor] Tool ${tool.id || "unknown"} failed:`,
          result.error
        );
        break;
      }

      // Apply context updates from tool result
      if (result.contextUpdate) {
        await updateContext(result.contextUpdate as Partial<TContext>);
      }
    }

    return results;
  }
}
