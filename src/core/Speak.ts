/**
 * Speak: the one call that phrases the reply (design §4.6).
 *
 * Runner decides who speaks and what is still pending; this module owns the
 * prompt, the envelope, the provider call(s) and the parsing. The envelope is
 * `{ message, ...pending fields }`, every property required and nullable, so
 * the model answers and harvests in one call. Tools run in rounds: each round
 * the model may call tools, their results go back as history, and the model
 * is asked again; after `maxToolLoops` rounds it is asked once more without
 * tools so a message always comes back.
 *
 * Speak never throws for a provider failure and never writes session data:
 * a failed or empty round returns `{ deferred }` for Runner to re-park, and
 * field values come back raw for Runner to validate.
 */

import { ProviderError, classify, type ErrorKind } from "@providerkit/core";

import type { GenerateMessageInput, TokenUsage } from "../types/ai.js";
import type { AgentOptions } from "../types/agent.js";
import type { FieldDefs } from "../types/flow.js";
import type { History } from "../types/history.js";
import type { StructuredSchema } from "../types/schema.js";
import type { StepOutcomeCode } from "../types/session.js";
import type { Tool, ToolCtx, ToolResult } from "../types/tool.js";
import { assistantMessage, toolMessage } from "../utils/history.js";
import { extractEmbeddedJSONObject, isRecord, tryParseJSONResponse } from "../utils/json.js";
import { logger } from "../utils/logger.js";
import { isKnown, toWireSchema } from "../utils/schema.js";
import { StreamingMessageDecoder } from "../utils/streamingMessage.js";
import { render, type TemplateScope } from "../utils/template.js";
import { addUsage, readUsage } from "../utils/usage.js";
import type { Deferral, SpeakOutcome, SpeakRequest, SpeakStreamChunk } from "./contracts.js";
import {
  describeField,
  factsSection,
  instructionsSection,
  joinSections,
  pendingSection,
  stablePrefix,
} from "./Prompt.js";

const DEFAULT_MAX_TOOL_LOOPS = 5;

/**
 * Every provider failure used to arrive here as one word, and Runner re-parked
 * the step on a 1m/5m/15m ladder that never ended. So a spent balance, a wrong
 * key or a prompt past the context window re-ran understand AND speak every
 * fifteen minutes forever, and the customer was never answered. The kind says
 * which of those it is; `RETRY_KINDS` says which are worth waking for at all.
 */
const DEFER_CODE = {
  aborted: "provider-unavailable",
  timeout: "provider-unavailable",
  network: "provider-unavailable",
  overload: "provider-unavailable",
  rate: "provider-unavailable",
  unknown: "provider-unavailable",
  quota: "provider-quota",
  entitlement: "provider-auth",
  auth: "provider-auth",
  model: "provider-invalid",
  invalid: "provider-invalid",
  content: "provider-invalid",
  context: "provider-context",
} as const satisfies Record<ErrorKind, StepOutcomeCode>;

/** Kinds a later wake can fix on its own. Everything else needs a human. */
const RETRY_KINDS: ReadonlySet<ErrorKind> = new Set<ErrorKind>(["timeout", "network", "overload", "rate", "unknown"]);

/** The provider said nothing usable, which is not an error object. Always worth one more try. */
const UNAVAILABLE: Deferral = { code: "provider-unavailable", retryable: true };

/** What kind of wall this was, and whether waiting at it helps. */
function deferralOf(error: unknown): Deferral {
  const kind = classify(error);
  const reset = error instanceof ProviderError ? error.resetAtMs : undefined;
  // A usage window that says when it reopens is worth exactly one wake, then.
  // Without that number, waiting is guessing, and the ladder guesses in minutes
  // at a limit measured in hours.
  const retryable = RETRY_KINDS.has(kind) || (kind === "quota" && reset !== undefined);
  return { code: DEFER_CODE[kind], retryable, ...(reset !== undefined ? { resetAtMs: reset } : {}) };
}
/** Gemini rejects any other envelope property name. */
const WIRE_NAME = /^[a-zA-Z0-9_-]+$/;

const GUIDELINE_HEADING = "## Guideline for your reply (adapt to the conversation)";
const DEFAULT_GUIDELINE =
  "Collect what is still missing below, in the flow of the conversation, one or two things per message.";
const TOOLS_SECTION =
  "## Tools\nCall the tools provided when you need to look something up or act before answering. Once you have what you need, answer the customer.";
const FINAL_SECTION =
  "## Wrap up\nAnswer the customer now, using the tool results in the conversation. Do not call any tools.";
const SPEAK_FIRST =
  "## Situation\nThere is no new message from the customer. You speak first: open naturally, do not answer a question nobody asked.";

interface ToolCall {
  toolName: string;
  arguments: Record<string, unknown>;
}

/** What one provider round produced, before parsing. */
interface Reply {
  message: string;
  structured: unknown;
  usage?: TokenUsage;
}

/** The model's own record of how it reached a tool round, replayed on the next. */
type Thought = { reasoning?: string; reasoningDetails?: unknown[] };

/** What one tool call sends back to the model, plus the data it wrote. */
interface CallResult<D> {
  content: string;
  data?: Partial<D>;
}

/** The wire schema plus the slug → property-name table (aliased when a slug is not a legal name). */
interface Envelope {
  schema: StructuredSchema;
  wire: Map<string, string>;
}

export class Speak<C = unknown, D = unknown> {
  constructor(private readonly options: AgentOptions<C, D>) {}

  async run(req: SpeakRequest<C, D>): Promise<SpeakOutcome> {
    const rounds = this.rounds(req, false);
    let next = await rounds.next();
    while (!next.done) next = await rounds.next();
    return next.value;
  }

  /** `run`, yielding the message text as it arrives; ends with `{ done, outcome }`. */
  async *stream(req: SpeakRequest<C, D>): AsyncIterable<SpeakStreamChunk> {
    const rounds = this.rounds(req, true);
    let next = await rounds.next();
    while (!next.done) {
      yield { delta: next.value };
      next = await rounds.next();
    }
    yield { done: true, outcome: next.value };
  }

  /** The round loop shared by both entry points: yields deltas, returns the outcome. */
  private async *rounds(req: SpeakRequest<C, D>, streaming: boolean): AsyncGenerator<string, SpeakOutcome> {
    const talk = req.talk;
    const envelope = buildEnvelope(this.options.fields, "idle" in talk ? [] : talk.pending);
    const { system, turn: prompt } = buildPrompt(this.options, req, envelope);
    const maxLoops = this.options.maxToolLoops ?? DEFAULT_MAX_TOOL_LOOPS;
    const tools = maxLoops > 0 ? req.tools : [];
    const wireTools = tools.map((t) => ({ id: t.id, name: t.id, description: t.description, parameters: t.parameters }));

    let history: History = req.history;
    const fields: Record<string, unknown> = {};
    const data: Record<string, unknown> = {};
    const toolCalls: ToolCall[] = [];
    let llmCalls = 0;
    let usage: TokenUsage | undefined;
    let message = "";

    for (let round = 0; ; round++) {
      const offerTools = wireTools.length > 0 && round < maxLoops;
      const input: GenerateMessageInput<C> = {
        prompt: joinSections(prompt, offerTools ? TOOLS_SECTION : round > 0 ? FINAL_SECTION : null),
        ...(system ? { system } : {}),
        history,
        context: req.context,
        tools: offerTools ? wireTools : undefined,
        parameters: { jsonSchema: envelope.schema, schemaName: "speak" },
      };
      llmCalls++;
      let reply: Reply;
      try {
        // ponytail: every round streams as it arrives, so a preamble the model
        // writes beside a tool call ("deixa eu ver") reaches the stream but not
        // `spoken.message`. Ceiling: joined deltas exceed the final message on
        // such a round. Upgrade: hold deltas until the provider says no tool call
        // is coming, once providers report that before the end of the stream.
        reply = yield* this.call(input, streaming);
      } catch (error) {
        const deferred = deferralOf(error);
        logger.warn(`[Speak] provider failed on call ${llmCalls} (${deferred.code}): ${describeError(error)}`);
        // A round that threw still bills the rounds before it.
        return { deferred, llmCalls, ...(usage ? { usage } : {}) };
      }
      usage = addUsage(usage, reply.usage);

      const read = readReply(reply, envelope);
      message = read.message;
      Object.assign(fields, read.fields);
      if (!offerTools || read.toolCalls.length === 0) break;

      const ctx: ToolCtx<C, D> = {
        context: req.context,
        data: Object.assign({}, req.data, data),
        history,
        run: "idle" in talk ? undefined : talk.run,
        now: req.now,
      };
      const executed = await this.executeRound(read.toolCalls, tools, ctx, round, read.message, read.thought);
      history = [...history, ...executed.items];
      Object.assign(data, executed.data);
      toolCalls.push(...read.toolCalls);
    }

    if (!message.trim()) {
      logger.warn(`[Speak] the model returned no message after ${llmCalls} call(s); deferring.`);
      return { deferred: UNAVAILABLE, llmCalls, ...(usage ? { usage } : {}) };
    }
    return { spoken: { message, fields, data, toolCalls, llmCalls, ...(usage ? { usage } : {}) } };
  }

  /** One provider call. Streaming yields clean message deltas; both paths return the same shape. */
  private async *call(input: GenerateMessageInput<C>, streaming: boolean): AsyncGenerator<string, Reply> {
    if (!streaming) {
      const out = await this.options.provider.generateMessage<C, unknown>(input);
      return { message: out.message, structured: out.structured, usage: readUsage(out.metadata) };
    }
    const decoder = new StreamingMessageDecoder();
    let message = "";
    let structured: unknown;
    // The counts ride on the terminal chunk, so the last one that carries any wins.
    let usage: TokenUsage | undefined;
    for await (const chunk of this.options.provider.generateMessageStream<C, unknown>(input)) {
      const clean = decoder.push(chunk.accumulated);
      if (clean.delta) yield clean.delta;
      message = clean.message;
      if (chunk.structured !== undefined) structured = chunk.structured;
      usage = readUsage(chunk.metadata) ?? usage;
    }
    return { message, structured, usage };
  }

  /**
   * Run one round of tool calls and turn them into history items. Consecutive
   * concurrency-safe calls run together; anything else runs alone, in order.
   * Data patches merge in call order whatever the completion order.
   */
  private async executeRound(
    calls: ToolCall[],
    tools: Tool<C, D>[],
    ctx: ToolCtx<C, D>,
    round: number,
    preamble: string,
    thought: Thought,
  ): Promise<{ items: History; data: Record<string, unknown> }> {
    const safe = (call: ToolCall): boolean => {
      const tool = tools.find((t) => t.id === call.toolName);
      if (!tool || tool.isDestructive?.(call.arguments)) return false;
      return tool.isConcurrencySafe?.(call.arguments) ?? tool.isReadOnly?.(call.arguments) ?? false;
    };
    const results: CallResult<D>[] = [];
    for (let i = 0; i < calls.length; ) {
      let j = i + 1;
      if (safe(calls[i])) while (j < calls.length && safe(calls[j])) j++;
      results.push(...(await Promise.all(calls.slice(i, j).map((call) => this.executeCall(call, tools, ctx)))));
      i = j;
    }

    const ids = calls.map((_, i) => `call-${round}-${i}`);
    const items: History = [
      assistantMessage(
        preamble || null,
        calls.map((call, i) => ({ id: ids[i], name: call.toolName, arguments: call.arguments })),
        thought,
      ),
      ...calls.map((call, i) => toolMessage(ids[i], call.toolName, results[i].content)),
    ];
    const data: Record<string, unknown> = {};
    for (const result of results) if (isRecord(result.data)) Object.assign(data, result.data);
    return { items, data };
  }

  /** One tool call through its gates and handler. Never throws: the model sees `{ error }`. */
  private async executeCall(call: ToolCall, tools: Tool<C, D>[], ctx: ToolCtx<C, D>): Promise<CallResult<D>> {
    const tool = tools.find((t) => t.id === call.toolName);
    if (!tool) return { content: failure(`Tool "${call.toolName}" is not available.`) };
    try {
      const validation = await tool.validateInput?.(call.arguments, ctx);
      if (validation && !validation.valid) {
        return {
          content: failure(`Validation failed: ${validation.error ?? "invalid input"}`, {
            correctedInput: validation.correctedInput,
          }),
        };
      }
      const permission = await tool.checkPermissions?.(call.arguments, ctx);
      if (permission && !permission.allowed) {
        return { content: failure(`Permission denied: ${permission.reason ?? "not allowed"}`) };
      }
      const result: ToolResult<D> = (await tool.handler(call.arguments, ctx)) ?? {};
      return { content: serialize(result.value, tool.maxResultSizeChars), data: result.data };
    } catch (error) {
      logger.warn(`[Speak] tool "${call.toolName}" threw: ${describeError(error)}`);
      return { content: failure(describeError(error)) };
    }
  }
}

// ── Prompt ──────────────────────────────────────────────────────────────

function buildPrompt<C, D>(
  options: AgentOptions<C, D>,
  req: SpeakRequest<C, D>,
  envelope: Envelope,
): { system: string | null; turn: string } {
  const talk = req.talk;
  const scope: TemplateScope = { data: req.data, context: req.context, input: "idle" in talk ? undefined : talk.run.input };
  const guideline = (text: string) => `${GUIDELINE_HEADING}\n${render(text, scope)}`;
  const body =
    "idle" in talk
      ? [guideline(talk.idle.prompt)]
      : [
          `## Flow\n${talk.flow.name}${talk.flow.description ? `: ${talk.flow.description}` : ""}`,
          guideline(talk.step.prompt ?? DEFAULT_GUIDELINE),
          pendingSection(talk.pending, options.fields, talk.step.ask ?? {}, scope),
          // `Partial<D>` is a mapped type; the guard is how it reaches an index-signature parameter without a cast.
          factsSection(options.fields, isRecord(req.data) ? req.data : {}),
        ];
  const { system, inline } = stablePrefix(options, scope);
  return {
    system,
    turn: joinSections(
      inline,
      ...body,
      instructionsSection([{ caption: "[Always]", items: req.instructions }], scope),
      inputSection(req.input),
      formatSection(envelope, options.fields),
    ),
  };
}

/** The customer's latest text, quoted. Without one, on anything but a message, the assistant opens the exchange. */
function inputSection(input: SpeakRequest["input"]): string | null {
  const text = input.text?.trim();
  if (text) return `## Customer's latest message\n"${text}"`;
  return input.kind === "message" ? null : SPEAK_FIRST;
}

/** The envelope restated in words, for providers that follow the schema by prompt only. */
function formatSection(envelope: Envelope, fields: FieldDefs): string {
  const lines = [
    "## Response format",
    "Answer with one JSON object and nothing else: no text before or after it, no code fences.",
    '- "message": what you say to the customer, as natural text. Never put field names, keys or raw values in it.',
  ];
  for (const [slug, name] of envelope.wire) {
    lines.push(
      `- "${name}": ${describeField(slug, fields[slug] ?? { type: "string" })}. The value the customer gave, or null when they did not give one.`,
    );
  }
  if (envelope.wire.size > 0) {
    lines.push(
      "",
      "Rules for the field properties:",
      "- Fill a property only with what the customer actually said, in this message or earlier. Never guess or invent a value.",
      "- People often give several details at once: take every one that matches a property.",
      "- A property the customer did not answer stays null; never put a question or a placeholder in it.",
      "- Property names must match exactly as written above.",
    );
  }
  return lines.join("\n");
}

// ── Envelope ────────────────────────────────────────────────────────────

function buildEnvelope(fields: FieldDefs, pending: string[]): Envelope {
  const wire = new Map<string, string>();
  const defs: FieldDefs = { message: { type: "string" } };
  pending.forEach((slug, i) => {
    // ponytail: a slug spelled like the reply key or with characters Gemini rejects
    // rides under an alias; the table maps it back. Ceiling: a real slug named
    // `field_N` could collide with an alias. Upgrade: bump the alias until free.
    const name = WIRE_NAME.test(slug) && slug !== "message" ? slug : `field_${i}`;
    wire.set(slug, name);
    defs[name] = fields[slug] ?? { type: "string" };
  });
  return { schema: toWireSchema(defs, { nullable: true }), wire };
}

/**
 * Read one round's envelope, tolerating what a prompt-only provider does:
 * missing keys, nulls, stray text around the object, arguments as a string.
 */
function readReply(
  reply: Reply,
  envelope: Envelope,
): { message: string; fields: Record<string, unknown>; toolCalls: ToolCall[]; thought: Thought } {
  const parsed = isRecord(reply.structured) ? reply.structured : extractEmbeddedJSONObject(reply.message);
  const message = parsed ? (typeof parsed.message === "string" ? parsed.message : "") : reply.message;
  const fields: Record<string, unknown> = {};
  for (const [slug, name] of envelope.wire) {
    const value = parsed?.[name];
    if (isKnown(value)) fields[slug] = value;
  }
  return { message, fields, toolCalls: parseToolCalls(parsed?.toolCalls), thought: readThought(parsed) };
}

/** What the model thought before it called a tool, if the provider sent it. */
function readThought(parsed: Record<string, unknown> | undefined): Thought {
  return {
    ...(typeof parsed?.reasoning === "string" && parsed.reasoning ? { reasoning: parsed.reasoning } : {}),
    ...(Array.isArray(parsed?.reasoningDetails) ? { reasoningDetails: parsed.reasoningDetails } : {}),
  };
}

function parseToolCalls(value: unknown): ToolCall[] {
  if (!Array.isArray(value)) return [];
  const calls: ToolCall[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.toolName !== "string") continue;
    const raw = typeof item.arguments === "string" ? tryParseJSONResponse(item.arguments) : item.arguments;
    calls.push({ toolName: item.toolName, arguments: isRecord(raw) ? raw : {} });
  }
  return calls;
}

// ── Tool results ────────────────────────────────────────────────────────

function failure(error: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ error, ...extra });
}

/** A tool's value as the model reads it, cut at `max` characters with a notice. */
function serialize(value: unknown, max?: number): string {
  let text: string;
  if (value === undefined) text = '{"ok":true}';
  else if (typeof value === "string") text = value;
  else {
    try {
      text = JSON.stringify(value) ?? '{"ok":true}';
    } catch {
      text = "[result could not be serialized]";
    }
  }
  if (max === undefined || max <= 0 || text.length <= max) return text;
  return `${text.slice(0, max)}\n[truncated: ${text.length} chars total, showing the first ${max}]`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
