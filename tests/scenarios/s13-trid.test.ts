/**
 * S13 — TRID's script as steps: say, wait 3s, say, prompt, in one turn.
 * The short wait rides as `afterMs` on the next message; the prompt speaks
 * once; one understand call (the model may already be naming a model) and
 * one speak call.
 */
import { describe, expect, test } from "bun:test";

import { build, f, message, saved, spoken, understood } from "./fixture.js";

const trid = f.flow({
  id: "trid",
  name: "TRID",
  on: [{ message: ["quer um iPhone"] }],
  steps: [
    { id: "a", say: "Oi! Aqui é da TRID." },
    { id: "p", wait: "3s" },
    { id: "b", say: "Chegou o iPhone 17, pronta entrega." },
    { id: "q", prompt: "Pergunte qual modelo interessa.", collect: ["modelo"] },
  ],
});

describe("S13: say / wait 3s / say / prompt in one turn", () => {
  test("messages [A, B afterMs 3000, C]; two calls; the run asks for the model", async () => {
    const { agent, provider } = build([trid], {
      script: { understand: [understood()], speak: [spoken("Qual modelo você quer: 17, 17 Pro ou 17 Pro Max?")] },
    });
    const r = await agent.turn(message("quero um iphone", "m1"));
    expect(r.llmCalls).toBe(2);
    expect(provider.calls.map((c) => c.schemaName)).toEqual(["understand", "speak"]);
    expect(r.messages).toEqual([
      { text: "Oi! Aqui é da TRID.", kind: "verbatim", afterMs: 0, key: "trid#m1:a:1", runId: "trid#m1", stepId: "a" },
      { text: "Chegou o iPhone 17, pronta entrega.", kind: "verbatim", afterMs: 3000, key: "trid#m1:b:1", runId: "trid#m1", stepId: "b" },
      { text: "Qual modelo você quer: 17, 17 Pro ou 17 Pro Max?", kind: "ai", afterMs: 0, key: "trid#m1:q:1", runId: "trid#m1", stepId: "q" },
    ]);
    expect(r.outcomes.map((o) => [o.stepId, o.kind, o.status, o.detail])).toEqual([
      ["a", "say", "ok", undefined],
      ["p", "wait", "ok", "3000ms"],
      ["b", "say", "ok", undefined],
      ["q", "collect", "ok", undefined],
    ]);
    expect(r.session.runs[0]).toMatchObject({ stepId: "q", status: "asking" });
    expect(r.schedule).toEqual([]);
  });

  test("the model named in the first message skips the question; the run ends in one turn with zero speak calls", async () => {
    const { agent, provider } = build([trid], { script: { understand: [understood({ fields: { modelo: "17 Pro" } })] } });
    const r = await agent.turn(message("quero um iphone 17 pro", "m1"));
    expect(r.llmCalls).toBe(1);
    expect(provider.calls.map((c) => c.schemaName)).toEqual(["understand"]);
    expect(r.messages.map((m) => m.text)).toEqual(["Oi! Aqui é da TRID.", "Chegou o iPhone 17, pronta entrega."]);
    expect(r.outcomes.at(-1)).toMatchObject({ stepId: "q", status: "skipped", code: "already-known" });
    expect(r.ended.map((e) => [e.id, e.reason])).toEqual([["trid#m1", "end"]]);
    expect(r.session.data).toEqual({ modelo: "17 Pro" });
  });

  test("a replay of the same input from the same session version mints the same keys", async () => {
    const script = () => ({ understand: [understood()], speak: [spoken("Qual modelo?")] });
    const a = await build([trid], { script: script() }).agent.turn(message("quero um iphone", "m1"));
    const b = await build([trid], { script: script() }).agent.turn(message("quero um iphone", "m1"));
    expect(b.messages).toEqual(a.messages);
    expect(b.session).toEqual(a.session);
    // And a second message re-entering the same step would mint a new visit, not the same key.
    const { agent } = build([trid], { script: { understand: [understood(), understood()], speak: [spoken("Qual modelo?"), spoken("Ainda não entendi: qual modelo?")] } });
    const t1 = await agent.turn(message("quero um iphone", "m1"));
    const t2 = await agent.turn(message("hm", "m2", { session: saved(t1) }));
    expect(t2.messages.map((m) => m.key)).toEqual(["trid#m1:q:1"]);
    expect(t2.session.runs[0].asked).toEqual({ modelo: 2 });
  });
});
