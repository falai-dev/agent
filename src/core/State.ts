/**
 * State in the route DSL
 */

import type { StateRef, TransitionSpec, TransitionResult } from "@/types/route";
import type { Guideline } from "@/types/agent";

import { END_ROUTE } from "@/constants";
import { Transition } from "@/core/Transition";

let stateIdCounter = 0;

/**
 * Represents a state within a route
 */
export class State {
  public readonly id: string;
  private transitions: Transition[] = [];
  private guidelines: Guideline[] = [];

  constructor(
    public readonly routeId: string,
    public readonly description?: string
  ) {
    this.id = `state_${++stateIdCounter}`;
  }

  /**
   * Create a transition from this state to another
   *
   * @param spec - Transition specification (chatState, toolState, or direct state)
   * @param condition - Optional condition for this transition
   * @returns Object with target state that supports chaining
   */
  transitionTo(spec: TransitionSpec, condition?: string): TransitionResult {
    // Handle END_ROUTE
    if (
      spec.state &&
      typeof spec.state === "symbol" &&
      spec.state === END_ROUTE
    ) {
      const endTransition = new Transition(
        this.getRef(),
        { state: END_ROUTE },
        condition
      );
      this.transitions.push(endTransition);

      // Return a terminal state reference
      return {
        target: this.createTerminalRef(),
      };
    }

    // Handle direct state reference
    if (spec.state && typeof spec.state !== "symbol") {
      const transition = new Transition(this.getRef(), spec, condition);
      this.transitions.push(transition);

      return {
        target: this.createStateRefWithTransition(spec.state),
      };
    }

    // Create new target state for chatState or toolState
    const targetState = new State(this.routeId, spec.chatState);
    const transition = new Transition(this.getRef(), spec, condition);
    transition.setTarget(targetState);

    this.transitions.push(transition);

    return {
      target: this.createStateRefWithTransition(
        targetState.getRef(),
        targetState
      ),
    };
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
  getTransitions(): Transition[] {
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
    state?: State
  ): StateRef & {
    transitionTo: (
      spec: TransitionSpec,
      condition?: string
    ) => TransitionResult;
  } {
    const stateInstance = state || this;

    return {
      ...ref,
      transitionTo: (spec: TransitionSpec, condition?: string) =>
        stateInstance.transitionTo(spec, condition),
    };
  }

  /**
   * Create a terminal state reference (for END_ROUTE)
   */
  private createTerminalRef(): StateRef & {
    transitionTo: (
      spec: TransitionSpec,
      condition?: string
    ) => TransitionResult;
  } {
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
