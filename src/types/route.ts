/**
 * Route/Journey DSL type definitions
 */

import type { Tool } from "./tool";
import type { StructuredSchema } from "./schema";
import type { Guideline, Term } from "./agent";
import { Template, ConditionTemplate } from "./template";

/**
 * Reason why batch execution stopped
 * Used to indicate the stopping condition for multi-step execution
 */
export type StoppedReason =
  | 'needs_input'      // Step requires uncollected data
  | 'end_route'        // Reached END_ROUTE
  | 'route_complete'   // All Steps processed
  | 'prepare_error'    // Error in prepare hook
  | 'llm_error'        // Error during LLM call
  | 'validation_error' // Error validating collected data
  | 'finalize_error';  // Error in finalize hook (non-fatal, logged)

/**
 * Event types for batch execution observability
 */
export type BatchExecutionEventType = 
  | 'batch_start' 
  | 'step_included' 
  | 'step_skipped' 
  | 'batch_stop' 
  | 'batch_complete';

/**
 * Event emitted during batch execution for debugging and observability
 * 
 * **Validates: Requirements 11.3**
 */
export interface BatchExecutionEvent {
  /** Type of batch execution event */
  type: BatchExecutionEventType;
  /** Timestamp when the event occurred */
  timestamp: Date;
  /** Event-specific details */
  details: {
    /** Step ID related to this event (for step_included, step_skipped) */
    stepId?: string;
    /** Reason for the event (e.g., why step was skipped or batch stopped) */
    reason?: string;
    /** Current batch size (for batch_start, batch_complete) */
    batchSize?: number;
    /** Stopped reason (for batch_stop, batch_complete) */
    stoppedReason?: StoppedReason;
    /** Phase timing information (for batch_complete) */
    timing?: BatchExecutionTiming;
  };
}

/**
 * Timing information for batch execution phases
 */
export interface BatchExecutionTiming {
  /** Total batch execution time in milliseconds */
  totalMs: number;
  /** Time spent in batch determination phase */
  determinationMs?: number;
  /** Time spent executing prepare hooks */
  prepareHooksMs?: number;
  /** Time spent in LLM call */
  llmCallMs?: number;
  /** Time spent collecting data */
  dataCollectionMs?: number;
  /** Time spent executing finalize hooks */
  finalizeHooksMs?: number;
}

/**
 * Callback type for batch execution event listeners
 */
export type BatchExecutionEventListener = (event: BatchExecutionEvent) => void;

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
 * Result of batch determination - which steps can execute together
 * @template TContext - Type of context data
 * @template TData - Type of collected data
 */
export interface BatchResult<TContext = unknown, TData = unknown> {
  /** Steps included in this batch */
  steps: StepOptions<TContext, TData>[];
  /** Why the batch stopped */
  stoppedReason: StoppedReason;
  /** The Step that caused the stop (if applicable) */
  stoppedAtStep?: StepOptions<TContext, TData>;
}

/**
 * Error details for batch execution failures
 */
export interface BatchExecutionError {
  /** Type of error that occurred */
  type: 'pre_extraction' | 'skipif_evaluation' | 'prepare_hook' | 
        'llm_call' | 'data_validation' | 'finalize_hook';
  /** Error message */
  message: string;
  /** Step where error occurred (if applicable) */
  stepId?: string;
  /** Additional error details */
  details?: unknown;
}

/**
 * Result of executing a batch of steps
 * @template TData - Type of collected data
 */
export interface BatchExecutionResult<TData = unknown> {
  /** The generated message */
  message: string;
  /** Updated session state */
  session: import('./session').SessionState<TData>;
  /** Steps that were executed */
  executedSteps: StepRef[];
  /** Why execution stopped */
  stoppedReason: StoppedReason;
  /** Collected data from the batch */
  collectedData?: Partial<TData>;
  /** Any errors that occurred */
  error?: BatchExecutionError;
}

/**
 * Route lifecycle hooks for managing route-specific data and behavior
 */
export interface RouteLifecycleHooks<TContext = unknown, TData = unknown> {
  /**
   * Called after collected data is updated for this route (from AI response or tool execution)
   * Useful for validation, enrichment, or persistence of route-specific collected data
   * Return modified collected data or the same data to keep it unchanged
   *
   * Unlike Agent-level onDataUpdate, this only triggers for data changes in this specific route.
   */
  onDataUpdate?: (
    data: Partial<TData>,
    previousCollected: Partial<TData>
  ) => Partial<TData> | Promise<Partial<TData>>;

  /**
   * Called after context is updated via updateContext() when this route is active
   * Useful for route-specific context reactions, validation, or side effects
   *
   * Unlike Agent-level onContextUpdate, this only triggers when this specific route is active.
   */
  onContextUpdate?: (
    newContext: TContext,
    previousContext: TContext
  ) => void | Promise<void>;
}

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
  /** Optional identity prompt defining the agent's role and persona for this route */
  identity?: Template<TContext, TData>;
  /** Optional personality prompt defining the agent's communication style for this route */
  personality?: Template<TContext, TData>;
  /** Conditions that activate this route */
  when?: ConditionTemplate<TContext, TData>;
  /** Conditions that prevent this route from being considered */
  skipIf?: ConditionTemplate<TContext, TData>;
  /** Initial guidelines for this route */
  guidelines?: Guideline<TContext, TData>[];
  /** Initial terms for the route's domain glossary */
  terms?: Term<TContext>[];
  /** Tools available in this route */
  tools?: (string | Tool<TContext, TData>)[];
  /** Absolute rules the agent must follow in this route */
  rules?: Template<TContext, TData>[];
  /** Absolute prohibitions the agent must never do in this route */
  prohibitions?: Template<TContext, TData>[];
  /** Optional: extractions the router may return (added to routing schema) */
  routingExtrasSchema?: StructuredSchema;
  /** Optional: structured response data for this route's message generation */
  responseOutputSchema?: StructuredSchema;
  /**
   * Required fields for route completion - must be valid keys from agent's TData type
   * Route is considered complete when all required fields are present in agent data
   */
  requiredFields?: (keyof TData)[];
  /**
   * Optional fields that enhance the route but aren't required for completion
   * Must be valid keys from agent's TData type
   */
  optionalFields?: (keyof TData)[];
  /**
   * Initial data to pre-populate when entering this route
   * Useful for restoring sessions or pre-filling known information
   * Steps with skipIf conditions will be automatically bypassed if data is present
   * Now refers to agent-level data
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
  initialStep?: Omit<StepOptions<TContext, TData>, "step">;
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
  /**
   * Route lifecycle hooks
   */
  hooks?: RouteLifecycleHooks<TContext, TData>;
  /** Knowledge base specific to this route containing any JSON structure the AI should know */
  knowledgeBase?: Record<string, unknown>;
}

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
  /** Tools available for AI to call in this step (by ID reference or inline definition) */
  tools?: (string | Tool<TContext, TData>)[];
  /** Programmatic function or tool to run before AI responds */
  prepare?:
    | string
    | Tool<TContext, TData>
    | ((context: TContext, data?: Partial<TData>) => void | Promise<void>);
  /** Programmatic function or tool to run after AI responds */
  finalize?:
    | string
    | Tool<TContext, TData>
    | ((context: TContext, data?: Partial<TData>) => void | Promise<void>);
  /** Transition to a specific step or end marker */
  step?: StepRef | symbol;
  /**
   * Fields to collect from the conversation in this step
   * These should match keys in the agent's TData schema
   */
  collect?: (keyof TData)[];
  /**
   * Condition to determine if this step should be skipped
   * If evaluates to true, the step will be bypassed
   * Supports strings (AI context), functions (programmatic), and arrays
   */
  skipIf?: ConditionTemplate<TContext, TData>;
  /**
   * Required data fields that must be present before entering this step
   * If any required field is missing, step cannot be entered
   * Must be valid keys from agent's TData type
   */
  requires?: (keyof TData)[];
  /**
   * Optional condition for this transition
   * Description of when this transition should be taken
   * Supports strings (AI context), functions (programmatic), and arrays
   */
  when?: ConditionTemplate<TContext, TData>;
  /** Initial guidelines for this step */
  guidelines?: Guideline<TContext, TData>[];
}

/**
 * Specification for a branch in the conversation flow
 */
export interface BranchSpec<TContext = unknown, TData = unknown> {
  /** User-friendly identifier for this branch (used as object key) */
  name: string;
  /** Optional ID for this branch (auto-generated if not provided) */
  id?: string;
  /** Step configuration for this branch */
  step: StepOptions<TContext, TData>;
}

/**
 * Result of a branch operation
 * Maps branch names to their respective step results for continued chaining
 */
export interface BranchResult<TContext = unknown, TData = unknown> {
  [branchName: string]: StepResult<TContext, TData>;
}

/**
 * Result of a transition operation
 * Combines step reference with the ability to chain transitions and create branches
 */
export interface StepResult<TContext = unknown, TData = unknown>
  extends StepRef {
  /** Allow chaining transitions */
  nextStep: (spec: StepOptions<TContext, TData>) => StepResult<TContext, TData>;
  /** Create multiple branches from this step */
  branch: (
    branches: BranchSpec<TContext, TData>[]
  ) => BranchResult<TContext, TData>;
  /** Shortcut to end the current route */
  endRoute: (options?: Omit<StepOptions<TContext, TData>, "step">) => StepResult<TContext, TData>;
}
