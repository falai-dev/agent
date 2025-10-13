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
  /** Custom ID for the route (optional - will generate deterministic ID from title if not provided) */
  id?: string;
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
export interface TransitionSpec<TContext = unknown> {
  /** Transition to a chat state with this description */
  chatState?: string;
  /** Transition to execute a tool */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  toolState?: ToolRef<TContext, any[], any>;
  /** Transition to a specific state or end marker */
  state?: StateRef | symbol;
}

/**
 * Result of a transition operation
 */
export interface TransitionResult<TContext = unknown> {
  /** The target state after transition */
  target: StateRef & {
    /** Allow chaining transitions */
    transitionTo: (
      spec: TransitionSpec<TContext>,
      condition?: string
    ) => TransitionResult<TContext>;
  };
}
