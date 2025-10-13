/**
 * Google Gemini AI provider implementation with retry and backup models
 */

import type {
  GoogleGenAI as GoogleGenAIType,
  GenerateContentConfig,
  GenerateContentResponse,
} from "@google/genai";
import { GoogleGenAI } from "@google/genai";

import type {
  AiProvider,
  GenerateMessageInput,
  GenerateMessageOutput,
  AgentStructuredResponse,
} from "../types/ai";
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
  code?: number;
  message?: string;
}

/**
 * Determines if an error should trigger backup model usage
 */
const shouldUseBackupModel = (error: unknown): boolean => {
  const err = error as ErrorWithStatus;

  if (err?.status === 500 || err?.code === 500) {
    return true;
  }

  const message = err?.message ?? String(error);
  if (
    message.includes("internal error") ||
    message.includes("Internal error") ||
    message.includes("INTERNAL")
  ) {
    return true;
  }

  if (
    err?.status === 429 ||
    err?.code === 429 ||
    err?.status === 503 ||
    err?.code === 503
  ) {
    return true;
  }

  if (message.includes("unavailable") || message.includes("not available")) {
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
      const primaryErrMsg = String(primaryError);
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
          return result;
        } catch (backupError: unknown) {
          const backupErrMsg = String(backupError);
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

      const lastBackupErrMsg = String(lastBackupError);
      console.error(
        `[GEMINI] All models failed. Primary: ${primaryErrMsg}, Last backup: ${lastBackupErrMsg}`
      );
      throw lastBackupError;
    }
  }

  private async generateWithModel<TContext = unknown>(
    model: string,
    input: GenerateMessageInput<TContext>
  ): Promise<GenerateMessageOutput> {
    const operation = async (): Promise<GenerateMessageOutput> => {
      // Enable JSON mode if requested
      const configOverride: Partial<GenerateContentConfig> = { ...this.config };
      if (input.parameters?.jsonMode) {
        configOverride.responseMimeType = "application/json";
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

      // Parse JSON response if JSON mode was enabled
      let structured;
      if (input.parameters?.jsonMode) {
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
    );
  }
}
