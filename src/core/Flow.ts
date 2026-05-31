/**
 * Flow (Journey) DSL implementation
 */

import type {
  FlowOptions,
  FlowRef,
  StepOptions,
  FlowLifecycleHooks,
  StructuredSchema,
  Instruction,
  Tool,
  TemplateContext,
  ConditionEvaluationResult,
  Directive,
} from "../types";
import type { SessionState } from "../types/session";
import type { StepResult } from "../types/flow";
import type { ConditionWhen, ConditionIf } from "../types/flow";

import { generateFlowId, logger } from "../utils";

import { Step, FlowConfigurationError } from "./Step";
import { Agent } from './Agent'

/**
 * Represents a conversational flow/journey
 */
export class Flow<TContext = unknown, TData = unknown> {
  public readonly id: string;
  public readonly title: string;
  public readonly description?: string;
  public readonly when?: ConditionWhen;
  public readonly if?: ConditionIf<TContext, TData>;
  private readonly _initialStep: Step<TContext, TData>;
  public readonly responseOutputSchema?: StructuredSchema;
  public readonly initialData?: Partial<TData>;
  public readonly requiredFields?: (keyof TData)[];
  public readonly optionalFields?: (keyof TData)[];
  public readonly onComplete?: string;
  public readonly reentrant: boolean;
  public readonly hooks?: FlowLifecycleHooks<TContext, TData>;
  public routingExtrasSchema?: StructuredSchema;
  public instructions: Instruction<TContext, TData>[] = [];
  public tools: Tool<TContext, TData>[] = [];
  public knowledgeBase: Record<string, unknown> = {};

  /** Get the initial (first) step of this flow. */
  get initialStep(): Step<TContext, TData> {
    return this._initialStep;
  }

  // Reference to parent agent for ToolManager access
  private parentAgent?: Agent<TContext, TData>;

  /**
   * Tracks whether this flow has participated in at least one turn.
   * Used to emit a DEBUG warning when `addStep` mutates the graph mid-session.
   * @internal Set by the pipeline after the first turn involving this flow.
   */
  public _hasHandledTurn: boolean = false;

  constructor(options: FlowOptions<TContext, TData>, parentAgent?: Agent<TContext, TData>) {
    // Use provided ID or generate a deterministic one from the title
    this.id = options.id || generateFlowId(options.title);
    this.title = options.title;
    this.description = options.description;
    this.when = options.when;
    this.if = options.if;

    // Validate when/if split: functions belong on `if`, not `when`
    if (this.when !== undefined) {
      const whenValue = this.when as unknown;
      if (typeof whenValue === 'function') {
        throw new FlowConfigurationError(
          `[FlowConfigurationError] Flow "${options.title}" has a function on "when": functions belong on "if" only. Move the function to the "if" field.`
        );
      }
      if (Array.isArray(whenValue)) {
        for (let i = 0; i < (whenValue as unknown[]).length; i++) {
          if (typeof (whenValue as unknown[])[i] === 'function') {
            throw new FlowConfigurationError(
              `[FlowConfigurationError] Flow "${options.title}" has a function at "when[${i}]": functions belong on "if" only. Move the function to the "if" field.`
            );
          }
        }
      }
    }

    // Store reference to parent agent for ToolManager access
    this.parentAgent = parentAgent;

    // Handle steps: use first step as initial
    let stepsToChain: StepOptions<TContext, TData>[] = [];

    if (options.steps && options.steps.length > 0) {
      stepsToChain = options.steps.slice(1);
      this._initialStep = new Step<TContext, TData>(this.id, options.steps[0], this.parentAgent);
    } else {
      this._initialStep = new Step<TContext, TData>(this.id, undefined, this.parentAgent);
    }

    // Store flow configuration
    this.routingExtrasSchema = options.routingExtrasSchema;
    this.responseOutputSchema = options.responseOutputSchema;
    this.initialData = options.initialData;
    this.requiredFields = options.requiredFields;
    this.optionalFields = options.optionalFields;
    this.onComplete = options.onComplete;
    this.reentrant = options.reentrant ?? false;
    this.hooks = options.hooks;

    // ─── onComplete cleanup: validate no conflict and desugar ─────────────
    // If both top-level `onComplete` and `hooks.onComplete` are set, throw.
    if (this.onComplete !== undefined && this.hooks?.onComplete !== undefined) {
      throw new FlowConfigurationError(
        `[FlowConfigurationError] Flow "${this.title}": both top-level \`onComplete\` and \`hooks.onComplete\` are set. ` +
        `Use one or the other — top-level \`onComplete: string\` is sugar for \`hooks.onComplete = () => ({ goTo: '<id>' })\`.`
      );
    }

    // Desugar: top-level `onComplete: '<flowId>'` → `hooks.onComplete = () => ({ goTo: '<flowId>' })`
    if (this.onComplete !== undefined && !this.hooks?.onComplete) {
      const targetFlowId = this.onComplete;
      const desugaredHook = () => ({ goTo: targetFlowId });
      if (this.hooks) {
        (this.hooks).onComplete = desugaredHook;
      } else {
        (this as { hooks?: FlowLifecycleHooks<TContext, TData> }).hooks = { onComplete: desugaredHook };
      }
    }

    // Initialize instructions from options
    if (options.instructions) {
      options.instructions.forEach((instruction) => {
        this.createInstruction(instruction);
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
              logger.warn(`[Flow] Tool ID '${toolRef}' not found in any scope for flow ${this.title}`);
            }
          } else {
            logger.warn(`[Flow] No agent available to resolve tool ID '${toolRef}' for flow ${this.title}`);
          }
        } else {
          // Inline tool object - validate and use directly
          if (toolRef && toolRef.id && typeof toolRef.handler === 'function') {
            this.createTool(toolRef);
          } else {
            logger.warn(`[Flow] Invalid inline tool object in flow ${this.title}:`, toolRef);
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
   * The last step in the array is the implicit terminus of the flow.
   * @private
   */
  private buildSequentialSteps(
    steps: Array<StepOptions<TContext, TData>>
  ): void {
    let currentStepResult: StepResult<TContext, TData> = this.initialStep.asStepResult();

    for (const step of steps) {
      currentStepResult = currentStepResult.nextStep(step);
    }
  }

  /**
   * Imperatively add a step to this flow after construction.
   *
   * Applies the same construction-time validations as declarative `steps: [...]`
   * registration (auto-step shape, `reply` exclusivity, `branches` validation,
   * schema lookups). Connects the new step as a successor of the current last
   * step in the flow.
   *
   * When called after the agent has handled a turn, emits a DEBUG-level warning
   * that the flow graph is being mutated mid-session; the operation still succeeds.
   *
   * @param options - Step configuration
   * @returns The newly created and registered Step
   *
   * **Validates: Requirements 8.7, 26.1–26.5**
   */
  addStep(options: StepOptions<TContext, TData>): Step<TContext, TData> {
    // Warn if graph is being mutated mid-session
    if (this._hasHandledTurn) {
      logger.debug(
        `[Flow] Flow "${this.title}" (${this.id}): addStep("${options.id || options.description || 'unnamed'}") called after the agent has handled a turn. ` +
        `The flow graph is being mutated mid-session. The step will still be registered.`
      );
    }

    // Find the current last step (terminal step with no transitions)
    const lastStep = this.getLastStep();

    // Create the new step via the last step's nextStep chain method.
    // This applies the same Step constructor validations (auto-step shape,
    // branches validation, when/if split checks) and connects the new step
    // as a successor of the last step — identical to declarative chaining.
    lastStep.nextStep(options);

    // Retrieve the newly created Step instance from the last step's transitions
    const transitions = lastStep.getTransitions();
    const newStep = transitions[transitions.length - 1];

    return newStep;
  }

  /**
   * Find the last step in the sequential chain (the terminal step with no transitions).
   * If multiple terminal steps exist (branching), returns the one visited last in BFS order.
   * @private
   */
  private getLastStep(): Step<TContext, TData> {
    const allSteps = this.getAllSteps();
    // Find the last step with no outgoing transitions (terminal)
    for (let i = allSteps.length - 1; i >= 0; i--) {
      if (allSteps[i].getTransitions().length === 0) {
        return allSteps[i];
      }
    }
    // Fallback: if all steps have transitions (cycle), return the last in traversal order
    return allSteps[allSteps.length - 1];
  }

  /**
   * Evaluate when/if conditions using the v2 split logic.
   * `if` (code predicate) evaluates first (free); `when` (AI) evaluates only when `if` passes.
   * Both are combined with AND semantics.
   */
  async evaluateWhen(
    templateContext: TemplateContext<TContext, TData>
  ): Promise<ConditionEvaluationResult> {
    // If neither `when` nor `if` is set, flow is always eligible
    if (!this.when && !this.if) {
      return {
        programmaticResult: true,
        aiContextStrings: [],
        hasProgrammaticConditions: false,
      };
    }

    // Evaluate `if` first (free, code-only)
    if (this.if) {
      const predicates = Array.isArray(this.if) ? this.if : [this.if];
      for (const predicate of predicates) {
        try {
          const result = await predicate({
            data: templateContext.data,
            context: templateContext.context as TContext,
            session: templateContext.session as SessionState<TData>,
            history: templateContext.history || [],
          });
          if (!result) {
            // `if` failed — short-circuit, don't evaluate `when`
            return {
              programmaticResult: false,
              aiContextStrings: [],
              hasProgrammaticConditions: true,
            };
          }
        } catch (error) {
          logger.warn(`[Flow] "if" predicate failed for flow "${this.title}":`, error);
          return {
            programmaticResult: false,
            aiContextStrings: [],
            hasProgrammaticConditions: true,
          };
        }
      }
    }

    // `if` passed (or was absent) — now evaluate `when` (AI-evaluated strings)
    if (this.when) {
      const whenStrings = Array.isArray(this.when) ? this.when : [this.when];
      return {
        programmaticResult: true,
        aiContextStrings: whenStrings,
        hasProgrammaticConditions: !!this.if,
      };
    }

    // Only `if` was set and it passed
    return {
      programmaticResult: true,
      aiContextStrings: [],
      hasProgrammaticConditions: true,
    };
  }

  /**
   * Create an instruction specific to this flow.
   */
  createInstruction(instruction: Instruction<TContext, TData>): this {
    this.instructions.push({
      ...instruction,
      kind: instruction.kind || 'should' as const,
      id: instruction.id || `instruction_${this.id}_${this.instructions.length}`,
      enabled: instruction.enabled !== false, // Default to true
    });
    return this;
  }

  /**
   * Register a tool for this flow
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
   * Register multiple tools for this flow
   */
  registerTools(tools: Tool<TContext, TData>[]): this {
    tools.forEach((tool) => this.createTool(tool));
    return this;
  }

  /**
   * Add a tool to this flow using the ToolManager API
   * Creates and adds the tool to flow scope in one operation
   */
  addTool(
    tool: Tool<TContext, TData>
  ): this {
    if (this.parentAgent && this.parentAgent.tool) {
      // Use ToolManager to add to flow scope - no casting needed with unified interface
      this.parentAgent.tool.addToFlow(this, tool);
    } else {
      // Fallback: add tool directly to flow tools
      this.createTool(tool);
    }
    return this;
  }

  /**
   * Get all instructions for this flow
   */
  getInstructions(): Instruction<TContext, TData>[] {
    return [...this.instructions];
  }

  /**
   * Get all tools for this flow
   */
  getTools(): Tool<TContext, TData>[] {
    return [...this.tools];
  }

  /**
   * Get optional extras schema requested during routing
   */
  getRoutingExtrasSchema(): StructuredSchema | undefined {
    return this.routingExtrasSchema;
  }

  /**
   * Get optional structured response schema for this flow's message
   */
  getResponseOutputSchema(): StructuredSchema | undefined {
    return this.responseOutputSchema;
  }

  getSteps(): Step<TContext, TData>[] {
    return this.getAllSteps();
  }

  /**
   * Get flow reference
   */
  getRef(): FlowRef {
    return {
      id: this.id,
    };
  }

  /**
   * Get all steps in this flow (via traversal from initial step)
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
   * Get a description of the flow structure for debugging
   */
  describe(): string {
    const lines: string[] = [
      `Flow: ${this.title}`,
      `ID: ${this.id}`,
      `Description: ${this.description || "N/A"}`,
      `When: ${this.when ? (typeof this.when === 'string' ? this.when : Array.isArray(this.when) ? '[Array]' : '[Function]') : "None"}`,
      `If: ${this.if ? '[Function]' : "None"}`,
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
   * Handle data updates for this flow, calling the onDataUpdate hook if configured
   * @param data - New collected data
   * @param previousCollected - Previously collected data
   * @returns Modified data after hook processing, or original data if no hook
   */
  async handleDataUpdate(
    data: Partial<TData>,
    previousCollected: Partial<TData>
  ): Promise<Partial<TData>> {
    // Call flow-specific onDataUpdate hook if configured
    if (this.hooks?.onDataUpdate) {
      return await this.hooks.onDataUpdate(data, previousCollected);
    }

    // Return original data if no hook
    return data;
  }

  /**
   * Handle context updates for this flow, calling the onContextUpdate hook if configured
   * @param newContext - New context
   * @param previousContext - Previous context
   */
  async handleContextUpdate(
    newContext: TContext,
    previousContext: TContext
  ): Promise<void> {
    // Call flow-specific onContextUpdate hook if configured
    if (this.hooks?.onContextUpdate) {
      await this.hooks.onContextUpdate(newContext, previousContext);
    }
  }

  /**
   * Export flow configuration as FlowOptions for copying/cloning
   * @returns FlowOptions that can be used to create a new flow with identical configuration
   */
  toOptions(): FlowOptions<TContext, TData> {
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
        skip: step.skip,
        requires: step.requires,
        when: step.when,
        if: step.if,
        instructions: step.getInstructions(),
      }));

    return {
      id: this.id,
      title: this.title,
      description: this.description,
      when: this.when,
      if: this.if,
      instructions: this.getInstructions(),
      tools: this.getTools(),
      routingExtrasSchema: this.routingExtrasSchema,
      responseOutputSchema: this.responseOutputSchema,
      requiredFields: this.requiredFields,
      optionalFields: this.optionalFields,
      initialData: this.initialData,
      steps: steps.length > 0 ? steps : undefined,
      onComplete: this.onComplete,
      reentrant: this.reentrant,
      hooks: this.hooks,
    };
  }

  /**
   * Check if this flow is complete based on the provided data
   * @param data - Currently collected agent-level data
   * @returns true if all required fields are present, false otherwise
   * 
   * Note: Flows with no requiredFields (whether they have optionalFields or not)
   * are never complete based on data — they complete when the last step finishes (implicit terminus).
   */
  isComplete(data: Partial<TData>): boolean {
    // If flow has required fields, check if they're all collected
    if (this.requiredFields && this.requiredFields.length > 0) {
      return this.requiredFields.every(field => {
        const value = data[field];
        return value !== undefined && value !== null && value !== '';
      });
    }

    // If flow has optional fields but no required fields, it's NOT complete
    // Optional-only flows complete when the last step finishes
    if (this.optionalFields && this.optionalFields.length > 0) {
      return false;
    }

    // No required or optional fields - flow doesn't complete based on data
    // It completes when the last step in the flow finishes (implicit terminus)
    return false;
  }

  /**
   * Get the list of missing required fields for this flow
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
   * Get the completion progress for this flow as a percentage
   * @param data - Currently collected agent-level data
   * @returns Completion progress as a number between 0 and 1
   * 
   * Note: Must be consistent with isComplete() logic
   */
  getCompletionProgress(data: Partial<TData>): number {
    // If flow has required fields, calculate progress
    if (this.requiredFields && this.requiredFields.length > 0) {
      const completedFields = this.requiredFields.filter(field => {
        const value = data[field];
        return value !== undefined && value !== null && value !== '';
      });
      return completedFields.length / this.requiredFields.length;
    }

    // If flow has optional fields but no required fields, it's NOT complete
    // Optional-only flows complete when the last step finishes, progress is 0
    if (this.optionalFields && this.optionalFields.length > 0) {
      return 0;
    }

    // No required or optional fields - flow doesn't complete based on data
    // Progress is 0 (completes when last step finishes)
    return 0;
  }

  /**
   * Evaluate the onComplete handler and return a Directive.
   *
   * In v2, top-level `onComplete` is desugared to `hooks.onComplete` at
   * construction time. This method delegates to `hooks.onComplete` when set.
   *
   * @param session - Current session step
   * @param context - Agent context
   * @returns Directive or undefined if no transition
   */
  async evaluateOnComplete(
    session: { data?: Partial<TData> },
    context?: TContext
  ): Promise<Directive<TContext, TData> | undefined> {
    if (this.hooks?.onComplete) {
      const hookCtx = {
        context: context as TContext,
        data: session.data ?? {} as Partial<TData>,
        session: {} as SessionState<TData>,
        history: [] as import("../types/history").Event[],
        dispatch: () => { },
      };
      const result = await this.hooks.onComplete(hookCtx);
      if (!result) return undefined;
      return result;
    }

    // Fallback: if somehow onComplete is set but hooks.onComplete is not
    if (this.onComplete) {
      return { goTo: this.onComplete };
    }

    return undefined;
  }
}
