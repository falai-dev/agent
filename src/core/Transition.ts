/**
 * Transition between states in the route DSL
 */

import type { StateRef, TransitionSpec } from "../types/route";
import type { State } from "./State";

/**
 * Represents a transition from one state to another
 */
export class Transition<TContext = unknown, TExtracted = unknown> {
  private target?: State<TContext, TExtracted>;

  constructor(
    public readonly source: StateRef,
    public readonly spec: TransitionSpec<TContext, TExtracted>,
    public readonly condition?: string
  ) {}

  /**
   * Set the target state for this transition
   */
  setTarget(state: State<TContext, TExtracted>): void {
    this.target = state;
  }

  /**
   * Get the target state
   */
  getTarget(): State<TContext, TExtracted> | undefined {
    return this.target;
  }

  /**
   * Check if this transition has a condition
   */
  hasCondition(): boolean {
    return !!this.condition;
  }

  /**
   * Get transition description for logging/debugging
   */
  describe(): string {
    const parts: string[] = [];

    if (this.spec.chatState) {
      parts.push(`chat: "${this.spec.chatState}"`);
    }
    if (this.spec.toolState) {
      parts.push(`tool: ${this.spec.toolState.name}`);
    }
    if (this.spec.state) {
      if (typeof this.spec.state === "symbol") {
        parts.push("state: END_ROUTE");
      } else {
        parts.push(`state: ${this.spec.state.id}`);
      }
    }

    const transition = parts.join(", ");
    const conditionPart = this.condition ? ` (when: ${this.condition})` : "";

    return `${this.source.id} -> [${transition}]${conditionPart}`;
  }
}
