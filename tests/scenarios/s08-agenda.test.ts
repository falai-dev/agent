/**
 * S8 — Agenda: a `repeat: 'always'` flow with `clearOnStart`, a tool the
 * speak step may call (one extra call per tool round), and a last step that
 * hands the floor to another flow with `then: { flow }`, hop 1.
 */
import { describe, expect, test } from "bun:test";

import type { Tool } from "../../src/index.js";
import type { Ctx, Data } from "./fixture.js";
import { build, f, message, saved, spoken, understood } from "./fixture.js";

const checkAvailability: Tool<Ctx, Data> = {
  id: "checkAvailability",
  description: "Horários livres em um dia.",
  parameters: { type: "object", properties: { day: { type: "string" } }, required: ["day"] },
  handler: (args) => ({ value: { day: args.day, slots: ["14:00", "16:00"] } }),
};

const agenda = f.flow({
  id: "agenda",
  name: "Agendar uma conversa",
  on: [{ message: ["quer marcar uma conversa ou reunião"], repeat: "always" }],
  clearOnStart: ["confirmado"],
  tools: ["checkAvailability"],
  steps: [
    { id: "horario", prompt: "Ofereça horários livres (use a ferramenta) e feche um.", collect: ["confirmado"] },
    { id: "ok", if: { equals: { confirmado: true } }, then: { flow: "pos" }, else: "horario" },
  ],
});
const pos = f.flow({ id: "pos", name: "Pós-agendamento", steps: [{ id: "p", prompt: "Confirme o combinado e diga o que acontece a seguir." }] });

describe("S8: repeat always, tools in the speak step, then: { flow }", () => {
  test("a tool round costs one more call; confirmation hands the floor to `pos` with hop 1; the flow runs again with the field cleared", async () => {
    const { agent, provider } = build([agenda, pos], {
      tools: [checkAvailability],
      script: {
        // One routing question in the whole exchange: while `pos` holds the floor, could "ótimo" be a new agenda request?
        understand: [understood({ flows: { pos: 10, agenda: 5 } })],
        speak: [
          { message: "", toolCalls: [{ toolName: "checkAvailability", arguments: { day: "amanhã" } }] },
          spoken("Amanhã tenho 14h ou 16h. Qual prefere?"),
          spoken("Fechado, 16h!", { confirmado: true }),
          spoken("Combinado: amanhã às 16h. Você recebe o convite por e-mail."),
          { message: "", toolCalls: [{ toolName: "checkAvailability", arguments: { day: "sexta" } }] },
          spoken("Sexta tenho 14h ou 16h."),
        ],
      },
    });

    // `confirmado` is a boolean (extract 'asked') and agenda is the only message flow: nothing for understand to do.
    const t1 = await agent.turn(message("quero marcar uma conversa", "m1"));
    expect(provider.calls.map((c) => c.schemaName)).toEqual(["speak", "speak"]);
    expect(t1.llmCalls).toBe(2);
    expect(provider.calls[0].input.tools?.map((t) => t.name)).toEqual(["checkAvailability"]);
    // The second round carries the tool result in the history.
    expect(provider.calls[1].input.history.at(-1)).toMatchObject({ role: "tool", name: "checkAvailability" });
    expect(JSON.stringify(provider.calls[1].input.history)).toContain("16:00");
    expect(t1.messages.map((m) => m.text)).toEqual(["Amanhã tenho 14h ou 16h. Qual prefere?"]);
    expect(t1.outcomes[0]).toMatchObject({ stepId: "horario", status: "ok", llmCalls: 2 });

    const t2 = await agent.turn(message("16h", "m2", { session: saved(t1) }));
    expect(t2.llmCalls).toBe(1);
    expect(t2.session.data.confirmado).toBe(true);
    expect(t2.ended.map((r) => [r.id, r.reason])).toEqual([["agenda#m1", "flow"]]);
    expect(t2.started.map((s) => [s.runId, s.flowId])).toEqual([["pos#agenda#m1:ok:1", "pos"]]);
    expect(t2.session.runs.map((r) => [r.flowId, r.status, r.hop, r.stepId])).toEqual([["pos", "asking", 1, "p"]]);

    const t3 = await agent.turn(message("ótimo", "m3", { session: saved(t2) }));
    expect(t3.llmCalls).toBe(2);
    expect(t3.messages.map((m) => m.text)).toEqual(["Combinado: amanhã às 16h. Você recebe o convite por e-mail."]);
    expect(t3.ended.map((r) => [r.flowId, r.reason])).toEqual([["pos", "end"]]);
    expect(t3.session.runs).toEqual([]);

    // `repeat: 'always'`: a new run under the new message key; `clearOnStart` forgets the old confirmation.
    const t4 = await agent.turn(message("quero marcar outra", "m4", { session: saved(t3) }));
    expect(t4.started.map((s) => s.runId)).toEqual(["agenda#m4"]);
    expect(t4.session.data).not.toHaveProperty("confirmado");
    expect(t4.messages.map((m) => m.text)).toEqual(["Sexta tenho 14h ou 16h."]);
    expect(t4.llmCalls).toBe(2);
    expect(Object.keys(t4.session.claims).sort()).toEqual(["agenda:s1:m1", "agenda:s1:m4", "pos:s1:agenda#m1:ok:1"]);
    expect(provider.remaining()).toEqual({ understand: 0, speak: 0 });
  });
});
