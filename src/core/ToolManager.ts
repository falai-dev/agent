/**
 * ToolManager - Centralized tool management with simplified creation APIs
 */

import type {
  Tool,
  ToolResult,
  ToolExecutionResult,
  DataEnrichmentConfig,
  ValidationConfig,
  ValidationResult,
  ApiCallConfig,
  ComputationConfig,
  ToolContext,
  ToolCallRequest,
  ToolExecutionUpdate,
  Event,
} from "../types";
import type { Directive } from "../types/flow";
import { ToolScope } from "../types";
import { logger } from "../utils";
import { Agent } from "./Agent";
import { Flow } from "./Flow";
import { Step } from "./Step";
import { StreamingToolExecutor } from "./StreamingToolExecutor";

/**
 * Error thrown when tool creation fails
 */
export class ToolCreationError extends Error {
  constructor(
    message: string,
    public readonly toolId: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'ToolCreationError';
  }
}

/**
 * Error thrown when tool execution fails
 */
export class ToolExecutionError extends Error {
  constructor(
    message: string,
    public readonly toolId: string,
    public readonly executionContext?: Record<string, unknown>,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'ToolExecutionError';
  }
}



/**
 * ToolManager - Centralized tool management with simplified APIs
 */
export class ToolManager<TContext = unknown, TData = unknown> {
  private toolRegistry: Map<string, Tool<TContext, TData>>;

  /**
   * Per-turn transient tool layer populated from Directive.injectTools.
   * Resolution order: transient → step → flow → agent.
   * Drained at end of turn via try/finally guard.
   *
   * Tools are deduplicated by `id` with last-definition-wins when
   * multiple pre-LLM emitters contribute tools in the same turn.
   */
  private transientTools: Map<string, Tool<TContext, TData>> = new Map();

  constructor(private agent: Agent<TContext, TData>) {
    this.toolRegistry = new Map();
  }

  /**
   * Set the transient tool layer for the current turn.
   *
   * Accepts the merged `injectTools` array from pre-LLM emitters
   * (already concatenated in outer-to-inner order by the DirectiveBus).
   * Deduplicates by tool `id` with last-definition-wins.
   *
   * Must be paired with `clearTransientTools()` in a try/finally guard
   * so the layer is drained even on abnormal termination.
   */
  setTransientTools(tools: Tool<TContext, TData>[]): void {
    this.transientTools.clear();
    for (const tool of tools) {
      this.transientTools.set(tool.id, tool);
    }
    if (this.transientTools.size > 0) {
      logger.debug(
        `[ToolManager] Set transient tools for turn: ${Array.from(this.transientTools.keys()).join(', ')}`
      );
    }
  }

  /**
   * Clear the transient tool layer. Called at end of turn via try/finally
   * guard so tools do not leak into subsequent turns.
   */
  clearTransientTools(): void {
    if (this.transientTools.size > 0) {
      logger.debug(
        `[ToolManager] Cleared transient tools: ${Array.from(this.transientTools.keys()).join(', ')}`
      );
    }
    this.transientTools.clear();
  }

  /**
   * Check whether the transient layer currently has any tools.
   * Useful for testing and debugging.
   */
  hasTransientTools(): boolean {
    return this.transientTools.size > 0;
  }

  /**
   * Validate a tool definition for completeness and correctness
   */
  private validateToolDefinition(
    definition: Tool<TContext, TData>
  ): void {
    const errors: string[] = [];

    // Required fields validation
    if (!definition.id || typeof definition.id !== 'string') {
      errors.push('Tool ID is required and must be a non-empty string');
    } else if (definition.id.trim() === '') {
      errors.push('Tool ID cannot be empty or whitespace only');
    } else if (!/^[a-zA-Z0-9_-]+$/.test(definition.id)) {
      errors.push('Tool ID must contain only alphanumeric characters, underscores, and hyphens');
    }

    if (!definition.handler || typeof definition.handler !== 'function') {
      errors.push('Tool handler is required and must be a function');
    }

    if (definition.description !== undefined && (typeof definition.description !== 'string' || definition.description.trim() === '')) {
      errors.push('Tool description must be a non-empty string if provided');
    }

    // Parameters validation (basic JSON schema check)
    if (definition.parameters !== undefined) {
      try {
        if (typeof definition.parameters === 'object' && definition.parameters !== null) {
          // Basic validation for JSON schema structure
          const params = definition.parameters as Record<string, unknown>;
          if ('type' in params && params.type && typeof params.type !== 'string') {
            errors.push('Tool parameters type must be a string if specified');
          }
          if ('properties' in params && params.properties && typeof params.properties !== 'object') {
            errors.push('Tool parameters properties must be an object if specified');
          }
        } else if (typeof definition.parameters !== 'string') {
          errors.push('Tool parameters must be an object (JSON schema) or string if provided');
        }
      } catch {
        errors.push('Tool parameters must be valid JSON schema or string');
      }
    }

    if (errors.length > 0) {
      throw new ToolCreationError(
        `[ToolCreationError] Tool definition validation failed for "${definition.id || 'unknown'}": ${errors.join('; ')}. ` +
        `Fix the tool definition to meet the required schema.`,
        definition.id || 'unknown'
      );
    }
  }

  /**
   * Validate data enrichment configuration
   */
  private validateDataEnrichmentConfig<TFields extends keyof TData>(
    config: DataEnrichmentConfig<TContext, TData, TFields>
  ): void {
    const errors: string[] = [];

    if (!config.fields || !Array.isArray(config.fields) || config.fields.length === 0) {
      errors.push('Data enrichment fields must be a non-empty array');
    }

    if (!config.enricher || typeof config.enricher !== 'function') {
      errors.push('Data enrichment enricher must be a function');
    }

    if (errors.length > 0) {
      throw new ToolCreationError(
        `[ToolCreationError] Data enrichment config validation failed for "${config.id || 'unknown'}": ${errors.join('; ')}. ` +
        `Fix the enrichment config to satisfy the required fields.`,
        config.id || 'unknown'
      );
    }
  }

  /**
   * Validate validation configuration
   */
  private validateValidationConfig<TFields extends keyof TData>(
    config: ValidationConfig<TContext, TData, TFields>
  ): void {
    const errors: string[] = [];

    if (!config.fields || !Array.isArray(config.fields) || config.fields.length === 0) {
      errors.push('Validation fields must be a non-empty array');
    }

    if (!config.validator || typeof config.validator !== 'function') {
      errors.push('Validation validator must be a function');
    }

    if (errors.length > 0) {
      throw new ToolCreationError(
        `[ToolCreationError] Validation config validation failed for "${config.id || 'unknown'}": ${errors.join('; ')}. ` +
        `Fix the validation config to satisfy the required fields.`,
        config.id || 'unknown'
      );
    }
  }

  /**
   * Validate API call configuration
   */
  private validateApiCallConfig<TResult = unknown>(
    config: ApiCallConfig<TContext, TData, TResult>
  ): void {
    const errors: string[] = [];

    if (!config.endpoint) {
      errors.push('API call endpoint is required');
    } else if (typeof config.endpoint !== 'string' && typeof config.endpoint !== 'function') {
      errors.push('API call endpoint must be a string or function');
    }

    if (config.method && !['GET', 'POST', 'PUT', 'DELETE'].includes(config.method)) {
      errors.push('API call method must be one of: GET, POST, PUT, DELETE');
    }

    if (config.headers && typeof config.headers !== 'object' && typeof config.headers !== 'function') {
      errors.push('API call headers must be an object or function');
    }

    if (config.body && typeof config.body !== 'function') {
      errors.push('API call body must be a function');
    }

    if (config.transform && typeof config.transform !== 'function') {
      errors.push('API call transform must be a function');
    }

    if (errors.length > 0) {
      throw new ToolCreationError(
        `[ToolCreationError] API call config validation failed for "${config.id || 'unknown'}": ${errors.join('; ')}. ` +
        `Fix the API call config to satisfy the required fields.`,
        config.id || 'unknown'
      );
    }
  }

  /**
   * Validate computation configuration
   */
  private validateComputationConfig<TResult = unknown>(
    config: ComputationConfig<TContext, TData, TResult>
  ): void {
    const errors: string[] = [];

    if (!config.inputs || !Array.isArray(config.inputs) || config.inputs.length === 0) {
      errors.push('Computation inputs must be a non-empty array');
    }

    if (!config.compute || typeof config.compute !== 'function') {
      errors.push('Computation compute function is required');
    }

    if (errors.length > 0) {
      throw new ToolCreationError(
        `[ToolCreationError] Computation config validation failed for "${config.id || 'unknown'}": ${errors.join('; ')}. ` +
        `Fix the computation config to satisfy the required fields.`,
        config.id || 'unknown'
      );
    }
  }

  /**
   * Create a tool instance with type inference from parent Agent
   * Does not register the tool anywhere - just creates it
   */
  create(
    definition: Tool<TContext, TData>
  ): Tool<TContext, TData> {
    try {
      // Validate the tool definition first
      this.validateToolDefinition(definition);

      logger.debug(`[ToolManager] Created tool: ${definition.id}`);
      return definition;
    } catch (error) {
      throw new ToolCreationError(
        `[ToolCreationError] Failed to create tool "${definition.id}": ${error instanceof Error ? error.message : String(error)}. ` +
        `Ensure the tool definition passes validation.`,
        definition.id,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Register a tool in the registry for later reference by ID
   * Can accept a tool instance
   */
  register(
    tool: Tool<TContext, TData>
  ): Tool<TContext, TData> {
    try {
      if (!tool) {
        throw new ToolCreationError(
          '[ToolCreationError] Tool registration failed: no tool provided. Pass a valid tool object with id and handler.',
          'unknown'
        );
      }

      if (!('handler' in tool) || typeof tool.handler !== 'function') {
        throw new ToolCreationError(
          `[ToolCreationError] Invalid tool for registration: tool "${tool?.id || 'unknown'}" must have a handler function. Add a handler property.`,
          tool?.id || 'unknown'
        );
      }

      // Validate the tool
      if (!tool.id || typeof tool.id !== 'string' || tool.id.trim() === '') {
        throw new ToolCreationError(
          '[ToolCreationError] Tool ID missing: tool ID is required and must be a non-empty string. Provide a unique string id.',
          tool.id || 'unknown'
        );
      }

      // Check for ID conflicts and provide better error context
      if (this.toolRegistry.has(tool.id)) {
        const existingTool = this.toolRegistry.get(tool.id);
        logger.warn(`[ToolManager] Overwriting existing registered tool: ${tool.id} (previous: ${existingTool?.id || 'unnamed'})`);
      }

      this.toolRegistry.set(tool.id, tool);
      logger.debug(`[ToolManager] Registered tool: ${tool.id} (${tool.id || 'unnamed'})`);

      return tool;
    } catch (error) {
      if (error instanceof ToolCreationError) {
        throw error;
      }

      const toolId = tool?.id || 'unknown';
      throw new ToolCreationError(
        `[ToolCreationError] Failed to register tool "${toolId}": ${error instanceof Error ? error.message : String(error)}. ` +
        `Ensure the tool object is valid and has id + handler.`,
        toolId,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Register multiple tools at once
   */
  registerMany(
    tools: Array<Tool<TContext, TData>>
  ): Tool<TContext, TData>[] {
    return tools.map(tool => this.register(tool));
  }

  /**
   * Get a registered tool by ID
   */
  getRegisteredTool(toolId: string): Tool<TContext, TData> | undefined {
    return this.toolRegistry.get(toolId);
  }

  /**
   * Get all registered tools
   */
  getAllRegistered(): Map<string, Tool<TContext, TData>> {
    return new Map(this.toolRegistry);
  }

  /**
   * Check if a tool is registered
   */
  isRegistered(toolId: string): boolean {
    return this.toolRegistry.has(toolId);
  }

  /**
   * Get all registered tool IDs
   */
  getRegisteredIds(): string[] {
    return Array.from(this.toolRegistry.keys());
  }

  /**
   * Get tool by ID from a specific scope
   */
  getFromScope(toolId: string, scope: ToolScope, step?: Step<TContext, TData>, flow?: Flow<TContext, TData>): Tool<TContext, TData> | undefined {
    return this.find(toolId, scope, step, flow);
  }

  /**
   * Check if a tool exists in any scope
   */
  exists(toolId: string, step?: Step<TContext, TData>, flow?: Flow<TContext, TData>): boolean {
    return this.find(toolId, ToolScope.ALL, step, flow) !== undefined;
  }

  /**
   * Get tool count by scope
   */
  getToolCount(scope?: ToolScope, step?: Step<TContext, TData>, flow?: Flow<TContext, TData>): number {
    return this.getAvailable(scope, step, flow).length;
  }

  /**
   * Clear all registered tools
   */
  clearRegistry(): void {
    this.toolRegistry.clear();
    logger.debug('[ToolManager] Cleared tool registry');
  }

  /**
   * Remove a tool from registry
   */
  unregister(toolId: string): boolean {
    const existed = this.toolRegistry.has(toolId);
    this.toolRegistry.delete(toolId);
    if (existed) {
      logger.debug(`[ToolManager] Unregistered tool: ${toolId}`);
    }
    return existed;
  }

  /**
   * Add a tool to the agent scope (creates and adds in one operation)
   */
  addToAgent(
    tool: Tool<TContext, TData>
  ): Tool<TContext, TData> {
    // Validate tool before adding
    if (!tool || !tool.id || !tool.handler) {
      throw new ToolCreationError(
        `[ToolCreationError] Invalid tool for addToAgent: tool must have id and handler properties. ` +
        `Provide a complete tool object with { id, handler, ... }.`,
        tool?.id || 'unknown'
      );
    }

    // Add to agent's tools array using the unified interface
    if (this.agent) {
      this.agent.addTool(tool);
    } else {
      logger.warn(`[ToolManager] No agent available, tool not added to agent scope: ${tool.id}`);
    }

    logger.debug(`[ToolManager] Added tool to agent scope: ${tool.id}`);
    return tool;
  }

  /**
   * Add a tool to a specific flow scope (creates and adds in one operation)
   */
  addToFlow(
    flow: Flow<TContext, TData>,
    tool: Tool<TContext, TData>
  ): Tool<TContext, TData> {
    // Add to flow's tools array using the existing createTool method
    if (flow && typeof flow.createTool === 'function') {
      flow.createTool(tool);
    } else {
      logger.warn(`[ToolManager] Flow does not support createTool method, tool not added to flow scope: ${tool.id}`);
    }

    logger.debug(`[ToolManager] Added tool to flow scope: ${tool.id}`);
    return tool;
  }

  /**
   * Find a tool by ID across different scopes with enhanced resolution logic
   * Priority: transient → step → flow → agent → registry
   * Supports both ID and name matching for better compatibility
   */
  find(toolId: string, scope?: ToolScope, step?: Step<TContext, TData>, flow?: Flow<TContext, TData>): Tool<TContext, TData> | undefined {
    logger.debug(`[ToolManager] Finding tool: ${toolId} with scope: ${scope || 'ALL'}`);

    // Check transient tools first (highest priority — per-turn injectTools)
    if (!scope || scope === ToolScope.ALL) {
      const transientTool = this.transientTools.get(toolId);
      if (transientTool) {
        logger.debug(`[ToolManager] Found tool in transient scope: ${toolId}`);
        return transientTool;
      }
    }

    // Check step-level tools (if step provided and scope allows)
    if (step && (!scope || scope === ToolScope.STEP || scope === ToolScope.ALL)) {
      if (step.tools) {
        for (const toolRef of step.tools) {
          if (typeof toolRef !== 'string') {
            // Inline tool object - check both id and name
            if (toolRef.id === toolId) {
              logger.debug(`[ToolManager] Found tool in step scope: ${toolId}`);
              return toolRef;
            }
          } else {
            // String reference - check if it matches and resolve from registry
            if (toolRef === toolId) {
              const registeredTool = this.toolRegistry.get(toolId);
              if (registeredTool) {
                logger.debug(`[ToolManager] Found tool reference in step, resolved from registry: ${toolId}`);
                return registeredTool;
              }
            }
          }
        }
      }
    }

    // Check flow-level tools (if route provided and scope allows)
    if (flow && (!scope || scope === ToolScope.FLOW || scope === ToolScope.ALL)) {
      if (flow.tools) {
        const flowTool = flow.tools.find((t) => t.id === toolId);
        if (flowTool) {
          logger.debug(`[ToolManager] Found tool in flow scope: ${toolId}`);
          return flowTool;
        }
      }
    }

    // Check agent-level tools (if scope allows)
    if (!scope || scope === ToolScope.AGENT || scope === ToolScope.ALL) {
      if (this.agent) {
        const agentTools = this.agent.getTools();
        const agentTool = agentTools.find((t) => t.id === toolId);
        if (agentTool) {
          logger.debug(`[ToolManager] Found tool in agent scope: ${toolId}`);
          return agentTool;
        }
      }
    }

    // Check registry (if scope allows)
    if (!scope || scope === ToolScope.REGISTERED || scope === ToolScope.ALL) {
      const registeredTool = this.toolRegistry.get(toolId);
      if (registeredTool) {
        logger.debug(`[ToolManager] Found tool in registry: ${toolId}`);
        return registeredTool;
      }

      // Also check by name in registry
      for (const [id, tool] of Array.from(this.toolRegistry.entries())) {
        if (tool.id === toolId) {
          logger.debug(`[ToolManager] Found tool in registry by name: ${toolId} (id: ${id})`);
          return tool;
        }
      }
    }

    logger.debug(`[ToolManager] Tool not found: ${toolId}`);
    return undefined;
  }

  /**
   * Get available tools for current context with enhanced resolution and deduplication
   * Returns tools in priority order with higher-priority scopes taking precedence
   * Resolution order: transient → step → flow → agent → registry
   */
  getAvailable(scope?: ToolScope, step?: Step<TContext, TData>, flow?: Flow<TContext, TData>): Tool<TContext, TData>[] {
    const toolMap = new Map<string, Tool<TContext, TData>>();
    const resolvedTools: Tool<TContext, TData>[] = [];

    logger.debug(`[ToolManager] Getting available tools with scope: ${scope || 'ALL'}`);

    // Add registered tools first (lowest priority)
    if (!scope || scope === ToolScope.REGISTERED || scope === ToolScope.ALL) {
      for (const [id, tool] of Array.from(this.toolRegistry.entries())) {
        toolMap.set(id, tool);
      }
      logger.debug(`[ToolManager] Added ${this.toolRegistry.size} registered tools`);
    }

    // Add agent-level tools (override registered tools with same ID)
    if (!scope || scope === ToolScope.AGENT || scope === ToolScope.ALL) {
      if (this.agent) {
        const agentTools = this.agent.getTools();
        for (const tool of agentTools) {
          toolMap.set(tool.id, tool);
        }
        logger.debug(`[ToolManager] Added ${agentTools.length} agent tools`);
      }
    }

    // Add route-level tools (override agent and registered tools with same ID)
    if (flow && (!scope || scope === ToolScope.FLOW || scope === ToolScope.ALL)) {
      if (flow.tools) {
        for (const tool of flow.tools) {
          toolMap.set(tool.id, tool);
        }
        logger.debug(`[ToolManager] Added ${flow.tools.length} flow.tools`);
      }
    }

    // Add step-level tools (override flow/agent/registry with same ID)
    if (step && (!scope || scope === ToolScope.STEP || scope === ToolScope.ALL)) {
      if (step.tools) {
        for (const toolRef of step.tools) {
          if (typeof toolRef !== 'string') {
            // Inline tool object - add directly
            toolMap.set(toolRef.id, toolRef);
            resolvedTools.push(toolRef);
          } else {
            // String reference - resolve from registry and add if found
            const registeredTool = this.toolRegistry.get(toolRef);
            if (registeredTool) {
              toolMap.set(registeredTool.id, registeredTool);
              resolvedTools.push(registeredTool);
            } else {
              logger.warn(`[ToolExecutionError] Step references unknown tool: "${toolRef}" is not registered. Skipping. Register the tool or remove the reference.`);
            }
          }
        }
        logger.debug(`[ToolManager] Added ${step.tools.length} step tools (${resolvedTools.length} resolved)`);
      }
    }

    // Add transient tools (highest priority — override everything with same ID)
    if (!scope || scope === ToolScope.ALL) {
      if (this.transientTools.size > 0) {
        for (const [id, tool] of this.transientTools) {
          toolMap.set(id, tool);
        }
        logger.debug(`[ToolManager] Added ${this.transientTools.size} transient tools`);
      }
    }

    // Convert map to array, preserving priority order
    const allTools = Array.from(toolMap.values());

    // If we have step-specific tools, prioritize them in the ordering
    // (but transient tools that override step tools via same ID are already in the map)
    if (resolvedTools.length > 0) {
      // Add resolved step tools first, then other tools not already included
      const stepToolIds = new Set(resolvedTools.map(t => t.id));
      const otherTools = allTools.filter(t => !stepToolIds.has(t.id));
      // For step tools, use the map version (which may be overridden by transient)
      const finalStepTools = resolvedTools.map(t => toolMap.get(t.id) || t);
      return [...finalStepTools, ...otherTools];
    }

    logger.debug(`[ToolManager] Returning ${allTools.length} available tools`);
    return allTools;
  }

  /**
   * Execute a tool by ID with proper error handling and fallback strategies
   * Consolidates tool execution logic from ToolExecutor and ResponseModal
   */
  async execute(
    toolId: string,
    args?: Record<string, unknown>,
    context?: {
      step?: Step<TContext, TData>;
      flow?: Flow<TContext, TData>;
      context?: TContext;
      data?: Partial<TData>;
      history?: Event[];
      updateContext?: (updates: Partial<TContext>) => Promise<void>;
      updateData?: (updates: Partial<TData>) => Promise<void>;
      fallbackTools?: string[]; // Alternative tools to try if primary fails
      retryCount?: number; // Number of retries for transient failures
    }
  ): Promise<ToolExecutionResult> {
    const maxRetries = context?.retryCount || 2;
    const fallbackTools = context?.fallbackTools || [];
    let lastError: Error | undefined;

    // Validate input parameters
    if (!toolId || typeof toolId !== 'string' || toolId.trim() === '') {
      return {
        success: false,
        error: 'Tool ID is required and must be a non-empty string',
        metadata: { toolId, args }
      };
    }

    // Try primary tool with retries
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const tool = this.find(toolId, undefined, context?.step, context?.flow);
        if (!tool) {
          // Tool not found - try fallback tools if available
          if (fallbackTools.length > 0) {
            logger.warn(`[ToolManager] Primary tool '${toolId}' not found, trying fallback tools: ${fallbackTools.join(', ')}`);

            for (const fallbackId of fallbackTools) {
              const fallbackResult = await this.execute(fallbackId, args, {
                ...context,
                fallbackTools: [], // Prevent infinite recursion
                retryCount: 0 // Don't retry fallback tools
              });

              if (fallbackResult.success) {
                logger.info(`[ToolManager] Fallback tool '${fallbackId}' succeeded for primary tool '${toolId}'`);
                return {
                  ...fallbackResult,
                  metadata: {
                    ...fallbackResult.metadata,
                    primaryTool: toolId,
                    fallbackUsed: fallbackId
                  }
                };
              }
            }
          }

          return {
            success: false,
            error: `Tool not found: ${toolId}${fallbackTools.length > 0 ? ` (fallback tools also failed: ${fallbackTools.join(', ')})` : ''}`,
            metadata: { toolId, args, fallbackTools }
          };
        }

        // Execute the tool with proper context
        const result = await this.executeTool({
          tool,
          context: context?.context || (await this.agent.getContext()) as TContext,
          updateContext: context?.updateContext || this.agent.updateContext.bind(this.agent),
          updateData: context?.updateData || this.agent.updateCollectedData.bind(this.agent),
          history: context?.history || [],
          data: context?.data,
          toolArguments: args,
        });

        // Success - return result with execution metadata
        if (result.success) {
          return {
            ...result,
            metadata: {
              ...result.metadata,
              toolId,
              attempt: attempt + 1,
              maxRetries
            }
          };
        } else {
          // Tool execution returned failure - don't retry, return immediately
          return {
            ...result,
            metadata: {
              ...result.metadata,
              toolId,
              attempt: attempt + 1,
              maxRetries
            }
          };
        }
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        const errorMessage = lastError.message;

        // Check if this is a transient error that should be retried
        const isTransientError = this.isTransientError(lastError);

        if (attempt < maxRetries && isTransientError) {
          logger.warn(`[ToolManager] Tool execution attempt ${attempt + 1} failed for ${toolId}, retrying: ${errorMessage}`);

          // Exponential backoff for retries
          const delay = Math.min(1000 * Math.pow(2, attempt), 5000);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        } else {
          logger.error(`[ToolManager] Tool execution failed for ${toolId} after ${attempt + 1} attempts: ${errorMessage}`);
          break;
        }
      }
    }

    // All retries failed - try fallback tools
    if (fallbackTools.length > 0) {
      logger.warn(`[ToolManager] Primary tool '${toolId}' failed after retries, trying fallback tools: ${fallbackTools.join(', ')}`);

      for (const fallbackId of fallbackTools) {
        try {
          const fallbackResult = await this.execute(fallbackId, args, {
            ...context,
            fallbackTools: [], // Prevent infinite recursion
            retryCount: 0 // Don't retry fallback tools
          });

          if (fallbackResult.success) {
            logger.info(`[ToolManager] Fallback tool '${fallbackId}' succeeded for failed primary tool '${toolId}'`);
            return {
              ...fallbackResult,
              metadata: {
                ...fallbackResult.metadata,
                primaryTool: toolId,
                primaryError: lastError?.message,
                fallbackUsed: fallbackId
              }
            };
          }
        } catch (fallbackError) {
          logger.warn(`[ToolManager] Fallback tool '${fallbackId}' also failed: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`);
        }
      }
    }

    // All attempts and fallbacks failed
    throw new ToolExecutionError(
      `[ToolExecutionError] Tool "${toolId}" execution failed: all ${maxRetries + 1} attempts exhausted${fallbackTools.length > 0 ? ` and fallback tools [${fallbackTools.join(', ')}] also failed` : ''}. ` +
      `Check the tool handler for errors or increase maxRetries. Last error: ${lastError?.message || 'Unknown'}.`,
      toolId,
      { args, context, attempts: maxRetries + 1, fallbackTools },
      lastError
    );
  }

  /**
   * Determine if an error is transient and should be retried
   */
  private isTransientError(error: Error): boolean {
    const transientPatterns = [
      /network/i,
      /timeout/i,
      /connection/i,
      /temporary/i,
      /rate limit/i,
      /503/,
      /502/,
      /504/,
      /ECONNRESET/,
      /ETIMEDOUT/,
      /ENOTFOUND/
    ];

    return transientPatterns.some(pattern => pattern.test(error.message));
  }

  /**
   * Execute a single tool with context and collected data
   * Consolidates logic from ToolExecutor class with enhanced error handling
   */
  async executeTool(params: {
    tool: Tool<TContext, TData>;
    context: TContext;
    updateContext: (updates: Partial<TContext>) => Promise<void>;
    updateData: (updates: Partial<TData>) => Promise<void>;
    history: Event[];
    data?: Partial<TData>;
    toolArguments?: Record<string, unknown>;
  }): Promise<ToolExecutionResult> {
    const { tool, context, updateContext, updateData, history, data, toolArguments } = params;
    const startTime = Date.now();

    try {
      // Validate tool before execution
      if (!tool || !tool.handler || typeof tool.handler !== 'function') {
        return {
          success: false,
          error: `Invalid tool: ${tool?.id || 'unknown'} - missing or invalid handler`,
          metadata: { toolId: tool?.id, executionTime: 0 }
        };
      }

      // Build tool context with complete agent data
      const collectedDirectives: Directive<TContext, TData>[] = [];

      const toolContext: ToolContext<TContext, TData> = {
        context,
        updateContext,
        updateData,
        history,
        data: data || {},
        getField: <K extends keyof TData>(key: K): TData[K] | undefined => {
          return data?.[key];
        },
        setField: async <K extends keyof TData>(key: K, value: TData[K]): Promise<void> => {
          const update = {} as Partial<TData>;
          update[key] = value;
          await updateData(update);
        },
        hasField: <K extends keyof TData>(key: K): boolean => {
          return data != null && key in data;
        },
        dispatch: (directive: Directive<TContext, TData>): void => {
          collectedDirectives.push(directive);
        }
      };

      logger.debug(`[ToolManager] Executing tool: ${tool.id} with args:`, toolArguments);

      // Tool validation gate (Req 6.1, 6.7)
      if (typeof tool.validateInput === 'function' && toolArguments) {
        const validation = await tool.validateInput(toolArguments, toolContext);
        if (!validation.valid) {
          const executionTime = Date.now() - startTime;
          logger.warn(`[DataValidationError] Tool "${tool.id}" input validation failed: ${validation.error}. Fix the tool call arguments to match the expected schema.`);
          return {
            success: false,
            error: `Validation failed: ${validation.error || 'Invalid input'}`,
            metadata: { toolId: tool.id, executionTime, gate: 'validateInput' }
          };
        }
      }

      // Tool permission gate (Req 6.7, 6.8)
      // When denied: do not invoke handler, do not process directives, do not apply state writes
      if (typeof tool.checkPermissions === 'function' && toolArguments) {
        const permission = await tool.checkPermissions(toolArguments, toolContext);
        if (!permission.allowed) {
          const executionTime = Date.now() - startTime;
          logger.warn(`[ToolExecutionError] Tool "${tool.id}" permission denied: ${permission.reason}. The tool's checkPermissions hook rejected this call.`);
          return {
            success: false,
            error: `Permission denied: ${permission.reason || 'Not allowed'}`,
            metadata: {
              toolId: tool.id,
              executionTime,
              gate: 'checkPermissions',
              canOverride: permission.canOverride
            }
          };
        }
      }

      // Execute tool with timeout protection
      const executionTimeout = 30000; // 30 seconds default timeout
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`Tool execution timeout after ${executionTimeout}ms`)), executionTimeout);
      });

      const result = await Promise.race([
        tool.handler(toolContext, toolArguments),
        timeoutPromise
      ]);

      const executionTime = Date.now() - startTime;
      logger.debug(`[ToolManager] Tool ${tool.id} completed in ${executionTime}ms`);

      // Handle different result types
      let toolResult: ToolResult<unknown, TContext, TData>;

      if (result && typeof result === 'object' && ('data' in result || 'success' in result || 'error' in result || 'directive' in result)) {
        // It's already a ToolResult-like object
        toolResult = result as ToolResult<unknown, TContext, TData>;
      } else {
        // It's a raw result - wrap it
        toolResult = {
          data: result,
          success: true
        };
      }

      // Collect directive from ToolResult.directive (if present)
      if (toolResult.directive) {
        collectedDirectives.push(toolResult.directive);
      }

      // Apply data updates from tool result with validation
      if (toolResult.dataUpdate) {
        try {
          if (typeof toolResult.dataUpdate === 'object' && toolResult.dataUpdate !== null) {
            await updateData(toolResult.dataUpdate);
          } else {
            logger.warn(`[DataValidationError] Tool "${tool.id}" returned invalid dataUpdate: expected object, got ${typeof toolResult.dataUpdate}. Fix the tool handler to return a valid dataUpdate object.`);
          }
        } catch (updateError) {
          logger.error(`[ToolManager] Failed to apply data update from tool ${tool.id}:`, updateError);
          return {
            success: false,
            error: `Failed to apply data update: ${updateError instanceof Error ? updateError.message : String(updateError)}`,
            metadata: { toolId: tool.id, executionTime, updateError: updateError instanceof Error ? updateError.message : String(updateError) }
          };
        }
      }

      // Apply context updates from tool result with validation
      if (toolResult.contextUpdate) {
        try {
          if (typeof toolResult.contextUpdate === 'object' && toolResult.contextUpdate !== null) {
            await updateContext(toolResult.contextUpdate);
          } else {
            logger.warn(`[DataValidationError] Tool "${tool.id}" returned invalid contextUpdate: expected object, got ${typeof toolResult.contextUpdate}. Fix the tool handler to return a valid contextUpdate object.`);
          }
        } catch (updateError) {
          logger.error(`[ToolManager] Failed to apply context update from tool ${tool.id}:`, updateError);
          return {
            success: false,
            error: `Failed to apply context update: ${updateError instanceof Error ? updateError.message : String(updateError)}`,
            metadata: { toolId: tool.id, executionTime, updateError: updateError instanceof Error ? updateError.message : String(updateError) }
          };
        }
      }

      // Return execution result with metadata
      return {
        success: toolResult.success !== false, // Default to true unless explicitly false
        data: toolResult.data,
        contextUpdate: toolResult.contextUpdate,
        dataUpdate: toolResult.dataUpdate,
        error: toolResult.error,
        directives: collectedDirectives.length > 0 ? collectedDirectives : undefined,
        metadata: {
          toolId: tool.id,
          toolName: tool.id,
          executionTime,
          ...(toolResult.meta || {})
        }
      };
    } catch (error) {
      const executionTime = Date.now() - startTime;

      logger.error(`[ToolManager] Tool execution error for ${tool.id} after ${executionTime}ms:`, error);

      // Re-throw the error so the execute method can handle retries
      throw error;
    }
  }

  /**
   * Execute multiple tools in sequence
   * Consolidates logic from ToolExecutor class
   */
  async executeTools(params: {
    tools: Array<Tool<TContext, TData>>;
    context: TContext;
    updateContext: (updates: Partial<TContext>) => Promise<void>;
    updateData: (updates: Partial<TData>) => Promise<void>;
    history: Event[];
    data?: Partial<TData>;
  }): Promise<ToolExecutionResult[]> {
    const { tools, context, updateContext, updateData, history, data } = params;
    const results: ToolExecutionResult[] = [];

    for (const tool of tools) {
      const result = await this.executeTool({
        tool,
        context,
        updateContext,
        updateData,
        history,
        data,
      });
      results.push(result);

      // If tool failed, stop execution chain
      if (!result.success) {
        logger.error(`[ToolManager] Tool ${tool.id || "unknown"} failed:`, result.error);
        break;
      }

      // Apply context updates from tool result
      if (result.contextUpdate) {
        await updateContext(result.contextUpdate as Partial<TContext>);
      }

      // Apply data updates from tool result
      if (result.dataUpdate) {
        await updateData(result.dataUpdate as Partial<TData>);
      }
    }

    return results;
  }

  /**
   * Execute tool calls with concurrency control using StreamingToolExecutor.
   * Creates a StreamingToolExecutor, resolves tools, queues them, and yields
   * ToolExecutionUpdate results in original request order.
   *
   * Concurrency-safe tools run in parallel; non-safe tools run serially.
   * Progress messages are yielded immediately.
   */
  async *executeWithConcurrency(params: {
    toolCalls: ToolCallRequest[];
    context: TContext;
    data?: Partial<TData>;
    history?: Event[];
    signal?: AbortSignal;
    flow?: Flow<TContext, TData>;
    step?: Step<TContext, TData>;
  }): AsyncGenerator<ToolExecutionUpdate<TData>> {
    const { toolCalls, context, data, history, signal, flow, step } = params;

    if (toolCalls.length === 0) {
      return;
    }

    // Build a ToolContext for the executor
    const toolContext: ToolContext<TContext, TData> = {
      context,
      data: data || {} as Partial<TData>,
      history: history || [],
      step: step ? { id: step.id, flowId: flow?.id || '' } : undefined,
      updateContext: (updates: Partial<TContext>): Promise<void> => {
        Object.assign(context as Record<string, unknown>, updates);
        return Promise.resolve();
      },
      updateData: (updates: Partial<TData>): Promise<void> => {
        if (data) {
          Object.assign(data as Record<string, unknown>, updates);
        }
        return Promise.resolve();
      },
      getField: <K extends keyof TData>(key: K): TData[K] | undefined => {
        return data?.[key];
      },
      setField: <K extends keyof TData>(key: K, value: TData[K]): Promise<void> => {
        if (data) {
          (data as TData)[key] = value;
        }
        return Promise.resolve();
      },
      hasField: <K extends keyof TData>(key: K): boolean => {
        return data != null && key in (data as Record<string, unknown>);
      },
      dispatch: (_directive: Directive<TContext, TData>): void => {
        // Directives from concurrent execution are collected by the StreamingToolExecutor
        // and surfaced via ToolExecutionUpdate. This is a no-op placeholder;
        // full directive bus integration happens in ResponsePipeline (task 1.6).
      },
    };

    const executor = new StreamingToolExecutor<TContext, TData>(toolContext, {
      signal,
    });

    // Resolve and queue each tool call
    for (const toolCall of toolCalls) {
      const tool = this.find(toolCall.toolName, undefined, step, flow);
      if (!tool) {
        logger.warn(`[ToolExecutionError] Tool not found for concurrent execution: "${toolCall.toolName}" is not registered in any scope. Skipping. Register the tool or check the tool name.`);
        continue;
      }
      // Tool carries all metadata fields directly — no cast needed
      executor.addTool(toolCall, tool);
    }

    // Yield all results in order
    yield* executor.getRemainingResults();
  }

  /**
   * Create a data enrichment tool that modifies collected data
   * Returns a tool instance that can be registered or added to scope
   */
  createDataEnrichment<TFields extends keyof TData>(
    config: DataEnrichmentConfig<TContext, TData, TFields>
  ): Tool<TContext, TData, void> {
    // Validate configuration first
    this.validateDataEnrichmentConfig(config);

    const tool: Tool<TContext, TData, void> = {
      id: config.id,
      description: config.description || `Enriches data fields: ${config.fields.join(', ')}`,
      parameters: {
        type: 'object',
        properties: {
          fields: {
            type: 'array',
            items: { type: 'string' },
            description: `Fields to enrich: ${config.fields.join(', ')}`
          }
        }
      },
      handler: async (context: ToolContext<TContext, TData>) => {
        try {
          // Extract the specified fields from current data
          const fieldData = {} as Pick<TData, TFields>;
          for (const field of config.fields) {
            if (context.hasField(field)) {
              const value = context.getField(field);
              if (value !== undefined) {
                (fieldData as Record<string, unknown>)[field as string] = value;
              }
            }
          }

          // Call the enricher function
          const enrichedData = await config.enricher(context.context, fieldData);

          // Update the data with enriched values
          if (enrichedData && typeof enrichedData === 'object') {
            await context.updateData(enrichedData);
          }

          logger.debug(`[ToolManager] Data enrichment completed for tool: ${config.id}`);

          return {
            success: true,
            dataUpdate: enrichedData
          };
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          logger.error(`[ToolManager] Data enrichment failed for ${config.id}: ${errorMessage}`);
          throw new ToolExecutionError(
            `[ToolExecutionError] Data enrichment failed for tool "${config.id}": ${errorMessage}. ` +
            `Check the enrichment handler and field references.`,
            config.id,
            { fields: config.fields },
            error instanceof Error ? error : undefined
          );
        }
      }
    };

    return tool;
  }

  /**
   * Create a validation tool that validates data fields
   * Returns a tool instance that can be registered or added to scope
   */
  createValidation<TFields extends keyof TData>(
    config: ValidationConfig<TContext, TData, TFields>
  ): Tool<TContext, TData, ValidationResult> {
    // Validate configuration first
    this.validateValidationConfig(config);

    const tool: Tool<TContext, TData, ValidationResult> = {
      id: config.id,
      description: config.description || `Validates data fields: ${config.fields.join(', ')}`,
      parameters: {
        type: 'object',
        properties: {
          fields: {
            type: 'array',
            items: { type: 'string' },
            description: `Fields to validate: ${config.fields.join(', ')}`
          }
        }
      },
      handler: async (context: ToolContext<TContext, TData>): Promise<ValidationResult> => {
        try {
          // Extract the specified fields from current data
          const fieldData = {} as Pick<TData, TFields>;
          for (const field of config.fields) {
            if (context.hasField(field)) {
              const value = context.getField(field);
              if (value !== undefined) {
                (fieldData as Record<string, unknown>)[field as string] = value;
              }
            }
          }

          // Call the validator function
          const result = await config.validator(context.context, fieldData);

          logger.debug(`[ToolManager] Validation completed for tool: ${config.id}, valid: ${result.valid}`);
          return result;
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          logger.error(`[ToolManager] Validation failed for ${config.id}: ${errorMessage}`);

          // Return validation failure result instead of throwing
          return {
            valid: false,
            errors: [{
              field: 'validation',
              message: `Validation error: ${errorMessage}`,
              value: undefined,
              schemaPath: config.id
            }],
            warnings: []
          };
        }
      }
    };

    return tool;
  }

  /**
   * Create an API call tool that makes external HTTP requests
   * Returns a tool instance that can be registered or added to scope
   */
  createApiCall<TResult = unknown>(
    config: ApiCallConfig<TContext, TData, TResult>
  ): Tool<TContext, TData, TResult> {
    // Validate configuration first
    this.validateApiCallConfig(config);

    const tool: Tool<TContext, TData, TResult> = {
      id: config.id,
      description: config.description || `Makes API call to external service`,
      parameters: {
        type: 'object',
        properties: {
          endpoint: {
            type: 'string',
            description: 'API endpoint URL'
          },
          method: {
            type: 'string',
            enum: ['GET', 'POST', 'PUT', 'DELETE'],
            description: 'HTTP method'
          }
        }
      },
      handler: async (context: ToolContext<TContext, TData>, args?: Record<string, unknown>): Promise<TResult> => {
        try {
          // Resolve endpoint URL
          const endpoint = typeof config.endpoint === 'function'
            ? config.endpoint(context.context, context.data)
            : config.endpoint;

          // Resolve headers
          const headers = typeof config.headers === 'function'
            ? config.headers(context.context)
            : config.headers || {};

          // Prepare request options
          const requestOptions: RequestInit = {
            method: config.method || 'GET',
            headers: {
              'Content-Type': 'application/json',
              ...headers
            }
          };

          // Add body for non-GET requests
          if (config.body && (config.method === 'POST' || config.method === 'PUT')) {
            const bodyData = config.body(context.context, context.data, args);
            requestOptions.body = JSON.stringify(bodyData);
          }

          // Make the API call
          const response = await fetch(endpoint, requestOptions);

          if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
          }

          // Parse response
          let responseData: unknown;
          const contentType = response.headers.get('content-type');
          if (contentType && contentType.includes('application/json')) {
            responseData = await response.json();
          } else {
            responseData = await response.text();
          }

          // Transform response if transformer provided
          const result = config.transform ? config.transform(responseData) : responseData as TResult;

          logger.debug(`[ToolManager] API call completed for tool: ${config.id}`);
          return result;
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          logger.error(`[ToolManager] API call failed for ${config.id}: ${errorMessage}`);

          throw new ToolExecutionError(
            `[ToolExecutionError] API call failed for tool "${config.id}": ${errorMessage}. ` +
            `Check the endpoint URL, method, and network connectivity.`,
            config.id,
            { endpoint: config.endpoint, method: config.method, args },
            error instanceof Error ? error : undefined
          );
        }
      }
    };

    return tool;
  }

  /**
   * Create a computation tool that performs calculations on input data
   * Returns a tool instance that can be registered or added to scope
   */
  createComputation<TResult = unknown>(
    config: ComputationConfig<TContext, TData, TResult>
  ): Tool<TContext, TData, TResult> {
    // Validate configuration first
    this.validateComputationConfig(config);

    const tool: Tool<TContext, TData, TResult> = {
      id: config.id,
      description: config.description || `Performs computation on inputs: ${config.inputs.join(', ')}`,
      parameters: {
        type: 'object',
        properties: {
          inputs: {
            type: 'array',
            items: { type: 'string' },
            description: `Input fields: ${config.inputs.join(', ')}`
          }
        }
      },
      handler: async (context: ToolContext<TContext, TData>, args?: Record<string, unknown>): Promise<TResult> => {
        try {
          // Extract the specified input fields from current data
          const inputData = {} as Partial<TData>;
          for (const input of config.inputs) {
            if (context.hasField(input)) {
              const value = context.getField(input);
              if (value !== undefined) {
                (inputData as Record<string, unknown>)[input as string] = value;
              }
            }
          }

          // Call the compute function
          const result = await config.compute(context.context, inputData, args);

          logger.debug(`[ToolManager] Computation completed for tool: ${config.id}`);
          return result;
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          logger.error(`[ToolManager] Computation failed for ${config.id}: ${errorMessage}`);

          throw new ToolExecutionError(
            `[ToolExecutionError] Computation failed for tool "${config.id}": ${errorMessage}. ` +
            `Check the compute function and input field references.`,
            config.id,
            { inputs: config.inputs, args },
            error instanceof Error ? error : undefined
          );
        }
      }
    };

    return tool;
  }

  /**
   * Get detailed information about a tool for debugging
   */
  getToolInfo(toolId: string, scope?: ToolScope, step?: Step<TContext, TData>, flow?: Flow<TContext, TData>): {
    found: boolean;
    tool?: Tool<TContext, TData>;
    scope?: string;
    metadata?: Record<string, unknown>;
  } {
    const tool = this.find(toolId, scope, step, flow);

    if (!tool) {
      return { found: false };
    }

    // Determine which scope the tool was found in
    let foundScope = 'unknown';

    // Check step scope
    if (step?.tools) {
      const stepTool = step.tools.find((t) =>
        (typeof t === 'string' && t === toolId) ||
        (typeof t === 'object' && (t.id === toolId))
      );
      if (stepTool) foundScope = 'step';
    }

    // Check route scope
    if (foundScope === 'unknown' && flow?.tools) {
      const flowTool = flow.tools.find((t) => t.id === toolId);
      if (flowTool) foundScope = 'flow';
    }

    // Check agent scope
    if (foundScope === 'unknown' && this.agent) {
      const agentTools = this.agent.tools;
      const agentTool = agentTools.find((t) => t.id === toolId);
      if (agentTool) foundScope = 'agent';
    }

    // Check registry
    if (foundScope === 'unknown' && this.toolRegistry.has(toolId)) {
      foundScope = 'registry';
    }

    return {
      found: true,
      tool,
      scope: foundScope,
      metadata: {
        id: tool.id,
        hasDescription: !!tool.description,
        hasParameters: !!tool.parameters,
        handlerLength: tool.handler.length
      }
    };
  }

  /**
   * Validate that all tools in a list exist and are accessible
   */
  validateToolReferences(toolIds: string[], step?: Step<TContext, TData>, flow?: Flow<TContext, TData>): {
    valid: boolean;
    missing: string[];
    found: string[];
    details: Array<{ id: string; found: boolean; scope?: string; }>;
  } {
    const missing: string[] = [];
    const found: string[] = [];
    const details: Array<{ id: string; found: boolean; scope?: string; }> = [];

    for (const toolId of toolIds) {
      const info = this.getToolInfo(toolId, ToolScope.ALL, step, flow);

      if (info.found) {
        found.push(toolId);
        details.push({ id: toolId, found: true, scope: info.scope });
      } else {
        missing.push(toolId);
        details.push({ id: toolId, found: false });
      }
    }

    return {
      valid: missing.length === 0,
      missing,
      found,
      details
    };
  }

  /**
   * Get comprehensive statistics about the tool system
   */
  getStatistics(): {
    registeredTools: number;
    agentTools: number;
    totalAvailable: number;
    registeredToolIds: string[];
    duplicateIds: string[];
  } {
    const registeredToolIds = Array.from(this.toolRegistry.keys());
    const agentTools = this.agent ? this.agent.getTools() : [];
    const agentToolIds = agentTools.map((t) => t.id);

    // Find duplicate IDs between registry and agent
    const duplicateIds = registeredToolIds.filter(id => agentToolIds.includes(id));

    const allAvailable = this.getAvailable();

    return {
      registeredTools: this.toolRegistry.size,
      agentTools: agentTools.length,
      totalAvailable: allAvailable.length,
      registeredToolIds,
      duplicateIds
    };
  }

  /**
   * Perform health check on the tool system
   */
  healthCheck(): {
    healthy: boolean;
    issues: string[];
    warnings: string[];
    statistics: {
      registeredTools: number;
      agentTools: number;
      totalAvailable: number;
      registeredToolIds: string[];
      duplicateIds: string[];
    };
  } {
    const issues: string[] = [];
    const warnings: string[] = [];
    const stats = this.getStatistics();

    // Check for duplicate tool IDs
    if (stats.duplicateIds.length > 0) {
      warnings.push(`Duplicate tool IDs found between registry and agent: ${stats.duplicateIds.join(', ')}`);
    }

    // Check for tools with missing handlers
    for (const [id, tool] of Array.from(this.toolRegistry.entries())) {
      if (!tool.handler || typeof tool.handler !== 'function') {
        issues.push(`Tool '${id}' has invalid or missing handler`);
      }

      if (!tool.id || tool.id.trim() === '') {
        issues.push(`Tool has empty or invalid ID: ${JSON.stringify(tool)}`);
      }
    }

    // Check agent tools if available
    if (this.agent) {
      const agentTools = this.agent.getTools();
      for (const tool of agentTools) {
        if (!tool.handler || typeof tool.handler !== 'function') {
          issues.push(`Agent tool '${tool.id}' has invalid or missing handler`);
        }
      }
    }

    return {
      healthy: issues.length === 0,
      issues,
      warnings,
      statistics: stats
    };
  }
}