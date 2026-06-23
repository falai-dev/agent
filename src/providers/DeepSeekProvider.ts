/**
 * DeepSeek provider implementation (OpenAI-compatible API)
 * Supports deepseek-chat, deepseek-reasoner with optional thinking/reasoning mode.
 * DeepSeek streams reasoning content via `delta.reasoning_content` when thinking is enabled.
 */

import OpenAI from "openai";
import type {
  ChatCompletionChunk,
  ChatCompletionCreateParamsStreaming,
} from "openai/resources/chat/completions";

import type { ProviderCapabilities } from "../types/ai";
import { logger } from "../utils";
import {
  OpenAICompatibleProvider,
  type OpenAICompatibleRequestConfig,
} from "./OpenAICompatibleProvider";

/**
 * Configuration options for DeepSeek provider
 * Uses types from openai package (DeepSeek is OpenAI-compatible)
 */
export interface DeepSeekProviderOptions {
  /** DeepSeek API key */
  apiKey: string;
  /** Model to use (required) - e.g., "deepseek-chat", "deepseek-reasoner" */
  model: string;
  /** Backup models to try if primary fails (default: []) */
  backupModels?: string[];
  /** Custom base URL (default: "https://api.deepseek.com") */
  baseURL?: string;
  /** Default parameters - uses ChatCompletionCreateParamsNonStreaming from openai package */
  config?: OpenAICompatibleRequestConfig;
  /** Retry configuration */
  retryConfig?: {
    timeout?: number;
    retries?: number;
  };
}

/**
 * DeepSeek provider implementation using the OpenAI-compatible API.
 * Supports deepseek-chat and deepseek-reasoner with optional thinking mode.
 *
 * DeepSeek streams reasoning content via `delta.reasoning_content` when
 * thinking mode is enabled. Tool calls follow the standard OpenAI format.
 * Structured output uses chat completions with a json_schema response
 * format (DeepSeek does not expose the responses.parse API).
 */
export class DeepSeekProvider extends OpenAICompatibleProvider {
  public readonly name = "deepseek";
  public readonly capabilities: ProviderCapabilities = {
    supportsTools: true,
    supportsNativeJsonSchema: true,
    supportsStreaming: true,
    supportsStreamingToolCalls: true,
    supportsPromptCaching: false,
  };

  protected readonly logLabel = "DEEPSEEK";
  protected readonly displayName = "DeepSeek";

  constructor(options: DeepSeekProviderOptions) {
    const {
      apiKey,
      model,
      backupModels,
      baseURL = "https://api.deepseek.com",
      config,
      retryConfig,
    } = options;

    if (!apiKey) {
      throw new Error("DeepSeek API key is required");
    }

    if (!model) {
      throw new Error(
        "Model is required. Example: 'deepseek-chat' or 'deepseek-reasoner'"
      );
    }

    super({
      client: new OpenAI({
        apiKey,
        baseURL,
      }),
      model,
      backupModels,
      config,
      retryConfig,
      // DeepSeek has no responses.parse API; structured output goes through
      // chat completions with a native json_schema response_format.
      structuredOutput: "json_schema",
    });
  }

  /**
   * DeepSeek reports usage in streaming chunks when explicitly requested.
   */
  protected override configureStreamParams(
    params: ChatCompletionCreateParamsStreaming
  ): void {
    params.stream_options = { include_usage: true };
  }

  /**
   * DeepSeek streams reasoning via `reasoning_content` on the delta.
   */
  protected override onStreamDelta(
    delta: ChatCompletionChunk.Choice.Delta
  ): void {
    const reasoning =
      ((delta as Record<string, unknown>).reasoning_content as
        | string
        | undefined) ?? undefined;
    if (reasoning) {
      logger.debug(`[${this.logLabel}] Reasoning: ${reasoning}`);
    }
  }
}
