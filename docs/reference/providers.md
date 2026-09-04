---
title: "Providers"
description: "Strategy classes that connect an Agent to Gemini, OpenAI, Anthropic, OpenRouter, or DeepSeek — plus the base class for building your own."
type: reference
order: 10
---

# Providers

> **Where this is introduced:** [Install](../start/01-install.md)

Providers are the strategy plug between an `Agent` and a model vendor. Every provider implements the same `AiProvider` interface, so the Agent itself stays vendor-agnostic. Pass an instance to `createAgent({ provider })` and the agent talks to that vendor for every turn (and for compaction, if you wire it in).

`@falai/agent` ships five built-in providers. All five accept an `apiKey` and a required `model`, support `backupModels` for automatic failover, and take the same neutral `RequestConfig` for sampling defaults.

There are no vendor SDKs behind them. Every provider is a thin binding over [`@providerkit/core`](https://www.npmjs.com/package/@providerkit/core), which speaks each vendor's REST API over `fetch` — so installing this package does not install one vendor's SDK for a consumer who uses another.

| Provider | Class | Options | Wire |
|----------|-------|---------|------|
| Google Gemini | `GeminiProvider` | `GeminiProviderOptions` | `generateContent` (SSE) |
| OpenAI | `OpenAIProvider` | `OpenAIProviderOptions` | Responses API |
| Anthropic Claude | `AnthropicProvider` | `AnthropicProviderOptions` | Messages API |
| OpenRouter | `OpenRouterProvider` | `OpenRouterProviderOptions` | chat completions |
| DeepSeek | `DeepSeekProvider` | `DeepSeekProviderOptions` | chat completions |

## Capabilities

Every provider declares a required `capabilities: ProviderCapabilities` field — five static flags the engine reads to decide how to drive the vendor (e.g., whether structured output is schema-enforced or prompt-instructed). Custom `AiProvider` implementations **must** declare it.

```typescript
interface ProviderCapabilities {
  supportsTools: boolean;              // tool/function calling
  supportsNativeJsonSchema: boolean;   // native JSON-schema-enforced output (vs. prompt-based JSON instruction)
  supportsStreaming: boolean;          // streaming responses
  supportsStreamingToolCalls: boolean; // tool calls surfaced during streaming
  supportsPromptCaching: boolean;      // prompt caching
}
```

The five built-ins:

| Capability | Gemini | OpenAI | Anthropic | OpenRouter | DeepSeek |
|------------|--------|--------|-----------|------------|----------|
| `supportsTools` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `supportsNativeJsonSchema` | ✅ | ✅ | ❌ | ✅ | ✅ |
| `supportsStreaming` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `supportsStreamingToolCalls` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `supportsPromptCaching` | ❌ | ❌ | ✅ | ❌ | ❌ |

The two asymmetries: Anthropic reports `supportsNativeJsonSchema: false` because its JSON output is enforced via a prompt instruction, not a native schema mode — and it is the only built-in that reports `supportsPromptCaching: true`.

## Use with createAgent

`createAgent({ provider })` accepts any class that implements `AiProvider`. Swap providers by changing the constructor; nothing else in your agent has to move.

```typescript
import {
  createAgent,
  GeminiProvider,
  OpenAIProvider,
  AnthropicProvider,
  OpenRouterProvider,
  DeepSeekProvider,
} from "@falai/agent";

const provider =
  process.env.PROVIDER === "openai"
    ? new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY!, model: "gpt-5.6" })
    : process.env.PROVIDER === "anthropic"
    ? new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY!, model: "claude-sonnet-5" })
    : process.env.PROVIDER === "openrouter"
    ? new OpenRouterProvider({ apiKey: process.env.OPENROUTER_API_KEY!, model: "anthropic/claude-sonnet-5" })
    : process.env.PROVIDER === "deepseek"
    ? new DeepSeekProvider({ apiKey: process.env.DEEPSEEK_API_KEY!, model: "deepseek-chat" })
    : new GeminiProvider({ apiKey: process.env.GEMINI_API_KEY!, model: "gemini-3.1-pro-preview" });

const agent = createAgent({ provider, schema, flows });
```

## GeminiProvider

### Signature

```typescript
new GeminiProvider(options: GeminiProviderOptions)

interface GeminiProviderOptions {
  apiKey: string;
  model: string;
  backupModels?: string[];
  baseUrl?: string;
  config?: RequestConfig;                  // temperature, topP, maxTokens, stopSequences
  retryConfig?: { timeout?: number; retries?: number };
  fetchImpl?: typeof fetch;                // scripted wire, for tests
}
```

### Fields

| Field | Type | Required | Default | Notes |
|-------|------|----------|---------|-------|
| `apiKey` | `string` | yes* | — | Throws if empty (unless `client` is set). |
| `model` | `string` | yes | — | Use the model id, e.g. `"gemini-3.1-pro-preview"`. |
| `backupModels` | `string[]` | no | `[]` | Tried in order on retriable failures (rate limits, overload, timeouts, network). |
| `config` | `Partial<GenerateContentConfig>` | no | — | Vendor-typed defaults (e.g. `temperature`, `systemInstruction`). |
| `retryConfig.timeout` | `number` | no | `60000` | Per-attempt timeout in ms. On streams it also bounds time-to-first-token. |
| `retryConfig.retries` | `number` | no | `3` | Total attempts before giving up. |
| `client` | `GoogleGenAI` | no | — | Pre-configured SDK client; overrides the internally-constructed one. Intended for tests injecting scripted transports; production callers should pass `apiKey`. |

### Example

```typescript
const gemini = new GeminiProvider({
  apiKey: process.env.GEMINI_API_KEY!,
  model: "gemini-3.1-pro-preview",
  backupModels: ["gemini-3.1-flash-lite"],
  config: { temperature: 0.3 },
});
```

## OpenAIProvider

### Signature

```typescript
new OpenAIProvider(options: OpenAIProviderOptions)

interface OpenAIProviderOptions {
  apiKey: string;
  organization?: string;
  model: string;
  backupModels?: string[];
  config?: Partial<Omit<ChatCompletionCreateParamsNonStreaming, "model" | "messages">>;
  retryConfig?: { timeout?: number; retries?: number };
}
```

### Fields

| Field | Type | Required | Default | Notes |
|-------|------|----------|---------|-------|
| `apiKey` | `string` | yes | — | Throws if empty. |
| `organization` | `string` | no | — | Forwarded as `OpenAI-Organization`. |
| `model` | `string` | yes | — | e.g. `"gpt-5.6"`, `"gpt-5.4-mini"`. |
| `backupModels` | `string[]` | no | `[]` | Tried in order on overload/rate-limit errors. |
| `config` | `RequestConfig` | no | — | Defaults for `temperature`, `topP`, `maxTokens`, `stopSequences`. |
| `retryConfig.timeout` | `number` | no | `60000` | Per-attempt timeout in ms. |
| `retryConfig.retries` | `number` | no | `3` | Total attempts. |

### Example

```typescript
const openai = new OpenAIProvider({
  apiKey: process.env.OPENAI_API_KEY!,
  model: "gpt-5.6",
  organization: "org_abc",
  config: { temperature: 0.2 },
});
```

## AnthropicProvider

### Signature

```typescript
new AnthropicProvider(options: AnthropicProviderOptions)

interface AnthropicProviderOptions {
  apiKey: string;
  model: string;
  backupModels?: string[];
  config?: Partial<Omit<MessageCreateParamsNonStreaming, "model" | "messages">>;
  retryConfig?: { timeout?: number; retries?: number };
  client?: Anthropic;                      // pre-configured SDK client override
}
```

### Fields

| Field | Type | Required | Default | Notes |
|-------|------|----------|---------|-------|
| `apiKey` | `string` | yes* | — | Throws if empty (unless `client` is set). |
| `model` | `string` | yes | — | e.g. `"claude-sonnet-5"`, `"claude-opus-5"`. |
| `backupModels` | `string[]` | no | `[]` | Tried in order on retriable failures (rate limits, overload incl. 529, timeouts, network). |
| `config` | `RequestConfig` | no | — | Defaults for `temperature`, `topP`, `maxTokens`, `stopSequences`. `maxTokens` falls back to 4096 if neither it nor `parameters.maxOutputTokens` is set. |
| `retryConfig.timeout` | `number` | no | `60000` | Per-attempt timeout in ms. On streams it also bounds time-to-first-token. |
| `retryConfig.retries` | `number` | no | `3` | Total attempts. |
| `client` | `Anthropic` | no | — | Pre-configured SDK client; overrides the internally-constructed one. Intended for tests injecting scripted transports; production callers should pass `apiKey`. |

### Example

```typescript
const anthropic = new AnthropicProvider({
  apiKey: process.env.ANTHROPIC_API_KEY!,
  model: "claude-sonnet-5",
  config: { maxTokens: 8192 },
});
```

## OpenRouterProvider

OpenRouter is OpenAI-compatible and brokers many vendors behind one endpoint. Use it to A/B-test models without changing client code.

### Signature

```typescript
new OpenRouterProvider(options: OpenRouterProviderOptions)

interface OpenRouterProviderOptions {
  apiKey: string;
  model: string;
  backupModels?: string[];
  siteUrl?: string;
  siteName?: string;
  config?: Partial<Omit<ChatCompletionCreateParamsNonStreaming, "model" | "messages">>;
  retryConfig?: { timeout?: number; retries?: number };
}
```

### Fields

| Field | Type | Required | Default | Notes |
|-------|------|----------|---------|-------|
| `apiKey` | `string` | yes | — | Throws if empty. |
| `model` | `string` | yes | — | OpenRouter model id, e.g. `"anthropic/claude-sonnet-5"`. See [openrouter.ai/models](https://openrouter.ai/models). |
| `backupModels` | `string[]` | no | `[]` | Tried in order on overload/capacity errors. |
| `siteUrl` | `string` | no | `""` | Sent as `HTTP-Referer` for OpenRouter rankings. |
| `siteName` | `string` | no | `""` | Sent as `X-Title` for OpenRouter rankings. |
| `config` | OpenAI params | no | — | OpenAI-shaped defaults (forwarded to OpenRouter). |
| `retryConfig.timeout` | `number` | no | `60000` | Per-attempt timeout in ms. |
| `retryConfig.retries` | `number` | no | `3` | Total attempts. |

### Example

```typescript
const openrouter = new OpenRouterProvider({
  apiKey: process.env.OPENROUTER_API_KEY!,
  model: "anthropic/claude-sonnet-5",
  backupModels: ["openai/gpt-5.6", "google/gemini-3.1-pro-preview"],
  siteName: "My App",
});
```

## DeepSeekProvider

DeepSeek is OpenAI-compatible and offers powerful reasoning models. The `deepseek-reasoner` model streams thinking/reasoning content via `reasoning_content` on the delta, which is logged at debug level.

### Signature

```typescript
new DeepSeekProvider(options: DeepSeekProviderOptions)

interface DeepSeekProviderOptions {
  apiKey: string;
  model: string;
  backupModels?: string[];
  baseURL?: string;
  config?: Partial<Omit<ChatCompletionCreateParamsNonStreaming, "model" | "messages">>;
  retryConfig?: { timeout?: number; retries?: number };
}
```

### Fields

| Field | Type | Required | Default | Notes |
|-------|------|----------|---------|-------|
| `apiKey` | `string` | yes | — | Throws if empty. |
| `model` | `string` | yes | — | e.g. `"deepseek-chat"`, `"deepseek-reasoner"`. |
| `backupModels` | `string[]` | no | `[]` | Tried in order on overload/rate-limit errors. |
| `baseURL` | `string` | no | `"https://api.deepseek.com"` | Custom endpoint for self-hosted or proxy deployments. |
| `config` | OpenAI params | no | — | OpenAI-shaped defaults (forwarded to DeepSeek). |
| `retryConfig.timeout` | `number` | no | `60000` | Per-attempt timeout in ms. |
| `retryConfig.retries` | `number` | no | `3` | Total attempts. |

### Example

```typescript
const deepseek = new DeepSeekProvider({
  apiKey: process.env.DEEPSEEK_API_KEY!,
  model: "deepseek-chat",
  backupModels: ["deepseek-reasoner"],
  config: { temperature: 0.3 },
});
```

## Building a custom OpenAI-compatible provider

Many vendors (Groq, Together, Fireworks, …) expose OpenAI-compatible chat-completions APIs. Instead of implementing `AiProvider` from scratch, subclass the exported `OpenAICompatibleProvider` base class — history and tool translation, streaming, tool-call assembly, backup-model fallback, retries and normalized `ProviderError`s all come with it. `OpenAIProvider`, `OpenRouterProvider`, and `DeepSeekProvider` are themselves thin subclasses.

A minimal subclass supplies the endpoint, naming, and capabilities:

```typescript
import {
  OpenAICompatibleProvider,
  type ProviderCapabilities,
} from "@falai/agent";

export class GroqProvider extends OpenAICompatibleProvider {
  public readonly name = "groq";
  public readonly capabilities: ProviderCapabilities = {
    supportsTools: true,
    supportsNativeJsonSchema: true,
    supportsStreaming: true,
    supportsStreamingToolCalls: true,
    supportsPromptCaching: false,
  };

  constructor(options: { apiKey: string; model: string; backupModels?: string[] }) {
    super({
      id: "groq",
      apiKey: options.apiKey,
      baseUrl: "https://api.groq.com/openai",
      model: options.model,
      structuredOutput: "json_schema",
      backupModels: options.backupModels,
    });
  }
}
```

That is a complete, working provider. Vendor-specific wire behaviour is not this layer's job any more: it lives in `@providerkit/core`, which the provider classes are thin bindings over. `DeepSeekProvider` is the reference pattern for what is left here — an id, a base URL, the structured-output mode the endpoint actually supports, and its capabilities. To bind a core provider this package does not ship a class for, subclass `ProviderAdapter` directly.

## Errors

All five providers share the same construction-time guards and runtime failure modes.

| When | Error | Why |
|------|-------|-----|
| `apiKey` is empty or missing | `Error("<vendor> API key is required")` | Thrown from the constructor. |
| `model` is empty or missing | `Error("Model is required. ...")` | Thrown from the constructor. |
| Vendor returns no text and no tool calls | `Error("No response from <vendor>")` | Surfaces as a `ResponseGenerationError` once it bubbles through the agent. |
| Primary and every backup model fail | `ProviderError` with a normalized `code` | After exhausting retries and `backupModels`. Propagates bare out of `respond()`. |
| Anthropic streaming with `system: undefined` | Vendor 400 | Set `config.system` or rely on history-derived system messages. |

The retry/backup logic only kicks in for **transient** errors: rate limits, overload and availability, timeouts, and network faults. Deterministic failures — a wrong key, an exhausted balance, an invalid request, a caller's abort — fail fast without burning the retry budget. Classification reads the response BODY before its status, because vendors file the same cause under whatever status they like.

Only failures *before the first chunk* are retried: past that the stream is committed, and a retry would replay text the reader has already seen. The same rule governs the walk to a backup model. `retryConfig.timeout` is the silence deadline — the wait allowed before the first byte, and between any two after it — so a stream that opens and stalls is treated as failed while a long, healthy one is left alone.

A model the endpoint will not serve also walks to the next model on the list, which is what the list is for.

### `ProviderError`

Terminal failures — after retries and backup models are exhausted — throw the exported `ProviderError` with a normalized `code`, so callers handle failures uniformly regardless of which vendor is configured. The original SDK/HTTP error is preserved as `cause`.

```typescript
import { ProviderError } from "@falai/agent";

type ErrorKind =
  | 'aborted'      // the caller pressed Stop — never retried
  | 'timeout'      // our deadline, or a 408
  | 'network'      // never reached the provider
  | 'overload'     // theirs and temporary — retry, and try another model
  | 'rate'         // per-minute throttle — wait, or rotate key or model
  | 'quota'        // balance or usage window exhausted — waiting will not fix it
  | 'entitlement'  // the plan never included this API
  | 'auth'         // the key is wrong, not the request
  | 'model'        // the model id is not served here
  | 'context'      // the prompt outgrew the window — send less
  | 'content'      // safety filter or refusal
  | 'invalid'      // any other 4xx — a bug in what we sent
  | 'unknown'
```

When the failure surfaces through `agent.respond(...)`, the `ProviderError` propagates **bare** — catch it with `instanceof`, no unwrapping. (On streaming turns, errors arrive wrapped as `ResponseGenerationError` on the final chunk's `error` field, with the original on `.cause`.) See [Errors](./errors.md).

## Related

- [Install](../start/01-install.md) — provider signup and env keys
- [Architecture](../concepts/architecture.md) — where the provider sits in the engine
- [createAgent](./create-agent.md) — the `provider` field
- [Persistence adapters](./adapters.md) — the other strategy plug
- [Errors](./errors.md) — `ProviderError`, `ResponseGenerationError`, and friends
- [v2.3 → v2.4 migration](../migration/v2-3-to-v2-4.md) — required `capabilities` and the `ProviderError` change
