/**
 * S1 — Triagem: per-field asks, fields landing out of order, `maxAsks`
 * skipping a field the lead will not give, confirmation as a collected
 * boolean behind an `if`, the notify action only after the lead's ok.
 * Two calls per text turn, never more.
 */
import { describe, expect, test } from "bun:test";

import type { Session } from "../../src/index.js";
import { build, f, message, saved, spoken, suporte, triagem, understood } from "./fixture.js";
import type { Data } from "./fixture.js";

describe("S1: triagem", () => {
  test("happy path: routing, out-of-order fields, maxAsks, confirmation, notify, goodbye", async () => {
    const { agent, provider, calls } = build([triagem, suporte], {
      script: {
        understand: [
          understood({ flows: { triagem: 92, suporte: 8 } }),
          understood({ fields: { nome: "Ana", empresa: "Zeta", tamanho: "11-50" } }),
          understood({ fields: { urgencia: "agora" } }),
          understood(),
          understood(),
          understood(),
          understood(),
        ],
        speak: [
          spoken("Oi! Com quem eu falo, e de qual empresa?"),
          spoken("Legal, Ana. E para quando vocês precisam resolver isso?"),
          spoken("Só para orientar: qual faixa de investimento vocês têm em mente?"),
          spoken("Sem problema, pode ser uma estimativa."),
          spoken("Então: Ana, da Zeta, 11-50 pessoas, precisa para agora. Está certo?"),
          spoken("Perfeito!", { confirmado: true }),
          spoken("Obrigada, Ana! Um vendedor continua daqui."),
        ],
      },
    });

    const t1 = await agent.turn(message("oi, quero saber como funciona", "m1"));
    expect(t1.llmCalls).toBe(2);
    expect(t1.started.map((s) => s.runId)).toEqual(["triagem#m1"]);
    expect(t1.messages).toEqual([
      { text: "Oi! Com quem eu falo, e de qual empresa?", kind: "ai", afterMs: 0, key: "triagem#m1:quem:1", runId: "triagem#m1", stepId: "quem" },
    ]);
    expect(t1.session.runs[0]).toMatchObject({ stepId: "quem", status: "asking", asked: { nome: 1, empresa: 1 } });

    // Three fields in one message, one of them belonging to the next step: `quem` completes, `porte` asks only what is missing.
    const t2 = await agent.turn(message("Sou a Ana, da Zeta. Somos uns 30.", "m2", { session: saved(t1) }));
    expect(t2.llmCalls).toBe(2);
    expect(t2.session.data).toEqual({ nome: "Ana", empresa: "Zeta", tamanho: "11-50" });
    expect(t2.session.runs[0]).toMatchObject({ stepId: "porte", asked: { nome: 1, empresa: 1, urgencia: 1 } });
    expect(t2.outcomes.map((o) => [o.stepId, o.status])).toEqual([["quem", "ok"], ["porte", "ok"]]);

    const t3 = await agent.turn(message("para agora", "m3", { session: saved(t2) }));
    expect(t3.llmCalls).toBe(2);
    expect(t3.session.runs[0].stepId).toBe("grana");
    expect(t3.session.runs[0].asked.orcamento).toBe(1);

    const t4 = await agent.turn(message("não sei ainda", "m4", { session: saved(t3) }));
    expect(t4.session.runs[0].stepId).toBe("grana");
    expect(t4.session.runs[0].asked.orcamento).toBe(2);

    // Second miss on a `maxAsks: 2` field: the field is skipped, loud in the outcomes, and the run moves on.
    const t5 = await agent.turn(message("prefiro não dizer", "m5", { session: saved(t4) }));
    expect(t5.llmCalls).toBe(2);
    expect(t5.outcomes.map((o) => o.detail)).toContain("campo pulado: perguntado 2 vezes");
    expect(t5.session.runs[0].stepId).toBe("confirma");
    expect(t5.session.runs[0].asked.confirmado).toBe(1);
    expect(t5.session.data).not.toHaveProperty("orcamento");

    // The confirmation is a boolean with extract 'asked': only the speak envelope of this step can set it.
    const t6 = await agent.turn(message("tá certo", "m6", { session: saved(t5) }));
    expect(t6.llmCalls).toBe(2);
    expect(t6.session.data.confirmado).toBe(true);
    expect(calls).toEqual([
      {
        action: "notify",
        key: "triagem#m1:avisa:1",
        dedupeKey: "triagem:s1:",
        params: { recipient: "leadAssignee", message: "Lead qualificado: Ana (Zeta), 11-50 pessoas, agora." },
      },
    ]);
    // `tchau` is a talk step reached after this turn's speak: it waits for the next message.
    expect(t6.session.runs[0]).toMatchObject({ stepId: "tchau", status: "asking" });

    const t7 = await agent.turn(message("obrigada", "m7", { session: saved(t6) }));
    expect(t7.messages.map((m) => m.text)).toEqual(["Obrigada, Ana! Um vendedor continua daqui."]);
    expect(t7.ended.map((r) => [r.id, r.reason])).toEqual([["triagem#m1", "end"]]);
    expect(t7.session.runs).toEqual([]);
    // Once per session by default: the flow is claimed.
    expect(Object.keys(t7.session.claims)).toEqual(["triagem:s1:"]);
    expect(provider.remaining()).toEqual({ understand: 0, speak: 0 });
  });

  test("a correction clears what the lead disputes; the steps whose fields stay known skip", async () => {
    // Known fields are never re-extracted, so a flow that lets the lead fix one clears it in the `else`.
    const corrigivel = f.flow({
      ...triagem,
      id: "triagem2",
      steps: triagem.steps.map((step) =>
        step.id === "ok" ? { id: "ok", if: { equals: { confirmado: true } }, else: { step: "quem", clear: ["confirmado", "empresa"] } } : step,
      ),
    });
    const { agent } = build([corrigivel], {
      script: {
        understand: [understood({ fields: { empresa: "Zeta Labs" } })],
        speak: [spoken("Anotei errado?", { confirmado: false }), spoken("Corrigido: Zeta Labs. Confere agora?")],
      },
    });
    const session: Session<Data> = {
      id: "s1", v: 4, version: 3,
      data: { nome: "Ana", empresa: "Zeta", tamanho: "11-50", urgencia: "agora", orcamento: 5000 },
      runs: [{
        id: "triagem2#m1", flowId: "triagem2", anchor: "s1", dedupeKey: "triagem2:s1:", stepId: "confirma", status: "asking",
        trigger: { kind: "message", key: "m1" }, hop: 0, startedAt: "2026-09-20T09:00:00.000Z",
        asked: { confirmado: 1 }, visits: { quem: 1, porte: 1, grana: 1, confirma: 1 }, outcomes: [],
      }],
      claims: { "triagem2:s1:": { at: "2026-09-20T09:00:00.000Z" } }, inputs: ["m1"], metadata: {},
    };

    // Everything is known and `confirmado` is extract 'asked': no understand call, one speak call.
    const t1 = await agent.turn(message("não, a empresa está errada", "m2", { session }));
    expect(t1.llmCalls).toBe(1);
    expect(t1.session.data).toEqual({ nome: "Ana", tamanho: "11-50", urgencia: "agora", orcamento: 5000 });
    expect(t1.outcomes.map((o) => [o.stepId, o.status, o.detail])).toEqual([
      ["confirma", "ok", undefined],
      ["ok", "ok", undefined],
    ]);
    // `quem` is reached after this turn's speak: it asks for the cleared field on the next message.
    expect(t1.session.runs[0]).toMatchObject({ stepId: "quem", status: "asking" });
    expect(t1.session.runs[0].visits).toEqual({ quem: 2, porte: 1, grana: 1, confirma: 1, ok: 1 });

    // The lead gives the fixed value up front: `quem`, the asking step, completes from the extraction; the known steps skip; `confirma` asks again.
    const t2 = await agent.turn(message("é Zeta Labs", "m3", { session: saved(t1) }));
    expect(t2.llmCalls).toBe(2);
    expect(t2.session.data.empresa).toBe("Zeta Labs");
    expect(t2.outcomes.map((o) => [o.stepId, o.status, o.detail])).toEqual([
      ["quem", "ok", undefined],
      ["porte", "skipped", "pulado: campos já conhecidos"],
      ["grana", "skipped", "pulado: campos já conhecidos"],
      ["confirma", "ok", undefined],
    ]);
    expect(t2.messages[0].text).toBe("Corrigido: Zeta Labs. Confere agora?");
    expect(t2.session.runs[0]).toMatchObject({ stepId: "confirma", status: "asking" });
    expect(t2.session.runs[0].visits.confirma).toBe(2);
  });
});
