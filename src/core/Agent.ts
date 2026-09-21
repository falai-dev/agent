/**
 * Agent: immutable configuration plus one entry point, `turn`.
 *
 * One instance serves every session; context and history arrive per turn.
 * A turn is the eight phases of docs/rfc/v4-one-flow.md §4 in one line each:
 * Runner moves the runs by code, Understand and Speak spend at most one
 * provider call apiece, and Runner settles what they returned.
 */

import type { AgentOptions, TurnInput, TurnResult, TurnStreamChunk } from "../types/agent.js";
import type { TokenUsage } from "../types/ai.js";
import type { CompactionOptions } from "../types/compaction.js";
import { FlowConfigurationError } from "../types/errors.js";
import { logger, LoggerLevel } from "../utils/logger.js";
import { addUsage } from "../utils/usage.js";
import { CompactionEngine } from "./CompactionEngine.js";
import type { IdleRequest, SpeakOutcome, TalkRequest } from "./contracts.js";
import { validateFlow } from "./FlowSpec.js";
import { Runner, type Turn } from "./Runner.js";
import { Speak } from "./Speak.js";
import { Understand } from "./Understand.js";

export class Agent<C = unknown, D = unknown> {
  private readonly runner: Runner<C, D>;
  private readonly understand: Understand<C, D>;
  private readonly speak: Speak<C, D>;
  private readonly compaction?: CompactionOptions;

  constructor(readonly options: AgentOptions<C, D>) {
    if (options.debug) logger.setLevel(LoggerLevel.DEBUG);
    validate(options);
    this.compaction = compactionOptions(options);
    this.runner = new Runner(options);
    this.understand = new Understand(options);
    this.speak = new Speak(options);
  }

  /** Take whatever just happened and return the messages to send and the timers to set. */
  async turn(input: TurnInput<C, D>): Promise<TurnResult<D>> {
    const { turn, talk } = await this.open(input);
    await this.runner.settle(turn, talk ? await this.speak.run(this.runner.speakRequest(turn, talk)) : null);
    return this.runner.finish(turn);
  }

  /** `turn`, streaming the spoken text as it is generated; the last chunk carries the result. */
  async *turnStream(input: TurnInput<C, D>): AsyncIterable<TurnStreamChunk<D>> {
    const { turn, talk } = await this.open(input);
    let outcome: SpeakOutcome | null = null;
    if (talk) {
      for await (const chunk of this.speak.stream(this.runner.speakRequest(turn, talk))) {
        if ("delta" in chunk) yield { delta: chunk.delta };
        else outcome = chunk.outcome;
      }
    }
    await this.runner.settle(turn, outcome);
    yield { done: true, result: this.runner.finish(turn) };
  }

  /** Load, Ingest, Understand, Decide and Run: everything before the one speaker is known. */
  private async open(input: TurnInput<C, D>): Promise<{ turn: Turn<C, D>; talk: TalkRequest<C, D> | IdleRequest<C, D> | null }> {
    const { runner } = this;
    const compacted = await this.compacted(input);
    const turn = runner.begin(compacted.input);
    turn.llmCalls += compacted.llmCalls;
    turn.usage = addUsage(turn.usage, compacted.usage);
    const request = runner.understandRequest(turn);
    runner.decide(turn, request ? await this.understand.run(request) : null);
    return { turn, talk: await runner.advance(turn) };
  }

  /** With `compaction` set, the history both calls see is trimmed once per turn; a summarization is one model call. */
  private async compacted(
    input: TurnInput<C, D>,
  ): Promise<{ input: TurnInput<C, D>; llmCalls: number; usage?: TokenUsage }> {
    const history = input.history ?? input.session?.history;
    if (!this.compaction || !history?.length) return { input, llmCalls: 0 };
    const result = await CompactionEngine.checkAndCompact(history, this.compaction);
    const llmCalls = result.strategy === "auto_compact" ? 1 : 0;
    const usage = result.usage ? { usage: result.usage } : {};
    if (result.history === history) return { input, llmCalls, ...usage };
    const trimmed: TurnInput<C, D> = Object.assign({}, input);
    trimmed.history = result.history;
    return { input: trimmed, llmCalls, ...usage };
  }
}

function compactionOptions<C, D>(options: AgentOptions<C, D>): CompactionOptions | undefined {
  const config = options.compaction;
  if (!config || config.enabled === false) return undefined;
  const resolved: CompactionOptions = {
    maxTokens: config.maxTokens,
    compactionThreshold: config.compactionThreshold ?? 0.8,
    preserveRecentCount: config.preserveRecentCount ?? 4,
    maxToolResultChars: config.maxToolResultChars ?? 5000,
    provider: options.provider,
  };
  CompactionEngine.validateOptions(resolved);
  return resolved;
}

/** Every name a flow uses must resolve now, not on the turn that first reaches it. */
function validate<C, D>(options: AgentOptions<C, D>): void {
  const ids = new Set<string>();
  for (const flow of options.flows ?? []) {
    if (ids.has(flow.id)) {
      throw new FlowConfigurationError(
        `[FlowConfigurationError] flow "${flow.id}" is declared twice: flow ids must be unique. Rename one of them.`,
      );
    }
    ids.add(flow.id);
    for (const warning of validateFlow(flow, options).warnings) logger.warn(`[Agent] ${warning}`);
  }
  for (const tool of options.tools ?? []) {
    // A function's parameters are a JSON Schema object, so anything else is a
    // mistake — most often the action's `{ name: { type } }` map written in a
    // tool. Only DeepSeek rejects it on the wire; everywhere else the tool is
    // simply never callable, and nothing says so.
    if (tool.parameters && tool.parameters.type !== "object") {
      throw new FlowConfigurationError(
        `[FlowConfigurationError] tool "${tool.id}": parameters must be a JSON Schema object. ` +
          `Write { type: "object", properties: { ... }, required: [...] }.`,
      );
    }
  }
  const { idle } = options;
  if (idle && idle !== "silent") {
    const known = new Set((options.tools ?? []).map((tool) => tool.id));
    for (const name of idle.tools ?? []) {
      if (!known.has(name)) {
        throw new FlowConfigurationError(
          `[FlowConfigurationError] idle: unknown tool "${name}". Register it in the agent's tools or fix the name.`,
        );
      }
    }
  }
}
