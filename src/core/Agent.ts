/**
 * Core Agent implementation
 */

import type {
  AgentOptions,
  Term,
  Guideline,
  Tool,
  Event,
  RouteOptions,
  SessionState,
  Template,
  StepRef,
  History,
  AgentResponseStreamChunk,
  AgentResponse,
  StructuredSchema,
  ValidationError,
  ValidationResult,
} from "../types";
import type { StreamOptions, GenerateOptions, RespondParams } from "./ResponseModal";
import {
  mergeCollected,
  logger,
  LoggerLevel,
  render,
} from "../utils";

import { Route } from "./Route";
import { Step } from "./Step";
import { PersistenceManager } from "./PersistenceManager";
import { SessionManager } from "./SessionManager";
import { RoutingEngine } from "./RoutingEngine";
import { ToolExecutor } from "./ToolExecutor";
import { ResponseModal } from "./ResponseModal";

/**
 * Error thrown when data validation fails
 */
class DataValidationError extends Error {
  constructor(public errors: ValidationError[], message?: string) {
    super(message || "Data validation failed");
    this.name = "DataValidationError";
  }
}

/**
 * Error thrown when route configuration is invalid
 */
class RouteConfigurationError extends Error {
  constructor(public routeTitle: string, public invalidFields: string[], message?: string) {
    super(message || `Route configuration error in '${routeTitle}'`);
    this.name = "RouteConfigurationError";
  }
}

/**
 * Main Agent class with generic context and data support
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export class Agent<TContext = any, TData = any> {
  private terms: Term<TContext, TData>[] = [];
  private guidelines: Guideline<TContext, TData>[] = [];
  private tools: Tool<TContext, TData, unknown[], unknown>[] = [];
  private routes: Route<TContext, TData>[] = [];
  private context: TContext | undefined;
  private persistenceManager: PersistenceManager<TData> | undefined;
  private routingEngine: RoutingEngine<TContext, TData>;
  private responseModal: ResponseModal<TContext, TData>;
  private currentSession?: SessionState<TData>;
  private knowledgeBase: Record<string, unknown> = {};
  private schema?: StructuredSchema;
  private collectedData: Partial<TData> = {};

  /** Public session manager for easy session management */
  public session: SessionManager<TData>;

  constructor(private readonly options: AgentOptions<TContext, TData>) {
    // Set log level based on debug option
    if (options.debug) {
      logger.setLevel(LoggerLevel.DEBUG);
    }

    // Validate context configuration
    if (options.context !== undefined && options.contextProvider) {
      throw new Error(
        "Cannot provide both 'context' and 'contextProvider'. Choose one."
      );
    }

    // Initialize and validate agent-level schema if provided
    if (options.schema) {
      this.schema = options.schema;
      this.validateSchema(this.schema);
      logger.debug("[Agent] Agent-level schema initialized and validated");
    }

    // Initialize context if provided
    this.context = options.context;

    // Initialize collected data with initial data if provided
    if (options.initialData) {
      if (this.schema) {
        const validation = this.validateData(options.initialData);
        if (!validation.valid) {
          throw new Error(
            `Initial data validation failed: ${validation.errors.map(e => e.message).join(', ')}`
          );
        }
      }
      this.collectedData = { ...options.initialData };
      logger.debug("[Agent] Initial data set:", this.collectedData);
    }

    // Initialize current session if provided
    this.currentSession = options.session;

    // Initialize routing engine
    this.routingEngine = new RoutingEngine<TContext, TData>({
      maxCandidates: 5,
      allowRouteSwitch: true,
      switchThreshold: 70,
    });

    // Initialize ResponseModal for handling all response generation
    this.responseModal = new ResponseModal<TContext, TData>(this);

    // Initialize persistence if configured
    if (options.persistence) {
      try {
        // Validate persistence configuration
        if (!options.persistence.adapter) {
          throw new Error("Persistence adapter is required when persistence is configured");
        }

        if (!options.persistence.adapter.sessionRepository) {
          throw new Error("Persistence adapter must provide a sessionRepository");
        }

        if (!options.persistence.adapter.messageRepository) {
          throw new Error("Persistence adapter must provide a messageRepository");
        }

        this.persistenceManager = new PersistenceManager<TData>(options.persistence);

        // Initialize the adapter if it has an initialize method
        if (options.persistence.adapter.initialize) {
          options.persistence.adapter.initialize().catch((error) => {
            logger.error(
              "[Agent] Persistence adapter initialization failed:",
              error instanceof Error ? error.message : String(error)
            );
          });
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error("[Agent] Failed to initialize persistence:", errorMessage);
        throw new Error(`Failed to initialize persistence: ${errorMessage}`);
      }
    }

    // Initialize from options - use create methods for consistency
    if (options.terms) {
      options.terms.forEach((term) => {
        this.createTerm(term);
      });
    }

    if (options.guidelines) {
      options.guidelines.forEach((guideline) => {
        this.createGuideline(guideline);
      });
    }

    if (options.tools) {
      options.tools.forEach((tool) => {
        this.createTool(tool);
      });
    }

    if (options.routes) {
      options.routes.forEach((routeOptions) => {
        this.createRoute(routeOptions);
      });
    }

    // Initialize knowledge base
    if (options.knowledgeBase) {
      this.knowledgeBase = { ...options.knowledgeBase };
    }

    // Initialize session manager
    this.session = new SessionManager<TData>(this.persistenceManager);

    // Store sessionId for later use in getOrCreate calls
    if (options.sessionId) {
      // The session will be loaded on first getOrCreate call
      this.session.getOrCreate(options.sessionId).catch((err) => {
        logger.error("Failed to start session", err);
      });
    }
  }

  /**
   * Validate the agent-level schema structure
   * @private
   */
  private validateSchema(schema: StructuredSchema): void {
    if (!schema || typeof schema !== 'object') {
      throw new Error(
        "Agent schema must be a valid JSON Schema object. " +
        "Provide a schema with 'type': 'object' and 'properties' to define the data structure."
      );
    }

    if (schema.type !== 'object') {
      throw new Error(
        `Agent schema must be of type 'object', but received '${String(schema.type)}'. ` +
        "Agent-level schemas must define object structures for data collection."
      );
    }

    if (!schema.properties || typeof schema.properties !== 'object') {
      throw new Error(
        "Agent schema must have a 'properties' field defining the data fields. " +
        "Example: { type: 'object', properties: { name: { type: 'string' }, email: { type: 'string' } } }"
      );
    }

    logger.debug("[Agent] Schema validation passed");
  }

  /**
   * Validate data against the agent-level schema
   */
  validateData(data: Partial<TData>): ValidationResult {
    if (!this.schema) {
      // No schema defined, consider all data valid
      return { valid: true, errors: [], warnings: [] };
    }

    const errors: ValidationError[] = [];
    const warnings: ValidationError[] = [];

    // Basic validation - check if provided fields exist in schema
    if (this.schema.properties) {
      for (const [key, value] of Object.entries(data)) {
        if (!(key in this.schema.properties)) {
          errors.push({
            field: key,
            value,
            message: `Field '${key}' is not defined in agent schema`,
            schemaPath: `properties.${key}`
          });
        }
      }
    }

    // Check required fields if specified
    if (this.schema.required && Array.isArray(this.schema.required)) {
      for (const requiredField of this.schema.required) {
        if (!(requiredField in data) || data[requiredField as keyof TData] === undefined) {
          warnings.push({
            field: requiredField,
            value: undefined,
            message: `Required field '${requiredField}' is missing`,
            schemaPath: `required`
          });
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings
    };
  }

  /**
   * Check if a field is valid according to the agent schema
   * @param field - The field key to validate
   * @returns true if field exists in schema or no schema is defined, false otherwise
   */
  isValidSchemaField(field: keyof TData): boolean {
    if (!this.schema || !this.schema.properties) {
      // No schema defined, consider all fields valid
      return true;
    }

    return field as string in this.schema.properties;
  }

  /**
   * Get the current collected data
   */
  getCollectedData(): Partial<TData> {
    return { ...this.collectedData };
  }

  /**
   * Update collected data with validation
   */
  async updateCollectedData(updates: Partial<TData>): Promise<void> {
    // Validate the updates
    const validation = this.validateData(updates);
    if (!validation.valid) {
      const errorMessages = validation.errors.map(e => e.message).join(', ');
      throw new DataValidationError(validation.errors, `Data validation failed: ${errorMessages}`);
    }

    // Log warnings if any
    if (validation.warnings.length > 0) {
      const warningMessages = validation.warnings.map(w => w.message).join(', ');
      logger.warn(`[Agent] Data validation warnings: ${warningMessages}`);
    }

    // Merge updates with current data
    const previousData = { ...this.collectedData };
    this.collectedData = {
      ...this.collectedData,
      ...updates
    };

    // Trigger agent-level lifecycle hook if configured
    if (this.options.hooks?.onDataUpdate) {
      this.collectedData = await this.options.hooks.onDataUpdate(
        this.collectedData,
        previousData
      );
    }

    // Update current session if it exists to keep it in sync
    if (this.currentSession) {
      this.currentSession = mergeCollected(this.currentSession, this.collectedData);
    }

    logger.debug("[Agent] Collected data updated:", updates);
  }

  /**
   * Get agent name
   */
  get name(): string {
    return this.options.name;
  }

  /**
   * Get agent description
   */
  get description(): string | undefined {
    return this.options.description;
  }

  /**
   * Get agent goal
   */
  get goal(): string | undefined {
    return this.options.goal;
  }

  /**
   * Get agent identity
   */
  get identity(): Template<TContext> | undefined {
    return this.options.identity;
  }

  /**
   * Create a new route (journey) using agent-level data type
   */
  createRoute(
    options: RouteOptions<TContext, TData>
  ): Route<TContext, TData> {
    // Validate that requiredFields exist in agent schema
    if (options.requiredFields && this.schema?.properties) {
      const invalidRequiredFields = options.requiredFields.filter(
        field => !(String(field) in this.schema!.properties!)
      );
      if (invalidRequiredFields.length > 0) {
        throw new RouteConfigurationError(
          options.title,
          invalidRequiredFields.map(f => String(f)),
          `Invalid required fields in route '${options.title}': ${invalidRequiredFields.join(', ')}. ` +
          `Must be valid keys from agent schema. Available fields: ${Object.keys(this.schema.properties).join(', ')}.`
        );
      }
    }

    // Validate that optionalFields exist in agent schema
    if (options.optionalFields && this.schema?.properties) {
      const invalidOptionalFields = options.optionalFields.filter(
        field => !(String(field) in this.schema!.properties!)
      );
      if (invalidOptionalFields.length > 0) {
        throw new RouteConfigurationError(
          options.title,
          invalidOptionalFields.map(f => String(f)),
          `Invalid optional fields in route '${options.title}': ${invalidOptionalFields.join(', ')}. ` +
          `Must be valid keys from agent schema. Available fields: ${Object.keys(this.schema.properties).join(', ')}.`
        );
      }
    }

    const route = new Route<TContext, TData>(options);
    this.routes.push(route);
    return route;
  }

  /**
   * Create a domain term for the glossary
   */
  createTerm(term: Term<TContext, TData>): this {
    this.terms.push(term);
    return this;
  }

  /**
   * Create a behavioral guideline
   */
  createGuideline(guideline: Guideline<TContext, TData>): this {
    const guidelineWithId = {
      ...guideline,
      id: guideline.id || `guideline_${this.guidelines.length}`,
      enabled: guideline.enabled !== false, // Default to true
    };
    this.guidelines.push(guidelineWithId);
    return this;
  }

  /**
   * Register a tool at the agent level
   */
  createTool(tool: Tool<TContext, TData, unknown[], unknown>): this {
    this.tools.push(tool);
    return this;
  }

  /**
   * Register multiple tools at the agent level
   */
  registerTools(tools: Tool<TContext, TData, unknown[], unknown>[]): this {
    tools.forEach((tool) => this.createTool(tool));
    return this;
  }

  /**
   * Update the agent's context
   * Triggers both agent-level and route-specific onContextUpdate lifecycle hooks if configured
   */
  async updateContext(updates: Partial<TContext>): Promise<void> {
    const previousContext = this.context;

    // Merge updates with current context
    this.context = {
      ...(this.context as Record<string, unknown>),
      ...(updates as Record<string, unknown>),
    } as TContext;

    // Trigger route-specific lifecycle hook if configured and session has current route
    if (this.currentSession?.currentRoute) {
      const currentRoute = this.routes.find(
        (r) => r.id === this.currentSession!.currentRoute?.id
      );
      if (
        currentRoute?.hooks?.onContextUpdate &&
        previousContext !== undefined
      ) {
        await currentRoute.handleContextUpdate(this.context, previousContext);
      }
    }

    // Trigger agent-level lifecycle hook if configured
    if (this.options.hooks?.onContextUpdate && previousContext !== undefined) {
      await this.options.hooks.onContextUpdate(this.context, previousContext);
    }
  }

  /**
   * Update collected data in session with lifecycle hook support
   * Triggers both agent-level and route-specific onDataUpdate lifecycle hooks if configured
   * @internal
   */
  private async updateData(
    session: SessionState<TData>,
    dataUpdate: Partial<TData>
  ): Promise<SessionState<TData>> {
    const previousCollected = { ...session.data };

    // Merge new collected data
    let newCollected = {
      ...session.data,
      ...dataUpdate,
    };

    // Trigger route-specific lifecycle hook if configured and session has a current route
    if (session.currentRoute) {
      const currentRoute = this.routes.find(
        (r) => r.id === session.currentRoute?.id
      );
      if (currentRoute?.hooks?.onDataUpdate) {
        newCollected = await currentRoute.handleDataUpdate(
          newCollected,
          previousCollected
        );
      }
    }

    // Trigger agent-level lifecycle hook if configured
    if (this.options.hooks?.onDataUpdate) {
      newCollected = (await this.options.hooks.onDataUpdate(
        newCollected,
        previousCollected
      ));
    }

    // Update agent's collected data to stay in sync
    this.collectedData = { ...newCollected };

    // Return updated session
    return mergeCollected(session, newCollected);
  }

  /**
   * Get current context (fetches from provider if configured)
   */
  async getContext(): Promise<TContext | undefined> {
    // If context provider is configured, use it to fetch fresh context
    if (this.options.contextProvider) {
      return await this.options.contextProvider();
    }

    // Otherwise return the stored context
    return this.context;
  }
  /**
   * Get current schema
   */
  getSchema(): StructuredSchema | undefined {
    return this.schema;
  }

  /**
   * Generate a response based on history and context as a stream
   */
  async *respondStream(params: RespondParams<TContext, TData>): AsyncGenerator<AgentResponseStreamChunk<TData>> {
    // Delegate to ResponseModal
    yield* this.responseModal.respondStream(params);
  }

  /**
   * Generate a response based on history and context
   */
  async respond(params: RespondParams<TContext, TData>): Promise<AgentResponse<TData>> {
    // Delegate to ResponseModal
    return this.responseModal.respond(params);
  }

  /**
   * Get all routes
   */
  getRoutes(): Route<TContext, TData>[] {
    return [...this.routes];
  }

  /**
   * Get agent options
   * @internal Used by ResponseModal
   */
  getAgentOptions(): AgentOptions<TContext, TData> {
    return this.options;
  }

  /**
   * Get routing engine
   * @internal Used by ResponseModal
   */
  getRoutingEngine(): RoutingEngine<TContext, TData> {
    return this.routingEngine;
  }

  /**
   * Get the updateData method bound to this agent
   * @internal Used by ResponseModal
   */
  getUpdateDataMethod(): (session: SessionState<TData>, dataUpdate: Partial<TData>) => Promise<SessionState<TData>> {
    return this.updateData.bind(this);
  }



  /**
   * Get all terms
   */
  getTerms(): Term<TContext, TData>[] {
    return [...this.terms];
  }

  /**
   * Get all tools
   */
  getTools(): Tool<TContext, TData, unknown[], unknown>[] {
    return [...this.tools];
  }







  /**
   * Get all guidelines
   */
  getGuidelines(): Guideline<TContext, TData>[] {
    return [...this.guidelines];
  }

  /**
   * Get the agent's knowledge base
   */
  getKnowledgeBase(): Record<string, unknown> {
    return { ...this.knowledgeBase };
  }



  /**
   * Get the persistence manager (if configured)
   */
  getPersistenceManager(): PersistenceManager<TData> | undefined {
    return this.persistenceManager;
  }

  /**
   * Check if persistence is enabled
   */
  hasPersistence(): boolean {
    return this.persistenceManager !== undefined;
  }

  /**
   * Set the current session for convenience methods
   * @param session - Session step to use for subsequent calls
   */
  setCurrentSession(session: SessionState): void {
    this.currentSession = session;
  }

  /**
   * Get the current session (if set)
   */
  getCurrentSession(): SessionState | undefined {
    return this.currentSession;
  }

  /**
   * Execute a prepare or finalize function/tool
   * @internal Used by ResponseModal
   */
  async executePrepareFinalize(
    prepareOrFinalize:
      | string
      | Tool<TContext, TData, unknown[], unknown>
      | ((context: TContext, data?: Partial<TData>) => void | Promise<void>)
      | undefined,
    context: TContext,
    data?: Partial<TData>,
    route?: Route<TContext, TData>,
    step?: Step<TContext, TData>
  ): Promise<void> {
    if (!prepareOrFinalize) return;

    if (typeof prepareOrFinalize === "function") {
      // It's a function - call it directly
      await prepareOrFinalize(context, data);
    } else {
      // It's a tool reference - find and execute the tool
      let tool: Tool<TContext, TData, unknown[], unknown> | undefined;

      if (typeof prepareOrFinalize === "string") {
        // Tool ID - find it in available tools
        const availableTools = new Map<string, Tool<TContext, TData, unknown[], unknown>>();

        // Add agent-level tools
        this.tools.forEach((t) => {
          availableTools.set(t.id, t);
        });

        // Add route-level tools
        if (route) {
          route.getTools().forEach((t) => {
            availableTools.set(t.id, t);
          });
        }

        // Add step-level tools
        if (step?.tools) {
          for (const toolRef of step.tools) {
            if (typeof toolRef === "string") {
              // Keep as is
            } else if (toolRef.id) {
              availableTools.set(toolRef.id, toolRef);
            }
          }
        }

        tool = availableTools.get(prepareOrFinalize);
      } else {
        // Tool object - use directly
        tool = prepareOrFinalize;
      }

      if (tool) {
        const toolExecutor = new ToolExecutor<TContext, TData>();
        const result = await toolExecutor.executeTool({
          tool,
          context,
          updateContext: this.updateContext.bind(this),
          updateData: this.updateCollectedData.bind(this),
          history: [], // Empty history for prepare/finalize
          data,
        });

        if (!result.success) {
          logger.error(
            `[Agent] Tool execution failed in prepare/finalize: ${result.error}`
          );
          throw new Error(`Tool execution failed: ${result.error}`);
        }
      } else {
        logger.warn(
          `[Agent] Tool not found for prepare/finalize: ${typeof prepareOrFinalize === "string"
            ? prepareOrFinalize
            : "inline tool"
          }`
        );
      }
    }
  }

  /**
   * Clear the current session
   */
  clearCurrentSession(): void {
    this.currentSession = undefined;
  }

  /**
   * Get collected data from current session or agent-level collected data
   * @param routeId - Optional route ID to get data for (uses current route if not provided)
   * @returns The collected data from the current session or agent-level data
   */
  getData(): Partial<TData> {
    // If we have a current session, use session data
    if (this.currentSession) {
      // With agent-level data, all routes share the same data structure
      // No need for route-specific data access
      return (this.currentSession.data) || {};
    }

    // Otherwise, return agent-level collected data
    return this.getCollectedData();
  }

  /**
   * Manually transition to a different route
   * Sets a pending transition that will be executed on the next respond() call
   *
   * @param routeIdOrTitle - Route ID or title to transition to
   * @param session - Session step to update (uses current session if not provided)
   * @param condition - Optional AI-evaluated condition for the transition
   * @returns Updated session with pending transition
   *
   * @example
   * // After route completes
   * if (response.isRouteComplete && response.session) {
   *   const updatedSession = agent.nextStepRoute("feedback-collection", response.session);
   *   // Next respond() call will automatically transition to feedback route
   *   const nextResponse = await agent.respond({ history, session: updatedSession });
   * }
   */
  async nextStepRoute(
    routeIdOrTitle: string,
    session?: SessionState<TData>,
    condition?: Template<TContext, TData>,
    history?: Event[]
  ): Promise<SessionState<TData>> {
    const targetSession = session || this.currentSession;

    if (!targetSession) {
      throw new Error(
        "No session provided and no current session available. Please provide a session to transition."
      );
    }

    // Find target route by ID or title
    const targetRoute = this.routes.find(
      (r) => r.id === routeIdOrTitle || r.title === routeIdOrTitle
    );

    if (!targetRoute) {
      throw new Error(
        `Route not found: ${routeIdOrTitle}. Available routes: ${this.routes
          .map((r) => r.title)
          .join(", ")}`
      );
    }
    const templateContext = {
      context: this.context,
      session,
      history,
      data: this.currentSession?.data,
    };
    const renderedCondition = await render(condition, templateContext);

    const updatedSession: SessionState<TData> = {
      ...targetSession,
      pendingTransition: {
        targetRouteId: targetRoute.id,
        condition: renderedCondition,
        reason: "route_complete",
      },
    };

    // Update current session if using it
    if (!session && this.currentSession) {
      this.currentSession = updatedSession;
    }

    logger.debug(
      `[Agent] Set pending transition to route: ${targetRoute.title}`
    );

    return updatedSession;
  }

  /**
   * Simplified respond method using SessionManager
   * Automatically manages conversation history through the session
   */
  async chat(
    message?: string,
    options?: GenerateOptions<TContext>
  ): Promise<AgentResponse<TData>> {
    // Delegate to ResponseModal.generate()
    return this.responseModal.generate(message, options);
  }

  /**
   * Modern streaming API - simple interface like chat() but returns a stream
   * Automatically manages conversation history through the session
   */
  async *stream(
    message?: string,
    options?: StreamOptions<TContext>
  ): AsyncGenerator<AgentResponseStreamChunk<TData>> {
    // Delegate to ResponseModal with the same options structure as chat()
    yield* this.responseModal.stream(message, {
      history: options?.history,
      contextOverride: options?.contextOverride,
      signal: options?.signal,
    });
  }
}