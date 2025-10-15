/**
 * Route (Journey) DSL implementation
 */

import type { RouteOptions, RouteRef } from "../types/route";
import type { StructuredSchema } from "../types/schema";
import type { Guideline } from "../types/agent";

import { State } from "./State";
import { generateRouteId } from "../utils/id";

/**
 * Represents a conversational route/journey
 */
export class Route<TContext = unknown, TExtracted = unknown> {
  public readonly id: string;
  public readonly title: string;
  public readonly description?: string;
  public readonly conditions: string[];
  public readonly domains?: string[];
  public readonly rules: string[];
  public readonly prohibitions: string[];
  public readonly initialState: State<TContext, TExtracted>;
  public readonly responseOutputSchema?: StructuredSchema;
  public readonly gatherSchema?: StructuredSchema;
  public readonly initialData?: Partial<TExtracted>;
  private routingExtrasSchema?: StructuredSchema;
  private guidelines: Guideline[] = [];

  constructor(options: RouteOptions<TExtracted>) {
    // Use provided ID or generate a deterministic one from the title
    this.id = options.id || generateRouteId(options.title);
    this.title = options.title;
    this.description = options.description;
    this.conditions = options.conditions || [];
    this.domains = options.domains;
    this.rules = options.rules || ([] as string[]);
    this.prohibitions = options.prohibitions || ([] as string[]);
    this.initialState = new State<TContext, TExtracted>(
      this.id,
      "Initial state"
    );
    this.routingExtrasSchema = options.routingExtrasSchema;
    this.responseOutputSchema = options.responseOutputSchema;
    this.gatherSchema = options.gatherSchema;
    this.initialData = options.initialData;

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
   * Get allowed domain names for this route
   * @returns Array of domain names, or undefined if all domains are allowed
   */
  getDomains(): string[] | undefined {
    return this.domains ? [...this.domains] : undefined;
  }

  /**
   * Get rules for this route
   */
  getRules(): string[] {
    return [...this.rules];
  }

  /**
   * Get prohibitions for this route
   */
  getProhibitions(): string[] {
    return [...this.prohibitions];
  }

  /**
   * Get optional extras schema requested during routing
   */
  getRoutingExtrasSchema(): StructuredSchema | undefined {
    return this.routingExtrasSchema;
  }

  /**
   * Get optional structured response schema for this route's message
   */
  getResponseOutputSchema(): StructuredSchema | undefined {
    return this.responseOutputSchema;
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
   * Get all states in this route (via traversal from initial state)
   */
  getAllStates(): State<TContext, TExtracted>[] {
    const visited = new Set<string>();
    const states: State<TContext, TExtracted>[] = [];
    const queue: State<TContext, TExtracted>[] = [this.initialState];

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
   * Get a specific state by ID
   * @param stateId - The state ID to find
   * @returns The state if found, undefined otherwise
   */
  getState(stateId: string): State<TContext, TExtracted> | undefined {
    const states = this.getAllStates();
    return states.find((state) => state.id === stateId);
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
