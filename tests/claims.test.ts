/**
 * One claims ledger: once / always / cooldown, one active run per (flow,
 * anchor) inside the session and across sessions (`claims.active`), `after`
 * replacement, the hop cap, and I5 (claim and first step in one save).
 */

import { describe, expect, test } from "bun:test";

import { Runner } from "../src/core/Runner.js";
import { OUTCOME_MESSAGES, falai } from "../src/index.js";
import type { Flow, Session, TurnInput } from "../src/index.js";
import { fakeClock } from "../src/utils/clock.js";
import { mockProvider } from "./mock-provider.js";
import { drive, saved } from "./runner-harness.js";

const f = falai().fields({ nome: { type: "string" } });
type Data = { nome: string };

const T0 = "2026-09-20T10:00:00.000Z";

function setup(flows: Flow<undefined, Data>[]) {
  const clock = fakeClock(T0);
  const keys: string[] = [];
  const notify = f.action({
    parameters: {},
    run: (_params, ctx) => {
      keys.push(ctx.key);
      return { ok: true };
    },
  });
  const runner = new Runner<undefined, Data>({
    name: "Ana", provider: mockProvider(), fields: f.fields, actions: { notify }, events: { ping: f.event(), stage_entered: f.event<{ stageId: string }>() }, flows, clock,
  });
  return { runner, clock, keys };
}

const message = (id: string, extra: Partial<TurnInput<undefined, Data>> = {}): TurnInput<undefined, Data> => ({ sessionId: "s1", message: "oi", id, ...extra });
const event = (key: string, extra: Partial<TurnInput<undefined, Data>> = {}): TurnInput<undefined, Data> => ({ sessionId: "s1", event: "ping", key, ...extra });

describe("repeat", () => {
  const detector = (repeat: Flow<undefined, Data>["on"] extends Array<infer T> | undefined ? (T extends { repeat?: infer R } ? R : never) : never) =>
    f.flow({ id: "promo", name: "Promo", on: [{ mention: [], repeat }], steps: [{ id: "n", do: "notify" }] });

  test("once: the second message is skipped; the claim is written in the same turn as the first step (I5)", async () => {
    const { runner, keys } = setup([detector("once")]);
    const t1 = await drive(runner, message("m1"));
    expect(t1.result.started[0].dedupeKey).toBe("promo:s1:");
    expect(t1.result.session.claims).toEqual({ "promo:s1:": { at: T0 } });
    expect(keys).toEqual(["promo#m1:n:1"]);
    const t2 = await drive(runner, message("m2", { session: saved(t1.result) }));
    expect(t2.result.started).toEqual([]);
    expect(t2.result.skipped).toEqual([{ flowId: "promo", anchor: "s1", triggerKey: "m2", code: "already-claimed", message: OUTCOME_MESSAGES["already-claimed"] }]);
    expect(keys).toHaveLength(1);
  });

  test("always: every message starts a run under its own key; a replayed event key does not", async () => {
    const { runner } = setup([detector("always"), f.flow({ id: "ev", name: "Ev", on: [{ event: "ping" }], steps: [{ id: "n", do: "notify" }] })]);
    const t1 = await drive(runner, message("m1"));
    const t2 = await drive(runner, message("m2", { session: saved(t1.result) }));
    expect(t2.result.started.map((s) => s.dedupeKey)).toEqual(["promo:s1:m2"]);
    expect(Object.keys(t2.result.session.claims)).toEqual(["promo:s1:m1", "promo:s1:m2"]);
    const e1 = await drive(runner, event("e1", { session: saved(t2.result) }));
    expect(e1.result.started.map((s) => s.runId)).toEqual(["ev#e1"]);
    const e1again = await drive(runner, event("e1", { session: saved(e1.result) }));
    expect(e1again.result.skipped.map((s) => s.code)).toEqual(["already-claimed"]);
  });

  test("always keeps the last 50 claims per flow and anchor", async () => {
    const { runner } = setup([f.flow({ id: "ev", name: "Ev", on: [{ event: "ping" }], steps: [{ id: "n", do: "notify" }] })]);
    let session: Session<Data> | undefined;
    for (let i = 0; i < 55; i++) {
      const { result } = await drive(runner, event(`e${i}`, { session }));
      session = saved(result);
    }
    const claims = Object.keys(session?.claims ?? {});
    expect(claims).toHaveLength(50);
    expect(claims[0]).toBe("ev:s1:e5");
    expect(claims.at(-1)).toBe("ev:s1:e54");
  });

  test("cooldown: blocked inside the window, overwritten after it", async () => {
    const { runner, clock } = setup([detector({ cooldown: "1h" })]);
    const t1 = await drive(runner, message("m1"));
    clock.advance("10m");
    const t2 = await drive(runner, message("m2", { session: saved(t1.result) }));
    expect(t2.result.skipped.map((s) => s.code)).toEqual(["cooldown"]);
    clock.advance("50m");
    const t3 = await drive(runner, message("m3", { session: saved(t2.result) }));
    expect(t3.result.started.map((s) => s.runId)).toEqual(["promo#m3"]);
    expect(t3.result.session.claims["promo:s1:"]).toEqual({ at: clock.now().toISOString() });
  });

  test("claims held in the lead's other sessions block a once flow anchored on the lead", async () => {
    const lead = f.flow({ id: "promo", name: "Promo", anchor: "lead", on: [{ mention: [] }], steps: [{ id: "n", do: "notify" }] });
    const { runner } = setup([lead]);
    const held = await drive(runner, message("m1", { anchors: { lead: { key: "lead:456" } }, claims: { held: { "promo:lead:456:": T0 }, active: [] } }));
    expect(held.result.skipped).toEqual([{ flowId: "promo", anchor: "lead:456", triggerKey: "m1", code: "already-claimed", message: OUTCOME_MESSAGES["already-claimed"] }]);
    const fresh = await drive(runner, message("m1", { anchors: { lead: { key: "lead:456" } } }));
    expect(fresh.result.started[0]).toMatchObject({ anchor: "lead:456", dedupeKey: "promo:lead:456:" });
    // A named anchor the host did not pass falls back to the session id.
    const fallback = await drive(runner, message("m1"));
    expect(fallback.result.started[0]).toMatchObject({ anchor: "s1", dedupeKey: "promo:s1:" });
  });
});

describe("one active run per (flow, anchor)", () => {
  const agenda = f.flow({ id: "agenda", name: "Agenda", on: [{ event: "ping" }], steps: [{ id: "w", wait: "1d" }, { id: "n", do: "notify" }] });

  test("a live run in the session blocks a second start", async () => {
    const { runner } = setup([agenda]);
    const t1 = await drive(runner, event("e1"));
    expect(t1.result.session.runs.map((r) => r.status)).toEqual(["waiting"]);
    const t2 = await drive(runner, event("e2", { session: saved(t1.result) }));
    expect(t2.result.skipped).toEqual([{ flowId: "agenda", anchor: "s1", triggerKey: "e2", code: "already-running", message: OUTCOME_MESSAGES["already-running"] }]);
    expect(t2.result.session.runs).toHaveLength(1);
  });

  test("a live run in another session (claims.active) blocks it too", async () => {
    const { runner } = setup([agenda]);
    const { result } = await drive(runner, event("e1", { claims: { held: {}, active: ["agenda:s1"] } }));
    expect(result.skipped.map((s) => s.code)).toEqual(["already-running"]);
    expect(result.changed).toBe(true); // the skip line still reaches the host's log
  });

  test("a run still parked on its own `after` timer is replaced; its job self-skips", async () => {
    const noshow = f.flow({
      id: "noshow", name: "No-show",
      on: [{ event: "stage_entered", if: ({ input }) => (input as { stageId: string }).stageId === "nao-compareceu", after: "1h" }],
      steps: [{ id: "n", do: "notify" }],
    });
    const { runner, clock, keys } = setup([noshow]);
    const e1 = await drive(runner, { sessionId: "s1", event: "stage_entered", payload: { stageId: "nao-compareceu" }, key: "stage:1" });
    expect(e1.result.session.runs[0]).toMatchObject({ id: "noshow#stage:1", status: "waiting", stepId: null, input: { stageId: "nao-compareceu" } });
    expect(e1.result.schedule[0].key).toBe(`noshow#stage:1:start:${clock.now().getTime() + 3_600_000}`);
    const firstWake = e1.result.schedule[0].key;
    clock.advance("30m");
    const e2 = await drive(runner, { sessionId: "s1", session: saved(e1.result), event: "stage_entered", payload: { stageId: "nao-compareceu" }, key: "stage:2" });
    expect(e2.result.ended.map((r) => [r.id, r.reason])).toEqual([["noshow#stage:1", "replaced"]]);
    expect(e2.result.started.map((s) => s.runId)).toEqual(["noshow#stage:2"]);
    const wrongStage = await drive(runner, { sessionId: "s1", session: saved(e2.result), event: "stage_entered", payload: { stageId: "proposta" }, key: "stage:3" });
    expect(wrongStage.result.started).toEqual([]);
    clock.advance("30m");
    const stale = await drive(runner, { sessionId: "s1", session: saved(e2.result), wake: firstWake });
    expect(stale.result.changed).toBe(false);
    clock.advance("30m");
    const fire = await drive(runner, { sessionId: "s1", session: saved(e2.result), wake: e2.result.schedule[0].key });
    expect(keys).toEqual(["noshow#stage:2:n:1"]);
    expect(fire.result.ended.map((r) => r.reason)).toEqual(["end"]);
  });
});

describe("hop cap", () => {
  const a = f.flow({ id: "a", name: "A", steps: [{ id: "n", do: "notify", then: { flow: "b" } }] });
  const b = f.flow({ id: "b", name: "B", steps: [{ id: "n", do: "notify" }] });

  test("a start at hop 5 is skipped; a chain that crosses the cap stops at the child", async () => {
    const { runner, keys } = setup([a, b]);
    const capped = await drive(runner, { sessionId: "s1", start: { flow: "a", key: "k", hop: 5 } });
    expect(capped.result.skipped).toEqual([{ flowId: "a", anchor: "s1", triggerKey: "k", code: "hop-limit", message: OUTCOME_MESSAGES["hop-limit"] }]);
    const chain = await drive(runner, { sessionId: "s1", start: { flow: "a", key: "k", hop: 4 } });
    expect(keys).toEqual(["a#k:n:1"]);
    expect(chain.result.ended.map((r) => [r.id, r.reason])).toEqual([["a#k", "flow"]]);
    expect(chain.result.skipped).toEqual([{ flowId: "b", anchor: "s1", triggerKey: "a#k:n:1", code: "hop-limit", message: OUTCOME_MESSAGES["hop-limit"] }]);
    const ok = await drive(runner, { sessionId: "s1", start: { flow: "a", key: "k2" } });
    expect(ok.result.started.map((s) => [s.runId, s.dedupeKey])).toEqual([["a#k2", "a:s1:k2"], ["b#a#k2:n:1", "b:s1:a#k2:n:1"]]);
    expect(ok.result.session.runs).toEqual([]);
    expect(keys.slice(1)).toEqual(["a#k2:n:1", "b#a#k2:n:1:n:1"]);
  });
});
