/**
 * Persistence: load, turn, save, and the one-time move of a 3.x session.
 *
 * Teaches: `Store`, `MemoryStore`, `save(session, expectedVersion)`,
 * `SessionConflictError`, `migrateSession`, `InvalidSessionError`.
 * Read next: docs/guides/persistence.md
 *
 * Run: GEMINI_API_KEY=... bun run examples/08-store-and-migration.ts
 */

import {
  falai,
  GeminiProvider,
  InvalidSessionError,
  MemoryStore,
  migrateSession,
  SessionConflictError,
  type DataOf,
  type Session,
  type TurnResult,
} from "@falai/agent";

const f = falai().fields({
  nome: { type: "string", ask: "Pergunte o nome." },
});
type Data = DataOf<typeof f>;

const agent = f.agent({
  name: "Ana",
  provider: new GeminiProvider({ apiKey: process.env.GEMINI_API_KEY ?? "", model: "gemini-2.5-flash" }),
  flows: [
    f.flow({
      id: "boas-vindas",
      name: "Boas-vindas",
      on: [{ message: [] }],
      steps: [{ id: "nome", collect: ["nome"] }],
    }),
  ],
});

// Any of the seven stores works here; all have the same two methods.
// PostgresStore, PrismaStore, RedisStore, MongoStore, SQLiteStore, OpenSearchStore take a client.
const store = new MemoryStore<Data>();

// ─── The host's turn: load → turn → save ────────────────────────────────────
// The framework never saves. You save when the turn changed something, with
// the version you loaded, so two concurrent turns cannot both win.

async function runTurn(sessionId: string, message: string): Promise<TurnResult<Data>> {
  const session = (await store.load(sessionId)) ?? undefined;
  const result = await agent.turn({ sessionId, session, message });
  if (!result.changed) return result;
  try {
    // 0 means "insert if absent". Later saves pass the loaded version.
    await store.save(result.session, session?.version ?? 0);
  } catch (error) {
    if (error instanceof SessionConflictError) {
      // Someone saved first. Nothing was sent yet, so just play the same input again.
      return runTurn(sessionId, message);
    }
    throw error;
  }
  // Only now: send result.messages, enqueue result.schedule.
  return result;
}

const r = await runTurn("demo", "oi, sou a Bia");
console.log(r.messages[0]?.text, r.session.data); // ... { nome: 'Bia' }

// ─── Moving a 3.x session ───────────────────────────────────────────────────
// A 3.x row holds `currentFlow`, `currentStep`, `signals.triggers`. Migrate it
// once, where you deserialize, then save it into the new table. The migrated
// session has version 0, so the usual save is the insert.

const legacyRow: unknown = {
  id: "conv-42",
  version: 12,
  data: { nome: "Rui" },
  currentFlow: { id: "boas-vindas", title: "Boas-vindas" },
  currentStep: { id: "nome" },
  signals: { triggers: { pediu_humano: { firedAt: "2026-09-01T13:05:12.000Z" } } },
};

const migrated: Session<Data> = migrateSession<Data>(legacyRow, {
  sessionId: "conv-42",
  // Signal keys and old flow ids → v4 flow ids. Identity when you kept the ids.
  flowIdOf: (key) => key,
});
console.log(migrated.runs[0]?.stepId, Object.keys(migrated.claims)); // 'nome' [ 'pediu_humano:conv-42:', 'boas-vindas:conv-42:' ]
await store.save(migrated, migrated.version);

// A row that is neither v4 nor 3.x is an error, never a fresh conversation.
try {
  migrateSession("garbage", { sessionId: "conv-43", flowIdOf: (key) => key });
} catch (error) {
  if (error instanceof InvalidSessionError) console.log(error.message);
}
