/**
 * S10 with version numbers (design §8): the silence wake wins v7→v8, the
 * concurrent lead text loses, replays on v8 and takes `w1.else`; the stale
 * W2 wake and a broken silence premise are ignored with `changed: false`.
 */

import { OUTCOME_MESSAGES } from "../src/index.js";
import { describe, expect, test } from "bun:test";

import { Runner } from "../src/core/Runner.js";
import { falai } from "../src/index.js";
import type { Session, TurnInput } from "../src/index.js";
import { fakeClock } from "../src/utils/clock.js";
import { parseDuration } from "../src/utils/duration.js";
import { mockProvider } from "./mock-provider.js";
import { drive, isTalk, saved, spoken, understood } from "./runner-harness.js";

interface Ctx {
  lead: { owner: "ai" | "human" };
}

const f = falai<Ctx>().fields({ nome: { type: "string", ask: "Pergunte o nome." } });
type Data = { nome: string };

const triagem = f.flow({
  id: "triagem", name: "Triagem",
  on: [{ message: ["quer saber como funciona"] }],
  steps: [{ id: "quem", collect: ["nome"] }],
});

const retomar = f.flow({
  id: "retomar", name: "Retomar quem sumiu",
  on: [{ silence: "24h", if: ({ context }) => context.lead.owner === "ai" }],
  steps: [
    { id: "gate", if: { silenced: true }, then: "lembra", else: "p1" },
    { id: "p1", prompt: "Retome a conversa de forma leve." },
    { id: "w1", wait: "2d", else: "end" },
    { id: "p2", prompt: "Última tentativa." },
    { id: "w2", wait: "3d", else: "end" },
    { id: "n1", do: "notify", with: { message: "{{data.nome}} não respondeu." }, then: "end" },
    { id: "lembra", do: "notify", with: { message: "Hora do follow-up." } },
  ],
});

const T0 = "2026-09-20T10:00:00.000Z";
const ai: Ctx = { lead: { owner: "ai" } };

function setup() {
  const clock = fakeClock(T0);
  const notified: string[] = [];
  const notify = f.action({
    parameters: { message: { type: "string" } },
    run: (params) => {
      notified.push(params.message);
      return { ok: true };
    },
  });
  const runner = new Runner<Ctx, Data>({ name: "Ana", provider: mockProvider(), fields: f.fields, actions: { notify }, flows: [triagem, retomar], clock });
  return { runner, clock, notified };
}

const at = (iso: string, plus: string): Date => new Date(Date.parse(iso) + parseDuration(plus));
const withVersion = <D>(session: Session<D>, version: number): Session<D> => ({ ...session, version });

describe("S10: wakes, versions and replays", () => {
  test("the walkthrough", async () => {
    const { runner, clock } = setup();

    // v0 → v7: the lead opens triage, the assistant asks the name, a silence wake is armed.
    const t0 = await drive(runner, { sessionId: "s1", context: ai, message: "quer saber como funciona", id: "m1" }, {
      understanding: understood({ flows: { triagem: 90 } }), speak: () => spoken("Qual é o seu nome?"),
    });
    expect(t0.result.session.runs.map((r) => [r.id, r.status])).toEqual([["triagem#m1", "asking"]]);
    const T0ms = Date.parse(T0);
    const W1 = `silence:retomar:s1:${T0ms}`;
    expect(t0.result.schedule).toEqual([{ key: W1, at: at(T0, "24h") }]);
    expect(t0.result.session.lastAssistantAt).toBe(T0);
    const v7 = withVersion(t0.result.session, 7);

    // W1 fires on v7: premise holds, retomar starts and speaks first, w1 parks and schedules W2. Saved as v8.
    clock.advance("24h");
    const T1 = clock.now().toISOString();
    const wakeInput: TurnInput<Ctx, Data> = { sessionId: "s1", context: ai, session: v7, wake: W1, history: [] };
    const tw = await drive(runner, wakeInput, { speak: () => spoken("Oi! Ainda faz sentido conversarmos?") });
    expect(tw.result.changed).toBe(true);
    expect(tw.result.llmCalls).toBe(0);
    expect(tw.result.started.map((s) => s.flowId)).toEqual(["retomar"]);
    expect(isTalk(tw.talk) && tw.talk.step.id).toBe("p1");
    expect(tw.result.messages).toEqual([{ text: "Oi! Ainda faz sentido conversarmos?", kind: "ai", afterMs: 0, key: `retomar#${T0ms}:p1:1`, runId: `retomar#${T0ms}`, stepId: "p1" }]);
    const W2 = `retomar#${T0ms}:w1:${at(T1, "2d").getTime()}`;
    expect(tw.result.schedule).toEqual([{ key: W2, at: at(T1, "2d") }]);
    expect(tw.result.outcomes.map((o) => [o.stepId, o.kind, o.status])).toEqual([["gate", "if", "ok"], ["p1", "prompt", "ok"], ["w1", "wait", "waiting"]]);
    // Triage was suspended for the nudge and is back to asking now that nobody asks.
    expect(tw.result.session.runs.map((r) => [r.id, r.status])).toEqual([["triagem#m1", "asking"], [`retomar#${T0ms}`, "waiting"]]);
    expect(tw.result.session.lastAssistantAt).toBe(T1);
    // Replaying the same wake from the same version is deterministic.
    const again = await drive(runner, wakeInput, { speak: () => spoken("Oi! Ainda faz sentido conversarmos?") });
    expect(again.result).toEqual(tw.result);
    const v8 = withVersion(tw.result.session, 8);

    // The lead's text (m9) landed concurrently against v7: its save fails and the result is discarded.
    clock.advance("2s");
    const T2 = clock.now().toISOString();
    const text = { sessionId: "s1", context: ai, message: "oi, ainda tô aqui", id: "m9", at: T2 };
    const lost = await drive(runner, { ...text, session: v7 }, { understanding: understood(), speak: () => spoken("Legal! E o seu nome?") });
    expect(lost.result.started).toEqual([]);
    expect(lost.result.session.runs).toHaveLength(1); // it never saw retomar; the host throws SessionConflictError and replays

    // Replay on v8: the reply takes w1.else, retomar ends, triage keeps the floor and asks again.
    const replay = await drive(runner, { ...text, session: v8 }, { understanding: understood(), speak: () => spoken("Legal! E o seu nome?") });
    expect(replay.result.ended.map((r) => [r.flowId, r.reason])).toEqual([["retomar", "end"]]);
    expect(replay.result.outcomes[0]).toMatchObject({ runId: `retomar#${T0ms}`, stepId: "w1", kind: "wait", status: "ok", code: "replied", next: "end" });
    expect(isTalk(replay.talk) && replay.talk.run.id).toBe("triagem#m1");
    expect(replay.result.messages.map((m) => m.key)).toEqual(["triagem#m1:quem:1"]);
    expect(replay.result.session.runs.map((r) => [r.id, r.status, r.asked])).toEqual([["triagem#m1", "asking", { nome: 2 }]]);
    expect(replay.result.schedule).toEqual([]); // retomar is `once`: no new silence wake
    expect(replay.result.session.lastUserAt).toBe(T2);
    const v9 = withVersion(replay.result.session, 9);

    // W2 fires later: no run waits on it any more.
    clock.advance("2d");
    const stale = await drive(runner, { sessionId: "s1", context: ai, session: v9, wake: W2 });
    expect(stale.result.changed).toBe(false);
    expect(stale.result.outcomes).toEqual([{ kind: "wait", status: "skipped", code: "stale-wake", message: OUTCOME_MESSAGES["stale-wake"], key: W2, at: clock.now().toISOString() }]);
    expect(stale.result.session).toEqual(v9);

    // A silence wake whose premise broke (the lead wrote after the assistant) is ignored too.
    const broken = await drive(runner, { sessionId: "s1", context: ai, session: v9, wake: `silence:retomar:s1:${Date.parse(T1)}` });
    expect(broken.result.changed).toBe(false);
    expect(broken.result.outcomes.map((o) => o.code)).toEqual(["silence-broken"]);
  });

  test("had the text arrived first, the wake finds lastUserAt > setAt and takes w1.else: no nudge", async () => {
    const { runner, clock } = setup();
    const t0 = await drive(runner, { sessionId: "s1", context: ai, message: "quer saber como funciona", id: "m1" }, { understanding: understood(), speak: () => spoken("Nome?") });
    clock.advance("24h");
    const tw = await drive(runner, { sessionId: "s1", context: ai, session: saved(t0.result), wake: t0.result.schedule[0].key }, { speak: () => spoken("Ainda aí?") });
    const W2 = tw.result.schedule[0].key;
    clock.advance("1h");
    const reply = await drive(runner, { sessionId: "s1", context: ai, session: saved(tw.result), message: "sim", id: "m2" }, { understanding: understood(), speak: () => spoken("Nome?") });
    // The reply already ended retomar in Ingest, so W2 is stale when it fires…
    clock.advance("2d");
    const stale = await drive(runner, { sessionId: "s1", context: ai, session: saved(reply.result), wake: W2 });
    expect(stale.result.changed).toBe(false);
    // …and had the reply not been turned yet, the wake itself sees the newer lastUserAt and takes else.
    const raced = { ...saved(tw.result), lastUserAt: clock.now().toISOString() };
    const wake = await drive(runner, { sessionId: "s1", context: ai, session: raced, wake: W2 });
    expect(wake.result.ended.map((r) => [r.flowId, r.reason])).toEqual([["retomar", "end"]]);
    expect(wake.result.outcomes[0]).toMatchObject({ stepId: "w1", code: "replied", next: "end" });
    expect(wake.result.messages).toEqual([]);
  });

  test("a wake with no session and a wake under silenced", async () => {
    const { runner, clock, notified } = setup();
    const none = await drive(runner, { sessionId: "s1", context: ai, wake: "silence:retomar:s1:1" });
    expect(none.result.changed).toBe(false);
    expect(none.result.outcomes.map((o) => o.code)).toEqual(["no-session"]);

    // Human owns the lead: the gate routes to `lembra`, the seller is notified, zero messages.
    const t0 = await drive(runner, { sessionId: "s1", context: ai, message: "quer saber como funciona", id: "m1" }, { understanding: understood(), speak: () => spoken("Nome?") });
    clock.advance("24h");
    const tw = await drive(runner, { sessionId: "s1", context: ai, session: saved(t0.result), wake: t0.result.schedule[0].key, silenced: "humano no comando" });
    expect(tw.talk).toBeNull();
    expect(notified).toEqual(["Hora do follow-up."]);
    expect(tw.result.ended.map((r) => [r.flowId, r.reason])).toEqual([["retomar", "end"]]);
    expect(tw.result.messages).toEqual([]);
    expect(tw.result.llmCalls).toBe(0);
  });

  test("the silence wake is not armed while the trigger if fails, and a new lastAssistantAt replaces the previous key", async () => {
    const { runner, clock } = setup();
    const human: Ctx = { lead: { owner: "human" } };
    const t0 = await drive(runner, { sessionId: "s1", context: human, message: "quer saber como funciona", id: "m1" }, { understanding: understood(), speak: () => spoken("Nome?") });
    expect(t0.result.schedule).toEqual([]);

    const always = f.flow({ id: "cutuca", name: "Cutuca", on: [{ silence: "1h", repeat: "always" }], steps: [{ id: "p", prompt: "Oi?" }] });
    const r2 = new Runner<Ctx, Data>({ name: "Ana", provider: mockProvider(), fields: f.fields, flows: [triagem, always], clock });
    const a = await drive(r2, { sessionId: "s1", context: ai, message: "quer saber como funciona", id: "m1" }, { understanding: understood(), speak: () => spoken("Nome?") });
    const first = a.result.schedule[0];
    clock.advance("10m");
    const b = await drive(r2, { sessionId: "s1", context: ai, session: saved(a.result), message: "hã?", id: "m2" }, { understanding: understood(), speak: () => spoken("Seu nome?") });
    expect(b.result.schedule).toEqual([{ key: `silence:cutuca:s1:${clock.now().getTime()}`, at: at(clock.now().toISOString(), "1h"), replaces: first.key }]);
  });

  test("a flow id and a session id with a colon still get their silence wake", async () => {
    // The key is `silence:<flowId>:<sessionId>:<ms>`; splitting at the first ":" read the flow as "follow".
    const clock = fakeClock(T0);
    const followUp = f.flow({ id: "follow:up", name: "Follow up", on: [{ silence: "1h" }], steps: [{ id: "p", prompt: "Oi?" }] });
    const runner = new Runner<Ctx, Data>({ name: "Ana", provider: mockProvider(), fields: f.fields, flows: [triagem, followUp], clock });
    const t0 = await drive(runner, { sessionId: "wa:5511", context: ai, message: "quer saber como funciona", id: "m1" }, { understanding: understood(), speak: () => spoken("Nome?") });
    const wake = t0.result.schedule[0];
    expect(wake.key).toBe(`silence:follow:up:wa:5511:${Date.parse(T0)}`);
    clock.advance("1h");
    const tw = await drive(runner, { sessionId: "wa:5511", context: ai, session: saved(t0.result), wake: wake.key }, { speak: () => spoken("Ainda aí?") });
    expect(tw.result.skipped).toEqual([]);
    expect(tw.result.started.map((s) => s.flowId)).toEqual(["follow:up"]);
  });
});

describe("pendingWakes: what a saved session waits on", () => {
  const strip = (entries: { key: string; at: Date; replaces?: string }[]) => entries.map(({ key, at: when }) => ({ key, at: when }));

  test("after each turn it is that turn's schedule, less what the turn replaced", async () => {
    const { runner, clock } = setup();
    const t0 = await drive(runner, { sessionId: "s1", context: ai, message: "quer saber como funciona", id: "m1" }, { understanding: understood(), speak: () => spoken("Nome?") });
    expect(runner.pendingWakes({ session: saved(t0.result), context: ai })).toEqual(strip(t0.result.schedule));

    // The silence wake fired: retomar spoke and parked on w1. Its claim holds, so the new silence arms nothing.
    clock.advance("24h");
    const tw = await drive(runner, { sessionId: "s1", context: ai, session: saved(t0.result), wake: t0.result.schedule[0].key }, { speak: () => spoken("Ainda aí?") });
    expect(runner.pendingWakes({ session: saved(tw.result), context: ai })).toEqual(strip(tw.result.schedule));
    expect(tw.result.schedule).toHaveLength(1);
  });

  test("a lifted session no turn has armed: silence counts from lastAssistantAt, and only while the lead has not written since", () => {
    const { runner } = setup();
    const quiet: Session<Data> = { id: "s1", v: 4, version: 3, data: {}, runs: [], claims: {}, inputs: [], metadata: {}, lastAssistantAt: T0 };
    expect(runner.pendingWakes({ session: quiet, context: ai })).toEqual([{ key: `silence:retomar:s1:${Date.parse(T0)}`, at: at(T0, "24h") }]);

    const answered = { ...quiet, lastUserAt: at(T0, "1m").toISOString() };
    expect(runner.pendingWakes({ session: answered, context: ai })).toEqual([]);
    // The trigger's `if` still decides: a human owns this lead.
    expect(runner.pendingWakes({ session: quiet, context: { lead: { owner: "human" } } })).toEqual([]);
    // A `once` flow whose claim is held, here by another session of the lead, arms nothing.
    expect(runner.pendingWakes({ session: quiet, context: ai, claims: { held: { "retomar:s1:": T0 }, active: [] } })).toEqual([]);
  });
});
