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
} from "../types/route";
import type { StructuredSchema } from "../types/schema";
import type { Guideline } from "../types/agent";

import { Step } from "./Step";
import { generateRouteId } from "../utils/id";
import { Template } from "../types/template";

/**
 * Represents a conversational route/journey
 */
export class Route<TContext = unknown, TData = unknown> {
  public readonly id: string;
  public readonly title: string;
  public readonly description?: string;
  public readonly conditions: Template<TContext, TData>[];
  public readonly domains?: string[];
  public readonly rules: Template<TContext, TData>[];
  public readonly prohibitions: Template<TContext, TData>[];
  public readonly initialStep: Step<TContext, TData>;
  public readonly endStepSpec: Omit<
    StepOptions<TContext, TData>,
    "step" | "condition" | "skipIf"
  >;
  public readonly responseOutputSchema?: StructuredSchema;
  public readonly schema?: StructuredSchema;
  public readonly initialData?: Partial<TData>;
  public readonly onComplete?:
    | string
    | RouteTransitionConfig<TContext, TData>
    | RouteCompletionHandler<TContext, TData>;
  private routingExtrasSchema?: StructuredSchema;
  private guidelines: Guideline<TContext>[] = [];

  constructor(options: RouteOptions<TContext, TData>) {
    // Use provided ID or generate a deterministic one from the title
    this.id = options.id || generateRouteId(options.title);
    this.title = options.title;
    this.description = options.description;
    this.conditions = options.conditions || [];
    this.domains = options.domains;
    this.rules = options.rules || [];
    this.prohibitions = options.prohibitions || [];
    this.initialStep = new Step<TContext, TData>(this.id, options.initialStep);
    // Store endStep spec (will be used when route completes)
    this.endStepSpec = options.endStep || {
      prompt:
        "Summarize what was accomplished and confirm completion based on the conversation history and collected data",
    };
    this.routingExtrasSchema = options.routingExtrasSchema;
    this.responseOutputSchema = options.responseOutputSchema;
    this.schema = options.schema;
    this.initialData = options.initialData;
    this.onComplete = options.onComplete;

    // Initialize guidelines from options
    if (options.guidelines) {
      options.guidelines.forEach((guideline) => {
        this.createGuideline(guideline);
      });
    }

    // Build sequential steps if provided
    if (options.steps && options.steps.length > 0) {
      this.buildSequentialSteps(options.steps);
    }
  }

  /**
   * Build a sequential step machine from an array of steps
   * @private
   */
  private buildSequentialSteps(
    steps: Array<StepOptions<TContext, TData>>
  ): void {
    // Import END_ROUTE dynamically to avoid circular dependency
    const END_ROUTE = Symbol.for("END_ROUTE");

    let currentStep: StepResult<TContext, TData> =
      this.initialStep.asStepResult();

    for (const step of steps) {
      currentStep = currentStep.nextStep(step);
    }

    // End the route
    currentStep.nextStep({ step: END_ROUTE });
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
   * Get all guidelines for this route
   */
  getGuidelines(): Guideline<TContext>[] {
    return [...this.guidelines];
  }

  /**
   * Get allowed domain names for this route
   * @returns Array of domain names, or undefined if all domains are allowed
   */
  getDomains(): string[] | undefined {
    return this.domains ? [...this.domains] : undefined;
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
