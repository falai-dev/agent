/**
 * OpenRouter — one OpenAI-compatible endpoint in front of many models.
 */

import type { AiProvider, ProviderCapabilities } from "../types/ai.js";
import { OpenAICompatibleProvider, type JsonWithTools } from "./OpenAICompatibleProvider.js";
import type { RequestConfig } from "./ProviderAdapter.js";
import type { Provider } from "@providerkit/core";

export interface OpenRouterProviderOptions {
  /** OpenRouter API key */
  apiKey: string;
  /** Model to use (required) — see https://openrouter.ai/models */
  model: string;
  /** Backup models to try if the primary fails (default: []) */
  backupModels?: string[];
  /**
   * Fallback providers, tried in order after this one fails or exhausts.
   * Accepts both @falai/agent AiProviders (like ZaiProvider) and
   * @providerkit/core Providers — the seam that makes a coding-plan primary
   * degrade to anything else rather than fail the turn.
   */
  fallbacks?: Array<AiProvider | Provider>;
  /** Site URL for OpenRouter's rankings */
  siteUrl?: string;
  /** App name for OpenRouter's rankings */
  siteName?: string;
  /**
   * Preferred upstream hosts, in order. OpenRouter's prompt cache lives on the
   * upstream host's account and default routing hops between them, so every hop
   * is a cold cache — worse latency and a higher effective input cost across a
   * conversation's rounds. Fallbacks stay on: this is a preference, not a lock.
   */
  providerOrder?: string[];
  /**
   * See {@link JsonWithTools} — and reach for it here first. One gateway serves
   * hundreds of models and they do not agree: measured through this provider,
   * `z-ai/glm-5.3-flash` called a tool 0/10 with the schema on the response
   * format and 8/8 with it in the prompt, while `qwen3.8-flash` went the other
   * way, 10/10 → 1/6. Changing `model` can change the right answer here.
   */
  jsonWithTools?: JsonWithTools;
  /** Request defaults sent with every call */
  config?: RequestConfig;
  /** Idle-stream deadline and retry budget */
  retryConfig?: { timeout?: number; retries?: number };
  /** Replacement `fetch`, for tests that script the wire. */
  fetchImpl?: typeof fetch;
}

export class OpenRouterProvider extends OpenAICompatibleProvider {
  public readonly name = "openrouter";
  public readonly capabilities: ProviderCapabilities = {
    supportsTools: true,
    supportsNativeJsonSchema: true,
    supportsStreaming: true,
    supportsStreamingToolCalls: true,
    supportsPromptCaching: true,
  };

  constructor(options: OpenRouterProviderOptions) {
    if (!options.apiKey) throw new Error("OpenRouter API key is required");
    if (!options.model) throw new Error("Model is required. See https://openrouter.ai/models");

    super({
      id: "openrouter",
      apiKey: options.apiKey,
      baseUrl: "https://openrouter.ai/api",
      model: options.model,
      // Chat completions rather than the Responses API: this gateway's
      // json_schema passthrough is what its models actually support.
      structuredOutput: "json_schema",
      ...(options.jsonWithTools ? { jsonWithTools: options.jsonWithTools } : {}),
      ...(options.siteUrl ? { siteUrl: options.siteUrl } : {}),
      ...(options.siteName ? { siteName: options.siteName } : {}),
      ...(options.providerOrder ? { providerOrder: options.providerOrder } : {}),
      ...(options.backupModels ? { backupModels: options.backupModels } : {}),
      ...(options.fallbacks ? { fallbacks: options.fallbacks } : {}),
      ...(options.config ? { config: options.config } : {}),
      ...(options.retryConfig ? { retryConfig: options.retryConfig } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
  }
}
