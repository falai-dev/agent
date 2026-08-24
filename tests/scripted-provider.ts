/**
 * Scripted wire doubles for OpenAI-compatible providers — regression-test
 * infrastructure that replays canned HTTP-shaped transcripts through the real
 * `OpenAICompatibleProvider` paths (message building, streamed tool-call
 * accumulation, retry classification, backup-model walking).
 *
 * The fake client covers ONLY the surface the provider touches:
 *   - `chat.completions.create(params, opts)` — non-streaming completion or
 *     (`stream: true`) an async-iterable of chunk objects
 *   - `responses.parse(params, opts)` — structured `responses_parse` mode
 *
 * Turns are consumed strictly in request order; every request's params are
 * captured for wire-level assertions. Transcript builders emit realistic
 * shapes: content split across deltas, tool-call arguments arriving as
 * fragmented deltas keyed by call index (the Phase-1 bug shape), and
 * classified provider errors (`{ status, message }`-like API errors).
 */
import type OpenAI from "openai";
import type {
  ChatCompletion,
  ChatCompletionChunk,
} from "openai/resources/chat/completions";

import {
  OpenAICompatibleProvider,
  type OpenAICompatibleProviderInit,
} from "../src/providers/OpenAICompatibleProvider";
import type { GenerateMessageInput, GenerateMessageStreamChunk, ProviderCapabilities } from "../src/types/ai";

// ---------------------------------------------------------------------------
// Script model
// ---------------------------------------------------------------------------

/** One tool call as the model would emit it (arguments still an object). */
export interface ToolCallSpec {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/**
 * One scripted turn = one upstream request. Consumed in order regardless of
 * which API the provider calls; shape mismatches throw instead of guessing.
 */
export type ScriptedTurn =
  /** Non-streaming chat completion returning text. */
  | { kind: "content"; text: string; model?: string }
  /** Non-streaming chat completion returning tool calls. */
  | { kind: "tool_calls"; calls: ToolCallSpec[]; model?: string }
  /** Streaming replay: canned chunks, optionally followed by a mid-stream throw. */
  | { kind: "stream"; chunks: ChatCompletionChunk[]; failAfter?: unknown }
  /** `responses.parse` success carrying the pre-parsed structured payload. */
  | { kind: "parsed"; structured: Record<string, unknown>; model?: string }
  /** The request itself throws (retriable or not — classification is the provider's job). */
  | { kind: "error"; error: unknown };

// ---------------------------------------------------------------------------
// Turn builders
// ---------------------------------------------------------------------------

export function contentTurn(text: string, model?: string): ScriptedTurn {
  return { kind: "content", text, model };
}

export function toolCallTurn(calls: ToolCallSpec[], model?: string): ScriptedTurn {
  return { kind: "tool_calls", calls, model };
}

/** A classified provider-ish failure, e.g. `errorTurn(apiError(429, "Rate limit exceeded"))`. */
export function errorTurn(error: unknown): ScriptedTurn {
  return { kind: "error", error };
}

export function parsedTurn(
  structured: Record<string, unknown>,
  model?: string
): ScriptedTurn {
  return { kind: "parsed", structured, model };
}

/** SDK-shaped API error: an `Error` carrying the HTTP `status` classifiers read. */
export function apiError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

/**
 * Build the awaitable async-iterable the real SDK returns for `{ stream: true }`.
 * ponytail: hoisted to module scope because Bun 1.3.x miscompiles an
 * `async function*` expression written inline inside an async-arrow class
 * property (its Symbol.asyncIterator ends up undefined).
 */
export function replayChunks<T>(
  chunks: T[],
  failAfter?: unknown
): AsyncGenerator<T> {
  return async function* () {
    for (const chunk of chunks) yield chunk;
    if (failAfter !== undefined) throw failAfter;
  }();
}

// ---------------------------------------------------------------------------
// Stream-transcript builders
// ---------------------------------------------------------------------------

/** Split text into roughly `n` fragments (always ≥ 1 piece). */
export function splitFragments(text: string, n: number): string[] {
  const size = Math.ceil(text.length / Math.max(n, 1));
  const pieces: string[] = [];
  for (let i = 0; i < text.length; i += size) {
    pieces.push(text.slice(i, i + size));
  }
  return pieces;
}

let seq = 0;

function streamChunk(
  model: string,
  choices: ChatCompletionChunk["choices"]
): ChatCompletionChunk {
  seq += 1;
  return {
    id: `chatcmpl-scripted-${seq}`,
    object: "chat.completion.chunk",
    created: 1700000000,
    model,
    choices,
  };
}

/**
 * Content split across `n` deltas: a leading role-header chunk, one chunk per
 * fragment, then a `finish_reason: "stop"` terminator.
 */
export function contentChunks(text: string, n: number, model = "primary-model"): ChatCompletionChunk[] {
  const chunks: ChatCompletionChunk[] = [
    streamChunk(model, [
      { index: 0, delta: { role: "assistant", content: "" }, finish_reason: null },
    ]),
  ];
  for (const piece of splitFragments(text, n)) {
    chunks.push(
      streamChunk(model, [
        { index: 0, delta: { content: piece }, finish_reason: null },
      ])
    );
  }
  chunks.push(streamChunk(model, [{ index: 0, delta: {}, finish_reason: "stop" }]));
  return chunks;
}

/**
 * Fragmented tool-call deltas — the Phase-1 bug shape. Each call gets a header
 * chunk (id + name), then its `JSON.stringify(args)` is split into `fragments`
 * pieces that arrive INTERLEAVED round-robin across call indexes, exactly how
 * servers emit parallel calls. Terminates with `finish_reason: "tool_calls"`.
 */
export function toolCallChunks(
  calls: ToolCallSpec[],
  fragments: number,
  model = "primary-model"
): ChatCompletionChunk[] {
  const chunks: ChatCompletionChunk[] = [];
  calls.forEach((call, index) => {
    chunks.push(
      streamChunk(model, [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index,
                id: call.id,
                type: "function",
                function: { name: call.name, arguments: "" },
              },
            ],
          },
          finish_reason: null,
        },
      ])
    );
  });

  const fragmentLists = calls.map((call) =>
    splitFragments(JSON.stringify(call.args), fragments)
  );
  const rounds = Math.max(...fragmentLists.map((list) => list.length), 1);
  for (let round = 0; round < rounds; round++) {
    const deltas = fragmentLists.flatMap((pieces, index) =>
      pieces[round]
        ? [{ index, function: { arguments: pieces[round] as string } }]
        : []
    );
    if (deltas.length > 0) {
      chunks.push(
        streamChunk(model, [
          { index: 0, delta: { tool_calls: deltas }, finish_reason: null },
        ])
      );
    }
  }

  chunks.push(streamChunk(model, [{ index: 0, delta: {}, finish_reason: "tool_calls" }]));
  return chunks;
}

// ---------------------------------------------------------------------------
// Fake SDK client
// ---------------------------------------------------------------------------

/** Wire-visible shape of a captured `chat.completions.create` call. */
export interface CapturedChatCall {
  params: {
    model?: string;
    messages?: Array<{
      role: string;
      content?: unknown;
      tool_call_id?: string;
      tool_calls?: Array<{
        id: string;
        type: string;
        function: { name: string; arguments: string };
      }>;
    }>;
    tools?: Array<{ type: string; function: { name: string } }>;
    tool_choice?: string;
    max_tokens?: number;
    response_format?: Record<string, unknown>;
    stream?: boolean;
  };
  opts: unknown;
}

/** Wire-visible shape of a captured `responses.parse` call. */
export interface CapturedParseCall {
  params: {
    model?: string;
    input?: Array<{
      type?: string;
      role?: string;
      content?: unknown;
      call_id?: string;
      name?: string;
      arguments?: string;
      output?: string;
    }>;
    reasoning?: { effort?: string };
    text?: {
      format?: { type?: string; name?: string; schema?: Record<string, unknown> };
    };
  };
  opts: unknown;
}

/** Minimal `responses.parse` result — only what `executeStructuredGenerate` reads. */
interface ParsedResponseStub {
  id: string;
  object: "response";
  created_at: number;
  status: "completed";
  model: string;
  output_parsed: Record<string, unknown>;
  usage: { input_tokens: number; output_tokens: number; total_tokens: number };
}

/**
 * Fake OpenAI SDK client driven by an ordered script. Throws a clear error
 * when a request arrives with no turn left, so transcripts stay exact.
 */
export class ScriptedOpenAIClient {
  readonly chatCalls: CapturedChatCall[] = [];
  readonly parseCalls: CapturedParseCall[] = [];

  private cursor = 0;

  constructor(private readonly turns: ScriptedTurn[]) {}

  /** How many scripted turns have been consumed so far. */
  get consumed(): number {
    return this.cursor;
  }

  // Field-initializer order matters: the captures/cursor above exist before
  // these arrow-bound members run.
  readonly chat = {
    completions: {
      create: async (
        params: CapturedChatCall["params"],
        opts?: unknown
      ): Promise<ChatCompletion | AsyncIterable<ChatCompletionChunk>> => {
        this.chatCalls.push({ params, opts });
        const turn = this.next("chat.completions.create", params.stream === true);
        if (turn.kind === "error") throw turn.error;

        if (params.stream === true) {
          if (turn.kind !== "stream") throw this.mismatch("a streaming request", turn);
          return replayChunks(turn.chunks, turn.failAfter);
        }

        if (turn.kind !== "content" && turn.kind !== "tool_calls") {
          throw this.mismatch("a non-streaming chat request", turn);
        }
        const model = turn.model ?? params.model ?? "primary-model";
        seq += 1;
        const message: ChatCompletion["choices"][number]["message"] =
          turn.kind === "content"
            ? { role: "assistant", content: turn.text, refusal: null }
            : {
                role: "assistant",
                content: null,
                refusal: null,
                tool_calls: turn.calls.map((call) => ({
                  id: call.id,
                  type: "function" as const,
                  function: { name: call.name, arguments: JSON.stringify(call.args) },
                })),
              };
        const completion: ChatCompletion = {
          id: `chatcmpl-scripted-${seq}`,
          object: "chat.completion",
          created: 1700000000,
          model,
          choices: [
            {
              index: 0,
              message,
              logprobs: null,
              finish_reason: turn.kind === "content" ? "stop" : "tool_calls",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        };
        return completion;
      },
    },
  };

  readonly responses = {
    parse: async (
      params: CapturedParseCall["params"],
      opts?: unknown
    ): Promise<ParsedResponseStub> => {
      this.parseCalls.push({ params, opts });
      const turn = this.next("responses.parse", false);
      if (turn.kind === "error") throw turn.error;
      if (turn.kind !== "parsed") throw this.mismatch("responses.parse", turn);
      seq += 1;
      return {
        id: `resp-scripted-${seq}`,
        object: "response",
        created_at: 1700000000,
        status: "completed",
        model: turn.model ?? params.model ?? "primary-model",
        output_parsed: turn.structured,
        usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 },
      };
    },
  };

  /**
   * The single SDK-double cast, at the boundary. Justification: the provider
   * under test only touches `chat.completions.create` and `responses.parse`,
   * both implemented above with faithful shapes.
   */
  asOpenAI(): OpenAI {
    return this as unknown as OpenAI;
  }

  private next(api: string, streaming: boolean): ScriptedTurn {
    if (this.cursor >= this.turns.length) {
      throw new Error(
        `[ScriptedOpenAIClient] script exhausted at ${api} (streaming=${streaming}); ` +
          `${this.turns.length} turn(s) were scripted`
      );
    }
    const turn = this.turns[this.cursor];
    this.cursor += 1;
    return turn;
  }

  private mismatch(request: string, turn: ScriptedTurn): Error {
    return new Error(
      `[ScriptedOpenAIClient] ${request} hit a scripted "${turn.kind}" turn`
    );
  }
}

// ---------------------------------------------------------------------------
// Provider under test
// ---------------------------------------------------------------------------

/** Concrete test subclass injecting the scripted client via the protected constructor. */
export class ScriptedProvider extends OpenAICompatibleProvider {
  public readonly name = "scripted-openai-compat";
  public readonly capabilities: ProviderCapabilities = {
    supportsTools: true,
    supportsNativeJsonSchema: true,
    supportsStreaming: true,
    supportsStreamingToolCalls: true,
    supportsPromptCaching: false,
  };
  protected readonly logLabel = "SCRIPTED";
  protected readonly displayName = "Scripted";

  // Public wrapper so tests can instantiate: the base constructor is
  // protected (subclass-only by design).
  constructor(init: OpenAICompatibleProviderInit) {
    super(init);
  }
}

/**
 * Build a provider over a scripted client. Defaults keep tests fast and
 * deterministic: no retries, short timeout. Override `model`,
 * `backupModels`, `retryConfig`, `structuredOutput` or `config` per test.
 */
export function scriptedProvider(
  client: ScriptedOpenAIClient,
  overrides: Partial<OpenAICompatibleProviderInit> = {}
): ScriptedProvider {
  return new ScriptedProvider({
    client: client.asOpenAI(),
    model: "primary-model",
    retryConfig: { timeout: 2000, retries: 0 },
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Shared wire-test harness helpers (vendor-neutral)
// ---------------------------------------------------------------------------

/** Minimal provider input shared by the wire-transcript suites. */
export function baseInput(): GenerateMessageInput<undefined> {
  return { prompt: "hi", history: [], context: undefined };
}

/** Resolve to the thrown value (undefined when the promise resolves). */
export async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return undefined;
  } catch (error: unknown) {
    return error;
  }
}

/** Drain a stream into an array. */
export async function collectChunks(
  stream: AsyncGenerator<GenerateMessageStreamChunk>
): Promise<Array<GenerateMessageStreamChunk>> {
  const chunks: Array<GenerateMessageStreamChunk> = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}
