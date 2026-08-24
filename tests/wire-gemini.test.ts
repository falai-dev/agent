/**
 * Gemini wire transcripts — regression infrastructure that replays canned
 * GenerateContent-shaped responses through the real `GeminiProvider` paths
 * (content building, function-call extraction, schema adaptation, retry
 * classification) via the injected-client seam (`options.client`).
 *
 * The fake client covers ONLY the surface the provider touches:
 *   - `models.generateContent(req)` — non-streaming completion
 *   - `models.generateContentStream(req)` — awaited, resolves to an
 *     async-iterable of chunk objects
 *
 * Shapes follow the real wire: text lives in
 * `candidates[0].content.parts[*].text`, tool calls in `parts[*].functionCall`
 * (`{ name, args }` with args already an object), token counts in
 * `usageMetadata`. Gemini's overload signals are message-based ("overloaded",
 * "not available"), so error doubles are plain Errors carrying those strings.
 */
import { describe, expect, test } from "bun:test";
import type { GoogleGenAI } from "@google/genai";
import { Type } from "@google/genai";

import { GeminiProvider, type GeminiProviderOptions } from "../src/providers/GeminiProvider";
import { ProviderError } from "../src/types/errors";
import type {
  GenerateMessageInput,
  GenerateMessageStreamChunk,
} from "../src/types/ai";

// ---------------------------------------------------------------------------
// Script model
// ---------------------------------------------------------------------------

/** One scripted turn = one upstream request, consumed strictly in order. */
type ScriptedTurn =
  /** Non-streaming completion returning text parts. */
  | { kind: "content"; text: string }
  /** Non-streaming completion returning functionCall parts (args an object). */
  | { kind: "function_calls"; calls: Array<{ name: string; args: Record<string, unknown> }> }
  /** Streaming replay: canned chunks. */
  | { kind: "stream_chunks"; chunks: unknown[] }
  /** The request itself throws (classification is the provider's job). */
  | { kind: "error"; error: unknown };

const contentTurn = (text: string): ScriptedTurn => ({ kind: "content", text });

const functionCallsTurn = (
  calls: Array<{ name: string; args: Record<string, unknown> }>
): ScriptedTurn => ({ kind: "function_calls", calls });

const streamChunksTurn = (chunks: unknown[]): ScriptedTurn => ({ kind: "stream_chunks", chunks });

const errorTurn = (error: unknown): ScriptedTurn => ({ kind: "error", error });

// ---------------------------------------------------------------------------
// Response/chunk transcript builders
// ---------------------------------------------------------------------------

const USAGE = { promptTokenCount: 11, candidatesTokenCount: 9, totalTokenCount: 20 };

function textResponse(text: string): Record<string, unknown> {
  return {
    candidates: [{ content: { role: "model", parts: [{ text }] } }],
    usageMetadata: USAGE,
  };
}

function functionCallResponse(
  calls: Array<{ name: string; args: Record<string, unknown> }>
): Record<string, unknown> {
  return {
    candidates: [
      {
        content: {
          role: "model",
          parts: calls.map((call) => ({ functionCall: { name: call.name, args: call.args } })),
        },
      },
    ],
    usageMetadata: USAGE,
  };
}

/** Split text into roughly `n` fragments (always ≥ 1 piece). */
function splitFragments(text: string, n: number): string[] {
  const size = Math.ceil(text.length / Math.max(n, 1));
  const pieces: string[] = [];
  for (let i = 0; i < text.length; i += size) {
    pieces.push(text.slice(i, i + size));
  }
  return pieces;
}

/** Text split across `n` streamed chunks; the terminator carries usageMetadata. */
function chunkedTextStream(text: string, n = 3): unknown[] {
  const pieces = splitFragments(text, n);
  return pieces.map((piece, index) => ({
    candidates: [{ content: { role: "model", parts: [{ text: piece }] } }],
    ...(index === pieces.length - 1 ? { usageMetadata: USAGE } : {}),
  }));
}

/** Single-chunk stream whose part is a functionCall — the tool-call shape. */
function functionCallStream(
  name: string,
  args: Record<string, unknown>
): unknown[] {
  return [
    {
      candidates: [{ content: { role: "model", parts: [{ functionCall: { name, args } }] } }],
      usageMetadata: USAGE,
    },
  ];
}

// ---------------------------------------------------------------------------
// Fake SDK client
// ---------------------------------------------------------------------------

/** Wire-visible shape of a captured `models.generateContent(Stream)` request. */
interface CapturedGeminiRequest {
  model?: string;
  contents?: Array<{ role: string; parts: Array<Record<string, unknown>> }>;
  config?: {
    systemInstruction?: unknown;
    responseMimeType?: string;
    responseSchema?: unknown;
    tools?: Array<{ functionDeclarations: Array<Record<string, unknown>> }>;
    abortSignal?: AbortSignal;
  };
}

/**
 * Fake @google/genai client driven by an ordered script. Throws a clear error
 * when a request arrives with no turn left, so transcripts stay exact.
 */
class ScriptedGeminiClient {
  readonly generateCalls: CapturedGeminiRequest[] = [];
  readonly streamCalls: CapturedGeminiRequest[] = [];

  private cursor = 0;

  constructor(private readonly turns: ScriptedTurn[]) {}

  readonly models = {
    generateContent: async (
      request: CapturedGeminiRequest
    ): Promise<Record<string, unknown>> => {
      this.generateCalls.push(request);
      const turn = this.next("models.generateContent");
      if (turn.kind === "error") throw turn.error;
      if (turn.kind === "content") return textResponse(turn.text);
      if (turn.kind === "function_calls") return functionCallResponse(turn.calls);
      throw this.mismatch("models.generateContent", turn);
    },

    generateContentStream: async (
      request: CapturedGeminiRequest
    ): Promise<AsyncGenerator<unknown>> => {
      this.streamCalls.push(request);
      const turn = this.next("models.generateContentStream");
      if (turn.kind === "error") throw turn.error;
      if (turn.kind !== "stream_chunks") {
        throw this.mismatch("models.generateContentStream", turn);
      }
      return replayChunks(turn.chunks);
    },
  };

  /**
   * The single SDK-double cast, at the boundary. Justification: the provider
   * under test only touches `models.generateContent` and
   * `models.generateContentStream`, both implemented above with faithful shapes.
   */
  asGenAI(): GoogleGenAI {
    return this as unknown as GoogleGenAI;
  }

  private next(api: string): ScriptedTurn {
    if (this.cursor >= this.turns.length) {
      throw new Error(
        `[ScriptedGeminiClient] script exhausted at ${api}; ${this.turns.length} turn(s) were scripted`
      );
    }
    const turn = this.turns[this.cursor];
    this.cursor += 1;
    return turn;
  }

  private mismatch(request: string, turn: ScriptedTurn): Error {
    return new Error(`[ScriptedGeminiClient] ${request} hit a scripted "${turn.kind}" turn`);
  }
}

// Hoisted to module scope because Bun 1.3.x miscompiles an `async function*`
// expression written inline inside a class property (see scripted-provider.ts).
function replayChunks(chunks: unknown[]): AsyncGenerator<unknown> {
  return async function* () {
    for (const chunk of chunks) yield chunk;
  }();
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function baseInput(): GenerateMessageInput<undefined> {
  return { prompt: "hi", history: [], context: undefined };
}

function wiredProvider(
  client: ScriptedGeminiClient,
  overrides: Partial<GeminiProviderOptions> = {}
): GeminiProvider {
  return new GeminiProvider({
    model: "gemini-test",
    retryConfig: { timeout: 2000, retries: 0 },
    ...overrides,
    client: client.asGenAI(),
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

const CITY_SCHEMA = {
  type: "object",
  properties: { city: { type: "string" } },
  required: ["city"],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GeminiProvider wire transcripts", () => {
  test("client injection seam: constructing with a client requires no apiKey", () => {
    expect(() => wiredProvider(new ScriptedGeminiClient([]))).not.toThrow();
  });

  test("chunked text stream concatenates correctly", async () => {
    const client = new ScriptedGeminiClient([
      streamChunksTurn(chunkedTextStream("Lisbon glows at dusk.", 3)),
    ]);
    const provider = wiredProvider(client);

    const input = { ...baseInput(), prompt: "Tell me about Lisbon" };
    const chunks = await collectChunks(provider.generateMessageStream(input));
    const last = chunks[chunks.length - 1];

    expect(chunks.map((chunk) => chunk.delta).join("")).toBe("Lisbon glows at dusk.");
    // accumulated grows monotonically toward the full text.
    expect(chunks[0].accumulated).toBe(chunks[0].delta);
    expect(last.accumulated).toBe("Lisbon glows at dusk.");
    expect(last.done).toBe(true);
    expect(last.metadata?.tokensUsed).toBe(20);
    expect(last.metadata?.promptTokens).toBe(11);
    expect(last.metadata?.completionTokens).toBe(9);

    // The prompt rides as the final user content in the captured request.
    const contents = client.streamCalls[0].contents ?? [];
    expect(contents[contents.length - 1]).toEqual({
      role: "user",
      parts: [{ text: "Tell me about Lisbon" }],
    });
  });

  test("functionCall parts surface as parsed tool calls with name and args object", async () => {
    const client = new ScriptedGeminiClient([
      functionCallsTurn([{ name: "get_weather", args: { city: "Paris", unit: "celsius" } }]),
    ]);
    const provider = wiredProvider(client);

    const weatherTool = {
      id: "get_weather",
      name: "get_weather",
      description: "Current weather",
      parameters: CITY_SCHEMA,
    };
    const output = await provider.generateMessage({ ...baseInput(), tools: [weatherTool] });

    // No text parts — message stays empty while the call is surfaced parsed.
    expect(output.message).toBe("");
    expect(output.structured?.toolCalls).toEqual([
      { toolName: "get_weather", arguments: { city: "Paris", unit: "celsius" } },
    ]);

    // Wire-level: JSON Schema parameters were converted to Gemini's Schema type.
    const declarations = client.generateCalls[0].config?.tools?.[0].functionDeclarations;
    expect(declarations?.length).toBe(1);
    expect(declarations?.[0]).toEqual({
      name: "get_weather",
      description: "Current weather",
      parameters: {
        type: Type.OBJECT,
        properties: { city: { type: Type.STRING } },
        required: ["city"],
      },
    });
  });

  test("streamed functionCall chunks surface as tool calls on the final chunk", async () => {
    const client = new ScriptedGeminiClient([
      streamChunksTurn(functionCallStream("book_trip", { city: "Rio", nights: 4 })),
    ]);
    const provider = wiredProvider(client);

    const chunks = await collectChunks(provider.generateMessageStream(baseInput()));
    const last = chunks[chunks.length - 1];

    // A pure function-call chunk yields no text deltas — only the terminator.
    expect(last.done).toBe(true);
    expect(last.delta).toBe("");
    expect(last.structured?.toolCalls).toEqual([
      { toolName: "book_trip", arguments: { city: "Rio", nights: 4 } },
    ]);
    expect(last.metadata?.tokensUsed).toBe(20);
  });

  test("schema path sends responseSchema + JSON mime type and parses returned JSON", async () => {
    const client = new ScriptedGeminiClient([contentTurn(JSON.stringify({ city: "Paris" }))]);
    const provider = wiredProvider(client);

    const output = await provider.generateMessage({
      ...baseInput(),
      parameters: { jsonSchema: CITY_SCHEMA },
    });

    const config = client.generateCalls[0].config;
    expect(config?.responseMimeType).toBe("application/json");
    expect(config?.responseSchema).toEqual({
      type: Type.OBJECT,
      properties: { city: { type: Type.STRING } },
      required: ["city"],
    });

    // Raw JSON string is the message; the parsed payload lands in structured.
    expect(output.message).toBe('{"city":"Paris"}');
    const parsed = output.structured as Record<string, unknown>;
    expect(parsed).toEqual({ city: "Paris" });
  });

  describe("retry classification (invocation counts)", () => {
    test("plain non-matching error fails fast — exactly one call", async () => {
      // Plain Error on purpose: no HTTP status, so classification must fall
      // through the message patterns (none match) to the non-retriable bucket.
      const client = new ScriptedGeminiClient([
        errorTurn(new Error("API key not valid. Please pass a valid API key.")),
      ]);
      const provider = wiredProvider(client, { retryConfig: { timeout: 2000, retries: 2 } });

      const error = await rejectionOf(provider.generateMessage(baseInput()));
      expect(error).toBeInstanceOf(ProviderError);
      expect(client.generateCalls.length).toBe(1);
    });

    test('"overloaded" message retries the same model and recovers', async () => {
      const client = new ScriptedGeminiClient([
        errorTurn(new Error("The model is overloaded. Please try again later.")),
        contentTurn("Recovered"),
      ]);
      const provider = wiredProvider(client, { retryConfig: { timeout: 2000, retries: 1 } });

      const output = await provider.generateMessage(baseInput());
      expect(output.message).toBe("Recovered");
      expect(client.generateCalls.length).toBe(2);
    });

    test('Gemini-specific "not available" message is treated as retriable', async () => {
      const client = new ScriptedGeminiClient([
        errorTurn(new Error("Model not available for the requested API version.")),
        contentTurn("Recovered too"),
      ]);
      const provider = wiredProvider(client, { retryConfig: { timeout: 2000, retries: 1 } });

      const output = await provider.generateMessage(baseInput());
      expect(output.message).toBe("Recovered too");
      expect(client.generateCalls.length).toBe(2);
    });
  });
});
