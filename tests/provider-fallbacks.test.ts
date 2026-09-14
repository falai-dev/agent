import { describe, expect, test, vi } from "vitest";

import { OpenRouterProvider } from "../src/providers/OpenRouterProvider.js";
import { ZaiProvider } from "../src/providers/ZaiProvider.js";

/**
 * Cross-provider fallbacks ride every leaf provider, not only the anthropic
 * ones: a gateway that cannot route the primary degrades to the plan
 * (or the plan to the gateway) rather than failing the turn. This test
 * scripts the wire for both sides of the walk.
 */

const encoder = new TextEncoder();

function sse(frames: string[]): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) {
          controller.enqueue(encoder.encode(`data: ${frame}\n\n`));
        }
        controller.close();
      },
    }),
  );
}

const zaiOk = () =>
  sse([
    JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 0 } } }),
    JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "plan" } }),
    JSON.stringify({
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { input_tokens: 3, output_tokens: 2 },
    }),
    JSON.stringify({ type: "message_stop" }),
  ]);

describe("cross-provider fallbacks walk to the plan", () => {
  test("OpenRouter primary 404s on its model, Zai answers", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request, _init?: RequestInit) => {
      calls.push(String(url));
      return calls.length === 1
        ? new Response('{"error":{"message":"The model `deepseek/x` does not exist"}}', {
            status: 404,
          })
        : zaiOk();
    }) as typeof fetch;

    const provider = new OpenRouterProvider({
      apiKey: "gateway-key",
      model: "deepseek/x",
      fetchImpl,
      fallbacks: [
        new ZaiProvider({ apiKey: "plan-key", model: "glm-5.3-flash", fetchImpl }),
      ],
    });

    const turn = await provider.generateMessage({
      prompt: "Reply",
      history: [],
      context: undefined,
    });
    expect(turn.message).toBe("plan");
    expect(calls[0]).toContain("openrouter.ai");
    expect(calls[1]).toBe("https://api.z.ai/api/anthropic/v1/messages");
  });
});
