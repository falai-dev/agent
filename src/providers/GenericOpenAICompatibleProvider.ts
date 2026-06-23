/**
 * Generic OpenAI-compatible provider + factory.
 *
 * Most "OpenAI-compatible" endpoints (Azure OpenAI, Groq, Together, Fireworks,
 * vLLM, LM Studio, Ollama, a self-hosted gateway…) differ from OpenAI only in
 * base URL, headers, and how structured output is requested. `createOpenAICompatibleProvider`
 * builds a working provider from that config alone — no subclass required — so
 * adding one ("fake" provider, same wire protocol, different base URL) is a few lines:
 *
 *   const ollama = createOpenAICompatibleProvider({
 *     name: "ollama",
 *     baseURL: "http://localhost:11434/v1",
 *     apiKey: "ollama",            // local servers ignore it; pass any non-empty string
 *     model: "llama3.3",
 *   });
 *
 *   const azure = createOpenAICompatibleProvider({
 *     name: "azure",
 *     baseURL: `https://${resource}.openai.azure.com/openai/deployments/${deployment}`,
 *     apiKey: process.env.AZURE_OPENAI_KEY!,
 *     model: deployment,
 *     defaultHeaders: { "api-key": process.env.AZURE_OPENAI_KEY! },
 *   });
 *
 * For OpenAI/OpenRouter (native `responses.parse`) and Anthropic/Gemini, prefer
 * their dedicated provider classes.
 */

import OpenAI from "openai";

import type { ProviderCapabilities } from "../types/ai";
import {
  OpenAICompatibleProvider,
  type OpenAICompatibleRequestConfig,
  type StructuredOutputMode,
} from "./OpenAICompatibleProvider";

export interface OpenAICompatibleOptions {
  /** Provider identifier, e.g. "azure", "ollama", "groq". */
  name: string;
  /** Base URL of the OpenAI-compatible endpoint. */
  baseURL: string;
  /** API key. Local servers often ignore it — pass any non-empty string. */
  apiKey: string;
  /** Primary model / deployment name. */
  model: string;
  /** Backup models to try if the primary fails. */
  backupModels?: string[];
  /** Human-readable name for error messages. Defaults to `name`. */
  displayName?: string;
  /** Uppercase tag for log lines. Defaults to `name.toUpperCase()`. */
  logLabel?: string;
  /** Capability overrides, merged over the defaults (all true except caching). */
  capabilities?: Partial<ProviderCapabilities>;
  /** Extra request headers (e.g. Azure's `api-key`, a gateway's auth header). */
  defaultHeaders?: Record<string, string>;
  /**
   * How structured output is requested. Defaults to `"json_schema"` — the
   * broadest enforced mode for arbitrary compatible endpoints (`responses.parse`
   * is OpenAI-only). See {@link StructuredOutputMode}.
   */
  structuredOutput?: StructuredOutputMode;
  /** Default request parameters merged into every call. */
  config?: OpenAICompatibleRequestConfig;
  /** Per-call timeout (ms) and retry count. */
  retryConfig?: { timeout?: number; retries?: number };
}

/** Sensible defaults for a modern OpenAI-compatible endpoint. */
const DEFAULT_CAPABILITIES: ProviderCapabilities = {
  supportsTools: true,
  supportsNativeJsonSchema: true,
  supportsStreaming: true,
  supportsStreamingToolCalls: true,
  supportsPromptCaching: false,
};

/**
 * Concrete OpenAI-compatible provider configured entirely from
 * {@link OpenAICompatibleOptions}. Kept private — construct via
 * {@link createOpenAICompatibleProvider}; subclass {@link OpenAICompatibleProvider}
 * directly if you need behavior beyond these knobs (e.g. provider-specific
 * error classification or streaming hooks).
 */
class GenericOpenAICompatibleProvider extends OpenAICompatibleProvider {
  public readonly name: string;
  public readonly capabilities: ProviderCapabilities;
  protected readonly logLabel: string;
  protected readonly displayName: string;

  constructor(options: OpenAICompatibleOptions) {
    if (!options.name) {
      throw new Error("An OpenAI-compatible provider needs a `name`.");
    }
    if (!options.baseURL) {
      throw new Error(`[${options.name}] A \`baseURL\` is required.`);
    }
    if (!options.apiKey) {
      throw new Error(
        `[${options.name}] An \`apiKey\` is required — use any non-empty string for servers that ignore it.`
      );
    }
    if (!options.model) {
      throw new Error(`[${options.name}] A \`model\` is required.`);
    }

    super({
      client: new OpenAI({
        apiKey: options.apiKey,
        baseURL: options.baseURL,
        ...(options.defaultHeaders ? { defaultHeaders: options.defaultHeaders } : {}),
      }),
      model: options.model,
      backupModels: options.backupModels,
      config: options.config,
      retryConfig: options.retryConfig,
      // Arbitrary compatible endpoints rarely have responses.parse; default to
      // the broadly-supported chat json_schema strategy.
      structuredOutput: options.structuredOutput ?? "json_schema",
    });

    this.name = options.name;
    this.displayName = options.displayName ?? options.name;
    this.logLabel = options.logLabel ?? options.name.toUpperCase();
    this.capabilities = { ...DEFAULT_CAPABILITIES, ...options.capabilities };
  }
}

/**
 * Build an `AiProvider` for any OpenAI-compatible endpoint from config alone.
 * See {@link OpenAICompatibleOptions} for the knobs and the file header for
 * Azure/Ollama examples.
 */
export function createOpenAICompatibleProvider(
  options: OpenAICompatibleOptions
): OpenAICompatibleProvider {
  return new GenericOpenAICompatibleProvider(options);
}
