/**
 * The code-only turn engine: scenarios S5, S7 and S13 without a single
 * provider call, plus the movement primitives (if, then/clear, onEnd, while,
 * replay, the step cap) and the host gate (`silenced`).
 */

import { OUTCOME_MESSAGES } from "../src/index.js";
import { describe, expect, test } from "bun:test";

import { Runner } from "../src/core/Runner.js";
import { evaluate } from "../src/core/predicate.js";
import { falai, FlowConfigurationError } from "../src/index.js";
import type { ActionResult, Duration, Flow, Run, Session, TurnInput } from "../src/index.js";
import { fakeClock, MemoryScheduler } from "../src/utils/clock.js";
import { parseDuration } from "../src/utils/duration.js";
import { mockProvider } from "./mock-provider.js";
import { drive, isTalk, saved, spoken, understood } from "./runner-harness.js";

interface Ctx {
  lead: { tags: string[]; owner: "ai" | "human" };
}

const f = falai<Ctx>().fields({
  nome: { type: "string", ask: "Pergunte o nome." },
  modelo: { type: "string", ask: "Pergunte o modelo." },
  confirmado: { type: "boolean", ask: "Confirme." },
});

type Data = { nome: string; modelo: string; confirmado: boolean };

const T0 = "2026-09-20T10:00:00.000Z";
const ai: Ctx = { lead: { tags: ["vip"], owner: "ai" } };

function setup(flows: Flow<Ctx, Data>[], options: { idle?: "silent"; reply?: (name: string, calls: number) => ActionResult } = {}) {
  const clock = fakeClock(T0);
  const calls: Array<{ action: string; key: string; params: Record<string, unknown> }> = [];
  const action = (name: string) =>
    f.action({
      parameters: { message: { type: "string", optional: true }, templateId: { type: "string", optional: true }, tags: { type: "array", items: { type: "string" }, optional: true } },
      run: (params, ctx) => {
        calls.push({ action: name, key: ctx.key, params });
        return options.reply ? options.reply(name, calls.length) : { ok: true };
      },
    });
  const runner = new Runner<Ctx, Data>({
    name: "Ana",
    provider: mockProvider(),
    fields: f.fields,
    actions: { notify: action("notify"), add_tags: action("add_tags"), send_template: action("send_template") },
    flows,
    clock,
    ...(options.idle ? { idle: options.idle } : {}),
  });
  return { runner, clock, calls };
}

const message = (text: string, id: string, extra: Partial<TurnInput<Ctx, Data>> = {}): TurnInput<Ctx, Data> => ({
  sessionId: "s1", context: ai, message: text, id, ...extra,
});
/** The model's verdict that this message is for `flowId`: with the idle speaker on, a lone flow is scored too. */
const routedTo = (flowId: string) => understood({ flows: { [flowId]: 90 } });

describe("duration, clock and predicates", () => {
  test("parseDuration reads s/m/h/d and rejects the rest", () => {
    expect(parseDuration("30s")).toBe(30_000);
    expect(parseDuration("5m")).toBe(300_000);
    expect(parseDuration("24h")).toBe(86_400_000);
    expect(parseDuration("1.5d")).toBe(129_600_000);
    expect(() => parseDuration("tomorrow")).toThrow(FlowConfigurationError);
  });

  test("fakeClock moves only when told; MemoryScheduler fires what is due, in order", () => {
    const clock = fakeClock(T0);
    expect(clock().toISOString()).toBe(T0);
    clock.advance("1h");
    expect(clock.now().toISOString()).toBe("2026-09-20T11:00:00.000Z");
    const scheduler = new MemoryScheduler();
    scheduler.add({ key: "b", at: new Date("2026-09-20T13:00:00Z") });
    scheduler.add({ key: "a", at: new Date("2026-09-20T12:00:00Z") });
    scheduler.add({ key: "c", at: new Date("2026-09-20T14:00:00Z"), replaces: "b" });
    expect(scheduler.size).toBe(2);
    expect(scheduler.due(clock.set("2026-09-20T13:30:00Z")).map((e) => e.key)).toEqual(["a"]);
    expect(scheduler.due(clock.advance(60 * 60 * 1000)).map((e) => e.key)).toEqual(["c"]);
    expect(scheduler.size).toBe(0);
  });

  test("evaluate: functions run as is, specs AND their keys, unknown names throw", () => {
    const run: Run = {
      id: "r", flowId: "x", anchor: "s1", dedupeKey: "x:s1:", stepId: null, status: "running",
      trigger: { kind: "message", key: "m1" }, hop: 0, startedAt: T0, asked: {}, visits: {}, outcomes: [],
    };
    const ctx = { context: ai, data: { nome: "Ana", confirmado: true }, input: undefined, run, now: new Date(T0) };
    const conditions = { tagsAny: f.condition((c, tags: string[]) => tags.some((t) => c.context.lead.tags.includes(t))) };
    expect(evaluate(() => false, ctx, conditions)).toBe(false);
    expect(evaluate({ equals: { confirmado: true }, known: ["nome"] }, ctx, conditions)).toBe(true);
    expect(evaluate({ equals: { confirmado: false } }, ctx, conditions)).toBe(false);
    expect(evaluate({ known: ["modelo"] }, ctx, conditions)).toBe(false);
    expect(evaluate({ silenced: true }, ctx, conditions)).toBe(false);
    expect(evaluate({ silenced: true }, { ...ctx, silenced: "pausa" }, conditions)).toBe(true);
    expect(evaluate({ tagsAny: ["vip"] }, ctx, conditions)).toBe(true);
    expect(() => evaluate({ nope: 1 }, ctx, conditions)).toThrow(/unknown condition "nope"/);
  });
});

describe("S7: code-only mention flow runs beside the reply", () => {
  const concorrente = f.flow({
    id: "concorrente", name: "Lead falou de concorrente",
    on: [{ mention: [], if: ({ context }) => context.lead.tags.includes("vip") }],
    steps: [
      { id: "tag", do: "add_tags", with: { tags: ["concorrente"] } },
      { id: "avisa", do: "notify", with: { message: "{{data.nome}} falou de concorrente" } },
    ],
  });

  test("starts, runs both do steps with deterministic keys, ends, and leaves the idle speaker to answer", async () => {
    const { runner, calls } = setup([concorrente]);
    const { result, talk, understood: asked } = await drive(runner, message("oi", "m1"));
    expect(asked).toBe(false);
    expect(result.llmCalls).toBe(0);
    expect(result.started).toEqual([{ runId: "concorrente#m1", flowId: "concorrente", anchor: "s1", dedupeKey: "concorrente:s1:" }]);
    expect(result.ended.map((r) => r.reason)).toEqual(["end"]);
    expect(result.outcomes.map((o) => [o.kind, o.status, o.key])).toEqual([
      ["do", "ok", "concorrente#m1:tag:1"],
      ["do", "ok", "concorrente#m1:avisa:1"],
    ]);
    expect(calls.map((c) => c.key)).toEqual(["concorrente#m1:tag:1", "concorrente#m1:avisa:1"]);
    expect(calls[1].params).toEqual({ message: "{{data.nome}} falou de concorrente" });
    expect(result.session.claims["concorrente:s1:"]).toEqual({ at: T0 });
    expect(result.session.runs).toEqual([]);
    expect(result.messages).toEqual([]);
    expect(talk).toEqual({ idle: { prompt: "" } });
    expect(result.changed).toBe(true);
  });

  test("the same input from the same session version yields a deep-equal result", async () => {
    const a = await drive(setup([concorrente]).runner, message("oi", "m1"));
    const b = await drive(setup([concorrente]).runner, message("oi", "m1"));
    expect(b.result).toEqual(a.result);
  });

  test("a failing if does not start the run and is not a trigger skip", async () => {
    const { runner, calls } = setup([concorrente]);
    const { result } = await drive(runner, message("oi", "m1", { context: { lead: { tags: [], owner: "ai" } } }));
    expect(result.started).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("idle: 'silent' mutes the idle speaker", async () => {
    const { runner } = setup([concorrente], { idle: "silent" });
    const { talk } = await drive(runner, message("oi", "m1"));
    expect(talk).toBeNull();
  });
});

describe("a lone phrased flow starts unscored only when nobody else could answer", () => {
  const agendar = f.flow({ id: "agendar", name: "Agendar", on: [{ message: ["quer agendar"] }], steps: [{ id: "a", prompt: "Ofereça horários." }] });
  const geral = f.flow({ id: "geral", name: "Geral", on: [{ message: [] }], steps: [{ id: "g", prompt: "Responda." }] });
  const low = understood({ flows: { agendar: 10 } });

  test("idle 'silent' and no catch-all: it starts with no understand call", async () => {
    const { result, understood: asked } = await drive(setup([agendar], { idle: "silent" }).runner, message("oi", "m1"), { speak: () => spoken("Temos horário amanhã.") });
    expect(asked).toBe(false);
    expect(result.started.map((s) => s.flowId)).toEqual(["agendar"]);
  });

  test("an eligible catch-all: the lone flow is scored, and a low score hands the message to the catch-all", async () => {
    const t1 = await drive(setup([agendar, geral], { idle: "silent" }).runner, message("oi", "m1"), { understanding: low, speak: () => spoken("Oi!") });
    expect(t1.understood).toBe(true);
    expect(t1.result.started.map((s) => s.flowId)).toEqual(["geral"]);

    const t2 = await drive(setup([agendar, geral], { idle: "silent" }).runner, message("quero agendar", "m1"), { understanding: routedTo("agendar"), speak: () => spoken("Temos horário amanhã.") });
    expect(t2.result.started.map((s) => s.flowId)).toEqual(["agendar"]);
  });

  test("the idle speaker: the lone flow is scored, and a low score leaves the reply to idle", async () => {
    const { result, talk, understood: asked } = await drive(setup([agendar]).runner, message("oi", "m1"), { understanding: low, speak: () => spoken("Oi!") });
    expect(asked).toBe(true);
    expect(result.started).toEqual([]);
    expect(talk).toEqual({ idle: { prompt: "" } });
  });
});

describe("S5: campaign start, deferred send, wake, reply into the funnel", () => {
  const campanha = f.flow({
    id: "campanha", name: "Campanha",
    steps: [
      { id: "envio", do: "send_template", with: { templateId: "{{input.templateId}}" } },
      { id: "espera", wait: "1d", else: { flow: "{{input.flowId}}" } },
      { id: "nudge", prompt: "Cutuque de leve." },
      { id: "espera2", wait: "2d", else: { flow: "{{input.flowId}}" } },
    ],
  });
  const funil = f.flow({ id: "funil", name: "Funil", steps: [{ id: "q", collect: ["nome"] }] });

  test("defer parks under a fresh wake key; the wake re-runs the same key; the reply chains into the funnel which holds the floor", async () => {
    const { runner, clock, calls } = setup([campanha, funil], {
      reply: (name, n) => (name === "send_template" && n === 1 ? { defer: "24h", detail: "sem créditos" } : { ok: true, spoke: true }),
    });
    const start: TurnInput<Ctx, Data> = {
      sessionId: "s1", context: ai,
      start: { flow: "campanha", input: { templateId: "t1", flowId: "funil" }, key: "camp:1" },
    };
    const t1 = await drive(runner, start);
    expect(t1.talk).toBeNull();
    expect(t1.result.llmCalls).toBe(0);
    expect(t1.result.outcomes.map((o) => [o.status, o.detail])).toEqual([["deferred", "sem créditos"]]);
    const wakeAt = new Date(Date.parse(T0) + parseDuration("24h"));
    expect(t1.result.schedule).toEqual([{ key: `campanha#camp:1:envio:${wakeAt.getTime()}`, at: wakeAt }]);
    expect(t1.result.session.runs[0].status).toBe("waiting");
    expect(t1.result.session.runs[0].waiting?.key).toBe(t1.result.schedule[0].key);
    expect(calls[0].params).toEqual({ templateId: "t1" });

    clock.advance("24h");
    const t2 = await drive(runner, { sessionId: "s1", context: ai, session: saved(t1.result), wake: t1.result.schedule[0].key });
    expect(t2.talk).toBeNull();
    expect(calls.map((c) => c.key)).toEqual(["campanha#camp:1:envio:1", "campanha#camp:1:envio:1"]);
    expect(t2.result.outcomes.map((o) => [o.kind, o.status])).toEqual([["do", "ok"], ["wait", "waiting"]]);
    expect(t2.result.session.lastAssistantAt).toBe(clock.now().toISOString());
    const espera = t2.result.session.runs[0];
    expect(espera.stepId).toBe("espera");
    expect(t2.result.schedule[0].key).toBe(espera.waiting?.key ?? "");

    clock.advance("2h");
    const t3 = await drive(runner, message("oi, vi a mensagem", "m2", { session: saved(t2.result) }), {
      understanding: understood(),
      speak: () => spoken("Qual seu nome?"),
    });
    expect(t3.result.ended.map((r) => [r.flowId, r.reason])).toEqual([["campanha", "flow"]]);
    expect(t3.result.started).toEqual([{ runId: "funil#campanha#camp:1:espera:1", flowId: "funil", anchor: "s1", dedupeKey: "funil:s1:campanha#camp:1:espera:1" }]);
    const child = t3.result.session.runs[0];
    expect(child.trigger).toEqual({ kind: "flow", key: "campanha#camp:1:espera:1", payload: { templateId: "t1", flowId: "funil" } });
    expect(child.hop).toBe(1);
    expect(child.status).toBe("asking");
    expect(child.asked).toEqual({ nome: 1 });
    expect(isTalk(t3.talk) && t3.talk.run.id).toBe("funil#campanha#camp:1:espera:1");
    expect(t3.result.messages).toEqual([{ text: "Qual seu nome?", kind: "ai", afterMs: 0, key: "funil#campanha#camp:1:espera:1:q:1", runId: "funil#campanha#camp:1:espera:1", stepId: "q" }]);
    expect(t3.result.outcomes[0]).toMatchObject({ kind: "wait", status: "ok", code: "replied", next: "flow:{{input.flowId}}" });
    expect(t3.result.llmCalls).toBe(0);
  });

  test("a stale wake for the deferred step is ignored and saves nothing", async () => {
    const { runner } = setup([campanha, funil], { reply: () => ({ defer: "24h", detail: "sem créditos" }) });
    const t1 = await drive(runner, { sessionId: "s1", context: ai, start: { flow: "campanha", input: { templateId: "t1", flowId: "funil" }, key: "camp:1" } });
    const { result } = await drive(runner, { sessionId: "s1", context: ai, session: saved(t1.result), wake: "campanha#camp:1:envio:1" });
    expect(result.changed).toBe(false);
    expect(result.outcomes).toEqual([{ kind: "wait", status: "skipped", code: "stale-wake", message: OUTCOME_MESSAGES["stale-wake"], key: "campanha#camp:1:envio:1", at: T0 }]);
  });

  test("a defer that is not a duration fails the step instead of throwing the turn", async () => {
    // The handler already ran: a throw here made every replay repeat its side effect.
    const { runner, calls } = setup([campanha, funil], { reply: () => ({ defer: "2 minutos" as Duration, detail: "x" }) });
    const { result } = await drive(runner, { sessionId: "s1", context: ai, start: { flow: "campanha", input: { templateId: "t1", flowId: "funil" }, key: "camp:1" } });
    expect(calls).toHaveLength(1);
    expect(result.outcomes[0]).toMatchObject({
      kind: "do",
      status: "failed",
      code: "action-failed",
      detail: 'action "send_template" asked to defer by "2 minutos", which is not a duration. Use a value like "2m" or "1h".',
    });
  });
});

describe("S13: say / wait 3s / say / prompt in one turn", () => {
  const trid = f.flow({
    id: "trid", name: "TRID",
    on: [{ message: ["quer iphone"] }],
    steps: [
      { id: "a", say: "Oi! Aqui é da TRID." },
      { id: "p", wait: "3s" },
      { id: "b", say: "Chegou o iPhone 17, pronta entrega." },
      { id: "q", prompt: "Pergunte qual modelo interessa.", collect: ["modelo"] },
    ],
  });

  test("messages [A, B afterMs 3000] and the prompt speaks; own says never silence own talk", async () => {
    const { runner } = setup([trid]);
    const { result, talk } = await drive(runner, message("oi", "m1"), { understanding: routedTo("trid"), speak: () => spoken("Qual modelo?", { modelo: "17 Pro" }) });
    expect(result.llmCalls).toBe(0);
    expect(result.messages).toEqual([
      { text: "Oi! Aqui é da TRID.", kind: "verbatim", afterMs: 0, key: "trid#m1:a:1", runId: "trid#m1", stepId: "a" },
      { text: "Chegou o iPhone 17, pronta entrega.", kind: "verbatim", afterMs: 3000, key: "trid#m1:b:1", runId: "trid#m1", stepId: "b" },
      { text: "Qual modelo?", kind: "ai", afterMs: 0, key: "trid#m1:q:1", runId: "trid#m1", stepId: "q" },
    ]);
    expect(isTalk(talk) && talk.step.id).toBe("q");
    expect(isTalk(talk) && talk.pending).toEqual(["modelo"]);
    expect(result.session.data).toEqual({ modelo: "17 Pro" });
    expect(result.ended.map((r) => r.reason)).toEqual(["end"]);
    expect(result.schedule).toEqual([]);
    expect(result.session.lastAssistantAt).toBe(T0);
  });

  test("a short wait with nothing to say after it schedules a real wake", async () => {
    const { runner } = setup([f.flow({ id: "w", name: "W", steps: [{ id: "p", wait: "5s" }, { id: "n", do: "notify", with: {} }] })]);
    const { result } = await drive(runner, { sessionId: "s1", context: ai, start: { flow: "w", key: "k" } });
    expect(result.schedule).toHaveLength(1);
    expect(result.session.runs[0].status).toBe("waiting");
  });

  test("another run's say silences the floor's talk that turn; the floor stays asking", async () => {
    const aviso = f.flow({
      id: "aviso", name: "Aviso",
      on: [{ mention: [], if: ({ context }) => context.lead.tags.includes("pediu_humano") }],
      steps: [{ id: "s", say: "Já chamo alguém." }],
    });
    const { runner } = setup([trid, aviso]);
    const t1 = await drive(runner, message("oi", "m1"), { understanding: routedTo("trid"), speak: () => spoken("Qual modelo?") });
    const humano: Ctx = { lead: { tags: ["vip", "pediu_humano"], owner: "ai" } };
    const t2 = await drive(runner, message("quero falar com alguém", "m2", { session: saved(t1.result), context: humano }), { understanding: understood() });
    expect(t2.talk).toBeNull();
    expect(t2.result.messages.map((m) => m.text)).toEqual(["Já chamo alguém."]);
    expect(t2.result.outcomes.find((o) => o.code === "another-reply")).toMatchObject({ kind: "collect", runId: "trid#m1" });
    expect(t2.result.session.runs.find((r) => r.flowId === "trid")?.status).toBe("asking");
  });
});

describe("the floor: suspended runs resume most recently suspended first", () => {
  // `tarde` starts early but only reaches its talk step an hour later, so its `startedAt`
  // is the oldest while its suspension is the newest: `suspendedAt` decides, not `startedAt`.
  const tarde = f.flow({ id: "tarde", name: "Tarde", steps: [{ id: "w", wait: "1h" }, { id: "p", prompt: "Fale primeiro.", collect: ["confirmado"] }] });
  const funil = f.flow({ id: "funil", name: "Funil", steps: [{ id: "q", collect: ["nome"] }] });
  const outro = f.flow({ id: "outro", name: "Outro", steps: [{ id: "q", collect: ["modelo"] }] });
  const start = (flow: string, key: string, session?: Session<Data>): TurnInput<Ctx, Data> => ({ sessionId: "s1", context: ai, session, start: { flow, key } });

  test("a run that took the floor by wake is suspended after an older run and resumes before it", async () => {
    const { runner, clock } = setup([tarde, funil, outro]);
    const t1 = await drive(runner, start("tarde", "a"));
    expect(t1.result.session.runs[0]).toMatchObject({ id: "tarde#a", status: "waiting" });

    clock.advance("10m");
    const t2 = await drive(runner, start("funil", "b", saved(t1.result)), { speak: () => spoken("Seu nome?") });
    expect(t2.result.session.runs.map((r) => [r.id, r.status])).toEqual([["tarde#a", "waiting"], ["funil#b", "asking"]]);

    clock.advance("50m");
    const t3 = await drive(runner, { sessionId: "s1", context: ai, session: saved(t2.result), wake: t1.result.schedule[0].key }, { speak: () => spoken("Oi, sou eu.") });
    expect(t3.result.session.runs.map((r) => [r.id, r.status])).toEqual([["tarde#a", "asking"], ["funil#b", "suspended"]]);
    expect(t3.result.session.runs[1].suspendedAt).toBe(clock.now().toISOString());

    clock.advance("10m");
    const t4 = await drive(runner, start("outro", "c", saved(t3.result)), { speak: () => spoken("Qual modelo?") });
    expect(t4.result.session.runs.map((r) => [r.id, r.status])).toEqual([["tarde#a", "suspended"], ["funil#b", "suspended"], ["outro#c", "asking"]]);

    clock.advance("10m");
    const t5 = await drive(runner, message("iPhone 17", "m1", { session: saved(t4.result) }), {
      understanding: understood({ fields: { modelo: "iPhone 17" } }),
      speak: () => spoken("Anotado."),
    });
    expect(t5.result.ended.map((r) => r.id)).toEqual(["outro#c"]);
    // LIFO by suspension: tarde (suspended last) resumes, not funil (started later than tarde).
    expect(t5.result.session.runs.map((r) => [r.id, r.status])).toEqual([["tarde#a", "asking"], ["funil#b", "suspended"]]);
    expect(t5.result.session.runs[0]).not.toHaveProperty("suspendedAt");
  });
  test("a run resumed on a message has its if branches judged before its step moves on", async () => {
    const compra = f.flow({
      id: "compra", name: "Compra",
      steps: [
        { id: "q", collect: ["modelo"], branches: [{ if: ({ context }) => context.lead.tags.includes("comprou"), then: "pos" }], then: "avisa" },
        { id: "avisa", do: "notify", with: {}, then: "end" },
        { id: "pos", say: "Vi que você já comprou! Posso ajudar no pós-venda?" },
      ],
    });
    const comprou: Ctx = { lead: { tags: ["vip", "comprou"], owner: "ai" } };
    const { runner, clock, calls } = setup([compra, outro]);
    const t1 = await drive(runner, start("compra", "a"), { speak: () => spoken("Qual modelo?") });
    clock.advance("1m");
    const t2 = await drive(runner, start("outro", "b", saved(t1.result)), { speak: () => spoken("Qual modelo você quer?") });
    expect(t2.result.session.runs.map((r) => [r.id, r.status])).toEqual([["compra#a", "suspended"], ["outro#b", "asking"]]);
    clock.advance("1m");
    const t3 = await drive(runner, message("um Corolla", "m3", { session: saved(t2.result), context: comprou }), {
      understanding: understood({ fields: { modelo: "Corolla" } }),
    });
    expect(calls).toEqual([]);
    expect(t3.result.messages.map((m) => m.text)).toEqual(["Vi que você já comprou! Posso ajudar no pós-venda?"]);
  });

  test("a message nobody answered goes down the suspended stack until a run answers it", async () => {
    const campanha = f.flow({ id: "campanha", name: "Campanha", steps: [{ id: "m", collect: ["modelo"] }] });
    const { runner, clock } = setup([funil, campanha, outro]);
    const t1 = await drive(runner, start("funil", "a"), { speak: () => spoken("Seu nome?") });
    clock.advance("1m");
    const t2 = await drive(runner, start("campanha", "b", saved(t1.result)), { speak: () => spoken("Qual modelo te interessa?") });
    clock.advance("1m");
    const t3 = await drive(runner, start("outro", "c", saved(t2.result)), { speak: () => spoken("Qual modelo?") });
    expect(t3.result.session.runs.map((r) => [r.id, r.status])).toEqual([["funil#a", "suspended"], ["campanha#b", "suspended"], ["outro#c", "asking"]]);
    clock.advance("1m");
    const t4 = await drive(runner, message("um Corolla", "m4", { session: saved(t3.result) }), {
      understanding: understood({ fields: { modelo: "Corolla" } }),
      speak: () => spoken("Anotado! E seu nome?"),
    });
    expect(t4.result.messages.map((m) => m.key)).toEqual(["funil#a:q:1"]);
  });
});

describe("if, then { step, clear }, onEnd, while, replay and the step cap", () => {
  const gate = f.flow({
    id: "gate", name: "Gate",
    steps: [
      { id: "c1", collect: ["confirmado"] },
      { id: "ok", if: { equals: { confirmado: true } }, else: { step: "c1", clear: ["confirmado"] } },
      { id: "fim", do: "notify", with: { message: "ok" } },
    ],
  });
  const withData = (data: Partial<Data>): Session<Data> => ({ id: "s1", v: 4, version: 3, data, runs: [], claims: {}, inputs: [], metadata: {} });

  test("a false if takes else, clears the field, re-enters the step with a new visit", async () => {
    const { runner } = setup([gate]);
    const { result, talk } = await drive(runner, { sessionId: "s1", context: ai, session: withData({ confirmado: false }), start: { flow: "gate", key: "k" } });
    expect(result.outcomes.map((o) => [o.kind, o.status, o.code, o.next])).toEqual([
      ["collect", "skipped", "already-known", undefined],
      ["if", "ok", undefined, "c1"],
    ]);
    expect(result.session.data).toEqual({});
    expect(result.session.runs[0].visits).toEqual({ c1: 2, ok: 1 });
    expect(isTalk(talk) && talk.step.id).toBe("c1");
    expect(result.session.runs[0].status).toBe("asking");
  });

  test("a true if takes then and the flow finishes", async () => {
    const { runner, calls } = setup([gate]);
    const { result } = await drive(runner, { sessionId: "s1", context: ai, session: withData({ confirmado: true }), start: { flow: "gate", key: "k" } });
    expect(calls.map((c) => c.key)).toEqual(["gate#k:fim:1"]);
    expect(result.ended.map((r) => r.reason)).toEqual(["end"]);
  });

  test("onEnd 'stay' repeats the last step with a new key each time", async () => {
    const faq = f.flow({ id: "faq", name: "FAQ", on: [{ message: ["pergunta"] }], onEnd: "stay", steps: [{ id: "r", prompt: "Responda." }] });
    const { runner } = setup([faq]);
    const t1 = await drive(runner, message("oi", "m1"), { understanding: routedTo("faq"), speak: () => spoken("Oi!") });
    expect(t1.result.session.runs[0]).toMatchObject({ stepId: "r", status: "asking", visits: { r: 2 } });
    const t2 = await drive(runner, message("e aí", "m2", { session: saved(t1.result) }), { speak: () => spoken("Tudo bem!") });
    expect(t1.result.messages[0].key).toBe("faq#m1:r:1");
    expect(t2.result.messages[0].key).toBe("faq#m1:r:2");
    expect(t2.result.ended).toEqual([]);
  });

  test("onEnd 'reset' closes the run and starts a fresh one at step one, data kept", async () => {
    const loop = f.flow({ id: "loop", name: "Loop", on: [{ message: ["oi"] }], onEnd: "reset", steps: [{ id: "p", prompt: "Oi." }, { id: "n", do: "notify", with: {} }] });
    const { runner } = setup([loop]);
    const { result } = await drive(runner, message("oi", "m1"), { understanding: routedTo("loop"), speak: () => spoken("Oi!", { nome: "Ana" }) });
    expect(result.ended.map((r) => [r.id, r.reason])).toEqual([["loop#m1", "reset"]]);
    expect(result.started.map((s) => s.runId)).toEqual(["loop#m1", "loop#loop#m1:n:1"]);
    expect(result.session.runs[0]).toMatchObject({ id: "loop#loop#m1:n:1", stepId: "p", status: "asking", hop: 1 });
    expect(result.session.data).toEqual({ nome: "Ana" });
  });

  test("while (default: the trigger if) re-checked with fresh context ends the run", async () => {
    const vip = f.flow({ id: "vip", name: "VIP", on: [{ message: ["quero"], if: ({ context }) => context.lead.tags.includes("vip") }], steps: [{ id: "q", collect: ["nome"] }] });
    const { runner } = setup([vip]);
    const t1 = await drive(runner, message("quero", "m1"), { understanding: routedTo("vip"), speak: () => spoken("Nome?") });
    expect(t1.result.session.runs[0].status).toBe("asking");
    const t2 = await drive(runner, message("oi", "m2", { session: saved(t1.result), context: { lead: { tags: [], owner: "ai" } } }));
    expect(t2.result.ended.map((r) => r.reason)).toEqual(["skipped"]);
    expect(t2.result.outcomes[0]).toMatchObject({ kind: "collect", status: "skipped", code: "premise-changed", runId: "vip#m1" });
    expect(t2.talk).toEqual({ idle: { prompt: "" } });
  });

  test("an explicit while wins over the trigger if", async () => {
    const flow = f.flow({ id: "w", name: "W", on: [{ message: ["x"] }], while: { known: ["nome"] }, steps: [{ id: "n", do: "notify", with: {} }] });
    const { runner, calls } = setup([flow]);
    const { result } = await drive(runner, message("x", "m1"), { understanding: routedTo("w") });
    expect(calls).toEqual([]);
    expect(result.outcomes.map((o) => o.code)).toEqual(["premise-changed"]);
  });

  test("a replayed keyed input is a no-op with changed: false", async () => {
    const { runner } = setup([gate]);
    const t1 = await drive(runner, message("oi", "m1"));
    expect(t1.result.session.inputs).toEqual(["m1"]);
    const t2 = await drive(runner, message("oi", "m1", { session: saved(t1.result) }));
    expect(t2.result.changed).toBe(false);
    expect(t2.result.outcomes.map((o) => o.code)).toEqual(["duplicate-input"]);
    expect(t2.talk).toBeNull();
  });

  test("50 steps per run per turn ends the run as failed", async () => {
    const spin = f.flow({ id: "spin", name: "Spin", steps: [{ id: "a", if: () => true, then: "b" }, { id: "b", if: () => true, then: "a" }] });
    const { runner } = setup([spin]);
    const { result } = await drive(runner, { sessionId: "s1", context: ai, start: { flow: "spin", key: "k" } });
    expect(result.ended.map((r) => r.reason)).toEqual(["failed"]);
    expect(result.outcomes.at(-1)).toMatchObject({ kind: "if", status: "failed", code: "step-loop" });
    expect(result.outcomes).toHaveLength(51);
  });

  test("missing flow or step ends the run with the pt-BR reason", async () => {
    const stale: Session<Data> = {
      id: "s1", v: 4, version: 1, data: {}, claims: {}, inputs: [], metadata: {},
      runs: [
        { id: "gone#k", flowId: "gone", anchor: "s1", dedupeKey: "gone:s1:", stepId: "x", status: "running", trigger: { kind: "start", key: "k" }, hop: 0, startedAt: T0, asked: {}, visits: {}, outcomes: [] },
        { id: "gate#k", flowId: "gate", anchor: "s1", dedupeKey: "gate:s1:", stepId: "nope", status: "running", trigger: { kind: "start", key: "k" }, hop: 0, startedAt: T0, asked: {}, visits: {}, outcomes: [] },
      ],
    };
    const { runner } = setup([gate]);
    const { result } = await drive(runner, message("oi", "m1", { session: stale }));
    expect(result.outcomes.map((o) => o.code)).toEqual(["flow-gone", "step-gone"]);
  });
});

describe("onEnd 'stay' answers every message from the last talk step, even one that only collects", () => {
  const lead = f.flow({
    id: "lead", name: "Lead", on: [{ message: ["quero"] }], onEnd: "stay",
    steps: [{ id: "q", collect: ["nome"], maxAsks: 2 }, { id: "avisa", do: "notify", with: {} }],
  });
  const asked = async () => {
    const { runner, calls } = setup([lead]);
    const t1 = await drive(runner, message("quero", "m1"), { understanding: routedTo("lead"), speak: () => spoken("Qual seu nome?") });
    return { runner, calls, t1 };
  };

  test("the reply that fills the field is answered, the tail runs once, then every message gets its own key", async () => {
    const { runner, calls, t1 } = await asked();
    const t2 = await drive(runner, message("Ana", "m2", { session: saved(t1.result) }), { speak: () => spoken("Prazer, Ana!", { nome: "Ana" }) });
    expect(t2.result.messages.map((m) => m.key)).toEqual(["lead#m1:q:1"]);
    expect(calls.map((c) => c.key)).toEqual(["lead#m1:avisa:1"]);
    expect(t2.result.session.runs[0]).toMatchObject({ stepId: "q", status: "asking", staying: true, visits: { q: 2, avisa: 1 } });

    const t3 = await drive(runner, message("e o preço?", "m3", { session: saved(t2.result) }), { speak: () => spoken("R$ 99.") });
    const t4 = await drive(runner, message("e o prazo?", "m4", { session: saved(t3.result) }), { speak: () => spoken("Dois dias.") });
    expect([t3, t4].map((t) => t.result.messages.map((m) => m.key))).toEqual([["lead#m1:q:2"], ["lead#m1:q:3"]]);
    expect(isTalk(t3.talk) && t3.talk.pending).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(t4.result.ended).toEqual([]);
    expect(t4.result.session.runs[0]).toMatchObject({ status: "asking", staying: true, visits: { q: 4, avisa: 1 } });
  });

  test("a field the understand call filled finishes the flow and the step answers that same message", async () => {
    const { runner, calls, t1 } = await asked();
    const t2 = await drive(runner, message("sou a Ana", "m2", { session: saved(t1.result) }), {
      understanding: understood({ fields: { nome: "Ana" } }),
      speak: () => spoken("Prazer, Ana!"),
    });
    expect(t2.result.outcomes.map((o) => [o.stepId, o.status, o.key])).toEqual([
      ["q", "ok", "lead#m1:q:1"],
      ["avisa", "ok", "lead#m1:avisa:1"],
      ["q", "ok", "lead#m1:q:2"],
    ]);
    expect(t2.result.messages.map((m) => [m.key, m.text])).toEqual([["lead#m1:q:2", "Prazer, Ana!"]]);
    expect(calls).toHaveLength(1);
    expect(t2.result.session.runs[0]).toMatchObject({ status: "asking", staying: true, visits: { q: 3 } });
  });

  test("the message that hits maxAsks is still answered, and max-asks is reported once", async () => {
    const { runner, t1 } = await asked();
    const t2 = await drive(runner, message("hm", "m2", { session: saved(t1.result) }), { speak: () => spoken("Sem problema.") });
    expect(t2.result.messages.map((m) => m.key)).toEqual(["lead#m1:q:1"]);
    const t3 = await drive(runner, message("oi?", "m3", { session: saved(t2.result) }), { speak: () => spoken("Oi! Em que ajudo?") });
    expect(t3.result.messages.map((m) => m.key)).toEqual(["lead#m1:q:2"]);
    const t4 = await drive(runner, message("preço?", "m4", { session: saved(t3.result) }), { speak: () => spoken("R$ 99.") });
    expect(t4.result.messages.map((m) => m.key)).toEqual(["lead#m1:q:3"]);
    const maxAsks = [t2, t3, t4].flatMap((t) => t.result.outcomes.filter((o) => o.code === "max-asks"));
    expect(maxAsks).toEqual([expect.objectContaining({ detail: "nome", stepId: "q" })]);
  });

  test("a silenced message leaves the run staying, asking, with zero calls", async () => {
    const { runner, t1 } = await asked();
    const t2 = await drive(runner, message("Ana", "m2", { session: saved(t1.result) }), { speak: () => spoken("Prazer!", { nome: "Ana" }) });
    const t3 = await drive(runner, message("oi", "m3", { session: saved(t2.result), silenced: "pausa" }));
    expect(t3.talk).toBeNull();
    expect(t3.result.llmCalls).toBe(0);
    expect(t3.result.ended).toEqual([]);
    expect(t3.result.session.runs[0]).toMatchObject({ status: "asking", staying: true, visits: { q: 2 } });
  });

  test("a silenced message that finishes the flow leaves it staying without a word", async () => {
    const { runner, calls, t1 } = await asked();
    const t2 = await drive(runner, message("sou a Ana", "m2", { session: saved(t1.result), silenced: { reason: "pausa", understand: true } }), {
      understanding: understood({ fields: { nome: "Ana" } }),
    });
    expect(t2.talk).toBeNull();
    expect(calls).toHaveLength(1);
    expect(t2.result.session.runs[0]).toMatchObject({ status: "asking", staying: true, visits: { q: 2 } });
  });

  test("a start turn for another flow leaves the staying run where it is", async () => {
    const tarefa = f.flow({ id: "tarefa", name: "Tarefa", steps: [{ id: "n", do: "notify", with: {} }] });
    const { runner, calls } = setup([lead, tarefa]);
    const t1 = await drive(runner, message("quero", "m1"), { understanding: routedTo("lead"), speak: () => spoken("Nome?") });
    const t2 = await drive(runner, message("Ana", "m2", { session: saved(t1.result) }), { speak: () => spoken("Prazer!", { nome: "Ana" }) });
    const t3 = await drive(runner, { sessionId: "s1", context: ai, session: saved(t2.result), start: { flow: "tarefa", key: "k" } });
    expect(t3.talk).toBeNull();
    expect(calls.map((c) => c.key)).toEqual(["lead#m1:avisa:1", "tarefa#k:n:1"]);
    expect(t3.result.session.runs).toEqual([t2.result.session.runs[0]]);
  });

  test("a branch taken from the staying step moves the run and it stops staying", async () => {
    const menu = f.flow({
      id: "menu", name: "Menu", on: [{ message: ["oi"] }], onEnd: "stay",
      steps: [
        { id: "h", collect: ["nome"] },
        { id: "r", prompt: "Responda.", branches: [{ when: "é outra pessoa", then: { step: "h", clear: ["nome"] } }] },
      ],
    });
    const { runner } = setup([menu]);
    const known: Session<Data> = { id: "s1", v: 4, version: 1, data: { nome: "Ana" }, runs: [], claims: {}, inputs: [], metadata: {} };
    const t1 = await drive(runner, message("oi", "m1", { session: known }), { understanding: routedTo("menu"), speak: () => spoken("Oi, Ana!") });
    expect(t1.result.session.runs[0]).toMatchObject({ stepId: "r", status: "asking", staying: true });
    const t2 = await drive(runner, message("não sou a Ana", "m2", { session: saved(t1.result) }), {
      understanding: understood({ branches: { "menu#m1/r/0": true } }),
    });
    expect(isTalk(t2.talk) && [t2.talk.step.id, t2.talk.pending]).toEqual(["h", ["nome"]]);
    expect(t2.result.session.data).toEqual({});
    expect(t2.result.session.runs[0].stepId).toBe("h");
    expect(t2.result.session.runs[0]).not.toHaveProperty("staying");
  });

  test("a say on the way to the end is the answer: no second reply that turn", async () => {
    const obrigado = f.flow({
      id: "lead", name: "Lead", on: [{ message: ["quero"] }], onEnd: "stay",
      steps: [{ id: "q", collect: ["nome"] }, { id: "s", say: "Obrigado! Um consultor vai te chamar." }],
    });
    const { runner } = setup([obrigado]);
    const t1 = await drive(runner, message("quero", "m1"), { understanding: routedTo("lead"), speak: () => spoken("Qual seu nome?") });
    const t2 = await drive(runner, message("sou a Ana", "m2", { session: saved(t1.result) }), { understanding: understood({ fields: { nome: "Ana" } }) });
    expect(t2.talk).toBeNull();
    expect(t2.result.messages.map((m) => [m.kind, m.key])).toEqual([["verbatim", "lead#m1:s:1"]]);
    expect(t2.result.session.runs[0]).toMatchObject({ stepId: "q", status: "asking", staying: true });
    const t3 = await drive(runner, message("e o preço?", "m3", { session: saved(t2.result) }), { speak: () => spoken("R$ 99.") });
    expect(t3.result.messages.map((m) => [m.kind, m.key])).toEqual([["ai", "lead#m1:q:2"]]);
  });

  test("an if branch the run took on the way is not judged again while it stays", async () => {
    const confirma = f.flow({
      id: "confirma", name: "Confirma", on: [{ message: ["quero"] }], onEnd: "stay",
      steps: [
        { id: "q", collect: ["confirmado"], branches: [{ if: { equals: { confirmado: true } }, then: "avisa" }] },
        { id: "avisa", do: "notify", with: {}, then: "end" },
      ],
    });
    const { runner, calls } = setup([confirma]);
    const t1 = await drive(runner, message("quero", "m1"), { understanding: routedTo("confirma"), speak: () => spoken("Confirma?") });
    // The reply fills the field, the run falls through to avisa and stays on q; from then on the branch holds on every message.
    const t2 = await drive(runner, message("sim", "m2", { session: saved(t1.result) }), { speak: () => spoken("Combinado!", { confirmado: true }) });
    const t3 = await drive(runner, message("e agora?", "m3", { session: saved(t2.result) }), { speak: () => spoken("Já te chamam.") });
    const t4 = await drive(runner, message("ok", "m4", { session: saved(t3.result) }), { speak: () => spoken("Até já.") });
    expect(calls.map((c) => c.key)).toEqual(["confirma#m1:avisa:1"]);
    expect([t3, t4].map((t) => t.result.messages.map((m) => m.key))).toEqual([["confirma#m1:q:2"], ["confirma#m1:q:3"]]);
  });

  test("it stays on the talk step its own path took, not the flow's last one", async () => {
    const menu = f.flow({
      id: "menu", name: "Menu", on: [{ message: ["oi"] }], onEnd: "stay",
      steps: [
        { id: "q", collect: ["confirmado"], branches: [{ when: "quer comprar", then: "sim" }, { when: "quer suporte", then: "nao" }] },
        { id: "sim", prompt: "Venda.", then: "end" },
        { id: "nao", prompt: "Resolva o problema.", then: "end" },
      ],
    });
    const { runner } = setup([menu]);
    const t1 = await drive(runner, message("oi", "m1"), { understanding: routedTo("menu"), speak: () => spoken("Quer comprar?") });
    const t2 = await drive(runner, message("quero comprar", "m2", { session: saved(t1.result) }), {
      understanding: understood({ branches: { "menu#m1/q/0": true } }),
      speak: () => spoken("Ótimo!"),
    });
    expect(isTalk(t2.talk) && t2.talk.step.id).toBe("sim");
    expect(t2.result.session.runs[0]).toMatchObject({ stepId: "sim", staying: true });
    const t3 = await drive(runner, message("e o preço?", "m3", { session: saved(t2.result) }), { speak: () => spoken("R$ 99.") });
    expect(isTalk(t3.talk) && t3.talk.step.id).toBe("sim");
  });

  test("finishing while another run asks, it waits suspended behind it and resumes when that run ends", async () => {
    const modelo = f.flow({ id: "modelo", name: "Modelo", on: [{ message: ["carro"] }], steps: [{ id: "m", collect: ["modelo"] }] });
    const { runner, calls } = setup([lead, modelo]);
    const known: Session<Data> = { id: "s1", v: 4, version: 1, data: { nome: "Ana" }, runs: [], claims: {}, inputs: [], metadata: {} };
    const t1 = await drive(runner, message("carro", "m1", { session: known }), { understanding: routedTo("modelo"), speak: () => spoken("Qual modelo?") });
    const t2 = await drive(runner, { sessionId: "s1", context: ai, session: saved(t1.result), start: { flow: "lead", key: "k" } });
    expect(calls.map((c) => c.key)).toEqual(["lead#k:avisa:1"]);
    expect(t2.result.session.runs.map((r) => [r.id, r.status])).toEqual([["modelo#m1", "asking"], ["lead#k", "suspended"]]);
    const t3 = await drive(runner, message("Corolla", "m3", { session: saved(t2.result) }), { speak: () => spoken("Anotado!", { modelo: "Corolla" }) });
    expect(t3.result.messages.map((m) => m.key)).toEqual(["modelo#m1:m:1"]);
    expect(t3.result.session.runs.map((r) => [r.id, r.status, r.stepId])).toEqual([["lead#k", "asking", "q"]]);
  });

  test("the message routed to it is answered by it, and the run that was asking is suspended", async () => {
    const modelo = f.flow({ id: "modelo", name: "Modelo", on: [{ message: ["carro"] }], steps: [{ id: "m", collect: ["modelo"] }] });
    const { runner } = setup([modelo, lead]);
    const t1 = await drive(runner, message("carro", "m1"), { understanding: routedTo("modelo"), speak: () => spoken("Qual modelo?") });
    const t2 = await drive(runner, message("quero, sou a Ana", "m2", { session: saved(t1.result) }), {
      understanding: understood({ flows: { lead: 90 }, fields: { nome: "Ana" } }),
      speak: () => spoken("Prazer, Ana!"),
    });
    expect(isTalk(t2.talk) && t2.talk.run.id).toBe("lead#m2");
    expect(t2.result.session.runs.map((r) => [r.id, r.status])).toEqual([["modelo#m1", "suspended"], ["lead#m2", "asking"]]);
  });

  test("an if branch on a prompt-only stay step hands off once its fact is true", async () => {
    const chat = f.flow({
      id: "chat", name: "Chat", on: [{ message: ["oi"] }], onEnd: "stay",
      steps: [{ id: "c", prompt: "Converse.", branches: [{ if: { equals: { confirmado: true } }, then: { flow: "posvenda" } }] }],
    });
    const posvenda = f.flow({ id: "posvenda", name: "Pós-venda", steps: [{ id: "pv", prompt: "Cuide do pós-venda." }] });
    const { runner } = setup([chat, posvenda]);
    const pago: Session<Data> = { id: "s1", v: 4, version: 1, data: { confirmado: true }, runs: [], claims: {}, inputs: [], metadata: {} };
    const t1 = await drive(runner, message("oi", "m1", { session: pago }), { understanding: routedTo("chat"), speak: () => spoken("Olá!") });
    expect(t1.result.session.runs[0]).toMatchObject({ stepId: "c", staying: true });
    const t2 = await drive(runner, message("e agora?", "m2", { session: saved(t1.result) }), { speak: () => spoken("Seu pedido já saiu.") });
    expect(isTalk(t2.talk) && t2.talk.run.flowId).toBe("posvenda");
  });

  test("a reply that resolves its wait into the stay is answered by that run, not the one that was asking", async () => {
    const seguro = f.flow({
      id: "seguro", name: "Seguro", on: [{ message: ["seguro"] }], onEnd: "stay",
      steps: [{ id: "s", prompt: "Fale do seguro." }, { id: "w", wait: "1d", else: "end" }, { id: "lembra", say: "Ainda por aí?" }],
    });
    const modelo = f.flow({ id: "modelo", name: "Modelo", steps: [{ id: "m", collect: ["modelo"] }] });
    const { runner } = setup([seguro, modelo]);
    const t1 = await drive(runner, message("seguro", "m1"), { understanding: routedTo("seguro"), speak: () => spoken("Temos três planos.") });
    const t2 = await drive(runner, { sessionId: "s1", context: ai, session: saved(t1.result), start: { flow: "modelo", key: "k" } }, { speak: () => spoken("Qual modelo?") });
    expect(t2.result.session.runs.map((r) => [r.id, r.status])).toEqual([["seguro#m1", "waiting"], ["modelo#k", "asking"]]);
    const t3 = await drive(runner, message("e o preço?", "m3", { session: saved(t2.result) }), { speak: () => spoken("R$ 50 por mês.") });
    expect(isTalk(t3.talk) && t3.talk.run.id).toBe("seguro#m1");
    expect(t3.result.session.runs.map((r) => [r.id, r.status])).toEqual([["seguro#m1", "asking"], ["modelo#k", "suspended"]]);
  });

  test("suspended on a start, it answers the message its asker moves on from without a word", async () => {
    const modelo = f.flow({ id: "modelo", name: "Modelo", on: [{ message: ["carro"] }], steps: [{ id: "m", collect: ["modelo"] }] });
    const { runner } = setup([lead, modelo], { idle: "silent" });
    const known: Session<Data> = { id: "s1", v: 4, version: 1, data: { nome: "Ana" }, runs: [], claims: {}, inputs: [], metadata: {} };
    const t1 = await drive(runner, message("carro", "m1", { session: known }), { understanding: routedTo("modelo"), speak: () => spoken("Qual modelo?") });
    const t2 = await drive(runner, { sessionId: "s1", context: ai, session: saved(t1.result), start: { flow: "lead", key: "k" } });
    expect(t2.result.session.runs.map((r) => [r.id, r.status])).toEqual([["modelo#m1", "asking"], ["lead#k", "suspended"]]);
    const t3 = await drive(runner, message("um Corolla", "m3", { session: saved(t2.result) }), {
      understanding: understood({ fields: { modelo: "Corolla" } }),
      speak: () => spoken("Anotado, Ana!"),
    });
    expect(isTalk(t3.talk) && t3.talk.run.id).toBe("lead#k");
    expect(t3.result.messages.map((m) => m.key)).toEqual(["lead#k:q:2"]);
  });

  test("a mention flow chaining on the side does not take the routed message from it", async () => {
    const modelo = f.flow({ id: "modelo", name: "Modelo", on: [{ message: ["carro"] }], steps: [{ id: "m", collect: ["modelo"] }] });
    const alerta = f.flow({ id: "alerta", name: "Alerta", on: [{ mention: ["urgente"] }], steps: [{ id: "n", do: "notify", with: {}, then: { flow: "marca" } }] });
    const marca = f.flow({ id: "marca", name: "Marca", steps: [{ id: "t", do: "add_tags", with: { tags: ["urgente"] } }] });
    const { runner, calls } = setup([modelo, lead, alerta, marca]);
    const t1 = await drive(runner, message("carro", "m1"), { understanding: routedTo("modelo"), speak: () => spoken("Qual modelo?") });
    const t2 = await drive(runner, message("quero, é urgente, sou a Ana", "m2", { session: saved(t1.result) }), {
      understanding: understood({ flows: { lead: 90 }, mentions: { alerta: true }, fields: { nome: "Ana" } }),
      speak: () => spoken("Prazer, Ana!"),
    });
    expect(calls.map((c) => c.action)).toEqual(["notify", "notify", "add_tags"]);
    expect(isTalk(t2.talk) && t2.talk.run.id).toBe("lead#m2");
    expect(t2.result.session.runs.map((r) => [r.id, r.status])).toEqual([["modelo#m1", "suspended"], ["lead#m2", "asking"]]);
  });

  test("routed to, it holds the conversation even when its own say was the answer", async () => {
    const modelo = f.flow({ id: "modelo", name: "Modelo", on: [{ message: ["carro"] }], steps: [{ id: "m", collect: ["modelo"] }] });
    const boas = f.flow({
      id: "boas", name: "Boas-vindas", on: [{ message: ["oi"] }], onEnd: "stay",
      steps: [{ id: "b", say: "Olá! Como posso ajudar?", then: "end" }, { id: "p", prompt: "Converse." }],
    });
    const { runner } = setup([modelo, boas]);
    const t1 = await drive(runner, message("carro", "m1"), { understanding: routedTo("modelo"), speak: () => spoken("Qual modelo?") });
    const t2 = await drive(runner, message("oi", "m2", { session: saved(t1.result) }), { understanding: routedTo("boas") });
    expect(t2.talk).toBeNull();
    expect(t2.result.messages.map((m) => m.text)).toEqual(["Olá! Como posso ajudar?"]);
    expect(t2.result.session.runs.map((r) => [r.id, r.status, r.stepId])).toEqual([["modelo#m1", "suspended", "m"], ["boas#m2", "asking", "p"]]);
  });

  test("chained into by a mention beside the asker, it waits suspended: the message stays the asker's", async () => {
    const modelo = f.flow({ id: "modelo", name: "Modelo", on: [{ message: ["carro"] }], steps: [{ id: "m", collect: ["modelo"] }, { id: "n", do: "notify", with: {} }] });
    const alerta = f.flow({ id: "alerta", name: "Alerta", on: [{ mention: ["urgente"] }], steps: [{ id: "t", do: "add_tags", with: {}, then: { flow: "lead" } }] });
    const { runner } = setup([modelo, alerta, lead]);
    const known: Session<Data> = { id: "s1", v: 4, version: 1, data: { nome: "Ana" }, runs: [], claims: {}, inputs: [], metadata: {} };
    const t1 = await drive(runner, message("carro", "m1", { session: known }), { understanding: routedTo("modelo"), speak: () => spoken("Qual modelo?") });
    const t2 = await drive(runner, message("ainda não sei, é urgente", "m2", { session: saved(t1.result) }), {
      understanding: understood({ mentions: { alerta: true } }),
      speak: () => spoken("Sem pressa. Qual modelo?"),
    });
    expect(isTalk(t2.talk) && t2.talk.run.id).toBe("modelo#m1");
    expect(t2.result.session.runs.map((r) => [r.flowId, r.status])).toEqual([["modelo", "asking"], ["lead", "suspended"]]);
  });

  test("a reply that brings the run back to its stay has that step's when branches judged", async () => {
    const seguro = f.flow({
      id: "seguro", name: "Seguro", on: [{ message: ["seguro"] }], onEnd: "stay",
      steps: [
        { id: "s", prompt: "Fale do seguro.", branches: [{ when: "quer falar com um humano", then: "humano" }] },
        { id: "w", wait: "1d", else: "end", then: "lembra" },
        { id: "lembra", say: "Ainda por aí?", then: "end" },
        { id: "humano", do: "notify", with: {}, then: "end" },
      ],
    });
    const { runner, calls } = setup([seguro]);
    const t1 = await drive(runner, message("seguro", "m1"), { understanding: routedTo("seguro"), speak: () => spoken("Temos três planos.") });
    expect(t1.result.session.runs.map((r) => [r.status, r.stepId])).toEqual([["waiting", "w"]]);
    const t2 = await drive(runner, message("quero falar com um humano", "m2", { session: saved(t1.result) }), {
      understanding: understood({ branches: { "seguro#m1/s/0": true } }),
      speak: () => spoken("Já chamo alguém."),
    });
    expect(calls.map((c) => c.key)).toEqual(["seguro#m1:humano:1"]);
    expect(t2.result.messages.map((m) => m.text)).toEqual(["Já chamo alguém."]);
  });

  test("routed to when the asker's own say already answered, it takes the conversation and the asker does not ask again", async () => {
    const pedido = f.flow({
      id: "pedido", name: "Pedido", on: [{ message: ["pedido"] }],
      steps: [{ id: "m", collect: ["modelo"] }, { id: "ok", say: "Anotado!" }, { id: "c", collect: ["confirmado"] }],
    });
    const { runner } = setup([pedido, lead]);
    const known: Session<Data> = { id: "s1", v: 4, version: 1, data: { nome: "Ana" }, runs: [], claims: {}, inputs: [], metadata: {} };
    const t1 = await drive(runner, message("pedido", "m1", { session: known }), { understanding: routedTo("pedido"), speak: () => spoken("Qual modelo?") });
    const t2 = await drive(runner, message("um Corolla. quero falar de seguro", "m2", { session: saved(t1.result) }), {
      understanding: understood({ flows: { lead: 90 }, fields: { modelo: "Corolla" } }),
      speak: () => spoken("Confirma o pedido?"),
    });
    expect(t2.talk).toBeNull();
    expect(t2.result.messages.map((m) => m.text)).toEqual(["Anotado!"]);
    expect(t2.result.session.runs.map((r) => [r.id, r.status])).toEqual([["pedido#m1", "suspended"], ["lead#m2", "asking"]]);
  });

  test("edited from 'stay' to 'end', a staying run ends on the next message", async () => {
    const steps: Flow<Ctx, Data>["steps"] = [{ id: "c", prompt: "Converse." }];
    const v1 = f.flow({ id: "chat", name: "Chat", on: [{ message: ["oi"] }], onEnd: "stay", steps });
    const v2 = f.flow({ id: "chat", name: "Chat", on: [{ message: ["oi"] }], onEnd: "end", steps });
    const t1 = await drive(setup([v1]).runner, message("oi", "m1"), { understanding: routedTo("chat"), speak: () => spoken("Olá!") });
    expect(t1.result.session.runs[0]).toMatchObject({ status: "asking", staying: true });
    const t2 = await drive(setup([v2]).runner, message("e aí", "m2", { session: saved(t1.result) }), { speak: () => spoken("Tudo certo.") });
    expect(t2.result.ended.map((r) => r.reason)).toEqual(["end"]);
    expect(t2.result.session.runs).toEqual([]);
  });

  test("staying with a field still pending, each answer has its own key and max-asks is reported once", async () => {
    const recusa = f.flow({
      id: "lead", name: "Lead", on: [{ message: ["quero"] }], onEnd: "stay",
      steps: [
        { id: "q", collect: ["nome"], maxAsks: 3, branches: [{ when: "não quer dizer o nome", then: "avisa" }] },
        { id: "avisa", do: "notify", with: {}, then: "end" },
      ],
    });
    const { runner } = setup([recusa]);
    const t1 = await drive(runner, message("quero", "m1"), { understanding: routedTo("lead"), speak: () => spoken("Qual seu nome?") });
    const t2 = await drive(runner, message("prefiro não dizer", "m2", { session: saved(t1.result) }), {
      understanding: understood({ branches: { "lead#m1/q/0": true } }),
      speak: () => spoken("Tudo bem! Em que posso ajudar?"),
    });
    const t3 = await drive(runner, message("qual o preço?", "m3", { session: saved(t2.result) }), { speak: () => spoken("R$ 99.") });
    const t4 = await drive(runner, message("e o prazo?", "m4", { session: saved(t3.result) }), { speak: () => spoken("Dois dias.") });
    expect([t2, t3, t4].flatMap((t) => t.result.messages.map((m) => m.key))).toEqual(["lead#m1:q:2", "lead#m1:q:3", "lead#m1:q:4"]);
    expect([t2, t3, t4].map((t) => t.result.outcomes.filter((o) => o.code === "max-asks").length)).toEqual([0, 1, 0]);
    expect(t4.result.session.runs[0]).toMatchObject({ stepId: "q", staying: true, asked: { nome: 3 } });
  });

  test("a stay flow with no talk step ends like 'end'", async () => {
    const tags = f.flow({ id: "tags", name: "Tags", onEnd: "stay", steps: [{ id: "t", do: "add_tags", with: { tags: ["x"] } }] });
    const { runner } = setup([tags]);
    const { result } = await drive(runner, { sessionId: "s1", context: ai, start: { flow: "tags", key: "k" } });
    expect(result.ended.map((r) => r.reason)).toEqual(["end"]);
    expect(result.session.runs).toEqual([]);
  });
});

describe("silenced: the host gate is one mouth", () => {
  const triagem = f.flow({ id: "triagem", name: "Triagem", on: [{ message: ["quer"] }], steps: [{ id: "quem", collect: ["nome"] }, { id: "avisa", do: "notify", with: {} }] });
  const nudge = f.flow({ id: "nudge", name: "Nudge", steps: [{ id: "w", wait: "1h" }, { id: "p", prompt: "Cutuque." }] });
  const tarefa = f.flow({ id: "tarefa", name: "Tarefa", steps: [{ id: "n", do: "notify", with: {} }, { id: "s", say: "Feito." }] });

  test("an asking run stays asking; no request, no talk, zero calls", async () => {
    const { runner } = setup([triagem]);
    const t1 = await drive(runner, message("quer", "m1"), { understanding: routedTo("triagem"), speak: () => spoken("Nome?") });
    const t2 = await drive(runner, message("oi", "m2", { session: saved(t1.result), silenced: "humano no comando" }));
    expect(t2.understood).toBe(false);
    expect(t2.talk).toBeNull();
    expect(t2.result.session.runs[0]).toMatchObject({ id: "triagem#m1", status: "asking", stepId: "quem" });
    expect(t2.result.messages).toEqual([]);
    expect(t2.result.llmCalls).toBe(0);
    expect(t2.result.changed).toBe(true);
  });

  test("silenced: { understand: true } still produces an understand request", async () => {
    const { runner } = setup([triagem]);
    const t1 = await drive(runner, message("quer", "m1"), { understanding: routedTo("triagem"), speak: () => spoken("Nome?") });
    const t2 = await drive(runner, message("oi", "m2", { session: saved(t1.result), silenced: { reason: "humano", understand: true } }));
    expect(t2.understood).toBe(true);
    expect(t2.talk).toBeNull();
  });

  test("a talk step reached by a wake ends silenciado; do steps still run; say does not emit", async () => {
    const { runner, clock, calls } = setup([nudge, tarefa]);
    const t1 = await drive(runner, { sessionId: "s1", context: ai, start: { flow: "nudge", key: "k" } });
    clock.advance("1h");
    const t2 = await drive(runner, { sessionId: "s1", context: ai, session: saved(t1.result), wake: t1.result.schedule[0].key, silenced: "pausa" });
    expect(t2.talk).toBeNull();
    expect(t2.result.ended.map((r) => [r.id, r.reason])).toEqual([["nudge#k", "skipped"]]);
    expect(t2.result.outcomes.at(-1)).toMatchObject({ kind: "prompt", status: "skipped", code: "silenced", detail: "pausa", stepId: "p" });

    const t3 = await drive(runner, { sessionId: "s1", context: ai, session: saved(t2.result), start: { flow: "tarefa", key: "k2" }, silenced: "pausa" });
    expect(calls.map((c) => c.key)).toEqual(["tarefa#k2:n:1"]);
    expect(t3.result.messages).toEqual([]);
    expect(t3.result.outcomes.map((o) => [o.kind, o.status, o.code, o.detail])).toEqual([["do", "ok", undefined, undefined], ["say", "skipped", "silenced", "pausa"]]);
  });
});
