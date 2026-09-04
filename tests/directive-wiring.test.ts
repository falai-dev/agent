/**
 * Directive wiring — end-to-end regression tests for the "truth pass":
 * directives emitted by tools (`ctx.dispatch` / `{ directive }` returns) and
 * step hooks (`hooks.finalize`) must actually reach the engine. Before this,
 * ToolManager collected tool directives and nothing consumed them.
 *
 * Also pins the SessionFinalizer ordering: finalize runs BEFORE persistence,
 * so its state writes survive even if this is the conversation's last turn.
 */
import { describe, expect, test } from "bun:test";

import { Agent } from "../src/core/Agent.js";
import { MemoryAdapter } from "../src/adapters/MemoryAdapter.js";
import { MockProvider, MockProviderFactory } from "./mock-provider.js";
import { createSession } from "../src/utils/session.js";
import type { Directive } from "../src/types/index.js";
import type { ToolContext } from "../src/types/tool.js";

interface TestContext {
    userId: string;
}
interface TestData {
    item?: string;
    confirmed?: boolean;
}

function makeAgentWithTool(
    handler: (ctx: ToolContext<TestContext, TestData>) => unknown,
    provider = MockProviderFactory.withToolCalls([
        { toolName: "intercept", arguments: {} },
    ])
): Agent<TestContext, TestData> {
    return new Agent<TestContext, TestData>({
        name: "wiring",
        sessionId: "sess_wiring",
        provider,
        flows: [
            {
                id: "flowA",
                title: "A",
                requiredFields: ["item"],
                steps: [{ id: "ask", prompt: "ask" }],
            },
        ],
        tools: [
            {
                id: "intercept",
                description: "intercept turn",
                parameters: {},
                handler,
            },
        ],
    });
}

describe("tool-emitted directives reach the engine", () => {
    test("a `{ directive: { reply } }` return becomes the final message without an LLM follow-up", async () => {
        const agent = makeAgentWithTool(() => ({
            directive: { reply: "Handled by tool." } satisfies Directive<TestContext, TestData>,
        }));

        const response = await agent.respond({
            history: [{ role: "user", content: "hi" }],
        });

        // The tool's verbatim reply IS the assistant message — not the model text.
        expect(response.message).toBe("Handled by tool.");
    });

    test("ctx.dispatch({ goTo }) queues session.pendingDirective for the next turn", async () => {
        const agent = makeAgentWithTool((ctx) => {
            ctx.dispatch({ goTo: "flowB" } as Directive<TestContext, TestData>);
            return { ok: true };
        });

        const response = await agent.respond({
            history: [{ role: "user", content: "hi" }],
        });

        // Agent was constructed with a sessionId, so respond always resolves one
        expect(response.session!.pendingDirective).toBeDefined();
    });
});

describe("step hooks run through real machinery", () => {
    test("hooks.finalize state write is persisted (finalize runs BEFORE auto-save)", async () => {
        const adapter = new MemoryAdapter();
        const agent = new Agent<TestContext, TestData>({
            name: "finalizeOrder",
            sessionId: "sess_finalize_order",
            provider: new MockProvider({ responseMessage: "ok" }),
            persistence: { adapter },
            flows: [
                {
                    id: "confirmFlow",
                    title: "Confirm",
                    requiredFields: [],
                    steps: [
                        {
                            id: "confirmStep",
                            prompt: "Confirm?",
                            hooks: {
                                finalize: () => ({
                                    dataUpdate: { confirmed: true },
                                }),
                            },
                        },
                    ],
                },
            ],
        });
        // Explicit session sidesteps the constructor's un-awaited getOrCreate
        // race (a separate pre-existing issue) from polluting this assertion.
        const session = createSession<TestData>("sess_finalize_order");

        await agent.respond({
            history: [{ role: "user", content: "yes please" }],
            session,
        });

        const persisted = await adapter.sessionRepository.findById("sess_finalize_order");
        expect(persisted).toBeDefined();
        expect(persisted?.collectedData?.data.confirmed).toBe(true);
    });
});
