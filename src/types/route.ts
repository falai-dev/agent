/**
 * Route/Journey DSL type definitions
 */

import type { ToolRef } from "./tool";

/**
 * Reference to a route
 */
export interface RouteRef {
  /** Route identifier */
  id: string;
}

/**
 * Reference to a state within a route
 */
export interface StateRef {
  /** State identifier */
  id: string;
  /** Route this state belongs to */
  routeId: string;
}

/**
 * Forward declare Guideline for circular dependency
 */
import type { Guideline } from "./agent";

/**
 * Options for creating a route
 */
export interface RouteOptions {
  /** Title of the route */
  title: string;
  /** Description of what this route accomplishes */
  description?: string;
  /** Conditions that activate this route */
  conditions?: string[];
  /** Initial guidelines for this route */
  guidelines?: Guideline[];
}

/**
 * Specification for a state transition
 */
export interface TransitionSpec {
  /** Transition to a chat state with this description */
  chatState?: string;
  /** Transition to execute a tool */
  toolState?: ToolRef<unknown, unknown[], unknown>;
  /** Transition to a specific state or end marker */
  state?: StateRef | symbol;
}

/**
 * Result of a transition operation
 */
export interface TransitionResult {
  /** The target state after transition */
  target: StateRef & {
    /** Allow chaining transitions */
    transitionTo: (
      spec: TransitionSpec,
      condition?: string
    ) => TransitionResult;
  };
}
