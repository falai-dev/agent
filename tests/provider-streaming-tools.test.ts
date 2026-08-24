/**
 * Streamed tool-call accumulation — regression tests for the wire-format bugs
 * where one streamed tool call became N broken entries:
 *  - OpenAI-compatible providers push every argument fragment separately
 *    unless deltas are accumulated by their `index`;
 *  - Anthropic sends tool arguments as input_json_delta fragments AFTER
 *    content_block_start (which always carries an empty input object).
 *
 * The SDK clients are replaced with canned-chunk stubs (`as unknown as …`) so
 * the real accumulation code paths run against realistic wire sequences.
 */
import { describe, expect, test } from "bun:test";

import { OpenAICompatibleProvider } from "../src/providers/OpenAICompatibleProvider";
import {
  createOpenAICompatibleProvider,
} from "../src/providers/GenericOpenAICompatibleProvider";
import { AnthropicProvider } from "../src/providers/AnthropicProvider";
import type { GenerateMessageInput } from "../src/types/ai";

function baseInput(): GenerateMessageInput<undefined> {
  return { prompt: "hi", history: [], context: undefined };
}

describe("OpenAI-compatible streamed tool-call accumulation", () => {
  test("fragments split across chunks merge into ONE call with full arguments", async () => {
    const provider = createOpenAICompatibleProvider({
      name: "stub",
      baseURL: "http://localhost/v1",
      apiKey: "k",
      model: "stub-model",
    });

    const chunks = [
      {
        model: "stub-model",
        choices: [
          { index: 0, delta: { role: "assistant", content: "" }, finish_reason: null },
        ],
      },
      {
        model: "stub-model",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_1",
                  type: "function",
                  function: { name: "get_weather", arguments: "" },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        model: "stub-model",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, function: { arguments: '{"city":"São' } }],
            },
            finish_reason: null,
          },
        ],
      },
      {
        model: "stub-model",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, function: { arguments: ' Paulo"}' } }],
            },
            finish_reason: null,
          },
        ],
      },
      {
        model: "stub-model",
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
      },
    ];

    // Replace the SDK client with a stub replaying the canned chunks.
    (
      provider as unknown as {
        client: { chat: { completions: { create: unknown } } };
      }
    ).client = {
      chat: {
        completions: {
          // Async generator: `await` on a generator object is a no-op, and the
          // provider iterates it directly.
          create: async function* () {
            for (const chunk of chunks) yield chunk;
          },
        },
      },
    };

    let last;
    for await (const chunk of provider.generateMessageStream(baseInput())) {
      last = chunk;
    }

    expect(last?.done).toBe(true);
    expect(last?.structured?.toolCalls).toEqual([
      { toolName: "get_weather", arguments: { city: "São Paulo" } },
    ]);
  });

  test("two interleaved calls stay separate and ordered", async () => {
    const provider = createOpenAICompatibleProvider({
      name: "stub",
      baseURL: "http://localhost/v1",
      apiKey: "k",
      model: "stub-model",
    });

    const fragment = (
      index: number,
      fn?: { name?: string; arguments?: string }
    ) => ({
      model: "stub-model",
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ index, function: fn }] },
          finish_reason: null,
        },
      ],
    });

    const chunks = [
      fragment(0, { name: "tool_a", arguments: "" }),
      fragment(1, { name: "tool_b", arguments: '{"n":' }),
      fragment(0, { arguments: '{"a":1}' }),
      fragment(1, { arguments: "2}" }),
      {
        model: "stub-model",
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      },
    ];

    (
      provider as unknown as {
        client: { chat: { completions: { create: unknown } } };
      }
    ).client = {
      chat: {
        completions: {
          create: async function* () {
            for (const chunk of chunks) yield chunk;
          },
        },
      },
    };

    let last;
    for await (const chunk of provider.generateMessageStream(baseInput())) {
      last = chunk;
    }

    expect(last?.structured?.toolCalls).toEqual([
      { toolName: "tool_a", arguments: { a: 1 } },
      { toolName: "tool_b", arguments: { n: 2 } },
    ]);
  });
});

describe("Anthropic streamed tool-call accumulation", () => {
  test("input_json_delta fragments assemble into full arguments", async () => {
    const provider = new AnthropicProvider({
      apiKey: "test-key",
      model: "claude-test",
    });

    const events = [
      {
        type: "message_start",
        message: { model: "claude-test", usage: { input_tokens: 10 } },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Checking." },
      },
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "tu_1", name: "get_weather", input: {} },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"city":' },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '"Paris"}' },
      },
      {
        type: "message_delta",
        delta: { stop_reason: "tool_use" },
        usage: { output_tokens: 5 },
      },
    ];

    (
      provider as unknown as {
        client: { messages: { stream: unknown } };
      }
    ).client = {
      messages: {
        // Returns an awaitable async-iterable of raw stream events, exactly
        // what the real SDK's MessageStream exposes to for-await consumers.
        stream: async function* () {
          for (const event of events) yield event;
        },
      },
    };

    let last;
    for await (const chunk of provider.generateMessageStream(baseInput())) {
      last = chunk;
    }

    expect(last?.done).toBe(true);
    expect(last?.structured?.toolCalls).toEqual([
      { toolName: "get_weather", arguments: { city: "Paris" } },
    ]);
  });
});
