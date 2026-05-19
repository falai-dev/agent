/** @intent Session persistence with MemoryAdapter: implicit default, explicit wiring, and sessionId for cross-turn continuity.
 *  @teaches MemoryAdapter, PersistenceConfig, sessionId, session resumption
 *  @readAfter docs/guides/persistence.md */
import { createAgent, GeminiProvider, MemoryAdapter } from "../src";

if (!process.env.GEMINI_API_KEY) throw new Error("Set GEMINI_API_KEY");

const provider = new GeminiProvider({
    apiKey: process.env.GEMINI_API_KEY,
    model: "models/gemini-2.5-flash",
});

const schema = {
    type: "object" as const,
    properties: {
        city: { type: "string" },
        checkIn: { type: "string" },
        checkOut: { type: "string" },
    },
};

const flows = [{
    title: "Book Hotel",
    requiredFields: ["city", "checkIn", "checkOut"],
    steps: [
        { id: "ask_city", prompt: "Which city are you visiting?", collect: ["city"] },
        { id: "ask_dates", prompt: "What are your check-in and check-out dates?", collect: ["checkIn", "checkOut"] },
    ],
}];

// --- 1. Implicit MemoryAdapter (default when no persistence is specified) ---
// When you omit `persistence`, the agent uses an internal MemoryAdapter automatically.
// Great for prototyping — zero config, but data is lost when the process exits.

const simpleAgent = createAgent({
    name: "BookingBot",
    provider,
    schema,
    flows,
});

const res1 = await simpleAgent.respond({
    history: [{ role: "user", content: "I'd like to book a hotel in Tokyo" }],
});
console.log("[Implicit adapter]", res1.message);

// --- 2. Explicit MemoryAdapter with userId ---
// Wire a MemoryAdapter explicitly to inspect stored sessions during development.

const adapter = new MemoryAdapter();

const agent = createAgent({
    name: "BookingBot",
    provider,
    schema,
    flows,
    persistence: {
        adapter,
        userId: "user_42",
    },
});

// --- 3. sessionId for cross-turn continuity ---
// Pass `sessionId` at construct time so the same conversation resumes across calls.
// In production, swap MemoryAdapter for PrismaAdapter (or Redis, Postgres, etc.)
// and the session survives process restarts.

const persistentAgent = createAgent({
    name: "BookingBot",
    provider,
    schema,
    flows,
    persistence: {
        adapter,        // swap to: new PrismaAdapter({ prisma }) for production
        userId: "user_42",
    },
    sessionId: "user_42:thread_001",
});

// Turn 1 — agent collects city
const turn1 = await persistentAgent.respond({
    history: [{ role: "user", content: "I want to stay in Paris" }],
});
console.log("[Turn 1]", turn1.message);

// Turn 2 — same sessionId, conversation continues where it left off
const turn2 = await persistentAgent.respond({
    history: [
        { role: "user", content: "I want to stay in Paris" },
        { role: "assistant", content: turn1.message },
        { role: "user", content: "March 10 to March 14" },
    ],
});
console.log("[Turn 2]", turn2.message);

// Inspect stored data (MemoryAdapter-only convenience method)
const snapshot = adapter.getSnapshot();
console.log("[Sessions]", snapshot.sessions.length);
