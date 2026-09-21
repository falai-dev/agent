/**
 * S3 — Entrou na etapa: a host event with `after: '1h'` parks a run on its
 * own timer; the wake re-checks `while` with fresh context, then the AI
 * speaks first and suspends the triage that was asking. When the stage
 * changed meanwhile, the run ends with `pulado: premissa mudou` and zero calls.
 */
import { describe, expect, test } from "bun:test";

import type { Ctx, Data } from "./fixture.js";
import { build, f, message, saved, spoken, triagem, understood, T0 } from "./fixture.js";
import type { TurnInput } from "../../src/index.js";

const interesse = f.flow({
  id: "interesse",
  name: "Entrou em negociação",
  on: [{ event: "stage_entered", after: "1h", if: { inStage: "negociacao" } }],
  while: { inStage: "negociacao" },
  steps: [
    { id: "p", prompt: "Diga que viu o interesse avançar e pergunte para quando precisam.", collect: ["urgencia"] },
    { id: "n", do: "notify", with: { recipient: "leadAssignee", message: "{{data.nome}} entrou em negociação: {{data.urgencia}}." } },
  ],
});

const negociando: Ctx = { lead: { id: "l1", tags: [], owner: "ai", stageId: "negociacao" } };
const perdido: Ctx = { lead: { id: "l1", tags: [], owner: "ai", stageId: "perdido" } };
const entered = (extra: Partial<TurnInput<Ctx, Data>>): TurnInput<Ctx, Data> => ({
  sessionId: "s1", context: negociando, event: "stage_entered", payload: { stageId: "negociacao" }, key: "stage:7", ...extra,
});

describe("S3: event + after + while", () => {
  test("the event parks; the wake speaks first (1 call) and suspends triage; the reply finishes it and triage resumes", async () => {
    const { agent, clock, calls, provider } = build([triagem, interesse], {
      script: {
        understand: [understood({ fields: { nome: "Ana" } }), understood({ fields: { urgencia: "agora" } })],
        speak: [spoken("Oi Ana! De qual empresa você fala?"), spoken("Vi que avançamos. Para quando vocês precisam disso?"), spoken("Legal. E a empresa?")],
      },
    });
    const t1 = await agent.turn(message("oi, sou a Ana", "m1"));

    const t2 = await agent.turn(entered({ session: saved(t1) }));
    expect(t2.llmCalls).toBe(0);
    const at = Date.parse(T0) + 3_600_000;
    expect(t2.schedule).toEqual([{ key: `interesse#stage:7:start:${at}`, at: new Date(at) }]);
    expect(t2.outcomes).toEqual([expect.objectContaining({ runId: "interesse#stage:7", kind: "wait", status: "waiting", detail: "aguardando gatilho", until: new Date(at).toISOString() })]);
    expect(t2.session.runs.map((r) => [r.flowId, r.status, r.stepId])).toEqual([["triagem", "asking", "quem"], ["interesse", "waiting", null]]);

    clock.advance("1h");
    const t3 = await agent.turn({ sessionId: "s1", context: negociando, session: saved(t2), wake: t2.schedule[0].key, history: [] });
    expect(t3.llmCalls).toBe(1);
    expect(provider.calls.at(-1)?.prompt).toContain("There is no new message from the customer");
    expect(t3.messages.map((m) => [m.text, m.key])).toEqual([["Vi que avançamos. Para quando vocês precisam disso?", "interesse#stage:7:p:1"]]);
    expect(t3.session.runs.map((r) => [r.flowId, r.status])).toEqual([["triagem", "suspended"], ["interesse", "asking"]]);

    const t4 = await agent.turn(message("para agora", "m2", { session: saved(t3), context: negociando }));
    expect(t4.llmCalls).toBe(2);
    expect(calls).toEqual([{ action: "notify", key: "interesse#stage:7:n:1", dedupeKey: "interesse:s1:stage:7", params: { recipient: "leadAssignee", message: "Ana entrou em negociação: agora." } }]);
    expect(t4.ended.map((r) => [r.flowId, r.reason])).toEqual([["interesse", "end"]]);
    // Nobody asks after interesse ends: triage resumes and its `quem` step speaks in this same turn.
    expect(t4.messages.map((m) => m.text)).toEqual(["Legal. E a empresa?"]);
    expect(t4.session.runs.map((r) => [r.flowId, r.status])).toEqual([["triagem", "asking"]]);
  });

  test("the stage changed before the wake: `while` fails, the run ends, zero calls, nothing said", async () => {
    const { agent, clock } = build([interesse]);
    const t1 = await agent.turn(entered({}));
    clock.advance("1h");
    const t2 = await agent.turn({ sessionId: "s1", context: perdido, session: saved(t1), wake: t1.schedule[0].key });
    expect(t2.llmCalls).toBe(0);
    expect(t2.messages).toEqual([]);
    expect(t2.ended.map((r) => [r.flowId, r.reason])).toEqual([["interesse", "skipped"]]);
    expect(t2.outcomes.map((o) => o.detail)).toEqual(["pulado: premissa mudou"]);
    expect(t2.session.runs).toEqual([]);
  });

  test("the trigger's `if` sees the event's context: a lead entering another stage starts nothing", async () => {
    const { agent } = build([interesse]);
    const t1 = await agent.turn(entered({ context: perdido, payload: { stageId: "perdido" } }));
    expect(t1.started).toEqual([]);
    expect(t1.session.runs).toEqual([]);
    expect(t1.schedule).toEqual([]);
  });
});
