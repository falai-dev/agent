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
import type { ActionResult, Flow, Run, Session, TurnInput } from "../src/index.js";
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
