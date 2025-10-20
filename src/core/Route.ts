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
  Term,
  Tool,
  Template,
} from "../types";

import { Step } from "./Step";
import { generateRouteId } from "../utils/id";
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
  public readonly conditions: Template<TContext, TData>[];
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
  public guidelines: Guideline<TContext>[] = [];
  public terms: Term<TContext>[] = [];
  public tools: Tool<TContext, TData, unknown[], unknown>[] = [];
  public knowledgeBase: Record<string, unknown> = {};

  constructor(options: RouteOptions<TContext, TData>) {
    // Use provided ID or generate a deterministic one from the title
    this.id = options.id || generateRouteId(options.title);
    this.title = options.title;
    this.description = options.description;
    this.identity = options.identity;
    this.personality = options.personality;
    this.conditions = options.conditions || [];
    this.rules = options.rules || [];
    this.prohibitions = options.prohibitions || [];

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

    this.initialStep = new Step<TContext, TData>(this.id, initialStepOptions);

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
      options.tools.forEach((tool) => {
        this.createTool(tool);
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
    let currentStep: StepResult<TContext, TData> =
      this.initialStep.asStepResult();

    for (const step of steps) {
      if (step === END_ROUTE) {
        currentStep.nextStep({ step: END_ROUTE });
      } else {
        currentStep = currentStep.nextStep(step);
      }
    }
  }

  /**
   * Create a guideline specific to this route
   */
  createGuideline(guideline: Guideline<TContext>): this {
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
  createTool(tool: Tool<TContext, TData, unknown[], unknown>): this {
    this.tools.push(tool);
    return this;
  }

  /**
   * Register multiple tools for this route
   */
  registerTools(tools: Tool<TContext, TData, unknown[], unknown>[]): this {
    tools.forEach((tool) => this.createTool(tool));
    return this;
  }

  /**
   * Get all guidelines for this route
   */
  getGuidelines(): Guideline<TContext>[] {
    return [...this.guidelines];
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
  getTools(): Tool<TContext, TData, unknown[], unknown>[] {
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
      `Conditions: ${this.conditions.join(", ") || "None"}`,
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
          `    -> ${transition.id}${
            transition.description ? `: ${transition.description}` : ""
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
   * Check if this route is complete based on the provided data
   * @param data - Currently collected agent-level data
   * @returns true if all required fields are present, false otherwise
   */
  isComplete(data: Partial<TData>): boolean {
    if (!this.requiredFields || this.requiredFields.length === 0) {
      return true; // No required fields means route is always complete
    }

    return this.requiredFields.every(field => {
      const value = data[field];
      return value !== undefined && value !== null && value !== '';
    });
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
   */
  getCompletionProgress(data: Partial<TData>): number {
    if (!this.requiredFields || this.requiredFields.length === 0) {
      return 1; // No required fields means 100% complete
    }

    const completedFields = this.requiredFields.filter(field => {
      const value = data[field];
      return value !== undefined && value !== null && value !== '';
    });

    return completedFields.length / this.requiredFields.length;
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
