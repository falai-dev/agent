/**
 * S11 — A whole host in thirty lines: MemoryStore for the CAS, an outbox
 * for messages, MemoryScheduler for wakes fired by `due(now)`. The loop is
 * the one docs/rfc/v4-one-flow.md §5 asks every host to run.
 */
import { describe, expect, test } from "bun:test";

import { MemoryScheduler, MemoryStore, SessionConflictError } from "../../src/index.js";
import type { History, OutboundMessage, TurnKind } from "../../src/index.js";
import type { Data } from "./fixture.js";
import { ai, build, retomar, spoken, triagem, understood } from "./fixture.js";

describe("S11: store + scheduler host loop", () => {
  test("messages leave through the outbox after the save; wakes fire from the scheduler; a lost CAS replays", async () => {
    const { agent, clock } = build([triagem, retomar], {
      script: {
        understand: [understood({ flows: { triagem: 90 }, fields: { nome: "Ana" } }), understood({ fields: { empresa: "Zeta" } })],
        speak: [spoken("Oi Ana! De qual empresa?"), spoken("Oi Ana, ainda faz sentido?"), spoken("Ótimo! Quantas pessoas são?")],
      },
    });
    const store = new MemoryStore<Data>();
    const scheduler = new MemoryScheduler();
    const outbox: OutboundMessage[] = [];

    const runTurn = async (input: TurnKind & { sessionId: string; history?: History }): Promise<void> => {
      for (;;) {
        const session = await store.load(input.sessionId);
        const r = await agent.turn({ ...input, context: ai, session: session ?? undefined });
        if (!r.changed) return;
        try {
          await store.save(r.session, session?.version ?? 0);
        } catch (error) {
          if (error instanceof SessionConflictError) continue;
          throw error;
        }
        outbox.push(...r.messages);
        for (const entry of r.schedule) scheduler.add(entry);
        return;
      }
    };
    const fireDue = async (): Promise<number> => {
      const due = scheduler.due(clock.now());
      for (const entry of due) await runTurn({ sessionId: "s1", wake: entry.key, history: [] });
      return due.length;
    };

    await runTurn({ sessionId: "s1", message: "oi, sou a Ana", id: "m1" });
    expect(outbox.map((m) => m.text)).toEqual(["Oi Ana! De qual empresa?"]);
    expect(scheduler.size).toBe(1);
    expect((await store.load("s1"))?.version).toBe(1);

    clock.advance("23h");
    expect(await fireDue()).toBe(0);
    clock.advance("1h");
    expect(await fireDue()).toBe(1);
    expect(outbox.map((m) => m.text)).toEqual(["Oi Ana! De qual empresa?", "Oi Ana, ainda faz sentido?"]);
    // The nudge parked on w1 (2d); the silence flow is once per session, so that is the only wake left.
    expect(scheduler.size).toBe(1);

    await runTurn({ sessionId: "s1", message: "faz sim, é a Zeta", id: "m2" });
    expect(outbox.at(-1)?.text).toBe("Ótimo! Quantas pessoas são?");
    const final = await store.load("s1");
    expect(final?.version).toBe(3);
    expect(final?.data).toEqual({ nome: "Ana", empresa: "Zeta" });
    expect(final?.runs.map((r) => [r.flowId, r.status, r.stepId])).toEqual([["triagem", "asking", "porte"]]);

    // The stale w1 wake fires into a session that no longer waits on it: ignored, nothing saved.
    clock.advance("2d");
    expect(await fireDue()).toBe(1);
    expect((await store.load("s1"))?.version).toBe(3);
    expect(outbox).toHaveLength(3);
    expect(scheduler.size).toBe(0);
  });
});
