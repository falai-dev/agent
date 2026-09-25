/**
 * OpenAI provider. Structured output goes out on the Responses API, which
 * enforces the schema natively.
 */

import type { AiProvider, ProviderCapabilities } from "../types/ai.js";
import { OpenAICompatibleProvider } from "./OpenAICompatibleProvider.js";
import type { Provider } from "@providerkit/core";
import type { RequestConfig } from "./ProviderAdapter.js";

export interface OpenAIProviderOptions {
  /** OpenAI API key */
  apiKey: string;
  /** Model to use (required) — e.g. "gpt-5.6", "gpt-5.4-mini" */
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
  /** Organization id, sent as the `OpenAI-Organization` header */
  organization?: string;
  /** Request defaults sent with every call */
  config?: RequestConfig;
  /** Idle-stream deadline and retry budget */
  retryConfig?: { timeout?: number; retries?: number };
  /** Replacement `fetch`, for tests that script the wire. */
  fetchImpl?: typeof fetch;
}

export class OpenAIProvider extends OpenAICompatibleProvider {
  public readonly name = "openai";
  public readonly capabilities: ProviderCapabilities = {
    supportsTools: true,
    supportsNativeJsonSchema: true,
    supportsStreaming: true,
    supportsStreamingToolCalls: true,
    // v3: the shape auto-caches repeated prefixes and now reports the hit
    // count, which the old adapter never read.
    supportsPromptCaching: true,
  };

  constructor(options: OpenAIProviderOptions) {
    if (!options.apiKey) throw new Error(`[OpenAIProvider] apiKey is empty: the provider cannot authenticate. Pass { apiKey: process.env.OPENAI_API_KEY } and check the variable is set.`);
    if (!options.model) throw new Error(`[OpenAIProvider] model is empty: there is no default. Pass one, e.g. { model: "gpt-5.6" }.`);

    super({
      id: "openai",
      apiKey: options.apiKey,
      model: options.model,
      structuredOutput: "responses_parse",
      ...(options.organization
        ? { headers: { "OpenAI-Organization": options.organization } }
        : {}),
      ...(options.backupModels ? { backupModels: options.backupModels } : {}),
      ...(options.fallbacks ? { fallbacks: options.fallbacks } : {}),
      ...(options.config ? { config: options.config } : {}),
      ...(options.retryConfig ? { retryConfig: options.retryConfig } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
  }
}
