/**
 * Agent-related type definitions
 */

import type { AiProvider } from "./ai";
import type { ToolRef } from "./tool";
import type { RouteOptions } from "./route";

/**
 * Composition mode determines how the agent processes and structures responses
 */
export enum CompositionMode {
  /** Fluid, natural conversation without strict structure */
  FLUID = "fluid",
  /** Canned responses with fluid fallback */
  CANNED_FLUID = "canned_fluid",
  /** Composited canned responses */
  CANNED_COMPOSITED = "composited_canned",
  /** Strict canned responses only */
  CANNED_STRICT = "strict_canned",
}

/**
 * Forward declare observation types
 */
import type { ObservationOptions } from "./observation";

/**
 * Context lifecycle hooks for managing state persistence
 */
export interface ContextLifecycleHooks<TContext = unknown> {
  /**
   * Called before respond() to get fresh context
   * Useful for loading context from a database or cache
   */
  beforeRespond?: (currentContext: TContext) => Promise<TContext> | TContext;

  /**
   * Called after context is updated via updateContext() or tool execution
   * Useful for persisting context to a database or cache
   */
  onContextUpdate?: (
    newContext: TContext,
    previousContext: TContext
  ) => Promise<void> | void;
}

/**
 * Context provider function for always-fresh context
 * Alternative to static context, useful for loading from external sources
 */
export type ContextProvider<TContext = unknown> = () =>
  | Promise<TContext>
  | TContext;

/**
 * Options for creating an Agent
 */
export interface AgentOptions<TContext = unknown> {
  /** Display name of the agent */
  name: string;
  /** Detailed description of the agent's purpose and personality */
  description?: string;
  /** The agent's primary goal or objective */
  goal?: string;
  /** Default context data available to the agent */
  context?: TContext;
  /** Context provider function for always-fresh context (alternative to static context) */
  contextProvider?: ContextProvider<TContext>;
  /** Lifecycle hooks for context management */
  hooks?: ContextLifecycleHooks<TContext>;
  /** AI provider strategy for generating responses */
  ai: AiProvider;
  /** Maximum number of processing iterations per request */
  maxEngineIterations?: number;
  /** Composition mode for response generation */
  compositionMode?: CompositionMode;
  /** Initial terms for domain glossary */
  terms?: Term[];
  /** Initial guidelines for agent behavior */
  guidelines?: Guideline[];
  /** Initial capabilities */
  capabilities?: Capability[];
  /** Initial routes (will be instantiated as Route objects) */
  routes?: RouteOptions[];
  /** Initial observations for disambiguation */
  observations?: ObservationOptions[];
}

/**
 * A term in the domain glossary
 */
export interface Term {
  /** Name of the term */
  name: string;
  /** Description/definition of the term */
  description: string;
  /** Alternative names or synonyms */
  synonyms?: string[];
}

/**
 * A behavioral guideline for the agent
 */
export interface Guideline {
  /** Unique identifier */
  id?: string;
  /** Condition that triggers this guideline (optional for always-active guidelines) */
  condition?: string;
  /** Action the agent should take when the condition is met */
  action: string;
  /** Whether this guideline is currently enabled */
  enabled?: boolean;
  /** Tags for organizing and filtering guidelines */
  tags?: string[];
  /** Tools available when following this guideline */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools?: ToolRef<any, any[], any>[];
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * A capability the agent can perform
 */
export interface Capability {
  /** Unique identifier */
  id?: string;
  /** Title of the capability */
  title: string;
  /** Description of what the capability does */
  description: string;
  /** Tools used by this capability */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools?: ToolRef<any, any[], any>[];
}

/**
 * Guideline match with rationale
 */
export interface GuidelineMatch {
  /** The matched guideline */
  guideline: Guideline;
  /** Explanation of why this guideline was matched */
  rationale?: string;
}
