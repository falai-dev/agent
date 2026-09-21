/**
 * S2 — Retomar quem sumiu: the framework arms a silence wake after it
 * speaks; the wake starts the flow, which speaks first (one call); any reply
 * ends the wait; while a human owns the lead the seller gets a reminder and
 * nothing is said.
 */
import { describe, expect, test } from "bun:test";

import { ai, build, human, message, retomar, saved, spoken, triagem, understood, T0 } from "./fixture.js";

describe("S2: retomar quem sumiu", () => {
  test("silence wake → nudge (1 call) → the lead replies → the wait's else ends the run", async () => {
    const { agent, clock, provider } = build([triagem, retomar], {
      script: {
        understand: [understood({ fields: { nome: "Ana" } }), understood()],
        speak: [spoken("Oi Ana! De qual empresa você fala?"), spoken("Oi Ana, ainda faz sentido conversarmos sobre a Zeta?"), spoken("Ótimo! E de qual empresa?")],
      },
    });

    const t1 = await agent.turn(message("oi, sou a Ana", "m1"));
    const silenceKey = `silence:retomar:s1:${Date.parse(T0)}`;
    expect(t1.schedule).toEqual([{ key: silenceKey, at: new Date(Date.parse(T0) + 24 * 3_600_000) }]);
    expect(t1.session.lastAssistantAt).toBe(T0);

    clock.advance("24h");
    const t2 = await agent.turn({ sessionId: "s1", context: ai, session: saved(t1), wake: silenceKey, history: [] });
    expect(t2.llmCalls).toBe(1);
    expect(provider.calls.at(-1)?.schemaName).toBe("speak");
    expect(provider.calls.at(-1)?.prompt).toContain("There is no new message from the customer");
    expect(t2.started.map((s) => s.flowId)).toEqual(["retomar"]);
    expect(t2.messages).toEqual([
      { text: "Oi Ana, ainda faz sentido conversarmos sobre a Zeta?", kind: "ai", afterMs: 0, key: `retomar#${Date.parse(T0)}:p1:1`, runId: `retomar#${Date.parse(T0)}`, stepId: "p1" },
    ]);
    const retomarRun = t2.session.runs.find((r) => r.flowId === "retomar");
    expect(retomarRun).toMatchObject({ stepId: "w1", status: "waiting", waiting: { kind: "timer", until: new Date(clock.now().getTime() + 2 * 86_400_000).toISOString() } });
    // Triagem is still asking: the nudge did not take its floor for good.
    expect(t2.session.runs.find((r) => r.flowId === "triagem")?.status).toBe("asking");
    // Only the wait's wake: retomar is `once` per session and has just claimed itself, so no second silence wake is armed.
    expect(t2.schedule.map((s) => s.key)).toEqual([`retomar#${Date.parse(T0)}:w1:${clock.now().getTime() + 2 * 86_400_000}`]);

    clock.advance("3h");
    const t3 = await agent.turn(message("faz sim!", "m2", { session: saved(t2) }));
    expect(t3.ended.map((r) => [r.flowId, r.reason])).toEqual([["retomar", "end"]]);
    expect(t3.outcomes.find((o) => o.kind === "wait")).toMatchObject({ status: "ok", detail: "respondeu", next: "end" });
    expect(t3.messages.map((m) => m.text)).toEqual(["Ótimo! E de qual empresa?"]);
    expect(t3.llmCalls).toBe(2);
    expect(t3.schedule).toEqual([]);
    expect(provider.remaining()).toEqual({ understand: 0, speak: 0 });
  });

  test("silenced wake (a human owns the lead): the gate routes to the reminder, zero calls, nothing said", async () => {
    const { agent, clock, calls } = build([triagem, retomar], {
      script: { understand: [understood({ fields: { nome: "Ana" } })], speak: [spoken("Oi Ana! De qual empresa?")] },
    });
    const t1 = await agent.turn(message("oi, sou a Ana", "m1"));
    clock.advance("24h");
    const t2 = await agent.turn({ sessionId: "s1", context: human, session: saved(t1), wake: t1.schedule[0].key, silenced: "humano no comando" });
    expect(t2.llmCalls).toBe(0);
    expect(t2.messages).toEqual([]);
    // The trigger's own `if` (owner === 'ai') is judged with the wake's context: a human owns the lead, so retomar does not start.
    expect(t2.started).toEqual([]);
    expect(t2.skipped).toEqual([]);
    expect(calls).toEqual([]);
    expect(t2.changed).toBe(false);
  });

  test("silenced wake with the owner still 'ai' (a pause): the gate step takes `then`, the seller is notified", async () => {
    const { agent, clock, calls } = build([triagem, retomar], {
      script: { understand: [understood({ fields: { nome: "Ana" } })], speak: [spoken("Oi Ana! De qual empresa?")] },
    });
    const t1 = await agent.turn(message("oi, sou a Ana", "m1"));
    clock.advance("24h");
    const t2 = await agent.turn({ sessionId: "s1", context: { lead: { id: "l1", tags: [], owner: "ai" } }, session: saved(t1), wake: t1.schedule[0].key, silenced: "pausa" });
    expect(t2.llmCalls).toBe(0);
    expect(t2.messages).toEqual([]);
    expect(calls).toEqual([
      { action: "notify", key: `retomar#${Date.parse(T0)}:lembra:1`, dedupeKey: "retomar:s1:", params: { recipient: "leadAssignee", message: "Hora de fazer follow-up com Ana." } },
    ]);
    expect(t2.ended.map((r) => [r.flowId, r.reason])).toEqual([["retomar", "end"]]);
  });
});
