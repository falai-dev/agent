/**
 * State in the route DSL
 */

import type {
  StateRef,
  TransitionSpec,
  TransitionResult,
} from "../types/route";
import type { Guideline } from "../types/agent";

import { END_ROUTE } from "../constants";
import { Transition } from "./Transition";
import { generateStateId } from "../utils/id";

/**
 * Represents a state within a route
 */
export class State<TContext = unknown, TExtracted = unknown> {
  public readonly id: string;
  private transitions: Transition<TContext, TExtracted>[] = [];
  private guidelines: Guideline[] = [];
  public readonly gatherFields?: string[];
  public readonly skipIf?: (extracted: Partial<TExtracted>) => boolean;
  public readonly requiredData?: string[];

  constructor(
    public readonly routeId: string,
    public readonly description?: string,
    customId?: string,
    gatherFields?: string[],
    skipIf?: (extracted: Partial<TExtracted>) => boolean,
    requiredData?: string[]
  ) {
    // Use provided ID or generate a deterministic one
    this.id = customId || generateStateId(routeId, description);
    this.gatherFields = gatherFields;
    this.skipIf = skipIf;
    this.requiredData = requiredData;
  }

  /**
   * Create a transition from this state to another
   *
   * @param spec - Transition specification (chatState, toolState, or direct state)
   * @param condition - Optional condition for this transition
   * @returns TransitionResult that supports chaining
   */
  transitionTo(
    spec: TransitionSpec<TContext, TExtracted>,
    condition?: string
  ): TransitionResult<TContext, TExtracted> {
    // Handle END_ROUTE
    if (
      spec.state &&
      typeof spec.state === "symbol" &&
      spec.state === END_ROUTE
    ) {
      const endTransition = new Transition<TContext, TExtracted>(
        this.getRef(),
        { state: END_ROUTE },
        condition
      );
      this.transitions.push(endTransition);

      // Return a terminal state reference
      return this.createTerminalRef();
    }

    // Handle direct state reference
    if (spec.state && typeof spec.state !== "symbol") {
      const transition = new Transition<TContext, TExtracted>(
        this.getRef(),
        spec,
        condition
      );
      this.transitions.push(transition);

      return this.createStateRefWithTransition(spec.state);
    }

    // Create new target state for chatState or toolState
    const targetState = new State<TContext, TExtracted>(
      this.routeId,
      spec.chatState,
      spec.id, // Use custom ID if provided
      spec.gather,
      spec.skipIf,
      spec.requiredData
    );
    const transition = new Transition<TContext, TExtracted>(
      this.getRef(),
      spec,
      condition
    );
    transition.setTarget(targetState);

    this.transitions.push(transition);

    return this.createStateRefWithTransition(targetState.getRef(), targetState);
  }

  /**
   * Add a guideline specific to this state
   */
  addGuideline(guideline: Guideline): void {
    this.guidelines.push(guideline);
  }

  /**
   * Get guidelines for this state
   */
  getGuidelines(): Guideline[] {
    return [...this.guidelines];
  }

  /**
   * Get all transitions from this state
   */
  getTransitions(): Transition<TContext, TExtracted>[] {
    return [...this.transitions];
  }

  /**
   * Check if this state should be skipped based on extracted data
   */
  shouldSkip(extracted: Partial<TExtracted>): boolean {
    if (!this.skipIf) return false;
    return this.skipIf(extracted);
  }

  /**
   * Check if this state has all required data to proceed
   */
  hasRequiredData(extracted: Partial<TExtracted>): boolean {
    if (!this.requiredData || this.requiredData.length === 0) return true;
    return this.requiredData.every(
      (key) => extracted[key as keyof TExtracted] !== undefined
    );
  }

  /**
   * Get state reference
   */
  getRef(): StateRef {
    return {
      id: this.id,
      routeId: this.routeId,
    };
  }

  /**
   * Create a state reference with transitionTo capability for chaining
   */
  private createStateRefWithTransition(
    ref: StateRef,
    state?: State<TContext, TExtracted>
  ): TransitionResult<TContext, TExtracted> {
    const stateInstance = state || this;

    return {
      ...ref,
      transitionTo: (
        spec: TransitionSpec<TContext, TExtracted>,
        condition?: string
      ) => stateInstance.transitionTo(spec, condition),
    };
  }

  /**
   * Create a terminal state reference (for END_ROUTE)
   */
  private createTerminalRef(): TransitionResult<TContext, TExtracted> {
    const terminalRef: StateRef = {
      id: "END",
      routeId: this.routeId,
    };

    return {
      ...terminalRef,
      transitionTo: () => {
        throw new Error("Cannot transition from END_ROUTE state");
      },
    };
  }
}
