# AI Provider Integrations

@falai/agent provides unified interfaces for multiple AI providers, enabling seamless switching between models and automatic fallback handling.

## Supported Providers

### OpenAI Provider

Full-featured integration with GPT models, including backup model support and structured outputs.

```typescript
import { OpenAIProvider } from "@falai/agent";

const provider = new OpenAIProvider({
  apiKey: process.env.OPENAI_API_KEY,
  model: "gpt-5",
  backupModels: ["gpt-4"], // Fallback models
  config: {
    temperature: 0.7,
    max_tokens: 1000,
  },
  retryConfig: {
    timeout: 30000,
    retries: 3,
  },
});
```

**Features:**

- ✅ GPT-4, GPT-5, and all OpenAI models
- ✅ Backup model fallback on failures
- ✅ Structured outputs with JSON Schema
- ✅ Tool calling support
- ✅ Streaming responses
- ✅ Automatic retry logic

### Google Gemini Provider

Integration with Google's Gemini models through Vertex AI or AI Studio.

```typescript
import { GeminiProvider } from "@falai/agent";

const provider = new GeminiProvider({
  apiKey: process.env.GEMINI_API_KEY,
  model: "gemini-pro",
  config: {
    safetySettings: [
      {
        category: "HARM_CATEGORY_HARASSMENT",
        threshold: "BLOCK_MEDIUM_AND_ABOVE",
      },
    ],
  },
});
```

**Features:**

- ✅ Gemini 2.0, 2.5 Pro, and Flash models
- ✅ Safety settings and content filtering
- ✅ Multimodal capabilities (text, images)
- ✅ Function calling support
- ✅ Streaming responses

### Anthropic Claude Provider

Integration with Anthropic's Claude models via their API.

```typescript
import { AnthropicProvider } from "@falai/agent";

const provider = new AnthropicProvider({
  apiKey: process.env.ANTHROPIC_API_KEY,
  model: "claude-sonnet-4.5",
  config: {
    maxTokens: 4096,
    temperature: 0.7,
  },
});
```

**Features:**

- ✅ Claude 4 Opus, Sonnet, and Haiku
- ✅ Constitutional AI safety
- ✅ Excellent reasoning capabilities
- ✅ Tool calling support
- ✅ Streaming responses

### OpenRouter Provider

Unified access to multiple AI models through OpenRouter's API.

```typescript
import { OpenRouterProvider } from "@falai/agent";

const provider = new OpenRouterProvider({
  apiKey: process.env.OPENROUTER_API_KEY,
  model: "anthropic/claude-sonnet-4",
  siteUrl: "https://your-app.com",
  siteName: "Your App Name",
});
```

**Features:**

- ✅ Access to 100+ AI models
- ✅ Unified pricing and billing
- ✅ Automatic model routing
- ✅ Fallback model support
- ✅ Streaming responses

## Provider Configuration

### Common Options

All providers support these configuration options:

```typescript
interface BaseProviderOptions {
  model: string; // Primary model to use
  backupModels?: string[]; // Fallback models on failure
  temperature?: number; // Response randomness (0-2)
  maxTokens?: number; // Maximum response length
  timeout?: number; // Request timeout in ms
  retries?: number; // Number of retry attempts
}
```

### Advanced Configuration

```typescript
const provider = new OpenAIProvider({
  apiKey: process.env.OPENAI_API_KEY,
  model: "gpt-5",

  // Model-specific parameters
  config: {
    temperature: 0.1, // Low randomness for consistent responses
    top_p: 0.9, // Nucleus sampling
    frequency_penalty: 0.1, // Reduce repetition
    presence_penalty: 0.1, // Encourage topic diversity
    max_tokens: 2048,
  },

  // Fallback configuration
  backupModels: [
    "gpt-4.1", // Try GPT-4 if turbo fails
    "gpt-4", // Final fallback
  ],

  // Retry configuration
  retryConfig: {
    timeout: 60000, // 60 second timeout
    retries: 3, // Retry up to 3 times
  },
});
```

## Unified Interface

All providers implement the same interface:

```typescript
interface AiProvider {
  name: string;

  // Synchronous response generation
  generateMessage(input: GenerateMessageInput): Promise<GenerateMessageOutput>;

  // Streaming response generation
  generateMessageStream(
    input: GenerateMessageInput
  ): AsyncGenerator<GenerateMessageStreamChunk>;
}
```

### Input Format

```typescript
interface GenerateMessageInput<TContext = unknown> {
  prompt: string; // The prompt to send
  history: Event[]; // Conversation history
  context?: TContext; // Additional context data
  tools?: ToolDefinition[]; // Available tools
  parameters?: {
    jsonSchema?: StructuredSchema; // Response schema
    schemaName?: string; // Schema identifier
    maxOutputTokens?: number; // Token limit
    reasoning?: { effort: "low" | "medium" | "high" };
  };
  signal?: AbortSignal; // Cancellation support
}
```

### Output Format

```typescript
interface GenerateMessageOutput<TStructured = AgentStructuredResponse> {
  message: string; // Main response text
  metadata: {
    model: string; // Model used
    tokensUsed: number; // Total tokens consumed
    promptTokens: number; // Input tokens
    completionTokens: number; // Output tokens
    finishReason?: string; // Why generation stopped
  };
  structured?: TStructured; // Structured data if schema provided
}
```

## Tool Calling Support

All providers support tool calling with consistent interfaces:

```typescript
const input: GenerateMessageInput = {
  prompt: "What's the weather in Paris?",
  history: conversationHistory,
  tools: [
    {
      id: "get_weather",
      description: "Get current weather for a location",
      parameters: {
        type: "object",
        properties: {
          location: { type: "string", description: "City name" },
        },
        required: ["location"],
      },
    },
  ],
};

const response = await provider.generateMessage(input);

// Check for tool calls
if (response.structured?.toolCalls) {
  for (const toolCall of response.structured.toolCalls) {
    console.log(`AI wants to call: ${toolCall.toolName}`);
    console.log(`With arguments:`, toolCall.arguments);
  }
}
```

## Streaming Responses

Real-time response generation with chunked output:

```typescript
const stream = provider.generateMessageStream(input);

for await (const chunk of stream) {
  if (chunk.delta) {
    process.stdout.write(chunk.delta); // Real-time output
  }

  if (chunk.done) {
    console.log("\nGeneration complete!");
    console.log("Total tokens:", chunk.metadata?.tokensUsed);
    console.log("Structured data:", chunk.structured);
  }
}
```

## Error Handling & Fallbacks

### Automatic Fallbacks

Providers automatically try backup models on failures:

```typescript
const provider = new OpenAIProvider({
  apiKey: process.env.OPENAI_API_KEY,
  model: "gpt-5",
  backupModels: ["gpt-4.1", "gpt-4"],
});

// If gpt-4 fails (rate limit, server error, etc.)
// Automatically tries gpt-4.1, then gpt-4
const response = await provider.generateMessage(input);
```

### Error Classification

Different error types trigger different fallback behaviors:

```typescript
// Server errors (5xx) → Try backup models
// Rate limits (429) → Try backup models
// Invalid requests (4xx) → Don't retry
// Timeouts → Retry with same model
```

### Custom Error Handling

```typescript
try {
  const response = await provider.generateMessage(input);
} catch (error) {
  if (error.code === "rate_limit_exceeded") {
    // Handle rate limiting
    await delay(60000); // Wait 1 minute
    return retryWithBackoff();
  }

  if (error.code === "model_not_available") {
    // Switch to different provider
    return fallbackProvider.generateMessage(input);
  }

  throw error;
}
```

## Performance Optimization

### Connection Reuse

Reuse provider instances for better performance:

```typescript
// ✅ Good: Reuse provider instance
const provider = new OpenAIProvider({ apiKey, model: "gpt-4" });

const agent1 = new Agent({ provider });
const agent2 = new Agent({ provider }); // Same instance

// ❌ Bad: Create new instance each time
const agent3 = new Agent({
  provider: new OpenAIProvider({ apiKey, model: "gpt-4" }),
});
```

### Request Batching

Group related requests to reduce latency:

```typescript
// Process multiple conversations efficiently
const responses = await Promise.all([
  agent1.respond({ history: history1 }),
  agent2.respond({ history: history2 }),
  agent3.respond({ history: history3 }),
]);
```

### Caching

Cache responses for similar prompts:

```typescript
const cache = new Map();

function getCachedResponse(prompt: string, context: any) {
  const key = hash(`${prompt}-${JSON.stringify(context)}`);
  return cache.get(key);
}

function setCachedResponse(prompt: string, context: any, response: any) {
  const key = hash(`${prompt}-${JSON.stringify(context)}`);
  cache.set(key, response);
}
```

## Monitoring & Observability

### Response Metrics

Track provider performance and usage:

```typescript
const response = await provider.generateMessage(input);

console.log("Provider:", response.metadata?.model);
console.log("Tokens used:", response.metadata?.tokensUsed);
console.log("Prompt tokens:", response.metadata?.promptTokens);
console.log("Completion tokens:", response.metadata?.completionTokens);
console.log("Finish reason:", response.metadata?.finishReason);
```

### Cost Tracking

Monitor API usage costs:

```typescript
const costTracker = {
  openai: {
    "gpt-5": { prompt: 0.03, completion: 0.06 },
    "gpt-4": { prompt: 0.002, completion: 0.002 },
  },
};

function calculateCost(metadata: ResponseMetadata): number {
  const rates = costTracker[metadata.model];
  if (!rates) return 0;

  return (
    ((metadata.promptTokens || 0) * rates.prompt) / 1000 +
    ((metadata.completionTokens || 0) * rates.completion) / 1000
  );
}
```

### Health Monitoring

Track provider availability and latency:

```typescript
const healthChecks = new Map();

async function checkProviderHealth(provider: AiProvider): Promise<boolean> {
  const startTime = Date.now();

  try {
    await provider.generateMessage({
      prompt: "Hello",
      history: [],
    });

    const latency = Date.now() - startTime;
    healthChecks.set(provider.name, { healthy: true, latency });
    return true;
  } catch (error) {
    healthChecks.set(provider.name, { healthy: false, error: error.message });
    return false;
  }
}
```

## Custom Provider Implementation

Create providers for unsupported AI services:

```typescript
import {
  AiProvider,
  GenerateMessageInput,
  GenerateMessageOutput,
} from "@falai/agent";

class CustomProvider implements AiProvider {
  name = "custom";

  async generateMessage(
    input: GenerateMessageInput
  ): Promise<GenerateMessageOutput> {
    // Implement your AI service integration
    const response = await callCustomAI(input.prompt, input.context);

    return {
      message: response.text,
      metadata: {
        model: "custom-model-v1",
        tokensUsed: response.tokens,
        promptTokens: input.prompt.split(" ").length,
        completionTokens: response.text.split(" ").length,
      },
      structured: response.structured,
    };
  }

  async *generateMessageStream(input: GenerateMessageInput) {
    // Implement streaming if supported
    const stream = await callCustomAIStream(input.prompt, input.context);

    for await (const chunk of stream) {
      yield {
        delta: chunk.text,
        accumulated: chunk.fullText,
        done: chunk.finished,
        metadata: chunk.metadata,
      };
    }
  }
}
```

## Best Practices

### Provider Selection

1. **Task Matching**: Choose providers based on task requirements

   - OpenAI GPT-4: Complex reasoning, creative tasks
   - Anthropic Claude: Safety-focused, analytical tasks
   - Google Gemini: Multimodal, fast responses
   - OpenRouter: Cost optimization, model experimentation

2. **Cost Optimization**: Use appropriate models for task complexity

   - Simple tasks: GPT-4.1, Claude Haiku, Gemini Flash
   - Complex tasks: GPT-5, Claude Sonnet, Gemini Pro

3. **Reliability**: Configure backup models for production
   - Always have fallback options
   - Monitor error rates and switch providers if needed

### Configuration

1. **Temperature**: Lower for deterministic tasks, higher for creative
2. **Max Tokens**: Set appropriate limits to control costs
3. **Timeouts**: Configure reasonable timeouts for your use case
4. **Retries**: Enable retries for transient failures

### Monitoring

1. **Track Usage**: Monitor token consumption and costs
2. **Error Rates**: Alert on high error rates
3. **Latency**: Monitor response times
4. **Fallback Usage**: Track how often backup models are used

The AI provider system enables flexible, reliable integration with multiple AI services while maintaining a consistent interface for the @falai/agent framework.
