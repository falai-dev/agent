/**
 * Route (Journey) DSL implementation
 */

import type { RouteOptions, RouteRef } from "../types/route";
import type { Guideline } from "../types/agent";

import { State } from "./State";

let routeIdCounter = 0;

/**
 * Represents a conversational route/journey
 */
export class Route<TContext = unknown> {
  public readonly id: string;
  public readonly title: string;
  public readonly description?: string;
  public readonly conditions: string[];
  public readonly initialState: State<TContext>;
  private guidelines: Guideline[] = [];

  constructor(options: RouteOptions) {
    this.id = `route_${++routeIdCounter}_${options.title
      .toLowerCase()
      .replace(/\s+/g, "_")}`;
    this.title = options.title;
    this.description = options.description;
    this.conditions = options.conditions || [];
    this.initialState = new State<TContext>(this.id, "Initial state");

    // Initialize guidelines from options
    if (options.guidelines) {
      options.guidelines.forEach((guideline) => {
        this.createGuideline(guideline);
      });
    }
  }

  /**
   * Create a guideline specific to this route
   */
  createGuideline(guideline: Guideline): this {
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
  getGuidelines(): Guideline[] {
    return [...this.guidelines];
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
   * Create a route reference that includes this route instance
   * Useful for disambiguation
   */
  toRef(): RouteRef & { route: Route<TContext> } {
    return {
      id: this.id,
      route: this,
    };
  }

  /**
   * Get all states in this route (via traversal from initial state)
   */
  getAllStates(): State<TContext>[] {
    const visited = new Set<string>();
    const states: State<TContext>[] = [];
    const queue: State<TContext>[] = [this.initialState];

    while (queue.length > 0) {
      const current = queue.shift()!;

      if (visited.has(current.id)) {
        continue;
      }

      visited.add(current.id);
      states.push(current);

      // Add target states from transitions
      for (const transition of current.getTransitions()) {
        const target = transition.getTarget();
        if (target && !visited.has(target.id)) {
          queue.push(target);
        }
      }
    }

    return states;
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
      "States:",
    ];

    const states = this.getAllStates();
    for (const state of states) {
      lines.push(
        `  - ${state.id}${state.description ? `: ${state.description}` : ""}`
      );

      const transitions = state.getTransitions();
      for (const transition of transitions) {
        lines.push(`    -> ${transition.describe()}`);
      }
    }

    return lines.join("\n");
  }
}
