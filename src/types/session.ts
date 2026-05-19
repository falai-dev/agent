/**
 * Session step types for tracking conversation progress
 */

import type { History } from "./history";
import type { Directive } from "./flow";
import type { SignalsState } from "./signals";

// Re-export for backward compatibility — canonical declarations live in ./signals.ts
export type { SignalsState, SignalTriggerState } from "./signals";

/**
 * Session state tracks the current position in the conversation flow
 * and data collected at the agent level across all flows
 */
export interface SessionState<TData = unknown> {
  /** Unique session identifier (useful for persistence) */
  id: string;

  /** Current flow the conversation is in */
  currentFlow?: {
    id: string;
    title: string;
    enteredAt?: Date;
  };

  /** Current step within the flow */
  currentStep?: {
    id: string;
    description?: string;
    enteredAt?: Date;
  };

  /**
   * Agent-level data collected across all flows
   * This is the single source of truth for all collected data
   * Flows can access and contribute to this shared data structure
   */
  data: Partial<TData>;

  /** History of flows visited in this session */
  flowHistory?: Array<{
    flowId: string;
    enteredAt?: Date;
    exitedAt?: Date;
    completed: boolean;
  }>;

  /**
   * Pending directive to apply at the start of the next turn.
   * Replaces the v1 `pendingTransition` field. When set, the turn pipeline
   * applies this directive and skips `FlowRouter.decideFlowAndStep`.
   *
   * Cleared after application unless `complete.next` chains another directive.
   */
  pendingDirective?: Directive<unknown, TData>;

  /**
   * Reserved for v2.x Signals feature. v2.0 does not read or mutate this
   * field at runtime — persistence adapters preserve it bit-identical through
   * save → load roundtrips. See Decision D-Q6 in design.md.
   */
  signals?: SignalsState;

  /**
   * Conversation history managed by the session
   * Contains the full conversation between user and assistant
   */
  history?: History;

  /** Session metadata */
  metadata?: {
    createdAt?: Date;
    lastUpdatedAt?: Date;
    [key: string]: unknown;
  };
}
