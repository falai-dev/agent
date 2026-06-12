/**
 * Shared base class for OpenAI-compatible chat-completions providers
 * (OpenAI, DeepSeek, OpenRouter).
 *
 * Handles message/history building, tool-call parsing, streaming chunk
 * handling, backup-model fallback, retry wiring, schema passthrough and
 * normalized error wrapping. Subclasses supply the configured client,
 * naming, capabilities and any genuinely provider-specific behavior via
 * the protected hooks.
 */

import OpenAI from "openai";
import type {
  ChatCompletionChunk,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
} from "openai/resources/chat/completions";
import { FunctionParameters } from "openai/resources/shared.mjs";

import type {
  AiProvider,
  GenerateMessageInput,
  GenerateMessageOutput,
  GenerateMessageStreamChunk,
  AgentStructuredResponse,
  StructuredSchema,
} from "../types";
import type { ProviderCapabilities } from "../types/ai";
import type { HistoryItem } from "../types/history";
import { withTimeoutAndRetry, logger } from "../utils";
import {
  classifyProviderError,
  getErrorMessage,
  isBackupEligible,
  toProviderError,
  type ErrorClassificationOptions,
} from "./errorClassification";

const DEFAULT_RETRY_CONFIG = {
  timeout: 60000,
  retries: 3,
};

/**
 * Default request parameters shared by OpenAI-compatible providers
 */
export type OpenAICompatibleRequestConfig = Partial<
  Omit<ChatCompletionCreateParamsNonStreaming, "model" | "messages">
>;

/**
 * Initialization values supplied by subclasses
 */
export interface OpenAICompatibleProviderInit {
  /** Configured OpenAI SDK client (subclass sets API key, base URL, headers) */
  client: OpenAI;
  /** Primary model */
  model: string;
  /** Backup models to try if primary fails (default: []) */
  backupModels?: string[];
  /** Default request parameters */
  config?: OpenAICompatibleRequestConfig;
  /** Retry configuration */
  retryConfig?: {
    timeout?: number;
    retries?: number;
  };
}

/**
 * Base implementation of AiProvider for OpenAI-compatible APIs with
 * backup models and retry logic.
 */
export abstract class OpenAICompatibleProvider implements AiProvider {
  public abstract readonly name: string;
  public abstract readonly capabilities: ProviderCapabilities;

  /** Uppercase tag used in log lines, e.g. "OPENAI" */
  protected abstract readonly logLabel: string;
  /** Human-readable name used in retry/error messages, e.g. "OpenAI" */
  protected abstract readonly displayName: string;

  protected readonly client: OpenAI;
  protected readonly primaryModel: string;
  protected readonly backupModels: string[];
  protected readonly config?: OpenAICompatibleRequestConfig;
  protected readonly retryConfig: { timeout: number; retries: number };

  /**
   * Provider-specific error classification signals.
   * model_not_found/model_overloaded historically triggered backup models.
   */
  protected readonly classificationOptions: ErrorClassificationOptions = {
    overloadedCodes: ["model_not_found", "model_overloaded"],
  };

  protected constructor(init: OpenAICompatibleProviderInit) {
    this.client = init.client;
    this.primaryModel = init.model;
    this.backupModels = init.backupModels ?? [];
    this.config = init.config;
    this.retryConfig = {
      timeout: init.retryConfig?.timeout || DEFAULT_RETRY_CONFIG.timeout,
      retries: init.retryConfig?.retries || DEFAULT_RETRY_CONFIG.retries,
    };
  }

  // ---------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------

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

  // ---------------------------------------------------------------------
  // Provider-specific hooks
  // ---------------------------------------------------------------------

  /**
   * Generate a structured (JSON schema) response. Default uses the
   * responses.parse API (OpenAI, OpenRouter). Subclasses whose API lacks
   * responses.parse (e.g. DeepSeek) override this to use chat completions
   * with a structured response_format instead.
   */
  protected async executeStructuredGenerate(
    model: string,
    input: GenerateMessageInput<unknown>,
    jsonSchema: StructuredSchema
  ): Promise<GenerateMessageOutput> {
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
          name: input.parameters?.schemaName || "structured_output",
          // Adapt common schema format to the provider's format
          schema: this.adaptSchema(jsonSchema),
        },
      },
    });

    if (!response.output_parsed) {
      throw new Error(`No parsed output returned from ${this.displayName}`);
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

  /**
   * response_format applied to chat-completions requests when a JSON
   * schema is present. Default requests a generic JSON object (parsed at
   * the end); subclasses with native json_schema support in chat
   * completions (e.g. DeepSeek) override this.
   */
  protected structuredResponseFormat(
    _jsonSchema: StructuredSchema,
    _schemaName: string | undefined
  ): ChatCompletionCreateParamsNonStreaming["response_format"] {
    return { type: "json_object" };
  }

  /**
   * Hook for provider-specific streaming request parameters
   * (e.g. DeepSeek's stream_options.include_usage).
   */
  protected configureStreamParams(
    _params: ChatCompletionCreateParamsStreaming
  ): void {
    // Default: no extra parameters
  }

  /**
   * Hook for provider-specific stream delta handling
   * (e.g. DeepSeek's reasoning_content).
   */
  protected onStreamDelta(_delta: ChatCompletionChunk.Choice.Delta): void {
    // Default: no extra handling
  }

  // ---------------------------------------------------------------------
  // Shared building blocks
  // ---------------------------------------------------------------------

  /**
   * Adapt common schema format to the provider's format.
   * OpenAI-compatible APIs use standard JSON Schema, so this is a
   * passthrough.
   */
  protected adaptSchema(schema: StructuredSchema): Record<string, unknown> {
    // Our StructuredSchema is already JSON Schema compatible
    return schema;
  }

  /**
   * Build OpenAI-formatted messages from HistoryItem[] array.
   * Maps directly to ChatCompletionMessageParam format.
   */
  protected buildChatMessages(history: HistoryItem[]): Array<unknown> {
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
   * Map framework tool definitions to OpenAI function tools.
   */
  private buildToolParams(
    tools: NonNullable<GenerateMessageInput<unknown>["tools"]>
  ): ChatCompletionCreateParamsNonStreaming["tools"] {
    return tools.map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name || tool.id,
        description: tool.description,
        parameters: tool.parameters as FunctionParameters, // JSON schema
      },
    }));
  }

  /**
   * Parse tool calls from a (complete or delta) tool_calls array,
   * tolerating malformed JSON arguments.
   */
  private parseToolCallArguments(
    rawArguments: string | undefined,
    streaming: boolean
  ): Record<string, unknown> {
    if (!rawArguments) {
      return {};
    }
    try {
      return JSON.parse(rawArguments) as Record<string, unknown>;
    } catch (error) {
      logger.warn(
        `[${this.logLabel}] Failed to parse tool call arguments${
          streaming ? " in stream" : ""
        }: ${getErrorMessage(error)}`
      );
      return {};
    }
  }

  /**
   * Determines if an error should trigger backup model usage.
   * Derived from the normalized error classification.
   */
  protected shouldUseBackupModel(error: unknown): boolean {
    return isBackupEligible(
      classifyProviderError(error, this.classificationOptions)
    );
  }

  /**
   * Wrap a terminal failure in a normalized ProviderError.
   */
  protected wrapTerminalError(error: unknown): Error {
    return toProviderError(error, this.name, this.classificationOptions);
  }

  // ---------------------------------------------------------------------
  // Generation with backup models
  // ---------------------------------------------------------------------

  private async generateWithBackup<
    TContext = unknown,
    TStructured = AgentStructuredResponse
  >(
    input: GenerateMessageInput<TContext>
  ): Promise<GenerateMessageOutput<TStructured>> {
    // Try primary model first
    try {
      return await this.generateWithModel<TContext, TStructured>(
        this.primaryModel,
        input
      );
    } catch (primaryError: unknown) {
      const primaryErrMsg = getErrorMessage(primaryError);
      logger.warn(
        `[${this.logLabel}] Primary model ${this.primaryModel} failed: ${primaryErrMsg}`
      );

      if (!this.shouldUseBackupModel(primaryError)) {
        throw this.wrapTerminalError(primaryError);
      }

      logger.debug(`[${this.logLabel}] Trying backup models`);

      let lastBackupError: unknown = primaryError;

      for (let i = 0; i < this.backupModels.length; i++) {
        const backupModel = this.backupModels[i];
        logger.debug(
          `[${this.logLabel}] Trying backup model ${i + 1}/${
            this.backupModels.length
          }: ${backupModel}`
        );

        try {
          const result = await this.generateWithModel<TContext, TStructured>(
            backupModel,
            input
          );
          logger.debug(`[${this.logLabel}] Backup model ${backupModel} succeeded`);
          return result;
        } catch (backupError: unknown) {
          const backupErrMsg = getErrorMessage(backupError);
          logger.warn(
            `[${this.logLabel}] Backup model ${backupModel} failed: ${backupErrMsg}`
          );
          lastBackupError = backupError;

          if (
            !this.shouldUseBackupModel(backupError) &&
            i < this.backupModels.length - 1
          ) {
            logger.debug(
              `[${this.logLabel}] Backup model error doesn't qualify for further attempts`
            );
            break;
          }
        }
      }

      const lastBackupErrMsg = getErrorMessage(lastBackupError);
      logger.error(
        `[${this.logLabel}] All models failed. Primary: ${primaryErrMsg}, Last backup: ${lastBackupErrMsg}`
      );
      throw this.wrapTerminalError(lastBackupError);
    }
  }

  private async *generateStreamWithBackup<
    TContext = unknown,
    TStructured = AgentStructuredResponse
  >(
    input: GenerateMessageInput<TContext>
  ): AsyncGenerator<GenerateMessageStreamChunk<TStructured>> {
    // Try primary model first
    try {
      yield* this.generateStreamWithModel<TContext, TStructured>(
        this.primaryModel,
        input
      );
    } catch (primaryError: unknown) {
      const primaryErrMsg = getErrorMessage(primaryError);
      logger.warn(
        `[${this.logLabel}] Primary model ${this.primaryModel} failed: ${primaryErrMsg}`
      );

      if (!this.shouldUseBackupModel(primaryError)) {
        throw this.wrapTerminalError(primaryError);
      }

      logger.debug(`[${this.logLabel}] Trying backup models for streaming`);

      let lastBackupError: unknown = primaryError;

      for (let i = 0; i < this.backupModels.length; i++) {
        const backupModel = this.backupModels[i];
        logger.debug(
          `[${this.logLabel}] Trying backup model ${i + 1}/${
            this.backupModels.length
          }: ${backupModel}`
        );

        try {
          yield* this.generateStreamWithModel<TContext, TStructured>(
            backupModel,
            input
          );
          logger.debug(`[${this.logLabel}] Backup model ${backupModel} succeeded`);
          return;
        } catch (backupError: unknown) {
          const backupErrMsg = getErrorMessage(backupError);
          logger.warn(
            `[${this.logLabel}] Backup model ${backupModel} failed: ${backupErrMsg}`
          );
          lastBackupError = backupError;

          if (
            !this.shouldUseBackupModel(backupError) &&
            i < this.backupModels.length - 1
          ) {
            logger.debug(
              `[${this.logLabel}] Backup model error doesn't qualify for further attempts`
            );
            break;
          }
        }
      }

      const lastBackupErrMsg = getErrorMessage(lastBackupError);
      logger.error(
        `[${this.logLabel}] All models failed. Primary: ${primaryErrMsg}, Last backup: ${lastBackupErrMsg}`
      );
      throw this.wrapTerminalError(lastBackupError);
    }
  }

  // ---------------------------------------------------------------------
  // Non-streaming generation
  // ---------------------------------------------------------------------

  private async generateWithModel<
    TContext = unknown,
    TStructured = AgentStructuredResponse
  >(
    model: string,
    input: GenerateMessageInput<TContext>
  ): Promise<GenerateMessageOutput<TStructured>> {
    const operation = async (): Promise<GenerateMessageOutput> => {
      // Use structured output path if JSON schema is provided
      if (input.parameters?.jsonSchema) {
        return this.executeStructuredGenerate(
          model,
          input,
          input.parameters.jsonSchema
        );
      }
      return this.executeChatCompletion(model, input);
    };

    return withTimeoutAndRetry(
      operation,
      this.retryConfig.timeout,
      this.retryConfig.retries,
      `${this.displayName} ${model}`
    ) as Promise<GenerateMessageOutput<TStructured>>;
  }

  /**
   * Non-streaming chat-completions request: builds messages/tools,
   * extracts text and tool calls, and merges structured output.
   */
  protected async executeChatCompletion(
    model: string,
    input: GenerateMessageInput<unknown>
  ): Promise<GenerateMessageOutput> {
    const historyMessages = this.buildChatMessages(input.history);
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
      params.tools = this.buildToolParams(input.tools);
      params.tool_choice = "auto";
    }

    // Use structured output format if JSON schema is provided
    if (input.parameters?.jsonSchema) {
      params.response_format = this.structuredResponseFormat(
        input.parameters.jsonSchema,
        input.parameters.schemaName
      );
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
        .map((toolCall) => ({
          toolName: toolCall.function.name,
          arguments: this.parseToolCallArguments(
            toolCall.function.arguments,
            false
          ),
        }));
    }

    // Only throw error if we have no text AND no function calls
    if (!message && toolCalls.length === 0) {
      throw new Error(`No response from ${this.displayName}`);
    }

    // Parse structured output if schema was provided
    let structured: AgentStructuredResponse | undefined;
    if (input.parameters?.jsonSchema && message) {
      try {
        structured = JSON.parse(message) as AgentStructuredResponse;
      } catch (error) {
        logger.warn(`[${this.logLabel}] Failed to parse JSON response:`, error);
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
  }

  // ---------------------------------------------------------------------
  // Streaming generation
  // ---------------------------------------------------------------------

  private async *generateStreamWithModel<
    TContext = unknown,
    TStructured = AgentStructuredResponse
  >(
    model: string,
    input: GenerateMessageInput<TContext>
  ): AsyncGenerator<GenerateMessageStreamChunk<TStructured>> {
    // Build messages from history and append prompt as final user message
    const historyMessages = this.buildChatMessages(input.history);
    historyMessages.push({ role: "user" as const, content: input.prompt });

    const params: ChatCompletionCreateParamsStreaming = {
      ...this.config,
      model,
      messages:
        historyMessages as ChatCompletionCreateParamsNonStreaming["messages"],
      stream: true as const,
    };
    this.configureStreamParams(params);

    // Override with input parameters if provided
    if (input.parameters?.maxOutputTokens !== undefined) {
      params.max_tokens = input.parameters.maxOutputTokens;
    }

    // Add tools if provided
    if (input.tools && input.tools.length > 0) {
      params.tools = this.buildToolParams(input.tools);
      params.tool_choice = "auto";
    }

    // Streaming path does not support responses.parse; if schema present,
    // request structured output and parse at the end.
    if (input.parameters?.jsonSchema) {
      params.response_format = this.structuredResponseFormat(
        input.parameters.jsonSchema,
        input.parameters.schemaName
      );
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

      // Some providers include usage in (possibly choice-less) chunks
      if (chunk.usage) {
        promptTokens = chunk.usage.prompt_tokens;
        completionTokens = chunk.usage.completion_tokens;
        totalTokens = chunk.usage.total_tokens;
      }

      const choice = chunk.choices?.[0];
      if (!choice) continue;

      // Extract tool calls from delta
      if (choice.delta?.tool_calls) {
        for (const toolCall of choice.delta.tool_calls) {
          if (toolCall.function) {
            toolCalls.push({
              toolName: toolCall.function.name || "",
              arguments: this.parseToolCallArguments(
                toolCall.function.arguments,
                true
              ),
            });
          }
        }
      }

      // Provider-specific delta handling (e.g. DeepSeek reasoning_content)
      this.onStreamDelta(choice.delta);

      const delta = choice.delta?.content || "";
      if (delta) {
        accumulated += delta;
        yield {
          delta,
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
          `[${this.logLabel}] Failed to parse JSON response in stream:`,
          error
        );
      }
    }

    // Include tool calls in structured response (even without JSON schema)
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
