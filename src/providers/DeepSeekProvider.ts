/**
 * DeepSeek (OpenAI-compatible). Its reasoning arrives on `reasoning_content`
 * and its cache hits under `prompt_cache_hit_tokens`; both are read one layer
 * down, where they are the dialect's business rather than this file's.
 */

import type { ProviderCapabilities } from "../types/ai.js";
import { OpenAICompatibleProvider } from "./OpenAICompatibleProvider.js";
import type { RequestConfig } from "./ProviderAdapter.js";

export interface DeepSeekProviderOptions {
  /** DeepSeek API key */
  apiKey: string;
  /** Model to use (required) — e.g. "deepseek-chat", "deepseek-reasoner" */
  model: string;
  /** Backup models to try if the primary fails (default: []) */
  backupModels?: string[];
  /** Custom base URL (default: "https://api.deepseek.com") */
  baseURL?: string;
  /** Request defaults sent with every call */
  config?: RequestConfig;
  /** Idle-stream deadline and retry budget */
  retryConfig?: { timeout?: number; retries?: number };
  /** Replacement `fetch`, for tests that script the wire. */
  fetchImpl?: typeof fetch;
}

export class DeepSeekProvider extends OpenAICompatibleProvider {
  public readonly name = "deepseek";
  public readonly capabilities: ProviderCapabilities = {
    supportsTools: true,
    supportsNativeJsonSchema: true,
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
      // No Responses API here; chat completions enforces the schema natively.
      structuredOutput: "json_schema",
      ...(options.backupModels ? { backupModels: options.backupModels } : {}),
      ...(options.config ? { config: options.config } : {}),
      ...(options.retryConfig ? { retryConfig: options.retryConfig } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
  }
}
