/**
 * S10 — The wake and the lead's text race on one session. With a real
 * Store the loser's save conflicts; the host replays it on the new version
 * and the wait's `else` ends the nudge run instead of nudging again.
 * tests/wakes.test.ts walks the same race through the Runner alone.
 */
import { describe, expect, test } from "bun:test";

import { MemoryStore, SessionConflictError } from "../../src/index.js";
import type { Session, TurnInput, TurnResult } from "../../src/index.js";
import type { Ctx, Data } from "./fixture.js";
import { ai, build, message, retomar, spoken, triagem, understood, T0 } from "./fixture.js";

describe("S10: wake vs text, with versions", () => {
  test("the wake saves v1→v2; the text loaded at v1 conflicts, replays on v2 and ends the nudge run", async () => {
    const { agent, clock } = build([triagem, retomar], {
      script: {
        understand: [understood({ flows: { triagem: 90 }, fields: { nome: "Ana" } }), understood(), understood()],
        // Four speak replies: the lost turn spends one too, exactly as a real host would.
        speak: [spoken("Oi Ana! De qual empresa?"), spoken("Oi Ana, ainda faz sentido?"), spoken("Ótimo! E a empresa?"), spoken("Ótimo! E a empresa?")],
      },
    });
    const store = new MemoryStore<Data>();
    const commit = async (r: TurnResult<Data>, expected: number): Promise<Session<Data>> => store.save(r.session, expected);

    const t0 = await agent.turn(message("oi, sou a Ana", "m1"));
    const v1 = await commit(t0, 0);
    expect(v1.version).toBe(1);

    clock.advance("24h");
    // Both loads see v1.
    const seenByWake = await store.load("s1");
    const seenByText = await store.load("s1");
    const wakeInput: TurnInput<Ctx, Data> = { sessionId: "s1", context: ai, session: seenByWake ?? undefined, wake: t0.schedule[0].key, history: [] };
    const textInput: TurnInput<Ctx, Data> = message("faz sim", "m2", { session: seenByText ?? undefined });

    const wake = await agent.turn(wakeInput);
    expect(wake.messages.map((m) => m.text)).toEqual(["Oi Ana, ainda faz sentido?"]);
    await commit(wake, 1);

    const lost = await agent.turn(textInput);
    // Computed on v1: retomar is not in this session copy, so the text only fed triage. Its message never leaves: the save fails.
    expect(lost.ended).toEqual([]);
    expect(lost.messages.map((m) => m.text)).toEqual(["Ótimo! E a empresa?"]);
    await expect(commit(lost, 1)).rejects.toBeInstanceOf(SessionConflictError);

    // Replay on v2: the same input now finds retomar waiting, and the wait's `else` ends it.
    const v2 = await store.load("s1");
    const replay = await agent.turn(message("faz sim", "m2", { session: v2 ?? undefined }));
    expect(replay.ended.map((r) => [r.flowId, r.reason])).toEqual([["retomar", "end"]]);
    expect(replay.outcomes.find((o) => o.kind === "wait")).toMatchObject({ status: "ok", code: "replied" });
    expect(replay.messages.map((m) => m.text)).toEqual(["Ótimo! E a empresa?"]);
    const v3 = await commit(replay, 2);
    expect(v3.version).toBe(3);

    // The nudge's second wake (w1) is now stale: honoured by nobody, nothing saved.
    clock.advance("2d");
    const stale = await agent.turn({ sessionId: "s1", context: ai, session: v3, wake: wake.schedule[0].key });
    expect(stale.changed).toBe(false);
    expect(stale.outcomes.map((o) => o.code)).toEqual(["stale-wake"]);
  });
});
