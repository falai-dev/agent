/**
 * S6 — Comentário no Instagram: an event lands on the IG session; the flow
 * is anchored to the lead, so the run's anchor and dedupe key carry the
 * host's lead key, and a second session for the same lead (WhatsApp) skips
 * the flow while the host reports it live there.
 */
import { OUTCOME_MESSAGES } from "../../src/index.js";
import { describe, expect, test } from "bun:test";

import { ai, build, f } from "./fixture.js";

const comentario = f.flow({
  id: "comentario",
  name: "Comentou no post",
  on: [{ event: "ig_comment" }],
  anchor: "lead",
  steps: [
    { id: "s", say: "Vi seu comentário! Te chamei aqui para continuar." },
    { id: "n", do: "notify", with: { recipient: "leadAssignee", message: "Comentário: {{input.text}}" } },
  ],
});

describe("S6: an anchored event flow across two sessions of one lead", () => {
  test("the run is anchored to the lead; the same lead on another channel is skipped while it is live elsewhere", async () => {
    const { agent, calls } = build([comentario]);
    const anchors = { lead: { key: "lead:456" } };

    const ig = await agent.turn({ sessionId: "ig1", context: ai, event: "ig_comment", payload: { text: "quanto custa?" }, key: "ig:c1", anchors });
    expect(ig.llmCalls).toBe(0);
    expect(ig.started).toEqual([{ runId: "comentario#ig:c1", flowId: "comentario", anchor: "lead:456", dedupeKey: "comentario:lead:456:ig:c1" }]);
    expect(ig.messages.map((m) => [m.text, m.kind, m.key])).toEqual([["Vi seu comentário! Te chamei aqui para continuar.", "verbatim", "comentario#ig:c1:s:1"]]);
    expect(calls).toEqual([{ action: "notify", key: "comentario#ig:c1:n:1", dedupeKey: "comentario:lead:456:ig:c1", params: { recipient: "leadAssignee", message: "Comentário: quanto custa?" } }]);
    // An `event` flow repeats by default: the claim carries the event key as its nonce.
    expect(Object.keys(ig.session.claims)).toEqual(["comentario:lead:456:ig:c1"]);

    // Say + do: the run finished in one turn, so the host would not list it as active. Suppose it were (a talk step in between):
    const wa = await agent.turn({
      sessionId: "wa1", context: ai, event: "ig_comment", payload: { text: "e o prazo?" }, key: "ig:c2", anchors,
      claims: { held: {}, active: ["comentario:lead:456"] },
    });
    expect(wa.started).toEqual([]);
    expect(wa.skipped).toEqual([{ flowId: "comentario", anchor: "lead:456", triggerKey: "ig:c2", code: "already-running", message: OUTCOME_MESSAGES["already-running"] }]);
    expect(wa.messages).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  test("a once-flow claimed in another session of the lead is skipped here through `claims.held`", async () => {
    const boas = f.flow({
      id: "boas",
      name: "Boas-vindas do lead",
      on: [{ event: "ig_comment", repeat: "once" }],
      anchor: "lead",
      steps: [{ id: "s", say: "Bem-vindo!" }],
    });
    const { agent } = build([boas]);
    const r = await agent.turn({
      sessionId: "wa1", context: ai, event: "ig_comment", payload: { text: "oi" }, key: "ig:c9",
      anchors: { lead: { key: "lead:456" } },
      claims: { held: { "boas:lead:456:": "2026-09-19T10:00:00.000Z" }, active: [] },
    });
    expect(r.skipped).toEqual([{ flowId: "boas", anchor: "lead:456", triggerKey: "ig:c9", code: "already-claimed", message: OUTCOME_MESSAGES["already-claimed"] }]);
    expect(r.messages).toEqual([]);
  });
});
