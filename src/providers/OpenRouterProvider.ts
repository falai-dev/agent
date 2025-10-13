/**
 * OpenRouter provider implementation
 * OpenRouter provides access to multiple AI models through a unified OpenAI-compatible API
 */

import OpenAI from "openai";
import type { ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions";

import type {
  AiProvider,
  GenerateMessageInput,
  GenerateMessageOutput,
} from "@/types/ai";
import { withTimeoutAndRetry } from "@/utils/retry";

const DEFAULT_RETRY_CONFIG = {
  timeout: 60000,
  retries: 3,
};

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
  config?: Partial<
    Omit<ChatCompletionCreateParamsNonStreaming, "model" | "messages">
  >;
  /** Retry configuration */
  retryConfig?: {
    timeout?: number;
    retries?: number;
  };
}

/**
 * Type guard for errors with status/code properties
 */
interface ErrorWithStatus {
  status?: number;
  code?: string;
  message?: string;
  type?: string;
}

/**
 * Type guard to check if error is ErrorWithStatus
 */
function isErrorWithStatus(error: unknown): error is ErrorWithStatus {
  return (
    typeof error === "object" &&
    error !== null &&
    ("status" in error || "code" in error || "message" in error)
  );
}

/**
 * Safely extract error message
 */
function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (isErrorWithStatus(error) && error.message) {
    return error.message;
  }
  return String(error);
}

/**
 * Determines if an error should trigger backup model usage
 */
const shouldUseBackupModel = (error: unknown): boolean => {
  if (!isErrorWithStatus(error)) {
    return false;
  }

  // Server errors
  if (error.status === 500 || error.status === 503) {
    return true;
  }

  // Rate limiting
  if (error.status === 429) {
    return true;
  }

  // Model not available or overloaded
  if (error.code === "model_not_found" || error.code === "model_overloaded") {
    return true;
  }

  const message = getErrorMessage(error);
  if (
    message.includes("overloaded") ||
    message.includes("unavailable") ||
    message.includes("internal error") ||
    message.includes("Internal error") ||
    message.includes("capacity")
  ) {
    return true;
  }

  return false;
};

/**
 * OpenRouter provider implementation
 * Provides access to multiple AI models through OpenRouter's unified API
 */
export class OpenRouterProvider implements AiProvider {
  public readonly name = "openrouter";
  private client: OpenAI;
  private primaryModel: string;
  private backupModels: string[];
  private config?: Partial<
    Omit<ChatCompletionCreateParamsNonStreaming, "model" | "messages">
  >;
  private retryConfig: { timeout: number; retries: number };

  constructor(options: OpenRouterProviderOptions) {
    const {
      apiKey,
      model,
      backupModels = [],
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
    this.client = new OpenAI({
      apiKey,
      baseURL: "https://openrouter.ai/api/v1",
      defaultHeaders: {
        "HTTP-Referer": siteUrl || "",
        "X-Title": siteName || "",
      },
    });

    this.primaryModel = model;
    this.backupModels = backupModels;
    this.config = config;
    this.retryConfig = {
      timeout: retryConfig?.timeout || DEFAULT_RETRY_CONFIG.timeout,
      retries: retryConfig?.retries || DEFAULT_RETRY_CONFIG.retries,
    };
  }

  async generateMessage<TContext = unknown>(
    input: GenerateMessageInput<TContext>
  ): Promise<GenerateMessageOutput> {
    return this.generateWithBackup(input);
  }

  private async generateWithBackup<TContext = unknown>(
    input: GenerateMessageInput<TContext>
  ): Promise<GenerateMessageOutput> {
    // Try primary model first
    try {
      return await this.generateWithModel(this.primaryModel, input);
    } catch (primaryError: unknown) {
      const primaryErrMsg = getErrorMessage(primaryError);
      console.warn(
        `[OPENROUTER] Primary model ${this.primaryModel} failed: ${primaryErrMsg}`
      );

      if (!shouldUseBackupModel(primaryError)) {
        throw primaryError;
      }

      console.log(`[OPENROUTER] Trying backup models`);

      let lastBackupError: unknown = primaryError;

      for (let i = 0; i < this.backupModels.length; i++) {
        const backupModel = this.backupModels[i];
        console.log(
          `[OPENROUTER] Trying backup model ${i + 1}/${
            this.backupModels.length
          }: ${backupModel}`
        );

        try {
          const result = await this.generateWithModel(backupModel, input);
          console.log(`[OPENROUTER] Backup model ${backupModel} succeeded`);
          return result;
        } catch (backupError: unknown) {
          const backupErrMsg = getErrorMessage(backupError);
          console.warn(
            `[OPENROUTER] Backup model ${backupModel} failed: ${backupErrMsg}`
          );
          lastBackupError = backupError;

          if (
            !shouldUseBackupModel(backupError) &&
            i < this.backupModels.length - 1
          ) {
            console.log(
              `[OPENROUTER] Backup model error doesn't qualify for further attempts`
            );
            break;
          }
        }
      }

      const lastBackupErrMsg = getErrorMessage(lastBackupError);
      console.error(
        `[OPENROUTER] All models failed. Primary: ${primaryErrMsg}, Last backup: ${lastBackupErrMsg}`
      );
      throw lastBackupError;
    }
  }

  private async generateWithModel<TContext = unknown>(
    model: string,
    input: GenerateMessageInput<TContext>
  ): Promise<GenerateMessageOutput> {
    const operation = async (): Promise<GenerateMessageOutput> => {
      const params: ChatCompletionCreateParamsNonStreaming = {
        model,
        messages: [
          {
            role: "user",
            content: input.prompt,
          },
        ],
        ...this.config,
      };

      // Override with input parameters if provided
      if (input.parameters?.maxOutputTokens !== undefined) {
        params.max_tokens = input.parameters.maxOutputTokens;
      }

      const response = await this.client.chat.completions.create(params);

      const message = response.choices[0]?.message?.content;
      if (!message) {
        throw new Error("No response from OpenRouter");
      }

      return {
        message,
        metadata: {
          model: response.model,
          finishReason: response.choices[0]?.finish_reason,
          tokensUsed: response.usage?.total_tokens,
          promptTokens: response.usage?.prompt_tokens,
          completionTokens: response.usage?.completion_tokens,
        },
      };
    };

    return withTimeoutAndRetry(
      operation,
      this.retryConfig.timeout,
      this.retryConfig.retries,
      `OpenRouter ${model}`
    );
  }
}
