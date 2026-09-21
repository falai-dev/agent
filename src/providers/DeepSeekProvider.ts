/**
 * DeepSeek (OpenAI-compatible). Its reasoning arrives on `reasoning_content`
 * and its cache hits under `prompt_cache_hit_tokens`; both are read one layer
 * down, where they are the dialect's business rather than this file's.
 */

import type { AiProvider, ProviderCapabilities } from "../types/ai.js";
import { OpenAICompatibleProvider, type JsonWithTools } from "./OpenAICompatibleProvider.js";
import type { Provider } from "@providerkit/core";
import type { RequestConfig } from "./ProviderAdapter.js";

export interface DeepSeekProviderOptions {
  /** DeepSeek API key */
  apiKey: string;
  /** Model to use (required) — e.g. "deepseek-chat", "deepseek-reasoner" */
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
  /** Custom base URL (default: "https://api.deepseek.com") */
  baseURL?: string;
  /** Request defaults sent with every call */
  config?: RequestConfig;
  /**
   * See {@link JsonWithTools} — and reach for it here first. The measured
   * DeepSeek flash models called a tool 0/5 with the schema on the response
   * format, and narrated it instead.
   */
  jsonWithTools?: JsonWithTools;
  /** Idle-stream deadline and retry budget */
  retryConfig?: { timeout?: number; retries?: number };
  /** Replacement `fetch`, for tests that script the wire. */
  fetchImpl?: typeof fetch;
}

export class DeepSeekProvider extends OpenAICompatibleProvider {
  public readonly name = "deepseek";
  public readonly capabilities: ProviderCapabilities = {
    supportsTools: true,
    // JSON yes, a schema no — see `structuredOutput` below.
    supportsNativeJsonSchema: false,
    supportsStreaming: true,
    supportsStreamingToolCalls: true,
    supportsPromptCaching: true,
  };

  constructor(options: DeepSeekProviderOptions) {
    if (!options.apiKey) throw new Error("DeepSeek API key is required");
    if (!options.model) {
      throw new Error("Model is required. Example: 'deepseek-chat' or 'deepseek-reasoner'");
    }

    super({
      id: "deepseek",
      apiKey: options.apiKey,
      baseUrl: options.baseURL ?? "https://api.deepseek.com",
      model: options.model,
      // DeepSeek serves `response_format: { type: 'json_object' }` and nothing
      // else: a `json_schema` format answers
      // `400 "This response_format type is unavailable now"` on every call.
      // So the endpoint guarantees JSON and the prompt carries the shape, which
      // is the path the parser already tolerates.
      structuredOutput: "json_object",
      ...(options.jsonWithTools ? { jsonWithTools: options.jsonWithTools } : {}),
      ...(options.backupModels ? { backupModels: options.backupModels } : {}),
      ...(options.fallbacks ? { fallbacks: options.fallbacks } : {}),
      ...(options.config ? { config: options.config } : {}),
      ...(options.retryConfig ? { retryConfig: options.retryConfig } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
  }
}
