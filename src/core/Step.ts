/**
 * Step in the route DSL
 */

import type { StepRef, TransitionSpec, TransitionResult } from "../types/route";
import type { Guideline } from "../types/agent";

import { END_ROUTE } from "../constants";
import { Transition } from "./Transition";
import { generateStepId } from "../utils/id";

/**
 * Represents a step within a route
 */
export class Step<TContext = unknown, TData = unknown> {
  public readonly id: string;
  private transitions: Transition<TContext, TData>[] = [];
  private guidelines: Guideline[] = [];
  public collectFields?: string[];
  public skipIf?: (data: Partial<TData>) => boolean;
  public requires?: string[];
  public instructions?: string;

  constructor(
    public readonly routeId: string,
    public description?: string,
    customId?: string,
    collectFields?: string[],
    skipIf?: (data: Partial<TData>) => boolean,
    requires?: string[],
    instructions?: string
  ) {
    // Use provided ID or generate a deterministic one
    this.id = customId || generateStepId(routeId, description);
    this.collectFields = collectFields;
    this.skipIf = skipIf;
    this.requires = requires;
    this.instructions = instructions;
  }

  /**
   * Configure the step properties after creation
   * Useful for overriding initial step configuration
   */
  configure(config: {
    description?: string;
    collectFields?: string[];
    skipIf?: (data: Partial<TData>) => boolean;
    requires?: string[];
    instructions?: string;
  }): this {
    if (config.description !== undefined) {
      this.description = config.description;
    }
    if (config.collectFields !== undefined) {
      this.collectFields = config.collectFields;
    }
    if (config.skipIf !== undefined) {
      this.skipIf = config.skipIf;
    }
    if (config.requires !== undefined) {
      this.requires = config.requires;
    }
    if (config.instructions !== undefined) {
      this.instructions = config.instructions;
    }
    return this;
  }

  /**
   * Create a transition from this step to another
   *
   * @param spec - Transition specification (instructions, tool, or direct step)
   * @returns TransitionResult that supports chaining
   */
  nextStep(
    spec: TransitionSpec<TContext, TData>
  ): TransitionResult<TContext, TData> {
    // Handle END_ROUTE
    if (spec.step && typeof spec.step === "symbol" && spec.step === END_ROUTE) {
      const endTransition = new Transition<TContext, TData>(this.getRef(), {
        step: END_ROUTE,
        condition: spec.condition,
        instructions: spec.instructions,
      });
      this.transitions.push(endTransition);

      // Return a terminal step reference
      return this.createTerminalRef();
    }

    // Handle direct step reference
    if (spec.step && typeof spec.step !== "symbol") {
      const transition = new Transition<TContext, TData>(this.getRef(), spec);
      this.transitions.push(transition);

      return this.createStepRefWithTransition(spec.step);
    }

    // Create new target step for instructions or tool
    const targetStep = new Step<TContext, TData>(
      this.routeId,
      spec.instructions,
      spec.id, // Use custom ID if provided
      spec.collect,
      spec.skipIf,
      spec.requires,
      spec.instructions
    );
    const transition = new Transition<TContext, TData>(this.getRef(), spec);
    transition.setTarget(targetStep);

    this.transitions.push(transition);

    return this.createStepRefWithTransition(targetStep.getRef(), targetStep);
  }

  /**
   * Add a guideline specific to this step
   */
  addGuideline(guideline: Guideline): void {
    this.guidelines.push(guideline);
  }

  /**
   * Get guidelines for this step
   */
  getGuidelines(): Guideline[] {
    return [...this.guidelines];
  }

  /**
   * Get all transitions from this step
   */
  getTransitions(): Transition<TContext, TData>[] {
    return [...this.transitions];
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
  ): TransitionResult<TContext, TData> {
    const stepInstance = step || this;

    return {
      ...ref,
      nextStep: (spec: TransitionSpec<TContext, TData>) =>
        stepInstance.nextStep(spec),
    };
  }

  /**
   * Create a terminal step reference (for END_ROUTE)
   */
  private createTerminalRef(): TransitionResult<TContext, TData> {
    const terminalRef: StepRef = {
      id: "END",
      routeId: this.routeId,
    };

    return {
      ...terminalRef,
      nextStep: () => {
        throw new Error("Cannot transition from END_ROUTE step");
      },
    };
  }
}
