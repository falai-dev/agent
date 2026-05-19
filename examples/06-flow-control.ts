/**
 * Programmatic flow control via Agent.dispatch and Directive shapes.
 * Teaches: dispatch from outside a turn, complete with next, abort, reply.
 * Read after: docs/guides/flow-control.md
 */

import { createAgent, GeminiProvider, type Directive, type History } from "@falai/agent";

// ─── Schema ──────────────────────────────────────────────────────────────────

interface AppData {
    item: string;
    confirmed: boolean;
}

// ─── Agent setup ─────────────────────────────────────────────────────────────

const agent = createAgent<{}, AppData>({
    name: "FlowControlDemo",
    provider: new GeminiProvider({
        apiKey: process.env.GEMINI_API_KEY!,
        model: "models/gemini-2.5-flash",
    }),
    schema: {
        type: "object",
        properties: {
            item: { type: "string" },
            confirmed: { type: "boolean" },
        },
    },
    flows: [
        {
            title: "Select Item",
            steps: [
                {
                    id: "ask_item",
                    prompt: "What item would you like?",
                    collect: ["item"],
                },
                {
                    id: "confirm",
                    prompt: "You chose {{data.item}}. Confirm?",
                    collect: ["confirmed"],
                    requires: ["item"],
                    // When the user confirms, complete with a chained directive
                    // that moves to the "Checkout" flow.
                    hooks: {
                        finalize: ({ data }) => {
                            if (data.confirmed) {
                                const d: Directive<{}, AppData> = {
                                    complete: { next: { goTo: "Checkout" }, reason: "User confirmed" },
                                };
                                return d;
                            }
                            // Not confirmed — abort with a reason
                            return { abort: "User declined the item" };
                        },
                    },
                },
            ],
        },
        {
            title: "Checkout",
            steps: [
                {
                    id: "receipt",
                    // reply renders a verbatim message without an LLM call
                    reply: "Your order for {{data.item}} is confirmed. Thank you!",
                },
            ],
        },
    ],
});

// ─── External dispatch ───────────────────────────────────────────────────────
// Agent.dispatch queues a directive on a session OUTSIDE a respond() turn.
// The directive takes effect on the next respond() call.

async function externalRedirect() {
    const history: History = [{ role: "user", content: "hello" }];

    // First turn — enters "Select Item" normally
    const res = await agent.respond({ history });
    const session = res.session!;

    // An external system decides to force-redirect to Checkout
    const updated = await agent.dispatch({ goTo: "Checkout" }, session);

    // Next turn picks up the pending directive
    const next = await agent.respond({
        history: [
            ...history,
            { role: "assistant", content: res.message },
            { role: "user", content: "actually, rush my order" },
        ],
        session: updated,
    });

    console.log(next.message);
    // → "Your order for ... is confirmed. Thank you!"
}

externalRedirect().catch(console.error);
