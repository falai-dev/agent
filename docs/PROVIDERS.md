# AI Providers Guide

This guide covers the available AI providers and how to configure them for optimal performance.

## Overview

`@falai/agent` uses a **strategy pattern** for AI providers, allowing you to:

- ✅ Switch between different AI providers easily
- ✅ Configure provider-specific settings
- ✅ Use backup models for failover
- ✅ Customize retry logic and timeouts
- ⚡ **Stream responses in real-time** (all providers)

## Streaming Support

**All providers support real-time streaming** via the `respondStream()` method on the Agent class.

Streaming provides:

- 🌊 Real-time text generation for better UX
- 📊 Incremental delivery with `delta` and `accumulated` properties
- 🛑 Cancellable streams using AbortSignal
- ✅ Full compatibility with routes, steps, and tool calls

**Example:**

```typescript
for await (const chunk of agent.respondStream({ history })) {
  process.stdout.write(chunk.delta); // Print incremental text

  if (chunk.done) {
    // Access final metadata
    console.log("Route:", chunk.route?.title);
    console.log("Tool calls:", chunk.toolCalls?.length);
  }
}
```

See [streaming-agent.ts](../examples/streaming-agent.ts) for comprehensive examples with all providers.

---

## Available Providers

### 🤖 Anthropic (Claude)

**Package:** `@anthropic-ai/sdk`

#### Overview

Anthropic's Claude models are known for their exceptional reasoning, analysis, and long context windows. Claude 3.5 Sonnet offers:

- Step-of-the-art reasoning and analysis
- 200K context window
- Excellent at following complex instructions
- Strong coding and writing capabilities

#### Installation

```bash
bun add @anthropic-ai/sdk
# or
npm install @anthropic-ai/sdk
```

#### Basic Usage

```typescript
import { AnthropicProvider } from "@falai/agent";

const provider = new AnthropicProvider({
  apiKey: process.env.ANTHROPIC_API_KEY!,
  model: "claude-sonnet-4-5", // Latest Claude 4.5 Sonnet
});
```

#### Configuration Options

All models are specified by the user - see [Anthropic Models](https://docs.anthropic.com/en/docs/models-overview) for available options.

```typescript
const provider = new AnthropicProvider({
  // Required
  apiKey: string;
  model: string; // e.g., "claude-sonnet-4-5", "claude-opus-4-1", etc.

  // Optional
  backupModels?: string[]; // Default: []
  config?: Partial<Omit<MessageCreateParamsNonStreaming, "model" | "messages" | "max_tokens">>; // Uses @anthropic-ai/sdk types
  retryConfig?: {
    timeout?: number; // Default: 60000ms (60s)
    retries?: number; // Default: 3
  };
});
```

#### Example: Advanced Configuration

```typescript
const provider = new AnthropicProvider({
  apiKey: process.env.ANTHROPIC_API_KEY!,
  model: "claude-sonnet-4-5",
  backupModels: ["claude-opus-4-1", "claude-sonnet-4-0"],
  config: {
    temperature: 0.7,
    top_p: 0.9,
  },
  retryConfig: {
    timeout: 45000,
    retries: 2,
  },
});
```

---

### 🌐 OpenRouter (Multi-Model Access)

**Package:** `openai` (OpenRouter uses OpenAI-compatible API)

#### Overview

OpenRouter provides access to 200+ AI models through a single unified API, including models from OpenAI, Anthropic, Google, Meta, and more. Perfect for:

- Access to multiple model providers
- Cost optimization through model selection
- Fallback across different providers
- Comparing model performance

#### Installation

```bash
bun add openai
# or
npm install openai
```

#### Basic Usage

```typescript
import { OpenRouterProvider } from "@falai/agent";

const provider = new OpenRouterProvider({
  apiKey: process.env.OPENROUTER_API_KEY!,
  model: "openai/gpt-5", // Required - specify your model
  siteUrl: "https://yourapp.com", // Optional: for rankings
  siteName: "Your App Name", // Optional: for rankings
});
```

#### Configuration Options

All models are specified by the user - see https://openrouter.ai/models for the full list.

```typescript
const provider = new OpenRouterProvider({
  // Required
  apiKey: string;
  model: string; // e.g., "openai/gpt-5", "anthropic/claude-sonnet-4.5", etc.

  // Optional
  backupModels?: string[]; // Default: []
  siteUrl?: string; // Your app URL for OpenRouter rankings
  siteName?: string; // Your app name for OpenRouter rankings
  config?: Partial<Omit<ChatCompletionCreateParamsNonStreaming, "model" | "messages">>; // Uses openai package types
  retryConfig?: {
    timeout?: number; // Default: 60000ms (60s)
    retries?: number; // Default: 3
  };
});
```

#### Example: Custom Configuration

```typescript
const provider = new OpenRouterProvider({
  apiKey: process.env.OPENROUTER_API_KEY!,
  model: "anthropic/claude-sonnet-4.5",
  backupModels: ["openai/gpt-5", "google/gemini-2.5-flash"],
  siteUrl: "https://myapp.com",
  siteName: "My AI Agent",
  config: {
    temperature: 0.7,
    max_tokens: 2048,
    top_p: 0.9,
  },
  retryConfig: {
    timeout: 45000,
    retries: 2,
  },
});
```

---

### 🤖 Gemini (Google AI)

**Package:** `@google/genai`

#### Installation

```bash
bun add @google/genai
# or
npm install @google/genai
```

#### Basic Usage

```typescript
import { GeminiProvider } from "@falai/agent";

const provider = new GeminiProvider({
  apiKey: process.env.GEMINI_API_KEY!,
  model: "models/gemini-2.5-pro", // Required - specify your model
});
```

#### Configuration Options

All models are specified by the user - check [Google AI Studio](https://ai.google.dev/) for available models.

```typescript
const provider = new GeminiProvider({
  // Required
  apiKey: string;
  model: string; // e.g., "models/gemini-2.5-pro", "models/gemini-2.5-flash", etc.

  // Optional
  backupModels?: string[]; // Default: []
  config?: Partial<GenerateContentConfig>; // Uses @google/genai package types
  retryConfig?: {
    timeout?: number; // Default: 60000ms (60s)
    retries?: number; // Default: 3
  };
});
```

#### Example: Advanced Configuration

```typescript
const provider = new GeminiProvider({
  apiKey: process.env.GEMINI_API_KEY!,
  model: "models/gemini-2.5-pro",
  backupModels: ["models/gemini-2.5-flash"],
  config: {
    thinkingConfig: {
      includeThoughts: false,
      thinkingBudget: 8192,
    },
  },
  retryConfig: {
    timeout: 45000,
    retries: 2,
  },
});
```

---

### 🧠 OpenAI

**Package:** `openai`

#### Installation

```bash
bun add openai
# or
npm install openai
```

#### Basic Usage

```typescript
import { OpenAIProvider } from "@falai/agent";

const provider = new OpenAIProvider({
  apiKey: process.env.OPENAI_API_KEY!,
  model: "gpt-5", // Required - specify your model
});
```

#### Configuration Options

All models are specified by the user - see [OpenAI Models](https://platform.openai.com/docs/models) for available options.

```typescript
const provider = new OpenAIProvider({
  // Required
  apiKey: string;
  model: string; // e.g., "gpt-5", "gpt-5-mini", etc.

  // Optional
  organization?: string;
  backupModels?: string[]; // Default: []
  config?: Partial<Omit<ChatCompletionCreateParamsNonStreaming, "model" | "messages">>; // Uses openai package types
  retryConfig?: {
    timeout?: number; // Default: 60000ms (60s)
    retries?: number; // Default: 3
  };
});
```

#### Example: Advanced Configuration

```typescript
const provider = new OpenAIProvider({
  apiKey: process.env.OPENAI_API_KEY!,
  model: "gpt-5",
  backupModels: ["gpt-5-mini"],
  config: {
    temperature: 0.7,
    max_tokens: 2048,
    top_p: 0.9,
  },
  retryConfig: {
    timeout: 45000,
    retries: 2,
  },
});
```

---

## Retry & Backup Logic

Both providers implement **robust retry logic** with:

### Automatic Retries

- ⏱️ Exponential backoff between retries
- ⚙️ Configurable timeout and retry count
- 🔄 Automatic fallback to backup models

### When Backup Models Are Used

Backup models are automatically tried when:

- ❌ Primary model returns 500 (Internal Server Error)
- ❌ Primary model returns 503 (Service Unavailable)
- ❌ Primary model returns 429 (Rate Limit)
- ❌ Model is overloaded or unavailable
- ❌ Request times out

### Example: Backup Flow

```typescript
const provider = new OpenAIProvider({
  apiKey: process.env.OPENAI_API_KEY!,
  model: "gpt-5", // Primary
  backupModels: [
    "gpt-5-mini", // Try first
    "gpt-5-nano", // Try second
  ],
  retryConfig: {
    timeout: 30000,
    retries: 2,
  },
});

// If gpt-5 fails with 500 error:
// 1. Retry gpt-5 (up to 2 times with exponential backoff)
// 2. If still failing, try gpt-5-mini
// 3. If that fails, try gpt-5-nano
// 4. If all fail, throw error
```

---

## Switching Providers

You can easily switch between providers:

```typescript
import {
  Agent,
  AnthropicProvider,
  GeminiProvider,
  OpenAIProvider,
  OpenRouterProvider,
} from "@falai/agent";

// Use Anthropic (Claude)
const claudeAgent = new Agent({
  name: "Claude Assistant",
  ai: new AnthropicProvider({
    apiKey: process.env.ANTHROPIC_API_KEY!,
    model: "claude-sonnet-4-5",
  }),
});

// Use Gemini
const geminiAgent = new Agent({
  name: "Gemini Assistant",
  ai: new GeminiProvider({
    apiKey: process.env.GEMINI_API_KEY!,
    model: "models/gemini-2.5-flash",
  }),
});

// Use OpenAI
const openaiAgent = new Agent({
  name: "OpenAI Assistant",
  ai: new OpenAIProvider({
    apiKey: process.env.OPENAI_API_KEY!,
    model: "gpt-5",
  }),
});

// Use OpenRouter (access to 200+ models)
const openrouterAgent = new Agent({
  name: "OpenRouter Assistant",
  ai: new OpenRouterProvider({
    apiKey: process.env.OPENROUTER_API_KEY!,
    model: "anthropic/claude-sonnet-4-5",
  }),
});

// All agents have the same interface!
```

---

## Environment Variables

It's recommended to store API keys in environment variables:

```bash
# .env
ANTHROPIC_API_KEY=your-anthropic-api-key-here
GEMINI_API_KEY=your-gemini-api-key-here
OPENAI_API_KEY=your-openai-api-key-here
OPENROUTER_API_KEY=your-openrouter-api-key-here
```

Then load them:

```typescript
import { config } from "dotenv";
config();

const anthropicProvider = new AnthropicProvider({
  apiKey: process.env.ANTHROPIC_API_KEY!,
  model: "claude-sonnet-4-5",
});

const geminiProvider = new GeminiProvider({
  apiKey: process.env.GEMINI_API_KEY!,
  model: "models/gemini-2.5-flash",
});

const openaiProvider = new OpenAIProvider({
  apiKey: process.env.OPENAI_API_KEY!,
  model: "gpt-5",
});

const openrouterProvider = new OpenRouterProvider({
  apiKey: process.env.OPENROUTER_API_KEY!,
  model: "anthropic/claude-sonnet-4-5",
});
```

---

## Custom Providers

Want to add a custom provider? Implement the `AiProvider` interface:

```typescript
import {
  AiProvider,
  GenerateMessageInput,
  GenerateMessageOutput,
} from "@falai/agent";

export class CustomProvider implements AiProvider {
  public readonly name = "custom";

  async generateMessage<TContext = unknown>(
    input: GenerateMessageInput<TContext>
  ): Promise<GenerateMessageOutput> {
    // Your implementation here
    const response = await yourApiCall(input.prompt);

    return {
      message: response.text,
      metadata: {
        model: "your-model",
        tokensUsed: response.tokens,
      },
    };
  }
}
```

See the [API Reference](./API_REFERENCE.md) for the full `AiProvider` interface definition.

---

## Best Practices

### 1. Use Environment-Specific Configs

```typescript
const isDev = process.env.NODE_ENV === "development";

const provider = new GeminiProvider({
  apiKey: process.env.GEMINI_API_KEY!,
  model: isDev ? "models/gemini-2.5-flash" : "models/gemini-2.5-pro",
  retryConfig: {
    timeout: isDev ? 10000 : 60000,
    retries: isDev ? 1 : 3,
  },
});
```

### 2. Configure Backup Models by Use Case

```typescript
// For critical production apps
const productionProvider = new OpenAIProvider({
  apiKey: process.env.OPENAI_API_KEY!,
  model: "gpt-5-pro",
  backupModels: ["gpt-5", "gpt-5-mini"], // More capable backups
});

// For high-volume, low-cost
const volumeProvider = new OpenAIProvider({
  apiKey: process.env.OPENAI_API_KEY!,
  model: "gpt-5-mini",
  backupModels: ["gpt-5-nano"], // Faster, cheaper model
});
```

### 3. Monitor Provider Performance

```typescript
const response = await agent.generateMessage(input);

console.log(`Model used: ${response.metadata?.model}`);
console.log(`Tokens used: ${response.metadata?.tokensUsed}`);
console.log(`Finish reason: ${response.metadata?.finishReason}`);
```

---

## Troubleshooting

### API Key Not Found

```
Error: apiKey is required
```

**Solution:** Ensure your environment variable is set correctly:

```typescript
if (!process.env.GEMINI_API_KEY) {
  throw new Error("GEMINI_API_KEY environment variable is required");
}
```

### Rate Limit Errors

```
Error: 429 Too Many Requests
```

**Solution:** Configure retry logic and backup models:

```typescript
const provider = new OpenAIProvider({
  apiKey: process.env.OPENAI_API_KEY!,
  model: "gpt-5",
  backupModels: ["gpt-5-mini"], // Fallback to cheaper model
  retryConfig: {
    retries: 5, // More retries
    timeout: 90000, // Longer timeout
  },
});
```

### Timeout Errors

```
Error: Operation timed out after 60000ms
```

**Solution:** Increase timeout or reduce max tokens:

```typescript
const provider = new GeminiProvider({
  apiKey: process.env.GEMINI_API_KEY!,
  model: "models/gemini-2.5-pro",
  config: {
    // No max_tokens parameter needed for Gemini
  },
  retryConfig: {
    timeout: 120000, // 2 minutes
  },
});
```

---

## Next Steps

- 📖 [Getting Started](./GETTING_STARTED.md) - Build your first agent
- 🔧 [API Reference](./API_REFERENCE.md) - Full API documentation
- 📝 [Examples](../examples/) - Real-world examples
