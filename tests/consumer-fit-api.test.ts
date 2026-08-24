/**
 * Consumer-fit API surface:
 *  - respond({ message }) owns history: user turn + assistant tail land on the
 *    returned session, and the model sees the message this turn;
 *  - allowedFlows pins routing candidates for a turn without cloning agents;
 *  - endedFlows surfaces flow exits (completions, directive redirects);
 *  - typed errors propagate bare (ProviderError reachable via err.cause or
 *    instanceof) instead of being flattened into ResponseGenerationError.
 */
import { describe, expect, test } from "bun:test";

import { Agent } from "../src/core/Agent";
import { createSession } from "../src/utils/session";
import { MockProvider } from "./mock-provider";
import { ProviderError } from "../src/types/errors";
import type { AiProvider, GenerateMessageInput, GenerateMessageOutput } from "../src/types/ai";
import type { HistoryItem } from "../src/types/history";

interface Ctx { userId: string }
interface Data { item?: string; confirmed?: boolean }

/** MockProvider wrapper recording generateMessage inputs. */
function recording(inner: AiProvider) {
    const calls: GenerateMessageInput<unknown>[] = [];
    return {
        calls,
        provider: {
            name: "rec",
            capabilities: inner.capabilities,
            generateMessage: async (input: GenerateMessageInput<unknown>) => {
                calls.push(input);
                return inner.generateMessage(input) as Promise<GenerateMessageOutput>;
            },
            // eslint-disable-next-line require-yield
            generateMessageStream: async function* () { throw new Error("unused"); },
        } as unknown as AiProvider,
    };
}

describe("respond({ message }) owns session history", () => {
    test("user message reaches the model AND the returned session, plus the assistant tail", async () => {
        const inner = new MockProvider({ responseMessage: "Model reply." });
        const { provider, calls } = recording(inner);

        const agent = new Agent<Ctx, Data>({
            name: "histAgent",
            sessionId: "sess_hist",
            provider,
            flows: [{
                id: "flowA", title: "A", requiredFields: ["item"],
                steps: [{ id: "ask", prompt: "ask" }],
            }],
        });
        const session = createSession<Data>("sess_hist");

        const response = await agent.respond<Ctx, Data>({
            history: [{ role: "user", content: "earlier context" }],
            message: "I want the blue widget",
            session,
        });

        // The model's history for THIS turn ends with the new user message.
        const lastHistoryItem = calls[0]?.history.at(-1) as HistoryItem;
        expect(lastHistoryItem.role).toBe("user");
        expect(lastHistoryItem.content).toBe("I want the blue widget");

        // The returned session carries the full exchange.
        const roles = (response.session?.history ?? []).map((h) => h.role);
        expect(roles).toContain("user");
        expect(roles.at(-1)).toBe("assistant");
        expect((response.session?.history ?? []).at(-1)?.content).toBe("Model reply.");
    });
});

describe("allowedFlows restricts routing for the turn", () => {
    test("a pinned flow wins even when default scoring prefers another", async () => {
        const agent = new Agent<Ctx, Data>({
            name: "pinAgent",
            sessionId: "sess_pin",
            provider: new MockProvider({ responseMessage: "routed" }),
            flows: [
                { id: "flowFirst", title: "First", requiredFields: ["item"], steps: [{ id: "s1", prompt: "p" }] },
                { id: "flowSecond", title: "Second", requiredFields: ["item"], steps: [{ id: "s2", prompt: "p" }] },
            ],
        });

        const response = await agent.respond<Ctx, Data>({
            history: [{ role: "user", content: "hi" }],
            allowedFlows: ["flowSecond"],
        });

        // Mock routing scores registration order (80, 70…); without the pin,
        // flowFirst would win. The pin forces flowSecond despite the lower score.
        expect(response.session?.currentFlow?.id).toBe("flowSecond");
    });
});

describe("endedFlows surfaces flow exits", () => {
    test("a mid-turn completion via auto-step complete directive appears with its reason", async () => {
        const agent = new Agent<Ctx, Data>({
            name: "endAgent",
            sessionId: "sess_end",
            provider: new MockProvider({ responseMessage: "done" }),
            flows: [{
                id: "soloFlow", title: "Solo", requiredFields: ["item"],
                steps: [{
                    id: "autoDone",
                    auto: true,
                    prepare: () => ({ dataUpdate: { item: "x" }, complete: true }),
                }],
            }],
        });

        const response = await agent.respond<Ctx, Data>({
            history: [{ role: "user", content: "hi" }],
        });

        const solo = response.endedFlows?.find((f) => f.flowId === "soloFlow");
        expect(solo).toBeDefined();
        expect(solo?.title).toBe("Solo");
        expect(solo?.reason).toBe("completed");
    });

    test("a directive-driven cross-flow redirect records the exited flow next turn", async () => {
        const agent = new Agent<Ctx, Data>({
            name: "redirectAgent",
            sessionId: "sess_redirect",
            provider: MockProviderFactoryHelper(),
            flows: [
                { id: "flowA", title: "A", requiredFields: ["item"], steps: [{ id: "ask", prompt: "p" }] },
                { id: "flowB", title: "B", requiredFields: [], steps: [{ id: "b1", prompt: "p" }] },
            ],
            tools: [{
                id: "redirect", description: "redirect", parameters: {},
                handler: (ctx) => { ctx.dispatch({ goTo: "flowB" }); return { ok: true }; },
            }],
        });

        // Turn 1: tool queues { goTo: 'flowB' } as pendingDirective.
        await agent.respond<Ctx, Data>({ history: [{ role: "user", content: "hi" }] });

        // Turn 2: the applier enters flowB; flowA must appear in endedFlows.
        const response = await agent.respond<Ctx, Data>({ history: [{ role: "user", content: "continue" }] });
        const exited = response.endedFlows?.find((f) => f.flowId === "flowA");
        expect(exited).toBeDefined();
        expect(exited?.reason).toBe("goto");
    });
});

// Helper kept separate so the redirect test stays readable above.
import { MockProviderFactory } from "./mock-provider";
function MockProviderFactoryHelper() {
    return MockProviderFactory.withToolCalls([{ toolName: "redirect", arguments: {} }]);
}

describe("typed errors propagate", () => {
    test("a ProviderError is rethrown AS-IS (instanceof survives)", async () => {
        const boom: AiProvider = {
            name: "boom",
            capabilities: new MockProvider().capabilities,
            generateMessage: () => Promise.reject(new ProviderError("rate_limited", "stub", "slow down")),
            // eslint-disable-next-line require-yield
            generateMessageStream: async function* () { throw new Error("unused"); },
        } as unknown as AiProvider;

        const agent = new Agent<Ctx, Data>({
            name: "errAgent",
            sessionId: "sess_err",
            provider: boom,
            flows: [{ id: "flowA", title: "A", requiredFields: [], steps: [{ id: "s", prompt: "p" }] }],
        });

        try {
            await agent.respond<Ctx, Data>({ history: [{ role: "user", content: "hi" }] });
            expect.unreachable();
        } catch (error) {
            // Bare rethrow: consumers can branch on the normalized code
            expect(error instanceof ProviderError).toBe(true);
            expect((error as ProviderError).code).toBe("rate_limited");
        }
    });

    test("other failures wrap with err.cause pointing at the original", async () => {
        const inner = new Error("socket hangup");
        const flaky: AiProvider = {
            name: "flaky",
            capabilities: new MockProvider().capabilities,
            generateMessage: () => Promise.reject(inner),
            // eslint-disable-next-line require-yield
            generateMessageStream: async function* () { throw new Error("unused"); },
        } as unknown as AiProvider;

        const agent = new Agent<Ctx, Data>({
            name: "causeAgent",
            sessionId: "sess_cause",
            provider: flaky,
            flows: [{ id: "flowA", title: "A", requiredFields: [], steps: [{ id: "s", prompt: "p" }] }],
        });

        await expect(
            agent.respond<Ctx, Data>({ history: [{ role: "user", content: "hi" }] })
        ).rejects.toMatchObject({ cause: inner });
    });
});
