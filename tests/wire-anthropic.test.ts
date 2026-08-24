/**
 * Anthropic wire transcripts — regression infrastructure that replays canned
 * MessageStream-shaped event sequences through the real `AnthropicProvider`
 * paths (message building, streamed tool-use accumulation, retry
 * classification) via the injected-client seam (`options.client`).
 *
 * The fake client covers ONLY the surface the provider touches:
 *   - `messages.create(params, opts)` — non-streaming completion
 *   - `messages.stream(params, opts)` — async-iterable raw event stream
 *
 * Events follow the real wire order: message_start → content_block_start
 * (tool_use blocks always carry an EMPTY `input: {}`) → content_block_delta
 * (`input_json_delta` fragments accumulating `partial_json`) →
 * content_block_stop → message_delta(stop_reason) → message_stop.
 */
import { describe, expect, test } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";

import { AnthropicProvider, type AnthropicProviderOptions } from "../src/providers/AnthropicProvider";
import { ProviderError } from "../src/types/errors";
import type {
  GenerateMessageInput,
  GenerateMessageStreamChunk,
} from "../src/types/ai";
import type { HistoryItem } from "../src/types/history";
import { apiError } from "./scripted-provider";

// ---------------------------------------------------------------------------
// Script model
// ---------------------------------------------------------------------------

/** One scripted turn = one upstream request, consumed strictly in order. */
type ScriptedTurn =
  /** Non-streaming completion returning a text block. */
  | { kind: "content"; text: string }
  /** Non-streaming completion returning tool_use blocks (input pre-parsed). */
  | { kind: "tool_use"; calls: Array<{ id: string; name: string; input: Record<string, unknown> }> }
  /** Streaming replay: canned raw stream events. */
  | { kind: "events"; events: unknown[] }
  /** The request itself throws (classification is the provider's job). */
  | { kind: "error"; error: unknown };

const contentTurn = (text: string): ScriptedTurn => ({ kind: "content", text });

const toolUseTurn = (
  calls: Array<{ id: string; name: string; input: Record<string, unknown> }>
): ScriptedTurn => ({ kind: "tool_use", calls });

const eventsTurn = (events: unknown[]): ScriptedTurn => ({ kind: "events", events });

const errorTurn = (error: unknown): ScriptedTurn => ({ kind: "error", error });

// ---------------------------------------------------------------------------
// Stream-event transcript builders
// ---------------------------------------------------------------------------

/** Split text into roughly `n` fragments (always ≥ 1 piece). */
function splitFragments(text: string, n: number): string[] {
  const size = Math.ceil(text.length / Math.max(n, 1));
  const pieces: string[] = [];
  for (let i = 0; i < text.length; i += size) {
    pieces.push(text.slice(i, i + size));
  }
  return pieces;
}

function messageStart(model = "claude-test"): unknown {
  return {
    type: "message_start",
    message: { id: "msg_scripted", model, usage: { input_tokens: 12 } },
  };
}

/** Text-only stream: fragments across `n` text_delta events, end_turn stop. */
function streamTextEvents(text: string, n = 3): unknown[] {
  const events: unknown[] = [
    messageStart(),
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  ];
  for (const piece of splitFragments(text, n)) {
    events.push({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: piece },
    });
  }
  events.push(
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } },
    { type: "message_stop" }
  );
  return events;
}

interface ToolBlockSpec {
  id: string;
  name: string;
  args: Record<string, unknown>;
  /** How many input_json_delta pieces args are split into (default 3). */
  fragments?: number;
}

/**
 * Preamble text followed by parallel tool_use blocks whose arguments arrive as
 * fragmented input_json_delta pieces INTERLEAVED round-robin across block
 * indexes — the Phase-1 bug shape. Each block starts with an empty
 * `input: {}` (the real wire never ships arguments in content_block_start).
 */
function streamToolUseEvents(preamble: string, blocks: ToolBlockSpec[]): unknown[] {
  const events: unknown[] = [
    messageStart(),
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  ];
  for (const piece of splitFragments(preamble, 2)) {
    events.push({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: piece },
    });
  }
  events.push({ type: "content_block_stop", index: 0 });

  blocks.forEach((block, position) => {
    // Tool blocks start after the preamble text block (index 0).
    const index = position + 1;
    events.push({
      type: "content_block_start",
      index,
      content_block: { type: "tool_use", id: block.id, name: block.name, input: {} },
    });
  });

  const fragmentLists = blocks.map((block) =>
    splitFragments(JSON.stringify(block.args), block.fragments ?? 3)
  );
  const rounds = Math.max(...fragmentLists.map((list) => list.length));
  for (let round = 0; round < rounds; round++) {
    fragmentLists.forEach((pieces, position) => {
      if (!pieces[round]) return;
      events.push({
        type: "content_block_delta",
        index: position + 1,
        delta: { type: "input_json_delta", partial_json: pieces[round] as string },
      });
    });
  }

  blocks.forEach((_, position) => {
    events.push({ type: "content_block_stop", index: position + 1 });
  });
  events.push(
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 9 } },
    { type: "message_stop" }
  );
  return events;
}

// ---------------------------------------------------------------------------
// Fake SDK client
// ---------------------------------------------------------------------------

/** Wire-visible shape of a captured `messages.create` / `messages.stream` call. */
interface CapturedMessageCall {
  params: {
    model?: string;
    max_tokens?: number;
    system?: unknown;
    messages?: Array<{ role: string; content: unknown }>;
    tools?: Array<{ name: string; description?: string; input_schema?: unknown }>;
    stream?: boolean;
  };
  opts: unknown;
}

/**
 * Fake Anthropic SDK client driven by an ordered script. Throws a clear error
 * when a request arrives with no turn left, so transcripts stay exact.
 */
class ScriptedAnthropicClient {
  readonly createCalls: CapturedMessageCall[] = [];
  readonly streamCalls: CapturedMessageCall[] = [];

  private cursor = 0;

  constructor(private readonly turns: ScriptedTurn[]) {}

  readonly messages = {
    create: async (
      params: CapturedMessageCall["params"],
      opts?: unknown
    ): Promise<Record<string, unknown>> => {
      this.createCalls.push({ params, opts });
      const turn = this.next("messages.create");
      if (turn.kind === "error") throw turn.error;
      if (turn.kind !== "content" && turn.kind !== "tool_use") {
        throw this.mismatch("messages.create", turn);
      }

      const content =
        turn.kind === "content"
          ? [{ type: "text", text: turn.text }]
          : turn.calls.map((call) => ({
              type: "tool_use",
              id: call.id,
              name: call.name,
              input: call.input,
            }));
      return {
        id: "msg_scripted",
        type: "message",
        role: "assistant",
        model: params.model ?? "claude-test",
        content,
        stop_reason: turn.kind === "content" ? "end_turn" : "tool_use",
        usage: { input_tokens: 10, output_tokens: 6 },
      };
    },

    stream: (
      params: CapturedMessageCall["params"],
      opts?: unknown
    ): AsyncGenerator<unknown> => {
      this.streamCalls.push({ params, opts });
      const turn = this.next("messages.stream");
      if (turn.kind === "error") throw turn.error;
      if (turn.kind !== "events") throw this.mismatch("messages.stream", turn);
      return replayEvents(turn.events);
    },
  };

  /**
   * The single SDK-double cast, at the boundary. Justification: the provider
   * under test only touches `messages.create` and `messages.stream`, both
   * implemented above with faithful shapes.
   */
  asAnthropic(): Anthropic {
    return this as unknown as Anthropic;
  }

  private next(api: string): ScriptedTurn {
    if (this.cursor >= this.turns.length) {
      throw new Error(
        `[ScriptedAnthropicClient] script exhausted at ${api}; ${this.turns.length} turn(s) were scripted`
      );
    }
    const turn = this.turns[this.cursor];
    this.cursor += 1;
    return turn;
  }

  private mismatch(request: string, turn: ScriptedTurn): Error {
    return new Error(`[ScriptedAnthropicClient] ${request} hit a scripted "${turn.kind}" turn`);
  }
}

// Hoisted to module scope because Bun 1.3.x miscompiles an `async function*`
// expression written inline inside a class property (see scripted-provider.ts).
function replayEvents(events: unknown[]): AsyncGenerator<unknown> {
  return async function* () {
    for (const event of events) yield event;
  }();
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function baseInput(): GenerateMessageInput<undefined> {
  return { prompt: "hi", history: [], context: undefined };
}

function wiredProvider(
  client: ScriptedAnthropicClient,
  overrides: Partial<AnthropicProviderOptions> = {}
): AnthropicProvider {
  return new AnthropicProvider({
    model: "claude-test",
    retryConfig: { timeout: 2000, retries: 0 },
    ...overrides,
    client: client.asAnthropic(),
  });
}

/** Resolve to the thrown value (undefined when the promise resolves). */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return undefined;
  } catch (error: unknown) {
    return error;
  }
}

async function collectChunks(
  stream: AsyncGenerator<GenerateMessageStreamChunk>
): Promise<Array<GenerateMessageStreamChunk>> {
  const chunks: Array<GenerateMessageStreamChunk> = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AnthropicProvider wire transcripts", () => {
  test("client injection seam: constructing with a client requires no apiKey", () => {
    expect(() => wiredProvider(new ScriptedAnthropicClient([]))).not.toThrow();
  });

  test("input_json_delta fragments accumulate into complete tool arguments", async () => {
    const client = new ScriptedAnthropicClient([
      eventsTurn(
        streamToolUseEvents("Checking Paris.", [
          { id: "tu_1", name: "get_weather", args: { city: "São Paulo", unit: "celsius" } },
          { id: "tu_2", name: "get_forecast", args: { days: 3 }, fragments: 2 },
        ])
      ),
    ]);
    const provider = wiredProvider(client);

    const chunks = await collectChunks(provider.generateMessageStream(baseInput()));
    const last = chunks[chunks.length - 1];

    // Every streamed chunk except the terminator was a partial delta.
    expect(chunks.slice(0, -1).every((chunk) => !chunk.done)).toBe(true);
    expect(last.done).toBe(true);
    // Blocks stay ordered by index despite interleaved fragments.
    expect(last.structured?.toolCalls).toEqual([
      { toolName: "get_weather", arguments: { city: "São Paulo", unit: "celsius" } },
      { toolName: "get_forecast", arguments: { days: 3 } },
    ]);
    expect(last.metadata?.stopReason).toBe("tool_use");
    expect(last.metadata?.tokensUsed).toBe(12 + 9);
  });

  test("text-only stream yields concatenated chunks and terminal metadata", async () => {
    const client = new ScriptedAnthropicClient([eventsTurn(streamTextEvents("Hello there, traveler.", 4))]);
    const provider = wiredProvider(client);

    const chunks = await collectChunks(provider.generateMessageStream(baseInput()));
    const last = chunks[chunks.length - 1];

    const deltas = chunks.map((chunk) => chunk.delta);
    expect(deltas.join("")).toBe("Hello there, traveler.");
    // accumulated grows monotonically toward the full text.
    expect(chunks[0].accumulated).toBe(deltas[0]);
    expect(last.accumulated).toBe("Hello there, traveler.");
    expect(last.done).toBe(true);
    expect(last.metadata?.model).toBe("claude-test");
    expect(last.metadata?.stopReason).toBe("end_turn");
    expect(last.metadata?.promptTokens).toBe(12);
    expect(last.metadata?.completionTokens).toBe(7);
  });

  test("tool-use round trips: second create receives tool_result blocks mapped from history", async () => {
    const weatherTool = {
      id: "get_weather",
      name: "get_weather",
      description: "Current weather",
      parameters: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      },
    };
    const client = new ScriptedAnthropicClient([
      toolUseTurn([{ id: "tu_1", name: "get_weather", input: { city: "Paris" } }]),
      contentTurn("Lisbon is sunny today."),
    ]);
    const provider = wiredProvider(client);

    const first = await provider.generateMessage({
      ...baseInput(),
      prompt: "What's the weather in Paris?",
      tools: [weatherTool],
    });
    expect(first.structured?.toolCalls).toEqual([
      { toolName: "get_weather", arguments: { city: "Paris" } },
    ]);

    // Wire-level: the first create carried the declared tool schema.
    expect(client.createCalls[0].params.tools?.[0]).toMatchObject({
      name: "get_weather",
      description: "Current weather",
      input_schema: { type: "object" },
    });

    const history: HistoryItem[] = [
      { role: "user", content: "What's the weather in Paris?" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "tu_1", name: "get_weather", arguments: { city: "Paris" } }],
      },
      { role: "tool", tool_call_id: "tu_1", name: "get_weather", content: '{"temp":"22C"}' },
    ];
    const second = await provider.generateMessage({
      ...baseInput(),
      prompt: "And in Lisbon?",
      history,
      tools: [weatherTool],
    });
    expect(second.message).toBe("Lisbon is sunny today.");
    expect(client.createCalls.length).toBe(2);

    // Assistant tool_calls map to tool_use blocks; tool results map to user
    // messages carrying tool_result blocks keyed by tool_use_id.
    expect(client.createCalls[1].params.messages).toEqual([
      { role: "user", content: "What's the weather in Paris?" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tu_1", name: "get_weather", input: { city: "Paris" } },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu_1", content: '{"temp":"22C"}' }],
      },
      { role: "user", content: "And in Lisbon?" },
    ]);
  });

  describe("retry classification (invocation counts)", () => {
    test("non-retriable auth error fails fast — exactly one create", async () => {
      const client = new ScriptedAnthropicClient([
        errorTurn(apiError(401, "invalid x-api-key")),
      ]);
      const provider = wiredProvider(client, { retryConfig: { timeout: 2000, retries: 2 } });

      const error = await rejectionOf(provider.generateMessage(baseInput()));
      expect(error).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).code).toBe("auth");
      expect(client.createCalls.length).toBe(1);
    });

    test("retriable 529 overload retries the same model and recovers", async () => {
      const client = new ScriptedAnthropicClient([
        errorTurn(apiError(529, "Overloaded")),
        contentTurn("Recovered"),
      ]);
      const provider = wiredProvider(client, { retryConfig: { timeout: 2000, retries: 1 } });

      const output = await provider.generateMessage(baseInput());
      expect(output.message).toBe("Recovered");
      expect(client.createCalls.length).toBe(2);
    });

    test("non-retriable error before the first stream chunk propagates immediately", async () => {
      const client = new ScriptedAnthropicClient([
        errorTurn(apiError(401, "invalid x-api-key")),
      ]);
      const provider = wiredProvider(client, { retryConfig: { timeout: 2000, retries: 1 } });

      const error = await rejectionOf(collectChunks(provider.generateMessageStream(baseInput())));
      expect(error).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).code).toBe("auth");
      expect(client.streamCalls.length).toBe(1);
    });

    test("retriable 529 before the first stream chunk restarts the stream", async () => {
      const client = new ScriptedAnthropicClient([
        errorTurn(apiError(529, "Overloaded")),
        eventsTurn(streamTextEvents("ok")),
      ]);
      const provider = wiredProvider(client, { retryConfig: { timeout: 2000, retries: 1 } });

      const chunks = await collectChunks(provider.generateMessageStream(baseInput()));
      expect(chunks[chunks.length - 1].accumulated).toBe("ok");
      expect(client.streamCalls.length).toBe(2);
    });
  });
});
