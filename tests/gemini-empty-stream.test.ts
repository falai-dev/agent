/**
 * GeminiProvider streaming empty-completion guard
 *
 * Regression tests for the bug where the streaming path silently emitted an
 * empty message while the non-streaming path threw "No response" and retried.
 * Covers both a genuinely empty completion and a valid-JSON-but-blank
 * structured message ({"message":""}).
 */
import { expect, test, describe } from "bun:test";

import { GeminiProvider } from "../src/providers/GeminiProvider";

/**
 * Minimal fake of the @google/genai surface the provider touches. Justification
 * for the cast below: GeminiProvider constructs its SDK client internally, so a
 * test double injected after construction is the only way to drive the
 * empty-completion path without a live API. Production code never reassigns it.
 */
function makeProvider(streamFactory: () => AsyncGenerator<unknown>): GeminiProvider {
  const provider = new GeminiProvider({
    apiKey: "test-key",
    model: "gemini-test",
    backupModels: [],
    // retries:0 disables retries (now honored — the provider uses `?? DEFAULT`,
    // no longer clobbering a falsy 0), so the empty completion throws at once
    // with no backoff.
    retryConfig: { retries: 0, timeout: 5000 },
  });
  const fakeGenAI = {
    models: {
      generateContentStream: async () => streamFactory(),
      generateContent: async () => ({ candidates: [] }),
    },
  };
  (provider as unknown as { genAI: typeof fakeGenAI }).genAI = fakeGenAI;
  return provider;
}

async function drain(gen: AsyncGenerator<unknown>): Promise<void> {
  for await (const _chunk of gen) {
    /* consume */
  }
}

const jsonSchema = {
  type: "object",
  properties: { message: { type: "string" } },
} as const;

describe("GeminiProvider streaming empty-completion guard", () => {
  test("throws when the stream yields no content and no tool calls", async () => {
    const provider = makeProvider(async function* () {
      /* yields nothing — a genuinely empty completion */
    });
    await expect(
      drain(provider.generateMessageStream({ prompt: "hi", history: [] }))
    ).rejects.toThrow("No response from Gemini");
  });

  test('throws on a valid-JSON but blank structured message ({"message":""})', async () => {
    const provider = makeProvider(async function* () {
      yield { candidates: [{ content: { parts: [{ text: '{"message":""}' }] } }] };
    });
    await expect(
      drain(
        provider.generateMessageStream({
          prompt: "hi",
          history: [],
          parameters: { jsonSchema },
        })
      )
    ).rejects.toThrow("No response from Gemini");
  });

  test("does NOT throw when the stream yields a real message", async () => {
    const provider = makeProvider(async function* () {
      yield { candidates: [{ content: { parts: [{ text: '{"message":"hello"}' }] } }] };
    });
    const chunks: unknown[] = [];
    for await (const chunk of provider.generateMessageStream({
      prompt: "hi",
      history: [],
      parameters: { jsonSchema },
    })) {
      chunks.push(chunk);
    }
    expect(chunks.length).toBeGreaterThan(0);
  });
});
