/**
 * DeepSeek provider implementation (OpenAI-compatible API)
 * Supports deepseek-chat, deepseek-reasoner with optional thinking/reasoning mode.
 * DeepSeek streams reasoning content via `delta.reasoning_content` when thinking is enabled.
 */

import OpenAI from "openai";
import type { ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions";
import { FunctionParameters } from "openai/resources/shared.mjs";

import type {
  AiProvider,
  GenerateMessageInput,
  GenerateMessageOutput,
  GenerateMessageStreamChunk,
  AgentStructuredResponse,
  StructuredSchema,
} from "../types";
import type { HistoryItem } from "../types/history";
import { withTimeoutAndRetry, logger } from "../utils";

const DEFAULT_RETRY_CONFIG = {
  timeout: 60000,
  retries: 3,
};

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
 * DeepSeek provider implementation using the OpenAI-compatible API.
 * Supports deepseek-chat and deepseek-reasoner with optional thinking mode.
 *
 * DeepSeek streams reasoning content via `delta.reasoning_content` when
 * thinking mode is enabled. Tool calls follow the standard OpenAI format.
 */
export class DeepSeekProvider implements AiProvider {
  public readonly name = "deepseek";
  private client: OpenAI;
  private primaryModel: string;
  private backupModels: string[];
  private config?: Partial<
    Omit<ChatCompletionCreateParamsNonStreaming, "model" | "messages">
  >;
  private retryConfig: { timeout: number; retries: number };

  constructor(options: DeepSeekProviderOptions) {
    const {
      apiKey,
      model,
      backupModels = [],
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

    this.client = new OpenAI({
      apiKey,
      baseURL,
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
   * Build OpenAI-formatted messages from HistoryItem[] array.
   * DeepSeek uses OpenAI-compatible message format.
   */
  private buildMessages(history: HistoryItem[]): Array<unknown> {
    const messages: Array<unknown> = [];

    for (const item of history) {
      switch (item.role) {
        case "system":
          messages.push({ role: "system", content: item.content });
          break;
        case "user":
          messages.push({ role: "user", content: item.content });
          break;
        case "assistant":
          if (item.tool_calls && item.tool_calls.length > 0) {
            messages.push({
              role: "assistant",
              content: item.content || null,
              tool_calls: item.tool_calls.map((tc) => ({
                id: tc.id,
                type: "function",
                function: {
                  name: tc.name,
                  arguments: JSON.stringify(tc.arguments),
                },
              })),
            });
          } else {
            messages.push({ role: "assistant", content: item.content || "" });
          }
          break;
        case "tool":
          messages.push({
            role: "tool",
            tool_call_id: item.tool_call_id,
            content:
              typeof item.content === "string"
                ? item.content
                : JSON.stringify(item.content),
          });
          break;
      }
    }

    return messages;
  }

  /**
   * Adapt common schema format to DeepSeek's format.
   * DeepSeek is OpenAI-compatible and uses standard JSON Schema.
   */
  private adaptSchema(schema: StructuredSchema): Record<string, unknown> {
    return schema as Record<string, unknown>;
  }

  async generateMessage<
    TContext = unknown,
    TStructured = AgentStructuredResponse,
  >(
    input: GenerateMessageInput<TContext>
  ): Promise<GenerateMessageOutput<TStructured>> {
    return this.generateWithBackup<TContext, TStructured>(input);
  }

  async *generateMessageStream<
    TContext = unknown,
    TStructured = AgentStructuredResponse,
  >(
    input: GenerateMessageInput<TContext>
  ): AsyncGenerator<GenerateMessageStreamChunk<TStructured>> {
    yield* this.generateStreamWithBackup<TContext, TStructured>(input);
  }

  private async generateWithBackup<
    TContext = unknown,
    TStructured = AgentStructuredResponse,
  >(
    input: GenerateMessageInput<TContext>
  ): Promise<GenerateMessageOutput<TStructured>> {
    try {
      return await this.generateWithModel<TContext, TStructured>(
        this.primaryModel,
        input
      );
    } catch (primaryError: unknown) {
      const primaryErrMsg = getErrorMessage(primaryError);
      logger.warn(
        `[DEEPSEEK] Primary model ${this.primaryModel} failed: ${primaryErrMsg}`
      );

      if (!shouldUseBackupModel(primaryError)) {
        throw primaryError;
      }

      logger.debug(`[DEEPSEEK] Trying backup models`);

      let lastBackupError: unknown = primaryError;

      for (let i = 0; i < this.backupModels.length; i++) {
        const backupModel = this.backupModels[i];
        logger.debug(
          `[DEEPSEEK] Trying backup model ${i + 1}/${this.backupModels.length}: ${backupModel}`
        );

        try {
          const result = await this.generateWithModel(backupModel, input);
          logger.debug(`[DEEPSEEK] Backup model ${backupModel} succeeded`);
          return result as GenerateMessageOutput<TStructured>;
        } catch (backupError: unknown) {
          const backupErrMsg = getErrorMessage(backupError);
          logger.warn(
            `[DEEPSEEK] Backup model ${backupModel} failed: ${backupErrMsg}`
          );
          lastBackupError = backupError;

          if (
            !shouldUseBackupModel(backupError) &&
            i < this.backupModels.length - 1
          ) {
            logger.debug(
              `[DEEPSEEK] Backup model error doesn't qualify for further attempts`
            );
            break;
          }
        }
      }

      const lastBackupErrMsg = getErrorMessage(lastBackupError);
      logger.error(
        `[DEEPSEEK] All models failed. Primary: ${primaryErrMsg}, Last backup: ${lastBackupErrMsg}`
      );
      throw lastBackupError;
    }
  }

  private async generateWithModel<
    TContext = unknown,
    TStructured = AgentStructuredResponse,
  >(
    model: string,
    input: GenerateMessageInput<TContext>
  ): Promise<GenerateMessageOutput<TStructured>> {
    const operation = async (): Promise<GenerateMessageOutput> => {
      const historyMessages = this.buildMessages(input.history);
      historyMessages.push({ role: "user", content: input.prompt });

      const params: ChatCompletionCreateParamsNonStreaming = {
        model,
        messages:
          historyMessages as ChatCompletionCreateParamsNonStreaming["messages"],
        ...this.config,
      };

      // Override with input parameters if provided
      if (input.parameters?.maxOutputTokens !== undefined) {
        params.max_tokens = input.parameters.maxOutputTokens;
      }

      // Add tools if provided
      if (input.tools && input.tools.length > 0) {
        params.tools = input.tools.map((tool) => ({
          type: "function" as const,
          function: {
            name: tool.name || tool.id,
            description: tool.description,
            parameters: tool.parameters as FunctionParameters,
          },
        }));
        params.tool_choice = "auto";
      }

      // Use structured output if JSON schema is provided
      if (input.parameters?.jsonSchema) {
        params.response_format = {
          type: "json_schema" as const,
          json_schema: {
            name: input.parameters.schemaName || "structured_output",
            schema: this.adaptSchema(input.parameters.jsonSchema),
          },
        } as ChatCompletionCreateParamsNonStreaming["response_format"];
      }

      const response = await this.client.chat.completions.create(params);

      const message = response.choices[0]?.message?.content || "";

      let toolCalls: Array<{
        toolName: string;
        arguments: Record<string, unknown>;
      }> = [];
      if (response.choices?.[0]?.message?.tool_calls) {
        toolCalls = response.choices[0].message.tool_calls
          .filter((toolCall) => toolCall.type === "function")
          .map((toolCall) => {
            let toolCallArguments: Record<string, unknown> = {};
            try {
              toolCallArguments = JSON.parse(
                toolCall.function.arguments
              ) as Record<string, unknown>;
            } catch (error) {
              logger.warn(
                `[DEEPSEEK] Failed to parse tool call arguments: ${getErrorMessage(error)}`
              );
              toolCallArguments = {};
            }
            return {
              toolName: toolCall.function.name,
              arguments: toolCallArguments,
            };
          });
      }

      // Only throw error if we have no text AND no function calls
      if (!message && toolCalls.length === 0) {
        throw new Error("No response from DeepSeek");
      }

      // Parse structured output if schema was provided
      let structured: AgentStructuredResponse | undefined;
      if (input.parameters?.jsonSchema && message) {
        try {
          structured = JSON.parse(message) as AgentStructuredResponse;
        } catch (error) {
          logger.warn("[DEEPSEEK] Failed to parse JSON response:", error);
        }
      }

      // If tools were used, include them in structured response
      if (toolCalls.length > 0) {
        structured = {
          ...(structured || {}),
          message: structured?.message || message,
          toolCalls,
        } as AgentStructuredResponse;
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
        structured,
      };
    };

    return withTimeoutAndRetry(
      operation,
      this.retryConfig.timeout,
      this.retryConfig.retries,
      `DeepSeek ${model}`
    ) as Promise<GenerateMessageOutput<TStructured>>;
  }

  private async *generateStreamWithBackup<
    TContext = unknown,
    TStructured = AgentStructuredResponse,
  >(
    input: GenerateMessageInput<TContext>
  ): AsyncGenerator<GenerateMessageStreamChunk<TStructured>> {
    try {
      yield* this.generateStreamWithModel<TContext, TStructured>(
        this.primaryModel,
        input
      );
    } catch (primaryError: unknown) {
      const primaryErrMsg = getErrorMessage(primaryError);
      logger.warn(
        `[DEEPSEEK] Primary model ${this.primaryModel} failed: ${primaryErrMsg}`
      );

      if (!shouldUseBackupModel(primaryError)) {
        throw primaryError;
      }

      logger.debug(`[DEEPSEEK] Trying backup models for streaming`);

      let lastBackupError: unknown = primaryError;

      for (let i = 0; i < this.backupModels.length; i++) {
        const backupModel = this.backupModels[i];
        logger.debug(
          `[DEEPSEEK] Trying backup model ${i + 1}/${this.backupModels.length}: ${backupModel}`
        );

        try {
          yield* this.generateStreamWithModel<TContext, TStructured>(
            backupModel,
            input
          );
          logger.debug(`[DEEPSEEK] Backup model ${backupModel} succeeded`);
          return;
        } catch (backupError: unknown) {
          const backupErrMsg = getErrorMessage(backupError);
          logger.warn(
            `[DEEPSEEK] Backup model ${backupModel} failed: ${backupErrMsg}`
          );
          lastBackupError = backupError;

          if (
            !shouldUseBackupModel(backupError) &&
            i < this.backupModels.length - 1
          ) {
            logger.debug(
              `[DEEPSEEK] Backup model error doesn't qualify for further attempts`
            );
            break;
          }
        }
      }

      const lastBackupErrMsg = getErrorMessage(lastBackupError);
      logger.error(
        `[DEEPSEEK] All models failed. Primary: ${primaryErrMsg}, Last backup: ${lastBackupErrMsg}`
      );
      throw lastBackupError;
    }
  }

  private async *generateStreamWithModel<
    TContext = unknown,
    TStructured = AgentStructuredResponse,
  >(
    model: string,
    input: GenerateMessageInput<TContext>
  ): AsyncGenerator<GenerateMessageStreamChunk<TStructured>> {
    const historyMessages = this.buildMessages(input.history);
    historyMessages.push({ role: "user" as const, content: input.prompt });

    const params = {
      ...this.config,
      model,
      messages:
        historyMessages as ChatCompletionCreateParamsNonStreaming["messages"],
      stream: true as const,
      stream_options: { include_usage: true },
    };

    // Override with input parameters if provided
    if (input.parameters?.maxOutputTokens !== undefined) {
      params.max_tokens = input.parameters.maxOutputTokens;
    }

    // Add tools if provided
    if (input.tools && input.tools.length > 0) {
      params.tools = input.tools.map((tool) => ({
        type: "function" as const,
        function: {
          name: tool.name || tool.id,
          description: tool.description,
          parameters: tool.parameters as FunctionParameters,
        },
      }));
      params.tool_choice = "auto";
    }

    // Request JSON schema output if schema is provided
    if (input.parameters?.jsonSchema) {
      params.response_format = {
        type: "json_schema" as const,
        json_schema: {
          name: input.parameters.schemaName || "structured_output",
          schema: this.adaptSchema(input.parameters.jsonSchema),
        },
      } as ChatCompletionCreateParamsNonStreaming["response_format"];
    }

    const stream = await this.client.chat.completions.create(params);

    let accumulated = "";
    let currentModel = model;
    let finishReason: string | undefined;
    let promptTokens: number | undefined;
    let completionTokens: number | undefined;
    let totalTokens: number | undefined;
    const toolCalls: Array<{
      toolName: string;
      arguments: Record<string, unknown>;
    }> = [];

    for await (const chunk of stream) {
      currentModel = chunk.model;
      const choice = chunk.choices?.[0];

      // DeepSeek may include usage in chunks with include_usage
      if (chunk.usage) {
        promptTokens = chunk.usage.prompt_tokens;
        completionTokens = chunk.usage.completion_tokens;
        totalTokens = chunk.usage.total_tokens;
      }

      if (!choice) continue;

      const delta = choice.delta as Record<string, unknown>;

      // Extract tool calls from delta
      const deltaToolCalls = delta?.tool_calls as
        | Array<{
            index: number;
            id?: string;
            function?: { name?: string; arguments?: string };
          }>
        | undefined;

      if (deltaToolCalls) {
        for (const toolCall of deltaToolCalls) {
          if (toolCall.function) {
            let toolCallArguments: Record<string, unknown> = {};
            try {
              toolCallArguments = toolCall.function.arguments
                ? (JSON.parse(toolCall.function.arguments) as Record<
                    string,
                    unknown
                  >)
                : {};
            } catch (error) {
              logger.warn(
                `[DEEPSEEK] Failed to parse tool call arguments in stream: ${getErrorMessage(error)}`
              );
              toolCallArguments = {};
            }
            toolCalls.push({
              toolName: toolCall.function.name || "",
              arguments: toolCallArguments,
            });
          }
        }
      }

      // DeepSeek streams reasoning via `reasoning_content` on the delta
      const reasoning =
        (delta?.reasoning_content as string | undefined) ?? undefined;
      if (reasoning) {
        logger.debug(`[DEEPSEEK] Reasoning: ${reasoning}`);
      }

      const content = (delta?.content as string | undefined) ?? "";
      if (content) {
        accumulated += content;
        yield {
          delta: content,
          accumulated,
          done: false,
        };
      }

      if (choice.finish_reason) {
        finishReason = choice.finish_reason;
      }
    }

    // Parse JSON response if schema was provided
    let structured: TStructured | undefined;
    if (input.parameters?.jsonSchema && accumulated) {
      try {
        structured = JSON.parse(accumulated) as TStructured;
      } catch (error) {
        logger.warn(
          "[DEEPSEEK] Failed to parse JSON response in stream:",
          error
        );
      }
    }

    // Include tool calls in structured response
    if (toolCalls.length > 0) {
      structured = {
        ...(structured || {}),
        message:
          (structured as AgentStructuredResponse | undefined)?.message ||
          accumulated,
        toolCalls,
      } as TStructured;
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
