/**
 * OpenAI provider. Structured output goes out on the Responses API, which
 * enforces the schema natively.
 */

import type { ProviderCapabilities } from "../types/ai";
import { OpenAICompatibleProvider } from "./OpenAICompatibleProvider";
import type { RequestConfig } from "./ProviderAdapter";

export interface OpenAIProviderOptions {
  /** OpenAI API key */
  apiKey: string;
  /** Model to use (required) — e.g. "gpt-5.6", "gpt-5.4-mini" */
  model: string;
  /** Backup models to try if the primary fails (default: []) */
  backupModels?: string[];
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
    if (!options.apiKey) throw new Error("OpenAI API key is required");
    if (!options.model) throw new Error("Model is required. Example: 'gpt-5.6' or 'gpt-5.5'");

    super({
      id: "openai",
      apiKey: options.apiKey,
      model: options.model,
      structuredOutput: "responses_parse",
      ...(options.organization
        ? { headers: { "OpenAI-Organization": options.organization } }
        : {}),
      ...(options.backupModels ? { backupModels: options.backupModels } : {}),
      ...(options.config ? { config: options.config } : {}),
      ...(options.retryConfig ? { retryConfig: options.retryConfig } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
  }
}
