import type { SessionState } from "./session";
import type { Event, MessageRole } from "./history";

/**
 * Context object passed to template functions for dynamic rendering.
 */
export interface TemplateContext<TContext = unknown, TData = unknown> {
  /**
   * The agent's static or dynamically-provided context.
   */
  context?: TContext;

  /**
   * The current session state, including collected data.
   */
  session?: SessionState<TData>;

  /**
   * The recent interaction history.
   */
  history?: Event[];

  /**
   * The data collected in the current flow.
   * A convenience alias for `session.data`.
   */
  data: Partial<TData>;

  /**
   * Helper methods for working with history and context.
   */
  helpers?: {
    /**
     * Get the last message from history, optionally filtered by role.
     * @param role - Optional role to filter by (user, assistant, etc.)
     * @returns The message content or undefined if not found
     */
    getLastMessage(role?: MessageRole): string | undefined;

    /**
     * Get the last user message from history.
     * @returns The user message content or undefined if not found
     */
    getLastUserMessage(): string | undefined;

    /**
     * Get the last assistant message from history.
     * @returns The assistant message content or undefined if not found
     */
    getLastAssistantMessage(): string | undefined;

    /**
     * Get all messages from history, optionally filtered by role.
     * @param role - Optional role to filter by
     * @returns Array of message contents
     */
    getMessages(role?: MessageRole): string[];

    /**
     * Check if the last message contains any of the given keywords.
     * @param keywords - Keywords to search for
     * @param caseSensitive - Whether to perform case-sensitive search (default: false)
     * @returns True if any keyword is found
     */
    lastMessageContains(keywords: string | string[], caseSensitive?: boolean): boolean;
  };
}

/**
 * Represents a string that can be either a literal or a function
 * that dynamically generates a string from context.
 */
export type Template<TContext = unknown, TData = unknown> =
  | string
  | ((params: TemplateContext<TContext, TData>) => string | Promise<string>);



/**
 * Result of condition evaluation containing both programmatic results
 * and AI context strings.
 */
export interface ConditionEvaluationResult {
  /** Result of function evaluations only */
  programmaticResult: boolean;
  /** Positive string values for AI context. Any one may satisfy the condition. */
  aiContextStrings: string[];
  /** Negative string values for AI context. Any one inhibits the condition. */
  aiExclusionStrings?: string[];
  /** Whether any functions were evaluated */
  hasProgrammaticConditions: boolean;
  /** Detailed evaluation information for debugging */
  evaluationDetails?: {
    condition: string;
    result?: boolean; // Only present for functions
    type: 'string' | 'function' | 'array';
  }[];
}
