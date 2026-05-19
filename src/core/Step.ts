/**
 * Step in the route DSL
 */

import type {
  StepRef,
  StepOptions,
  BranchMap,
  Instruction,
  Tool,
  PrepareResult,
} from "../types";
import type { SessionState } from "../types/session";
import type { StepResult, BranchSpec, BranchResult } from "../types/flow";
import { ToolScope, Template, TemplateContext } from "../types";
import type { ConditionWhen, ConditionIf } from "../types/flow";
import { generateStepId, logger } from "../utils";
import { Agent } from './Agent'

/**
 * Error thrown when a step's configuration violates auto-step constraints.
 */
export class FlowConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FlowConfigurationError";
  }
}

/**
 * Represents a step within a route
 */
export class Step<TContext = unknown, TData = unknown> {
  public readonly id: string;
  private nextSteps: Step<TContext, TData>[] = [];
  private _instructions: Instruction<TContext, TData>[] = [];
  public readonly flowId: string;
  public collect?: (keyof TData)[];
  public description?: string;
  public when?: ConditionWhen;
  public if?: ConditionIf<TContext, TData>;
  public skip?: ConditionIf<TContext, TData>;
  public requires?: (keyof TData)[];
  public prompt?: Template<TContext, TData>;
  public reply?: Template<TContext, TData>;
  public prepare?:
    | string
    | Tool<TContext, TData>
    | ((context: TContext, data?: Partial<TData>) => void | PrepareResult | Promise<void | PrepareResult>);
  public finalize?:
    | string
    | Tool<TContext, TData>
    | ((context: TContext, data?: Partial<TData>) => void | PrepareResult | Promise<void | PrepareResult>);
  public tools?: (string | Tool<TContext, TData>)[];

  private readonly _auto: boolean;
  private readonly _branches?: BranchMap<TContext, TData>;

  /** Whether this step runs without an LLM call (computational only). */
  get auto(): boolean {
    return this._auto;
  }

  /** Explicit source-local fork entries, if declared. */
  get branches(): BranchMap<TContext, TData> | undefined {
    return this._branches;
  }

  // Reference to parent agent for ToolManager access
  private parentAgent?: Agent<TContext, TData>;

  constructor(
    routeId: string,
    options: StepOptions<TContext, TData> = {},
    parentAgent?: Agent<TContext, TData>
  ) {
    // Use provided ID or generate a deterministic one
    this.id = options.id || generateStepId(routeId, options.description);
    this.flowId = routeId;
    this.description = options.description;

    this._auto = options.auto ?? false;
    this._branches = options.branches;
    this.collect = options.collect;
    this.skip = options.skip;
    this.requires = options.requires;
    this.prompt = options.prompt;
    this.reply = options.reply;
    this.when = options.when;
    this.if = options.if;
    this.prepare = options.prepare;
    this.finalize = options.finalize;
    this.tools = options.tools;

    // Validate when/if split: functions belong on `if`, not `when`
    if (this.when !== undefined) {
      const whenValue = this.when;
      if (typeof whenValue === 'function') {
        throw new FlowConfigurationError(
          `[FlowConfigurationError] Step "${this.id}" has a function on "when": functions belong on "if" only. Move the function to the "if" field.`
        );
      }
      if (Array.isArray(whenValue)) {
        for (let i = 0; i < whenValue.length; i++) {
          if (typeof whenValue[i] === 'function') {
            throw new FlowConfigurationError(
              `[FlowConfigurationError] Step "${this.id}" has a function at "when[${i}]": functions belong on "if" only. Move the function to the "if" field.`
            );
          }
        }
      }
    }

    // Validate auto-step shape: auto-steps cannot define prompt, collect, tools, or finalize
    if (this._auto) {
      const violatingFields: string[] = [];
      if (this.prompt != null) violatingFields.push('prompt');
      if (this.collect != null && this.collect.length > 0) violatingFields.push('collect');
      if (this.tools != null && this.tools.length > 0) violatingFields.push('tools');
      if (this.finalize != null) violatingFields.push('finalize');

      if (violatingFields.length > 0) {
        throw new FlowConfigurationError(
          `[FlowConfigurationError] Auto-step "${this.id}" cannot define: ${violatingFields.join(', ')}. Auto-steps run without an LLM call and must not declare prompt, collect, tools, or finalize. Remove these fields or set auto: false.`
        );
      }
    }

    // Validate reply-step shape: reply steps cannot define prompt, collect, tools, finalize, or auto: true
    if (this.reply != null) {
      const conflictingFields: string[] = [];
      if (this.prompt != null) conflictingFields.push('prompt');
      if (this.collect != null && this.collect.length > 0) conflictingFields.push('collect');
      if (this.tools != null && this.tools.length > 0) conflictingFields.push('tools');
      if (this.finalize != null) conflictingFields.push('finalize');
      if (this._auto) conflictingFields.push('auto: true');

      if (conflictingFields.length > 0) {
        throw new FlowConfigurationError(
          `[FlowConfigurationError] Step "${this.id}" sets "reply" together with conflicting fields: ${conflictingFields.join(', ')}. A reply step skips the LLM call and cannot define prompt, collect, tools, finalize, or auto: true.`
        );
      }
    }

    // Validate branches shape
    if (this._branches !== undefined) {
      this.validateBranches(this._branches);
    }

    // Initialize instructions from options
    if (options.instructions) {
      options.instructions.forEach((instruction) => {
        this.addInstruction(instruction);
      });
    }

    // Store reference to parent agent for ToolManager access
    this.parentAgent = parentAgent;
  }

  /**
   * Configure the step properties after creation
   * Useful for overriding initial step configuration
   */
  configure(config: {
    description?: string;
    collect?: (keyof TData)[];
    skip?: ConditionIf<TContext, TData>;
    requires?: (keyof TData)[];
    prompt?: Template<TContext, TData>;
    prepare?:
    | string
    | Tool<TContext, TData>
    | ((context: TContext, data?: Partial<TData>) => void | Promise<void>);
    finalize?:
    | string
    | Tool<TContext, TData>
    | ((context: TContext, data?: Partial<TData>) => void | Promise<void>);
    tools?: (string | Tool<TContext, TData>)[];
  }): this {
    if (config.description !== undefined) {
      this.description = config.description;
    }

    if (config.collect !== undefined) {
      this.collect = config.collect;
    }

    if (config.skip !== undefined) {
      this.skip = config.skip;
    }

    if (config.requires !== undefined) {
      this.requires = config.requires;
    }

    if (config.prompt !== undefined) {
      this.prompt = config.prompt;
    }
    if (config.prepare !== undefined) {
      this.prepare = config.prepare;
    }
    if (config.finalize !== undefined) {
      this.finalize = config.finalize;
    }
    if (config.tools !== undefined) {
      this.tools = config.tools;
    }
    return this;
  }

  /**
   * Create a transition from this step to another
   *
   * @param spec - Transition specification (prompt, tool, or direct step)
   * @returns StepResult that supports chaining
   */
  nextStep(spec: StepOptions<TContext, TData>): StepResult<TContext, TData> {
    // Create new target step for prompt or tool
    const targetStep = new Step<TContext, TData>(this.flowId, spec, this.parentAgent);
    this.nextSteps.push(targetStep);

    return this.createStepRefWithTransition(targetStep.getRef(), targetStep);
  }

  /**
   * Create multiple branches from this step
   *
   * @param branches - Array of branch specifications
   * @returns BranchResult mapping branch names to their step results
   */
  branch(
    branches: BranchSpec<TContext, TData>[]
  ): BranchResult<TContext, TData> {
    const result = {} as BranchResult<TContext, TData>;

    for (const branchSpec of branches) {
      // Create step options with optional ID
      const stepOptions: StepOptions<TContext, TData> = branchSpec.id
        ? { ...branchSpec.step, id: branchSpec.id }
        : branchSpec.step;

      // Create a new step for this branch
      const branchStep = new Step<TContext, TData>(this.flowId, stepOptions, this.parentAgent);
      // Add it to our transitions
      this.nextSteps.push(branchStep);
      // Create a step result for chaining
      const branchName: string = branchSpec.name;
      result[branchName] = this.createStepRefWithTransition(
        branchStep.getRef(),
        branchStep
      );
    }

    return result;
  }

  /**
   * Add an instruction to this step.
   */
  addInstruction(instruction: Instruction<TContext, TData>): void {
    this._instructions.push({
      ...instruction,
      kind: instruction.kind || 'should' as const,
      id: instruction.id || `instruction_${this.id}_${this._instructions.length}`,
      enabled: instruction.enabled !== false, // Default to true
    });
  }

  /**
   * Get instructions for this step
   */
  getInstructions(): Instruction<TContext, TData>[] {
    return [...this._instructions];
  }

  /**
   * Add a tool to this step using the unified Tool interface
   * Creates and adds the tool to step scope in one operation
   */
  addTool(
    tool: Tool<TContext, TData>
  ): this {
    // Validate tool before adding
    if (!tool || !tool.id || !tool.handler) {
      throw new Error('Invalid tool: must have id and handler properties');
    }

    // Add to step's tools array
    if (!this.tools) {
      this.tools = [];
    }
    this.tools.push(tool);

    return this;
  }

  /**
   * Resolve tool references in the tools array
   * Supports both string IDs (resolved from registry) and inline tool objects
   */
  resolveTools(): Tool<TContext, TData>[] {
    if (!this.tools) {
      return [];
    }

    const resolvedTools: Tool<TContext, TData>[] = [];

    for (const toolRef of this.tools) {
      if (typeof toolRef === 'string') {
        // Tool ID - try to resolve from ToolManager using proper scope resolution
        if (this.parentAgent?.tool) {
          const registeredTool = this.parentAgent.tool.find(toolRef);
          if (registeredTool) {
            resolvedTools.push(registeredTool);
          } else {
            // Tool not found - log warning but don't fail
            logger.warn(`[Step] Tool ID '${toolRef}' not found in any scope for step ${this.id}`);
          }
        } else {
          logger.warn(`[Step] No parent agent available to resolve tool ID '${toolRef}' for step ${this.id}`);
        }
      } else {
        // Inline tool object - validate and use directly
        if (toolRef && toolRef.id && typeof toolRef.handler === 'function') {
          resolvedTools.push(toolRef);
        } else {
          logger.warn(`[Step] Invalid inline tool object in step ${this.id}:`, toolRef);
        }
      }
    }

    return resolvedTools;
  }

  /**
   * Get all tools available to this step (both inline and resolved from registry)
   */
  getAvailableTools(): (string | Tool<TContext, TData>)[] {
    return this.tools ? [...this.tools] : [];
  }

  /**
   * Get all resolved tools available to this step using ToolManager
   * This method provides the complete set of tools accessible from this step
   */
  getAllAvailableTools(): Tool<TContext, TData>[] {
    if (!this.parentAgent?.tool) {
      // Fallback to local resolution if no ToolManager available
      return this.resolveTools();
    }

    // Use ToolManager to get all available tools for this step context
    return this.parentAgent.tool.getAvailable(ToolScope.ALL, this, undefined);
  }

  /**
   * Find a specific tool by ID using ToolManager resolution
   * This method respects the tool resolution hierarchy: step → route → agent → registry
   */
  findTool(toolId: string, scope?: ToolScope): Tool<TContext, TData> | undefined {
    if (!this.parentAgent?.tool) {
      // Fallback to local resolution if no ToolManager available
      const resolved = this.resolveTools();
      return resolved.find(tool => tool.id === toolId || tool.id === toolId);
    }

    // Use ToolManager to find the tool with proper scope resolution
    return this.parentAgent.tool.find(toolId, scope || ToolScope.ALL, this, undefined);
  }

  /**
   * Get tools from a specific scope
   */
  getToolsFromScope(scope: ToolScope): Tool<TContext, TData>[] {
    if (!this.parentAgent?.tool) {
      // Fallback to local resolution if no ToolManager available
      return scope === ToolScope.STEP ? this.resolveTools() : [];
    }

    return this.parentAgent.tool.getAvailable(scope, this, undefined);
  }

  /**
   * Get only step-level tools (inline tools in this step)
   */
  getStepTools(): Tool<TContext, TData>[] {
    return this.getToolsFromScope(ToolScope.STEP);
  }

  /**
   * Get only registered tools accessible from this step
   */
  getRegisteredTools(): Tool<TContext, TData>[] {
    return this.getToolsFromScope(ToolScope.REGISTERED);
  }

  /**
   * Validate that all tool references in this step can be resolved
   * Returns validation result with details about missing tools
   */
  validateToolReferences(): {
    valid: boolean;
    missing: string[];
    found: string[];
    details: Array<{ id: string; found: boolean; scope?: string; }>;
  } {
    if (!this.tools || this.tools.length === 0) {
      return { valid: true, missing: [], found: [], details: [] };
    }

    // Extract tool IDs from the tools array
    const toolIds: string[] = [];
    for (const toolRef of this.tools) {
      if (typeof toolRef === 'string') {
        toolIds.push(toolRef);
      } else if (toolRef && toolRef.id) {
        toolIds.push(toolRef.id);
      }
    }

    if (!this.parentAgent?.tool) {
      // Fallback validation without ToolManager
      const resolved = this.resolveTools();
      const resolvedIds = resolved.map(tool => tool.id);
      const missing = toolIds.filter(id => !resolvedIds.includes(id));
      const found = toolIds.filter(id => resolvedIds.includes(id));

      return {
        valid: missing.length === 0,
        missing,
        found,
        details: toolIds.map(id => ({ id, found: resolvedIds.includes(id) }))
      };
    }

    // Use ToolManager validation
    return this.parentAgent.tool.validateToolReferences(toolIds, this);
  }

  /**
   * Get all transitions from this step
   */
  getTransitions(): Step<TContext, TData>[] {
    return [...this.nextSteps];
  }

  /**
   * Evaluate when/if conditions using the v2 split logic.
   * `if` (code predicate) evaluates first (free); `when` (AI) evaluates only when `if` passes.
   * Both are combined with AND semantics.
   */
  async evaluateWhen(
    templateContext: TemplateContext<TContext, TData>
  ): Promise<{
    shouldActivate: boolean;
    aiContextStrings: string[];
    hasProgrammaticConditions: boolean;
  }> {
    // If neither `when` nor `if` is set, step is always eligible
    if (!this.when && !this.if) {
      return {
        shouldActivate: true,
        aiContextStrings: [],
        hasProgrammaticConditions: false
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
            // `if` failed — short-circuit, don't bother with `when`
            return {
              shouldActivate: false,
              aiContextStrings: [],
              hasProgrammaticConditions: true
            };
          }
        } catch (error) {
          logger.warn(`[Step] "if" predicate failed for step "${this.id}":`, error);
          return {
            shouldActivate: false,
            aiContextStrings: [],
            hasProgrammaticConditions: true
          };
        }
      }
    }

    // `if` passed (or was absent) — now evaluate `when` (AI-evaluated strings)
    if (this.when) {
      const whenStrings = Array.isArray(this.when) ? this.when : [this.when];
      // `when` strings are handed to the AI — return them as aiContextStrings
      // The programmatic result is true (strings don't fail programmatically;
      // they're scored by the AI at routing time)
      return {
        shouldActivate: true,
        aiContextStrings: whenStrings,
        hasProgrammaticConditions: !!this.if
      };
    }

    // Only `if` was set and it passed
    return {
      shouldActivate: true,
      aiContextStrings: [],
      hasProgrammaticConditions: true
    };
  }

  /**
   * Evaluate the skip condition (if-only shape — code predicates, OR semantics).
   * Returns true if the step should be skipped.
   */
  async evaluateSkip(
    templateContext: TemplateContext<TContext, TData>
  ): Promise<{
    shouldSkip: boolean;
    aiContextStrings: string[];
    hasProgrammaticConditions: boolean;
  }> {
    if (!this.skip) {
      return {
        shouldSkip: false,
        aiContextStrings: [],
        hasProgrammaticConditions: false
      };
    }

    const predicates = Array.isArray(this.skip) ? this.skip : [this.skip];
    // OR semantics: if ANY predicate returns true, skip
    for (const predicate of predicates) {
      try {
        const result = await predicate({
          data: templateContext.data,
          context: templateContext.context as TContext,
          session: templateContext.session as SessionState<TData>,
          history: templateContext.history || [],
        });
        if (result) {
          return {
            shouldSkip: true,
            aiContextStrings: [],
            hasProgrammaticConditions: true
          };
        }
      } catch (error) {
        logger.warn(`[Step] "skip" predicate failed for step "${this.id}":`, error);
        // On error, default to not skipping (safe fallback)
      }
    }

    return {
      shouldSkip: false,
      aiContextStrings: [],
      hasProgrammaticConditions: true
    };
  }



  /**
   * Check if this step has all required data to proceed
   */
  hasRequires(data: Partial<TData>): boolean {
    if (!this.requires || this.requires.length === 0) return true;
    return this.requires.every((key) => data[key] !== undefined);
  }

  /**
   * Get step reference
   */
  getRef(): StepRef {
    return {
      id: this.id,
      flowId: this.flowId,
    };
  }

  /**
   * Create a step reference with nextStep capability for chaining
   */
  private createStepRefWithTransition(
    ref: StepRef,
    step?: Step<TContext, TData>
  ): StepResult<TContext, TData> {
    const stepInstance = step || this;

    return {
      ...ref,
      nextStep: (spec: StepOptions<TContext, TData>) =>
        stepInstance.nextStep(spec),
      branch: (branches: BranchSpec<TContext, TData>[]) =>
        stepInstance.branch(branches),
    };
  }

  /**
   * Create a transition result for this step
   */
  asStepResult(): StepResult<TContext, TData> {
    return {
      ...this.getRef(),
      nextStep: (spec: StepOptions<TContext, TData>) => this.nextStep(spec),
      branch: (branches: BranchSpec<TContext, TData>[]) =>
        this.branch(branches),
    };
  }

  /**
   * Export step configuration as StepOptions for copying/cloning
   * @returns StepOptions that can be used to create a new step with identical configuration
   */
  toOptions(): StepOptions<TContext, TData> {
    return {
      id: this.id,
      description: this.description,
      auto: this._auto,
      branches: this._branches,
      prompt: this.prompt,
      reply: this.reply,
      tools: this.tools,
      prepare: this.prepare,
      finalize: this.finalize,
      collect: this.collect,
      skip: this.skip,
      requires: this.requires,
      when: this.when,
      if: this.if,
      instructions: this.getInstructions(),
    };
  }

  /**
   * Validate the branches array at construction time.
   * Checks:
   * - Non-empty array
   * - Unconditional entries (no `when` and no `if`) only legal as the last entry
   * - Directive `then` values: at most one position field, no empty `goTo: {}`
   */
  private validateBranches(branches: BranchMap<TContext, TData>): void {
    if (branches.length === 0) {
      throw new FlowConfigurationError(
        `[FlowConfigurationError] Empty branches array on step "${this.id}": branches must contain at least one entry. Add branch entries or remove the branches field.`
      );
    }

    const POSITION_FIELDS = ['goTo', 'goToStep', 'complete', 'abort', 'reset'] as const;

    for (let i = 0; i < branches.length; i++) {
      const entry = branches[i];
      const isLast = i === branches.length - 1;

      // Non-last entry without `when` or `if` is dead code — later entries are unreachable
      if (!isLast && !entry.when && !entry.if) {
        throw new FlowConfigurationError(
          `[FlowConfigurationError] Dead-code branch at index ${i}: branches[${i}] has neither "when" nor "if" and is not the last entry. Entries after index ${i} are unreachable. Move the unconditional entry to the end or add a condition.`
        );
      }

      // Validate Directive `then` values
      if (entry.then && typeof entry.then === 'object') {
        const directive = entry.then;

        // Check for multiple position fields
        const setPositionFields = POSITION_FIELDS.filter(
          (field) => directive[field] !== undefined
        );
        if (setPositionFields.length > 1) {
          throw new FlowConfigurationError(
            `[FlowConfigurationError] Multiple position fields in branches[${i}].then: Directive sets ${setPositionFields.join(', ')}. At most one position field is allowed per Directive. Remove all but one.`
          );
        }

        // Check for empty goTo: {}
        if (directive.goTo !== undefined && typeof directive.goTo === 'object' && directive.goTo !== null) {
          const goToObj = directive.goTo as Record<string, unknown>;
          if (Object.keys(goToObj).length === 0) {
            throw new FlowConfigurationError(
              `[FlowConfigurationError] Empty goTo in branches[${i}].then: Directive has "goTo: {}" with no flow target. Provide at least a flow id or title.`
            );
          }
        }
      }
    }
  }
}
