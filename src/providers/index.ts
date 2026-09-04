/**
 * AI provider exports.
 *
 * Every provider here is a thin binding over `@providerkit/core`: the vendor
 * knowledge lives in that package, and these classes supply the naming,
 * capabilities and construction this framework's seam expects.
 */

export { AnthropicProvider } from "./AnthropicProvider";
export type { AnthropicProviderOptions } from "./AnthropicProvider";

export { GeminiProvider } from "./GeminiProvider";
export type { GeminiProviderOptions } from "./GeminiProvider";

export { OpenAIProvider } from "./OpenAIProvider";
export type { OpenAIProviderOptions } from "./OpenAIProvider";

export { OpenRouterProvider } from "./OpenRouterProvider";
export type { OpenRouterProviderOptions } from "./OpenRouterProvider";

export { DeepSeekProvider } from "./DeepSeekProvider";
export type { DeepSeekProviderOptions } from "./DeepSeekProvider";

export { OpenAICompatibleProvider } from "./OpenAICompatibleProvider";
export type {
  OpenAICompatibleProviderInit,
  StructuredOutputMode,
} from "./OpenAICompatibleProvider";

export { createOpenAICompatibleProvider } from "./GenericOpenAICompatibleProvider";
export type { OpenAICompatibleOptions } from "./GenericOpenAICompatibleProvider";

export { ProviderAdapter, resolveRetryConfig } from "./ProviderAdapter";
export type { ProviderAdapterInit, RequestConfig, RetryConfig } from "./ProviderAdapter";
