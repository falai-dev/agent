/**
 * S9 — No flows: the idle speaker answers with the agent's tools in one
 * call; `idle: 'silent'` spends nothing and says nothing. Understand is
 * skipped outright when nothing is AI-conditioned.
 */
import { describe, expect, test } from "bun:test";

import type { Tool } from "../../src/index.js";
import type { Ctx, Data } from "./fixture.js";
import { build, message, saved, spoken } from "./fixture.js";

const faq: Tool<Ctx, Data> = {
  id: "faq",
  description: "Busca uma resposta na base de perguntas frequentes.",
  parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
  handler: (args) => ({ value: `Resposta para "${String(args.q)}": custa R$ 10 por mês.` }),
};

describe("S9: zero flows", () => {
  test("one speak call with tools offered; no understand call; the message is keyed to the input", async () => {
    const { agent, provider } = build([], {
      tools: [faq],
      idle: { prompt: "Responda pela empresa; não invente preços." },
      script: { speak: [spoken("Oi! Posso ajudar com dúvidas sobre o produto.")] },
    });
    const r = await agent.turn(message("oi", "m1"));
    expect(r.llmCalls).toBe(1);
    expect(provider.calls.map((c) => c.schemaName)).toEqual(["speak"]);
    expect(provider.calls[0].input.tools?.map((t) => t.name)).toEqual(["faq"]);
    expect(provider.calls[0].prompt).toContain("Responda pela empresa; não invente preços.");
    expect(r.messages).toEqual([{ text: "Oi! Posso ajudar com dúvidas sobre o produto.", kind: "ai", afterMs: 0, key: "idle:m1" }]);
    expect(r.outcomes).toEqual([expect.objectContaining({ kind: "idle", status: "ok", key: "idle:m1", llmCalls: 1 })]);
    expect(r.session.runs).toEqual([]);
    expect(r.changed).toBe(true);
  });

  test("a tool round: two calls, the tool's answer reaches the second prompt's history", async () => {
    const { agent, provider } = build([], {
      tools: [faq],
      idle: { prompt: "Responda pela empresa." },
      script: { speak: [{ message: "", toolCalls: [{ toolName: "faq", arguments: { q: "preço" } }] }, spoken("Custa R$ 10 por mês.")] },
    });
    const r = await agent.turn(message("quanto custa?", "m1"));
    expect(r.llmCalls).toBe(2);
    expect(JSON.stringify(provider.calls[1].input.history)).toContain("custa R$ 10 por mês");
    expect(r.messages.map((m) => m.text)).toEqual(["Custa R$ 10 por mês."]);
  });

  test("idle: 'silent' spends nothing and says nothing; the input is still recorded", async () => {
    const { agent, provider } = build([], { idle: "silent" });
    const t1 = await agent.turn(message("oi", "m1"));
    expect(t1.llmCalls).toBe(0);
    expect(provider.calls).toEqual([]);
    expect(t1.messages).toEqual([]);
    expect(t1.session.inputs).toEqual(["m1"]);
    expect(t1.session.lastUserAt).toBeDefined();
    // The same channel id again is a no-op.
    const t2 = await agent.turn(message("oi", "m1", { session: saved(t1) }));
    expect(t2.changed).toBe(false);
    expect(t2.outcomes.map((o) => o.code)).toEqual(["duplicate-input"]);
  });
});
