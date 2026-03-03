/**
 * Core Agent implementation
 */

import type {
  AgentOptions,
  Term,
  Guideline,
  GuidelineMatch,
  Tool,
  Event,
  RouteOptions,
  SessionState,
  Template,
  AgentResponseStreamChunk,
  AgentResponse,
  StructuredSchema,
  ValidationError,
  ValidationResult,
  AiProvider,
} from "../types";
import { CompositionMode } from "../types";
import type { StreamOptions, GenerateOptions, RespondParams } from "./ResponseModal";
import {
  mergeCollected,
  logger,
  LoggerLevel,
  render,
  createTemplateContext,
  createConditionEvaluator,
} from "../utils";

import { Route } from "./Route";
import { Step } from "./Step";
import { PersistenceManager } from "./PersistenceManager";
import { SessionManager } from "./SessionManager";
import { RoutingEngine } from "./RoutingEngine";

import { ResponseModal } from "./ResponseModal";
import { ToolManager } from "./ToolManager";

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
  private _terms: Term<TContext, TData>[] = [];
  private _guidelines: Guideline<TContext, TData>[] = [];
  private _tools: Tool<TContext, TData>[] = [];
  private _routes: Route<TContext, TData>[] = [];
  private _rules: Template<TContext, TData>[] = [];
  private _prohibitions: Template<TContext, TData>[] = [];
  private _context: TContext | undefined;
  private _persistenceManager: PersistenceManager<TData> | undefined;
  private _routingEngine: RoutingEngine<TContext, TData>;
  private _responseModal: ResponseModal<TContext, TData>;
  private _currentSession?: SessionState<TData>;
  private _knowledgeBase: Record<string, unknown> = {};
  private _schema?: StructuredSchema;
  private _collectedData: Partial<TData> = {};

  /** Public session manager for easy session management */
  public session: SessionManager<TData>;

  /** Public tool manager for simplified tool creation and management */
  public tool: ToolManager<TContext, TData>;

  constructor(private options: AgentOptions<TContext, TData>) {
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
      this._schema = options.schema;
      this.validateSchema(this._schema);
      logger.debug("[Agent] Agent-level schema initialized and validated");
    }

    // Initialize context if provided
    this._context = options.context;

    // Initialize collected data with initial data if provided
    if (options.initialData) {
      if (this._schema) {
        const validation = this.validateData(options.initialData);
        if (!validation.valid) {
          throw new Error(
            `Initial data validation failed: ${validation.errors.map(e => e.message).join(', ')}`
          );
        }
      }
      this._collectedData = { ...options.initialData };
      logger.debug("[Agent] Initial data set:", this._collectedData);
    }

    // Initialize current session if provided
    this._currentSession = options.session;

    // Initialize routing engine
    this._routingEngine = new RoutingEngine<TContext, TData>({
      routeSwitchMargin: options.routeSwitchMargin,
    });

    // Initialize ResponseModal for handling all response generation
    this._responseModal = new ResponseModal<TContext, TData>(this);

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

        this._persistenceManager = new PersistenceManager<TData>(options.persistence);

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

    // Initialize agent-level rules and prohibitions
    if (options.rules) {
      this._rules = [...options.rules];
    }
    if (options.prohibitions) {
      this._prohibitions = [...options.prohibitions];
    }

    if (options.routes) {
      options.routes.forEach((routeOptions) => {
        this.createRoute(routeOptions);
      });
    }

    // Initialize knowledge base
    if (options.knowledgeBase) {
      this._knowledgeBase = { ...options.knowledgeBase };
    }

    // Initialize session manager with reference to this agent for bidirectional sync
    this.session = new SessionManager<TData>(this._persistenceManager, this);

    // Initialize tool manager with proper type inference
    this.tool = new ToolManager<TContext, TData>(this);

    // Store sessionId for later use in getOrCreate calls
    if (options.sessionId) {
      this.session.setDefaultSessionId(options.sessionId);
      // The session will be loaded on first getOrCreate call
      this.session.getOrCreate(options.sessionId).then((session) => {
        // Sync session data to agent collected data
        if (session.data && Object.keys(session.data).length > 0) {
          this._collectedData = { ...session.data };
          logger.debug("[Agent] Synced session data to collected data:", this._collectedData);
        }
      }).catch((err) => {
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
    if (!this._schema) {
      // No schema defined, consider all data valid
      return { valid: true, errors: [], warnings: [] };
    }

    const errors: ValidationError[] = [];
    const warnings: ValidationError[] = [];

    // Basic validation - check if provided fields exist in schema
    if (this._schema.properties) {
      for (const [key, value] of Object.entries(data)) {
        if (!(key in this._schema.properties)) {
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
    if (this._schema.required && Array.isArray(this._schema.required)) {
      for (const requiredField of this._schema.required) {
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
    if (!this._schema || !this._schema.properties) {
      // No schema defined, consider all fields valid
      return true;
    }

    return field as string in this._schema.properties;
  }

  /**
   * Get the current collected data
   */
  getCollectedData(): Partial<TData> {
    // Ensure agent collected data is synced with session
    this.syncSessionDataToCollectedData();
    return { ...this._collectedData };
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
    const previousData = { ...this._collectedData };
    this._collectedData = {
      ...this._collectedData,
      ...updates
    };

    // Trigger agent-level lifecycle hook if configured
    if (this.options.hooks?.onDataUpdate) {
      this._collectedData = await this.options.hooks.onDataUpdate(
        this._collectedData,
        previousData
      );
    }

    // Update current session if it exists to keep it in sync
    if (this._currentSession) {
      this._currentSession = mergeCollected(this._currentSession, this._collectedData);
    }

    // Also update the session manager's session data (avoid circular call)
    const sessionManagerSession = this.session.current;
    if (sessionManagerSession) {
      sessionManagerSession.data = { ...this._collectedData };
      sessionManagerSession.metadata!.lastUpdatedAt = new Date();
    }

    logger.debug("[Agent] Collected data updated:", updates);
  }

  // ---------------------------------------------------------------------------
  // Property accessors (get / set)
  // ---------------------------------------------------------------------------

  /**
   * Get agent name
   */
  get name(): string {
    return this.options.name;
  }

  /**
   * Set agent name
   */
  set name(value: string) {
    this.options.name = value;
  }

  /**
   * Get agent description
   */
  get description(): string | undefined {
    return this.options.description;
  }

  /**
   * Set agent description
   */
  set description(value: string | undefined) {
    this.options.description = value;
  }

  /**
   * Get agent goal
   */
  get goal(): string | undefined {
    return this.options.goal;
  }

  /**
   * Set agent goal
   */
  set goal(value: string | undefined) {
    this.options.goal = value;
  }

  /**
   * Get agent identity
   */
  get identity(): Template<TContext> | undefined {
    return this.options.identity;
  }

  /**
   * Set agent identity
   */
  set identity(value: Template<TContext> | undefined) {
    this.options.identity = value;
  }

  /**
   * Get agent personality
   */
  get personality(): Template<TContext> | undefined {
    return this.options.personality;
  }

  /**
   * Set agent personality
   */
  set personality(value: Template<TContext> | undefined) {
    this.options.personality = value;
  }

  /**
   * Get whether debug mode is enabled
   */
  get debug(): boolean {
    return this.options.debug ?? false;
  }

  /**
   * Set debug mode (also updates logger level)
   */
  set debug(value: boolean) {
    this.options.debug = value;
    logger.setLevel(value ? LoggerLevel.DEBUG : LoggerLevel.INFO);
  }

  /**
   * Get the AI provider
   */
  get provider(): AiProvider {
    return this.options.provider;
  }

  /**
   * Set the AI provider
   */
  set provider(value: AiProvider) {
    this.options.provider = value;
  }

  /**
   * Get the composition mode
   */
  get compositionMode(): CompositionMode {
    return this.options.compositionMode ?? CompositionMode.FLUID;
  }

  /**
   * Set the composition mode
   */
  set compositionMode(value: CompositionMode) {
    this.options.compositionMode = value;
  }

  /**
   * Get the route switch margin
   * @default 15
   */
  get routeSwitchMargin(): number {
    return this.options.routeSwitchMargin ?? 15;
  }

  /**
   * Set the route switch margin
   */
  set routeSwitchMargin(value: number) {
    this.options.routeSwitchMargin = value;
  }

  /**
   * Get the maximum steps per batch
   * @default 1
   */
  get maxStepsPerBatch(): number {
    return this.options.maxStepsPerBatch ?? 1;
  }

  /**
   * Set the maximum steps per batch
   */
  set maxStepsPerBatch(value: number) {
    this.options.maxStepsPerBatch = value;
  }

  /**
   * Get all terms
   */
  get terms(): Term<TContext, TData>[] {
    return [...this._terms];
  }

  /**
   * Get all guidelines
   */
  get guidelines(): Guideline<TContext, TData>[] {
    return [...this._guidelines];
  }

  /**
   * Get all tools
   */
  get tools(): Tool<TContext, TData>[] {
    return [...this._tools];
  }

  /**
   * Get all routes
   */
  get routes(): Route<TContext, TData>[] {
    return [...this._routes];
  }

  /**
   * Get agent-level rules
   */
  get rules(): Template<TContext, TData>[] {
    return [...this._rules];
  }

  /**
   * Set agent-level rules
   */
  set rules(value: Template<TContext, TData>[]) {
    this._rules = [...value];
  }

  /**
   * Get agent-level prohibitions
   */
  get prohibitions(): Template<TContext, TData>[] {
    return [...this._prohibitions];
  }

  /**
   * Set agent-level prohibitions
   */
  set prohibitions(value: Template<TContext, TData>[]) {
    this._prohibitions = [...value];
  }

  /**
   * Get current schema
   */
  get schema(): StructuredSchema | undefined {
    return this._schema;
  }

  /**
   * Set schema (validates structure)
   */
  set schema(value: StructuredSchema | undefined) {
    if (value) {
      this.validateSchema(value);
    }
    this._schema = value;
  }

  /**
   * Get the agent's knowledge base
   */
  get knowledgeBase(): Record<string, unknown> {
    return { ...this._knowledgeBase };
  }

  /**
   * Set the agent's knowledge base
   */
  set knowledgeBase(value: Record<string, unknown>) {
    this._knowledgeBase = { ...value };
  }

  /**
   * Get the current session (if set)
   */
  get currentSession(): SessionState | undefined {
    return this._currentSession;
  }

  /**
   * Set the current session for convenience methods
   * Set to undefined to clear the current session
   */
  set currentSession(value: SessionState | undefined) {
    this._currentSession = value;
  }

  // ---------------------------------------------------------------------------
  // Deprecated method-based accessors (for backward compatibility)
  // ---------------------------------------------------------------------------

  /**
   * Get all terms
   * @deprecated Use `agent.terms` instead
   */
  getTerms(): Term<TContext, TData>[] {
    return this.terms;
  }

  /**
   * Get all tools
   * @deprecated Use `agent.tools` instead
   */
  getTools(): Tool<TContext, TData>[] {
    return this.tools;
  }

  /**
   * Get all guidelines
   * @deprecated Use `agent.guidelines` instead
   */
  getGuidelines(): Guideline<TContext, TData>[] {
    return this.guidelines;
  }

  /**
   * Get all routes
   * @deprecated Use `agent.routes` instead
   */
  getRoutes(): Route<TContext, TData>[] {
    return this.routes;
  }

  /**
   * Get agent-level rules
   * @deprecated Use `agent.rules` instead
   */
  getRules(): Template<TContext, TData>[] {
    return this.rules;
  }

  /**
   * Get agent-level prohibitions
   * @deprecated Use `agent.prohibitions` instead
   */
  getProhibitions(): Template<TContext, TData>[] {
    return this.prohibitions;
  }

  /**
   * Get current schema
   * @deprecated Use `agent.schema` instead
   */
  getSchema(): StructuredSchema | undefined {
    return this.schema;
  }

  /**
   * Get the agent's knowledge base
   * @deprecated Use `agent.knowledgeBase` instead
   */
  getKnowledgeBase(): Record<string, unknown> {
    return this.knowledgeBase;
  }

  /**
   * Get the current session (if set)
   * @deprecated Use `agent.currentSession` instead
   */
  getCurrentSession(): SessionState | undefined {
    return this.currentSession;
  }

  /**
   * Set the current session for convenience methods
   * @deprecated Use `agent.currentSession = session` instead
   * @param session - Session step to use for subsequent calls
   */
  setCurrentSession(session: SessionState): void {
    this.currentSession = session;
  }

  /**
   * Clear the current session
   * @deprecated Use `agent.currentSession = undefined` instead
   */
  clearCurrentSession(): void {
    this._currentSession = undefined;
  }

  /**
   * Get the persistence manager (if configured)
   */
  getPersistenceManager(): PersistenceManager<TData> | undefined {
    return this._persistenceManager;
  }

  /**
   * Check if persistence is enabled
   */
  hasPersistence(): boolean {
    return this._persistenceManager !== undefined;
  }

  // ---------------------------------------------------------------------------
  // Core methods
  // ---------------------------------------------------------------------------

  /**
   * Create a new route (journey) using agent-level data type
   */
  createRoute(
    options: RouteOptions<TContext, TData>
  ): Route<TContext, TData> {
    // Validate that requiredFields exist in agent schema
    if (options.requiredFields && this._schema?.properties) {
      const invalidRequiredFields = options.requiredFields.filter(
        field => !(String(field) in this._schema!.properties!)
      );
      if (invalidRequiredFields.length > 0) {
        throw new RouteConfigurationError(
          options.title,
          invalidRequiredFields.map(f => String(f)),
          `Invalid required fields in route '${options.title}': ${invalidRequiredFields.join(', ')}. ` +
          `Must be valid keys from agent schema. Available fields: ${Object.keys(this._schema.properties).join(', ')}.`
        );
      }
    }

    // Validate that optionalFields exist in agent schema
    if (options.optionalFields && this._schema?.properties) {
      const invalidOptionalFields = options.optionalFields.filter(
        field => !(String(field) in this._schema!.properties!)
      );
      if (invalidOptionalFields.length > 0) {
        throw new RouteConfigurationError(
          options.title,
          invalidOptionalFields.map(f => String(f)),
          `Invalid optional fields in route '${options.title}': ${invalidOptionalFields.join(', ')}. ` +
          `Must be valid keys from agent schema. Available fields: ${Object.keys(this._schema.properties).join(', ')}.`
        );
      }
    }

    const route = new Route<TContext, TData>(options, this);
    this._routes.push(route);
    return route;
  }

  /**
   * Create a domain term for the glossary
   */
  createTerm(term: Term<TContext, TData>): this {
    this._terms.push(term);
    return this;
  }

  /**
   * Create a behavioral guideline
   */
  createGuideline(guideline: Guideline<TContext, TData>): this {
    const guidelineWithId = {
      ...guideline,
      id: guideline.id || `guideline_${this._guidelines.length}`,
      enabled: guideline.enabled !== false, // Default to true
    };
    this._guidelines.push(guidelineWithId);
    return this;
  }

  /**
   * Add a tool to the agent using the unified Tool interface
   * Creates and adds the tool to agent scope in one operation (BREAKING CHANGE: replaces createTool)
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  addTool<TResult = any>(
    tool: Tool<TContext, TData, TResult>
  ): this {
    // Validate tool before adding
    if (!tool || !tool.id || !tool.handler) {
      throw new Error('Invalid tool: must have id and handler properties');
    }

    // Add directly to agent's tools array, preserving the TResult type
    this._tools.push(tool);
    logger.debug(`[Agent] Added tool to agent scope: ${tool.id}`);
    return this;
  }

  /**
   * Register a tool at the agent level (legacy method for backward compatibility)
   * @deprecated Use addTool() with Tool interface instead
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createTool<TResult = any>(tool: Tool<TContext, TData, TResult>): this {
    // Validate tool before adding
    if (!tool || !tool.id || !tool.handler) {
      throw new Error('Invalid tool: must have id and handler properties');
    }

    this._tools.push(tool);
    logger.debug(`[Agent] Created tool (legacy): ${tool.id}`);
    return this;
  }

  /**
   * Register multiple tools at the agent level
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerTools<TResult = any>(tools: Tool<TContext, TData, TResult>[]): this {
    tools.forEach((tool) => {
      // Validate each tool before adding
      if (!tool || !tool.id || !tool.handler) {
        throw new Error(`Invalid tool in batch: must have id and handler properties (tool: ${tool?.id || 'unknown'})`);
      }
      this._tools.push(tool);
    });
    logger.debug(`[Agent] Registered ${tools.length} tools`);
    return this;
  }

  /**
   * Update the agent's context
   * Triggers both agent-level and route-specific onContextUpdate lifecycle hooks if configured
   */
  async updateContext(updates: Partial<TContext>): Promise<void> {
    const previousContext = this._context;

    // Merge updates with current context
    this._context = {
      ...(this._context as Record<string, unknown>),
      ...(updates as Record<string, unknown>),
    } as TContext;

    // Trigger route-specific lifecycle hook if configured and session has current route
    if (this._currentSession?.currentRoute) {
      const currentRoute = this._routes.find(
        (r) => r.id === this._currentSession!.currentRoute?.id
      );
      if (
        currentRoute?.hooks?.onContextUpdate &&
        previousContext !== undefined
      ) {
        await currentRoute.handleContextUpdate(this._context, previousContext);
      }
    }

    // Trigger agent-level lifecycle hook if configured
    if (this.options.hooks?.onContextUpdate && previousContext !== undefined) {
      await this.options.hooks.onContextUpdate(this._context, previousContext);
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
      const currentRoute = this._routes.find(
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
    this._collectedData = { ...newCollected };

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
    return this._context;
  }

  /**
   * Generate a response based on history and context as a stream
   */
  async *respondStream(params: RespondParams<TContext, TData>): AsyncGenerator<AgentResponseStreamChunk<TData>> {
    // Delegate to ResponseModal
    yield* this._responseModal.respondStream(params);
  }

  /**
   * Generate a response based on history and context
   */
  async respond(params: RespondParams<TContext, TData>): Promise<AgentResponse<TData>> {
    // Delegate to ResponseModal
    return this._responseModal.respond(params);
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
    return this._routingEngine;
  }

  /**
   * Get the updateData method bound to this agent
   * @internal Used by ResponseModal
   */
  getUpdateDataMethod(): (session: SessionState<TData>, dataUpdate: Partial<TData>) => Promise<SessionState<TData>> {
    return this.updateData.bind(this);
  }

  /**
   * Evaluate and match active guidelines based on their conditions
   * Returns guidelines that should be active given the current context
   */
  async evaluateGuidelines(
    context?: TContext,
    session?: SessionState<TData>,
    history?: Event[]
  ): Promise<GuidelineMatch<TContext, TData>[]> {
    const templateContext = { context, session, history, data: session?.data };
    const evaluator = createConditionEvaluator(templateContext);
    const matches: GuidelineMatch<TContext, TData>[] = [];

    for (const guideline of this._guidelines) {
      // Skip disabled guidelines
      if (guideline.enabled === false) {
        continue;
      }

      if (guideline.condition) {
        const evaluation = await evaluator.evaluateCondition(guideline.condition, 'AND');

        // Include guideline if:
        // 1. No programmatic conditions (only strings) - always active
        // 2. Programmatic conditions evaluate to true
        if (!evaluation.hasProgrammaticConditions || evaluation.programmaticResult) {
          const rationale = evaluation.aiContextStrings.length > 0
            ? `Condition met: ${evaluation.aiContextStrings.join(" AND ")}`
            : evaluation.hasProgrammaticConditions
              ? "Programmatic condition evaluated to true"
              : "Always active (no conditions)";

          matches.push({
            guideline,
            rationale
          });
        }
      } else {
        // No condition means always active
        matches.push({
          guideline,
          rationale: "Always active (no conditions)"
        });
      }
    }

    return matches;
  }

  /**
   * Execute a prepare or finalize function/tool
   * @internal Used by ResponseModal
   */
  async executePrepareFinalize(
    prepareOrFinalize:
      | string
      | Tool<TContext, TData>
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
      let tool: Tool<TContext, TData> | undefined;

      if (typeof prepareOrFinalize === "string") {
        // Tool ID - use ToolManager to find it across all scopes
        tool = this.tool.find(prepareOrFinalize, undefined, step, route);
      } else {
        // Tool object - validate it has required properties
        if (prepareOrFinalize.id && typeof prepareOrFinalize.handler === 'function') {
          tool = prepareOrFinalize;
        } else {
          logger.error(`[Agent] Invalid tool object for prepare/finalize: missing id or invalid handler`);
          return;
        }
      }

      if (tool) {
        // Use ToolManager for execution
        const result = await this.tool.executeTool({
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
   * Sync session data to agent collected data
   * @internal Used to keep agent and session data in sync
   */
  private syncSessionDataToCollectedData(): void {
    const sessionData = this.session.getData();
    if (sessionData && Object.keys(sessionData).length > 0) {
      this._collectedData = { ...sessionData };
      logger.debug("[Agent] Synced session data to collected data:", this._collectedData);
    }
  }

  /**
   * Get collected data from current session or agent-level collected data
   * @param routeId - Optional route ID to get data for (uses current route if not provided)
   * @returns The collected data from the current session or agent-level data
   */
  getData(): Partial<TData> {
    // Ensure agent collected data is synced with session
    this.syncSessionDataToCollectedData();

    // If we have a current session, use session data
    if (this._currentSession) {
      // With agent-level data, all routes share the same data structure
      // No need for route-specific data access
      return (this._currentSession.data) || {};
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
    const targetSession = session || this._currentSession;

    if (!targetSession) {
      throw new Error(
        "No session provided and no current session available. Please provide a session to transition."
      );
    }

    // Find target route by ID or title
    const targetRoute = this._routes.find(
      (r) => r.id === routeIdOrTitle || r.title === routeIdOrTitle
    );

    if (!targetRoute) {
      throw new Error(
        `Route not found: ${routeIdOrTitle}. Available routes: ${this._routes
          .map((r) => r.title)
          .join(", ")}`
      );
    }
    const templateContext = createTemplateContext({
      context: this._context,
      session,
      history,
      data: this._currentSession?.data,
    });
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
    if (!session && this._currentSession) {
      this._currentSession = updatedSession;
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
    return this._responseModal.generate(message, options);
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
    yield* this._responseModal.stream(message, {
      history: options?.history,
      contextOverride: options?.contextOverride,
      signal: options?.signal,
    });
  }
}