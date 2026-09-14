import { describe, expect, it, vi } from "vitest";
import { FallbackAiProvider } from "../src/providers/FallbackAiProvider.js";
import { ProviderError } from "../src/types/errors.js";
import type {
  AgentStructuredResponse,
  AiProvider,
  GenerateMessageInput,
  GenerateMessageOutput,
  GenerateMessageStreamChunk,
  ProviderCapabilities,
} from "../src/types/ai.js";

function mockProvider(name: string, failCount = 0): AiProvider & { calls: number } {
  const capabilities: ProviderCapabilities = {
    supportsTools: true,
    supportsNativeJsonSchema: true,
    supportsStreaming: true,
    supportsStreamingToolCalls: true,
    supportsPromptCaching: true,
  };

  let callCount = 0;

  return {
    name,
    capabilities,
    get calls() {
      return callCount;
    },
    async generateMessage<TContext = unknown, TStructured = AgentStructuredResponse>(
      _input: GenerateMessageInput<TContext>,
    ): Promise<GenerateMessageOutput<TStructured>> {
      callCount++;
      if (callCount <= failCount) {
        throw new ProviderError(name, "rate", `${name} rate limit reached`, {
          retryAfterMs: 60_000,
        });
      }
      return {
        message: `Hello from ${name}`,
      } as GenerateMessageOutput<TStructured>;
    },
    async *generateMessageStream<TContext = unknown, TStructured = AgentStructuredResponse>(
      _input: GenerateMessageInput<TContext>,
    ): AsyncGenerator<GenerateMessageStreamChunk<TStructured>> {
      callCount++;
      if (callCount <= failCount) {
        throw new ProviderError(name, "rate", `${name} rate limit reached`, {
          retryAfterMs: 60_000,
        });
      }
      yield {
        delta: `Hello from ${name}`,
        accumulated: `Hello from ${name}`,
        done: true,
      } as GenerateMessageStreamChunk<TStructured>;
    },
  };
}

describe("FallbackAiProvider", () => {
  it("falls back to secondary provider on failure and remembers cooldown", async () => {
    const p1 = mockProvider("primary", 100);
    const p2 = mockProvider("secondary", 0);

    const fallback = new FallbackAiProvider({
      providers: [p1, p2],
    });

    const res1 = await fallback.generateMessage({
      prompt: "hi",
      history: [],
      context: {},
    });
    expect(res1.message).toBe("Hello from secondary");
    expect(p1.calls).toBe(1);
    expect(p2.calls).toBe(1);

    // Next call: primary is cooled down, so it goes directly to secondary
    const res2 = await fallback.generateMessage({
      prompt: "hi 2",
      history: [],
      context: {},
    });
    expect(res2.message).toBe("Hello from secondary");
    expect(p1.calls).toBe(1); // Not called again!
    expect(p2.calls).toBe(2);
  });

  it("streams from backup provider properly", async () => {
    const p1 = mockProvider("primary", 100);
    const p2 = mockProvider("secondary", 0);

    const fallback = new FallbackAiProvider({
      providers: [p1, p2],
    });

    const chunks: string[] = [];
    for await (const chunk of fallback.generateMessageStream({
      prompt: "hi",
      history: [],
      context: {},
    })) {
      if (chunk.delta) chunks.push(chunk.delta);
    }
    expect(chunks).toEqual(["Hello from secondary"]);
  });
});
