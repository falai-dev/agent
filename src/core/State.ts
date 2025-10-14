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
export class State<TContext = unknown> {
  public readonly id: string;
  private transitions: Transition<TContext>[] = [];
  private guidelines: Guideline[] = [];

  constructor(
    public readonly routeId: string,
    public readonly description?: string,
    customId?: string
  ) {
    // Use provided ID or generate a deterministic one
    this.id = customId || generateStateId(routeId, description);
  }

  /**
   * Create a transition from this state to another
   *
   * @param spec - Transition specification (chatState, toolState, or direct state)
   * @param condition - Optional condition for this transition
   * @returns TransitionResult that supports chaining
   */
  transitionTo(
    spec: TransitionSpec<TContext>,
    condition?: string
  ): TransitionResult<TContext> {
    // Handle END_ROUTE
    if (
      spec.state &&
      typeof spec.state === "symbol" &&
      spec.state === END_ROUTE
    ) {
      const endTransition = new Transition<TContext>(
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
      const transition = new Transition<TContext>(
        this.getRef(),
        spec,
        condition
      );
      this.transitions.push(transition);

      return this.createStateRefWithTransition(spec.state);
    }

    // Create new target state for chatState or toolState
    const targetState = new State<TContext>(this.routeId, spec.chatState);
    const transition = new Transition<TContext>(this.getRef(), spec, condition);
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
  getTransitions(): Transition<TContext>[] {
    return [...this.transitions];
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
    state?: State<TContext>
  ): TransitionResult<TContext> {
    const stateInstance = state || this;

    return {
      ...ref,
      transitionTo: (spec: TransitionSpec<TContext>, condition?: string) =>
        stateInstance.transitionTo(spec, condition),
    };
  }

  /**
   * Create a terminal state reference (for END_ROUTE)
   */
  private createTerminalRef(): TransitionResult<TContext> {
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
