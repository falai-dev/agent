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
import { withTimeoutAndRetry } from "../utils/retry";

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
  /** Model to use (required) - e.g., "claude-sonnet-4-5", "claude-opus-4-1" */
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
  if (error.status === 500 || error.status === 503 || error.status === 529) {
    return true;
  }

  // Rate limiting
  if (error.status === 429) {
    return true;
  }

  // Model overloaded or unavailable
  if (
    error.type === "overloaded_error" ||
    error.type === "api_error" ||
    error.code === "overloaded"
  ) {
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
 * Anthropic provider implementation with backup models and retry logic
 */
export class AnthropicProvider implements AiProvider {
  public readonly name = "anthropic";
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
      throw new Error("Model is required. Example: 'claude-sonnet-4-5'");
    }

    this.client = new Anthropic({
      apiKey,
    });
    this.primaryModel = model;
    this.backupModels = backupModels;
    this.config = config;
    this.retryConfig = {
      timeout: retryConfig?.timeout || DEFAULT_RETRY_CONFIG.timeout,
      retries: retryConfig?.retries || DEFAULT_RETRY_CONFIG.retries,
    };
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
      console.warn(
        `[ANTHROPIC] Primary model ${this.primaryModel} failed: ${primaryErrMsg}`
      );

      if (!shouldUseBackupModel(primaryError)) {
        throw primaryError;
      }

      console.log(`[ANTHROPIC] Trying backup models`);

      let lastBackupError: unknown = primaryError;

      for (let i = 0; i < this.backupModels.length; i++) {
        const backupModel = this.backupModels[i];
        console.log(
          `[ANTHROPIC] Trying backup model ${i + 1}/${
            this.backupModels.length
          }: ${backupModel}`
        );

        try {
          const result = await this.generateWithModel<TContext, TStructured>(
            backupModel,
            input
          );
          console.log(`[ANTHROPIC] Backup model ${backupModel} succeeded`);
          return result;
        } catch (backupError: unknown) {
          const backupErrMsg = getErrorMessage(backupError);
          console.warn(
            `[ANTHROPIC] Backup model ${backupModel} failed: ${backupErrMsg}`
          );
          lastBackupError = backupError;

          if (
            !shouldUseBackupModel(backupError) &&
            i < this.backupModels.length - 1
          ) {
            console.log(
              `[ANTHROPIC] Backup model error doesn't qualify for further attempts`
            );
            break;
          }
        }
      }

      const lastBackupErrMsg = getErrorMessage(lastBackupError);
      console.error(
        `[ANTHROPIC] All models failed. Primary: ${primaryErrMsg}, Last backup: ${lastBackupErrMsg}`
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
      // Anthropic requires max_tokens to be specified
      const maxTokens = input.parameters?.maxOutputTokens || 4096;

      const params: MessageCreateParamsNonStreaming = {
        model,
        max_tokens: maxTokens,
        messages: [
          {
            role: "user",
            content: input.prompt,
          },
        ],
        ...this.config,
      };

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

      if (!message) {
        throw new Error("No response from Anthropic");
      }

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

      // Parse JSON response if schema was provided
      let structured: AgentStructuredResponse | undefined;
      if (input.parameters?.jsonSchema) {
        try {
          structured = JSON.parse(message) as AgentStructuredResponse;
        } catch (error) {
          console.warn("[ANTHROPIC] Failed to parse JSON response:", error);
          // Fall back to treating the message as plain text
        }
      }

      // If tools were used, include them in structured response
      if (toolCalls.length > 0) {
        structured = {
          message,
          toolCalls,
          ...structured,
        } as AgentStructuredResponse;
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
      yield* this.generateStreamWithModel<TContext, TStructured>(
        this.primaryModel,
        input
      );
    } catch (primaryError: unknown) {
      const primaryErrMsg = getErrorMessage(primaryError);
      console.warn(
        `[ANTHROPIC] Primary model ${this.primaryModel} failed: ${primaryErrMsg}`
      );

      if (!shouldUseBackupModel(primaryError)) {
        throw primaryError;
      }

      console.log(`[ANTHROPIC] Trying backup models for streaming`);

      let lastBackupError: unknown = primaryError;

      for (let i = 0; i < this.backupModels.length; i++) {
        const backupModel = this.backupModels[i];
        console.log(
          `[ANTHROPIC] Trying backup model ${i + 1}/${
            this.backupModels.length
          }: ${backupModel}`
        );

        try {
          yield* this.generateStreamWithModel<TContext, TStructured>(
            backupModel,
            input
          );
          console.log(`[ANTHROPIC] Backup model ${backupModel} succeeded`);
          return;
        } catch (backupError: unknown) {
          const backupErrMsg = getErrorMessage(backupError);
          console.warn(
            `[ANTHROPIC] Backup model ${backupModel} failed: ${backupErrMsg}`
          );
          lastBackupError = backupError;

          if (
            !shouldUseBackupModel(backupError) &&
            i < this.backupModels.length - 1
          ) {
            console.log(
              `[ANTHROPIC] Backup model error doesn't qualify for further attempts`
            );
            break;
          }
        }
      }

      const lastBackupErrMsg = getErrorMessage(lastBackupError);
      console.error(
        `[ANTHROPIC] All models failed. Primary: ${primaryErrMsg}, Last backup: ${lastBackupErrMsg}`
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
    // Anthropic requires max_tokens to be specified
    const maxTokens = input.parameters?.maxOutputTokens || 4096;

    const params = {
      model,
      max_tokens: maxTokens,
      messages: [
        {
          role: "user" as const,
          content: input.prompt,
        },
      ],
      stream: true,
      ...this.config,
    };

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
        console.warn(
          "[ANTHROPIC] Failed to parse JSON response in stream:",
          error
        );
      }
    }

    // If tools were used, include them in structured response
    if (toolCalls.length > 0) {
      structured = {
        message: accumulated,
        toolCalls,
        ...structured,
      } as AgentStructuredResponse;
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
      structured,
    } as GenerateMessageStreamChunk<TStructured>;
  }
}
