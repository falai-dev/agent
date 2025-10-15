/**
 * AI provider strategy types
 */

import type { Event } from "./history";

/**
 * Reasoning/thinking configuration for AI models
 */
export interface ReasoningConfig {
  /**
   * Effort level for reasoning models (OpenAI: gpt-5, o-series)
   * - minimal: Fastest, least reasoning
   * - low: Basic reasoning
   * - medium: Balanced reasoning
   * - high: Maximum reasoning effort
   */
  effort?: "minimal" | "low" | "medium" | "high";
  /**
   * Summary detail level of reasoning process
   * - auto: Model decides
   * - concise: Brief summary
   * - detailed: Full reasoning details
   */
  summary?: "auto" | "concise" | "detailed";
  /**
   * Whether to include thinking/reasoning in response (Gemini)
   */
  includeThoughts?: boolean;
}

/**
 * Input for AI message generation
 */
export interface GenerateMessageInput<TContext = unknown> {
  /** The constructed prompt */
  prompt: string;
  /** Interaction history */
  history: Event[];
  /** Context data */
  context: TContext;
  /** Additional generation parameters */
  parameters?: {
    /** Maximum output tokens to generate */
    maxOutputTokens?: number;
    /** Reasoning/thinking configuration */
    reasoning?: ReasoningConfig;
    /**
     * Required: Structured JSON schema the provider must enforce for output
     */
    jsonSchema: { [key: string]: unknown };
    /** Optional schema name (used by providers that require one) */
    schemaName?: string;
  };
  /** Abort signal for cancellation */
  signal?: AbortSignal;
}

/**
 * Structured response from AI containing message and metadata
 */
export interface AgentStructuredResponse {
  /** The actual message to send to the user */
  message: string;
  /** Route chosen by the agent (route title or null if no route) */
  route?: string | null;
  /** Current state within the route (state description or null) */
  state?: string | null;
  /** Tool calls the agent wants to execute */
  toolCalls?: Array<{
    /** Name of the tool to call */
    toolName: string;
    /** Arguments to pass to the tool */
    arguments: Record<string, unknown>;
  }>;
  /** Additional reasoning or internal thoughts (optional) */
  reasoning?: string;
}

/**
 * Output from AI message generation
 */
export interface GenerateMessageOutput<TStructured = AgentStructuredResponse> {
  /** The generated message */
  message: string;
  /** Optional metadata about generation */
  metadata?: {
    /** Model used */
    model?: string;
    /** Tokens consumed */
    tokensUsed?: number;
    /** Finish reason */
    finishReason?: string;
    /** Additional provider-specific data */
    [key: string]: unknown;
  };
  /** Structured response data (when JSON mode is enabled) */
  structured?: TStructured;
}

/**
 * Stream chunk from AI message generation
 */
export interface GenerateMessageStreamChunk<
  TStructured = AgentStructuredResponse
> {
  /** The delta/chunk of the message */
  delta: string;
  /** Accumulated message so far */
  accumulated: string;
  /** Whether this is the final chunk */
  done: boolean;
  /** Optional metadata about generation */
  metadata?: {
    /** Model used */
    model?: string;
    /** Tokens consumed */
    tokensUsed?: number;
    /** Finish reason */
    finishReason?: string;
    /** Additional provider-specific data */
    [key: string]: unknown;
  };
  /** Structured response data (only available when done=true and JSON mode is enabled) */
  structured?: TStructured;
}

/**
 * AI provider interface (strategy pattern)
 */
export interface AiProvider {
  /** Provider name/identifier */
  readonly name: string;

  /**
   * Generate a message based on prompt and context
   */
  generateMessage<TContext = unknown, TStructured = AgentStructuredResponse>(
    input: GenerateMessageInput<TContext>
  ): Promise<GenerateMessageOutput<TStructured>>;

  /**
   * Generate a message as a stream based on prompt and context
   */
  generateMessageStream<
    TContext = unknown,
    TStructured = AgentStructuredResponse
  >(
    input: GenerateMessageInput<TContext>
  ): AsyncGenerator<GenerateMessageStreamChunk<TStructured>>;
}
