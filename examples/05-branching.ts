/** @intent Demonstrates step.branches — source-local forks with if, when, and Directive targets.
 *  @teaches BranchEntry, BranchMap, if-only fork, when-only fork, combined if+when, mixed targets
 *  @readAfter docs/guides/branching.md */
import { createAgent, GeminiProvider } from "../src";
import type { BranchMap, Directive, FlowOptions, StepOptions } from "../src";

// ─── Types ───────────────────────────────────────────────────────────────────

interface Context { tier: "free" | "pro" | "enterprise" }
interface Data { intent: string; query: string; answer: string }

// ─── Provider ────────────────────────────────────────────────────────────────

const provider = new GeminiProvider({
    apiKey: process.env.GEMINI_API_KEY!,
    model: "models/gemini-2.5-flash",
});

// ─── Steps with branches ─────────────────────────────────────────────────────

// 1. if-only fork — pure code predicate, zero LLM cost
const triageStep: StepOptions<Context, Data> = {
    id: "triage",
    prompt: "What can I help you with today?",
    collect: ["intent"],
    branches: [
        {
            label: "pro-fast-track",
            if: ({ context }) => context.tier === "pro" || context.tier === "enterprise",
            then: "priority_queue",   // resolves as step id in same flow
        },
        {
            label: "free-default",
            then: "general_help",     // unconditional fallback (last entry)
        },
    ] satisfies BranchMap<Context, Data>,
};

// 2. when-only fork — AI-evaluated condition (costs tokens)
const classifyStep: StepOptions<Context, Data> = {
    id: "general_help",
    prompt: "Let me look into that for you.",
    collect: ["query"],
    branches: [
        {
            label: "billing",
            when: "The user is asking about billing, invoices, or payments",
            then: "billing_flow",     // resolves as flow id (cross-flow jump)
        },
        {
            label: "technical",
            when: "The user is asking a technical or API question",
            then: "tech_support",     // resolves as step id
        },
        {
            label: "fallback",
            then: "tech_support",
        },
    ] satisfies BranchMap<Context, Data>,
};

// 3. Combined if + when — code runs first (free), AI only if code passes
const priorityStep: StepOptions<Context, Data> = {
    id: "priority_queue",
    prompt: "You have priority support. What do you need?",
    collect: ["query"],
    branches: [
        {
            label: "enterprise-escalation",
            if: ({ context }) => context.tier === "enterprise",
            when: "The user is reporting a production outage or critical bug",
            then: {
                goTo: "escalation_flow",
                dataUpdate: { intent: "escalation" },
                reply: "Routing you to our on-call engineering team now.",
            } satisfies Directive<Context, Data>,
        },
        {
            label: "standard-priority",
            then: "tech_support",
        },
    ] satisfies BranchMap<Context, Data>,
};

// 4. Terminal step — no branches, linear end
const techSupportStep: StepOptions<Context, Data> = {
    id: "tech_support",
    prompt: "I'll find the answer to your technical question.",
    collect: ["answer"],
};

// ─── Flows ───────────────────────────────────────────────────────────────────

const supportFlow: FlowOptions<Context, Data> = {
    id: "support_flow",
    title: "Support",
    description: "Routes users through support triage",
    when: "The user needs help or support",
    steps: [triageStep, classifyStep, priorityStep, techSupportStep],
    requiredFields: ["answer"],
};

const billingFlow: FlowOptions<Context, Data> = {
    id: "billing_flow",
    title: "Billing",
    description: "Handles billing inquiries",
    when: "The user asks about billing",
    steps: [{ id: "billing_help", prompt: "Let me pull up your billing info." }],
};

const escalationFlow: FlowOptions<Context, Data> = {
    id: "escalation_flow",
    title: "Escalation",
    description: "Critical issue escalation for enterprise customers",
    steps: [{ id: "escalate", prompt: "Connecting you to on-call engineering." }],
};

// ─── Agent ───────────────────────────────────────────────────────────────────

const agent = createAgent<Context, Data>({
    name: "Support Bot",
    provider,
    context: { tier: "pro" },
    schema: {
        type: "object",
        properties: {
            intent: { type: "string" },
            query: { type: "string" },
            answer: { type: "string" },
        },
    },
    flows: [supportFlow, billingFlow, escalationFlow],
});

// ─── Run ─────────────────────────────────────────────────────────────────────

const response = await agent.respond({
    history: [{ role: "user", content: "I need help with my API integration" }],
});
console.log(response.message);
