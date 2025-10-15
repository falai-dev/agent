/**
 * ToolExecutor - Simple utility for executing tools with context
 *
 * Tools execute BEFORE message generation to enrich context with data.
 * The LLM sees the enriched context when generating responses.
 */

import type { Event } from "../types/history";
import type { ToolRef, ToolContext } from "../types/tool";

export interface ToolExecutionResult {
  toolName: string;
  success: boolean;
  data?: unknown;
  contextUpdate?: Record<string, unknown>;
  extractedUpdate?: Record<string, unknown>;
  error?: string;
}

export class ToolExecutor<TContext = unknown, TExtracted = unknown> {
  /**
   * Execute a single tool with context and extracted data
   * @param allowedDomains - Array of domain names allowed for this execution context (undefined = all domains allowed)
   */
  async executeTool(
    tool: ToolRef<TContext, unknown[], unknown>,
    context: TContext,
    updateContext: (updates: Partial<TContext>) => Promise<void>,
    history: Event[],
    extracted?: Partial<TExtracted>,
    allowedDomains?: string[]
  ): Promise<ToolExecutionResult> {
    try {
      // Domain enforcement: Check if tool's domain is allowed
      if (allowedDomains !== undefined && tool.domainName) {
        // allowedDomains is explicitly set (could be empty array)
        if (!allowedDomains.includes(tool.domainName)) {
          throw new Error(
            `Domain security violation: Tool "${
              tool.name
            }" belongs to domain "${
              tool.domainName
            }" which is not allowed in this route. Allowed domains: [${allowedDomains.join(
              ", "
            )}]`
          );
        }
      }

      // Build tool context with extracted data
      const toolContext: ToolContext<TContext, TExtracted> = {
        context,
        updateContext,
        history,
        extracted,
      };

      // Execute tool (no arguments - tools read from context/extracted)
      const result = await tool.handler(toolContext);

      // Return execution result
      return {
        toolName: tool.name,
        success: true,
        data: result.data,
        contextUpdate: result.contextUpdate,
        extractedUpdate: result.extractedUpdate,
      };
    } catch (error) {
      return {
        toolName: tool.name,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Execute multiple tools in sequence
   * @param allowedDomains - Array of domain names allowed for this execution context (undefined = all domains allowed)
   */
  async executeTools(
    tools: Array<ToolRef<TContext, unknown[], unknown>>,
    context: TContext,
    updateContext: (updates: Partial<TContext>) => Promise<void>,
    history: Event[],
    extracted?: Partial<TExtracted>,
    allowedDomains?: string[]
  ): Promise<ToolExecutionResult[]> {
    const results: ToolExecutionResult[] = [];

    for (const tool of tools) {
      const result = await this.executeTool(
        tool,
        context,
        updateContext,
        history,
        extracted,
        allowedDomains
      );
      results.push(result);

      // If tool failed, stop execution chain
      if (!result.success) {
        console.error(`[ToolExecutor] Tool ${tool.name} failed:`, result.error);
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
