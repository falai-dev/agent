/**
 * Step in the route DSL
 */

import type {
  StepRef,
  StepOptions,
  StepResult,
  Guideline,
  Tool,
} from "../types";
import { Template } from "../types/template";

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
  public collect?: string[];
  public description?: string;
  public when?: Template<TContext, TData>;
  public skipIf?: (data: Partial<TData>) => boolean;
  public requires?: string[];
  public prompt?: Template<TContext, TData>;
  public prepare?: (
    context: TContext,
    data?: Partial<TData>
  ) => void | Promise<void>;
  public finalize?: (
    context: TContext,
    data?: Partial<TData>
  ) => void | Promise<void>;
  public tools?: (string | Tool<TContext, unknown[], unknown, TData>)[];

  constructor(routeId: string, options: StepOptions<TContext, TData> = {}) {
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
  }

  /**
   * Configure the step properties after creation
   * Useful for overriding initial step configuration
   */
  configure(config: {
    description?: string;
    collect?: string[];
    skipIf?: (data: Partial<TData>) => boolean;
    requires?: string[];
    prompt?: Template<TContext, TData>;
    prepare?: (
      context: TContext,
      data?: Partial<TData>
    ) => void | Promise<void>;
    finalize?: (
      context: TContext,
      data?: Partial<TData>
    ) => void | Promise<void>;
    tools?: (string | Tool<TContext, unknown[], unknown, TData>)[];
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
      });
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
    const targetStep = new Step<TContext, TData>(this.routeId, spec);
    this.nextSteps.push(targetStep);

    return this.createStepRefWithTransition(targetStep.getRef(), targetStep);
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
    return this.requires.every((key) => data[key as keyof TData] !== undefined);
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
    };
  }

  /**
   * Create a transition result for this step
   */
  asStepResult(): StepResult<TContext, TData> {
    return {
      ...this.getRef(),
      nextStep: (spec: StepOptions<TContext, TData>) => this.nextStep(spec),
    };
  }
}
