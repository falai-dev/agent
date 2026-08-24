/**
 * FlowRouter resilience regressions:
 *
 * 3. Unparseable routing LLM output logs an explicit warning (with a raw
 *    snippet) instead of silently degrading the turn.
 * 4. Cross-flow completion from shared agent-level data:
 *    (a) construction-time warning when two registered flows declare
 *        overlapping requiredFields;
 *    (b) sticky-current-flow conservatism — switching away requires the
 *        configured margin even when the current flow has no score entry
 *        or scores 0.
 */

import { describe, test, expect, spyOn } from "bun:test";
import log from "loglevel";
import { Agent } from "../src/index";
import { FlowRouter } from "../src/core/FlowRouter";
import { Flow } from "../src/core/Flow";
import { createSession, enterStep, enterFlow, historyToEvents } from "../src/utils";
import type {
    SessionState,
    GenerateMessageInput,
    GenerateMessageOutput,
    GenerateMessageStreamChunk,
} from "../src/types";
import type { AiProvider } from "../src/types/ai";

// ─── Test types ──────────────────────────────────────────────────────────────

interface TestData {
    fieldA?: string;
    fieldB?: string;
    fieldC?: string;
    email?: string;
    topic?: string;
}

interface TestContext {
    userId: string;
}

// ─── Provider with controllable routing output parseability ─────────────────

class RouterProbeProvider implements AiProvider {
    public readonly name = "RouterProbeProvider";
    /** When true, the routing call returns no structured payload (parse failure). */
    public unparseableRouting = false;
    public rawRoutingMessage = "";
    public routingScores: Record<string, number> = {};

    async generateMessage<TContext = unknown, TStructured = unknown>(
        input: GenerateMessageInput<TContext>
    ): Promise<GenerateMessageOutput<TStructured>> {
        const schemaName = input.parameters?.schemaName || "";
        const schema = (input.parameters?.jsonSchema ?? {}) as {
            properties?: Record<string, unknown>;
        };
        const metadata = { model: "mock", tokensUsed: 10, finishReason: "stop" as const };

        if (schema.properties?.flows) {
            if (this.unparseableRouting) {
                return {
                    message: this.rawRoutingMessage,
                    metadata,
                    structured: undefined as TStructured,
                };
            }
            return {
                message: "",
                metadata,
                structured: {
                    context: "test",
                    flows: this.routingScores,
                    responseDirectives: [],
                } as TStructured,
            };
        }

        if (schema.properties?.selectedStepId) {
            const stepIds =
                ((schema.properties.selectedStepId as { enum?: string[] }).enum) || [];
            return {
                message: "",
                metadata,
                structured: { reasoning: "test", selectedStepId: stepIds[0] } as TStructured,
            };
        }

        return { message: "OK", metadata, structured: { message: "OK" } as TStructured };
    }

    async *generateMessageStream<TContext = unknown, TStructured = unknown>(
        _input: GenerateMessageInput<TContext>
    ): AsyncGenerator<GenerateMessageStreamChunk<TStructured>> {
        yield {
            delta: "OK",
            accumulated: "OK",
            done: true,
            metadata: { model: "mock", tokensUsed: 10, finishReason: "stop" },
        };
    }
}

function makeTwoFlows(): Flow<TestContext, TestData>[] {
    return [
        new Flow<TestContext, TestData>({
            id: "flow-a",
            title: "Flow A",
            requiredFields: ["fieldA"],
            steps: [{ id: "a1", prompt: "A entry" }],
        }),
        new Flow<TestContext, TestData>({
            id: "flow-b",
            title: "Flow B",
            requiredFields: ["fieldB"],
            steps: [{ id: "b1", prompt: "B entry" }],
        }),
    ];
}

// ─── Fix 3: unparseable router output is surfaced loudly ────────────────────

describe("FlowRouter: unparseable routing output observability", () => {
    test("warns with [FlowRouter] prefix and raw snippet when flows payload is missing", async () => {
        const warnSpy = spyOn(log, "warn");
        try {
            const provider = new RouterProbeProvider();
            provider.unparseableRouting = true;
            provider.rawRoutingMessage = 'I could not decide… broken json {"flows":';

            const router = new FlowRouter<TestContext, TestData>();
            const flows = makeTwoFlows();
            let session = createSession<TestData>();

            const result = await router.decideFlowAndStep({
                flows,
                session,
                history: historyToEvents([
                    { role: "user" as const, content: "hello there", name: "User" },
                ]),
                provider,
                context: { userId: "u1" },
            });

            // Fallback behavior unchanged: no flow selected
            expect(result.selectedFlow).toBeUndefined();

            const warned = warnSpy.mock.calls.some((args) =>
                args.some(
                    (arg) =>
                        typeof arg === "string" &&
                        arg.includes("[FlowRouter]") &&
                        arg.includes("unparseable") &&
                        arg.includes('{"flows":')
                )
            );
            expect(warned).toBe(true);
        } finally {
            warnSpy.mockRestore();
        }
    });

    test("does not warn about unparseable output when routing parses fine", async () => {
        const warnSpy = spyOn(log, "warn");
        try {
            const provider = new RouterProbeProvider();
            provider.routingScores = { "flow-a": 80, "flow-b": 20 };

            const router = new FlowRouter<TestContext, TestData>();
            const flows = makeTwoFlows();
            const session = createSession<TestData>();

            await router.decideFlowAndStep({
                flows,
                session,
                history: historyToEvents([
                    { role: "user" as const, content: "hello there", name: "User" },
                ]),
                provider,
                context: { userId: "u1" },
            });

            const unparseableWarning = warnSpy.mock.calls.some((args) =>
                args.some(
                    (arg) =>
                        typeof arg === "string" && arg.includes("unparseable")
                )
            );
            expect(unparseableWarning).toBe(false);
        } finally {
            warnSpy.mockRestore();
        }
    });
});

// ─── Fix 4a: construction-time overlap warning ───────────────────────────────

describe("Flow registration: overlapping requiredFields warning", () => {
    test("warns once per registration when two flows share required fields", () => {
        const agent = new Agent<TestContext, TestData>({
            name: "OverlapAgent",
            provider: new RouterProbeProvider(),
            schema: {
                type: "object",
                properties: {
                    email: { type: "string" },
                    topic: { type: "string" },
                },
            },
        });

        const warnSpy = spyOn(log, "warn");
        try {
            agent.createFlow({
                id: "contact-update",
                title: "Contact Update",
                requiredFields: ["email"],
            });
            agent.createFlow({
                id: "newsletter",
                title: "Newsletter",
                requiredFields: ["email", "topic"],
            });

            const warned = warnSpy.mock.calls.some((args) =>
                args.some(
                    (arg) =>
                        typeof arg === "string" &&
                        arg.includes("Overlapping requiredFields") &&
                        arg.includes("Contact Update") &&
                        arg.includes("Newsletter") &&
                        arg.includes("email")
                )
            );
            expect(warned).toBe(true);
        } finally {
            warnSpy.mockRestore();
        }
    });

    test("no overlap warning for distinct requiredFields or across different agents", () => {
        const makeAgent = (name: string) =>
            new Agent<TestContext, TestData>({
                name,
                provider: new RouterProbeProvider(),
                schema: {
                    type: "object",
                    properties: {
                        email: { type: "string" },
                        topic: { type: "string" },
                    },
                },
            });

        const warnSpy = spyOn(log, "warn");
        try {
            // Distinct fields on one agent — no overlap
            const agent1 = makeAgent("DistinctAgent");
            agent1.createFlow({ title: "Alpha", requiredFields: ["email"] });
            agent1.createFlow({ title: "Beta", requiredFields: ["topic"] });

            // Same fields as agent1's flows, but a DIFFERENT agent — must not cross-warn
            const agent2 = makeAgent("OtherAgent");
            agent2.createFlow({ title: "Gamma", requiredFields: ["email"] });
            agent2.createFlow({ title: "Delta", requiredFields: ["email"] });

            // Gamma/Delta DO overlap each other; Alpha/Beta must never be named
            const alphaBetaWarned = warnSpy.mock.calls.some((args) =>
                args.some(
                    (arg) =>
                        typeof arg === "string" &&
                        (arg.includes("Alpha") || arg.includes("Beta"))
                )
            );
            expect(alphaBetaWarned).toBe(false);

            const gammaDeltaWarned = warnSpy.mock.calls.some((args) =>
                args.some(
                    (arg) =>
                        typeof arg === "string" &&
                        arg.includes("Overlapping requiredFields") &&
                        arg.includes("Gamma") &&
                        arg.includes("Delta")
                )
            );
            expect(gammaDeltaWarned).toBe(true);
        } finally {
            warnSpy.mockRestore();
        }
    });
});

// ─── Fix 4b: sticky margin applies when current flow has no score entry ──────

describe("FlowRouter.selectOptimalFlow: symmetric switch margin", () => {
    const router = new FlowRouter<TestContext, TestData>();

    test("current flow absent from AI scores still requires the switch margin", () => {
        const [fa, fb] = makeTwoFlows();
        // Current flow scored nothing (absent), alternative below the margin
        const result = router.selectOptimalFlow([fa, fb], {}, { "flow-b": 10 }, "flow-a");
        expect(result?.id).toBe("flow-a");
    });

    test("current flow explicitly scored 0 still requires the switch margin", () => {
        const [fa, fb] = makeTwoFlows();
        const result = router.selectOptimalFlow([fa, fb], {}, { "flow-a": 0, "flow-b": 10 }, "flow-a");
        expect(result?.id).toBe("flow-a");
    });

    test("alternative clearing the margin still wins the switch", () => {
        const [fa, fb] = makeTwoFlows();
        const result = router.selectOptimalFlow([fa, fb], {}, { "flow-a": 5, "flow-b": 30 }, "flow-a");
        expect(result?.id).toBe("flow-b");
    });

    test("data-complete alternative is still excluded regardless of scores", () => {
        const [fa, fb] = makeTwoFlows();
        // fieldB collected → flow-b is 100% complete and hard-excluded even at 100 score
        const data: Partial<TestData> = { fieldB: "x" };
        const result = router.selectOptimalFlow(
            [fa, fb], data, { "flow-a": 20, "flow-b": 100 }, "flow-a"
        );
        expect(result?.id).toBe("flow-a");
    });

    test("current flow no longer routable → best alternative is returned", () => {
        const [, fb] = makeTwoFlows();
        // 'flow-a' filtered out of candidates entirely — cannot stick to it
        const result = router.selectOptimalFlow([fb], {}, { "flow-b": 10 }, "flow-a");
        expect(result?.id).toBe("flow-b");
    });
});

// ─── Sanity: shared-field scenario end to end (4a context) ───────────────────

describe("Cross-flow completion conservatism", () => {
    test("mid-conversation flow with zeroed score keeps position against weak alternative", async () => {
        const provider = new RouterProbeProvider();
        // Both flows score low; user is mid flow-a whose data got zeroed by
        // shared agent-level data written for other purposes.
        provider.routingScores = { "flow-a": 3, "flow-b": 8 };

        const router = new FlowRouter<TestContext, TestData>({ flowSwitchMargin: 15 });
        const flows = makeTwoFlows();
        let session: SessionState<TestData> = createSession<TestData>();
        session = enterFlow(session, "flow-a", "Flow A");
        session = enterStep(session, "a1");

        const result = await router.decideFlowAndStep({
            flows,
            session,
            history: historyToEvents([
                { role: "user" as const, content: "hmm ok whatever", name: "User" },
            ]),
            provider,
            context: { userId: "u1" },
        });

        expect(result.selectedFlow?.id).toBe("flow-a");
    });
});
