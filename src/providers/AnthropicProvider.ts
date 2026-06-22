/**
 * Anthropic (Claude) provider implementation with retry and backup models
 */

import Anthropic from "@anthropic-ai/sdk";
import type {
  MessageCreateParamsNonStreaming,
  Tool,
} from "@anthropic-ai/sdk/resources/messages";

import type {
  AiProvider,
  GenerateMessageInput,
  GenerateMessageOutput,
  GenerateMessageStreamChunk,
  AgentStructuredResponse,
} from "../types";
import type { ProviderCapabilities } from "../types/ai";
import type { HistoryItem } from "../types/history";
import { withTimeoutAndRetry, withStreamRetry, logger } from "../utils";
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
 * Configuration options for Anthropic provider
 * Uses types from @anthropic-ai/sdk package
 */
export interface AnthropicProviderOptions {
  /** Anthropic API key */
  apiKey: string;
  /** Model to use (required) - e.g., "claude-sonnet-4-6", "claude-opus-4-7" */
  model: string;
  /** Backup models to try if primary fails (default: []) */
  backupModels?: string[];
  /** Default parameters - uses MessageCreateParamsNonStreaming from @anthropic-ai/sdk */
  config?: Partial<Omit<MessageCreateParamsNonStreaming, "model" | "messages">>;
  /** Retry configuration */
  retryConfig?: {
    timeout?: number;
    retries?: number;
  };
}

/**
 * Anthropic-specific error classification signals (HTTP 529 plus
 * overloaded_error/api_error types and the "overloaded" code).
 */
const CLASSIFICATION_OPTIONS: ErrorClassificationOptions = {
  overloadedStatuses: [529],
  overloadedTypes: ["overloaded_error", "api_error"],
  overloadedCodes: ["overloaded"],
};

/**
 * Determines if an error should trigger backup model usage.
 * Derived from the normalized error classification.
 */
const shouldUseBackupModel = (error: unknown): boolean =>
  isBackupEligible(classifyProviderError(error, CLASSIFICATION_OPTIONS));

/**
 * Anthropic provider implementation with backup models and retry logic
 */
export class AnthropicProvider implements AiProvider {
  public readonly name = "anthropic";
  public readonly capabilities: ProviderCapabilities = {
    supportsTools: true,
    supportsNativeJsonSchema: false, // JSON output is enforced via a prompt instruction, not a native schema mode
    supportsStreaming: true,
    supportsStreamingToolCalls: true,
    supportsPromptCaching: true,
  };
  private client: Anthropic;
  private primaryModel: string;
  private backupModels: string[];
  private config?: Partial<
    Omit<MessageCreateParamsNonStreaming, "model" | "messages">
  >;
  private retryConfig: { timeout: number; retries: number };

  constructor(options: AnthropicProviderOptions) {
    const { apiKey, model, backupModels = [], config, retryConfig } = options;

    if (!apiKey) {
      throw new Error("Anthropic API key is required");
    }

    if (!model) {
      throw new Error("Model is required. Example: 'claude-sonnet-4-6'");
    }

    this.client = new Anthropic({
      apiKey,
    });
    this.primaryModel = model;
    this.backupModels = backupModels;
    this.config = config;
    this.retryConfig = {
      // `||` is intentional: a 0ms timeout is degenerate (aborts every call
      // immediately), so fall back to the default.
      timeout: retryConfig?.timeout || DEFAULT_RETRY_CONFIG.timeout,
      // `??` so an explicit `retries: 0` (disable retries) is honored instead of
      // being clobbered to the default by a falsy-zero check.
      retries: retryConfig?.retries ?? DEFAULT_RETRY_CONFIG.retries,
    };
  }

  /**
   * Build Anthropic-formatted messages from HistoryItem[] array.
   * System messages are extracted separately (Anthropic uses a `system` param).
   * Tool results are mapped to Anthropic's tool_result content blocks.
   * Assistant tool_calls are mapped to tool_use content blocks.
   */
  private buildAnthropicMessages(history: HistoryItem[]): {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    messages: any[];
    systemMessages: string[];
  } {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const messages: any[] = [];
    const systemMessages: string[] = [];

    for (const item of history) {
      switch (item.role) {
        case "system":
          systemMessages.push(item.content);
          break;
        case "user":
          messages.push({ role: "user", content: item.content });
          break;
        case "assistant":
          if (item.tool_calls && item.tool_calls.length > 0) {
            const content: Array<Record<string, unknown>> = [];
            if (item.content) {
              content.push({ type: "text", text: item.content });
            }
            for (const tc of item.tool_calls) {
              content.push({
                type: "tool_use",
                id: tc.id,
                name: tc.name,
                input: tc.arguments,
              });
            }
            messages.push({ role: "assistant", content });
          } else {
            messages.push({ role: "assistant", content: item.content || "" });
          }
          break;
        case "tool":
          // Anthropic tool results are sent as user messages with tool_result content blocks
          messages.push({
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: item.tool_call_id,
                content: typeof item.content === "string" ? item.content : JSON.stringify(item.content),
              },
            ],
          });
          break;
      }
    }

    return { messages, systemMessages };
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
      return await this.generateWithModel<TContext, TStructured>(
        this.primaryModel,
        input
      );
    } catch (primaryError: unknown) {
      const primaryErrMsg = getErrorMessage(primaryError);
      logger.warn(
        `[ANTHROPIC] Primary model ${this.primaryModel} failed: ${primaryErrMsg}`
      );

      if (!shouldUseBackupModel(primaryError)) {
        throw toProviderError(primaryError, this.name, CLASSIFICATION_OPTIONS);
      }

      logger.debug(`[ANTHROPIC] Trying backup models`);

      let lastBackupError: unknown = primaryError;

      for (let i = 0; i < this.backupModels.length; i++) {
        const backupModel = this.backupModels[i];
        logger.debug(
          `[ANTHROPIC] Trying backup model ${i + 1}/${this.backupModels.length
          }: ${backupModel}`
        );

        try {
          const result = await this.generateWithModel<TContext, TStructured>(
            backupModel,
            input
          );
          logger.debug(`[ANTHROPIC] Backup model ${backupModel} succeeded`);
          return result;
        } catch (backupError: unknown) {
          const backupErrMsg = getErrorMessage(backupError);
          logger.warn(
            `[ANTHROPIC] Backup model ${backupModel} failed: ${backupErrMsg}`
          );
          lastBackupError = backupError;

          if (
            !shouldUseBackupModel(backupError) &&
            i < this.backupModels.length - 1
          ) {
            logger.debug(
              `[ANTHROPIC] Backup model error doesn't qualify for further attempts`
            );
            break;
          }
        }
      }

      const lastBackupErrMsg = getErrorMessage(lastBackupError);
      logger.error(
        `[ANTHROPIC] All models failed. Primary: ${primaryErrMsg}, Last backup: ${lastBackupErrMsg}`
      );
      throw toProviderError(lastBackupError, this.name, CLASSIFICATION_OPTIONS);
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
      // Anthropic requires max_tokens to be specified
      const maxTokens = input.parameters?.maxOutputTokens || 4096;

      // Build messages from history
      const { messages: historyMessages, systemMessages } = this.buildAnthropicMessages(input.history);

      // Append the current prompt as the final user message
      historyMessages.push({
        role: "user",
        content: input.prompt,
      });

      const params: MessageCreateParamsNonStreaming = {
        model,
        max_tokens: maxTokens,
        messages: historyMessages,
        ...this.config,
      };

      // Set system messages from history if present
      if (systemMessages.length > 0) {
        if (typeof this.config?.system === "string") {
          params.system = `${this.config.system}\n\n${systemMessages.join("\n\n")}`;
        } else if (Array.isArray(this.config?.system)) {
          params.system = [
            ...this.config.system,
            ...systemMessages.map(s => ({ type: "text" as const, text: s })),
          ];
        } else {
          params.system = systemMessages.join("\n\n");
        }
      }

      // Add tools if provided
      if (input.tools && input.tools.length > 0) {
        params.tools = input.tools.map((tool) => ({
          name: tool.name || tool.id,
          description: tool.description || "",
          input_schema: tool.parameters as Tool["input_schema"], // JSON schema
        }));
      }

      // Handle schema: Anthropic doesn't have a native schema mode, so embed constraints
      if (input.parameters?.jsonSchema) {
        const systemPrompt =
          "You must respond with valid JSON only and it MUST match the provided schema.";

        // Merge with existing system if present
        if (typeof this.config?.system === "string") {
          params.system = `${this.config.system}\n\n${systemPrompt}`;
        } else if (Array.isArray(this.config?.system)) {
          params.system = [
            ...this.config.system,
            {
              type: "text" as const,
              text: systemPrompt,
            },
          ];
        } else {
          params.system = systemPrompt;
        }
      }

      const response = await this.client.messages.create(params);

      // Extract text and tool calls from response
      const textContent = response.content.find(
        (block) => block.type === "text"
      );
      const message = textContent?.type === "text" ? textContent.text : "";

      // Extract tool calls from response
      const toolCalls: Array<{
        toolName: string;
        arguments: Record<string, unknown>;
      }> = [];

      // Check for tool_use content blocks
      for (const block of response.content) {
        if (block.type === "tool_use") {
          toolCalls.push({
            toolName: block.name,
            arguments: block.input as Record<string, unknown>,
          });
        }
      }

      // Only throw error if we have no text AND no function calls
      if (!message && toolCalls.length === 0) {
        throw new Error("No response from Anthropic");
      }

      // Parse JSON response if schema was provided
      let structured: AgentStructuredResponse | undefined;
      if (input.parameters?.jsonSchema) {
        try {
          structured = JSON.parse(message) as AgentStructuredResponse;
        } catch (error) {
          logger.warn("[ANTHROPIC] Failed to parse JSON response:", error);
          // Fall back to treating the message as plain text
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

      // A parsed-but-blank structured message with no tool calls is just as
      // empty as no text at all — throw so withTimeoutAndRetry retries instead
      // of returning {"message":""}.
      if (
        toolCalls.length === 0 &&
        typeof structured?.message === "string" &&
        !structured.message.trim()
      ) {
        throw new Error("No response from Anthropic");
      }

      return {
        message,
        metadata: {
          model: response.model,
          stopReason: response.stop_reason,
          tokensUsed:
            response.usage.input_tokens + response.usage.output_tokens,
          promptTokens: response.usage.input_tokens,
          completionTokens: response.usage.output_tokens,
        },
        structured,
      };
    };

    return withTimeoutAndRetry(
      operation,
      this.retryConfig.timeout,
      this.retryConfig.retries,
      `Anthropic ${model}`
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
      yield* withStreamRetry(
        () => this.generateStreamWithModel<TContext, TStructured>(this.primaryModel, input),
        { maxRetries: this.retryConfig.retries, operationName: `Anthropic ${this.primaryModel} stream` }
      );
    } catch (primaryError: unknown) {
      const primaryErrMsg = getErrorMessage(primaryError);
      logger.warn(
        `[ANTHROPIC] Primary model ${this.primaryModel} failed: ${primaryErrMsg}`
      );

      if (!shouldUseBackupModel(primaryError)) {
        throw toProviderError(primaryError, this.name, CLASSIFICATION_OPTIONS);
      }

      logger.debug(`[ANTHROPIC] Trying backup models for streaming`);

      let lastBackupError: unknown = primaryError;

      for (let i = 0; i < this.backupModels.length; i++) {
        const backupModel = this.backupModels[i];
        logger.debug(
          `[ANTHROPIC] Trying backup model ${i + 1}/${this.backupModels.length
          }: ${backupModel}`
        );

        try {
          yield* withStreamRetry(
            () => this.generateStreamWithModel<TContext, TStructured>(backupModel, input),
            { maxRetries: this.retryConfig.retries, operationName: `Anthropic ${backupModel} stream` }
          );
          logger.debug(`[ANTHROPIC] Backup model ${backupModel} succeeded`);
          return;
        } catch (backupError: unknown) {
          const backupErrMsg = getErrorMessage(backupError);
          logger.warn(
            `[ANTHROPIC] Backup model ${backupModel} failed: ${backupErrMsg}`
          );
          lastBackupError = backupError;

          if (
            !shouldUseBackupModel(backupError) &&
            i < this.backupModels.length - 1
          ) {
            logger.debug(
              `[ANTHROPIC] Backup model error doesn't qualify for further attempts`
            );
            break;
          }
        }
      }

      const lastBackupErrMsg = getErrorMessage(lastBackupError);
      logger.error(
        `[ANTHROPIC] All models failed. Primary: ${primaryErrMsg}, Last backup: ${lastBackupErrMsg}`
      );
      throw toProviderError(lastBackupError, this.name, CLASSIFICATION_OPTIONS);
    }
  }

  private async *generateStreamWithModel<
    TContext = unknown,
    TStructured = AgentStructuredResponse
  >(
    model: string,
    input: GenerateMessageInput<TContext>
  ): AsyncGenerator<GenerateMessageStreamChunk<TStructured>> {
    // Anthropic requires max_tokens to be specified
    const maxTokens = input.parameters?.maxOutputTokens || 4096;

    // Build messages from history
    const { messages: historyMessages, systemMessages } = this.buildAnthropicMessages(input.history);

    // Append the current prompt as the final user message
    historyMessages.push({
      role: "user" as const,
      content: input.prompt,
    });

    const params = {
      model,
      max_tokens: maxTokens,
      messages: historyMessages,
      stream: true,
      ...this.config,
    };

    // Set system messages from history if present
    if (systemMessages.length > 0) {
      if (typeof this.config?.system === "string") {
        params.system = `${this.config.system}\n\n${systemMessages.join("\n\n")}`;
      } else if (Array.isArray(this.config?.system)) {
        params.system = [
          ...this.config.system,
          ...systemMessages.map(s => ({ type: "text" as const, text: s })),
        ];
      } else {
        params.system = systemMessages.join("\n\n");
      }
    }

    // Add tools if provided
    if (input.tools && input.tools.length > 0) {
      params.tools = input.tools.map((tool) => ({
        name: tool.name || tool.id,
        description: tool.description || "",
        input_schema: tool.parameters as Tool["input_schema"], // JSON schema
      }));
    }

    // Handle schema in streaming: embed constraint
    if (input.parameters?.jsonSchema) {
      const systemPrompt =
        "You must respond with valid JSON only and it MUST match the provided schema.";

      if (typeof this.config?.system === "string") {
        params.system = `${this.config.system}\n\n${systemPrompt}`;
      } else if (Array.isArray(this.config?.system)) {
        params.system = [
          ...this.config.system,
          {
            type: "text" as const,
            text: systemPrompt,
          },
        ];
      } else {
        params.system = systemPrompt;
      }
    }

    const stream = this.client.messages.stream(params);

    let accumulated = "";
    let currentModel = model;
    let stopReason: string | undefined;
    let inputTokens = 0;
    let outputTokens = 0;
    const toolCalls: Array<{
      toolName: string;
      arguments: Record<string, unknown>;
    }> = [];

    for await (const chunk of stream) {
      if (chunk.type === "message_start") {
        currentModel = chunk.message.model;
        inputTokens = chunk.message.usage.input_tokens;
      } else if (chunk.type === "content_block_start") {
        if (chunk.content_block.type === "tool_use") {
          toolCalls.push({
            toolName: chunk.content_block.name,
            arguments: chunk.content_block.input as Record<string, unknown>,
          });
        }
      } else if (chunk.type === "content_block_delta") {
        if (chunk.delta.type === "text_delta") {
          const delta = chunk.delta.text;
          accumulated += delta;
          yield {
            delta,
            accumulated,
            done: false,
          } as GenerateMessageStreamChunk<TStructured>;
        }
      } else if (chunk.type === "message_delta") {
        stopReason = chunk.delta.stop_reason || undefined;
        outputTokens = chunk.usage.output_tokens;
      }
    }

    // Parse JSON response if schema was provided
    let structured: AgentStructuredResponse | undefined;
    if (input.parameters?.jsonSchema && accumulated) {
      try {
        structured = JSON.parse(accumulated) as AgentStructuredResponse;
      } catch (error) {
        logger.warn(
          "[ANTHROPIC] Failed to parse JSON response in stream:",
          error
        );
      }
    }

    // If tools were used, include them in structured response
    if (toolCalls.length > 0) {
      structured = {
        ...(structured || {}),
        message: structured?.message || accumulated,
        toolCalls,
      } as AgentStructuredResponse;
    }

    // Empty-completion guard — mirror of the non-streaming path. A blank
    // effective message (structured message under a schema, else accumulated
    // text) with no tool calls means the model produced nothing usable; throw
    // so withStreamRetry/generateStreamWithBackup retry instead of silently
    // emitting an empty message.
    const messageText = (
      typeof structured?.message === "string" ? structured.message : accumulated
    ).trim();
    if (!messageText && toolCalls.length === 0) {
      throw new Error("No response from Anthropic");
    }

    // Yield final chunk
    yield {
      delta: "",
      accumulated,
      done: true,
      metadata: {
        model: currentModel,
        stopReason,
        tokensUsed: inputTokens + outputTokens,
        promptTokens: inputTokens,
        completionTokens: outputTokens,
      },
      structured: structured as TStructured,
    };
  }
}
