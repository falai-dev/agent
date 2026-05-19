/**
 * Data extraction — schema, collect, skip, requires, requiredFields; pre-extraction in action.
 * Run with the message "I want X for Y people on Z" and watch all three fields populate from one turn.
 * Read after: docs/start/03-collect-data.md
 */

import { createAgent, GeminiProvider } from "@falai/agent";

// ─── Schema ──────────────────────────────────────────────────────────────────

interface BookingData {
    roomType: "single" | "double" | "suite";
    guests: number;
    checkIn: string;
}

const schema = {
    type: "object" as const,
    properties: {
        roomType: {
            type: "string" as const,
            enum: ["single", "double", "suite"],
            description: "Type of room requested",
        },
        guests: {
            type: "number" as const,
            description: "Number of guests",
        },
        checkIn: {
            type: "string" as const,
            description: "Check-in date in YYYY-MM-DD format",
        },
    },
    required: ["roomType", "guests", "checkIn"],
};

// ─── Agent ───────────────────────────────────────────────────────────────────

const agent = createAgent<Record<string, never>, BookingData>({
    name: "Booking Agent",
    provider: new GeminiProvider({
        apiKey: process.env.GEMINI_API_KEY!,
        model: "models/gemini-2.5-flash",
    }),
    schema,
    flows: [
        {
            title: "Book a room",
            when: "The user wants to book a hotel room",
            requiredFields: ["roomType", "guests", "checkIn"],
            steps: [
                {
                    id: "ask_room",
                    prompt: "What type of room would you like? (single, double, or suite)",
                    collect: ["roomType"],
                    skip: [({ data }) => data.roomType !== undefined],
                },
                {
                    id: "ask_guests",
                    prompt: "How many guests will be staying?",
                    collect: ["guests"],
                    requires: ["roomType"],
                    skip: [({ data }) => data.guests !== undefined],
                },
                {
                    id: "ask_checkin",
                    prompt: "When would you like to check in?",
                    collect: ["checkIn"],
                    requires: ["roomType", "guests"],
                    skip: [({ data }) => data.checkIn !== undefined],
                },
            ],
        },
    ],
});

// ─── Run ─────────────────────────────────────────────────────────────────────

async function main() {
    // Pre-extraction: all three fields are extracted from a single message.
    const response = await agent.respond({
        history: [{ role: "user", content: "I want a double for 2 people on 2025-03-15" }],
    });

    console.log(response.message);
    console.log("Collected:", response.session?.data);
    console.log("Complete:", response.isFlowComplete);
}

main();
