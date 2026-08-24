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
import { withTimeoutAndRetry, withStreamRetry, withBackupFallback, streamWithBackupFallback, backupFallbackLogging, resolveRetryConfig, logger, assertUsableCompletion, combineAbortSignals } from "../utils";
import {
  classifyProviderError,
  isBackupEligible,
  isRetriableProviderError,
  toProviderError,
  type ErrorClassificationOptions,
} from "./errorClassification";

/**
 * Configuration options for Anthropic provider
 * Uses types from @anthropic-ai/sdk package
 */
export interface AnthropicProviderOptions {
  /** Anthropic API key. Optional when `client` is injected (tests). */
  apiKey?: string;
  /** Model to use (required) - e.g., "claude-sonnet-5", "claude-opus-5" */
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
  /**
   * Pre-configured SDK client. Overrides the internally-constructed one.
   * Intended for tests injecting scripted transports; production callers
   * should pass `apiKey` instead.
   */
  client?: Anthropic;
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
    // No cache_control is attached to any request yet — reporting true would
    // make consumers believe repeated system prompts are cached when they are
    // not. Flip this when caching is actually implemented.
    supportsPromptCaching: false,
  };
  private client: Anthropic;
  private primaryModel: string;
  private backupModels: string[];
  private config?: Partial<
    Omit<MessageCreateParamsNonStreaming, "model" | "messages">
  >;
  private retryConfig: { timeout: number; retries: number };

  constructor(options: AnthropicProviderOptions) {
    const { apiKey, model, backupModels = [], config, retryConfig, client } = options;

    if (!client && !apiKey) {
      throw new Error("Anthropic API key is required");
    }

    if (!model) {
      throw new Error("Model is required. Example: 'claude-sonnet-5'");
    }

    this.client = client ?? new Anthropic({
      apiKey,
    });
    this.primaryModel = model;
    this.backupModels = backupModels;
    this.config = config;
    this.retryConfig = resolveRetryConfig(retryConfig);
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
    const observer = backupFallbackLogging("[ANTHROPIC]", shouldUseBackupModel);

    try {
      return await withBackupFallback({
        models: [this.primaryModel, ...this.backupModels],
        attempt: (model) =>
          this.generateWithModel<TContext, TStructured>(model, input),
        shouldTryBackup: shouldUseBackupModel,
        ...observer.callbacks,
      });
    } catch (error: unknown) {
      observer.logExhausted(error);
      throw toProviderError(error, this.name, CLASSIFICATION_OPTIONS);
    }
  }

  private async generateWithModel<
    TContext = unknown,
    TStructured = AgentStructuredResponse
  >(
    model: string,
    input: GenerateMessageInput<TContext>
  ): Promise<GenerateMessageOutput<TStructured>> {
    const operation = async (signal: AbortSignal): Promise<GenerateMessageOutput> => {
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

      const response = await this.client.messages.create(params, {
        signal: combineAbortSignals(input.signal, signal),
      });

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

      // A parsed-but-blank message with no tool calls is as empty as no text;
      // the shared guard throws so withTimeoutAndRetry retries instead of
      // returning {"message":""}.
      assertUsableCompletion(structured, message, toolCalls.length, "Anthropic");

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
      `Anthropic ${model}`,
      (error) => isRetriableProviderError(error, CLASSIFICATION_OPTIONS)
    ) as Promise<GenerateMessageOutput<TStructured>>;
  }

  private async *generateStreamWithBackup<
    TContext = unknown,
    TStructured = AgentStructuredResponse
  >(
    input: GenerateMessageInput<TContext>
  ): AsyncGenerator<GenerateMessageStreamChunk<TStructured>> {
    const observer = backupFallbackLogging("[ANTHROPIC]", shouldUseBackupModel, { streaming: true });

    try {
      yield* streamWithBackupFallback({
        models: [this.primaryModel, ...this.backupModels],
        attempt: (model) =>
          withStreamRetry(
            (signal) => this.generateStreamWithModel<TContext, TStructured>(model, input, signal),
            { maxRetries: this.retryConfig.retries, firstChunkTimeoutMs: this.retryConfig.timeout, operationName: `Anthropic ${model} stream`, isRetriable: (error) => isRetriableProviderError(error, CLASSIFICATION_OPTIONS) }
          ),
        shouldTryBackup: shouldUseBackupModel,
        ...observer.callbacks,
      });
    } catch (error: unknown) {
      observer.logExhausted(error);
      throw toProviderError(error, this.name, CLASSIFICATION_OPTIONS);
    }
  }

  private async *generateStreamWithModel<
    TContext = unknown,
    TStructured = AgentStructuredResponse
  >(
    model: string,
    input: GenerateMessageInput<TContext>,
    attemptSignal?: AbortSignal
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

    const stream = this.client.messages.stream(params, {
      signal: combineAbortSignals(input.signal, attemptSignal),
    });

    let accumulated = "";
    let currentModel = model;
    let stopReason: string | undefined;
    let inputTokens = 0;
    let outputTokens = 0;
    // Tool_use blocks arrive empty: content_block_start carries `input: {}`,
    // the real arguments stream in later as input_json_delta partial_json
    // fragments. Accumulate per block index and parse once at stream end.
    const pendingToolBlocks = new Map<
      number,
      { toolName: string; argumentsBuffer: string }
    >();

    for await (const chunk of stream) {
      if (chunk.type === "message_start") {
        currentModel = chunk.message.model;
        inputTokens = chunk.message.usage.input_tokens;
      } else if (chunk.type === "content_block_start") {
        if (chunk.content_block.type === "tool_use") {
          pendingToolBlocks.set(chunk.index, {
            toolName: chunk.content_block.name,
            argumentsBuffer: "",
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
        } else if (chunk.delta.type === "input_json_delta") {
          const block = pendingToolBlocks.get(chunk.index);
          if (block) {
            block.argumentsBuffer += chunk.delta.partial_json;
          }
        }
      } else if (chunk.type === "message_delta") {
        stopReason = chunk.delta.stop_reason || undefined;
        outputTokens = chunk.usage.output_tokens;
      }
    }

    const toolCalls: Array<{
      toolName: string;
      arguments: Record<string, unknown>;
    }> = [];
    for (const [, block] of [...pendingToolBlocks.entries()].sort(
      ([a], [b]) => a - b
    )) {
      let args: Record<string, unknown> = {};
      if (block.argumentsBuffer) {
        try {
          args = JSON.parse(block.argumentsBuffer) as Record<string, unknown>;
        } catch (error) {
          logger.warn(
            "[ANTHROPIC] Failed to parse streamed tool call arguments:",
            error
          );
        }
      }
      toolCalls.push({ toolName: block.toolName, arguments: args });
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

    // Empty-completion guard — same definition as the non-streaming path, so the
    // stream retries / falls back to backup instead of emitting an empty message.
    assertUsableCompletion(structured, accumulated, toolCalls.length, "Anthropic");

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
