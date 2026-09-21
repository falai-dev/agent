/**
 * Drives the Runner through one turn with the two provider phases fed by
 * hand: `understanding` stands in for the understand call, `speak` for the
 * speak call. Every test here spends zero real calls.
 */

import type { SpeakOutcome, TalkRequest, Understanding } from "../src/core/contracts.js";
import type { IdleSpeaker, Runner } from "../src/core/Runner.js";
import type { Session, TurnInput, TurnResult } from "../src/index.js";

export interface Driven<C, D> {
  result: TurnResult<D>;
  talk: TalkRequest<C, D> | IdleSpeaker<C, D> | null;
  understood: boolean;
}

export async function drive<C, D>(
  runner: Runner<C, D>,
  input: TurnInput<C, D>,
  feed: {
    understanding?: Omit<Understanding, "llmCalls">;
    speak?: (talk: TalkRequest<C, D> | IdleSpeaker<C, D>) => SpeakOutcome | null;
  } = {},
): Promise<Driven<C, D>> {
  const turn = runner.begin(input);
  const request = runner.understandRequest(turn);
  runner.decide(turn, request && feed.understanding ? { ...feed.understanding, llmCalls: 0 } : null);
  const talk = await runner.advance(turn);
  await runner.settle(turn, talk && feed.speak ? feed.speak(talk) : null);
  return { result: runner.finish(turn), talk, understood: request !== null };
}

/** What the host does after a successful CAS save. */
export function saved<D>(result: TurnResult<D>): Session<D> {
  return { ...result.session, version: result.session.version + 1 };
}

/** A hand-made understand result; hand-made means no call was spent. */
export function understood(partial: Partial<Omit<Understanding, "llmCalls">> = {}): Omit<Understanding, "llmCalls"> {
  return { flows: {}, mentions: {}, extract: {}, branches: {}, fields: {}, ...partial };
}

/** A hand-made speak result with the fields the model would have filled. */
export function spoken(message: string, fields: Record<string, unknown> = {}): SpeakOutcome {
  return { spoken: { message, fields, data: {}, toolCalls: [], llmCalls: 0 } };
}

export function isTalk<C, D>(talk: TalkRequest<C, D> | IdleSpeaker<C, D> | null): talk is TalkRequest<C, D> {
  return talk !== null && "run" in talk;
}
