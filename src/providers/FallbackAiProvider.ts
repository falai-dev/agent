/**
 * Fallback AI Provider: runs an ordered list of AiProviders.
 *
 * Each child AiProvider is tried in turn using `@providerkit/core`'s FallbackPool,
 * preserving per-provider cooldowns (e.g. 5h or weekly rate limit / quota resets)
 * across calls.
 */

import {
  FallbackPool,
  type FallbackOptions,
  type ErrorKind,
} from "@providerkit/core";

import type {
  AgentStructuredResponse,
  AiProvider,
  GenerateMessageInput,
  GenerateMessageOutput,
  GenerateMessageStreamChunk,
  ProviderCapabilities,
} from "../types/ai.js";
import { logger } from "../utils/logger.js";

export interface FallbackAiProviderOptions {
  /** The ordered list of providers to try. The first is primary. */
  providers: AiProvider[];
  /** Optional cooldown configuration overrides. */
  cooldownMs?: Partial<Record<ErrorKind, number | null>>;
  /** Optional callback when a provider enters cooldown. */
  onCooldown?: FallbackOptions<AiProvider>["onCooldown"];
}

export class FallbackAiProvider implements AiProvider {
  public readonly name: string;
  public readonly capabilities: ProviderCapabilities;
  public readonly pool: FallbackPool<AiProvider>;

  constructor(options: FallbackAiProviderOptions) {
    if (!options.providers || options.providers.length === 0) {
      throw new Error("[FallbackAiProvider] providers is empty: there is nothing to call. Pass at least one, e.g. { providers: [primary, backup] }.");
    }

    this.name = `fallback(${options.providers.map((p) => p.name).join("->")})`;

    // Capabilities represent the intersection of supported critical features
    // while inheriting primary's defaults.
    this.capabilities = {
      supportsTools: options.providers.every((p) => p.capabilities.supportsTools),
      supportsNativeJsonSchema: options.providers.every(
        (p) => p.capabilities.supportsNativeJsonSchema,
      ),
      supportsStreaming: options.providers.every((p) => p.capabilities.supportsStreaming),
      supportsStreamingToolCalls: options.providers.every(
        (p) => p.capabilities.supportsStreamingToolCalls,
      ),
      supportsPromptCaching: options.providers.every((p) => p.capabilities.supportsPromptCaching),
    };

    this.pool = new FallbackPool<AiProvider>(options.providers, {
      ...(options.cooldownMs ? { cooldownMs: options.cooldownMs } : {}),
      onCooldown: (info) => {
        logger.warn(
          `[${this.name}] Provider "${info.candidate.name}" cooled down until ${new Date(
            info.retryAtMs,
          ).toISOString()} (${info.kind}${info.window ? ` / ${info.window}` : ""})`,
        );
        options.onCooldown?.(info);
      },
    });
  }

  async generateMessage<TContext = unknown, TStructured = AgentStructuredResponse>(
    input: GenerateMessageInput<TContext>,
  ): Promise<GenerateMessageOutput<TStructured>> {
    return this.pool.with(async (provider, signal) => {
      return provider.generateMessage<TContext, TStructured>({
        ...input,
        signal,
      });
    }, input.signal);
  }

  async *generateMessageStream<TContext = unknown, TStructured = AgentStructuredResponse>(
    input: GenerateMessageInput<TContext>,
  ): AsyncGenerator<GenerateMessageStreamChunk<TStructured>> {
    yield* this.pool.stream(async function* (provider, signal) {
      yield* provider.generateMessageStream<TContext, TStructured>({
        ...input,
        signal,
      });
    }, input.signal);
  }
}
