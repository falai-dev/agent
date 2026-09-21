/**
 * Z.ai Coding Plan.
 *
 * The flat-rate plan hosts GLM on an Anthropic-compatible endpoint with
 * Bearer auth and its own thinking dialect — all of that lives in
 * `@providerkit/core` (adapter + preset); this file is the constructor, the
 * family default for cheap high-volume work.
 *
 * Dialect notes (see the core preset for detail): model ids are BARE
 * (`glm-5.3-flash`, not `z-ai/glm-5.3-flash`), and the endpoint reads an
 * absent `thinking` field as thinking ON, so the preset says "no" out loud.
 * That makes thinking OFF here by default (measured 2026-09-21: a call with no
 * `config.effort` sends `thinking: { type: "disabled" }`); ask for it with
 * `config: { effort: 'high' }`.
 */

import { createZaiCodingProvider, type FallbackOptions, type Provider } from "@providerkit/core";

import type { AiProvider, ProviderCapabilities } from "../types/ai.js";
import { ProviderAdapter, type RequestConfig } from "./ProviderAdapter.js";

export interface ZaiProviderOptions {
  /** Z.ai Coding Plan key */
  apiKey: string;
  /** Model to use. Defaults to the fleet workhorse `glm-5.3-flash`. */
  model?: string;
  /** Backup models to try on this provider if the primary fails (default: []) */
  backupModels?: string[];
  /** Fallback providers to try if this provider fails/exhausts */
  fallbacks?: Array<AiProvider | Provider>;
  fallbackOptions?: FallbackOptions<Provider>;
  /** Any endpoint speaking the Anthropic Messages dialect with the plan's
   *  auth. Defaults to the coding endpoint. */
  baseUrl?: string;
  /** Request defaults sent with every call */
  config?: RequestConfig;
  /** Idle-stream deadline and retry budget */
  retryConfig?: { timeout?: number; retries?: number };
  /** Replacement `fetch`, for tests that script the wire. */
  fetchImpl?: typeof fetch;
}

export class ZaiProvider extends ProviderAdapter {
  public readonly name = "zai";
  public readonly capabilities: ProviderCapabilities = {
    supportsTools: true,
    supportsNativeJsonSchema: false,
    supportsStreaming: true,
    supportsStreamingToolCalls: true,
    supportsPromptCaching: true,
  };

  constructor(options: ZaiProviderOptions) {
    if (!options.apiKey) throw new Error("Z.ai Coding Plan API key is required");

    const model = options.model ?? "glm-5.3-flash";
    super({
      provider: createZaiCodingProvider({
        apiKey: options.apiKey,
        model,
        ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
        ...(options.config?.maxTokens ? { maxTokens: options.config.maxTokens } : {}),
        ...(options.config?.effort ? { effort: options.config.effort } : {}),
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      }),
      model,
      ...(options.config ? { defaults: options.config } : {}),
      ...(options.backupModels ? { backupModels: options.backupModels } : {}),
      ...(options.fallbacks ? { fallbacks: options.fallbacks } : {}),
      ...(options.fallbackOptions ? { fallbackOptions: options.fallbackOptions } : {}),
      ...(options.retryConfig ? { retryConfig: options.retryConfig } : {}),
    });
  }
}
