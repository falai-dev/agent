/**
 * The seam this package still owns.
 *
 * Vendor wire behaviour — SSE framing, each dialect's tool-call shape, thought
 * signatures, cache accounting — moved to `@providerkit/core` and is tested
 * there against recorded bytes, including the mid-frame reads and CRLF splits a
 * real socket produces. Re-testing it from here would only assert that a
 * dependency still works.
 *
 * What is left is the translation: history and a composed prompt going in,
 * an accumulated turn with parsed structured output coming out, and the
 * retry/backup wiring around it. That is what this file covers, driven by a
 * scripted `fetch` so the provider under test is the real one.
 */

import { describe, expect, test } from "bun:test";
import { OpenAIProvider } from "../src/providers/OpenAIProvider.js";
import { OpenRouterProvider } from "../src/providers/OpenRouterProvider.js";
import { DeepSeekProvider } from "../src/providers/DeepSeekProvider.js";
import { AnthropicProvider } from "../src/providers/AnthropicProvider.js";
import { GeminiProvider } from "../src/providers/GeminiProvider.js";
import { toMessages } from "../src/providers/ProviderAdapter.js";
import type { GenerateMessageInput } from "../src/types/ai.js";
import type { HistoryItem } from "../src/types/history.js";

// ── scripted wire ─────────────────────────────────────────────────────────

function sse(frames: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(`data: ${frame}\n\n`));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

/** One canned reply per call, in order. Records every request body. */
function scripted(replies: (() => Response)[]) {
  const bodies: Record<string, unknown>[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(init.body as string) as Record<string, unknown>);
    const next = replies[Math.min(bodies.length - 1, replies.length - 1)];
    return next();
  }) as unknown as typeof fetch;
  return { bodies, fetchImpl };
}

const chat = (...deltas: Record<string, unknown>[]) =>
  sse([
    ...deltas.map((delta) =>
      JSON.stringify({ id: "1", model: "m", choices: [{ index: 0, delta }] }),
    ),
    JSON.stringify({ id: "1", model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
    "[DONE]",
  ]);

const failure = (status: number, body: string) => () => new Response(body, { status });

function input(over: Partial<GenerateMessageInput<undefined>> = {}): GenerateMessageInput<undefined> {
  return { prompt: "What now?", history: [], context: undefined, ...over };
}

const deepseek = (fetchImpl: typeof fetch, over = {}) =>
  new DeepSeekProvider({ apiKey: "k", model: "primary", fetchImpl, ...over });

async function drain(stream: AsyncIterable<{ delta: string }>): Promise<string[]> {
  const out: string[] = [];
  for await (const chunk of stream) if (chunk.delta) out.push(chunk.delta);
  return out;
}

// ── history → messages ────────────────────────────────────────────────────

describe("history becomes the seam's messages", () => {
  test("the composed prompt is always the final user turn", () => {
    const messages = toMessages([{ role: "user", content: "hello" }], "PROMPT");
    expect(messages).toHaveLength(2);
    expect(messages[1]).toEqual({ role: "user", content: "PROMPT" });
  });

  test("an assistant turn's tool calls carry arguments as raw JSON", () => {
    const history: HistoryItem[] = [
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_1", name: "lookup", arguments: { city: "Lisbon" } }],
      },
      { role: "tool", tool_call_id: "call_1", name: "lookup", content: { temp: 19 } },
    ];
    const [assistant, tool] = toMessages(history, "p");

    expect(assistant).toEqual({
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call_1", name: "lookup", arguments: '{"city":"Lisbon"}' }],
    });
    // The pairing needs the NAME as well as the id: Gemini matches a result to
    // its call by name, and has no id to match on.
    expect(tool).toEqual({
      role: "tool",
      toolCallId: "call_1",
      name: "lookup",
      content: '{"temp":19}',
    });
  });

  test("an assistant turn replays the reasoning that produced its tool call", () => {
    const [assistant] = toMessages(
      [
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "c1", name: "lookup", arguments: {} }],
          reasoning: "preciso do clima",
        },
      ],
      "p",
    );
    expect(assistant).toMatchObject({ role: "assistant", reasoning: "preciso do clima" });
  });

  test("system turns stay system turns", () => {
    expect(toMessages([{ role: "system", content: "Be brief." }], "p")[0]).toEqual({
      role: "system",
      content: "Be brief.",
    });
  });
});

// ── chunks → a turn ───────────────────────────────────────────────────────

describe("a stream becomes one accumulated turn", () => {
  test("deltas accumulate and the final chunk carries the whole message", async () => {
    const { fetchImpl } = scripted([() => chat({ content: "Hel" }, { content: "lo" })]);
    const result = await deepseek(fetchImpl).generateMessage(input());
    expect(result.message).toBe("Hello");
  });

  test("streaming and non-streaming run the same path", async () => {
    const { fetchImpl } = scripted([() => chat({ content: "a" }, { content: "b" })]);
    expect(await drain(deepseek(fetchImpl).generateMessageStream(input()))).toEqual(["a", "b"]);
  });

  test("tool-call fragments across chunks assemble into one parsed call", async () => {
    const { fetchImpl } = scripted([
      () =>
        chat(
          { tool_calls: [{ index: 0, id: "c1", function: { name: "lookup", arguments: '{"ci' } }] },
          { tool_calls: [{ index: 0, function: { arguments: 'ty":"Porto"}' } }] },
        ),
    ]);
    const result = await deepseek(fetchImpl).generateMessage(input());
    expect(result.structured?.toolCalls).toEqual([
      { toolName: "lookup", arguments: { city: "Porto" } },
    ]);
  });

  test("arguments cut mid-stream keep the fields that closed", async () => {
    // The stream ends after `city` but inside `note`. Parsed strictly this
    // throws, and the tool used to run with `{}` — a lookup with no city.
    const { fetchImpl } = scripted([
      () =>
        chat({
          tool_calls: [{ index: 0, id: "c1", function: { name: "lookup", arguments: '{"city":"Porto","note":"o cliente di' } }],
        }),
    ]);
    const result = await deepseek(fetchImpl).generateMessage(input());
    // Salvage closes the open string rather than dropping it, so a cut value
    // arrives short instead of absent. The tool's own `validateInput` is what
    // decides whether that is good enough.
    expect(result.structured?.toolCalls).toEqual([
      { toolName: "lookup", arguments: { city: "Porto", note: "o cliente di" } },
    ]);
  });

  test("the reasoning behind a tool call rides out with it", async () => {
    // A thinking provider rejects the next round when the assistant turn that
    // called the tool comes back without its own chain of thought.
    const { fetchImpl } = scripted([
      () =>
        chat(
          { reasoning_content: "preciso do clima " },
          { reasoning_content: "antes de responder" },
          { tool_calls: [{ index: 0, id: "c1", function: { name: "lookup", arguments: "{}" } }] },
        ),
    ]);
    const result = await deepseek(fetchImpl).generateMessage(input());
    expect(result.structured?.reasoning).toBe("preciso do clima antes de responder");
  });

  test("two parallel calls stay distinct and ordered by index", async () => {
    const { fetchImpl } = scripted([
      () =>
        chat({
          tool_calls: [
            { index: 1, id: "b", function: { name: "second", arguments: "{}" } },
            { index: 0, id: "a", function: { name: "first", arguments: "{}" } },
          ],
        }),
    ]);
    const result = await deepseek(fetchImpl).generateMessage(input());
    expect(result.structured?.toolCalls?.map((call) => call.toolName)).toEqual(["first", "second"]);
  });

  test("a schema request asks for JSON, carries the shape as prompt, and parses the reply", async () => {
    const { bodies, fetchImpl } = scripted([() => chat({ content: '{"message":"parsed"}' })]);
    const result = await deepseek(fetchImpl).generateMessage(
      input({
        parameters: {
          jsonSchema: {
            type: "object",
            properties: { message: { type: "string" } },
            required: ["message"],
            additionalProperties: false,
          },
          schemaName: "reply",
        },
      }),
    );
    expect(result.structured).toEqual({ message: "parsed" });
    // DeepSeek answers a `json_schema` format with
    // `400 "This response_format type is unavailable now"`, so the request asks
    // for JSON and the schema travels as prompt instead.
    expect((bodies[0].response_format as { type: string }).type).toBe("json_object");
    const sent = bodies[0].messages as Array<{ role: string; content: string }>;
    expect(sent.at(-1)).toMatchObject({ role: "system", content: expect.stringContaining('"message"') });
  });

  const REPLY_SCHEMA = {
    jsonSchema: {
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
      additionalProperties: false,
    },
    schemaName: "reply",
  };

  test("an envelope with raw newlines inside the message is repaired, not passed on as text", async () => {
    // What a model writes when the schema rode in its PROMPT instead of pinning
    // the decoder: it pretty-prints, and the line breaks land inside the string
    // where JSON forbids them. `JSON.parse` alone gives up here, and the caller
    // then reads the raw envelope as the reply — the 2026-09-11 WhatsApp leak.
    const raw = '{\n"message": "Boa escolha!\n\u00c0 vista: R$ 3.149"\n}';
    const { fetchImpl } = scripted([() => chat({ content: raw })]);

    const result = await deepseek(fetchImpl).generateMessage(input({ parameters: REPLY_SCHEMA }));

    expect(result.structured).toEqual({ message: "Boa escolha!\n\u00c0 vista: R$ 3.149" });
  });

  test("an unreadable envelope is dropped rather than offered as the turn's message", async () => {
    // Beyond repair (the stray quote moves the string boundary). With a tool
    // call in the same turn there is still a way forward — the tool results
    // produce the reply — so the turn survives, but the bytes must not.
    const raw = '{"message": "R$ 3."149, sem fechar';
    const { fetchImpl } = scripted([
      () => chat({ content: raw, tool_calls: [{ index: 0, id: "c1", function: { name: "catalog", arguments: "{}" } }] }),
    ]);

    const result = await deepseek(fetchImpl).generateMessage(input({ parameters: REPLY_SCHEMA }));

    expect(result.structured?.message).toBe("");
    expect(result.message).toBe("");
    expect(result.structured?.toolCalls?.[0]?.toolName).toBe("catalog");
  });

  test("an unreadable envelope with nothing to fall back on fails the turn", async () => {
    const { fetchImpl } = scripted([() => chat({ content: '{"message": "R$ 3."149, sem fechar' })]);

    await expect(
      deepseek(fetchImpl).generateMessage(input({ parameters: REPLY_SCHEMA })),
    ).rejects.toThrow(/No response from/);
  });

  test("a plain-text preamble beside a tool call is still the message", async () => {
    const { fetchImpl } = scripted([
      () => chat({
        content: "Deixa eu ver aqui.",
        tool_calls: [{ index: 0, id: "c1", function: { name: "catalog", arguments: "{}" } }],
      }),
    ]);

    const result = await deepseek(fetchImpl).generateMessage(input({ parameters: REPLY_SCHEMA }));

    expect(result.structured?.message).toBe("Deixa eu ver aqui.");
  });

  test("jsonWithTools reaches the wire, and only changes the calls carrying tools", async () => {
    // A response format pins the decoder, and on some models a pinned decoder
    // cannot emit a tool call at all — so the model narrates the call it could
    // not make and the turn ends with nothing logged. Measured 2026-09-07:
    // z-ai/glm-5.3-flash called its tool 0/10 this way and 8/8 without the
    // format. Whether a model needs it is the model's answer, not ours, which
    // is why it is a setting the caller passes down rather than a rule here.
    const schema = {
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
      additionalProperties: false,
    };
    const sent = async (tools?: GenerateMessageInput<undefined>["tools"]) => {
      const { bodies, fetchImpl } = scripted([() => chat({ content: '{"message":"ok"}' })]);
      await new OpenRouterProvider({
        apiKey: "k",
        model: "z-ai/glm-5.3-flash",
        jsonWithTools: "prompt",
        fetchImpl,
      }).generateMessage(input({ ...(tools ? { tools } : {}), parameters: { jsonSchema: schema } }));
      return bodies[0];
    };

    const withTools = await sent([{ id: "search", name: "search", description: "look it up" }]);
    expect(withTools.response_format).toBeUndefined();
    // The schema still reaches the model, the one way nothing can suppress.
    expect(JSON.stringify(withTools.messages)).toContain("message");

    // No tools on the call, no bet to lose: the enforced schema rides as always.
    expect((await sent()).response_format).toMatchObject({ type: "json_schema" });
  });

  // Compaction asks for a summary with `jsonSchema: {}` — meaning "no schema".
  // Sent as one it becomes a json_schema block with no type, which is a 400.
  test("an empty schema asks for no JSON mode at all", async () => {
    const { bodies, fetchImpl } = scripted([() => chat({ content: "a summary" })]);
    const result = await deepseek(fetchImpl).generateMessage(
      input({ parameters: { jsonSchema: {} } }),
    );
    expect(bodies[0].response_format).toBeUndefined();
    expect(result.message).toBe("a summary");
  });
});

// ── failure handling ──────────────────────────────────────────────────────

describe("what happens when a turn fails", () => {
  test("a turn that completes having said nothing is a failure, not an answer", async () => {
    const { fetchImpl } = scripted([() => chat()]);
    await expect(
      deepseek(fetchImpl, { retryConfig: { retries: 0 } }).generateMessage(input()),
    ).rejects.toThrow();
  });

  test("a throttle retries the same model and recovers", async () => {
    const { bodies, fetchImpl } = scripted([
      failure(429, "slow down"),
      () => chat({ content: "second time" }),
    ]);
    const result = await deepseek(fetchImpl).generateMessage(input());
    expect(result.message).toBe("second time");
    expect(bodies).toHaveLength(2);
  });

  test("a bad key fails fast — one attempt despite the budget", async () => {
    const { bodies, fetchImpl } = scripted([failure(401, "bad key")]);
    await expect(deepseek(fetchImpl).generateMessage(input())).rejects.toThrow();
    expect(bodies).toHaveLength(1);
  });

  test("an overloaded primary falls through to the backup model", async () => {
    const { bodies, fetchImpl } = scripted([
      failure(503, "overloaded"),
      () => chat({ content: "from the backup" }),
    ]);
    // retries: 0 is one attempt per model, so the walk is visible rather than
    // buried under a retry budget.
    const provider = deepseek(fetchImpl, { backupModels: ["backup"], retryConfig: { retries: 0 } });
    const result = await provider.generateMessage(input());
    expect(result.message).toBe("from the backup");
    expect(bodies.at(-1)?.model).toBe("backup");
  });

  // A model the endpoint will not serve is what the backup list is FOR. Core's
  // own default is narrower on purpose; this package widens it.
  test("a model the gateway will not serve walks to the backup", async () => {
    const { bodies, fetchImpl } = scripted([
      failure(404, '{"error":{"message":"The model `primary` does not exist"}}'),
      () => chat({ content: "from the backup" }),
    ]);
    const provider = deepseek(fetchImpl, { backupModels: ["backup"] });
    expect((await provider.generateMessage(input())).message).toBe("from the backup");
    expect(bodies.at(-1)?.model).toBe("backup");
  });
});

// ── the same adapter, a second wire ───────────────────────────────────────

describe("the adapter is not the OpenAI dialect wearing a hat", () => {
  test("Anthropic answers through the identical seam", async () => {
    const frames = [
      JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 5 } } }),
      JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text" } }),
      JSON.stringify({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Claude here" },
      }),
      JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" } }),
      JSON.stringify({ type: "message_stop" }),
    ];
    const { bodies, fetchImpl } = scripted([() => sse(frames)]);
    const provider = new AnthropicProvider({ apiKey: "k", model: "claude", fetchImpl });
    const result = await provider.generateMessage(
      input({ history: [{ role: "system", content: "Be brief." }] }),
    );

    expect(result.message).toBe("Claude here");
    expect(result.metadata?.promptTokens).toBe(5);
    expect(bodies[0].system).toBeDefined();
  });

  test("OpenAI structured output goes out on the Responses wire", async () => {
    const { bodies, fetchImpl } = scripted([
      () =>
        sse([
          JSON.stringify({
            type: "response.output_text.delta",
            delta: '{"message":"ok"}',
          }),
          JSON.stringify({ type: "response.completed", response: { model: "gpt" } }),
        ]),
    ]);
    const provider = new OpenAIProvider({ apiKey: "k", model: "gpt", fetchImpl });
    const result = await provider.generateMessage(
      input({
        parameters: {
          jsonSchema: {
            type: "object",
            properties: { message: { type: "string" } },
            required: ["message"],
            additionalProperties: false,
          },
        },
      }),
    );
    expect(result.structured).toEqual({ message: "ok" });
    // The Responses shape carries a schema under `text.format`, not `response_format`.
    expect(bodies[0].text).toBeDefined();
  });
});

// ── bound effort ──────────────────────────────────────────────────────────

/**
 * `config.effort` is the only way to tell a model NOT to think. Absent, every
 * dialect falls back to the model's own dynamic thinking — which under a small
 * `maxTokens` competes with the answer for the same budget and can eat all of
 * it, returning a completion with no text in it.
 */
describe("a bound effort reaches the wire", () => {
  const geminiTurn = () =>
    sse([
      JSON.stringify({
        candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
      }),
    ]);

  test("effort 'none' turns thinking off on the Gemini shape", async () => {
    const { bodies, fetchImpl } = scripted([geminiTurn]);
    const provider = new GeminiProvider({
      apiKey: "k",
      model: "gemini-3.5-flash",
      config: { temperature: 0.4, effort: "none" },
      fetchImpl,
    });

    await provider.generateMessage(input());

    const generationConfig = bodies[0].generationConfig as Record<string, unknown>;
    expect(generationConfig.thinkingConfig).toEqual({ thinkingLevel: "MINIMAL" });
  });

  test("effort 'none' turns thinking off on the OpenAI-compatible shape", async () => {
    const { bodies, fetchImpl } = scripted([() => chat({ content: "ok" })]);

    await deepseek(fetchImpl, { config: { effort: "none" } }).generateMessage(input());

    expect(bodies[0].thinking).toEqual({ type: "disabled" });
  });

  const responsesTurn = () =>
    sse([
      JSON.stringify({ type: "response.output_text.delta", delta: "ok" }),
      JSON.stringify({ type: "response.completed", response: { model: "gpt" } }),
    ]);

  /**
   * The case the DeepSeek test above cannot catch, and the reason for
   * `@providerkit/core` 0.4.1. Through 0.4.0 this shape emitted `reasoning`
   * only for graded levels, so "none" left byte-identical to never asking —
   * and not asking is the model's own default, which is `medium` on
   * everything older than GPT-5.1. Under a small `maxTokens` that spends the
   * whole allowance on invisible reasoning and returns empty text.
   */
  test("effort 'none' turns thinking off on the Responses shape", async () => {
    const { bodies, fetchImpl } = scripted([responsesTurn]);

    await new OpenAIProvider({
      apiKey: "k",
      model: "gpt",
      config: { effort: "none" },
      fetchImpl,
    }).generateMessage(input());

    expect(bodies[0].reasoning).toEqual({ effort: "none" });
  });

  /** "max" is this package's word. OpenAI's enum stops at `high`, and sending
   * it verbatim 400'd the request on the top setting alone. */
  test("effort 'max' is clamped to what the Responses enum accepts", async () => {
    const { bodies, fetchImpl } = scripted([responsesTurn]);

    await new OpenAIProvider({
      apiKey: "k",
      model: "gpt",
      config: { effort: "max" },
      fetchImpl,
    }).generateMessage(input());

    expect(bodies[0].reasoning).toEqual({ effort: "high", summary: "auto" });
  });

  /**
   * Re-measured live 2026-09-14 through providerkit 0.10.1's dialect table:
   * GLM 5.3 Flash on OpenRouter answers 400 "Reasoning is mandatory" to
   * `reasoning.effort: "none"` (its earlier enum acceptance is gone), and its
   * off switch is the ABSENT field — omitting `reasoning` disables thinking.
   * So `none` encodes as omission on this dialect; the only thing that must
   * never ride is the `enabled` flag, refused for every model.
   *
   * Why dialect-level and not per-model capabilities: the wire GRAMMAR is the
   * endpoint's (OpenRouter's `reasoning` object, DeepSeek's `thinking`), while
   * what each model does with it is the model's. An explicit `none` is
   * spellable on DeepSeek and OpenAI but not on OpenRouter; omission is the
   * one encoding every OpenRouter model accepts, and for GLM it IS off.
   */
  test("OpenRouter: effort 'none' omits the reasoning field — the absent field is GLM's off switch", async () => {
    const { bodies, fetchImpl } = scripted([() => chat({ content: "ok" })]);

    await new OpenRouterProvider({
      apiKey: "k",
      model: "z-ai/glm-4.6",
      config: { effort: "none" },
      fetchImpl,
    }).generateMessage(input());

    expect(bodies[0]).not.toHaveProperty("reasoning");
    expect(bodies[0]).not.toHaveProperty("reasoning_effort");
  });

  test("no effort sends nothing at all — the model keeps its own default", async () => {
    const { bodies, fetchImpl } = scripted([geminiTurn]);
    const provider = new GeminiProvider({
      apiKey: "k",
      model: "gemini-3.5-flash",
      config: { temperature: 0.4 },
      fetchImpl,
    });

    await provider.generateMessage(input());

    const generationConfig = bodies[0].generationConfig as Record<string, unknown>;
    expect(generationConfig.thinkingConfig).toBeUndefined();
  });
});
