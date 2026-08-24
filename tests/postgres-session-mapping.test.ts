/**
 * PostgreSQL adapter row mapping — regression test for the adapter returning
 * raw snake_case rows cast to the camelCase SessionData interface, which made
 * every load yield a blank session (no collected data, no dates).
 *
 * The mapper is exercised directly: it is pure and the DB driver adds nothing
 * node-postgres doesn't already deliver in the row object.
 */
import { describe, expect, test } from "bun:test";

import { deserializeSessionRow } from "../src/adapters/PostgreSQLAdapter";

const baseRow = {
  id: "sess_1",
  user_id: "user_1",
  agent_name: "prospector",
  status: "active",
  current_flow: "qualification",
  current_step: "ask_budget",
  message_count: 4,
  version: 7,
};

describe("deserializeSessionRow", () => {
  test("maps snake_case columns onto the camelCase SessionData shape", () => {
    const created = new Date("2026-08-01T10:00:00Z");
    const updated = new Date("2026-08-02T12:30:00Z");

    const session = deserializeSessionRow({
      ...baseRow,
      collected_data: JSON.stringify({
        schemaVersion: 2,
        data: { city: "Recife" },
        flowHistory: [],
        history: [],
      }),
      created_at: created,
      updated_at: updated,
    });

    expect(session.id).toBe("sess_1");
    expect(session.userId).toBe("user_1");
    expect(session.agentName).toBe("prospector");
    expect(session.status).toBe("active");
    expect(session.currentFlow).toBe("qualification");
    expect(session.currentStep).toBe("ask_budget");
    expect(session.collectedData?.data).toEqual({ city: "Recife" });
    expect(session.messageCount).toBe(4);
    expect(session.version).toBe(7);
    expect(session.createdAt).toEqual(created);
    expect(session.updatedAt).toEqual(updated);
  });

  test("accepts JSONB delivered as a parsed object (node-postgres) OR a string", () => {
    const asObject = deserializeSessionRow({
      ...baseRow,
      collected_data: { schemaVersion: 1, data: { a: 1 }, flowHistory: [] },
      created_at: new Date(),
      updated_at: new Date(),
    });
    expect(asObject.collectedData?.data).toEqual({ a: 1 });

    const asString = deserializeSessionRow({
      ...baseRow,
      collected_data: '{"data":{"b":2},"flowHistory":[]}',
      created_at: new Date(),
      updated_at: new Date(),
    });
    expect(asString.collectedData?.data).toEqual({ b: 2 });
  });

  test("nullable columns normalize to undefined; timestamps as strings still parse", () => {
    const session = deserializeSessionRow({
      id: "sess_2",
      status: "active",
      user_id: null,
      agent_name: null,
      current_flow: null,
      current_step: null,
      collected_data: null,
      message_count: null,
      version: null,
      last_message_at: null,
      completed_at: null,
      created_at: "2026-08-01T10:00:00Z",
      updated_at: "2026-08-02T12:30:00Z",
    });

    expect(session.userId).toBeUndefined();
    expect(session.agentName).toBeUndefined();
    expect(session.currentFlow).toBeUndefined();
    expect(session.currentStep).toBeUndefined();
    expect(session.collectedData).toBeUndefined();
    expect(session.messageCount).toBe(0);
    expect(session.version).toBeUndefined();
    expect(session.lastMessageAt).toBeUndefined();
    expect(session.completedAt).toBeUndefined();
    expect(session.createdAt?.toISOString()).toBe("2026-08-01T10:00:00.000Z");
    expect(session.updatedAt?.toISOString()).toBe("2026-08-02T12:30:00.000Z");
  });
});
