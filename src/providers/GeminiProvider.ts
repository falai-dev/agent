/**
 * Google Gemini AI provider implementation with retry and backup models
 */

import type {
  GoogleGenAI as GoogleGenAIType,
  GenerateContentConfig,
  GenerateContentResponse,
  Schema,
} from "@google/genai";
import { GoogleGenAI, Type } from "@google/genai";

import type {
  AiProvider,
  GenerateMessageInput,
  GenerateMessageOutput,
  GenerateMessageStreamChunk,
  AgentStructuredResponse,
} from "../types/ai";
import type { StructuredSchema } from "../types/schema";
import { withTimeoutAndRetry } from "../utils/retry";

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
        console.warn(
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
        console.warn(
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
      console.warn(
        `[GEMINI] Primary model ${this.primaryModel} failed: ${primaryErrMsg}`
      );

      if (!shouldUseBackupModel(primaryError)) {
        throw primaryError;
      }

      console.log(`[GEMINI] Trying backup models`);

      let lastBackupError: unknown = primaryError;

      for (let i = 0; i < this.backupModels.length; i++) {
        const backupModel = this.backupModels[i];
        console.log(
          `[GEMINI] Trying backup model ${i + 1}/${
            this.backupModels.length
          }: ${backupModel}`
        );

        try {
          const result = await this.generateWithModel(backupModel, input);
          console.log(`[GEMINI] Backup model ${backupModel} succeeded`);
          return result as GenerateMessageOutput<TStructured>;
        } catch (backupError: unknown) {
          const backupErrMsg = getErrorMessage(backupError);
          console.warn(
            `[GEMINI] Backup model ${backupModel} failed: ${backupErrMsg}`
          );
          lastBackupError = backupError;

          if (
            !shouldUseBackupModel(backupError) &&
            i < this.backupModels.length - 1
          ) {
            console.log(
              `[GEMINI] Backup model error doesn't qualify for further attempts`
            );
            break;
          }
        }
      }

      const lastBackupErrMsg = getErrorMessage(lastBackupError);
      console.error(
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
      if (input.parameters?.jsonSchema) {
        configOverride.responseMimeType = "application/json";
        // Adapt common schema format to Gemini's specific requirements
        configOverride.responseSchema = this.adaptSchemaForGemini(
          input.parameters.jsonSchema
        );
      }

      const response: GenerateContentResponse =
        await this.genAI.models.generateContent({
          model,
          contents: input.prompt,
          config: configOverride,
        });

      const message = response.text;
      if (!message) {
        throw new Error("No response from Gemini");
      }

      // Parse JSON response if schema was provided
      let structured: AgentStructuredResponse | undefined;
      if (input.parameters?.jsonSchema) {
        try {
          structured = JSON.parse(message) as AgentStructuredResponse;
        } catch (error) {
          console.warn("[GEMINI] Failed to parse JSON response:", error);
          // Fall back to treating the message as plain text
        }
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
      console.warn(
        `[GEMINI] Primary model ${this.primaryModel} failed: ${primaryErrMsg}`
      );

      if (!shouldUseBackupModel(primaryError)) {
        throw primaryError;
      }

      console.log(`[GEMINI] Trying backup models for streaming`);

      let lastBackupError: unknown = primaryError;

      for (let i = 0; i < this.backupModels.length; i++) {
        const backupModel = this.backupModels[i];
        console.log(
          `[GEMINI] Trying backup model ${i + 1}/${
            this.backupModels.length
          }: ${backupModel}`
        );

        try {
          yield* this.generateStreamWithModel(backupModel, input);
          console.log(`[GEMINI] Backup model ${backupModel} succeeded`);
          return;
        } catch (backupError: unknown) {
          const backupErrMsg = getErrorMessage(backupError);
          console.warn(
            `[GEMINI] Backup model ${backupModel} failed: ${backupErrMsg}`
          );
          lastBackupError = backupError;

          if (
            !shouldUseBackupModel(backupError) &&
            i < this.backupModels.length - 1
          ) {
            console.log(
              `[GEMINI] Backup model error doesn't qualify for further attempts`
            );
            break;
          }
        }
      }

      const lastBackupErrMsg = getErrorMessage(lastBackupError);
      console.error(
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
    if (input.parameters?.jsonSchema) {
      configOverride.responseMimeType = "application/json";
      // Adapt common schema format to Gemini's specific requirements
      configOverride.responseSchema = this.adaptSchemaForGemini(
        input.parameters.jsonSchema
      );
    }

    const stream = await this.genAI.models.generateContentStream({
      model,
      contents: input.prompt,
      config: configOverride,
    });

    let accumulated = "";
    let promptTokenCount = 0;
    let candidatesTokenCount = 0;
    let totalTokenCount = 0;

    for await (const chunk of stream) {
      const delta = chunk.text || "";

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
      try {
        structured = JSON.parse(accumulated) as AgentStructuredResponse;
      } catch (error) {
        console.warn(
          "[GEMINI] Failed to parse JSON response in stream:",
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
        model,
        tokensUsed: totalTokenCount,
        promptTokens: promptTokenCount,
        completionTokens: candidatesTokenCount,
      },
      structured: structured as TStructured | undefined,
    };
  }
}
