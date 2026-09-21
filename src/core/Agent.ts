/**
 * Agent: immutable configuration plus one entry point, `turn`.
 *
 * One instance serves every session; context and history arrive per turn.
 * The runtime behind `turn` lands in slice 8 of `docs/rfc/v4-one-flow.md`;
 * until then both entry points reject with `NotImplementedError`.
 */

import type { AgentOptions, TurnInput, TurnResult, TurnStreamChunk } from "../types/agent.js";
import { NotImplementedError } from "../types/errors.js";

const NOT_YET =
  "[NotImplementedError] agent.turn is not available yet: the v4 runtime lands in slice 8 " +
  "(docs/rfc/v4-one-flow.md). Pin @falai/agent@3 until 4.0.0 ships.";

export class Agent<C = unknown, D = unknown> {
  constructor(readonly options: AgentOptions<C, D>) {}

  /** Take whatever just happened and return the messages to send and the timers to set. */
  turn(_input: TurnInput<C, D>): Promise<TurnResult<D>> {
    return Promise.reject(new NotImplementedError(NOT_YET));
  }

  /** `turn`, streaming the spoken text as it is generated. */
  turnStream(_input: TurnInput<C, D>): AsyncIterable<TurnStreamChunk<D>> {
    return {
      [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new NotImplementedError(NOT_YET)) }),
    };
  }
}
