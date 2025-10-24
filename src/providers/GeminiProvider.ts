/**
 * Google Gemini AI provider implementation with retry and backup models
 */

import type {
  GoogleGenAI as GoogleGenAIType,
  GenerateContentConfig,
  GenerateContentResponse,
  Schema,
  FunctionDeclaration,
} from "@google/genai";
import { GoogleGenAI, Type } from "@google/genai";

import type {
  AiProvider,
  GenerateMessageInput,
  GenerateMessageOutput,
  GenerateMessageStreamChunk,
  AgentStructuredResponse,
  StructuredSchema,
} from "../types";
import { withTimeoutAndRetry } from "../utils/retry";
import { tryParseJSONResponse } from "../utils/json";
import { logger } from "../utils/logger";

const DEFAULT_RETRY_CONFIG = {
  timeout: 60000,
  retries: 3,
};

/**
 * Configuration options for Gemini provider
 * Uses types from @google/genai package
 */
export interface GeminiProviderOptions {
  /** Gemini API key */
  apiKey: string;
  /** Model to use (required) - e.g., "models/gemini-2.5-pro" */
  model: string;
  /** Backup models to try if primary fails (default: []) */
  backupModels?: string[];
  /** Default generation config - uses GenerateContentConfig from @google/genai */
  config?: Partial<GenerateContentConfig>;
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
  if (error.code === "overloaded") {
    return true;
  }

  const message = getErrorMessage(error);
  if (
    message.includes("overloaded") ||
    message.includes("unavailable") ||
    message.includes("not available") ||
    message.includes("internal error") ||
    message.includes("Internal error") ||
    message.includes("INTERNAL")
  ) {
    return true;
  }

  return false;
};

/**
 * Gemini provider implementation with backup models and retry logic
 */
export class GeminiProvider implements AiProvider {
  public readonly name = "gemini";
  private genAI: GoogleGenAIType;
  private primaryModel: string;
  private backupModels: string[];
  private config?: Partial<GenerateContentConfig>;
  private retryConfig: { timeout: number; retries: number };

  constructor(options: GeminiProviderOptions) {
    const { apiKey, model, backupModels = [], config, retryConfig } = options;

    if (!apiKey) {
      throw new Error("Gemini API key is required");
    }

    if (!model) {
      throw new Error("Model is required. Example: 'models/gemini-2.5-pro'");
    }

    this.genAI = new GoogleGenAI({ apiKey });
    this.primaryModel = model;
    this.backupModels = backupModels;
    this.config = config;
    this.retryConfig = {
      timeout: retryConfig?.timeout || DEFAULT_RETRY_CONFIG.timeout,
      retries: retryConfig?.retries || DEFAULT_RETRY_CONFIG.retries,
    };
  }

  /**
   * Adapt common schema format to Gemini's specific requirements.
   * Gemini has strict validation:
   * - OBJECT types MUST have non-empty properties
   * - Empty objects cause 400 Bad Request errors
   * - Uses Gemini's Schema type with Type enums
   *
   * @private
   */
  private adaptSchemaForGemini(schema: StructuredSchema): Schema {
    const geminiSchema: Schema = {};

    // Convert type
    if (schema.type) {
      if (Array.isArray(schema.type)) {
        // For now, take the first type (Gemini doesn't support union types the same way)
        geminiSchema.type = this.mapToGeminiType(schema.type[0]);
      } else {
        geminiSchema.type = this.mapToGeminiType(schema.type);
      }
    }

    // Handle description
    if (schema.description) {
      geminiSchema.description = schema.description;
    }

    // Handle nullable
    if (schema.nullable !== undefined) {
      geminiSchema.nullable = schema.nullable;
    }

    // Handle enum
    if (schema.enum) {
      geminiSchema.enum = schema.enum as string[];
    }

    // Handle object properties - Gemini requires non-empty properties for OBJECT type
    if (
      geminiSchema.type === Type.OBJECT ||
      schema.type === "object" ||
      (Array.isArray(schema.type) && schema.type.includes("object"))
    ) {
      if (!schema.properties || Object.keys(schema.properties).length === 0) {
        logger.warn(
          "[GeminiProvider] Gemini requires OBJECT types to have non-empty properties. Converting empty object to STRING."
        );
        geminiSchema.type = Type.STRING;
        return geminiSchema;
      }

      // Recursively convert nested properties
      geminiSchema.properties = {};
      for (const [key, value] of Object.entries(schema.properties)) {
        geminiSchema.properties[key] = this.adaptSchemaForGemini(value);
      }

      // Handle required fields
      if (schema.required && schema.required.length > 0) {
        geminiSchema.required = schema.required;
      }
    }

    // Handle array items
    if (
      geminiSchema.type === Type.ARRAY ||
      schema.type === "array" ||
      (Array.isArray(schema.type) && schema.type.includes("array"))
    ) {
      if (schema.items) {
        geminiSchema.items = this.adaptSchemaForGemini(schema.items);
      }
    }

    return geminiSchema;
  }

  /**
   * Map common JSON Schema type strings to Gemini's Type enum
   * @private
   */
  private mapToGeminiType(type: string): Type {
    switch (type.toLowerCase()) {
      case "string":
        return Type.STRING;
      case "number":
        return Type.NUMBER;
      case "integer":
        return Type.INTEGER;
      case "boolean":
        return Type.BOOLEAN;
      case "array":
        return Type.ARRAY;
      case "object":
        return Type.OBJECT;
      default:
        logger.warn(
          `[GeminiProvider] Unknown type "${type}", defaulting to STRING`
        );
        return Type.STRING;
    }
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
      logger.warn(
        `[GEMINI] Primary model ${this.primaryModel} failed: ${primaryErrMsg}`
      );

      if (!shouldUseBackupModel(primaryError)) {
        throw primaryError;
      }

      logger.debug(`[GEMINI] Trying backup models`);

      let lastBackupError: unknown = primaryError;

      for (let i = 0; i < this.backupModels.length; i++) {
        const backupModel = this.backupModels[i];
        logger.debug(
          `[GEMINI] Trying backup model ${i + 1}/${this.backupModels.length
          }: ${backupModel}`
        );

        try {
          const result = await this.generateWithModel(backupModel, input);
          logger.debug(`[GEMINI] Backup model ${backupModel} succeeded`);
          return result as GenerateMessageOutput<TStructured>;
        } catch (backupError: unknown) {
          const backupErrMsg = getErrorMessage(backupError);
          logger.warn(
            `[GEMINI] Backup model ${backupModel} failed: ${backupErrMsg}`
          );
          lastBackupError = backupError;

          if (
            !shouldUseBackupModel(backupError) &&
            i < this.backupModels.length - 1
          ) {
            logger.debug(
              `[GEMINI] Backup model error doesn't qualify for further attempts`
            );
            break;
          }
        }
      }

      const lastBackupErrMsg = getErrorMessage(lastBackupError);
      logger.error(
        `[GEMINI] All models failed. Primary: ${primaryErrMsg}, Last backup: ${lastBackupErrMsg}`
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
      // Schema-required: configure response schema
      const configOverride: Partial<GenerateContentConfig> = { ...this.config };

      // Handle tools and JSON schema - Gemini doesn't support both simultaneously
      const hasTools = input.tools && input.tools.length > 0;
      const hasJsonSchema = input.parameters?.jsonSchema;

      if (hasTools && hasJsonSchema) {
        logger.debug(`[GeminiProvider] Both tools and JSON schema provided. Prioritizing function calling - JSON schema will be ignored.`);
      }

      if (hasTools) {
        const toolNames = input.tools?.map((tool) => tool.name || tool.id) || [];
        logger.debug(`[GeminiProvider] Configuring ${toolNames.length} tools for model ${model}:`, toolNames);
        configOverride.tools = [
          {
            functionDeclarations: input.tools?.map((tool) => ({
              name: tool.name || tool.id,
              description: tool.description || "",
              parameters: tool.parameters as FunctionDeclaration["parameters"], // JSON schema
            })),
          },
        ];

      } else if (hasJsonSchema) {
        // Only set JSON schema if no tools are present
        configOverride.responseMimeType = "application/json";
        // Adapt common schema format to Gemini's specific requirements
        configOverride.responseSchema = input.parameters ? this.adaptSchemaForGemini(
          input.parameters.jsonSchema
        ) : {};
      }

      let response: GenerateContentResponse;
      try {
        response = await this.genAI.models.generateContent({
          model,
          contents: input.prompt,
          config: configOverride,
        });
      } catch (error: unknown) {
        logger.error(`[GeminiProvider] API call failed:`, error);
        throw error;
      }

      // Extract tool calls from response first
      const toolCalls: Array<{
        toolName: string;
        arguments: Record<string, unknown>;
      }> = [];

      // Check for function calls in the response content
      if (response.candidates && response.candidates[0]?.content?.parts) {
        for (const part of response.candidates[0].content.parts) {
          if (part.functionCall) {
            toolCalls.push({
              toolName: part.functionCall.name || "",
              arguments: part.functionCall.args as Record<string, unknown>,
            });
          }
        }
      }

      // Debug logging for response structure
      if (!response.text && toolCalls.length === 0) {
        logger.debug(`[GeminiProvider] Debug - Response structure:`, {
          hasText: !!response.text,
          candidatesCount: response.candidates?.length || 0,
          firstCandidateContent: response.candidates?.[0]?.content,
          firstCandidateParts: response.candidates?.[0]?.content?.parts?.length || 0,
        });
      }
      // Try to get text from response, handling function calls properly
      let message = "";
      try {
        message = response.text || "";
      } catch (textError) {
        // Sometimes response.text throws when there are function calls
        logger.debug(`[GeminiProvider] Could not get response.text (likely due to function calls):`, textError);

        // Try to extract text parts manually
        if (response.candidates && response.candidates[0]?.content?.parts) {
          const textParts = response.candidates[0].content.parts
            .filter(part => part.text)
            .map(part => part.text)
            .join('');
          message = textParts;
          logger.debug(`[GeminiProvider] Extracted text from parts:`, message);
        }
      }

      // Only throw error if we have no text AND no function calls
      if (!message && toolCalls.length === 0) {
        logger.error(`[GeminiProvider] Empty response - no text or function calls`);
        logger.error(`[GeminiProvider] Response candidates:`, response.candidates);
        throw new Error("No response from Gemini");
      }

      // Log when we have function calls but no text (this is normal)
      if (toolCalls.length > 0 && !message) {
        logger.debug(`[GeminiProvider] Function calls detected without text message:`, toolCalls.map(tc => tc.toolName));
      } else if (toolCalls.length > 0 && message) {
        logger.debug(`[GeminiProvider] Response has both text and function calls:`, {
          messageLength: message.length,
          toolCalls: toolCalls.map(tc => tc.toolName),
        });
      }



      // Parse JSON response if schema was provided
      let structured: AgentStructuredResponse | undefined;
      if (input.parameters?.jsonSchema) {
        const parsed = tryParseJSONResponse(message);
        if (parsed) {
          structured = parsed as AgentStructuredResponse;
        } else {
          logger.warn("[GeminiProvider] Failed to parse JSON response, treating as plain text");
        }
      }

      // If tools were used, include them in structured response
      if (toolCalls.length > 0) {
        structured = {
          message: structured?.message || message,
          toolCalls,
          ...structured,
        } as AgentStructuredResponse;
      }

      return {
        message,
        metadata: {
          model,
          tokensUsed: response.usageMetadata?.totalTokenCount,
          promptTokens: response.usageMetadata?.promptTokenCount,
          completionTokens: response.usageMetadata?.candidatesTokenCount,
        },
        structured,
      };
    };

    return withTimeoutAndRetry(
      operation,
      this.retryConfig.timeout,
      this.retryConfig.retries,
      `Gemini ${model}`
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
      logger.warn(
        `[GEMINI] Primary model ${this.primaryModel} failed: ${primaryErrMsg}`
      );

      if (!shouldUseBackupModel(primaryError)) {
        throw primaryError;
      }

      logger.debug(`[GEMINI] Trying backup models for streaming`);

      let lastBackupError: unknown = primaryError;

      for (let i = 0; i < this.backupModels.length; i++) {
        const backupModel = this.backupModels[i];
        logger.debug(
          `[GEMINI] Trying backup model ${i + 1}/${this.backupModels.length
          }: ${backupModel}`
        );

        try {
          yield* this.generateStreamWithModel(backupModel, input);
          logger.debug(`[GEMINI] Backup model ${backupModel} succeeded`);
          return;
        } catch (backupError: unknown) {
          const backupErrMsg = getErrorMessage(backupError);
          logger.warn(
            `[GEMINI] Backup model ${backupModel} failed: ${backupErrMsg}`
          );
          lastBackupError = backupError;

          if (
            !shouldUseBackupModel(backupError) &&
            i < this.backupModels.length - 1
          ) {
            logger.debug(
              `[GEMINI] Backup model error doesn't qualify for further attempts`
            );
            break;
          }
        }
      }

      const lastBackupErrMsg = getErrorMessage(lastBackupError);
      logger.error(
        `[GEMINI] All models failed. Primary: ${primaryErrMsg}, Last backup: ${lastBackupErrMsg}`
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
    // Streaming: request JSON if schema provided
    const configOverride: Partial<GenerateContentConfig> = { ...this.config };

    // Handle tools and JSON schema - Gemini doesn't support both simultaneously
    const hasTools = input.tools && input.tools.length > 0;
    const hasJsonSchema = input.parameters?.jsonSchema;

    if (hasTools && hasJsonSchema) {
      logger.debug(`[GeminiProvider] Both tools and JSON schema provided. Prioritizing function calling - JSON schema will be ignored.`);
    }

    if (hasTools) {
      const toolNames = input.tools?.map((tool) => tool.name || tool.id) || [];
      logger.debug(`[GeminiProvider] Configuring ${toolNames.length} tools for streaming:`, toolNames);
      configOverride.tools = [
        {
          functionDeclarations: input.tools?.map((tool) => ({
            name: tool.name || tool.id,
            description: tool.description || "",
            parameters: tool.parameters as FunctionDeclaration["parameters"],
          })),
        },
      ];

    } else if (hasJsonSchema) {
      // Only set JSON schema if no tools are present
      configOverride.responseMimeType = "application/json";
      // Adapt common schema format to Gemini's specific requirements
      configOverride.responseSchema = input.parameters ? this.adaptSchemaForGemini(
        input.parameters.jsonSchema
      ) : {};
    }

    let stream;
    try {
      stream = await this.genAI.models.generateContentStream({
        model,
        contents: input.prompt,
        config: configOverride,
      });
    } catch (error: unknown) {
      logger.error(`[GeminiProvider] Streaming API call failed:`, error);
      throw error;
    }

    let accumulated = "";
    let promptTokenCount = 0;
    let candidatesTokenCount = 0;
    let totalTokenCount = 0;
    const toolCalls: Array<{
      toolName: string;
      arguments: Record<string, unknown>;
    }> = [];

    for await (const chunk of stream) {
      const delta = chunk.text || "";

      // Extract tool calls from chunk
      if (chunk.candidates && chunk.candidates[0]?.content?.parts) {
        for (const part of chunk.candidates[0].content.parts) {
          if (part.functionCall) {
            toolCalls.push({
              toolName: part.functionCall.name || "",
              arguments: part.functionCall.args as Record<string, unknown>,
            });
          }
        }
      }

      if (delta) {
        accumulated += delta;
        yield {
          delta,
          accumulated,
          done: false,
        };
      }

      // Update token counts if available
      if (chunk.usageMetadata) {
        promptTokenCount = chunk.usageMetadata.promptTokenCount || 0;
        candidatesTokenCount = chunk.usageMetadata.candidatesTokenCount || 0;
        totalTokenCount = chunk.usageMetadata.totalTokenCount || 0;
      }
    }

    // Parse JSON response if schema was provided
    let structured: AgentStructuredResponse | undefined;
    if (input.parameters?.jsonSchema && accumulated) {
      const parsed = tryParseJSONResponse(accumulated);
      if (parsed) {
        structured = parsed as AgentStructuredResponse;
      } else {
        logger.warn("[GeminiProvider] Failed to parse JSON response in stream, treating as plain text");
      }
    }

    // If tools were used, include them in structured response
    if (toolCalls.length > 0) {
      structured = {
        message: structured?.message || accumulated,
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
        model,
        tokensUsed: totalTokenCount,
        promptTokens: promptTokenCount,
        completionTokens: candidatesTokenCount,
      },
      structured: structured as TStructured | undefined,
    };
  }
}
