/**
 * Agent: immutable configuration plus one entry point, `turn`.
 *
 * One instance serves every session; context and history arrive per turn.
 * A turn is the eight phases of docs/rfc/v4-one-flow.md §4 in one line each:
 * Runner moves the runs by code, Understand and Speak spend at most one
 * provider call apiece, and Runner settles what they returned.
 */

import type { AgentOptions, TurnInput, TurnResult, TurnStreamChunk } from "../types/agent.js";
import { FlowConfigurationError } from "../types/errors.js";
import { logger, LoggerLevel } from "../utils/logger.js";
import type { SpeakOutcome } from "./contracts.js";
import { validateFlow } from "./FlowSpec.js";
import { Runner } from "./Runner.js";
import { Speak } from "./Speak.js";
import { Understand } from "./Understand.js";

export class Agent<C = unknown, D = unknown> {
  private readonly runner: Runner<C, D>;
  private readonly understand: Understand<C, D>;
  private readonly speak: Speak<C, D>;

  constructor(readonly options: AgentOptions<C, D>) {
    if (options.debug) logger.setLevel(LoggerLevel.DEBUG);
    validate(options);
    this.runner = new Runner(options);
    this.understand = new Understand(options);
    this.speak = new Speak(options);
  }

  /** Take whatever just happened and return the messages to send and the timers to set. */
  async turn(input: TurnInput<C, D>): Promise<TurnResult<D>> {
    const { runner } = this;
    const turn = runner.begin(input);
    const request = runner.understandRequest(turn);
    runner.decide(turn, request ? await this.understand.run(request) : null);
    const talk = await runner.advance(turn);
    await runner.settle(turn, talk ? await this.speak.run(runner.speakRequest(turn, talk)) : null);
    return runner.finish(turn);
  }

  /** `turn`, streaming the spoken text as it is generated; the last chunk carries the result. */
  async *turnStream(input: TurnInput<C, D>): AsyncIterable<TurnStreamChunk<D>> {
    const { runner } = this;
    const turn = runner.begin(input);
    const request = runner.understandRequest(turn);
    runner.decide(turn, request ? await this.understand.run(request) : null);
    const talk = await runner.advance(turn);
    let outcome: SpeakOutcome | null = null;
    if (talk) {
      for await (const chunk of this.speak.stream(runner.speakRequest(turn, talk))) {
        if ("delta" in chunk) yield { delta: chunk.delta };
        else outcome = chunk.outcome;
      }
    }
    await runner.settle(turn, outcome);
    yield { done: true, result: runner.finish(turn) };
  }
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
