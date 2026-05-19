/**
 * Signals — pre-phase escalation with halt + replyWith, post-phase entity capture with extract.
 * Teaches: Signal, SignalContext, SignalDirective, behavior: 'cooldown', extract schema.
 * Read next: docs/reference/signals.md
 */

import {
    createAgent,
    GeminiProvider,
    createSession,
    type Signal,
    type SignalContext,
    type SignalDirective,
    type SignalFiring,
} from "@falai/agent";

// ─── Types ───────────────────────────────────────────────────────────────────

interface AppContext {
    supportTier: "free" | "premium";
}

interface AppData {
    topic: string;
    sentiment: string;
    contactName: string;
    contactEmail: string;
}

// ─── Signal 1: Pre-phase escalation with cooldown ────────────────────────────
// Detects angry messages BEFORE the LLM responds. Halts normal flow and
// replies with an escalation notice. Cooldown prevents re-triggering for 60s.

const escalationSignal: Signal<AppContext, AppData> = {
    id: "escalation",
    title: "Anger Escalation",
    description: "Detects user frustration and halts to escalate.",
    phase: "pre",

    when: "The user is expressing strong frustration, anger, or threats to leave",

    behavior: "cooldown",
    cooldownMs: 60_000,

    handler(ctx: SignalContext<AppContext, AppData>): SignalDirective<AppContext, AppData> {
        // halt: stops the LLM call from running
        // replyWith: sends a canned response instead
        return {
            halt: true,
            replyWith: "I can see this is frustrating — let me connect you with a specialist right away.",
            dataUpdate: { sentiment: "escalated" },
            stopOtherSignals: true,
        };
    },
};

// ─── Signal 2: Post-phase entity capture with extract ────────────────────────
// After the LLM responds, extracts contact info the user may have provided.
// Uses `extract` schema so the classifier pulls structured data alongside
// the match decision.

interface ContactExtract {
    name: string | null;
    email: string | null;
}

const contactCaptureSignal: Signal<AppContext, AppData, ContactExtract> = {
    id: "contact_capture",
    title: "Contact Info Capture",
    description: "Extracts name and email from the conversation when mentioned.",
    phase: "post",

    when: "The user has provided their name or email address in this message",

    extract: {
        type: "object",
        properties: {
            name: { type: ["string", "null"], description: "The user's full name, or null if not provided" },
            email: { type: ["string", "null"], description: "The user's email address, or null if not provided" },
        },
        required: ["name", "email"],
    } as const,

    async handler(ctx: SignalContext<AppContext, AppData, ContactExtract>): Promise<void> {
        const { extracted } = ctx;

        // Only update fields that were actually extracted
        if (extracted.name) {
            await ctx.updateData({ contactName: extracted.name });
        }
        if (extracted.email) {
            await ctx.updateData({ contactEmail: extracted.email });
        }
    },
};

// ─── Agent ───────────────────────────────────────────────────────────────────

const agent = createAgent<AppContext, AppData>({
    name: "SupportAgent",
    provider: new GeminiProvider({
        apiKey: process.env.GEMINI_API_KEY!,
        model: "gemini-3.1-flash-lite",
    }),
    context: { supportTier: "free" },
    schema: {
        type: "object",
        properties: {
            topic: { type: "string" },
            sentiment: { type: "string" },
            contactName: { type: "string" },
            contactEmail: { type: "string" },
        },
    },
    signals: [escalationSignal, contactCaptureSignal],
    flows: [
        {
            title: "Support",
            when: "User needs help with a product issue",
            steps: [
                { id: "triage", prompt: "Identify the user's issue and ask clarifying questions.", collect: ["topic"] },
                { id: "resolve", prompt: "Provide a solution based on the identified topic." },
            ],
        },
    ],
});

// ─── Run ─────────────────────────────────────────────────────────────────────

const session = createSession<AppData>("signals-demo");

const response = await agent.respond({
    history: [{ role: "user", content: "This is ridiculous! I've been waiting 3 days. My name is Alex and my email is alex@example.com." }],
    session,
});

console.log(response.message);

// Observability: log which signals fired this turn
if (response.triggeredSignals?.length) {
    for (const firing of response.triggeredSignals as SignalFiring[]) {
        console.log(`[signal] ${firing.id} (${firing.phase}) — ${firing.reason ?? "no reason"}`);
    }
}
