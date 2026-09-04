/**
 * Google Gemini.
 *
 * Thought signatures, the `functionResponse`-by-name pairing, implicit cache
 * hits and the thinking levels are all in `@providerkit/core`, written against
 * the REST API rather than the SDK.
 *
 * v3 sends a response schema alongside tools when a caller asks for both. v2
 * dropped the schema in that case, from a 2024-era constraint that no longer
 * holds — a sibling codebase runs the combination in production today.
 */

import { createGeminiProvider } from "@providerkit/core";

import type { ProviderCapabilities } from "../types/ai.js";
import { ProviderAdapter, type RequestConfig } from "./ProviderAdapter.js";

export interface GeminiProviderOptions {
  /** Gemini API key */
  apiKey: string;
  /** Model to use (required) — e.g. "gemini-3.1-pro-preview" */
  model: string;
  /** Backup models to try if the primary fails (default: []) */
  backupModels?: string[];
  /** Any endpoint speaking the Gemini generateContent dialect. */
  baseUrl?: string;
  /** Request defaults sent with every call */
  config?: RequestConfig;
  /** Idle-stream deadline and retry budget */
  retryConfig?: { timeout?: number; retries?: number };
  /** Replacement `fetch`, for tests that script the wire. Replaces v2's
   *  injected SDK client — see {@link AnthropicProviderOptions.fetchImpl}. */
  fetchImpl?: typeof fetch;
}

export class GeminiProvider extends ProviderAdapter {
  public readonly name = "gemini";
  public readonly capabilities: ProviderCapabilities = {
    supportsTools: true,
    supportsNativeJsonSchema: true,
    supportsStreaming: true,
    supportsStreamingToolCalls: true,
    supportsPromptCaching: true,
  };

  constructor(options: GeminiProviderOptions) {
    if (!options.apiKey) throw new Error("Gemini API key is required");
    if (!options.model) {
      throw new Error("Model is required. Example: 'gemini-3.1-pro-preview'");
    }

    super({
      provider: createGeminiProvider({
        apiKey: options.apiKey,
        model: options.model,
        id: "gemini",
        ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
        ...(options.config?.maxTokens ? { maxTokens: options.config.maxTokens } : {}),
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      }),
      model: options.model,
      ...(options.config ? { defaults: options.config } : {}),
      ...(options.backupModels ? { backupModels: options.backupModels } : {}),
      ...(options.retryConfig ? { retryConfig: options.retryConfig } : {}),
    });
  }
}
