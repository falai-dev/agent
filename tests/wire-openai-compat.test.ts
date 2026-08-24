/**
 * Wire-transcript regression tests for OpenAI-compatible providers.
 *
 * Every test drives the real `OpenAICompatibleProvider` paths (request
 * building, streamed tool-call accumulation, retry classification,
 * backup-model walking) against a fully scripted fake SDK client — no
 * network, no sleeps beyond the unavoidable 1s retry backoff (retries ≤ 1).
 */
import { describe, expect, test } from "bun:test";

import type {
  GenerateMessageInput,
  GenerateMessageStreamChunk,
} from "../src/types/ai";
import type { HistoryItem } from "../src/types/history";
import { ProviderError } from "../src/types/errors";

import {
  ScriptedOpenAIClient,
  ScriptedProvider,
  apiError,
  contentChunks,
  contentTurn,
  errorTurn,
  parsedTurn,
  scriptedProvider,
  toolCallChunks,
  toolCallTurn,
} from "./scripted-provider";

function input(
  overrides: Partial<GenerateMessageInput<undefined>> = {}
): GenerateMessageInput<undefined> {
  return { prompt: "hi", history: [], context: undefined, ...overrides };
}

async function collectStream(
  provider: ScriptedProvider,
  genInput: GenerateMessageInput<undefined>
): Promise<{ deltas: string[]; last?: GenerateMessageStreamChunk }> {
  const deltas: string[] = [];
  let last: GenerateMessageStreamChunk | undefined;
  for await (const chunk of provider.generateMessageStream(genInput)) {
    if (!chunk.done) deltas.push(chunk.delta);
    last = chunk;
  }
  return { deltas, last };
}

const SUMMARY_SCHEMA = {
  type: "object",
  properties: { message: { type: "string" } },
  required: ["message"],
};

describe("streamed tool-call accumulation", () => {
  test("fragments across many chunks accumulate into ONE complete call", async () => {
    const client = new ScriptedOpenAIClient([
      {
        kind: "stream",
        chunks: toolCallChunks(
          [
            {
              id: "call_1",
              name: "get_weather",
              args: { city: "São Paulo", unit: "celsius" },
            },
          ],
          5
        ),
      },
    ]);
    const provider = scriptedProvider(client);

    const { deltas, last } = await collectStream(provider, input());

    expect(client.chatCalls[0]?.params.stream).toBe(true);
    expect(deltas.length).toBe(0); // tool-call stream emits no text deltas
    expect(last?.done).toBe(true);
    expect(last?.metadata?.finishReason).toBe("tool_calls");
    expect(last?.structured?.toolCalls).toEqual([
      { toolName: "get_weather", arguments: { city: "São Paulo", unit: "celsius" } },
    ]);
  });

  test("two same-name parallel calls at different indexes stay distinct", async () => {
    // Fragments arrive interleaved round-robin across both indexes — the exact
    // shape that made naive per-fragment parsing cross arguments between calls.
    const client = new ScriptedOpenAIClient([
      {
        kind: "stream",
        chunks: toolCallChunks(
          [
            { id: "call_a", name: "get_weather", args: { city: "Paris" } },
            { id: "call_b", name: "get_weather", args: { city: "Tokyo" } },
          ],
          4
        ),
      },
    ]);
    const provider = scriptedProvider(client);

    const { last } = await collectStream(provider, input());

    expect(last?.structured?.toolCalls).toEqual([
      { toolName: "get_weather", arguments: { city: "Paris" } },
      { toolName: "get_weather", arguments: { city: "Tokyo" } },
    ]);
  });
});

describe("structured generation carries conversation history", () => {
  test("buildResponsesInput maps tool exchanges onto function_call items", async () => {
    const client = new ScriptedOpenAIClient([
      parsedTurn({ message: "18°C and cloudy in Paris." }),
    ]);
    const provider = scriptedProvider(client);

    const history: HistoryItem[] = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "What's the weather?" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_9", name: "get_weather", arguments: { city: "Paris" } },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_9",
        name: "get_weather",
        content: '{"tempC":18}',
      },
    ];

    const out = await provider.generateMessage(
      input({
        prompt: "Summarize.",
        history,
        parameters: { jsonSchema: SUMMARY_SCHEMA, schemaName: "summary" },
      })
    );

    expect(out.message).toBe("18°C and cloudy in Paris.");
    expect(out.structured?.message).toBe("18°C and cloudy in Paris.");
    expect(out.metadata?.model).toBe("primary-model");
    expect(out.metadata?.tokensUsed).toBe(18);

    // responses_parse mode goes to responses.parse, never chat completions.
    expect(client.parseCalls.length).toBe(1);
    expect(client.chatCalls.length).toBe(0);

    const items = client.parseCalls[0]?.params.input ?? [];
    // Assistant tool_calls become function_call items keyed by the original id.
    expect(items.find((item) => item.type === "function_call")).toEqual({
      type: "function_call",
      call_id: "call_9",
      name: "get_weather",
      arguments: '{"city":"Paris"}',
    });
    // Tool results become function_call_output items under the same id.
    expect(items.find((item) => item.type === "function_call_output")).toEqual({
      type: "function_call_output",
      call_id: "call_9",
      output: '{"tempC":18}',
    });
    // Plain messages pass through; null-content assistant adds no item.
    expect(items.some((i) => i.role === "system" && i.content === "You are helpful.")).toBe(true);
    expect(items.some((i) => i.role === "user" && i.content === "What's the weather?")).toBe(true);
    expect(items.filter((i) => i.role === "assistant").length).toBe(0);
    // The prompt is appended as the final user turn.
    expect(items[items.length - 1]).toEqual({ role: "user", content: "Summarize." });
  });
});

describe("truncated structured JSON at the wire", () => {
  test("non-streaming: raw fragment passes through unstructured — salvage lives above the wire", async () => {
    const client = new ScriptedOpenAIClient([
      contentTurn('{"message": "Sure, I can boo'),
    ]);
    const provider = scriptedProvider(client, { structuredOutput: "json_object" });

    const out = await provider.generateMessage(
      input({ parameters: { jsonSchema: SUMMARY_SCHEMA, schemaName: "summary" } })
    );

    // The provider does NOT throw on truncated-but-nonempty JSON: it hands the
    // raw text up with no structured payload. Salvage-or-throw is owned by the
    // ResponseModal layer (pinned in malformed-structured-output.test.ts);
    // assertUsableCompletion only fires when nothing usable arrived at all.
    expect(out.message).toBe('{"message": "Sure, I can boo');
    expect(out.structured).toBeUndefined();
    expect(client.chatCalls[0]?.params.response_format).toEqual({ type: "json_object" });
  });

  test("streaming: final chunk carries raw accumulated text, no structured payload", async () => {
    const client = new ScriptedOpenAIClient([
      { kind: "stream", chunks: contentChunks('{"message": "Sure, I can boo', 3) },
    ]);
    const provider = scriptedProvider(client);

    const { last } = await collectStream(
      provider,
      input({ parameters: { jsonSchema: SUMMARY_SCHEMA, schemaName: "summary" } })
    );

    expect(last?.done).toBe(true);
    expect(last?.accumulated).toBe('{"message": "Sure, I can boo');
    expect(last?.structured).toBeUndefined();
  });
});

describe("retry classification through the real wrapper", () => {
  test("retriable 429 turn retries, then success", async () => {
    const client = new ScriptedOpenAIClient([
      errorTurn(apiError(429, "Rate limit exceeded")),
      contentTurn("Recovered."),
    ]);
    const provider = scriptedProvider(client, {
      retryConfig: { timeout: 2000, retries: 1 },
    });

    const out = await provider.generateMessage(input());

    expect(out.message).toBe("Recovered.");
    expect(client.chatCalls.length).toBe(2); // one retry, then success
  });

  test("non-retriable 401 fails fast — exactly one attempt despite budget", async () => {
    const client = new ScriptedOpenAIClient([
      errorTurn(apiError(401, "Invalid API key")),
    ]);
    const provider = scriptedProvider(client, {
      retryConfig: { timeout: 2000, retries: 3 }, // budget deliberately unused
    });

    let err: unknown;
    try {
      await provider.generateMessage(input());
    } catch (error) {
      err = error;
    }

    expect(client.chatCalls.length).toBe(1); // no second attempt
    if (!(err instanceof ProviderError)) throw new Error("expected ProviderError");
    expect(err.code).toBe("auth");
  });
});

describe("backup-model walk", () => {
  test("primary retriable failure falls through to the backup model", async () => {
    const client = new ScriptedOpenAIClient([
      errorTurn(apiError(503, "Service unavailable")),
      contentTurn("Served by the backup.", "backup-model-a"),
    ]);
    const provider = scriptedProvider(client, {
      backupModels: ["backup-model-a", "backup-model-b"],
    });

    const out = await provider.generateMessage(input());

    expect(out.message).toBe("Served by the backup.");
    expect(out.metadata?.model).toBe("backup-model-a");
    expect(client.chatCalls.length).toBe(2);
    expect(client.chatCalls[1]?.params.model).toBe("backup-model-a");
  });

  test("deterministic primary failure stops the walk — backup never invoked", async () => {
    const client = new ScriptedOpenAIClient([
      errorTurn(apiError(400, "Invalid request payload")),
    ]);
    const provider = scriptedProvider(client, {
      backupModels: ["backup-model-a"],
    });

    let err: unknown;
    try {
      await provider.generateMessage(input());
    } catch (error) {
      err = error;
    }

    expect(client.consumed).toBe(1); // backup model never requested
    if (!(err instanceof ProviderError)) throw new Error("expected ProviderError");
    expect(err.code).toBe("invalid_request");
  });
});

describe("stream retry semantics", () => {
  test("failure before the first chunk retries cleanly", async () => {
    const client = new ScriptedOpenAIClient([
      errorTurn(apiError(503, "Service unavailable")),
      { kind: "stream", chunks: contentChunks("Hello from attempt two.", 3) },
    ]);
    const provider = scriptedProvider(client, {
      retryConfig: { timeout: 2000, retries: 1 },
    });

    const { deltas, last } = await collectStream(provider, input());

    expect(client.chatCalls.length).toBe(2);
    expect(deltas.join("")).toBe("Hello from attempt two."); // attempt two only, once
    expect(last?.done).toBe(true);
  });

  test("failure after the first chunk propagates without re-emitting earlier deltas", async () => {
    const client = new ScriptedOpenAIClient([
      {
        kind: "stream",
        chunks: contentChunks("partial answer", 2),
        failAfter: apiError(500, "Internal error"),
      },
    ]);
    const provider = scriptedProvider(client, {
      retryConfig: { timeout: 2000, retries: 3 }, // budget irrelevant once committed
    });

    const deltas: string[] = [];
    let err: unknown;
    try {
      for await (const chunk of provider.generateMessageStream(input())) {
        if (!chunk.done) deltas.push(chunk.delta);
      }
    } catch (error) {
      err = error;
    }

    expect(deltas.join("")).toBe("partial answer"); // emitted once, never replayed
    expect(client.chatCalls.length).toBe(1); // a committed stream never retries
    if (!(err instanceof ProviderError)) throw new Error("expected ProviderError");
    expect(err.code).toBe("overloaded");
  });
});

describe("history robustness", () => {
  test("orphaned tool result does not crash chat request building", async () => {
    const client = new ScriptedOpenAIClient([contentTurn("Noted.")]);
    const provider = scriptedProvider(client);

    const out = await provider.generateMessage(
      input({
        history: [
          { role: "user", content: "hi" },
          {
            role: "tool",
            tool_call_id: "call_orphan",
            name: "get_weather",
            content: '{"tempC":20}',
          },
        ],
      })
    );

    expect(out.message).toBe("Noted.");
    const messages = client.chatCalls[0]?.params.messages ?? [];
    expect(messages).toContainEqual({
      role: "tool",
      tool_call_id: "call_orphan",
      content: '{"tempC":20}',
    });
  });

  test("orphaned tool result maps to a standalone function_call_output item", async () => {
    const client = new ScriptedOpenAIClient([parsedTurn({ message: "ok" })]);
    const provider = scriptedProvider(client);

    await provider.generateMessage(
      input({
        history: [
          {
            role: "tool",
            tool_call_id: "call_orphan",
            name: "get_weather",
            content: { tempC: 20 },
          },
        ],
        parameters: { jsonSchema: SUMMARY_SCHEMA },
      })
    );

    const items = client.parseCalls[0]?.params.input ?? [];
    expect(items.find((item) => item.type === "function_call_output")).toEqual({
      type: "function_call_output",
      call_id: "call_orphan",
      output: '{"tempC":20}', // object content serialized
    });
  });
});

describe("multi-turn scripts", () => {
  test("turn 1 tool calls, turn 2 content — consumed strictly in order", async () => {
    const client = new ScriptedOpenAIClient([
      toolCallTurn([{ id: "call_1", name: "get_weather", args: { city: "Paris" } }]),
      contentTurn("It is 18°C."),
    ]);
    const provider = scriptedProvider(client);

    const first = await provider.generateMessage(input());
    expect(first.structured?.toolCalls).toEqual([
      { toolName: "get_weather", arguments: { city: "Paris" } },
    ]);

    const second = await provider.generateMessage(input());
    expect(second.message).toBe("It is 18°C.");

    expect(client.consumed).toBe(2);
  });

  test("a request past the script fails loudly instead of improvising", async () => {
    const client = new ScriptedOpenAIClient([contentTurn("only turn")]);
    const provider = scriptedProvider(client);

    await provider.generateMessage(input());
    await expect(provider.generateMessage(input())).rejects.toThrow(/script exhausted/);
  });
});
