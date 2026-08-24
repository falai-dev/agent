/**
 * Regression pins for gaps found in the phase 1–4 fix-coverage audit.
 *
 * Most phase fixes already have pinning tests written alongside them; this
 * file adds ONLY the missing ones:
 *  - tool directives reaching the engine through the STREAMING executor
 *    (the non-streaming path is pinned in directive-wiring.test.ts);
 *  - the streaming batch fallback closing the turn from ALREADY-EXECUTED tool
 *    results instead of re-running them (ToolLoopExecutor.runStreamingBatch);
 *  - Step hooks desugar: shorthand + hooks.* compose, shorthand first;
 *  - DirectiveBus staying absent from the public surface (api-surface.test.ts
 *    lists other deleted internals but never this one);
 *  - consumer-fit leftovers: AgentResponse.metadata.tokensUsed and
 *    restoreSession as the named inverse of createPersistedState;
 *  - SessionManager.addMessage actually APPLYING the default history bound
 *    (history-bound.test.ts pins the pure helper and constant only).
 */
import { describe, expect, test } from "bun:test";

import {
    Agent,
    FlowConfigurationError,
    MemoryAdapter,
    SessionManager,
    Step,
    ToolManager,
    createPersistedState,
    createSession,
    restoreSession,
} from "../src/index";
import { ToolLoopExecutor } from "../src/core/ToolLoopExecutor";
import { MockProvider } from "./mock-provider";
import { DEFAULT_MAX_HISTORY_MESSAGES } from "../src/utils/session";
import type {
    AgentStructuredResponse,
    AiProvider,
    GenerateMessageInput,
    GenerateMessageOutput,
    GenerateMessageStreamChunk,
} from "../src/types/ai";
import type { Directive } from "../src/types";
import type { ToolExecutionUpdate } from "../src/types/tool";

interface Ctx { userId: string }
interface Data { item?: string; confirmed?: boolean }

/**
 * Provider that scripts tool calls into the STREAMED turn only; follow-up
 * generateMessage rounds close with plain text. (MockProvider alone cannot do
 * this — its scripted toolCalls win on EVERY round, so the loop re-fires the
 * tool until maxToolLoops.)
 */
function streamScriptedThenClose(scripted: MockProvider, closing: MockProvider): AiProvider {
    return {
        name: "scripted-stream",
        capabilities: scripted.capabilities,
        generateMessage: async (input: GenerateMessageInput<unknown>) =>
            closing.generateMessage(input) as Promise<GenerateMessageOutput>,
        generateMessageStream: async function* (input: GenerateMessageInput<unknown>) {
            for await (const chunk of scripted.generateMessageStream(input)) {
                yield chunk as GenerateMessageStreamChunk;
            }
        },
        // Cast justified (test double): structurally an AiProvider over two
        // real MockProviders with different per-phase configs.
    } as unknown as AiProvider;
}

// ─── 1. Tool directives through the streaming executor ───────────────────────

describe("tool-emitted directives reach the engine via the STREAMING executor", () => {
    test("a `{ directive: { goTo } }` tool return queues session.pendingDirective on a streamed turn", async () => {
        let executions = 0;
        const provider = streamScriptedThenClose(
            new MockProvider({
                responseMessage: "Redirecting you.",
                delayMs: 0,
                structuredResponse: {
                    message: "Redirecting you.",
                    flow: null,
                    step: null,
                    toolCalls: [{ toolName: "redirect", arguments: {} }],
                },
            }),
            new MockProvider({ responseMessage: "Redirecting you.", delayMs: 0 })
        );

        const agent = new Agent<Ctx, Data>({
            name: "streamDirectiveAgent",
            sessionId: "sess_stream_directive",
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
                    id: "redirect",
                    description: "redirects the conversation",
                    parameters: {},
                    handler: (): { directive: Directive<Ctx, Data> } => {
                        executions++;
                        return { directive: { goTo: "flowB" } };
                    },
                },
            ],
        });

        let last;
        for await (const chunk of agent.stream("redirect me please")) {
            last = chunk;
        }

        expect(executions).toBe(1);
        // Same deferred dispatch semantics as the non-streaming path: the
        // control field queues for the NEXT turn instead of vanishing.
        expect(last?.session?.pendingDirective?.goTo).toBe("flowB");
    });
});

// ─── 2. Streaming fallback never re-executes executed tools ──────────────────

const FORCED_TEXT = "Your card was charged; here is your receipt.";

// Only the forced post-tool generateMessage call matters here; the streamed
// turn is bypassed because we drive runStreamingBatch directly.
const forcedTextProvider: AiProvider = {
    name: "forced-text-stub",
    capabilities: {
        supportsTools: true,
        supportsNativeJsonSchema: true,
        supportsStreaming: true,
        supportsStreamingToolCalls: true,
        supportsPromptCaching: false,
    },
    async generateMessage<TContext = unknown, TStructured = AgentStructuredResponse>() {
        return {
            message: FORCED_TEXT,
            // Cast justified (test stub): the runStreamingBatch fallback path
            // this pin drives consumes only `message` from this response.
            structured: { message: FORCED_TEXT },
        } as GenerateMessageOutput<TStructured>;
    },
    // eslint-disable-next-line require-yield
    async *generateMessageStream() {
        throw new Error("generateMessageStream is not exercised by this test");
    },
};

describe("runStreamingBatch transient failure closes from executed results", () => {
    test("an already-executed tool is NEVER re-run when the concurrent batch dies mid-batch", async () => {
        let charges = 0;
        const agent = new Agent<Ctx, Data>({
            name: "fallbackAgent",
            context: { userId: "u1" },
            provider: forcedTextProvider,
        });
        agent.addTool({
            id: "charge_card",
            description: "charges the card",
            handler: async () => {
                charges++;
                return { ok: true };
            },
        });
        const flow = agent.createFlow({
            title: "Billing",
            description: "Billing help",
            steps: [{ id: "ask", prompt: "What can I charge for you?" }],
        });

        const toolManager = new ToolManager<Ctx, Data>(agent);
        // Stub the concurrent executor: the charge COMPLETES, then the transport
        // dies before the rest of the batch finishes. Cast justified (test SDK
        // double): replaces one generator method with this canned sequence.
        (
            toolManager as unknown as {
                executeWithConcurrency: (params: {
                    toolCalls: Array<{ id: string }>;
                }) => AsyncGenerator<ToolExecutionUpdate<Data>>;
            }
        ).executeWithConcurrency = async function* (params) {
            charges++; // the real-world side effect already happened…
            yield {
                toolCallId: params.toolCalls[0].id,
                result: { success: true, data: { charged: true } },
            };
            // …then the batch itself fails transiently.
            throw new Error("connection reset mid-batch");
        };

        const exec = new ToolLoopExecutor<Ctx, Data>({
            toolManager,
            getAgentOptions: () => agent.getAgentOptions(),
            updateContext: async () => {},
            updateCollectedData: async () => {},
            updateSessionData: async (session, dataUpdate) => ({
                ...session,
                data: { ...session.data, ...dataUpdate },
            }),
        });

        const gen = exec.runStreamingBatch({
            toolCalls: [{ toolName: "charge_card", arguments: {} }],
            context: { userId: "u1" },
            session: createSession<Data>("sess_fallback"),
            history: [{ role: "user", content: "buy it now" }],
            selectedFlow: flow,
            step: flow.initialStep,
            accumulated: "",
            responsePrompt: "Respond to the user.",
            availableTools: [{ id: "charge_card", name: "charge_card" }],
        });

        let finalMessage: string | undefined;
        while (true) {
            const next = await gen.next();
            if (next.done) {
                finalMessage = next.value.finalMessage;
                break;
            }
        }

        // The charge ran EXACTLY once — the pre-fix unconditional runLoop()
        // fallback executed the tool a second time (double send/write/charge).
        expect(charges).toBe(1);
        // And the turn closed from the COLLECTED result, not the bare preamble.
        expect(finalMessage).toBe(FORCED_TEXT);
    });
});

// ─── 3. Step hooks desugar composition ───────────────────────────────────────

describe("Step hooks desugar composes both spellings", () => {
    test("shorthand runs first, hook second, returns merge via Algorithm 4", async () => {
        // appendPrompt is a Directive-level pre-LLM field (not part of the
        // PrepareResult subset), so handlers are typed at their real shape.
        const shorthandPrepare = (): Directive<Ctx, Data> => ({ appendPrompt: ["shorthand"] });
        const hookPrepare = (): Directive<Ctx, Data> => ({ appendPrompt: ["hook"] });

        const step = new Step<Ctx, Data>("desugarFlow", {
            id: "both_spellings",
            prepare: shorthandPrepare,
            finalize: () => ({ dataUpdate: { confirmed: true } }),
            hooks: {
                prepare: hookPrepare,
                finalize: () => ({ dataUpdate: { item: "set-by-hook" } }),
            },
        });

        const prepareFn = step.prepare;
        if (typeof prepareFn !== "function") {
            throw new Error("setup: expected a composed prepare function");
        }
        // The composed result is typed as PrepareResult; read it back at the
        // Directive surface that declares appendPrompt.
        const prepared = (await prepareFn({ userId: "u1" }, {})) as Directive<Ctx, Data>;
        expect(prepared.appendPrompt).toEqual(["shorthand", "hook"]);

        const finalizeFn = step.finalize;
        if (typeof finalizeFn !== "function") {
            throw new Error("setup: expected a composed finalize function");
        }
        const finalized = await finalizeFn({ userId: "u1" }, {});
        expect(finalized?.dataUpdate).toEqual({
            confirmed: true,
            item: "set-by-hook",
        });
    });

    test("a tool-reference shorthand combined with a function hook refuses loudly", () => {
        expect(
            () =>
                new Step<Ctx, Data>("desugarFlow", {
                    id: "conflicting_prepare",
                    prepare: {
                        id: "lookup_tool",
                        description: "lookup",
                        handler: async () => "v",
                    },
                    hooks: { prepare: () => undefined },
                })
        ).toThrow(FlowConfigurationError);
    });
});

// ─── 4. Deleted machinery stays deleted ──────────────────────────────────────

describe("deleted machinery stays deleted", () => {
    test("DirectiveBus is not on the public surface", () => {
        const exports = require("../src/index");
        expect(exports.DirectiveBus).toBeUndefined();
    });
});

// ─── 5. Consumer-fit leftovers ───────────────────────────────────────────────

describe("consumer-fit leftovers", () => {
    test("respond() surfaces metadata.tokensUsed from the turn's primary generation", async () => {
        const agent = new Agent<Ctx, Data>({
            name: "tokensAgent",
            sessionId: "sess_tokens",
            provider: new MockProvider({ responseMessage: "ok", delayMs: 0 }),
            flows: [
                {
                    id: "flowA",
                    title: "A",
                    requiredFields: ["item"],
                    steps: [{ id: "ask", prompt: "ask" }],
                },
            ],
        });

        const response = await agent.respond({
            history: [{ role: "user", content: "hi" }],
            session: createSession<Data>("sess_tokens"),
        });

        // MockProvider reports a fixed 150 on every generation's usage metadata.
        expect(response.metadata?.tokensUsed).toBe(150);
    });

    test("restoreSession is the named inverse of createPersistedState (completed-flow blob survives)", () => {
        const session = createSession<Data>({ id: "sess_restore" });
        session.data = { item: "widget" };
        session.flowHistory = [
            {
                flowId: "flowA",
                enteredAt: new Date(0),
                exitedAt: new Date(1000),
                completed: true,
            },
        ];

        const restored = restoreSession<Data>(createPersistedState(session));

        expect(restored.id).toBe("sess_restore");
        expect(restored.data).toEqual({ item: "widget" });
        expect(restored.flowHistory).toHaveLength(1);
        expect(restored.flowHistory?.[0]?.completed).toBe(true);
        expect(restored.currentFlow).toBeUndefined();
    });
});

// ─── 6. Default history bound is wired into the manager ──────────────────────

describe("SessionManager applies the default history bound", () => {
    test("addMessage trims an unbounded thread to DEFAULT_MAX_HISTORY_MESSAGES", async () => {
        const manager = new SessionManager(new MemoryAdapter());
        const total = DEFAULT_MAX_HISTORY_MESSAGES + 5;
        for (let i = 0; i < total; i++) {
            await manager.addMessage("user", `m${i}`);
        }

        const history = manager.current?.history ?? [];
        expect(history.length).toBeLessThanOrEqual(DEFAULT_MAX_HISTORY_MESSAGES);
        expect(history.at(-1)?.content).toBe(`m${total - 1}`);
    });
});
