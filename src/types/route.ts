/**
 * Route/Journey DSL type definitions
 */

import type { ToolRef, ToolResult } from "./tool";
import type { StructuredSchema } from "./schema";
import { Template } from "./template";

/**
 * Reference to a route
 */
export interface RouteRef {
  /** Route identifier */
  id: string;
}

/**
 * Reference to a step within a route
 */
export interface StepRef {
  /** Step identifier */
  id: string;
  /** Route this step belongs to */
  routeId: string;
}

/**
 * Forward declare Guideline for circular dependency
 */
import type { Guideline } from "./agent";

/**
 * Route transition configuration when route completes
 */
export interface RouteTransitionConfig<TContext = unknown, TData = unknown> {
  /** Target route ID or title to transition to */
  nextStep: string;
  /** Optional AI-evaluated condition for the transition */
  condition?: Template<TContext, TData>;
}

/**
 * Function type for dynamic route completion transitions
 * @param session - Current session step with collected data
 * @param context - Agent context
 * @returns Route ID/title to transition to, or transition config, or undefined to end
 */
export type RouteCompletionHandler<TContext = unknown, TData = unknown> = (
  session: { data?: Partial<TData> },
  context?: TContext
) =>
  | string
  | RouteTransitionConfig<TContext, TData>
  | undefined
  | Promise<string | RouteTransitionConfig<TContext, TData> | undefined>;

/**
 * Options for creating a route
 * @template TData - Type of data collected throughout the route (inferred from schema)
 */
export interface RouteOptions<TContext = unknown, TData = unknown> {
  /** Custom ID for the route (optional - will generate deterministic ID from title if not provided) */
  id?: string;
  /** Title of the route */
  title: string;
  /** Description of what this route accomplishes */
  description?: string;
  /** Conditions that activate this route */
  conditions?: Template<TContext, TData>[];
  /** Initial guidelines for this route */
  guidelines?: Guideline<TContext>[];
  /** Domain names that are allowed in this route (undefined = all domains) */
  domains?: string[];
  /** Absolute rules the agent must follow in this route */
  rules?: Template<TContext, TData>[];
  /** Absolute prohibitions the agent must never do in this route */
  prohibitions?: Template<TContext, TData>[];
  /** Optional: extractions the router may return (added to routing schema) */
  routingExtrasSchema?: StructuredSchema;
  /** Optional: structured response data for this route's message generation */
  responseOutputSchema?: StructuredSchema;
  /**
   * NEW: Schema defining data to extract throughout this route
   * This creates a type-safe contract for what data the route collects
   */
  schema?: StructuredSchema;
  /**
   * NEW: Initial data to pre-populate when entering this route
   * Useful for restoring sessions or pre-filling known information
   * Steps with skipIf conditions will be automatically bypassed if data is present
   */
  initialData?: Partial<TData>;
  /**
   * NEW: Sequential steps for simple linear flows
   * If provided, automatically chains the steps from initialStep to END_ROUTE
   * For complex flows with branching, build the step machine manually instead
   */
  steps?: StepOptions<TContext, TData>[];
  /**
   * Configure the initial step (optional)
   * Accepts full StepOptions configuration (id, prompt, collect, skipIf, etc.)
   * Note: tool and step properties are ignored for initial step
   */
  initialStep?: Omit<
    StepOptions<TContext, TData>,
    "tool" | "step" | "condition"
  >;
  /**
   * Configure the end step (optional)
   * Defines what happens when the route completes (reaches END_ROUTE)
   * Can include prompt for completion message, tool for final actions, etc.
   * Note: step, condition, skipIf properties are ignored for end step
   */
  endStep?: Omit<StepOptions<TContext, TData>, "step" | "condition" | "skipIf">;
  /**
   * Optional transition when route completes (reaches END_ROUTE)
   * Can be:
   * - String: Route ID or title to transition to
   * - Object: Transition config with optional AI-evaluated condition
   * - Function: Dynamic logic that returns route ID, config, or undefined
   *
   * @example
   * // Simple string
   * onComplete: "feedback-collection"
   *
   * @example
   * // With condition
   * onComplete: {
   *   nextStep: "feedback-collection",
   *   condition: "if booking succeeded"
   * }
   *
   * @example
   * // Dynamic function
   * onComplete: (session) => {
   *   if (session.data?.success) return "feedback";
   *   return "error-recovery";
   * }
   */
  onComplete?:
    | string
    | RouteTransitionConfig<TContext, TData>
    | RouteCompletionHandler<TContext, TData>;
}

/**
 * Inline tool handler for dynamic tool generation
 */
export type InlineToolHandler<TContext = unknown, TData = unknown> = (
  context: import("./tool").ToolContext<TContext, TData>
) =>
  | ToolResult<unknown, TContext, TData>
  | Promise<ToolResult<unknown, TContext, TData>>;

/**
 * Specification for a step transition
 */
export interface StepOptions<TContext = unknown, TData = unknown> {
  /** Custom ID for this step (optional - will generate deterministic ID if not provided) */
  id?: string;
  /** Description of the transition */
  description?: string;
  /** Transition to a chat state with this description */
  prompt?: Template<TContext, TData>;
  /** Transition to execute a tool */
  tool?: // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ToolRef<TContext, any[], any, TData> | InlineToolHandler<TContext, TData>;
  /** Transition to a specific step or end marker */
  step?: StepRef | symbol;
  /**
   * NEW: Fields to collect from the conversation in this step
   * These should match keys in the route's schema
   */
  collect?: string[];
  /**
   * NEW: Function to determine if this step should be skipped
   * If returns true, the step will be bypassed
   * @param data - Currently collected data
   * @returns true if step should be skipped, false otherwise
   */
  skipIf?: (data: Partial<TData>) => boolean;
  /**
   * NEW: Required data fields that must be present before entering this step
   * If any required field is missing, step cannot be entered
   * Uses string[] for developer-friendly usage (same as collect)
   */
  requires?: string[];
  /**
   * Optional condition for this transition
   * Description of when this transition should be taken
   */
  condition?: Template<TContext, TData>;
}

/**
 * Result of a transition operation
 * Combines step reference with the ability to chain transitions
 */
export interface StepResult<TContext = unknown, TData = unknown>
  extends StepRef {
  /** Allow chaining transitions */
  nextStep: (spec: StepOptions<TContext, TData>) => StepResult<TContext, TData>;
}
