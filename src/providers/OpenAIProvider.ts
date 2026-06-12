/**
 * OpenAI provider implementation with retry and backup models
 */

import OpenAI from "openai";

import type { ProviderCapabilities } from "../types/ai";
import {
  OpenAICompatibleProvider,
  type OpenAICompatibleRequestConfig,
} from "./OpenAICompatibleProvider";

/**
 * Configuration options for OpenAI provider
 * Uses types from openai package
 */
export interface OpenAIProviderOptions {
  /** OpenAI API key */
  apiKey: string;
  /** Organization ID (optional) */
  organization?: string;
  /** Model to use (required) - e.g., "gpt-5.5", "gpt-5.4" */
  model: string;
  /** Backup models to try if primary fails (default: []) */
  backupModels?: string[];
  /** Default parameters - uses ChatCompletionCreateParamsNonStreaming from openai package */
  config?: OpenAICompatibleRequestConfig;
  /** Retry configuration */
  retryConfig?: {
    timeout?: number;
    retries?: number;
  };
}

/**
 * OpenAI provider implementation with backup models and retry logic.
 * Structured output uses the responses.parse API (native JSON schema).
 */
export class OpenAIProvider extends OpenAICompatibleProvider {
  public readonly name = "openai";
  public readonly capabilities: ProviderCapabilities = {
    supportsTools: true,
    supportsNativeJsonSchema: true,
    supportsStreaming: true,
    supportsStreamingToolCalls: true,
    supportsPromptCaching: false,
  };

  protected readonly logLabel = "OPENAI";
  protected readonly displayName = "OpenAI";

  constructor(options: OpenAIProviderOptions) {
    const {
      apiKey,
      organization,
      model,
      backupModels,
      config,
      retryConfig,
    } = options;

    if (!apiKey) {
      throw new Error("OpenAI API key is required");
    }

    if (!model) {
      throw new Error("Model is required. Example: 'gpt-5.5' or 'gpt-5.4'");
    }

    super({
      client: new OpenAI({
        apiKey,
        organization,
      }),
      model,
      backupModels,
      config,
      retryConfig,
    });
  }
}
