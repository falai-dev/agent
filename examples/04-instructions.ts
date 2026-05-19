/**
 * Instructions — behavioral rules at agent, flow, and step scope.
 * Teaches: Instruction, kind (must / never / should), conditional `when`.
 * Read next: docs/guides/instructions.md
 */

import { createAgent, GeminiProvider } from "../src";

if (!process.env.GEMINI_API_KEY) throw new Error("Set GEMINI_API_KEY");

// ─── Types ───────────────────────────────────────────────────────────────────

interface SupportData {
    issue: string;
    category: string;
    resolution: string;
}

// ─── Agent with instructions at every scope ──────────────────────────────────

const agent = createAgent<unknown, SupportData>({
    name: "SupportBot",
    provider: new GeminiProvider({
        apiKey: process.env.GEMINI_API_KEY,
        model: "models/gemini-2.5-flash",
    }),
    schema: {
        type: "object",
        properties: {
            issue: { type: "string" },
            category: { type: "string" },
            resolution: { type: "string" },
        },
    },

    // ── Agent-scope instructions (apply to every flow and step) ──────────
    instructions: [
        // "must" — absolute rule, always enforced
        { kind: "must", prompt: "Always greet the user by name if it appears in the message." },
        // "never" — absolute prohibition
        { kind: "never", prompt: "Share internal ticket IDs or system error codes with the user." },
        // "should" — behavioral nudge, conditionally active
        {
            kind: "should",
            prompt: "Suggest the FAQ article link before escalating to a human.",
            when: "User is asking a common question",
        },
    ],

    flows: [
        {
            title: "Resolve Issue",
            when: "User reports a problem or asks for help",
            requiredFields: ["issue", "category", "resolution"],

            // ── Flow-scope instructions (active only in this flow) ────────
            instructions: [
                { kind: "must", prompt: "Classify the issue into a category before proposing a resolution." },
                {
                    kind: "should",
                    prompt: "Ask clarifying questions if the issue description is under ten words.",
                    when: "The user's issue description is vague or very short",
                },
            ],

            steps: [
                {
                    id: "identify",
                    prompt: "Ask the user to describe their issue.",
                    collect: ["issue", "category"],

                    // ── Step-scope instructions (active only in this step) ─
                    instructions: [
                        { kind: "never", prompt: "Suggest a resolution before the issue is fully described." },
                        {
                            kind: "should",
                            prompt: "Offer example categories to help the user classify their problem.",
                            when: "User seems unsure how to categorize",
                        },
                    ],
                },
                {
                    id: "resolve",
                    prompt: "Propose a resolution based on the identified issue and category.",
                    collect: ["resolution"],
                },
            ],
        },
    ],
});

// ─── Run ─────────────────────────────────────────────────────────────────────

const response = await agent.respond({
    history: [{ role: "user", content: "Hey, my login page keeps showing a blank screen." }],
});

console.log(response.message);
// The appliedInstructions array shows which instructions were active this turn.
console.log("Applied:", response.appliedInstructions);
