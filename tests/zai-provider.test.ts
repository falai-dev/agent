import { afterEach, describe, expect, test, vi } from "vitest";

import { ZaiProvider } from "../src/providers/ZaiProvider.js";

/**
 * The coding endpoint's dialect, pinned at THIS package's boundary: Bearer on
 * the Anthropic wire, bare model ids, and "no thinking" as an explicit marker
 * (silence means the model default, which is ON). The adapter semantics live
 * in @providerkit/core and are tested there; these tests prove the binding.
 */

const frames = [
  JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 0 } } }),
  JSON.stringify({
    type: "content_block_start",
    index: 0,
    content_block: { type: "text" },
  }),
  JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } }),
  JSON.stringify({
    type: "message_delta",
    delta: { stop_reason: "end_turn" },
    usage: { input_tokens: 3, output_tokens: 2 },
  }),
  JSON.stringify({ type: "message_stop" }),
];

function wireFetch() {
  return vi.fn<typeof fetch>().mockResolvedValue(
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          for (const frame of frames) {
            controller.enqueue(encoder.encode(`data: ${frame}\n\n`));
          }
          controller.close();
        },
      }),
    ),
  );
}

afterEach(() => vi.restoreAllMocks());

describe("ZaiProvider", () => {
  test("sends to the coding endpoint with Bearer auth and the default workhorse model", async () => {
    const fetchImpl = wireFetch();
    const provider = new ZaiProvider({ apiKey: "plan-key", fetchImpl });

    const turn = await provider.generateMessage({ prompt: "Reply OK", history: [], context: undefined });
    expect(turn.message).toBe("OK");

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://api.z.ai/api/anthropic/v1/messages");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer plan-key");
    expect(headers.has("x-api-key")).toBe(false);
    // The default model is the fleet workhorse — bare id, no gateway prefix.
    expect(JSON.parse(String(init?.body)).model).toBe("glm-5.3-flash");
  });

  test("says no-thinking out loud: silence would mean the model default, which is ON", async () => {
    const fetchImpl = wireFetch();
    const provider = new ZaiProvider({ apiKey: "plan-key", fetchImpl });

    await provider.generateMessage({ prompt: "Reply OK", history: [], context: undefined });
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)).thinking).toEqual({
      type: "disabled",
    });
  });
});
