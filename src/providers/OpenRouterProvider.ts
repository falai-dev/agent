/**
 * OpenRouter provider implementation
 * OpenRouter provides access to multiple AI models through a unified OpenAI-compatible API
 */

import OpenAI from "openai";
import type { ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions";

import type {
  AiProvider,
  AgentStructuredResponse,
  GenerateMessageInput,
  GenerateMessageOutput,
  GenerateMessageStreamChunk,
} from "../types/ai";
import type { StructuredSchema } from "../types/schema";
import { withTimeoutAndRetry } from "../utils/retry";

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

  /**
   * Adapt common schema format to OpenRouter's format.
   * OpenRouter is OpenAI-compatible and uses standard JSON Schema.
   *
   * @private
   */
  private adaptSchemaForOpenRouter(
    schema: StructuredSchema
  ): Record<string, unknown> {
    // OpenRouter is OpenAI-compatible and uses standard JSON Schema
    // Our StructuredSchema is already JSON Schema compatible
    return schema as Record<string, unknown>;
  }

  async generateMessage<
    TContext = unknown,
    TStructured = AgentStructuredResponse
  >(
    input: GenerateMessageInput<TContext>
  ): Promise<GenerateMessageOutput<TStructured>> {
    return this.generateWithBackup<TContext, TStructured>(input);
  }

  async *generateMessageStream<
    TContext = unknown,
    TStructured = AgentStructuredResponse
  >(
    input: GenerateMessageInput<TContext>
  ): AsyncGenerator<GenerateMessageStreamChunk<TStructured>> {
    yield* this.generateStreamWithBackup<TContext, TStructured>(input);
  }

  private async generateWithBackup<
    TContext = unknown,
    TStructured = AgentStructuredResponse
  >(
    input: GenerateMessageInput<TContext>
  ): Promise<GenerateMessageOutput<TStructured>> {
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
          return result as GenerateMessageOutput<TStructured>;
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

  private async generateWithModel<
    TContext = unknown,
    TStructured = AgentStructuredResponse
  >(
    model: string,
    input: GenerateMessageInput<TContext>
  ): Promise<GenerateMessageOutput<TStructured>> {
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

      // Use structured output API if JSON schema is provided
      if (input.parameters?.jsonSchema) {
        const response = await this.client.responses.parse({
          model,
          prompt: input.prompt,
          input: "",
          reasoning: {
            effort: input.parameters?.reasoning?.effort || "low",
          },
          text: {
            format: {
              type: "json_schema",
              name: input.parameters?.schemaName || "structured_output",
              // Adapt common schema format to OpenRouter's format
              schema: this.adaptSchemaForOpenRouter(
                input.parameters.jsonSchema
              ),
            },
          },
        });

        if (!response.output_parsed) {
          throw new Error("No parsed output returned from OpenRouter");
        }

        const structured = response.output_parsed as AgentStructuredResponse;
        const message = structured.message;

        return {
          message,
          metadata: {
            model: response.model,
            tokensUsed: response.usage?.total_tokens,
            promptTokens: response.usage?.input_tokens,
            completionTokens: response.usage?.output_tokens,
          },
          structured,
        };
      }

      // Fall back to regular chat completions API if no schema provided
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
    ) as Promise<GenerateMessageOutput<TStructured>>;
  }

  private async *generateStreamWithBackup<
    TContext = unknown,
    TStructured = AgentStructuredResponse
  >(
    input: GenerateMessageInput<TContext>
  ): AsyncGenerator<GenerateMessageStreamChunk<TStructured>> {
    // Try primary model first
    try {
      yield* this.generateStreamWithModel(this.primaryModel, input);
    } catch (primaryError: unknown) {
      const primaryErrMsg = getErrorMessage(primaryError);
      console.warn(
        `[OPENROUTER] Primary model ${this.primaryModel} failed: ${primaryErrMsg}`
      );

      if (!shouldUseBackupModel(primaryError)) {
        throw primaryError;
      }

      console.log(`[OPENROUTER] Trying backup models for streaming`);

      let lastBackupError: unknown = primaryError;

      for (let i = 0; i < this.backupModels.length; i++) {
        const backupModel = this.backupModels[i];
        console.log(
          `[OPENROUTER] Trying backup model ${i + 1}/${
            this.backupModels.length
          }: ${backupModel}`
        );

        try {
          yield* this.generateStreamWithModel(backupModel, input);
          console.log(`[OPENROUTER] Backup model ${backupModel} succeeded`);
          return;
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

  private async *generateStreamWithModel<
    TContext = unknown,
    TStructured = AgentStructuredResponse
  >(
    model: string,
    input: GenerateMessageInput<TContext>
  ): AsyncGenerator<GenerateMessageStreamChunk<TStructured>> {
    const params = {
      ...this.config,
      model,
      messages: [
        {
          role: "user" as const,
          content: input.prompt,
        },
      ],
      stream: true as const,
    };

    // Override with input parameters if provided
    if (input.parameters?.maxOutputTokens !== undefined) {
      params.max_tokens = input.parameters.maxOutputTokens;
    }

    // Streaming path does not support responses.parse; if schema present,
    // request JSON object and parse at the end.
    if (input.parameters?.jsonSchema) {
      params.response_format = { type: "json_object" };
    }

    const stream = await this.client.chat.completions.create(params);

    let accumulated = "";
    let currentModel = model;
    let finishReason: string | undefined;
    let promptTokens: number | undefined;
    let completionTokens: number | undefined;
    let totalTokens: number | undefined;

    for await (const chunk of stream) {
      currentModel = chunk.model;
      const delta = chunk.choices[0]?.delta?.content || "";

      if (delta) {
        accumulated += delta;
        yield {
          delta,
          accumulated,
          done: false,
        };
      }

      if (chunk.choices[0]?.finish_reason) {
        finishReason = chunk.choices[0].finish_reason;
      }

      // OpenRouter may include usage in the final chunk
      if (chunk.usage) {
        promptTokens = chunk.usage.prompt_tokens;
        completionTokens = chunk.usage.completion_tokens;
        totalTokens = chunk.usage.total_tokens;
      }
    }

    // Parse JSON response if schema was provided
    let structured: TStructured | undefined;
    if (input.parameters?.jsonSchema && accumulated) {
      try {
        structured = JSON.parse(accumulated) as TStructured;
      } catch (error) {
        console.warn(
          "[OPENROUTER] Failed to parse JSON response in stream:",
          error
        );
      }
    }

    // Yield final chunk
    yield {
      delta: "",
      accumulated,
      done: true,
      metadata: {
        model: currentModel,
        finishReason,
        tokensUsed: totalTokens,
        promptTokens,
        completionTokens,
      },
      structured,
    };
  }
}
