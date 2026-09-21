/**
 * `migrateSession`: a 3.x blob becomes one v4 session with the same cursor
 * and every once-signal carried as a claim; a v4 blob passes through; a row
 * that is neither throws `InvalidSessionError` and never becomes a fresh
 * conversation. Fixtures under tests/fixtures/blobs are synthetic 3.x shapes
 * (design §10) until Phase D swaps in anonymised real rows.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { InvalidSessionError, migrateSession } from "../src/core/Migrate.js";
import { MemoryStore } from "../src/persistence/MemoryStore.js";
import type { Session } from "../src/types/session.js";

type Blob = Record<string, unknown>;

function fixture(name: string): Blob {
  return JSON.parse(readFileSync(new URL(`./fixtures/blobs/${name}.json`, import.meta.url), "utf8")) as Blob;
}

const identity = (key: string): string => key;
const NOW = new Date("2026-09-21T12:00:00.000Z");

describe("migrateSession: 3.x blobs", () => {
  test("prospectar mid-flow: one asking run at the same step, the completed flow claimed", () => {
    const blob = fixture("prospectar-midflow");
    const sid = blob.id as string;
    const session = migrateSession(blob, { sessionId: sid, flowIdOf: identity, now: NOW });

    expect(session).toEqual({
      id: sid,
      v: 4,
      version: 0,
      data: blob.data as Session["data"],
      runs: [
        {
          id: "qualificacao#legacy",
          flowId: "qualificacao",
          anchor: sid,
          dedupeKey: `qualificacao:${sid}:`,
          stepId: "ask_budget",
          status: "asking",
          trigger: { kind: "message", key: "legacy" },
          hop: 0,
          startedAt: "2026-09-01T13:05:12.000Z",
          asked: {},
          visits: {},
          outcomes: [],
        },
      ],
      claims: {
        [`boas_vindas:${sid}:`]: { at: "2026-09-01T13:05:12.000Z" },
        [`qualificacao:${sid}:`]: { at: "2026-09-01T13:05:12.000Z" },
      },
      inputs: [],
      metadata: blob.metadata as Session["metadata"],
    });
    expect(session).not.toHaveProperty("history");
    // Data is the same object, not a copy with coerced values.
    expect<unknown>(session.data).toBe(blob.data);
  });

  test("ilojista signals: once-fired signals and the cooldown one become claims; pendingDirective is dropped", () => {
    const blob = fixture("ilojista-signals");
    const sid = blob.id as string;
    const session = migrateSession(blob, { sessionId: sid, flowIdOf: identity, now: NOW });

    expect(session.runs).toHaveLength(1);
    expect(session.runs[0]).toMatchObject({
      id: "atendimento_pedido#legacy",
      flowId: "atendimento_pedido",
      stepId: "confirmar_endereco",
      status: "asking",
      startedAt: "2026-09-03T15:20:05.000Z",
    });
    expect(session.claims).toEqual({
      [`not_interested_detection:${sid}:`]: { at: "2026-09-03T15:21:10.000Z" },
      [`pediu_preco:${sid}:`]: { at: "2026-09-03T15:22:02.000Z" },
      [`bot_detected:${sid}:`]: { at: "2026-09-03T15:23:15.000Z" },
      // Cooldown: the claim carries the LAST firing, which is what the interval check reads.
      [`lembrete_carrinho:${sid}:`]: { at: "2026-09-03T15:24:00.000Z" },
      [`atendimento_pedido:${sid}:`]: { at: "2026-09-03T15:20:05.000Z" },
    });
    // The legacy row version is not carried: the first save into a v4 store is an insert.
    expect(session.version).toBe(0);
    expect(session.data).toEqual(blob.data as Session["data"]);
    expect(JSON.stringify(session)).not.toContain("pendingDirective");
    expect(JSON.stringify(session)).not.toContain("pagamento");
  });

  test("flowIdOf renames signal keys and flow ids into their v4 flow ids", () => {
    const blob = fixture("ilojista-signals");
    const sid = blob.id as string;
    const renamed: Record<string, string> = { pediu_preco: "preco", atendimento_pedido: "pedido" };
    const session = migrateSession(blob, { sessionId: sid, flowIdOf: (key) => renamed[key] ?? key, now: NOW });
    expect(session.runs[0].id).toBe("pedido#legacy");
    expect(session.runs[0].flowId).toBe("pedido");
    expect(session.runs[0].dedupeKey).toBe(`pedido:${sid}:`);
    expect(Object.keys(session.claims).sort()).toEqual(
      [`bot_detected:${sid}:`, `lembrete_carrinho:${sid}:`, `not_interested_detection:${sid}:`, `pedido:${sid}:`, `preco:${sid}:`].sort(),
    );
  });

  test("Date instances (a deserialised SessionState) become ISO text everywhere", () => {
    const entered = new Date("2026-09-10T09:00:00.000Z");
    const blob = {
      id: "s1",
      currentFlow: { id: "f", title: "F", enteredAt: entered },
      currentStep: { id: "s", enteredAt: new Date("2026-09-10T09:01:00.000Z") },
      data: { nome: "Ana" },
      flowHistory: [{ flowId: "g", enteredAt: entered, exitedAt: new Date("2026-09-10T09:00:30.000Z"), completed: true }],
      signals: { triggers: { sig: { firstTriggeredAt: entered, lastTriggeredAt: new Date("2026-09-10T09:02:00.000Z"), count: 2 } } },
      metadata: { createdAt: entered, lastUpdatedAt: entered, nested: { when: entered, list: [entered, 1] } },
    };
    const session = migrateSession(blob, { sessionId: "s1", flowIdOf: identity, now: NOW });
    expect(session.runs[0].startedAt).toBe("2026-09-10T09:00:00.000Z");
    expect(session.claims["g:s1:"]).toEqual({ at: "2026-09-10T09:00:30.000Z" });
    expect(session.claims["sig:s1:"]).toEqual({ at: "2026-09-10T09:02:00.000Z" });
    expect(session.metadata).toEqual({
      createdAt: "2026-09-10T09:00:00.000Z",
      lastUpdatedAt: "2026-09-10T09:00:00.000Z",
      nested: { when: "2026-09-10T09:00:00.000Z", list: ["2026-09-10T09:00:00.000Z", 1] },
    });
    expect(JSON.stringify(session)).toBe(JSON.stringify(JSON.parse(JSON.stringify(session))));
  });

  test("a blob with no cursor, no signals and no version is an idle session at version 0", () => {
    const session = migrateSession({ id: "s1", data: { nome: "Ana" } }, { sessionId: "s1", flowIdOf: identity, now: NOW });
    expect(session).toEqual({ id: "s1", v: 4, version: 0, data: { nome: "Ana" }, runs: [], claims: {}, inputs: [], metadata: {} });
  });

  test("a flow entered before its first step is a running run with no step", () => {
    const session = migrateSession(
      { id: "s1", data: {}, currentFlow: { id: "f", title: "F" } },
      { sessionId: "s1", flowIdOf: identity, now: NOW },
    );
    expect(session.runs[0]).toMatchObject({ id: "f#legacy", stepId: null, status: "running", startedAt: NOW.toISOString() });
    expect(session.claims["f:s1:"]).toEqual({ at: NOW.toISOString() });
  });

  test("history is kept only when present", () => {
    const history = [{ role: "user" as const, content: "oi" }];
    const withHistory = migrateSession({ id: "s1", data: {}, history }, { sessionId: "s1", flowIdOf: identity });
    expect(withHistory.history).toEqual(history);
    const without = migrateSession({ id: "s1", data: {} }, { sessionId: "s1", flowIdOf: identity });
    expect(without).not.toHaveProperty("history");
  });

  test("a migrated session saves and loads through a Store unchanged", async () => {
    const blob = fixture("prospectar-midflow");
    const sid = blob.id as string;
    const migrated = migrateSession(blob, { sessionId: sid, flowIdOf: identity, now: NOW });
    const store = new MemoryStore();
    // A fresh v4 table has no row for this id yet: the migrated version is 0, so the host's
    // usual `save(session, session.version)` is the insert, and the stored version starts at 1.
    const saved = await store.save(migrated, migrated.version);
    expect(await store.load(sid)).toEqual({ ...migrated, version: 1 });
    expect(saved.runs[0].stepId).toBe("ask_budget");
  });
});

describe("migrateSession: v4 blobs", () => {
  test("a v4 blob passes through unchanged", () => {
    const blob = fixture("v4");
    const session = migrateSession(blob, { sessionId: "conv_v4", flowIdOf: () => "never-called" });
    expect(session).toEqual(blob as unknown as Session); // fixture is the exact v4 shape; the cast only types the comparison
  });

  test("a v4 blob drops a store's own bookkeeping keys and nothing else", () => {
    const blob = { ...fixture("v4"), createdAt: "x", updatedAt: "y" };
    const session = migrateSession(blob, { sessionId: "conv_v4", flowIdOf: identity });
    expect(session).not.toHaveProperty("createdAt");
    expect(Object.keys(session).sort()).toEqual(
      ["claims", "data", "id", "inputs", "lastAssistantAt", "lastUserAt", "metadata", "runs", "v", "version"],
    );
  });
});

describe("migrateSession: malformed blobs throw InvalidSessionError", () => {
  const opts = { sessionId: "s1", flowIdOf: identity };
  const v4 = (over: Blob): Blob => ({ ...fixture("v4"), id: "s1", ...over });

  const cases: Array<[string, unknown]> = [
    ["null", null],
    ["text", "not a session"],
    ["a list", []],
    ["an empty object", {}],
    ["data is text", { id: "s1", data: "nope" }],
    ["data is a list", { id: "s1", data: [] }],
    ["legacy currentFlow is a number", { id: "s1", data: {}, currentFlow: 5 }],
    ["legacy currentFlow has no id", { id: "s1", data: {}, currentFlow: { title: "F" } }],
    ["legacy flowHistory entry without flowId", { id: "s1", data: {}, flowHistory: [{ completed: true }] }],
    ["legacy signals.triggers is a list", { id: "s1", data: {}, signals: { triggers: [] } }],
    ["legacy metadata is text", { id: "s1", data: {}, metadata: "x" }],
    ["v is 3", { v: 3, id: "s1", data: {} }],
    ["v4 with another id", v4({ id: "other" })],
    ["v4 version is text", v4({ version: "3" })],
    ["v4 runs is an object", v4({ runs: {} })],
    ["v4 claims without at", v4({ claims: { "a:s1:": {} } })],
    ["v4 inputs with a number", v4({ inputs: [1] })],
    ["v4 metadata missing", v4({ metadata: undefined })],
    ["v4 history is an object", v4({ history: {} })],
    ["v4 run with an unknown status", v4({ runs: [{ ...(fixture("v4").runs as Blob[])[0], status: "done" }] })],
    ["v4 run without trigger", v4({ runs: [{ ...(fixture("v4").runs as Blob[])[0], trigger: undefined }] })],
    ["v4 run with hop as text", v4({ runs: [{ ...(fixture("v4").runs as Blob[])[0], hop: "0" }] })],
  ];

  for (const [label, blob] of cases) {
    test(label, () => {
      expect(() => migrateSession(blob, opts)).toThrow(InvalidSessionError);
    });
  }

  test("the error names the session and says what to do", () => {
    const error = (() => {
      try {
        migrateSession({ id: "s1", data: "nope" }, opts);
      } catch (e) {
        return e as InvalidSessionError;
      }
      throw new Error("did not throw");
    })();
    expect(error.name).toBe("InvalidSessionError");
    expect(error.sessionId).toBe("s1");
    expect(error.message).toMatch(/^\[InvalidSessionError\] stored session "s1" is unreadable: data is "nope"/);
    expect(error.message).toContain("Repair or delete the row");
  });
});
