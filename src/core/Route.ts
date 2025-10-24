/**
 * Route (Journey) DSL implementation
 */

import type {
  RouteOptions,
  RouteRef,
  StepOptions,
  StepResult,
  RouteTransitionConfig,
  RouteCompletionHandler,
  RouteLifecycleHooks,
  StructuredSchema,
  Guideline,
  GuidelineMatch,
  Term,
  Tool,
  Template,
  ConditionTemplate,
  TemplateContext,
  ConditionEvaluationResult,
  SessionState,
  Event,
} from "../types";

import { createConditionEvaluator, generateRouteId, logger } from "../utils";

import { Step } from "./Step";
import { Agent } from './Agent'
import { END_ROUTE } from "../constants";

/**
 * Represents a conversational route/journey
 */
export class Route<TContext = unknown, TData = unknown> {
  public readonly id: string;
  public readonly title: string;
  public readonly description?: string;
  public readonly identity?: Template<TContext, TData>;
  public readonly personality?: Template<TContext, TData>;
  public readonly when?: ConditionTemplate<TContext, TData>;
  public readonly skipIf?: ConditionTemplate<TContext, TData>;
  public readonly rules: Template<TContext, TData>[];
  public readonly prohibitions: Template<TContext, TData>[];
  public readonly initialStep: Step<TContext, TData>;
  public readonly endStepSpec: Omit<
    StepOptions<TContext, TData>,
    "step" | "condition" | "skipIf"
  >;
  public readonly responseOutputSchema?: StructuredSchema;
  public readonly initialData?: Partial<TData>;
  public readonly requiredFields?: (keyof TData)[];
  public readonly optionalFields?: (keyof TData)[];
  public readonly onComplete?:
    | string
    | RouteTransitionConfig<TContext, TData>
    | RouteCompletionHandler<TContext, TData>;
  public readonly hooks?: RouteLifecycleHooks<TContext, TData>;
  public routingExtrasSchema?: StructuredSchema;
  public guidelines: Guideline<TContext, TData>[] = [];
  public terms: Term<TContext>[] = [];
  public tools: Tool<TContext, TData>[] = [];
  public knowledgeBase: Record<string, unknown> = {};

  // Reference to parent agent for ToolManager access
  private parentAgent?: Agent<TContext, TData>; 

  constructor(options: RouteOptions<TContext, TData>, parentAgent?: Agent<TContext, TData>) {
    // Use provided ID or generate a deterministic one from the title
    this.id = options.id || generateRouteId(options.title);
    this.title = options.title;
    this.description = options.description;
    this.identity = options.identity;
    this.personality = options.personality;
    this.when = options.when;
    this.skipIf = options.skipIf;
    this.rules = options.rules || [];
    this.prohibitions = options.prohibitions || [];

    // Store reference to parent agent for ToolManager access
    this.parentAgent = parentAgent;

    // Handle initial step logic
    let initialStepOptions = options.initialStep;
    let stepsToChain: StepOptions<TContext, TData>[] = [];

    if (options.steps && options.steps.length > 0) {
      // If steps are provided but no initialStep, use first step as initial
      if (!options.initialStep) {
        initialStepOptions = options.steps[0];
        stepsToChain = options.steps.slice(1);
      } else {
        // Both initialStep and steps provided - chain steps after initial
        stepsToChain = options.steps;
      }
    }

    this.initialStep = new Step<TContext, TData>(this.id, initialStepOptions, this.parentAgent);

    // Store endStep spec (will be used when route completes)
    this.endStepSpec = options.endStep || {
      prompt:
        "Summarize what was accomplished and confirm completion based on the conversation history and collected data",
    };
    this.routingExtrasSchema = options.routingExtrasSchema;
    this.responseOutputSchema = options.responseOutputSchema;
    this.initialData = options.initialData;
    this.requiredFields = options.requiredFields;
    this.optionalFields = options.optionalFields;
    this.onComplete = options.onComplete;
    this.hooks = options.hooks;

    // Initialize knowledge base
    if (options.knowledgeBase) {
      this.knowledgeBase = { ...options.knowledgeBase };
    }

    // Initialize guidelines from options
    if (options.guidelines) {
      options.guidelines.forEach((guideline) => {
        this.createGuideline(guideline);
      });
    }

    // Initialize terms from options
    if (options.terms) {
      options.terms.forEach((term) => {
        this.createTerm(term);
      });
    }

    // Initialize tools from options
    if (options.tools) {
      options.tools.forEach((toolRef) => {
        if (typeof toolRef === 'string') {
          // Tool ID - try to resolve from ToolManager
          if (this.parentAgent?.tool) {
            const registeredTool = this.parentAgent.tool.find(toolRef);
            if (registeredTool) {
              this.createTool(registeredTool);
            } else {
              // Tool not found - log warning but don't fail
              logger.warn(`[Route] Tool ID '${toolRef}' not found in any scope for route ${this.title}`);
            }
          } else {
            logger.warn(`[Route] No agent available to resolve tool ID '${toolRef}' for route ${this.title}`);
          }
        } else {
          // Inline tool object - validate and use directly
          if (toolRef && toolRef.id && typeof toolRef.handler === 'function') {
            this.createTool(toolRef);
          } else {
            logger.warn(`[Route] Invalid inline tool object in route ${this.title}:`, toolRef);
          }
        }
      });
    }

    // Build sequential steps if provided
    if (stepsToChain.length > 0) {
      this.buildSequentialSteps(stepsToChain);
    }
  }

  /**
   * Build a sequential step machine from an array of steps
   * @private
   */
  private buildSequentialSteps(
    steps: Array<StepOptions<TContext, TData> | typeof END_ROUTE>
  ): void {
    let currentStepResult: StepResult<TContext, TData> = this.initialStep.asStepResult();

    for (const step of steps) {
      if (step === END_ROUTE) {
        currentStepResult.nextStep({ step: END_ROUTE });
      } else {
        currentStepResult = currentStepResult.nextStep(step);
      }
    }
  }

  /**
   * Evaluate the when condition for this route
   * @param templateContext - Context for condition evaluation
   * @returns Evaluation result with programmatic result and AI context strings
   */
  async evaluateWhen(
    templateContext: TemplateContext<TContext, TData>
  ): Promise<ConditionEvaluationResult> {
    if (!this.when) {
      return {
        programmaticResult: true, // No condition means always eligible
        aiContextStrings: [],
        hasProgrammaticConditions: false,
      };
    }

    const evaluator = createConditionEvaluator(templateContext);
    return await evaluator.evaluateCondition(this.when, 'AND');
  }

  /**
   * Evaluate the skipIf condition for this route
   * @param templateContext - Context for condition evaluation
   * @returns Evaluation result with programmatic result and AI context strings
   */
  async evaluateSkipIf(
    templateContext: TemplateContext<TContext, TData>
  ): Promise<ConditionEvaluationResult> {
    if (!this.skipIf) {
      return {
        programmaticResult: false, // No skipIf means never skip
        aiContextStrings: [],
        hasProgrammaticConditions: false,
      };
    }

    const evaluator = createConditionEvaluator(templateContext);
    return await evaluator.evaluateCondition(this.skipIf, 'OR');
  }

  /**
   * Create a guideline specific to this route
   */
  createGuideline(guideline: Guideline<TContext, TData>): this {
    this.guidelines.push({
      ...guideline,
      id: guideline.id || `guideline_${this.id}_${this.guidelines.length}`,
      enabled: guideline.enabled !== false, // Default to true
    });
    return this;
  }

  /**
   * Create a term for the route's domain glossary
   */
  createTerm(term: Term<TContext>): this {
    this.terms.push(term);
    return this;
  }

  /**
   * Register a tool for this route
   */
  createTool(tool: Tool<TContext, TData>): this {
    // Validate tool before adding
    if (!tool || !tool.id || !tool.handler) {
      throw new Error(`Invalid tool: must have id and handler properties`);
    }
    
    this.tools.push(tool);
    return this;
  }

  /**
   * Register multiple tools for this route
   */
  registerTools(tools: Tool<TContext, TData>[]): this {
    tools.forEach((tool) => this.createTool(tool));
    return this;
  }

  /**
   * Add a tool to this route using the ToolManager API
   * Creates and adds the tool to route scope in one operation
   */
  addTool(
    tool: Tool<TContext, TData>
  ): this {
    if (this.parentAgent && this.parentAgent.tool) {
      // Use ToolManager to add to route scope - no casting needed with unified interface
      this.parentAgent.tool.addToRoute(this, tool);
    } else {
      // Fallback: add tool directly to route tools
      this.createTool(tool);
    }
    return this;
  }

  /**
   * Get all guidelines for this route
   */
  getGuidelines(): Guideline<TContext, TData>[] {
    return [...this.guidelines];
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

    for (const guideline of this.guidelines) {
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
   * Get all terms for this route
   */
  getTerms(): Term<TContext>[] {
    return [...this.terms];
  }

  /**
   * Get all tools for this route
   */
  getTools(): Tool<TContext, TData>[] {
    return [...this.tools];
  }

  /**
   * Get the route's knowledge base
   */
  getKnowledgeBase(): Record<string, unknown> {
    return { ...this.knowledgeBase };
  }

  /**
   * Get rules for this route
   */
  getRules(): Template<TContext, TData>[] {
    return [...this.rules];
  }

  /**
   * Get prohibitions for this route
   */
  getProhibitions(): Template<TContext, TData>[] {
    return [...this.prohibitions];
  }

  /**
   * Get optional extras schema requested during routing
   */
  getRoutingExtrasSchema(): StructuredSchema | undefined {
    return this.routingExtrasSchema;
  }

  /**
   * Get optional structured response schema for this route's message
   */
  getResponseOutputSchema(): StructuredSchema | undefined {
    return this.responseOutputSchema;
  }

  getSteps(): Step<TContext, TData>[] {
    return this.getAllSteps();
  }

  /**
   * Get route reference
   */
  getRef(): RouteRef {
    return {
      id: this.id,
    };
  }

  /**
   * Get all steps in this route (via traversal from initial step)
   */
  getAllSteps(): Step<TContext, TData>[] {
    const visited = new Set<string>();
    const steps: Step<TContext, TData>[] = [];
    const queue: Step<TContext, TData>[] = [this.initialStep];

    while (queue.length > 0) {
      const current = queue.shift()!;

      if (visited.has(current.id)) {
        continue;
      }

      visited.add(current.id);
      steps.push(current);

      // Add target steps from transitions
      for (const nextStep of current.getTransitions()) {
        if (nextStep && !visited.has(nextStep.id)) {
          queue.push(nextStep);
        }
      }
    }

    return steps;
  }

  /**
   * Get a specific step by ID
   * @param stepId - The step ID to find
   * @returns The step if found, undefined otherwise
   */
  getStep(stepId: string): Step<TContext, TData> | undefined {
    const steps = this.getAllSteps();
    return steps.find((step) => step.id === stepId);
  }

  /**
   * Get a description of the route structure for debugging
   */
  describe(): string {
    const lines: string[] = [
      `Route: ${this.title}`,
      `ID: ${this.id}`,
      `Description: ${this.description || "N/A"}`,
      `When: ${this.when ? (typeof this.when === 'string' ? this.when : Array.isArray(this.when) ? '[Array]' : '[Function]') : "None"}`,
      `SkipIf: ${this.skipIf ? (typeof this.skipIf === 'string' ? this.skipIf : Array.isArray(this.skipIf) ? '[Array]' : '[Function]') : "None"}`,
      "",
      "Steps:",
    ];

    const steps = this.getAllSteps();
    for (const step of steps) {
      lines.push(
        `  - ${step.id}${step.description ? `: ${step.description}` : ""}`
      );

      const transitions = step.getTransitions();
      for (const transition of transitions) {
        lines.push(
          `    -> ${transition.id}${transition.description ? `: ${transition.description}` : ""
          }`
        );
      }
    }

    return lines.join("\n");
  }

  /**
   * Handle data updates for this route, calling the onDataUpdate hook if configured
   * @param data - New collected data
   * @param previousCollected - Previously collected data
   * @returns Modified data after hook processing, or original data if no hook
   */
  async handleDataUpdate(
    data: Partial<TData>,
    previousCollected: Partial<TData>
  ): Promise<Partial<TData>> {
    // Call route-specific onDataUpdate hook if configured
    if (this.hooks?.onDataUpdate) {
      return await this.hooks.onDataUpdate(data, previousCollected);
    }

    // Return original data if no hook
    return data;
  }

  /**
   * Handle context updates for this route, calling the onContextUpdate hook if configured
   * @param newContext - New context
   * @param previousContext - Previous context
   */
  async handleContextUpdate(
    newContext: TContext,
    previousContext: TContext
  ): Promise<void> {
    // Call route-specific onContextUpdate hook if configured
    if (this.hooks?.onContextUpdate) {
      await this.hooks.onContextUpdate(newContext, previousContext);
    }
  }

  /**
   * Export route configuration as RouteOptions for copying/cloning
   * @returns RouteOptions that can be used to create a new route with identical configuration
   */
  toOptions(): RouteOptions<TContext, TData> {
    // Convert steps to StepOptions
    const steps = this.getAllSteps()
      .filter(step => step.id !== this.initialStep.id) // Exclude initial step
      .map(step => ({
        id: step.id,
        description: step.description,
        prompt: step.prompt,
        tools: step.tools,
        prepare: step.prepare,
        finalize: step.finalize,
        collect: step.collect,
        skipIf: step.skipIf,
        requires: step.requires,
        when: step.when,
        guidelines: step.getGuidelines(),
      }));

    return {
      id: this.id,
      title: this.title,
      description: this.description,
      identity: this.identity,
      personality: this.personality,
      when: this.when,
      skipIf: this.skipIf,
      guidelines: this.getGuidelines(),
      terms: this.getTerms(),
      tools: this.getTools(),
      rules: this.rules,
      prohibitions: this.prohibitions,
      routingExtrasSchema: this.routingExtrasSchema,
      responseOutputSchema: this.responseOutputSchema,
      requiredFields: this.requiredFields,
      optionalFields: this.optionalFields,
      initialData: this.initialData,
      steps: steps.length > 0 ? steps : undefined,
      initialStep: {
        id: this.initialStep.id,
        description: this.initialStep.description,
        prompt: this.initialStep.prompt,
        tools: this.initialStep.tools,
        prepare: this.initialStep.prepare,
        finalize: this.initialStep.finalize,
        collect: this.initialStep.collect,
        skipIf: this.initialStep.skipIf,
        requires: this.initialStep.requires,
        when: this.initialStep.when,
        guidelines: this.initialStep.getGuidelines(),
      },
      endStep: this.endStepSpec,
      onComplete: this.onComplete,
      hooks: this.hooks,
      knowledgeBase: this.knowledgeBase,
    };
  }

  /**
   * Check if this route is complete based on the provided data
   * @param data - Currently collected agent-level data
   * @returns true if all required fields are present, false otherwise
   * 
   * Note: Routes with no requiredFields AND no optionalFields are never complete
   * based on data (they complete via END_ROUTE). Routes with only optionalFields
   * are always complete (optional data doesn't block completion).
   */
  isComplete(data: Partial<TData>): boolean {
    // If route has required fields, check if they're all collected
    if (this.requiredFields && this.requiredFields.length > 0) {
      return this.requiredFields.every(field => {
        const value = data[field];
        return value !== undefined && value !== null && value !== '';
      });
    }

    // If route has optional fields but no required fields, it's always complete
    if (this.optionalFields && this.optionalFields.length > 0) {
      return true;
    }

    // No required or optional fields - route doesn't complete based on data
    // It can only complete by reaching END_ROUTE in step flow
    return false;
  }

  /**
   * Get the list of missing required fields for this route
   * @param data - Currently collected agent-level data
   * @returns Array of missing required field keys
   */
  getMissingRequiredFields(data: Partial<TData>): (keyof TData)[] {
    if (!this.requiredFields || this.requiredFields.length === 0) {
      return [];
    }

    return this.requiredFields.filter(field => {
      const value = data[field];
      return value === undefined || value === null || value === '';
    });
  }

  /**
   * Get the completion progress for this route as a percentage
   * @param data - Currently collected agent-level data
   * @returns Completion progress as a number between 0 and 1
   * 
   * Note: Must be consistent with isComplete() logic
   */
  getCompletionProgress(data: Partial<TData>): number {
    // If route has required fields, calculate progress
    if (this.requiredFields && this.requiredFields.length > 0) {
      const completedFields = this.requiredFields.filter(field => {
        const value = data[field];
        return value !== undefined && value !== null && value !== '';
      });
      return completedFields.length / this.requiredFields.length;
    }

    // If route has optional fields but no required fields, it's always complete
    if (this.optionalFields && this.optionalFields.length > 0) {
      return 1;
    }

    // No required or optional fields - route doesn't complete based on data
    // Progress is 0 (must reach END_ROUTE in step flow)
    return 0;
  }

  /**
   * Evaluate the onComplete handler and return transition config
   * @param session - Current session step
   * @param context - Agent context
   * @returns Transition config or undefined if no transition
   */
  async evaluateOnComplete(
    session: { data?: Partial<TData> },
    context?: TContext
  ): Promise<RouteTransitionConfig<TContext, TData> | undefined> {
    if (!this.onComplete) {
      return undefined;
    }

    // String form: just route ID/title
    if (typeof this.onComplete === "string") {
      return {
        nextStep: this.onComplete,
      };
    }

    // Function form: execute and normalize result
    if (typeof this.onComplete === "function") {
      const result = await this.onComplete(session, context);

      if (!result) {
        return undefined;
      }

      if (typeof result === "string") {
        return {
          nextStep: result,
        };
      }

      return result;
    }

    // Object form: return as-is
    return this.onComplete;
  }
}
