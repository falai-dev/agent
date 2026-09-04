/**
 * Shared base for OpenAI-compatible chat-completions providers (OpenAI,
 * DeepSeek, OpenRouter, and anything else speaking the dialect).
 *
 * Everything that used to live here — message building, tool-call assembly,
 * streaming, retry, backup models, error wrapping — is now in
 * `@providerkit/core` and `ProviderAdapter`. What is left is the one decision
 * this layer still owns: which wire a structured request goes out on.
 */

import { createOpenAIProvider, createResponsesProvider, type Provider } from "@providerkit/core";

import { ProviderAdapter, type ProviderAdapterInit, type RequestConfig } from "./ProviderAdapter.js";

/**
 * How structured (JSON-schema) output is requested from the endpoint:
 * - `"responses_parse"` — OpenAI's Responses API, which enforces the schema
 *   natively. Most compatible endpoints do not implement it.
 * - `"json_schema"` — chat completions with a `json_schema` response format.
 *   The broadest enforced mode (DeepSeek, Groq, Together, Fireworks, vLLM…).
 * - `"json_object"` — chat completions with plain JSON mode, for servers with
 *   no schema enforcement at all. The caller validates.
 */
export type StructuredOutputMode = "responses_parse" | "json_schema" | "json_object";

export interface OpenAICompatibleProviderInit
  extends Omit<ProviderAdapterInit, "provider"> {
  apiKey: string;
  baseUrl?: string;
  /** Names the provider in errors, and picks core's effort dialect. */
  id: string;
  headers?: Record<string, string>;
  config?: RequestConfig;
  structuredOutput?: StructuredOutputMode;
  /** OpenRouter upstream-host pin, to keep a conversation's prompt cache warm. */
  providerOrder?: string[];
  /** Replacement `fetch`, for tests that script the wire. */
  fetchImpl?: typeof fetch;
}

export abstract class OpenAICompatibleProvider extends ProviderAdapter {
  protected readonly config?: RequestConfig;

  protected constructor(init: OpenAICompatibleProviderInit) {
    const mode = init.structuredOutput ?? "responses_parse";
    super({
      provider: buildProvider(init, mode),
      model: init.model,
      ...(init.config ? { defaults: init.config } : {}),
      ...(init.backupModels ? { backupModels: init.backupModels } : {}),
      ...(init.retryConfig ? { retryConfig: init.retryConfig } : {}),
    });
    this.config = init.config;
  }
}

function buildProvider(init: OpenAICompatibleProviderInit, mode: StructuredOutputMode): Provider {
  if (mode === "responses_parse") {
    return createResponsesProvider({
      apiKey: init.apiKey,
      model: init.model,
      id: init.id,
      ...(init.baseUrl ? { baseUrl: `${init.baseUrl}` } : {}),
      ...(init.headers ? { headers: init.headers } : {}),
      ...(init.config?.maxTokens ? { maxTokens: init.config.maxTokens } : {}),
      ...(init.fetchImpl ? { fetchImpl: init.fetchImpl } : {}),
    });
  }
  return createOpenAIProvider({
    apiKey: init.apiKey,
    model: init.model,
    id: init.id,
    jsonMode: mode === "json_schema" ? "schema" : "object",
    ...(init.baseUrl ? { baseUrl: init.baseUrl } : {}),
    ...(init.headers ? { headers: init.headers } : {}),
    ...(init.config?.maxTokens ? { maxTokens: init.config.maxTokens } : {}),
    ...(init.providerOrder ? { providerOrder: init.providerOrder } : {}),
    ...(init.fetchImpl ? { fetchImpl: init.fetchImpl } : {}),
  });
}
