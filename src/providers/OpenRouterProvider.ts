/**
 * OpenRouter provider implementation
 * OpenRouter provides access to multiple AI models through a unified OpenAI-compatible API
 */

import OpenAI from "openai";

import type { ProviderCapabilities } from "../types/ai";
import type { ErrorClassificationOptions } from "./errorClassification";
import {
  OpenAICompatibleProvider,
  type OpenAICompatibleRequestConfig,
} from "./OpenAICompatibleProvider";

/**
 * Configuration options for OpenRouter provider
 * Uses types from openai package (OpenRouter is OpenAI-compatible)
 */
export interface OpenRouterProviderOptions {
  /** OpenRouter API key */
  apiKey: string;
  /** Model to use (required) - see https://openrouter.ai/models */
  model: string;
  /** Backup models to try if primary fails (default: []) */
  backupModels?: string[];
  /** Optional site URL for OpenRouter rankings */
  siteUrl?: string;
  /** Optional app name for OpenRouter rankings */
  siteName?: string;
  /** Default parameters - uses ChatCompletionCreateParamsNonStreaming from openai package */
  config?: OpenAICompatibleRequestConfig;
  /** Retry configuration */
  retryConfig?: {
    timeout?: number;
    retries?: number;
  };
}

/**
 * OpenRouter provider implementation
 * Provides access to multiple AI models through OpenRouter's unified API
 */
export class OpenRouterProvider extends OpenAICompatibleProvider {
  public readonly name = "openrouter";
  public readonly capabilities: ProviderCapabilities = {
    supportsTools: true,
    supportsNativeJsonSchema: true,
    supportsStreaming: true,
    supportsStreamingToolCalls: true,
    supportsPromptCaching: false,
  };

  protected readonly logLabel = "OPENROUTER";
  protected readonly displayName = "OpenRouter";

  /** OpenRouter additionally reports capacity issues in error messages */
  protected override readonly classificationOptions: ErrorClassificationOptions =
    {
      overloadedCodes: ["model_not_found", "model_overloaded"],
      overloadedMessages: ["capacity"],
    };

  constructor(options: OpenRouterProviderOptions) {
    const {
      apiKey,
      model,
      backupModels,
      siteUrl,
      siteName,
      config,
      retryConfig,
    } = options;

    if (!apiKey) {
      throw new Error("OpenRouter API key is required");
    }

    if (!model) {
      throw new Error("Model is required. See https://openrouter.ai/models");
    }

    // Initialize OpenAI client with OpenRouter base URL
    super({
      client: new OpenAI({
        apiKey,
        baseURL: "https://openrouter.ai/api/v1",
        defaultHeaders: {
          "HTTP-Referer": siteUrl || "",
          "X-Title": siteName || "",
        },
      }),
      model,
      backupModels,
      config,
      retryConfig,
    });
  }
}
