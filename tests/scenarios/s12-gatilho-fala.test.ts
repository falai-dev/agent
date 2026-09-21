/**
 * S12 — A prompt reached by a wake speaks through the same agent as a text
 * turn: same identity, instructions, tools and session. The host gate
 * arrives as `silenced`: the talk step ends `silenciado: <reason>` with zero
 * calls, while `do` steps still run.
 */
import { describe, expect, test } from "bun:test";

import type { Tool } from "../../src/index.js";
import type { Ctx, Data } from "./fixture.js";
import { ai, build, f, saved, spoken, T0 } from "./fixture.js";

const agendaLink: Tool<Ctx, Data> = {
  id: "agendaLink",
  description: "Link da reunião.",
  parameters: { type: "object", properties: {}, required: [] },
  handler: () => ({ value: "https://meet.example/abc" }),
};

const lembrete = f.flow({
  id: "lembrete",
  name: "Lembrete de reunião",
  on: [{ event: "meeting_booked", after: "10m" }],
  instructions: [{ kind: "must", prompt: "Cite a data e a hora exatas da reunião." }],
  steps: [
    { id: "n", do: "notify", with: { recipient: "leadAssignee", message: "Reunião {{input.eventId}} confirmada." } },
    { id: "p", prompt: "Confirme a reunião marcada e mande o link." },
  ],
});

describe("S12: a wake-reached prompt through the one agent", () => {
  test("the wake speaks first with the agent's instructions and tools (1 call)", async () => {
    const { agent, clock, provider, calls } = build([lembrete], {
      tools: [agendaLink],
      instructions: [{ kind: "never", prompt: "Nunca prometa desconto." }, { kind: "should", prompt: "Só para VIPs: ofereça o gerente.", if: { tagsAny: ["vip"] } }, { kind: "should", prompt: "Nunca aparece.", if: { tagsAny: ["nada"] } }],
      script: { speak: [spoken("Sua reunião está confirmada para amanhã às 10h: https://meet.example/abc")] },
    });
    const t1 = await agent.turn({ sessionId: "s1", context: ai, event: "meeting_booked", payload: { eventId: "ev-9" }, key: "meet:9" });
    expect(t1.llmCalls).toBe(0);
    expect(t1.schedule.map((s) => s.key)).toEqual([`lembrete#meet:9:start:${Date.parse(T0) + 600_000}`]);

    clock.advance("10m");
    const t2 = await agent.turn({ sessionId: "s1", context: ai, session: saved(t1), wake: t1.schedule[0].key, history: [] });
    expect(t2.llmCalls).toBe(1);
    expect(calls).toEqual([{ action: "notify", key: "lembrete#meet:9:n:1", dedupeKey: "lembrete:s1:meet:9", params: { recipient: "leadAssignee", message: "Reunião ev-9 confirmada." } }]);
    const { prompt, seen, input } = provider.calls[0];
    // Identity is untemplated here, so it rides in the cacheable system half.
    expect(seen).toContain("Ana");
    expect(prompt).toContain("There is no new message from the customer");
    expect(prompt).toContain("Nunca prometa desconto.");
    expect(prompt).toContain("Cite a data e a hora exatas da reunião.");
    expect(prompt).toContain("Só para VIPs: ofereça o gerente.");
    expect(seen).not.toContain("Nunca aparece.");
    expect(input.tools?.map((t) => t.name)).toEqual(["agendaLink"]);
    expect(t2.messages.map((m) => [m.text, m.kind, m.key])).toEqual([["Sua reunião está confirmada para amanhã às 10h: https://meet.example/abc", "ai", "lembrete#meet:9:p:1"]]);
    expect(t2.ended.map((r) => [r.flowId, r.reason])).toEqual([["lembrete", "end"]]);
  });

  test("silenced at the wake: the do step runs, the talk step ends silenced, zero calls", async () => {
    const { agent, clock, provider, calls } = build([lembrete], { tools: [agendaLink] });
    const t1 = await agent.turn({ sessionId: "s1", context: ai, event: "meeting_booked", payload: { eventId: "ev-9" }, key: "meet:9" });
    clock.advance("10m");
    const t2 = await agent.turn({ sessionId: "s1", context: ai, session: saved(t1), wake: t1.schedule[0].key, silenced: "janela de 24h fechada" });
    expect(t2.llmCalls).toBe(0);
    expect(provider.calls).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(t2.messages).toEqual([]);
    expect(t2.outcomes.map((o) => [o.stepId, o.status, o.code, o.detail])).toEqual([["n", "ok", undefined, undefined], ["p", "skipped", "silenced", "janela de 24h fechada"]]);
    expect(t2.ended.map((r) => [r.flowId, r.reason])).toEqual([["lembrete", "skipped"]]);
  });
});
