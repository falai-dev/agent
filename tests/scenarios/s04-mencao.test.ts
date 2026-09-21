/**
 * S4 — Pediu humano: a `mention` flow reacts beside the conversation. Its
 * `say` answers the lead this turn, so the floor's talk is skipped and the
 * asking run stays asking; the `do` runs in the same turn; the next message
 * resumes triage. One call for the whole turn.
 */
import { OUTCOME_MESSAGES } from "../../src/index.js";
import { describe, expect, test } from "bun:test";

import { build, f, message, saved, spoken, triagem, understood } from "./fixture.js";

const pediuHumano = f.flow({
  id: "pediu_humano",
  name: "Pediu para falar com uma pessoa",
  on: [{ mention: ["pede para falar com uma pessoa, um humano ou um atendente"] }],
  steps: [
    { id: "s", say: "Claro! Já chamo alguém da equipe para continuar com você." },
    { id: "a", do: "assign_lead", with: {} },
  ],
});

describe("S4: mention → say silences the floor → do → triage resumes", () => {
  test("the mention turn spends one call; the say is the only message; triage keeps its floor for the next message", async () => {
    const { agent, calls, provider } = build([triagem, pediuHumano], {
      script: {
        understand: [understood({ fields: { nome: "Ana" } }), understood({ mentions: { pediu_humano: true } }), understood()],
        speak: [spoken("Oi Ana! De qual empresa você fala?"), spoken("Enquanto isso: de qual empresa você fala?")],
      },
    });
    const t1 = await agent.turn(message("oi, sou a Ana", "m1"));
    expect(t1.session.runs.map((r) => [r.flowId, r.status])).toEqual([["triagem", "asking"]]);

    const t2 = await agent.turn(message("quero falar com uma pessoa", "m2", { session: saved(t1) }));
    expect(t2.llmCalls).toBe(1);
    expect(provider.calls.map((c) => c.schemaName)).toEqual(["understand", "speak", "understand"]);
    expect(t2.messages).toEqual([
      { text: "Claro! Já chamo alguém da equipe para continuar com você.", kind: "verbatim", afterMs: 0, key: "pediu_humano#m2:s:1", runId: "pediu_humano#m2", stepId: "s" },
    ]);
    expect(calls).toEqual([{ action: "assign_lead", key: "pediu_humano#m2:a:1", dedupeKey: "pediu_humano:s1:", params: {} }]);
    expect(t2.outcomes.map((o) => [o.runId, o.stepId, o.status, o.code])).toEqual([
      ["pediu_humano#m2", "s", "ok", undefined],
      ["pediu_humano#m2", "a", "ok", undefined],
      ["triagem#m1", "quem", "skipped", "another-reply"],
    ]);
    expect(t2.ended.map((r) => [r.flowId, r.reason])).toEqual([["pediu_humano", "end"]]);
    expect(t2.session.runs.map((r) => [r.flowId, r.status, r.stepId])).toEqual([["triagem", "asking", "quem"]]);

    const t3 = await agent.turn(message("ok, é a Zeta", "m3", { session: saved(t2) }));
    expect(t3.llmCalls).toBe(2);
    expect(t3.messages.map((m) => m.text)).toEqual(["Enquanto isso: de qual empresa você fala?"]);
    // Once per session: a second mention is skipped, not re-run.
    expect(t3.skipped).toEqual([]);
  });

  test("a second mention in the same session is skipped as already run", async () => {
    const { agent, calls } = build([triagem, pediuHumano], {
      script: {
        understand: [understood({ mentions: { pediu_humano: true } }), understood({ mentions: { pediu_humano: true } })],
        speak: [spoken("Oi! Quem fala?")],
      },
    });
    const t1 = await agent.turn(message("quero um humano", "m1"));
    const t2 = await agent.turn(message("um humano, por favor", "m2", { session: saved(t1) }));
    expect(t2.skipped).toEqual([{ flowId: "pediu_humano", anchor: "s1", triggerKey: "m2", code: "already-claimed", message: OUTCOME_MESSAGES["already-claimed"] }]);
    expect(calls).toHaveLength(1);
    expect(t2.messages.map((m) => m.text)).toEqual(["Oi! Quem fala?"]);
  });
});
