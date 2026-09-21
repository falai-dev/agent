/**
 * What happens when the provider says no.
 *
 * Two halves. Speak decides WHAT kind of wall it hit — a wrong key reads
 * differently from a busy server. Runner decides whether waiting at that wall
 * can help, and for how long. Before this, every failure was one word and
 * Runner re-parked the step every fifteen minutes for as long as the session
 * existed: two model calls a wake, forever, and the customer never answered.
 */

import { describe, expect, test } from "bun:test";
import { ProviderError } from "@providerkit/core";

import { Runner } from "../src/core/Runner.js";
import { Speak } from "../src/core/Speak.js";
import type { Deferral } from "../src/core/contracts.js";
import { falai } from "../src/index.js";
import type { AgentStructuredResponse, AiProvider, GenerateMessageStreamChunk } from "../src/types/ai.js";
import { fakeClock } from "../src/utils/clock.js";
import { parseDuration } from "../src/utils/duration.js";
import { mockProvider } from "./mock-provider.js";
import { drive, isTalk, saved } from "./runner-harness.js";
import { agentOptions, talkRequest } from "./speak-fixtures.js";

// ── Speak: which wall was it? ─────────────────────────────────────────────

/** A provider that fails every call with the given error. */
function failing(error: unknown): AiProvider {
  return {
    name: "failing",
    capabilities: {
      supportsTools: true,
      supportsNativeJsonSchema: true,
      supportsStreaming: true,
      supportsStreamingToolCalls: true,
      supportsPromptCaching: false,
    },
    generateMessage: () => Promise.reject(error),
    // Throws before the first yield, which is what a provider that fails on
    // connect looks like from the consumer's side.
    // eslint-disable-next-line require-yield
    generateMessageStream: async function* <
      TContext = unknown,
      TStructured = AgentStructuredResponse,
    >(): AsyncGenerator<GenerateMessageStreamChunk<TStructured>> {
      throw error;
    },
  };
}

async function deferralFor(error: unknown): Promise<Deferral> {
  const out = await new Speak(agentOptions(failing(error))).run(talkRequest());
  if (!("deferred" in out)) throw new Error("expected a deferral");
  return out.deferred;
}

describe("Speak names the failure", () => {
  test("a wrong key is not a temporary outage", async () => {
    expect(await deferralFor(new ProviderError("zai", "auth", "401 invalid api key"))).toEqual({
      code: "provider-auth",
      retryable: false,
    });
  });

  test("a prompt past the context window ends the step", async () => {
    // Retrying sends the same oversized history, so a wake is a guaranteed
    // second failure. The host has to shorten the conversation.
    expect(await deferralFor(new ProviderError("zai", "context", "prompt is too long"))).toEqual({
      code: "provider-context",
      retryable: false,
    });
  });

  test("a spent balance with no stated reset is not worth waiting for", async () => {
    expect(await deferralFor(new ProviderError("deepseek", "quota", "insufficient balance"))).toEqual({
      code: "provider-quota",
      retryable: false,
    });
  });

  test("a usage window that says when it reopens is worth exactly one wake", async () => {
    const resetAtMs = Date.parse("2026-09-20T15:00:00.000Z");
    expect(await deferralFor(new ProviderError("zai", "quota", "5h plan window", { resetAtMs }))).toEqual({
      code: "provider-quota",
      retryable: true,
      resetAtMs,
    });
  });

  test("a bare 402 is classified as a wall, not as a mystery outage", async () => {
    // The kinds a wake can fix are 408, a transient 429, 5xx and no answer at
    // all — nothing else. A payment wall reaches here as a plain rejection with
    // a status and no kind, and `unknown` (the one retryable fallback) is
    // reserved for an error carrying no status at all.
    expect(await deferralFor(Object.assign(new Error("payment required"), { status: 402 }))).toEqual({
      code: "provider-quota",
      retryable: false,
    });
  });

  test("a busy server is the case the ladder was built for", async () => {
    expect(await deferralFor(new ProviderError("gemini", "overload", "503 overloaded"))).toEqual({
      code: "provider-unavailable",
      retryable: true,
    });
  });

  test("an error that is not a ProviderError still gets one more try", async () => {
    expect(await deferralFor(new Error("socket hang up"))).toEqual({
      code: "provider-unavailable",
      retryable: true,
    });
  });
});

// ── Runner: is waiting going to help, and for how long? ───────────────────

interface Ctx {
  tenant: string;
}

const f = falai<Ctx>().fields({ nome: { type: "string", ask: "Pergunte o nome." } });
type Data = { nome: string };

const flow = f.flow({
  id: "triagem",
  name: "Triagem",
  on: [{ message: [] }],
  steps: [{ id: "quem", collect: ["nome"] }],
});

const START = "2026-09-20T10:00:00.000Z";

function runnerAt(iso: string) {
  return new Runner<Ctx, Data>({
    name: "Ana",
    provider: mockProvider(),
    fields: { nome: { type: "string", ask: "Pergunte o nome." } },
    flows: [flow],
    clock: fakeClock(iso),
  });
}

const CTX: Ctx = { tenant: "acme" };

/** The first turn of a conversation, whose speak call failed with `deferred`. */
async function failTurn(iso: string, deferred: Deferral) {
  return drive<Ctx, Data>(
    runnerAt(iso),
    { sessionId: "s1", context: CTX, message: "oi", id: "m1" },
    { speak: () => ({ deferred, llmCalls: 1 }) },
  );
}

describe("Runner decides whether to wait", () => {
  test("a temporary failure climbs the ladder and then stops", async () => {
    const retryable: Deferral = { code: "provider-unavailable", retryable: true };
    const rungs = ["1m", "5m", "15m", "1h", "6h"] as const;

    let at = Date.parse(START);
    let { result } = await failTurn(new Date(at).toISOString(), retryable);
    const parked: string[] = [];

    for (const rung of rungs) {
      expect(result.outcomes.at(-1)).toMatchObject({ status: "deferred", code: "provider-unavailable" });
      expect(result.schedule).toHaveLength(1);
      const due = result.schedule[0].at.getTime();
      expect(due - at).toBe(parseDuration(rung));
      parked.push(result.schedule[0].key);

      // The host wakes at the parked time and the step fails again.
      at = due;
      const session = saved(result);
      const runner = runnerAt(new Date(at).toISOString());
      ({ result } = await drive<Ctx, Data>(
        runner,
        { sessionId: "s1", context: CTX, session, wake: parked.at(-1) as string },
        { speak: () => ({ deferred: retryable, llmCalls: 1 }) },
      ));
    }

    // Six failures in: the ladder is spent, so the run ends instead of parking
    // a seventh wake. This is the whole point — it used to saturate at 15m and
    // never stop.
    expect(result.schedule).toEqual([]);
    expect(result.outcomes.at(-1)).toMatchObject({ status: "failed", code: "provider-unavailable" });
    expect(result.ended.at(-1)).toMatchObject({ flowId: "triagem", reason: "failed" });
    expect(result.session.runs).toEqual([]);
    expect(new Set(parked).size).toBe(rungs.length);
  });

  test("a wrong key parks nothing at all", async () => {
    const { result } = await failTurn(START, { code: "provider-auth", retryable: false });
    expect(result.schedule).toEqual([]);
    expect(result.outcomes.at(-1)).toMatchObject({
      status: "failed",
      code: "provider-auth",
      message: "the provider rejected the credentials",
    });
    expect(result.ended.at(-1)).toMatchObject({ reason: "failed" });
    expect(result.session.runs).toEqual([]);
  });

  test("a stated reset beats the first rung of the ladder", async () => {
    const resetAtMs = Date.parse("2026-09-20T15:00:00.000Z"); // five hours out
    const { result } = await failTurn(START, { code: "provider-quota", retryable: true, resetAtMs });
    expect(result.schedule).toHaveLength(1);
    expect(result.schedule[0].at.getTime()).toBe(resetAtMs);
    expect(result.outcomes.at(-1)).toMatchObject({ status: "deferred", code: "provider-quota" });
  });

  test("a reset already in the past does not move the wake backwards", async () => {
    const resetAtMs = Date.parse("2026-09-20T09:00:00.000Z"); // an hour ago
    const { result } = await failTurn(START, { code: "provider-quota", retryable: true, resetAtMs });
    expect(result.schedule[0].at.getTime()).toBe(Date.parse(START) + parseDuration("1m"));
  });

  test("the step is still there to speak when the retry wake fires", async () => {
    const { result } = await failTurn(START, { code: "provider-unavailable", retryable: true });
    const runner = runnerAt(new Date(Date.parse(START) + parseDuration("1m")).toISOString());
    const { talk } = await drive<Ctx, Data>(
      runner,
      { sessionId: "s1", context: CTX, session: saved(result), wake: result.schedule[0].key },
      {},
    );
    expect(isTalk(talk) && talk.step.id).toBe("quem");
    expect(isTalk(talk) && talk.pending).toEqual(["nome"]);
  });
});
