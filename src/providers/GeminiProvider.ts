/**
 * Google Gemini.
 *
 * Thought signatures, the `functionResponse`-by-name pairing, implicit cache
 * hits and the thinking levels are all in `@providerkit/core`, written against
 * the REST API rather than the SDK.
 *
 * On Gemini 3 a response schema and tools travel on the same call. On Gemini 2
 * they cannot: the API answers `400 "Function calling with a response mime
 * type: 'application/json' is unsupported"`, so the schema rides in the prompt
 * instead. `@providerkit/core` reads the model id and picks; nothing to set.
 */

import { createGeminiProvider, type FallbackOptions, type Provider } from "@providerkit/core";

import type { AiProvider, ProviderCapabilities } from "../types/ai.js";
import type { JsonWithTools } from "./OpenAICompatibleProvider.js";
import { ProviderAdapter, type RequestConfig } from "./ProviderAdapter.js";

export interface GeminiProviderOptions {
  /** Gemini API key */
  apiKey: string;
  /** Model to use (required) — e.g. "gemini-3.1-pro-preview" */
  model: string;
  /** Backup models to try if the primary fails (default: []) */
  backupModels?: string[];
  /** Fallback providers to try if this provider fails/exhausts */
  fallbacks?: Array<AiProvider | Provider>;
  fallbackOptions?: FallbackOptions<Provider>;
  /** Any endpoint speaking the Gemini generateContent dialect. */
  baseUrl?: string;
  /**
   * See {@link JsonWithTools}. The answer is the MODEL's, not the endpoint's:
   * `gemini-3.5-flash` and `-flash-lite` called their tool under
   * `responseJsonSchema` every time, while `gemini-3.8-flash` managed 3/10
   * (2026-09-07). `probeJsonWithTools()` asks the one you serve.
   */
  jsonWithTools?: JsonWithTools;
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
    if (!options.apiKey) throw new Error(`[GeminiProvider] apiKey is empty: the provider cannot authenticate. Pass { apiKey: process.env.GEMINI_API_KEY } and check the variable is set.`);
    if (!options.model) throw new Error(`[GeminiProvider] model is empty: there is no default. Pass one, e.g. { model: "gemini-2.5-flash" }.`);

    super({
      provider: createGeminiProvider({
        apiKey: options.apiKey,
        model: options.model,
        id: "gemini",
        ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
        ...(options.jsonWithTools ? { jsonWithTools: options.jsonWithTools } : {}),
        ...(options.config?.maxTokens ? { maxTokens: options.config.maxTokens } : {}),
        ...(options.config?.effort ? { effort: options.config.effort } : {}),
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      }),
      model: options.model,
      ...(options.config ? { defaults: options.config } : {}),
      ...(options.backupModels ? { backupModels: options.backupModels } : {}),
      ...(options.fallbacks ? { fallbacks: options.fallbacks } : {}),
      ...(options.fallbackOptions ? { fallbackOptions: options.fallbackOptions } : {}),
      ...(options.retryConfig ? { retryConfig: options.retryConfig } : {}),
    });
  }
}
