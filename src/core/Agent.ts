/**
 * Core Agent implementation
 */

import type {
  AgentOptions,
  Term,
  Instruction,
  Tool,
  FlowOptions,
  SessionState,
  Template,
  AgentResponseStreamChunk,
  AgentResponse,
  StructuredSchema,
  ValidationError,
  ValidationResult,
  AiProvider,
  CompactionOptions,
  Directive,
} from "../types";
import type { Signal } from "../types/signals";
import { NotImplementedError } from "../types/errors";
import { SignalProcessor } from "./SignalProcessor";
import { SignalEvaluator } from "./SignalEvaluator";
import type { StreamOptions, GenerateOptions, RespondParams } from "./ResponseModal";
import {
  mergeCollected,
  enterFlow,
  enterStep,
  completeCurrentFlow,
  logger,
  LoggerLevel,
  generateSignalId,
} from "../utils";

import { Flow } from "./Flow";
import { Step, FlowConfigurationError as StepFlowConfigurationError } from "./Step";
import { PersistenceManager } from "./PersistenceManager";
import { SessionManager } from "./SessionManager";
import { FlowRouter } from "./FlowRouter";
import { PromptSectionCache } from "./PromptSectionCache";

import { ResponseModal } from "./ResponseModal";
import { ToolManager } from "./ToolManager";
import { CompactionEngine } from "./CompactionEngine";

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
 * Error thrown when flow configuration is invalid
 */
class FlowConfigurationError extends Error {
  constructor(public flowTitle: string, public invalidFields: string[], message?: string) {
    super(message || `Flow configuration error in '${flowTitle}'`);
    this.name = "FlowConfigurationError";
  }
}

/**
 * Main Agent class with generic context and data support
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export class Agent<TContext = any, TData = any> {
  private _terms: Term<TContext, TData>[] = [];
  private _instructions: Instruction<TContext, TData>[] = [];
  private _tools: Tool<TContext, TData>[] = [];
  private _flows: Flow<TContext, TData>[] = [];
  private _context: TContext | undefined;
  private _persistenceManager: PersistenceManager<TData> | undefined;
  private _routingEngine: FlowRouter<TContext, TData>;
  private _responseModal: ResponseModal<TContext, TData>;
  private _currentSession?: SessionState<TData>;
  private _knowledgeBase: Record<string, unknown> = {};
  private _schema?: StructuredSchema;
  private _collectedData: Partial<TData> = {};
  private _compactionOptions?: CompactionOptions;
  private _promptSectionCache: PromptSectionCache;

  /** Signals: typed event detectors that run around the LLM turn. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _signals: Signal<TContext, TData, any>[];

  /**
   * Signal processor instance. Undefined when no signals are configured.
   * Constructed only when `options.signals` is non-empty (Requirement 2.3).
   */
  public signalProcessor: SignalProcessor<TContext, TData> | undefined;

  /** Maximum consecutive auto-steps allowed in a single turn before throwing. */
  public readonly maxAutoStepsPerTurn: number;

  /** Maximum chained directives allowed in a single turn before throwing. */
  public readonly maxDirectiveChain: number;

  /** Public session manager for easy session management */
  public session: SessionManager<TData>;

  /** Public tool manager for simplified tool creation and management */
  public tool: ToolManager<TContext, TData>;

  constructor(private options: AgentOptions<TContext, TData>) {
    this.maxAutoStepsPerTurn = options.maxAutoStepsPerTurn ?? 10;
    this.maxDirectiveChain = options.maxDirectiveChain ?? 10;

    // Validate routerMode reservation — only 'ai' is supported in v2.0
    if (options.routerMode !== undefined && options.routerMode !== 'ai') {
      throw new NotImplementedError(
        `[NotImplementedError] routerMode "${String(options.routerMode)}" is not implemented: only "ai" is supported in v2.0. ` +
        `Set routerMode to "ai" or omit the option.`
      );
    }

    // ─── Signal construction-time validation (Requirements 1.4, 1.5, 1.6, 1.9, 2.3) ───
    const rawSignals = options.signals ?? [];

    // Auto-generate stable ids for entries without `id`
    for (let i = 0; i < rawSignals.length; i++) {
      if (!rawSignals[i].id) {
        rawSignals[i] = {
          ...rawSignals[i],
          id: generateSignalId(rawSignals[i].title, rawSignals[i].description, i),
        };
      }
    }

    // Validate unique ids (Requirement 1.4)
    const idCounts = new Map<string, number>();
    for (const signal of rawSignals) {
      const id = signal.id!;
      idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
    }
    const duplicateIds = [...idCounts.entries()]
      .filter(([, count]) => count > 1)
      .map(([id]) => id);
    if (duplicateIds.length > 0) {
      throw new StepFlowConfigurationError(
        `[FlowConfigurationError] Duplicate signal ids: ${duplicateIds.join(', ')}. ` +
        `Each signal must have a unique id.`
      );
    }

    // Validate signalBatchSize (positive integer when set)
    if (options.signalBatchSize !== undefined) {
      if (
        !Number.isInteger(options.signalBatchSize) ||
        options.signalBatchSize <= 0
      ) {
        throw new StepFlowConfigurationError(
          `[FlowConfigurationError] signalBatchSize must be a positive integer, got: ${options.signalBatchSize}.`
        );
      }
    }

    // Validate each signal's configuration
    for (const signal of rawSignals) {
      // Requirement 1.5: cooldown without cooldownMs → debug warning, treat as 'always'
      if (signal.behavior === 'cooldown' && signal.cooldownMs == null) {
        logger.debug(
          `[Agent] Signal "${signal.id}" has behavior 'cooldown' but no cooldownMs. Treating as 'always'.`
        );
        (signal as { behavior?: string }).behavior = 'always';
      }

      // Requirement 1.9: validate extract schema is a JSON Schema object
      if (signal.extract !== undefined) {
        if (
          signal.extract === null ||
          typeof signal.extract !== 'object' ||
          Array.isArray(signal.extract)
        ) {
          throw new StepFlowConfigurationError(
            `[FlowConfigurationError] Signal "${signal.id}" has an invalid extract schema. ` +
            `Expected a JSON Schema object, got: ${typeof signal.extract}.`
          );
        }
      }
    }

    this._signals = rawSignals;

    // Requirement 2.3: Only instantiate SignalProcessor when signals are present
    if (rawSignals.length > 0) {
      const evaluator = new SignalEvaluator<TContext, TData>(options.provider);
      this.signalProcessor = new SignalProcessor<TContext, TData>(
        rawSignals,
        options.provider,
        evaluator,
        { batchSize: options.signalBatchSize ?? 10 },
      );
    } else {
      this.signalProcessor = undefined;
    }

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

    // Initialize prompt section cache
    this._promptSectionCache = new PromptSectionCache(options.promptCache);

    // Initialize flow router
    this._routingEngine = new FlowRouter<TContext, TData>({
      flowSwitchMargin: options.flowSwitchMargin,
      onFlowSwitch: () => this.invalidateFlowSections(),
      promptSectionCache: this._promptSectionCache,
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

    // Initialize instructions (new unified form)
    if (options.instructions) {
      options.instructions.forEach((instruction) => {
        this.createInstruction(instruction);
      });
    }

    if (options.tools) {
      options.tools.forEach((tool) => {
        this.addTool(tool);
      });
    }

    if (options.flows) {
      options.flows.forEach((flowOptions) => {
        this.createFlow(flowOptions);
      });
    }

    // Validate deferred branch `then` string references against the flow registry.
    // This catches strings that don't match a local step id AND don't match any flow id/title.
    this.validateBranchReferences();

    // Initialize knowledge base
    if (options.knowledgeBase) {
      this._knowledgeBase = { ...options.knowledgeBase };
    }

    // Initialize compaction options if configured
    if (options.compaction && options.compaction.enabled !== false) {
      const compactionOptions: CompactionOptions = {
        maxTokens: options.compaction.maxTokens,
        compactionThreshold: options.compaction.compactionThreshold ?? 0.8,
        preserveRecentCount: options.compaction.preserveRecentCount ?? 4,
        maxToolResultChars: options.compaction.maxToolResultChars ?? 5000,
        provider: options.provider,
      };
      CompactionEngine.validateOptions(compactionOptions);
      this._compactionOptions = compactionOptions;
      logger.debug("[Agent] Compaction options initialized and validated");
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
   * Walk every flow's steps and resolve deferred string `then` values in branches
   * against the agent's flow registry. Strings that match neither a local step id
   * nor any flow id/title throw FlowConfigurationError.
   * @private
   */
  private validateBranchReferences(): void {
    for (const flow of this._flows) {
      this.validateFlowBranchReferences(flow);
    }
  }

  /**
   * Validate branch `then` string references for a single flow against the agent's
   * flow registry. Throws FlowConfigurationError for unresolved references.
   * @private
   */
  private validateFlowBranchReferences(flow: Flow<TContext, TData>): void {
    const steps = flow.getAllSteps();
    const localStepIds = new Set(steps.map(s => s.id));

    for (const step of steps) {
      if (!step.branches) continue;

      for (const entry of step.branches) {
        if (typeof entry.then !== 'string') continue;

        // Already matches a local step id — no deferred resolution needed
        if (localStepIds.has(entry.then)) continue;

        // Check against the agent's flow registry (id or title)
        const matchesFlow = this._flows.some(
          f => f.id === entry.then || f.title === entry.then
        );

        if (!matchesFlow) {
          throw new StepFlowConfigurationError(
            `[FlowConfigurationError] Unresolved branch target: "${entry.then}" in ${flow.id}.${step.id} does not match any step in the flow or any flow in the agent. ` +
            `Fix the branch "then" value to reference a valid step id or flow id/title.`
          );
        }
      }
    }
  }

  /**
   * Validate that every step's `collect` fields in a flow reference valid keys
   * from the agent-level schema. Throws FlowConfigurationError at construction
   * time if any collect field is not a valid schema key.
   *
   * This enforces Requirement 14.5: generic inference is preserved AND every
   * `collect` field reference is a valid key of the inferred TData.
   * @private
   */
  private validateFlowCollectFields(flow: Flow<TContext, TData>): void {
    const schemaKeys = Object.keys(this._schema!.properties!);
    const schemaKeySet = new Set(schemaKeys);
    const steps = flow.getAllSteps();

    for (const step of steps) {
      if (!step.collect || step.collect.length === 0) continue;

      const invalidFields = step.collect.filter(
        field => !schemaKeySet.has(String(field))
      );

      if (invalidFields.length > 0) {
        throw new StepFlowConfigurationError(
          `[FlowConfigurationError] Step "${step.id}" in flow "${flow.title}" references invalid collect fields: ${invalidFields.map(f => String(f)).join(', ')}. ` +
          `Must be valid keys from agent schema. Available fields: ${schemaKeys.join(', ')}.`
        );
      }
    }
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
      throw new DataValidationError(validation.errors, `[DataValidationError] Data validation failed: fields [${errorMessages}] did not pass schema validation. Fix the offending values to match the declared schema.`);
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
   * Get agent persona
   */
  get persona(): Template<TContext> | undefined {
    return this.options.persona;
  }

  /**
   * Set agent persona
   */
  set persona(value: Template<TContext> | undefined) {
    this.options.persona = value;
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
   * Get the flow switch margin
   * @default 15
   */
  get flowSwitchMargin(): number {
    return this.options.flowSwitchMargin ?? 15;
  }

  /**
   * Set the flow switch margin
   */
  set flowSwitchMargin(value: number) {
    this.options.flowSwitchMargin = value;
  }

  /**
   * Get the prompt section cache instance
   */
  get promptSectionCache(): PromptSectionCache {
    return this._promptSectionCache;
  }

  /**
   * Get all terms
   */
  get terms(): Term<TContext, TData>[] {
    return [...this._terms];
  }

  /**
   * Get all instructions
   */
  get instructions(): Instruction<TContext, TData>[] {
    return [...this._instructions];
  }

  /**
   * Get all tools
   */
  get tools(): Tool<TContext, TData>[] {
    return [...this._tools];
  }

  /**
   * Get all flows
   */
  get flows(): Flow<TContext, TData>[] {
    return [...this._flows];
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
   * Get the configured signals.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  get signals(): Signal<TContext, TData, any>[] {
    return this._signals;
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
    this._promptSectionCache.invalidateAll();
  }

  /**
   * Get all flows
   */
  getFlows(): Flow<TContext, TData>[] {
    return this.flows;
  }

  /**
   * Get all terms
   */
  getTerms(): Term<TContext, TData>[] {
    return this.terms;
  }

  /**
   * Get all tools
   */
  getTools(): Tool<TContext, TData>[] {
    return this.tools;
  }

  /**
   * Get all instructions
   */
  getInstructions(): Instruction<TContext, TData>[] {
    return this.instructions;
  }

  /**
   * Invalidate flow-dependent prompt cache sections.
   * Called automatically when the active flow changes.
   */
  invalidateFlowSections(): void {
    this._promptSectionCache.invalidate('activeFlows');
    this._promptSectionCache.invalidate('flowKnowledgeBase');
    this._promptSectionCache.invalidate('instructionsFlow');
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

  /**
   * Get the resolved compaction options (if compaction is configured)
   */
  getCompactionOptions(): CompactionOptions | undefined {
    return this._compactionOptions;
  }

  // ---------------------------------------------------------------------------
  // Core methods
  // ---------------------------------------------------------------------------

  /**
   * Create a new flow (journey) using agent-level data type
   */
  createFlow(
    options: FlowOptions<TContext, TData>
  ): Flow<TContext, TData> {
    // Validate that requiredFields exist in agent schema
    if (options.requiredFields && this._schema?.properties) {
      const invalidRequiredFields = options.requiredFields.filter(
        field => !(String(field) in this._schema!.properties!)
      );
      if (invalidRequiredFields.length > 0) {
        throw new FlowConfigurationError(
          options.title,
          invalidRequiredFields.map(f => String(f)),
          `[FlowConfigurationError] Invalid required fields in flow "${options.title}": [${invalidRequiredFields.join(', ')}] are not declared in the agent schema. ` +
          `Use valid schema keys. Available fields: ${Object.keys(this._schema.properties).join(', ')}.`
        );
      }
    }

    // Validate that optionalFields exist in agent schema
    if (options.optionalFields && this._schema?.properties) {
      const invalidOptionalFields = options.optionalFields.filter(
        field => !(String(field) in this._schema!.properties!)
      );
      if (invalidOptionalFields.length > 0) {
        throw new FlowConfigurationError(
          options.title,
          invalidOptionalFields.map(f => String(f)),
          `[FlowConfigurationError] Invalid optional fields in flow "${options.title}": [${invalidOptionalFields.join(', ')}] are not declared in the agent schema. ` +
          `Use valid schema keys. Available fields: ${Object.keys(this._schema.properties).join(', ')}.`
        );
      }
    }

    const flow = new Flow<TContext, TData>(options, this);

    // Validate that step collect fields reference valid schema keys
    if (this._schema?.properties) {
      this.validateFlowCollectFields(flow);
    }

    this._flows.push(flow);
    return flow;
  }

  /**
   * Create a domain term for the glossary
   */
  createTerm(term: Term<TContext, TData>): this {
    this._terms.push(term);
    return this;
  }

  /**
   * Create an instruction (unified behavioral primitive).
   */
  createInstruction(instruction: Instruction<TContext, TData>): this {
    const instructionWithId = {
      ...instruction,
      kind: instruction.kind || 'should' as const,
      id: instruction.id || `instruction_${this._instructions.length}`,
      enabled: instruction.enabled !== false, // Default to true
    };
    this._instructions.push(instructionWithId);
    this._promptSectionCache.invalidate('instructionsGlobal');
    return this;
  }

  /**
   * Add a tool to the agent using the unified Tool interface
   * Creates and adds the tool to agent scope in one operation
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
   * Triggers both agent-level and flow-specific onContextUpdate lifecycle hooks if configured
   */
  async updateContext(updates: Partial<TContext>): Promise<void> {
    const previousContext = this._context;

    // Merge updates with current context
    this._context = {
      ...(this._context as Record<string, unknown>),
      ...(updates as Record<string, unknown>),
    } as TContext;

    // Trigger flow-specific lifecycle hook if configured and session has current flow
    if (this._currentSession?.currentFlow) {
      const currentFlow = this._flows.find(
        (r) => r.id === this._currentSession!.currentFlow?.id
      );
      if (
        currentFlow?.hooks?.onContextUpdate &&
        previousContext !== undefined
      ) {
        await currentFlow.handleContextUpdate(this._context, previousContext);
      }
    }

    // Trigger agent-level lifecycle hook if configured
    if (this.options.hooks?.onContextUpdate && previousContext !== undefined) {
      await this.options.hooks.onContextUpdate(this._context, previousContext);
    }

    // Invalidate context-dependent prompt cache sections
    this._promptSectionCache.invalidate('agentMeta');
    this._promptSectionCache.invalidate('knowledgeBase');
    this._promptSectionCache.invalidate('instructionsGlobal');
  }

  /**
   * Update collected data in session with lifecycle hook support
   * Triggers both agent-level and flow-specific onDataUpdate lifecycle hooks if configured
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

    // Trigger flow-specific lifecycle hook if configured and session has a current flow
    if (session.currentFlow) {
      const currentFlow = this._flows.find(
        (r) => r.id === session.currentFlow?.id
      );
      if (currentFlow?.hooks?.onDataUpdate) {
        newCollected = await currentFlow.handleDataUpdate(
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
  async * respondStream(params: RespondParams<TContext, TData>): AsyncGenerator<AgentResponseStreamChunk<TData>> {
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
   * Get flow router
   * @internal Used by ResponseModal
   */
  getFlowRouter(): FlowRouter<TContext, TData> {
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
    flow?: Flow<TContext, TData>,
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
        tool = this.tool.find(prepareOrFinalize, undefined, step, flow);
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
   * @returns The collected data from the current session or agent-level data
   */
  getData(): Partial<TData> {
    // Ensure agent collected data is synced with session
    this.syncSessionDataToCollectedData();

    // If we have a current session, use session data
    if (this._currentSession) {
      // With agent-level data, all flows share the same data structure
      // No need for flow-specific data access
      return (this._currentSession.data) || {};
    }

    // Otherwise, return agent-level collected data
    return this.getCollectedData();
  }

  /**
   * Dispatch a directive (or a flow shorthand) into a session.
   * Sets `pendingDirective` on the session without triggering a `respond()` call.
   * The directive will be applied at the start of the next turn.
   *
   * String form desugars to `{ goTo: target }`.
   *
   * @param target - Flow ID/title string (desugars to `{ goTo: target }`) or a full Directive
   * @param session - Session to update (uses current session if not provided)
   * @returns Updated session with `pendingDirective` set
   *
   * @throws FlowConfigurationError if the string target doesn't match any flow
   * @throws FlowConfigurationError if the directive fails validation
   *
   * @example
   * // String shorthand — desugars to { goTo: 'Feedback' }
   * const updated = await agent.dispatch('Feedback', session);
   *
   * @example
   * // Full directive
   * const updated = await agent.dispatch({ goTo: 'Billing', reply: 'Transferring you now.' }, session);
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async dispatch(
    target: string | Directive<TContext, TData>,
    session?: SessionState<TData>
  ): Promise<SessionState<TData>> {
    const targetSession = session || this._currentSession;

    if (!targetSession) {
      throw new Error(
        "No session provided and no current session available. Please provide a session to dispatch into."
      );
    }

    // Desugar string form to { goTo: target }
    const directive: Directive<TContext, TData> = typeof target === 'string'
      ? { goTo: target }
      : target;

    // Validate the directive: check for multiple position fields, empty goTo, etc.
    this.validateDirective(directive);

    // If goTo is a string, validate it references a known flow
    if (typeof directive.goTo === 'string') {
      const flowTarget = directive.goTo;
      const matchesFlow = this._flows.some(
        f => f.id === flowTarget || f.title === flowTarget
      );
      if (!matchesFlow) {
        throw new StepFlowConfigurationError(
          `[FlowConfigurationError] Unknown flow: "${flowTarget}" does not match any flow id or title. ` +
          `Available flows: ${this._flows.map(f => f.title).join(', ')}.`
        );
      }
    } else if (directive.goTo && typeof directive.goTo === 'object' && directive.goTo.flow) {
      const flowTarget = directive.goTo.flow;
      const matchesFlow = this._flows.some(
        f => f.id === flowTarget || f.title === flowTarget
      );
      if (!matchesFlow) {
        throw new StepFlowConfigurationError(
          `[FlowConfigurationError] Unknown flow: "${flowTarget}" does not match any flow id or title. ` +
          `Available flows: ${this._flows.map(f => f.title).join(', ')}.`
        );
      }
    }

    // Strip pre-LLM-only fields before storing
    const stripped = this.stripPreDirectiveFields(directive);

    // Set pendingDirective on the session without applying it
    const updatedSession: SessionState<TData> = {
      ...targetSession,
      pendingDirective: stripped as Directive<unknown, TData>,
      metadata: {
        ...targetSession.metadata,
        lastUpdatedAt: new Date(),
      },
    };

    // Update current session in place if no explicit session was passed
    if (!session && this._currentSession) {
      this._currentSession = updatedSession;
    }

    logger.debug(
      `[Agent] Dispatched directive: pendingDirective set on session ${updatedSession.id}`
    );

    return updatedSession;
  }

  /**
   * Apply a directive synchronously to a session without invoking `respond()`.
   * Performs in-place application: updates flow/step position, merges state writes.
   *
   * This is the synchronous counterpart to `dispatch` — it applies immediately
   * rather than deferring to the next turn.
   *
   * @param directive - The directive to apply
   * @param session - The session to apply the directive to
   * @returns The updated session with the directive applied
   */
  applyDirective(
    directive: Directive<TContext, TData>,
    session: SessionState<TData>
  ): SessionState<TData> {
    // Validate the directive
    this.validateDirective(directive);

    let updatedSession = { ...session };
    const now = new Date();

    // Apply state writes
    if (directive.contextUpdate) {
      // Context updates are applied to the agent, not the session
      this._context = {
        ...(this._context as Record<string, unknown>),
        ...(directive.contextUpdate as Record<string, unknown>),
      } as TContext;
    }

    if (directive.dataUpdate) {
      updatedSession = {
        ...updatedSession,
        data: {
          ...updatedSession.data,
          ...directive.dataUpdate,
        },
      };
    }

    // Apply position control
    if (directive.goTo) {
      const flowTarget = typeof directive.goTo === 'string'
        ? directive.goTo
        : directive.goTo.flow;

      if (flowTarget) {
        const targetFlow = this._flows.find(
          f => f.id === flowTarget || f.title === flowTarget
        );
        if (targetFlow) {
          // Merge goTo.data if present
          if (typeof directive.goTo === 'object' && directive.goTo.data) {
            updatedSession = {
              ...updatedSession,
              data: {
                ...updatedSession.data,
                ...directive.goTo.data,
              },
            };
          }

          updatedSession = enterFlow(updatedSession, targetFlow.id, targetFlow.title);

          // If a specific step is targeted
          if (typeof directive.goTo === 'object' && directive.goTo.step) {
            updatedSession = enterStep(updatedSession, directive.goTo.step);
          }
        }
      }
    } else if (directive.goToStep) {
      const stepTarget = typeof directive.goToStep === 'string'
        ? directive.goToStep
        : directive.goToStep.step;

      // Merge goToStep.data if present
      if (typeof directive.goToStep === 'object' && directive.goToStep.data) {
        updatedSession = {
          ...updatedSession,
          data: {
            ...updatedSession.data,
            ...directive.goToStep.data,
          },
        };
      }

      updatedSession = enterStep(updatedSession, stepTarget);
    } else if (directive.complete) {
      updatedSession = completeCurrentFlow(updatedSession);

      // If complete carries a chained directive, set it as pendingDirective
      if (typeof directive.complete === 'object' && directive.complete.next) {
        updatedSession = {
          ...updatedSession,
          pendingDirective: directive.complete.next as Directive<unknown, TData>,
        };
      }
    } else if (directive.abort) {
      const clearSession = typeof directive.abort === 'object'
        ? directive.abort.clearSession !== false
        : true;

      if (clearSession) {
        updatedSession = {
          ...updatedSession,
          currentFlow: undefined,
          currentStep: undefined,
          data: {} as Partial<TData>,
        };
      } else {
        updatedSession = {
          ...updatedSession,
          currentFlow: undefined,
          currentStep: undefined,
        };
      }
    } else if (directive.reset) {
      const currentFlowId = updatedSession.currentFlow?.id;
      const currentFlowTitle = updatedSession.currentFlow?.title;

      if (currentFlowId && currentFlowTitle) {
        // Clear data if requested
        if (typeof directive.reset === 'object' && directive.reset.clearData) {
          const currentFlow = this._flows.find(f => f.id === currentFlowId);
          if (currentFlow) {
            const ownedFields = [
              ...(currentFlow.requiredFields || []),
              ...(currentFlow.optionalFields || []),
            ];
            updatedSession = completeCurrentFlow(updatedSession, { clearOwnedFields: ownedFields });
            // Re-enter the same flow
            updatedSession = enterFlow(updatedSession, currentFlowId, currentFlowTitle);
          }
        } else {
          // Re-enter the flow from the beginning (or specified step)
          updatedSession = enterFlow(updatedSession, currentFlowId, currentFlowTitle);
        }

        // If a specific step is targeted for reset
        if (typeof directive.reset === 'object' && directive.reset.step) {
          updatedSession = enterStep(updatedSession, directive.reset.step);
        }
      }
    }

    // Update metadata
    updatedSession = {
      ...updatedSession,
      metadata: {
        ...updatedSession.metadata,
        lastUpdatedAt: now,
      },
    };

    return updatedSession;
  }

  /**
   * Validate a directive for structural correctness.
   * Throws FlowConfigurationError for invalid combinations.
   * @private
   */
  private validateDirective(directive: Directive<TContext, TData>): void {
    // Check for multiple position fields
    const positionFields = ['goTo', 'goToStep', 'complete', 'abort', 'reset'] as const;
    const setPositionFields = positionFields.filter(
      field => directive[field] !== undefined
    );

    if (setPositionFields.length > 1) {
      throw new StepFlowConfigurationError(
        `[FlowConfigurationError] Multiple position fields: a Directive may set at most one position field. ` +
        `Found: ${setPositionFields.join(', ')}. Remove all but one.`
      );
    }

    // Check for empty goTo object
    if (directive.goTo && typeof directive.goTo === 'object') {
      const goToObj = directive.goTo;
      if (!goToObj.flow && !goToObj.step) {
        throw new StepFlowConfigurationError(
          `[FlowConfigurationError] Empty goTo: "goTo" requires at least a "flow" field. ` +
          `Provide { goTo: { flow: '<id>' } } or use the string shorthand { goTo: '<id>' }.`
        );
      }
    }
  }

  /**
   * Strip pre-LLM-only fields (appendPrompt, injectTools, halt) from a directive.
   * These fields are transient (one-turn lifetime) and must not be persisted.
   * @private
   */
  private stripPreDirectiveFields(directive: Directive<TContext, TData>): Directive<TContext, TData> {
    const raw = directive as Record<string, unknown>;
    if (!raw.appendPrompt && !raw.injectTools && raw.halt === undefined) {
      return directive;
    }

    const { appendPrompt, injectTools, halt, ...rest } = raw;

    if (appendPrompt || injectTools || halt !== undefined) {
      logger.warn(
        `[Agent] Ignoring pre-LLM-only fields on pendingDirective (these only take effect in onEnter/prepare hooks): ` +
        `${[appendPrompt && 'appendPrompt', injectTools && 'injectTools', halt !== undefined && 'halt'].filter(Boolean).join(', ')}`
      );
    }

    return rest as Directive<TContext, TData>;
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
  async * stream(
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