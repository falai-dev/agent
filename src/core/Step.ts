/**
 * Step in the route DSL
 */

import type {
  StepRef,
  StepOptions,
  StepResult,
  BranchSpec,
  BranchResult,
  Guideline,
  Tool,
} from "../types";
import { ToolScope } from "../types";
import { Template } from "../types/template";
import { Agent } from './Agent'
import { END_ROUTE, END_ROUTE_ID } from "../constants";
import { generateStepId } from "../utils/id";

/**
 * Represents a step within a route
 */
export class Step<TContext = unknown, TData = unknown> {
  public readonly id: string;
  private nextSteps: Step<TContext, TData>[] = [];
  private guidelines: Guideline<TContext>[] = [];
  public readonly routeId: string;
  public collect?: (keyof TData)[];
  public description?: string;
  public when?: Template<TContext, TData>;
  public skipIf?: (data: Partial<TData>) => boolean;
  public requires?: (keyof TData)[];
  public prompt?: Template<TContext, TData>;
  public prepare?:
    | string
    | Tool<TContext, TData>
    | ((context: TContext, data?: Partial<TData>) => void | Promise<void>);
  public finalize?:
    | string
    | Tool<TContext, TData>
    | ((context: TContext, data?: Partial<TData>) => void | Promise<void>);
  public tools?: (string | Tool<TContext, TData>)[];

  // Reference to parent agent for ToolManager access
  private parentAgent?: Agent<TContext, TData>; 

  constructor(
    routeId: string,
    options: StepOptions<TContext, TData> = {},
    parentAgent?: Agent<TContext, TData> 
  ) {
    // Use provided ID or generate a deterministic one
    this.id = options.id || generateStepId(routeId, options.description);
    this.routeId = routeId;
    this.description = options.description;

    this.collect = options.collect;
    this.skipIf = options.skipIf;
    this.requires = options.requires;
    this.prompt = options.prompt;
    this.when = options.when;
    this.prepare = options.prepare;
    this.finalize = options.finalize;
    this.tools = options.tools;

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
    skipIf?: (data: Partial<TData>) => boolean;
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

    if (config.skipIf !== undefined) {
      this.skipIf = config.skipIf;
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
   * Shortcut to end the current route
   *
   * @param options - Optional step options for the end step
   * @returns Terminal step result
   */
  endRoute(
    options: Omit<StepOptions<TContext, TData>, "step"> = {}
  ): StepResult<TContext, TData> {
    return this.nextStep({
      ...options,
      step: END_ROUTE,
    });
  }

  /**
   * Create a transition from this step to another
   *
   * @param spec - Transition specification (prompt, tool, or direct step)
   * @returns StepResult that supports chaining
   */
  nextStep(spec: StepOptions<TContext, TData>): StepResult<TContext, TData> {
    // Handle END_ROUTE
    if (spec.step && typeof spec.step === "symbol" && spec.step === END_ROUTE) {
      const endStep = new Step<TContext, TData>(this.routeId, {
        ...spec,
        id: END_ROUTE_ID,
      }, this.parentAgent);
      this.nextSteps.push(endStep);
      return this.createTerminalRef();
    }

    // Handle direct step reference
    if (spec.step && typeof spec.step !== "symbol") {
      // This is a bit tricky. We need to find the actual Step instance.
      // For now, let's assume the user will provide a Step instance directly.
      // This part might need to be revisited.
    }

    // Create new target step for prompt or tool
    const targetStep = new Step<TContext, TData>(this.routeId, spec, this.parentAgent);
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
      const branchStep = new Step<TContext, TData>(this.routeId, stepOptions, this.parentAgent);
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
   * Add a guideline specific to this step
   */
  addGuideline(guideline: Guideline<TContext>): void {
    this.guidelines.push(guideline);
  }

  /**
   * Get guidelines for this step
   */
  getGuidelines(): Guideline<TContext>[] {
    return [...this.guidelines];
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
            console.warn(`[Step] Tool ID '${toolRef}' not found in any scope for step ${this.id}`);
          }
        } else {
          console.warn(`[Step] No parent agent available to resolve tool ID '${toolRef}' for step ${this.id}`);
        }
      } else {
        // Inline tool object - validate and use directly
        if (toolRef && toolRef.id && typeof toolRef.handler === 'function') {
          resolvedTools.push(toolRef);
        } else {
          console.warn(`[Step] Invalid inline tool object in step ${this.id}:`, toolRef);
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
      return resolved.find(tool => tool.id === toolId || tool.name === toolId);
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
   * Check if this step should be skipped based on collected data
   */
  shouldSkip(data: Partial<TData>): boolean {
    if (!this.skipIf) return false;
    return this.skipIf(data);
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
      routeId: this.routeId,
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
      endRoute: (options?: Omit<StepOptions<TContext, TData>, "step">) =>
        stepInstance.endRoute(options),
    };
  }

  /**
   * Create a terminal step reference (for END_ROUTE)
   */
  private createTerminalRef(): StepResult<TContext, TData> {
    const terminalRef: StepRef = {
      id: END_ROUTE_ID,
      routeId: this.routeId,
    };

    return {
      ...terminalRef,
      nextStep: () => {
        throw new Error("Cannot transition from END_ROUTE step");
      },
      branch: () => {
        throw new Error("Cannot branch from END_ROUTE step");
      },
      endRoute: (options?: Omit<StepOptions<TContext, TData>, "step">) =>
        this.endRoute(options),
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
      endRoute: (options?: Omit<StepOptions<TContext, TData>, "step">) =>
        this.endRoute(options),
    };
  }
}
