/**
 * Two invariants of `advance()` over random small flows and sessions:
 * at most one run asks after a turn (a talk step from another run suspends
 * the asker, never sits beside it), and a run whose `while` is false never
 * moves: it ends `pulado: premissa mudou` with nothing else on its account.
 */

import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { Runner } from "../src/core/Runner.js";
import { falai } from "../src/index.js";
import type { Flow, Next, Run, RunStatus, Session, Step } from "../src/index.js";
import { fakeClock } from "../src/utils/clock.js";
import { mockProvider } from "./mock-provider.js";
import { drive, isTalk } from "./runner-harness.js";

const f = falai().fields({ a: { type: "string" } });
type Data = { a: string };
const T0 = "2026-09-20T10:00:00.000Z";

const ids = ["s0", "s1", "s2", "s3"];
const targetArb: fc.Arbitrary<Next<Data> | undefined> = fc.option(fc.constantFrom<Next<Data>>(...ids, "end"), { nil: undefined });

const stepArb = (id: string): fc.Arbitrary<Step<undefined, Data>> =>
  fc.oneof(
    fc.record({ id: fc.constant(id), say: fc.constant("oi"), then: targetArb }),
    fc.record({ id: fc.constant(id), do: fc.constant("noop"), then: targetArb }),
    fc.record({ id: fc.constant(id), if: fc.boolean().map((b) => () => b), then: targetArb, else: targetArb }),
    fc.record({ id: fc.constant(id), collect: fc.constant(["a"] as ("a")[]), then: targetArb }),
    fc.record({ id: fc.constant(id), prompt: fc.constant("fale"), then: targetArb }),
    fc.record({ id: fc.constant(id), wait: fc.constantFrom("3s" as const, "1d" as const), then: targetArb }),
  );

interface Spec {
  flowId: string;
  steps: Step<undefined, Data>[];
  onEnd: "end" | "stay" | "reset";
  whileFalse: boolean;
  run?: { status: RunStatus; stepIndex: number | null };
}

const specArb = (flowId: string): fc.Arbitrary<Spec> =>
  fc.record({
    flowId: fc.constant(flowId),
    steps: fc.integer({ min: 1, max: ids.length }).chain((n) => fc.tuple(...ids.slice(0, n).map(stepArb))),
    onEnd: fc.constantFrom("end" as const, "stay" as const, "reset" as const),
    whileFalse: fc.boolean(),
    run: fc.option(
      fc.record({ status: fc.constantFrom<RunStatus>("running", "asking", "suspended"), stepIndex: fc.option(fc.integer({ min: 0, max: ids.length - 1 }), { nil: null }) }),
      { nil: undefined },
    ),
  });

const worldArb = fc.tuple(specArb("fa"), specArb("fb"), specArb("fc"));
/** A message, or a start of one of the flows: a turn with no fresh text, where no asker speaks. */
const inputArb = fc.option(fc.constantFrom("fa", "fb", "fc"), { nil: undefined });

function build(specs: Spec[]) {
  const flows: Flow<undefined, Data>[] = specs.map((s) => ({
    id: s.flowId, name: s.flowId, steps: s.steps, onEnd: s.onEnd, ...(s.whileFalse ? { while: () => false } : {}),
  }));
  const runs: Run[] = [];
  let askers = 0;
  for (const s of specs) {
    if (!s.run) continue;
    let status = s.run.status;
    if (status === "asking" && askers++ > 0) status = "suspended";
    const stepId = s.run.stepIndex === null ? null : (s.steps[s.run.stepIndex] ?? s.steps[0]).id;
    runs.push({
      id: `${s.flowId}#k`, flowId: s.flowId, anchor: "s1", dedupeKey: `${s.flowId}:s1:k`, stepId: status === "running" ? stepId : (stepId ?? s.steps[0].id), status,
      trigger: { kind: "start", key: "k" }, hop: 0, startedAt: T0, asked: {}, visits: {}, outcomes: [],
    });
  }
  const session: Session<Data> = { id: "s1", v: 4, version: 1, data: {}, runs, claims: {}, inputs: [], metadata: {} };
  const moved: string[] = [];
  const noop = f.action({ parameters: {}, run: (_p, ctx) => { moved.push(ctx.run.id); return { ok: true }; } });
  const runner = new Runner<undefined, Data>({ name: "Ana", provider: mockProvider(), fields: f.fields, actions: { noop }, flows, clock: fakeClock(T0) });
  return { runner, session, moved, flows };
}

describe("advance() invariants", () => {
  test("at most one asker, and a run whose while is false never moves", async () => {
    await fc.assert(
      fc.asyncProperty(worldArb, inputArb, async (specs, start) => {
        const { runner, session, moved } = build(specs);
        const { result, talk } = await drive(runner, start
          ? { sessionId: "s1", session, start: { flow: start, key: "k2" } }
          : { sessionId: "s1", session, message: "oi", id: "m1" });

        const asking = result.session.runs.filter((r) => r.status === "asking");
        expect(asking.length).toBeLessThanOrEqual(1);
        if (isTalk(talk)) {
          expect(asking.map((r) => r.id)).toEqual([talk.run.id]);
          expect(result.session.runs.filter((r) => r.id !== talk.run.id).every((r) => r.status !== "asking")).toBe(true);
        }

        // `session` is the input blob, untouched by the turn: it still shows every run's starting status.
        for (const run of session.runs) {
          if (!specs.find((s) => s.flowId === run.flowId)?.whileFalse) continue;
          const still = result.session.runs.find((r) => r.id === run.id);
          const lines = result.outcomes.filter((o) => o.runId === run.id);
          if (still) {
            // A suspended run was never about to move; at most it was resumed to asking for the next message.
            expect(still.stepId).toBe(run.stepId);
            expect(still.visits).toEqual(run.visits);
            expect(lines).toEqual([]);
          } else {
            expect(result.ended.find((r) => r.id === run.id)?.reason).toBe("skipped");
            expect(lines.map((o) => o.code)).toEqual(["premise-changed"]);
          }
          expect(moved).not.toContain(run.id);
          expect(result.messages.some((m) => m.runId === run.id)).toBe(false);
        }
        expect(result.llmCalls).toBe(0);
      }),
      { numRuns: 400 },
    );
  });
});
