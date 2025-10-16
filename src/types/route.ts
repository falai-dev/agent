/**
 * Route/Journey DSL type definitions
 */

import type { ToolRef } from "./tool";
import type { StructuredSchema } from "./schema";

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
 * @template TExtracted - Type of data extracted throughout the route (inferred from extractionSchema)
 */
export interface RouteOptions<TExtracted = unknown> {
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
  /** Domain names that are allowed in this route (undefined = all domains) */
  domains?: string[];
  /** Absolute rules the agent must follow in this route */
  rules?: string[];
  /** Absolute prohibitions the agent must never do in this route */
  prohibitions?: string[];
  /** Optional: extractions the router may return (added to routing schema) */
  routingExtrasSchema?: StructuredSchema;
  /** Optional: structured response data for this route's message generation */
  responseOutputSchema?: StructuredSchema;
  /**
   * NEW: Schema defining data to extract throughout this route
   * This creates a type-safe contract for what data the route collects
   */
  extractionSchema?: StructuredSchema;
  /**
   * NEW: Initial data to pre-populate when entering this route
   * Useful for restoring sessions or pre-filling known information
   * States with skipIf conditions will be automatically bypassed if data is present
   */
  initialData?: Partial<TExtracted>;
  /**
   * NEW: Sequential steps for simple linear flows
   * If provided, automatically chains the steps from initialState to END_STATE
   * For complex flows with branching, build the state machine manually instead
   */
  steps?: TransitionSpec<unknown, TExtracted>[];
  /**
   * Configure the initial state (optional)
   * Accepts full TransitionSpec configuration (id, chatState, gather, skipIf, etc.)
   * Note: toolState and state properties are ignored for initial state
   */
  initialState?: Omit<
    TransitionSpec<unknown, TExtracted>,
    "toolState" | "state" | "condition"
  >;
}

/**
 * Specification for a state transition
 */
export interface TransitionSpec<TContext = unknown, TExtracted = unknown> {
  /** Custom ID for this state (optional - will generate deterministic ID if not provided) */
  id?: string;
  /** Transition to a chat state with this description */
  chatState?: string;
  /** Transition to execute a tool */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  toolState?: ToolRef<TContext, any[], any>;
  /** Transition to a specific state or end marker */
  state?: StateRef | symbol;
  /**
   * NEW: Fields to gather from the conversation in this state
   * These should match keys in the route's extractionSchema
   */
  gather?: string[];
  /**
   * NEW: Function to determine if this state should be skipped
   * If returns true, the state will be bypassed
   * @param extracted - Currently extracted data
   * @returns true if state should be skipped, false otherwise
   */
  skipIf?: (extracted: Partial<TExtracted>) => boolean;
  /**
   * NEW: Required data fields that must be present before entering this state
   * If any required field is missing, state cannot be entered
   * Uses string[] for developer-friendly usage (same as gather)
   */
  requiredData?: string[];
  /**
   * Optional condition for this transition
   * Description of when this transition should be taken
   */
  condition?: string;
}

/**
 * Result of a transition operation
 * Combines state reference with the ability to chain transitions
 */
export interface TransitionResult<TContext = unknown, TExtracted = unknown>
  extends StateRef {
  /** Allow chaining transitions */
  transitionTo: (
    spec: TransitionSpec<TContext, TExtracted>
  ) => TransitionResult<TContext, TExtracted>;
}
