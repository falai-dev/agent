/**
 * Token counts, added up across a turn.
 *
 * Providers report per call; a text turn spends two, plus one per tool round,
 * plus one if the history was compacted. The host bills the conversation, so
 * the framework hands it one figure beside `llmCalls`.
 */

import type { TokenUsage } from "../types/ai.js";

interface Counted {
  promptTokens?: number;
  completionTokens?: number;
  cachedInputTokens?: number;
}

/** What a call's metadata says it cost, or nothing when the provider said nothing. */
export function readUsage(metadata: Counted | undefined): TokenUsage | undefined {
  if (!metadata) return undefined;
  const { promptTokens, completionTokens, cachedInputTokens } = metadata;
  if (promptTokens === undefined && completionTokens === undefined) return undefined;
  return {
    promptTokens: promptTokens ?? 0,
    completionTokens: completionTokens ?? 0,
    cachedInputTokens: cachedInputTokens ?? 0,
  };
}

/** Adds two tallies. Nobody counting is not the same as counting zero. */
export function addUsage(a: TokenUsage | undefined, b: TokenUsage | undefined): TokenUsage | undefined {
  if (!a || !b) return a ?? b;
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
  };
}
