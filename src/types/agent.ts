/**
 * Agent-related type definitions
 */

import type { AgentStructuredResponse, AiProvider } from "./ai";
import type { Tool } from "./tool";
import type { RouteOptions } from "./route";
import type { PersistenceConfig } from "./persistence";
import type { SessionState } from "./session";
import { Template } from "./template";

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
 * Context lifecycle hooks for managing step persistence
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

  /**
   * Called after collected data is updated (from AI response or tool execution)
   * Useful for validation, enrichment, or persistence of collected data
   * Return modified collected data or the same data to keep it unchanged
   *
   * Note: This hook works with ANY route's collected data (since an agent can have
   * multiple routes with different extraction schemas). Use type guards or runtime
   * checks if you need type-specific logic.
   */

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onDataUpdate?: (data: any, previousCollected: any) => any;
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
  /** Optional personality/tone prompt used in prompts */
  personality?: Template<TContext>;
  /** Optional identity prompt defining the agent's self-concept and role */
  identity?: Template<TContext>;
  /** Enable debug logging */
  debug?: boolean;
  /** Default context data available to the agent */
  context?: TContext;
  /** Optional current session for convenience methods */
  session?: SessionState;
  /** Optional sessionId to load or create - managed by SessionManager */
  sessionId?: string;
  /** Context provider function for always-fresh context (alternative to static context) */
  contextProvider?: ContextProvider<TContext>;
  /** Lifecycle hooks for context management */
  hooks?: ContextLifecycleHooks<TContext>;
  /** AI provider strategy for generating responses */
  provider: AiProvider;
  /** Composition mode for response generation */
  compositionMode?: CompositionMode;
  /** Initial terms for domain glossary */
  terms?: Term<TContext>[];
  /** Initial guidelines for agent behavior */
  guidelines?: Guideline<TContext>[];
  /** Global tools available to all routes */
  tools?: Tool<TContext, unknown[], unknown, unknown>[];
  /** Initial routes (will be instantiated as Route objects) */
  routes?: RouteOptions<TContext, unknown>[];
  /** Optional persistence configuration for auto-saving sessions and messages */
  persistence?: PersistenceConfig;
  /** Knowledge base containing any JSON structure the AI should know */
  knowledgeBase?: Record<string, unknown>;
}

/**
 * A term in the domain glossary
 */
export interface Term<TContext = unknown> {
  /** Name of the term */
  name: Template<TContext>;
  /** Description/definition of the term */
  description: Template<TContext>;
  /** Alternative names or synonyms */
  synonyms?: Template<TContext>[];
}

/**
 * A behavioral guideline for the agent
 */
export interface Guideline<TContext = unknown> {
  /** Unique identifier */
  id?: string;
  /** Condition that triggers this guideline (optional for always-active guidelines) */
  condition?: Template<TContext>;
  /** Action the agent should take when the condition is met */
  action: Template<TContext>;
  /** Whether this guideline is currently enabled */
  enabled?: boolean;
  /** Tags for organizing and filtering guidelines */
  tags?: string[];
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Guideline match with rationale
 */
export interface GuidelineMatch<TContext = unknown> {
  /** The matched guideline */
  guideline: Guideline<TContext>;
  /** Explanation of why this guideline was matched */
  rationale?: string;
}

export interface AgentResponse<TData = Record<string, unknown>> {
  message: string;
  session?: SessionState<TData>;
  toolCalls?: Array<{ toolName: string; arguments: Record<string, unknown> }>;
  isRouteComplete?: boolean;
}

export interface AgentResponseStreamChunk<TData = Record<string, unknown>> {
  delta: string;
  accumulated: string;
  done: boolean;
  session?: SessionState<TData>;
  toolCalls?: Array<{ toolName: string; arguments: Record<string, unknown> }>;
  isRouteComplete?: boolean;
  metadata?: {
    model?: string;
    tokensUsed?: number;
    finishReason?: string;
    [key: string]: unknown;
  };
  structured?: AgentStructuredResponse;
}
