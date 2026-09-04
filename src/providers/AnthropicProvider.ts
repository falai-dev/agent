/**
 * Anthropic (Claude).
 *
 * Anthropic has no native schema mode, so a structured request carries the
 * schema as an extra system block — placed after the cached one, where a
 * per-call schema cannot invalidate the system prompt's cache. That, the
 * thinking budget, its 529, and its cache-token accounting all live in
 * `@providerkit/core`; this file is the constructor.
 */

import { createAnthropicProvider } from "@providerkit/core";

import type { ProviderCapabilities } from "../types/ai";
import { ProviderAdapter, type RequestConfig } from "./ProviderAdapter";

export interface AnthropicProviderOptions {
  /** Anthropic API key */
  apiKey: string;
  /** Model to use (required) — e.g. "claude-sonnet-5", "claude-opus-5" */
  model: string;
  /** Backup models to try if the primary fails (default: []) */
  backupModels?: string[];
  /** Any endpoint speaking the Anthropic Messages dialect. */
  baseUrl?: string;
  /** Request defaults sent with every call */
  config?: RequestConfig;
  /** Idle-stream deadline and retry budget */
  retryConfig?: { timeout?: number; retries?: number };
  /**
   * Replacement `fetch`, for tests that script the wire.
   *
   * v3 note: this replaces the injected SDK client. There is no SDK now, so a
   * test drives the same bytes the provider really receives rather than an
   * SDK's idea of them.
   */
  fetchImpl?: typeof fetch;
}

export class AnthropicProvider extends ProviderAdapter {
  public readonly name = "anthropic";
  public readonly capabilities: ProviderCapabilities = {
    supportsTools: true,
    supportsNativeJsonSchema: false,
    supportsStreaming: true,
    supportsStreamingToolCalls: true,
    supportsPromptCaching: true,
  };

  constructor(options: AnthropicProviderOptions) {
    if (!options.apiKey) throw new Error("Anthropic API key is required");
    if (!options.model) {
      throw new Error("Model is required. Example: 'claude-sonnet-5' or 'claude-opus-5'");
    }

    super({
      provider: createAnthropicProvider({
        apiKey: options.apiKey,
        model: options.model,
        id: "anthropic",
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
