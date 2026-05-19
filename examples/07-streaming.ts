/**
 * Real-time streaming with respondStream and final-chunk metadata.
 * Teaches: respondStream, chunk consumption, appliedInstructions, triggeredSignals.
 * Read after: docs/guides/streaming.md
 */

import { createAgent, GeminiProvider, createSession, type AgentResponseStreamChunk } from "@falai/agent";

// ─── Schema ──────────────────────────────────────────────────────────────────

interface AppData {
    topic: string;
}

// ─── Agent setup ─────────────────────────────────────────────────────────────

const agent = createAgent<{}, AppData>({
    name: "StreamingDemo",
    provider: new GeminiProvider({
        apiKey: process.env.GEMINI_API_KEY!,
        model: "models/gemini-2.5-flash",
    }),
    schema: {
        type: "object",
        properties: {
            topic: { type: "string" },
        },
    },
    instructions: [
        { id: "concise", kind: "should", prompt: "Keep answers under 100 words" },
    ],
    flows: [
        {
            title: "Chat",
            steps: [{ id: "talk", prompt: "Discuss the user's topic.", collect: ["topic"] }],
        },
    ],
});

// ─── Stream consumption ──────────────────────────────────────────────────────

async function streamResponse() {
    const session = createSession<AppData>("stream-demo");
    const history = [{ role: "user" as const, content: "Explain how tides work" }];

    const stream = agent.respondStream({ history, session });

    let finalChunk: AgentResponseStreamChunk<AppData> | undefined;

    for await (const chunk of stream) {
        // Print each delta as it arrives (real-time UX)
        process.stdout.write(chunk.delta);

        if (chunk.done) {
            finalChunk = chunk;
        }
    }

    console.log("\n");

    // ─── Final-chunk metadata ────────────────────────────────────────────────
    if (finalChunk) {
        console.log("Accumulated:", finalChunk.accumulated.length, "chars");
        console.log("Applied instructions:", finalChunk.appliedInstructions ?? []);
        console.log("Triggered signals:", finalChunk.triggeredSignals ?? []);
    }
}

streamResponse().catch(console.error);
