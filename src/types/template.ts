import type { SessionState } from "./session";
import type { Event } from "./history";

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
   * The data collected in the current route.
   * A convenience alias for `session.data`.
   */
  data?: Partial<TData>;
}

/**
 * Represents a string that can be either a literal or a function
 * that dynamically generates a string from context.
 */
export type Template<TContext = unknown, TData = unknown> =
  | string
  | ((params: TemplateContext<TContext, TData>) => string | Promise<string>);
