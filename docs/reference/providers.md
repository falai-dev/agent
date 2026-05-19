---
title: "Providers"
description: "Strategy classes that connect an Agent to Gemini, OpenAI, Anthropic, or OpenRouter."
type: reference
order: 10
---

# Providers

> **Where this is introduced:** [Install](../start/01-install.md)

Providers are the strategy plug between an `Agent` and a model vendor. Every provider implements the same `AiProvider` interface, so the Agent itself stays vendor-agnostic. Pass an instance to `createAgent({ provider })` and the agent talks to that vendor for every turn (and for compaction, if you wire it in).

`@falai/agent` ships four built-in providers. All four accept an `apiKey` and a required `model`, support `backupModels` for automatic failover on overload or 5xx, and accept a vendor-typed `config` object that flows through to the underlying SDK.

| Provider | Class | Options | SDK |
|----------|-------|---------|-----|
| Google Gemini | `GeminiProvider` | `GeminiProviderOptions` | `@google/genai` |
| OpenAI | `OpenAIProvider` | `OpenAIProviderOptions` | `openai` |
| Anthropic Claude | `AnthropicProvider` | `AnthropicProviderOptions` | `@anthropic-ai/sdk` |
| OpenRouter | `OpenRouterProvider` | `OpenRouterProviderOptions` | `openai` (compat) |

## Use with createAgent

`createAgent({ provider })` accepts any class that implements `AiProvider`. Swap providers by changing the constructor; nothing else in your agent has to move.

```typescript
import {
  createAgent,
  GeminiProvider,
  OpenAIProvider,
  AnthropicProvider,
  OpenRouterProvider,
} from "@falai/agent";

const provider =
  process.env.PROVIDER === "openai"
    ? new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY!, model: "gpt-5-mini" })
    : process.env.PROVIDER === "anthropic"
    ? new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY!, model: "claude-sonnet-4-5" })
    : process.env.PROVIDER === "openrouter"
    ? new OpenRouterProvider({ apiKey: process.env.OPENROUTER_API_KEY!, model: "anthropic/claude-sonnet-4.5" })
    : new GeminiProvider({ apiKey: process.env.GEMINI_API_KEY!, model: "models/gemini-2.5-pro" });

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
  config?: Partial<GenerateContentConfig>; // from @google/genai
  retryConfig?: { timeout?: number; retries?: number };
}
```

### Fields

| Field | Type | Required | Default | Notes |
|-------|------|----------|---------|-------|
| `apiKey` | `string` | yes | — | Throws if empty. |
| `model` | `string` | yes | — | Use the fully-qualified id, e.g. `"models/gemini-2.5-pro"`. |
| `backupModels` | `string[]` | no | `[]` | Tried in order on 429/500/503/overload errors. |
| `config` | `Partial<GenerateContentConfig>` | no | — | Vendor-typed defaults (e.g. `temperature`, `systemInstruction`). |
| `retryConfig.timeout` | `number` | no | `60000` | Per-attempt timeout in ms. |
| `retryConfig.retries` | `number` | no | `3` | Total attempts before giving up. |

### Example

```typescript
const gemini = new GeminiProvider({
  apiKey: process.env.GEMINI_API_KEY!,
  model: "models/gemini-2.5-pro",
  backupModels: ["models/gemini-2.5-flash"],
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
| `model` | `string` | yes | — | e.g. `"gpt-5"`, `"gpt-5-mini"`. |
| `backupModels` | `string[]` | no | `[]` | Tried in order on overload/rate-limit errors. |
| `config` | OpenAI params | no | — | Defaults for `temperature`, `top_p`, etc. |
| `retryConfig.timeout` | `number` | no | `60000` | Per-attempt timeout in ms. |
| `retryConfig.retries` | `number` | no | `3` | Total attempts. |

### Example

```typescript
const openai = new OpenAIProvider({
  apiKey: process.env.OPENAI_API_KEY!,
  model: "gpt-5-mini",
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
}
```

### Fields

| Field | Type | Required | Default | Notes |
|-------|------|----------|---------|-------|
| `apiKey` | `string` | yes | — | Throws if empty. |
| `model` | `string` | yes | — | e.g. `"claude-sonnet-4-5"`, `"claude-opus-4-1"`. |
| `backupModels` | `string[]` | no | `[]` | Tried in order on 429/500/503/529/overload. |
| `config` | Anthropic params | no | — | Defaults for `max_tokens`, `system`, etc. The provider sets `max_tokens=4096` if neither `config.max_tokens` nor `parameters.maxOutputTokens` is set. |
| `retryConfig.timeout` | `number` | no | `60000` | Per-attempt timeout in ms. |
| `retryConfig.retries` | `number` | no | `3` | Total attempts. |

### Example

```typescript
const anthropic = new AnthropicProvider({
  apiKey: process.env.ANTHROPIC_API_KEY!,
  model: "claude-sonnet-4-5",
  config: { max_tokens: 8192 },
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
| `model` | `string` | yes | — | OpenRouter model id, e.g. `"anthropic/claude-sonnet-4.5"`. See [openrouter.ai/models](https://openrouter.ai/models). |
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
  model: "anthropic/claude-sonnet-4.5",
  backupModels: ["openai/gpt-5-mini", "google/gemini-2.5-pro"],
  siteName: "My App",
});
```

## Errors

All four providers share the same construction-time guards and runtime failure modes.

| When | Error | Why |
|------|-------|-----|
| `apiKey` is empty or missing | `Error("<vendor> API key is required")` | Thrown from the constructor. |
| `model` is empty or missing | `Error("Model is required. ...")` | Thrown from the constructor. |
| Vendor returns no text and no tool calls | `Error("No response from <vendor>")` | Surfaces as a `ResponseGenerationError` once it bubbles through the agent. |
| Primary and every backup model fail | The last backup error is rethrown | After exhausting `backupModels`. The agent wraps it in `ResponseGenerationError`. |
| Anthropic streaming with `system: undefined` | Vendor 400 | Set `config.system` or rely on history-derived system messages. |

The retry/backup logic only kicks in for transient errors: HTTP 429 / 500 / 503 (and 529 for Anthropic), `overloaded`-style codes, or messages containing `overloaded`, `unavailable`, `internal error`, or (OpenRouter only) `capacity`. Other errors fail fast.

## Related

- [Install](../start/01-install.md) — provider signup and env keys
- [Architecture](../concepts/architecture.md) — where the provider sits in the engine
- [createAgent](./create-agent.md) — the `provider` field
- [Persistence adapters](./adapters.md) — the other strategy plug
- [Errors](./errors.md) — `ResponseGenerationError` and friends
