/**
 * S5 — Campanha: started by the host, `do send_template` speaks for the
 * run, a day of silence wakes a nudge (1 call), the reply chains into the
 * funnel with `{{input.flowId}}`, hop 1, which then holds the floor.
 */
import { describe, expect, test } from "bun:test";

import type { Ctx, Data } from "./fixture.js";
import { ai, build, f, message, saved, spoken, understood, T0 } from "./fixture.js";
import type { TurnInput } from "../../src/index.js";

const campanha = f.flow({
  id: "campanha",
  name: "Campanha",
  steps: [
    { id: "envio", do: "send_template", with: { templateId: "{{input.templateId}}" } },
    { id: "espera", wait: "1d", else: { flow: "{{input.flowId}}" } },
    { id: "nudge", prompt: "Cutuque de leve: pergunte se a pessoa viu a mensagem." },
    { id: "espera2", wait: "2d", else: { flow: "{{input.flowId}}" } },
  ],
});
const funil = f.flow({ id: "funil", name: "Funil", steps: [{ id: "q", collect: ["nome"] }] });

describe("S5: campaign start → template → nudge → reply chains into the funnel", () => {
  test("start (0 calls) → wake nudge (1 call) → reply ends the wait with `else: { flow }` (2 calls)", async () => {
    const { agent, clock, calls, provider } = build([campanha, funil], {
      reply: (name) => (name === "send_template" ? { ok: true, spoke: true, detail: "template enviado" } : { ok: true }),
      script: { understand: [understood({ fields: {} })], speak: [spoken("Oi! Viu minha mensagem de ontem?"), spoken("Que bom! Como você se chama?")] },
    });
    const start: TurnInput<Ctx, Data> = {
      sessionId: "s1", context: ai, start: { flow: "campanha", input: { templateId: "t1", flowId: "funil" }, key: "camp:1" },
    };
    const t1 = await agent.turn(start);
    expect(t1.llmCalls).toBe(0);
    // A manual start repeats by default, so the dedupe key carries the host's start key.
    expect(calls).toEqual([{ action: "send_template", key: "campanha#camp:1:envio:1", dedupeKey: "campanha:s1:camp:1", params: { templateId: "t1" } }]);
    const w1 = Date.parse(T0) + 86_400_000;
    expect(t1.schedule).toEqual([{ key: `campanha#camp:1:espera:${w1}`, at: new Date(w1) }]);
    expect(t1.outcomes.map((o) => [o.stepId, o.status, o.detail, o.until])).toEqual([
      ["envio", "ok", "template enviado", undefined],
      ["espera", "waiting", undefined, new Date(w1).toISOString()],
    ]);
    // The action spoke for the assistant: lastAssistantAt is stamped.
    expect(t1.session.lastAssistantAt).toBe(T0);

    clock.advance("1d");
    const t2 = await agent.turn({ sessionId: "s1", context: ai, session: saved(t1), wake: t1.schedule[0].key, history: [] });
    expect(t2.llmCalls).toBe(1);
    expect(t2.messages.map((m) => [m.text, m.key])).toEqual([["Oi! Viu minha mensagem de ontem?", "campanha#camp:1:nudge:1"]]);
    expect(t2.outcomes.map((o) => [o.stepId, o.status, o.detail])).toEqual([["espera", "ok", "sem resposta"], ["nudge", "ok", undefined], ["espera2", "waiting", undefined]]);
    expect(t2.session.runs[0]).toMatchObject({ stepId: "espera2", status: "waiting" });

    clock.advance("2h");
    const t3 = await agent.turn(message("vi sim, me conta mais", "m1", { session: saved(t2) }));
    expect(t3.ended.map((r) => [r.id, r.reason])).toEqual([["campanha#camp:1", "flow"]]);
    // A chained run repeats by default: its key is the parent's step key, and so is its dedupe nonce.
    expect(t3.started).toEqual([{ runId: "funil#campanha#camp:1:espera2:1", flowId: "funil", anchor: "s1", dedupeKey: "funil:s1:campanha#camp:1:espera2:1" }]);
    expect(t3.session.runs.map((r) => [r.flowId, r.status, r.hop, r.input])).toEqual([["funil", "asking", 1, { templateId: "t1", flowId: "funil" }]]);
    expect(t3.messages.map((m) => m.text)).toEqual(["Que bom! Como você se chama?"]);
    expect(t3.llmCalls).toBe(2);
    expect(provider.remaining()).toEqual({ understand: 0, speak: 0 });
  });

  test("`defer` re-parks the action under a fresh wake and the wake re-runs the same key", async () => {
    const { agent, clock, calls } = build([campanha, funil], {
      reply: (name, n) => (name === "send_template" && n === 1 ? { defer: "24h", detail: "sem créditos" } : { ok: true, spoke: true }),
    });
    const t1 = await agent.turn({ sessionId: "s1", context: ai, start: { flow: "campanha", input: { templateId: "t1", flowId: "funil" }, key: "camp:1" } });
    const retry = Date.parse(T0) + 86_400_000;
    expect(t1.outcomes[0]).toMatchObject({ stepId: "envio", status: "deferred", detail: "sem créditos", until: new Date(retry).toISOString() });
    expect(t1.schedule.map((s) => s.key)).toEqual([`campanha#camp:1:envio:${retry}`]);

    clock.advance("24h");
    const t2 = await agent.turn({ sessionId: "s1", context: ai, session: saved(t1), wake: t1.schedule[0].key });
    // Same key both times: the host's idempotency guard sees one send.
    expect(calls.map((c) => c.key)).toEqual(["campanha#camp:1:envio:1", "campanha#camp:1:envio:1"]);
    expect(t2.session.runs[0]).toMatchObject({ stepId: "espera", status: "waiting" });
  });
});
