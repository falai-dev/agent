/**
 * AI provider types
 */

import type { Effort } from "@providerkit/core";
import type { HistoryItem } from "./history.js";

/**
 * How hard the model thinks before answering.
 *
 * `@providerkit/core`'s effort union, which every provider speaks: "none" |
 * "low" | "medium" | "high" | "max". Absent means the provider's own default
 * and is never sent. The shapes that need a thought summary switched on get it
 * whenever an effort is set, so there is no separate setting for it.
 */
export interface ReasoningConfig {
  effort?: Effort;
}

/**
 * Input for AI message generation
 */
export interface GenerateMessageInput<TContext = unknown> {
  /** The constructed prompt, sent as the final user turn. */
  prompt: string;
  /**
   * The part of the prompt that is the same every turn, sent as a leading
   * system message. Split out so providers can cache it — see `stablePrefix`.
   */
  system?: string;
  /** Interaction history */
  history: HistoryItem[];
  /** Context data */
  context: TContext;
  /** Tools available for AI to call during this interaction */
  tools?: Array<{
    id: string;
    name?: string;
    description?: string;
    parameters?: unknown;
  }>;
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
export interface AgentStructuredResponse extends Record<string, unknown> {
  /** The actual message to send to the user */
  message: string;
  /** Flow chosen by the agent (flow title or null if no flow) */
  flow?: string | null;
  /** Current step within the flow (step description or null) */
  step?: string | null;
  /** Tool calls the agent wants to execute */
  toolCalls?: Array<{
    /** Name of the tool to call */
    toolName: string;
    /** Arguments to pass to the tool */
    arguments: Record<string, unknown>;
  }>;
  /** Additional reasoning or internal thoughts (optional) */
  reasoning?: string;
  /** OpenRouter's normalized reasoning payload, when the provider sent one. */
  reasoningDetails?: unknown[];
}

/**
 * What a call cost, as the provider counted it. A turn spends several calls,
 * so `TurnResult.usage` is their sum. Absent when no provider reported any.
 */
export interface TokenUsage {
  /** Tokens read, the cached ones included. */
  promptTokens: number;
  /** Tokens written. Thinking tokens count here. */
  completionTokens: number;
  /** The part of `promptTokens` served from a cache, billed far cheaper. */
  cachedInputTokens: number;
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
    /** Tokens in the prompt, as the provider counted them. */
    promptTokens?: number;
    /** Tokens generated. */
    completionTokens?: number;
    /** The part of `promptTokens` the provider served from its cache, billed far cheaper. */
    cachedInputTokens?: number;
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
    /** Tokens in the prompt, as the provider counted them. */
    promptTokens?: number;
    /** Tokens generated. */
    completionTokens?: number;
    /** The part of `promptTokens` the provider served from its cache, billed far cheaper. */
    cachedInputTokens?: number;
    /** Additional provider-specific data */
    [key: string]: unknown;
  };
  /** Structured response data (only available when done=true and JSON mode is enabled) */
  structured?: TStructured;
}

/**
 * Static capability flags exposed by a provider implementation.
 *
 * Values describe what the implementation actually does (e.g. Anthropic
 * enforces JSON output via a prompt instruction, not a native schema mode).
 */
export interface ProviderCapabilities {
  /** Provider supports tool/function calling */
  supportsTools: boolean;
  /** Provider natively enforces a JSON schema on output (vs. prompt-based JSON instruction) */
  supportsNativeJsonSchema: boolean;
  /** Provider supports streaming responses */
  supportsStreaming: boolean;
  /** Provider surfaces tool calls during streaming */
  supportsStreamingToolCalls: boolean;
  /** Provider supports prompt caching */
  supportsPromptCaching: boolean;
}

/**
 * AI provider interface (strategy pattern)
 */
export interface AiProvider {
  /** Provider name/identifier */
  readonly name: string;

  /** Static capability flags for this provider implementation */
  capabilities: ProviderCapabilities;

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
