/**
 * S7 — A rule typed in chat: the stored JSON is the framework's FlowSpec.
 * `f.fromSpec` types it, the agent validates it, and a mention with an
 * `extract` runs the tag and the notify beside the reply. Once per session.
 */
import { describe, expect, test } from "bun:test";

import { validateFlow } from "../../src/index.js";
import type { FlowSpec } from "../../src/index.js";
import { build, conditions, events, f, message, saved, spoken, understood } from "./fixture.js";

const spec: FlowSpec = {
  id: "concorrente",
  name: "Lead falou de concorrente",
  on: [{ mention: ["o lead cita ou compara com um concorrente"], extract: { trecho: { type: "string" } }, repeat: "once" }],
  steps: [
    { id: "tag", kind: "do", do: "add_tags", with: { tags: ["concorrente"] } },
    { id: "avisa", kind: "do", do: "notify", with: { recipient: "owner", message: '{{data.nome}} falou de concorrente: "{{input.trecho}}"' } },
  ],
};

describe("S7: a mention rule from JSON", () => {
  test("the JSON validates against the registries and runs both actions with the extracted excerpt", async () => {
    const { agent, calls, provider } = build([f.fromSpec(spec)], {
      idle: { prompt: "Responda pela empresa, sem inventar preços." },
      script: {
        understand: [understood({ mentions: { concorrente: true }, extract: { concorrente: { trecho: "a Acme cobra metade" } } })],
        speak: [spoken("Entendo! Posso te mostrar o que está incluso no nosso preço?"), spoken("Claro, vamos comparar.")],
      },
    });
    expect(validateFlow(spec, { fields: f.fields, actions: agent.options.actions, events, conditions }).warnings).toEqual([]);

    const session = { id: "s1", v: 4 as const, version: 0, data: { nome: "Ana" }, runs: [], claims: {}, inputs: [], metadata: {} };
    const t1 = await agent.turn(message("a Acme cobra metade disso", "m1", { session }));
    // Understand (1) judges the mention and extracts; nobody holds the floor, so the idle speaker answers (1).
    expect(t1.llmCalls).toBe(2);
    expect(provider.calls.map((c) => c.schemaName)).toEqual(["understand", "speak"]);
    expect(calls).toEqual([
      { action: "add_tags", key: "concorrente#m1:tag:1", dedupeKey: "concorrente:s1:", params: { tags: ["concorrente"] } },
      { action: "notify", key: "concorrente#m1:avisa:1", dedupeKey: "concorrente:s1:", params: { recipient: "owner", message: 'Ana falou de concorrente: "a Acme cobra metade"' } },
    ]);
    expect(t1.messages.map((m) => [m.text, m.key])).toEqual([["Entendo! Posso te mostrar o que está incluso no nosso preço?", "idle:m1"]]);
    expect(t1.ended.map((r) => [r.id, r.reason, r.input])).toEqual([["concorrente#m1", "end", { trecho: "a Acme cobra metade" }]]);
    // The extract never lands in data.
    expect(t1.session.data).toEqual({ nome: "Ana" });

    // Once per session: the claimed flow is not even a candidate any more, so understand is skipped and only the idle speaker answers.
    const t2 = await agent.turn(message("a Acme de novo...", "m2", { session: saved(t1) }));
    expect(provider.calls.map((c) => c.schemaName)).toEqual(["understand", "speak", "speak"]);
    expect(t2.llmCalls).toBe(1);
    expect(calls).toHaveLength(2);
    expect(t2.started).toEqual([]);
  });

  test("a spec naming an unknown action is refused when the agent is built", () => {
    const broken: FlowSpec = { ...spec, id: "quebrado", steps: [{ id: "x", kind: "do", do: "enviar_email", with: {} }] };
    expect(() => build([f.fromSpec(broken)])).toThrow('unknown action "enviar_email"');
  });
});
