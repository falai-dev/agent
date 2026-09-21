---
title: "Providers"
description: "Every provider class the package exports, the AiProvider interface they implement, and the retry, backup and fallback options they share."
type: reference
order: 15
---

# Providers

A provider is the object the agent talks to the model through. You build one and pass it as `provider` to `f.agent()`; the agent calls it for the understand call and the speak call of every turn. All built-in providers implement the same `AiProvider` interface, so changing vendors is one constructor. There is no vendor SDK behind them: each is a thin binding over [`@providerkit/core`](https://www.npmjs.com/package/@providerkit/core), which speaks every vendor's REST API over `fetch`.

```ts
import { GeminiProvider } from "@falai/agent";

const provider = new GeminiProvider({ apiKey: process.env.GEMINI_API_KEY ?? "", model: "gemini-2.5-flash" });
console.log(provider.name); // "gemini"
```

## The exported providers

| Export | Options type | Talks to | `name` | Structured output |
|--------|--------------|----------|--------|-------------------|
| `GeminiProvider` | `GeminiProviderOptions` | Google Gemini, `generateContent` | `gemini` | native response schema |
| `OpenAIProvider` | `OpenAIProviderOptions` | OpenAI, Responses API | `openai` | native (`responses_parse`) |
| `AnthropicProvider` | `AnthropicProviderOptions` | Anthropic, Messages API | `anthropic` | schema in a system block |
| `OpenRouterProvider` | `OpenRouterProviderOptions` | OpenRouter, chat completions | `openrouter` | native (`json_schema`) |
| `DeepSeekProvider` | `DeepSeekProviderOptions` | DeepSeek, chat completions | `deepseek` | native (`json_schema`) |
| `ZaiProvider` | `ZaiProviderOptions` | Z.ai Coding Plan, Anthropic-compatible | `zai` | schema in a system block |
| `FallbackAiProvider` | `FallbackAiProviderOptions` | an ordered list of the above | `fallback(a->b)` | the list's intersection |
| `createOpenAICompatibleProvider()` | `OpenAICompatibleOptions` | any OpenAI-compatible endpoint | your `name` | `json_schema` by default |
| `OpenAICompatibleProvider` | `OpenAICompatibleProviderInit` | abstract base for the chat-completions dialect | yours | per `structuredOutput` |
| `ProviderAdapter` | `ProviderAdapterInit` | abstract base for any `@providerkit/core` provider | yours | yours |

### Capabilities

Every provider carries `capabilities: ProviderCapabilities`, five flags that describe what the implementation does. From each class in `src/providers/`.

| Flag | Gemini | OpenAI | Anthropic | OpenRouter | DeepSeek | Z.ai | `createOpenAICompatibleProvider` default |
|------|--------|--------|-----------|------------|----------|------|------------------------------------------|
| `supportsTools` | yes | yes | yes | yes | yes | yes | yes |
| `supportsNativeJsonSchema` | yes | yes | no | yes | no | no | yes |
| `supportsStreaming` | yes | yes | yes | yes | yes | yes | yes |
| `supportsStreamingToolCalls` | yes | yes | yes | yes | yes | yes | yes |
| `supportsPromptCaching` | yes | yes | yes | yes | yes | yes | no |

Anthropic has no native schema mode, so the schema is sent as an extra system block after the cached one; Z.ai is Anthropic-compatible and reports the same flag, and DeepSeek serves JSON mode but not a schema. In all three the schema reaches the model as prompt, which is why Gemini's own limit matters: on Gemini 2 a response schema and tools cannot ride the same call (`400 "Function calling with a response mime type: 'application/json' is unsupported"`), so those calls send the schema as prompt too. Gemini 3 takes both. `FallbackAiProvider` reports a flag as true only when every provider in its list does. `createOpenAICompatibleProvider` takes `capabilities` overrides merged over its defaults.

## Options every vendor provider takes

The six vendor classes share these fields. Where a provider adds or renames one, its own section says so.

| Field | Type | Default | Meaning |
|-------|------|---------|---------|
| `apiKey` | `string` | required | The vendor key. An empty string throws at construction. |
| `model` | `string` | required (Z.ai: `glm-5.3-flash`) | The model id. |
| `backupModels` | `string[]` | `[]` | Tried in order on the same provider when a call fails with a kind that is backup-eligible in `@providerkit/core`, or with `model`. |
| `fallbacks` | `Array<AiProvider \| Provider>` | none | Other providers tried after this one fails or is on cooldown. Takes this package's providers and `@providerkit/core` providers alike. |
| `fallbackOptions` | `FallbackOptions<Provider>` | none | Cooldowns per error kind and an `onCooldown` callback for `fallbacks`. Gemini, Anthropic and Z.ai only. |
| `config` | `RequestConfig` | none | Sampling defaults sent with every call: `temperature`, `topP`, `maxTokens`, `stopSequences`, `effort`. |
| `retryConfig` | `{ timeout?: number; retries?: number }` | `{ timeout: 60000, retries: 3 }` | Idle-stream deadline in ms and retries after the first attempt. See [Retries](#retries-backup-models-and-fallbacks). |
| `fetchImpl` | `typeof fetch` | global `fetch` | A replacement `fetch`, for tests that script the wire. |

## GeminiProvider

```ts fragment
interface GeminiProviderOptions {
  apiKey: string;
  model: string;
  backupModels?: string[];
  fallbacks?: Array<AiProvider | Provider>;
  fallbackOptions?: FallbackOptions<Provider>;
  /** Any endpoint speaking the Gemini generateContent dialect. */
  baseUrl?: string;
  jsonWithTools?: "response_format" | "prompt";
  config?: RequestConfig;
  retryConfig?: { timeout?: number; retries?: number };
  fetchImpl?: typeof fetch;
}
```

```ts
import { GeminiProvider } from "@falai/agent";

const gemini = new GeminiProvider({
  apiKey: process.env.GEMINI_API_KEY ?? "",
  model: "gemini-2.5-flash",
  backupModels: ["gemini-2.5-flash-lite"],
  config: { temperature: 0.3 },
});
```

Sends the response schema alongside tools when a call carries both. `jsonWithTools` is explained under [When the model narrates a tool](#when-the-model-narrates-a-tool-instead-of-calling-it).

## OpenAIProvider

```ts fragment
interface OpenAIProviderOptions {
  apiKey: string;
  model: string;
  backupModels?: string[];
  fallbacks?: Array<AiProvider | Provider>;
  /** Sent as the `OpenAI-Organization` header. */
  organization?: string;
  config?: RequestConfig;
  retryConfig?: { timeout?: number; retries?: number };
  fetchImpl?: typeof fetch;
}
```

```ts
import { OpenAIProvider } from "@falai/agent";

const openai = new OpenAIProvider({
  apiKey: process.env.OPENAI_API_KEY ?? "",
  model: "gpt-5.6",
  organization: "org_abc",
});
```

Structured output goes out on the Responses API (`structuredOutput: "responses_parse"`), which enforces the schema natively.

## AnthropicProvider

```ts fragment
interface AnthropicProviderOptions {
  apiKey: string;
  model: string;
  backupModels?: string[];
  fallbacks?: Array<AiProvider | Provider>;
  fallbackOptions?: FallbackOptions<Provider>;
  /** Any endpoint speaking the Anthropic Messages dialect. */
  baseUrl?: string;
  config?: RequestConfig;
  retryConfig?: { timeout?: number; retries?: number };
  fetchImpl?: typeof fetch;
}
```

```ts
import { AnthropicProvider } from "@falai/agent";

const anthropic = new AnthropicProvider({
  apiKey: process.env.ANTHROPIC_API_KEY ?? "",
  model: "claude-sonnet-5",
  config: { maxTokens: 8192 },
});
```

No native schema mode: a structured request carries the schema as a system block placed after the cached one, so a per-call schema does not invalidate the system prompt's cache.

## OpenRouterProvider

```ts fragment
interface OpenRouterProviderOptions {
  apiKey: string;
  model: string;
  backupModels?: string[];
  fallbacks?: Array<AiProvider | Provider>;
  /** Sent as `HTTP-Referer`, for OpenRouter's rankings. */
  siteUrl?: string;
  /** Sent as `X-Title`, for OpenRouter's rankings. */
  siteName?: string;
  /** Preferred upstream hosts, in order; keeps the prompt cache on one host. */
  providerOrder?: string[];
  jsonWithTools?: "response_format" | "prompt";
  config?: RequestConfig;
  retryConfig?: { timeout?: number; retries?: number };
  fetchImpl?: typeof fetch;
}
```

```ts
import { OpenRouterProvider } from "@falai/agent";

const openrouter = new OpenRouterProvider({
  apiKey: process.env.OPENROUTER_API_KEY ?? "",
  model: "anthropic/claude-sonnet-5",
  providerOrder: ["anthropic"],
});
```

Base URL `https://openrouter.ai/api`, chat completions with `json_schema`.

**The upstream host is pinned for you.** OpenRouter's prompt cache lives on the upstream host's account, and default routing hops between hosts, so every hop is a cold cache. By default the model's own vendor is preferred — `z-ai/glm-5.3-flash` goes to `z-ai`, `anthropic/claude-sonnet-5` to `anthropic` — with fallbacks on, so it is a preference and never a failed call. Measured 2026-09-21: unpinned, four calls with the same 2.9k-token prefix all landed on a host that reported `cached: 0`; pinned, the second call read 2,880 of 2,904 tokens from cache.

Pass `providerOrder` to choose the hosts yourself. There is no way to say it inside `model`: OpenRouter answers `400 "z-ai/glm-5.3-flash@novita is not a valid model ID"`.

**The route changes the answers, so measure your own model here.** Through this gateway, `z-ai/glm-5.3-flash` put "somos umas 30 pessoas" in the wrong band of a four-value enum on most attempts, in every JSON mode and routing tried, while the same model on [ZaiProvider](#zaiprovider) and `deepseek-chat` got it right every time. Over the 40-case understand eval on 2026-09-21 the same split holds: routing agreement 93% either way, but field agreement 86% (12/14) through OpenRouter against 100% (14/14) on `ZaiProvider`, and a median call three to five times slower. Prefer a model's own endpoint where you have one; run `bun run eval:understand` and `bun run eval:live --only openrouter` against the model you ship.

## DeepSeekProvider

```ts fragment
interface DeepSeekProviderOptions {
  apiKey: string;
  model: string;
  backupModels?: string[];
  fallbacks?: Array<AiProvider | Provider>;
  /** Default "https://api.deepseek.com". Note the spelling: baseURL. */
  baseURL?: string;
  jsonWithTools?: "response_format" | "prompt";
  config?: RequestConfig;
  retryConfig?: { timeout?: number; retries?: number };
  fetchImpl?: typeof fetch;
}
```

```ts
import { DeepSeekProvider } from "@falai/agent";

const deepseek = new DeepSeekProvider({ apiKey: process.env.DEEPSEEK_API_KEY ?? "", model: "deepseek-chat" });
```

Chat completions with `json_object`: DeepSeek answers a `json_schema` response format with `400 "This response_format type is unavailable now"`, so the endpoint guarantees JSON and the schema travels in the prompt. Reasoning arrives on `reasoning_content` and cache hits under `prompt_cache_hit_tokens`; both are read one layer down.

## ZaiProvider

```ts fragment
interface ZaiProviderOptions {
  apiKey: string;
  /** Default "glm-5.3-flash". Bare ids: "glm-5.3-flash", not "z-ai/glm-5.3-flash". */
  model?: string;
  backupModels?: string[];
  fallbacks?: Array<AiProvider | Provider>;
  fallbackOptions?: FallbackOptions<Provider>;
  /** Any endpoint speaking the Anthropic Messages dialect with the plan's auth. Default: the coding endpoint. */
  baseUrl?: string;
  config?: RequestConfig;
  retryConfig?: { timeout?: number; retries?: number };
  fetchImpl?: typeof fetch;
}
```

```ts
import { ZaiProvider } from "@falai/agent";

const zai = new ZaiProvider({ apiKey: process.env.ZAI_API_KEY ?? "" }); // model defaults to glm-5.3-flash
```

The flat-rate Z.ai Coding Plan hosts GLM on an Anthropic-compatible endpoint. Model ids are bare, and thinking is off unless you ask for it: the endpoint reads an absent `thinking` field as thinking on, so `@providerkit/core` says "no" out loud for you. Measured 2026-09-21: a call with no `config.effort` sends `thinking: { type: "disabled" }`, the same body `effort: "none"` produces. Ask for thinking with `config: { effort: "high" }`.

## FallbackAiProvider

Runs an ordered list of providers. Each call goes to the first provider not on cooldown; a failure puts that provider on cooldown for a time chosen by the error's `kind` and moves on to the next. Cooldowns are remembered across calls, so a key that hit a weekly quota is not tried again a second later.

```ts fragment
interface FallbackAiProviderOptions {
  /** The ordered list of providers to try. The first is primary. */
  providers: AiProvider[];
  /** Cooldown per error kind in ms; null stops fallback for that kind. */
  cooldownMs?: Partial<Record<ErrorKind, number | null>>;
  /** Called when a provider enters cooldown. */
  onCooldown?: (info: { candidate: AiProvider; error: unknown; kind: ErrorKind; retryAtMs: number }) => void;
}

class FallbackAiProvider implements AiProvider {
  readonly name: string;                    // "fallback(zai->gemini)"
  readonly capabilities: ProviderCapabilities;
  readonly pool: FallbackPool<AiProvider>;  // from @providerkit/core
  constructor(options: FallbackAiProviderOptions);
}
```

```ts
import { FallbackAiProvider, GeminiProvider, ZaiProvider } from "@falai/agent";

const provider = new FallbackAiProvider({
  providers: [
    new ZaiProvider({ apiKey: process.env.ZAI_API_KEY ?? "" }),
    new GeminiProvider({ apiKey: process.env.GEMINI_API_KEY ?? "", model: "gemini-2.5-flash" }),
  ],
  onCooldown: ({ candidate, kind, retryAtMs }) => console.warn(candidate.name, kind, new Date(retryAtMs)),
});
console.log(provider.name); // "fallback(zai->gemini)"
```

An empty `providers` list throws at construction. The difference from a provider's own `fallbacks` option: `FallbackAiProvider` works on whole `AiProvider` objects and keeps its pool on `.pool`; `fallbacks` folds the chain into one `@providerkit/core` provider inside the adapter.

## createOpenAICompatibleProvider

Most endpoints that call themselves OpenAI-compatible (Azure OpenAI, Groq, Together, Fireworks, vLLM, LM Studio, Ollama, a gateway of your own) differ from OpenAI only in base URL, headers, and how they want structured output requested. This builds a provider from those settings alone.

```ts fragment
interface OpenAICompatibleOptions {
  /** Names the provider in errors and logs: "azure", "ollama", "groq". */
  name: string;
  baseURL: string;
  /** Local servers often ignore it; pass any non-empty string. */
  apiKey: string;
  model: string;
  backupModels?: string[];
  fallbacks?: Array<AiProvider | Provider>;
  /** Merged over the defaults (all true except supportsPromptCaching). */
  capabilities?: Partial<ProviderCapabilities>;
  /** Extra request headers, e.g. Azure's `api-key`. */
  defaultHeaders?: Record<string, string>;
  /** Default "json_schema". */
  structuredOutput?: "responses_parse" | "json_schema" | "json_object";
  jsonWithTools?: "response_format" | "prompt";
  config?: RequestConfig;
  retryConfig?: { timeout?: number; retries?: number };
  fetchImpl?: typeof fetch;
}

function createOpenAICompatibleProvider(options: OpenAICompatibleOptions): OpenAICompatibleProvider;
```

```ts
import { createOpenAICompatibleProvider } from "@falai/agent";

const ollama = createOpenAICompatibleProvider({
  name: "ollama",
  baseURL: "http://localhost:11434/v1",
  apiKey: "ollama",
  model: "llama3.3",
});

const azure = createOpenAICompatibleProvider({
  name: "azure",
  baseURL: `https://${process.env.AZURE_RESOURCE}.openai.azure.com/openai/deployments/${process.env.AZURE_DEPLOYMENT}`,
  apiKey: process.env.AZURE_OPENAI_KEY ?? "",
  model: process.env.AZURE_DEPLOYMENT ?? "",
  defaultHeaders: { "api-key": process.env.AZURE_OPENAI_KEY ?? "" },
});
console.log(ollama.name, azure.name);
```

`structuredOutput` decides how a structured request is sent:

| Mode | What goes out | Use when |
|------|---------------|----------|
| `responses_parse` | OpenAI's Responses API, schema enforced natively | The endpoint is OpenAI itself. Most compatible servers do not implement it. |
| `json_schema` | Chat completions with a `json_schema` response format | The broadest enforced mode: DeepSeek, Groq, Together, Fireworks, vLLM. The default here. |
| `json_object` | Chat completions with plain JSON mode | Servers with no schema enforcement at all. The framework reads what comes back leniently. |

Missing `name`, `baseURL`, `apiKey` or `model` throws at construction. For behaviour these settings do not cover, subclass `OpenAICompatibleProvider`.

## OpenAICompatibleProvider

The abstract base every chat-completions provider extends: `OpenAIProvider`, `OpenRouterProvider`, `DeepSeekProvider` and the class behind `createOpenAICompatibleProvider`. A subclass names itself and its capabilities; the base picks the request shape from `structuredOutput` (default `responses_parse`) and hands everything else to `ProviderAdapter`.

```ts fragment
interface OpenAICompatibleProviderInit extends Omit<ProviderAdapterInit, "provider"> {
  apiKey: string;
  baseUrl?: string;
  /** Names the provider in errors, and picks core's effort dialect. */
  id: string;
  headers?: Record<string, string>;
  config?: RequestConfig;
  structuredOutput?: StructuredOutputMode;
  jsonWithTools?: JsonWithTools;
  /** OpenRouter upstream-host pin. */
  providerOrder?: string[];
  fetchImpl?: typeof fetch;
}

abstract class OpenAICompatibleProvider extends ProviderAdapter {
  protected readonly config?: RequestConfig;
  protected constructor(init: OpenAICompatibleProviderInit);
}
```

```ts
import { OpenAICompatibleProvider } from "@falai/agent";
import type { ProviderCapabilities } from "@falai/agent";

class GatewayProvider extends OpenAICompatibleProvider {
  readonly name = "gateway";
  readonly capabilities: ProviderCapabilities = {
    supportsTools: true,
    supportsNativeJsonSchema: true,
    supportsStreaming: true,
    supportsStreamingToolCalls: true,
    supportsPromptCaching: false,
  };

  constructor(apiKey: string, model: string) {
    super({ id: "gateway", apiKey, baseUrl: "https://llm.example.com/v1", model, structuredOutput: "json_schema" });
  }
}

const gateway = new GatewayProvider(process.env.GATEWAY_KEY ?? "", "glm-5.3-flash");
console.log(gateway.name);
```

## ProviderAdapter

The base class every built-in provider extends. `@providerkit/core` returns normalized stream chunks; this framework works in whole turns: a composed prompt plus history in, a parsed structured reply out. `ProviderAdapter` does that translation once, for every vendor, and adds retries, backup models and fallbacks around it. `generateMessage` is `generateMessageStream` drained, so both paths behave the same.

```ts fragment
interface ProviderAdapterInit {
  /** The @providerkit/core provider this adapter drives. */
  provider: Provider;
  model: string;
  /** Sampling defaults for every call. */
  defaults?: RequestConfig;
  /** Tried in order after the primary. */
  backupModels?: string[];
  fallbacks?: Array<AiProvider | Provider>;
  fallbackOptions?: FallbackOptions<Provider>;
  retryConfig?: { timeout?: number; retries?: number };
}

interface RequestConfig {
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  stopSequences?: string[];
  /** "none" | "low" | "medium" | "high" | "max". Absent: the model's own default, never sent. */
  effort?: Effort;
}

interface RetryConfig {
  /** Milliseconds a stream may stay silent before it counts as wedged. */
  timeout: number;
  /** Retries after the first attempt; 0 still makes one call. */
  retries: number;
}

function resolveRetryConfig(input?: { timeout?: number; retries?: number }): RetryConfig;

abstract class ProviderAdapter implements AiProvider {
  abstract readonly name: string;
  abstract readonly capabilities: ProviderCapabilities;
  protected readonly provider: Provider;
  protected readonly primaryModel: string;
  protected readonly backupModels: string[];
  protected readonly retryConfig: RetryConfig;
  get coreProvider(): Provider;
  protected constructor(init: ProviderAdapterInit);
  probeJsonWithTools(opts?: ProbeOptions): Promise<JsonWithToolsProbe>;
  generateMessage<C, S>(input: GenerateMessageInput<C>): Promise<GenerateMessageOutput<S>>;
  generateMessageStream<C, S>(input: GenerateMessageInput<C>): AsyncGenerator<GenerateMessageStreamChunk<S>>;
}
```

A subclass supplies a `@providerkit/core` provider and a name. Only `@falai/agent` symbols appear below, so the core provider arrives already built:

```ts
import { ProviderAdapter, resolveRetryConfig } from "@falai/agent";
import type { ProviderAdapterInit, ProviderCapabilities } from "@falai/agent";

declare const core: ProviderAdapterInit["provider"]; // e.g. createOpenAIProvider(...) from @providerkit/core

class MyProvider extends ProviderAdapter {
  readonly name = "mine";
  readonly capabilities: ProviderCapabilities = {
    supportsTools: true,
    supportsNativeJsonSchema: true,
    supportsStreaming: true,
    supportsStreamingToolCalls: true,
    supportsPromptCaching: false,
  };

  constructor() {
    super({ provider: core, model: "my-model", backupModels: ["my-smaller-model"], retryConfig: { retries: 1 } });
  }
}

console.log(resolveRetryConfig({ retries: 1 })); // { timeout: 60000, retries: 1 }
console.log(resolveRetryConfig({ timeout: 0 })); // { timeout: 60000, retries: 3 }: a 0 ms timeout would abort every call, so it is treated as unset
console.log(new MyProvider().name);
```

What the adapter does on every call, from `src/providers/ProviderAdapter.ts`:

1. Turns `history` plus the prompt into the provider's messages. The prompt is always the final user message.
2. Turns `tools` into tool definitions and `parameters.jsonSchema` into a JSON output request named `parameters.schemaName` (or `structured_output`). An empty schema means no JSON mode.
3. Merges `defaults`, then `parameters.maxOutputTokens` as `maxTokens` and `parameters.reasoning.effort` as `effort`.
4. Streams with a silence watchdog of `retryConfig.timeout` ms and `retryConfig.retries + 1` attempts, then moves to the next backup model when the error kind allows.
5. Folds the chunks: text becomes `delta` chunks, tool call fragments are assembled and their arguments parsed, usage lands on `metadata` (`tokensUsed`, `promptTokens`, `completionTokens`, `cachedInputTokens`).
6. Parses the accumulated text leniently into `structured`. Text that looks like an envelope but did not parse is dropped rather than handed to the customer. A message that is blank after parsing, with no tool calls, throws `Error: No response from <provider>` — after the retries and backup models, so the caller's path (a deferred speak step, or the host replaying the turn) is what picks it up. A stream that never produced any content is caught earlier, inside the retry, as a `ProviderError` of kind `overload`.

## Retries, backup models and fallbacks

Three layers, innermost first. All from `src/providers/ProviderAdapter.ts` and `@providerkit/core`.

| Layer | Option | What triggers it | What it does |
|-------|--------|------------------|--------------|
| Retry | `retryConfig` | A transient error (`timeout`, `network`, `overload`, `rate`), or silence for `timeout` ms. Default `timeout: 60000`, `retries: 3`, so up to 4 attempts. | Same model, same provider. `timeout: 0` is treated as unset; `retries: 0` is honoured. |
| Backup model | `backupModels` | Retries exhausted with a backup-eligible kind, or `kind === "model"` (the endpoint does not serve that id). | Next model on the list, same provider. |
| Fallback | `fallbacks` (per provider) or `FallbackAiProvider` | The provider fails or is on cooldown. | Next provider. Cooldowns per `kind`; a server-supplied `Retry-After` always wins over the default interval. |

The `timeout` bounds silence, not the whole call: a stream that keeps producing tokens is left alone, one that goes quiet for 60 s is cut and retried.

## Reasoning

```ts fragment
interface ReasoningConfig {
  effort?: "none" | "low" | "medium" | "high" | "max";
}
```

`GenerateMessageInput.parameters.reasoning` is on the interface for a custom caller, but the framework never sets it. The one way to reach the wire is `config.effort` on a provider, which the adapter sends with every call as the provider's default. Absent means the model's own dynamic thinking and is never sent; `"none"` is the only way to say do not think. It matters most under a small `maxTokens`, where thinking tokens and the answer share one budget. Support varies per model; an unsupported level comes back as a 400 (`kind: "invalid"`).

## The AiProvider interface

What a provider must implement, from `src/types/ai.ts`. The built-in providers, `FallbackAiProvider` and the test mock all satisfy it.

```ts fragment
interface AiProvider {
  readonly name: string;
  capabilities: ProviderCapabilities;
  generateMessage<TContext = unknown, TStructured = AgentStructuredResponse>(
    input: GenerateMessageInput<TContext>,
  ): Promise<GenerateMessageOutput<TStructured>>;
  generateMessageStream<TContext = unknown, TStructured = AgentStructuredResponse>(
    input: GenerateMessageInput<TContext>,
  ): AsyncGenerator<GenerateMessageStreamChunk<TStructured>>;
}

interface GenerateMessageInput<TContext = unknown> {
  prompt: string;
  history: HistoryItem[];
  context: TContext;
  tools?: Array<{ id: string; name?: string; description?: string; parameters?: unknown }>;
  parameters?: {
    maxOutputTokens?: number;
    reasoning?: ReasoningConfig;
    jsonSchema: { [key: string]: unknown };
    schemaName?: string;
  };
  signal?: AbortSignal;
}

interface GenerateMessageOutput<TStructured = AgentStructuredResponse> {
  message: string;
  metadata?: { model?: string; tokensUsed?: number; finishReason?: string; [key: string]: unknown };
  structured?: TStructured;
}

interface GenerateMessageStreamChunk<TStructured = AgentStructuredResponse> {
  delta: string;
  accumulated: string;
  done: boolean;
  metadata?: { model?: string; tokensUsed?: number; finishReason?: string; [key: string]: unknown };
  /** Only on the chunk with done: true. */
  structured?: TStructured;
}

interface ProviderCapabilities {
  supportsTools: boolean;
  supportsNativeJsonSchema: boolean;
  supportsStreaming: boolean;
  supportsStreamingToolCalls: boolean;
  supportsPromptCaching: boolean;
}
```

### What the framework sends

Every call carries `parameters.jsonSchema` and a `schemaName`, so a custom provider can tell the calls apart and log them. From `src/core/Understand.ts`, `src/core/Speak.ts` and `src/core/CompactionEngine.ts`:

| Call | Method | `schemaName` | `tools` | Once per |
|------|--------|--------------|---------|----------|
| Understand | `generateMessage` | `"understand"` | never | message turn with something to judge: two or more flows to route between (counting the one on the floor), a mention flow, a `when` branch on the asking step, or a pending `extract: 'anywhere'` field on the flow on the floor or on a flow with `message` hints. Skipped when none of those is live. |
| Speak | `generateMessage` on `turn()`, `generateMessageStream` on `turnStream()` | `"speak"` | on rounds where tools are offered (`maxToolLoops`, default 5) | talk step or idle answer, plus one call per tool round |
| Compaction summary | `generateMessage` | none, and `jsonSchema` is `{}` | never | turn whose history crossed the compaction threshold, before both calls above |

The framework reads `structured` first. When it is missing it looks for a JSON object inside `message`, so a provider that only returns text still works as long as the text is the envelope. A speak reply whose `message` is blank after the last tool round is treated like a failed call: the step is deferred (see [Errors](./errors.md#where-a-provider-failure-lands-in-a-turn)).

### A custom provider

The shortest useful one wraps another provider and logs which call it is. The two methods are generic; declare the type parameters and pass them through.

```ts
import { falai, GeminiProvider } from "@falai/agent";
import type { AiProvider, GenerateMessageInput } from "@falai/agent";

function logged(inner: AiProvider): AiProvider {
  const tag = (input: GenerateMessageInput<unknown>): string => input.parameters?.schemaName ?? "unnamed";
  return {
    name: `logged(${inner.name})`,
    capabilities: inner.capabilities,
    generateMessage<C, S>(input: GenerateMessageInput<C>) {
      console.log(`[${tag(input)}] ${input.prompt.length} chars, ${input.tools?.length ?? 0} tools`);
      return inner.generateMessage<C, S>(input);
    },
    generateMessageStream<C, S>(input: GenerateMessageInput<C>) {
      console.log(`[${tag(input)}] streaming`);
      return inner.generateMessageStream<C, S>(input);
    },
  };
}

const f = falai().fields({ nome: { type: "string", ask: "Pergunte o nome." } });
const agent = f.agent({
  name: "Ana",
  provider: logged(new GeminiProvider({ apiKey: process.env.GEMINI_API_KEY ?? "", model: "gemini-2.5-flash" })),
  flows: [f.flow({ id: "oi", name: "Oi", on: [{ message: [] }], steps: [{ id: "nome", collect: ["nome"] }] })],
});

const r = await agent.turn({ sessionId: "s1", message: "oi" });
console.log(r.llmCalls); // logs "[speak] …" once: one flow with no routing hints and nobody on the floor, so no understand call
```

## When the model narrates a tool instead of calling it

Every turn the framework sends pins the model's output to a schema, because that is how `message` and the step's fields come back. Some models cannot emit a tool call while pinned that way. They do not report it: the model writes "deixa eu ver aqui" and stops. On the wire the call succeeded; in the product the agent never uses its tools, and no instruction fixes it.

`jsonWithTools` on `GeminiProvider`, `OpenRouterProvider`, `DeepSeekProvider`, `createOpenAICompatibleProvider` and `OpenAICompatibleProviderInit` decides how the schema is sent on calls that also carry tools:

- `"response_format"` sends both, which every wire documents and most models honour.
- `"prompt"` leaves the response format off those calls and puts the schema in the prompt instead. Calls without tools are untouched.

The answer belongs to the model, not the endpoint, and it goes both ways. The code's own measurements, sampled on 2026-09-07. Each cell is the samples where the model called its tool:

| Model | Response format | Prompt |
|-------|-----------------|--------|
| `z-ai/glm-5.3-flash` (OpenRouter) | 0/10 | 8/8 |
| `qwen3.8-flash` (OpenRouter) | 10/10 | 1/6 |
| DeepSeek's flash models | 0/5 | not sampled |
| `gemini-3.8-flash` | 3/10 | not sampled |
| `gemini-3.5-flash`, `gemini-3.5-flash-lite` | every call | not sampled |

Do not pick from that list. Ask the model you ship.

### The probe

Every `ProviderAdapter` subclass has `probeJsonWithTools(opts?)`. It asks the bound model, on the wire, both ways, and reports which shape called the tool on every sample.

```ts fragment
interface JsonWithToolsProbe {
  /** The shape to configure, or null when neither called the tool on every sample. */
  use: "response_format" | "prompt" | null;
  /** Samples that produced a tool call, per shape. */
  calls: Record<"response_format" | "prompt", number>;
  samples: number;
}

interface ProbeOptions {
  /** Samples per shape. Default 3. */
  samples?: number;
  /** Probe a model other than the bound one. */
  model?: string;
  signal?: AbortSignal;
}
```

```ts
import { OpenRouterProvider } from "@falai/agent";

const apiKey = process.env.OPENROUTER_API_KEY ?? "";
const model = "z-ai/glm-5.3-flash";

const probe = await new OpenRouterProvider({ apiKey, model }).probeJsonWithTools();
console.log(probe.calls); // e.g. { response_format: 0, prompt: 3 }
if (!probe.use) throw new Error(`${model} cannot call a tool while pinned to a schema; pick another model`);

const provider = new OpenRouterProvider({ apiKey, model, jsonWithTools: probe.use });
console.log(provider.name);
```

Run it once, at boot. It costs `samples × 2` short calls (6 by default), and errors propagate: a probe that swallowed a bad key would report "this model cannot call tools", which is worse to believe than "the call failed". Log `calls`, not just `use`; `0/3 and 3/3` is what makes the next model swap's regression obvious. The probe catches the structural failure, a model that cannot emit the call on the easiest question there is; a model that is merely unreliable passes it.

## See also

- [Install](../start/01-install.md): getting a key and running an example.
- [Agent](./agent.md): the `provider` option and the rest of `AgentOptions`.
- [Pipeline](../concepts/pipeline.md): where the understand and speak calls sit in a turn and what each costs.
- [Errors](./errors.md): `ProviderError`, its kinds, and where a failure lands in a turn.
- [Streaming](../guides/streaming.md): `turnStream` and what `generateMessageStream` must yield.
- [Testing](../guides/testing.md): a scripted `AiProvider` that answers by `schemaName`.
