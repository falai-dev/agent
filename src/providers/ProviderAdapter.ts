/**
 * The bridge between this framework's provider seam and `@providerkit/core`.
 *
 * The two seams are different shapes on purpose. Core speaks in normalized
 * chunks — `createStream(messages, tools, opts)` — because that is the only
 * shape every vendor's wire actually is. This framework speaks in whole turns:
 * `generateMessage(input)` takes a composed prompt plus history and hands back
 * a parsed structured response, because that is what a flow step needs.
 *
 * Everything vendor-specific now lives one layer down, so what is left here is
 * exactly the translation and nothing else: history to messages, tools to tool
 * definitions, chunks to an accumulated turn.
 *
 * Both entry points run the SAME pipeline. `generateMessage` is
 * `generateMessageStream` drained — one code path for the streaming and
 * non-streaming APIs, where there used to be two of everything per vendor and
 * the pair drifted (the streaming path silently lost native schema enforcement
 * because only the non-streaming one could reach `responses.parse`).
 */

import {
  ProviderError,
  classify,
  isBackupEligible,
  requireContent,
  streamWatch,
  streamWithBackupModels,
  watchChunks,
  withStreamRetry,
  type ChatMessage,
  type JsonObjectSchema,
  type Provider,
  type ProviderChunk,
  type StreamOptions,
  type ToolDefinition,
} from "@providerkit/core";

import type {
  AgentStructuredResponse,
  AiProvider,
  GenerateMessageInput,
  GenerateMessageOutput,
  GenerateMessageStreamChunk,
  ProviderCapabilities,
} from "../types/ai";
import type { HistoryItem } from "../types/history";
import { assertUsableCompletion } from "../utils/completion";
import { logger } from "../utils/logger";

/** Provider timeout (ms) + retry count, after defaults are applied. */
export interface RetryConfig {
  /**
   * How long a stream may stay SILENT before it is considered wedged.
   *
   * In v2 this was a total wall-clock cap on a non-streaming call, so a healthy
   * but long generation died at the one-minute mark. It now bounds silence
   * instead: time to the first byte, and the gap between any two after it. A
   * request that never gets a reply still fails at the same moment; one that is
   * steadily producing tokens is left alone.
   */
  timeout: number;
  /** Retries AFTER the first attempt, so `0` still performs one call. */
  retries: number;
}

const DEFAULT_RETRY_CONFIG: RetryConfig = { timeout: 60_000, retries: 3 };

/**
 * Normalize a provider's optional retry config against the defaults. `timeout`
 * uses `||` (a 0ms timeout is degenerate — it would abort every call before it
 * began), while `retries` uses `??` so an explicit `retries: 0` is honored
 * rather than treated as unset.
 */
export function resolveRetryConfig(input?: { timeout?: number; retries?: number }): RetryConfig {
  return {
    timeout: input?.timeout || DEFAULT_RETRY_CONFIG.timeout,
    retries: input?.retries ?? DEFAULT_RETRY_CONFIG.retries,
  };
}

/**
 * Request defaults sent with every call.
 *
 * Only the fields every supported shape has. In v2 each provider took its own
 * vendor's SDK parameter type here — which is how one vendor's package ended
 * up in the dependency tree of consumers who used a different vendor, and how
 * a field set on one provider silently vanished on another.
 */
export interface RequestConfig {
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  stopSequences?: string[];
}

export interface ProviderAdapterInit {
  /** The `@providerkit/core` provider this adapter drives. */
  provider: Provider;
  model: string;
  /**
   * Sampling defaults for every call, overridden by anything the caller sets
   * per turn. Only the fields every supported shape has: a knob one vendor
   * alone understands belongs to that vendor's own client, not to a seam four
   * of them share.
   */
  defaults?: RequestConfig;
  /** Tried in order after the primary. */
  backupModels?: string[];
  retryConfig?: { timeout?: number; retries?: number };
}

/**
 * A model id the endpoint will not serve is grounds to try the next model on
 * the list — that is what the list is FOR. Core's default is deliberately
 * narrower (a throttle and an overload only), because there a typo'd model
 * should fail loudly rather than quietly answer from a different one. Here the
 * backup list is explicit and per-provider, so the wider reading is the right
 * one: a gateway that has deprecated or cannot currently route the primary is
 * routine, and falling through is exactly the intent.
 */
function shouldTryBackup(error: unknown): boolean {
  const kind = classify(error);
  return isBackupEligible(kind) || kind === "model";
}

/** History plus the composed prompt, as the seam's messages. */
export function toMessages(history: HistoryItem[], prompt: string): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const item of history) {
    switch (item.role) {
      case "system":
        out.push({ role: "system", content: item.content });
        break;
      case "user":
        out.push({ role: "user", content: item.content });
        break;
      case "assistant":
        out.push({
          role: "assistant",
          content: item.content ?? "",
          ...(item.tool_calls?.length
            ? {
                toolCalls: item.tool_calls.map((call) => ({
                  id: call.id,
                  name: call.name,
                  // The seam carries raw JSON: arguments arrive in fragments and
                  // can be truncated mid-stream, so parsing is the consumer's.
                  arguments: JSON.stringify(call.arguments),
                })),
              }
            : {}),
        });
        break;
      case "tool":
        out.push({
          role: "tool",
          toolCallId: item.tool_call_id,
          name: item.name,
          content: typeof item.content === "string" ? item.content : JSON.stringify(item.content),
        });
        break;
    }
  }
  out.push({ role: "user", content: prompt });
  return out;
}

function toTools(tools: GenerateMessageInput<unknown>["tools"]): ToolDefinition[] {
  return (tools ?? []).map((tool) => ({
    name: tool.name || tool.id,
    description: tool.description ?? "",
    inputSchema: (tool.parameters ?? { type: "object" }) as JsonObjectSchema,
  }));
}

/**
 * A schema with nothing in it is not a request for JSON — it is a caller who
 * has no schema. Sent as one it becomes a `json_schema` block with no `type`,
 * which is a flat 400 on the shapes that enforce schemas.
 */
function toJsonOutput(input: GenerateMessageInput<unknown>): StreamOptions["json"] {
  const schema = input.parameters?.jsonSchema;
  if (!schema || Object.keys(schema).length === 0) return undefined;
  return {
    name: input.parameters?.schemaName || "structured_output",
    schema: schema as JsonObjectSchema,
  };
}

/** What a turn accumulates into as its chunks arrive. */
interface Accumulator {
  text: string;
  model: string;
  finishReason?: string;
  promptTokens?: number;
  completionTokens?: number;
  cachedInputTokens?: number;
  calls: Map<number, { name: string; arguments: string }>;
}

function fold(acc: Accumulator, chunk: ProviderChunk): string {
  if (chunk.usage) {
    acc.promptTokens = chunk.usage.inputTokens;
    acc.completionTokens = chunk.usage.outputTokens;
    acc.cachedInputTokens = chunk.usage.cachedInputTokens;
  }
  if (chunk.finishReason) acc.finishReason = chunk.finishReason;
  for (const call of chunk.toolCalls ?? []) {
    const entry = acc.calls.get(call.index) ?? { name: "", arguments: "" };
    if (call.name) entry.name = call.name;
    if (call.arguments) entry.arguments += call.arguments;
    acc.calls.set(call.index, entry);
  }
  if (!chunk.content) return "";
  acc.text += chunk.content;
  return chunk.content;
}

type ToolCallList = NonNullable<AgentStructuredResponse["toolCalls"]>;

function toolCallsOf(acc: Accumulator, label: string): ToolCallList {
  const out: ToolCallList = [];
  for (const [, entry] of [...acc.calls.entries()].sort(([a], [b]) => a - b)) {
    if (!entry.name) continue;
    let args: Record<string, unknown> = {};
    try {
      if (entry.arguments) args = JSON.parse(entry.arguments) as Record<string, unknown>;
    } catch (error) {
      logger.warn(`[${label}] Failed to parse tool call arguments:`, error);
    }
    out.push({ toolName: entry.name, arguments: args });
  }
  return out;
}

export abstract class ProviderAdapter implements AiProvider {
  public abstract readonly name: string;
  public abstract readonly capabilities: ProviderCapabilities;

  protected readonly provider: Provider;
  protected readonly primaryModel: string;
  protected readonly backupModels: string[];
  protected readonly retryConfig: RetryConfig;
  private readonly defaults: ProviderAdapterInit["defaults"];

  protected constructor(init: ProviderAdapterInit) {
    this.defaults = init.defaults;
    this.provider = init.provider;
    this.primaryModel = init.model;
    this.backupModels = init.backupModels ?? [];
    this.retryConfig = resolveRetryConfig(init.retryConfig);
  }

  async generateMessage<TContext = unknown, TStructured = AgentStructuredResponse>(
    input: GenerateMessageInput<TContext>,
  ): Promise<GenerateMessageOutput<TStructured>> {
    let last: GenerateMessageStreamChunk<TStructured> | undefined;
    for await (const chunk of this.generateMessageStream<TContext, TStructured>(input)) {
      last = chunk;
    }
    // The stream always ends on its terminal chunk, and the empty-completion
    // guard has already thrown if there was nothing in it.
    if (!last) throw new ProviderError(this.name, "overload", `${this.name}: no response`);
    return { message: last.accumulated, metadata: last.metadata, structured: last.structured };
  }

  async *generateMessageStream<TContext = unknown, TStructured = AgentStructuredResponse>(
    input: GenerateMessageInput<TContext>,
  ): AsyncGenerator<GenerateMessageStreamChunk<TStructured>> {
    const messages = toMessages(input.history, input.prompt);
    const tools = toTools(input.tools);
    const json = toJsonOutput(input);
    const acc: Accumulator = { text: "", model: this.primaryModel, calls: new Map() };

    const opts: StreamOptions = {
      ...this.defaults,
      ...(input.parameters?.maxOutputTokens !== undefined
        ? { maxTokens: input.parameters.maxOutputTokens }
        : {}),
      ...(input.parameters?.reasoning?.effort ? { effort: input.parameters.reasoning.effort } : {}),
      ...(json ? { json } : {}),
    };

    const attempt = (model: string) =>
      withStreamRetry<ProviderChunk>(
        (signal) => {
          acc.model = model;
          const watch = streamWatch({
            provider: this.name,
            idleMs: this.retryConfig.timeout,
            signal,
          });
          return requireContent(
            this.name,
            watchChunks(
              watch,
              this.provider.createStream(messages, tools, {
                ...opts,
                model,
                signal: watch.signal,
              }),
            ),
          );
        },
        {
          maxAttempts: this.retryConfig.retries + 1,
          ...(input.signal ? { signal: input.signal } : {}),
          onRetry: ({ error, attempt: n }) =>
            logger.warn(`[${this.name}] ${model} attempt ${n} failed, retrying:`, error),
        },
      );

    const stream = streamWithBackupModels<ProviderChunk>(attempt, {
      models: [this.primaryModel, ...this.backupModels],
      shouldTryNext: shouldTryBackup,
      onFallback: ({ model, position, total }) =>
        logger.warn(`[${this.name}] falling back to ${model} (${position}/${total})`),
    });

    for await (const chunk of stream) {
      const delta = fold(acc, chunk);
      if (delta) yield { delta, accumulated: acc.text, done: false };
    }

    const toolCalls = toolCallsOf(acc, this.name);
    let structured: TStructured | undefined;
    if (json && acc.text) {
      try {
        structured = JSON.parse(acc.text) as TStructured;
      } catch (error) {
        logger.warn(`[${this.name}] Failed to parse JSON response:`, error);
      }
    }
    if (toolCalls.length > 0) {
      structured = {
        ...(structured ?? {}),
        message: (structured as AgentStructuredResponse | undefined)?.message || acc.text,
        toolCalls,
      } as TStructured;
    }

    // A parsed-but-blank message with no tool calls is as empty as no text. The
    // stream guard upstream only knows about chunks; this one knows what the
    // turn was FOR, and a turn that produced `{"message":""}` did not do it.
    assertUsableCompletion(structured, acc.text, toolCalls.length, this.name);

    yield {
      delta: "",
      accumulated: acc.text,
      done: true,
      metadata: {
        model: acc.model,
        ...(acc.finishReason ? { finishReason: acc.finishReason } : {}),
        ...(acc.promptTokens !== undefined
          ? {
              tokensUsed: acc.promptTokens + (acc.completionTokens ?? 0),
              promptTokens: acc.promptTokens,
              completionTokens: acc.completionTokens,
              // New in v3: the cache-hit subset of the prompt, which the old
              // adapters never read and which is billed far cheaper.
              cachedInputTokens: acc.cachedInputTokens,
            }
          : {}),
      },
      structured,
    };
  }
}
