/**
 * OpenAI provider implementation with retry and backup models
 */

import OpenAI from "openai";
import type { ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions";

import type {
  AiProvider,
  GenerateMessageInput,
  GenerateMessageOutput,
  GenerateMessageStreamChunk,
  AgentStructuredResponse,
} from "../types/ai";
import { withTimeoutAndRetry } from "../utils/retry";

const DEFAULT_RETRY_CONFIG = {
  timeout: 60000,
  retries: 3,
};

/**
 * Configuration options for OpenAI provider
 * Uses types from openai package
 */
export interface OpenAIProviderOptions {
  /** OpenAI API key */
  apiKey: string;
  /** Organization ID (optional) */
  organization?: string;
  /** Model to use (required) - e.g., "gpt-5", "gpt-5-mini" */
  model: string;
  /** Backup models to try if primary fails (default: []) */
  backupModels?: string[];
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

  // Model overloaded or unavailable
  if (error.code === "model_not_found" || error.code === "model_overloaded") {
    return true;
  }

  const message = getErrorMessage(error);
  if (
    message.includes("overloaded") ||
    message.includes("unavailable") ||
    message.includes("internal error") ||
    message.includes("Internal error")
  ) {
    return true;
  }

  return false;
};

/**
 * OpenAI provider implementation with backup models and retry logic
 */
export class OpenAIProvider implements AiProvider {
  public readonly name = "openai";
  private client: OpenAI;
  private primaryModel: string;
  private backupModels: string[];
  private config?: Partial<
    Omit<ChatCompletionCreateParamsNonStreaming, "model" | "messages">
  >;
  private retryConfig: { timeout: number; retries: number };

  constructor(options: OpenAIProviderOptions) {
    const {
      apiKey,
      organization,
      model,
      backupModels = [],
      config,
      retryConfig,
    } = options;

    if (!apiKey) {
      throw new Error("OpenAI API key is required");
    }

    if (!model) {
      throw new Error("Model is required. Example: 'gpt-5' or 'gpt-5-mini'");
    }

    // Dynamic import to avoid bundling issues

    this.client = new OpenAI({
      apiKey,
      organization,
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

  async *generateMessageStream<TContext = unknown>(
    input: GenerateMessageInput<TContext>
  ): AsyncGenerator<GenerateMessageStreamChunk> {
    yield* this.generateStreamWithBackup(input);
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
        `[OPENAI] Primary model ${this.primaryModel} failed: ${primaryErrMsg}`
      );

      if (!shouldUseBackupModel(primaryError)) {
        throw primaryError;
      }

      console.log(`[OPENAI] Trying backup models`);

      let lastBackupError: unknown = primaryError;

      for (let i = 0; i < this.backupModels.length; i++) {
        const backupModel = this.backupModels[i];
        console.log(
          `[OPENAI] Trying backup model ${i + 1}/${
            this.backupModels.length
          }: ${backupModel}`
        );

        try {
          const result = await this.generateWithModel(backupModel, input);
          console.log(`[OPENAI] Backup model ${backupModel} succeeded`);
          return result;
        } catch (backupError: unknown) {
          const backupErrMsg = getErrorMessage(backupError);
          console.warn(
            `[OPENAI] Backup model ${backupModel} failed: ${backupErrMsg}`
          );
          lastBackupError = backupError;

          if (
            !shouldUseBackupModel(backupError) &&
            i < this.backupModels.length - 1
          ) {
            console.log(
              `[OPENAI] Backup model error doesn't qualify for further attempts`
            );
            break;
          }
        }
      }

      const lastBackupErrMsg = getErrorMessage(lastBackupError);
      console.error(
        `[OPENAI] All models failed. Primary: ${primaryErrMsg}, Last backup: ${lastBackupErrMsg}`
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

      // Use structured output API if JSON mode is enabled
      if (input.parameters?.jsonMode) {
        // Define the JSON schema for agent response
        const agentResponseSchema = {
          type: "object",
          properties: {
            message: {
              type: "string",
              description: "The actual message to send to the user",
            },
            route: {
              type: ["string", "null"],
              description:
                "The title of the route chosen (or null if no specific route)",
            },
            state: {
              type: ["string", "null"],
              description:
                "The current state within the route (or null if not in a route)",
            },
            toolCalls: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  toolName: {
                    type: "string",
                    description: "Name of the tool to call",
                  },
                  arguments: {
                    type: "object",
                    description: "Arguments to pass to the tool",
                  },
                },
                required: ["toolName", "arguments"],
              },
              description: "Tool calls the agent wants to execute",
            },
            reasoning: {
              type: "string",
              description: "Optional: Internal reasoning for this response",
            },
          },
          required: ["message"],
          additionalProperties: false,
        };

        const response = await this.client.responses.parse({
          model,
          instructions: input.prompt,
          input: "",
          reasoning: {
            effort: input.parameters?.reasoning?.effort || "low",
          },
          text: {
            format: {
              type: "json_schema",
              name: "agentResponseSchema",
              schema: agentResponseSchema,
            },
          },
        });

        if (!response.output_parsed) {
          throw new Error("No parsed output returned from OpenAI");
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

      // Fall back to regular chat completions API if JSON mode not enabled
      const response = await this.client.chat.completions.create(params);

      const message = response.choices[0]?.message?.content;
      if (!message) {
        throw new Error("No response from OpenAI");
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
      `OpenAI ${model}`
    );
  }

  private async *generateStreamWithBackup<TContext = unknown>(
    input: GenerateMessageInput<TContext>
  ): AsyncGenerator<GenerateMessageStreamChunk> {
    // Try primary model first
    try {
      yield* this.generateStreamWithModel(this.primaryModel, input);
    } catch (primaryError: unknown) {
      const primaryErrMsg = getErrorMessage(primaryError);
      console.warn(
        `[OPENAI] Primary model ${this.primaryModel} failed: ${primaryErrMsg}`
      );

      if (!shouldUseBackupModel(primaryError)) {
        throw primaryError;
      }

      console.log(`[OPENAI] Trying backup models for streaming`);

      let lastBackupError: unknown = primaryError;

      for (let i = 0; i < this.backupModels.length; i++) {
        const backupModel = this.backupModels[i];
        console.log(
          `[OPENAI] Trying backup model ${i + 1}/${
            this.backupModels.length
          }: ${backupModel}`
        );

        try {
          yield* this.generateStreamWithModel(backupModel, input);
          console.log(`[OPENAI] Backup model ${backupModel} succeeded`);
          return;
        } catch (backupError: unknown) {
          const backupErrMsg = getErrorMessage(backupError);
          console.warn(
            `[OPENAI] Backup model ${backupModel} failed: ${backupErrMsg}`
          );
          lastBackupError = backupError;

          if (
            !shouldUseBackupModel(backupError) &&
            i < this.backupModels.length - 1
          ) {
            console.log(
              `[OPENAI] Backup model error doesn't qualify for further attempts`
            );
            break;
          }
        }
      }

      const lastBackupErrMsg = getErrorMessage(lastBackupError);
      console.error(
        `[OPENAI] All models failed. Primary: ${primaryErrMsg}, Last backup: ${lastBackupErrMsg}`
      );
      throw lastBackupError;
    }
  }

  private async *generateStreamWithModel<TContext = unknown>(
    model: string,
    input: GenerateMessageInput<TContext>
  ): AsyncGenerator<GenerateMessageStreamChunk> {
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

    // Use JSON mode if requested
    // Note: OpenAI streaming doesn't support the responses.parse API,
    // so we use response_format with JSON mode instead
    if (input.parameters?.jsonMode) {
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

      // OpenAI includes usage in the final chunk for some models
      if (chunk.usage) {
        promptTokens = chunk.usage.prompt_tokens;
        completionTokens = chunk.usage.completion_tokens;
        totalTokens = chunk.usage.total_tokens;
      }
    }

    // Parse JSON response if JSON mode was enabled
    let structured: AgentStructuredResponse | undefined;
    if (input.parameters?.jsonMode && accumulated) {
      try {
        structured = JSON.parse(accumulated) as AgentStructuredResponse;
      } catch (error) {
        console.warn(
          "[OPENAI] Failed to parse JSON response in stream:",
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
