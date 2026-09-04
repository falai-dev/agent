/**
 * ResponsePipeline routing regressions:
 *
 * 1. Signals+routing parallel combine keeps BOTH sides' mutations — the
 *    routed session (position state, flow initialData, directive data
 *    merges) is the base, and the signal phase's non-position mutations
 *    (trigger state, handler data writes) are re-applied on top.
 * 2. Routing-skip optimization: step-scoped extraction schema, single
 *    extraction call per turn, skipped entirely when all collect fields
 *    are already populated.
 */

import { describe, test, expect } from "bun:test";
import { Agent } from "../src/index.js";
import { ResponsePipeline } from "../src/core/ResponsePipeline.js";
import { FlowRouter } from "../src/core/FlowRouter.js";
import { SignalCoordinator } from "../src/core/SignalCoordinator.js";
import type { SignalProcessor } from "../src/core/SignalProcessor.js";
import { Flow } from "../src/core/Flow.js";
import { createSession, enterFlow, enterStep, historyToEvents } from "../src/utils/index.js";
import type {
    SessionState,
    StructuredSchema,
    GenerateMessageInput,
    GenerateMessageOutput,
    GenerateMessageStreamChunk,
} from "../src/types/index.js";
import type { AiProvider } from "../src/types/ai.js";

// ─── Test types ──────────────────────────────────────────────────────────────

interface TestData {
    name?: string;
    email?: string;
    phone?: string;
    query?: string;
    tier?: string;
    sentiment?: string;
}

interface TestContext {
    userId: string;
}

// ─── Provider that records every call with its schema shape ─────────────────

interface RecordedCall {
    schemaName?: string;
    schemaProperties: string[];
}

class PipelineProbeProvider implements AiProvider {
    public readonly name = "PipelineProbeProvider";
    public readonly capabilities = {
        supportsTools: true,
        supportsNativeJsonSchema: true,
        supportsStreaming: true,
        supportsStreamingToolCalls: true,
        supportsPromptCaching: false,
    };
    public calls: RecordedCall[] = [];
    /** Scores returned for routing_output calls, keyed by flow id. */
    public routingScores: Record<string, number> = {};
    /** Data returned for data_extraction calls. */
    public extractionData: Partial<TestData> = {};

    async generateMessage<TContext = unknown, TStructured = unknown>(
        input: GenerateMessageInput<TContext>
    ): Promise<GenerateMessageOutput<TStructured>> {
        const schemaName = input.parameters?.schemaName || "";
        const schema = (input.parameters?.jsonSchema ?? {}) as {
            properties?: Record<string, unknown>;
        };
        this.calls.push({
            schemaName,
            schemaProperties: schema.properties ? Object.keys(schema.properties) : [],
        });

        const metadata = { model: "mock", tokensUsed: 10, finishReason: "stop" as const };

        // Extraction call
        if (schemaName === "data_extraction") {
            return {
                message: "",
                metadata,
                structured: this.extractionData as TStructured,
            };
        }

        // Routing call (checked before step selection — routing schemas may
        // also carry selectedStepId)
        if (schema.properties?.flows) {
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

        // Step selection
        if (schema.properties?.selectedStepId) {
            const stepIds =
                ((schema.properties.selectedStepId as { enum?: string[] }).enum) || [];
            return {
                message: "",
                metadata,
                structured: { reasoning: "test", selectedStepId: stepIds[0] } as TStructured,
            };
        }

        // Response generation
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

    callsWithSchema(schemaName: string): RecordedCall[] {
        return this.calls.filter((c) => c.schemaName === schemaName);
    }

    reset(): void {
        this.calls = [];
    }
}

// ─── Signal phase stub: writes data + records a trigger, no directive ───────

function makeEscalationSignalProcessor(): SignalProcessor<TestContext, TestData> {
    // Duck-typed stub: SignalCoordinator only ever calls these two methods.
    // Cast justified for test isolation from SignalProcessor internals.
    const stub = {
        async runPreSignalPhase(params: { session: SessionState<TestData> }) {
            const session = params.session;
            const updatedSession: SessionState<TestData> = {
                ...session,
                data: { ...session.data, sentiment: "frustrated" },
                signals: {
                    ...(session.signals ?? {}),
                    triggers: {
                        ...(session.signals?.triggers ?? {}),
                        escalation_sig: {
                            firstTriggeredAt: new Date(),
                            lastTriggeredAt: new Date(),
                            count: 1,
                            lastReason: "test",
                            lastPhase: "pre",
                        },
                    },
                },
            };
            return {
                firings: [{ id: "escalation_sig", phase: "pre" as const, reason: "test" }],
                updatedSession,
                mergedDirective: undefined,
            };
        },
        async runPostSignalPhase(params: { session: SessionState<TestData> }) {
            return { firings: [], updatedSession: params.session, mergedDirective: undefined };
        },
    };
    return stub as unknown as SignalProcessor<TestContext, TestData>;
}

// ─── Pipeline factory ────────────────────────────────────────────────────────

const TEST_SCHEMA: StructuredSchema = {
    type: "object",
    properties: {
        name: { type: "string", description: "User name" },
        email: { type: "string", description: "User email" },
        phone: { type: "string", description: "User phone" },
        query: { type: "string", description: "User query" },
        tier: { type: "string", description: "Plan tier" },
        sentiment: { type: "string", description: "User sentiment" },
    },
};

function makePipeline(
    provider: PipelineProbeProvider,
    flows: Flow<TestContext, TestData>[],
    options?: { signalProcessor?: SignalProcessor<TestContext, TestData> }
) {
    const collectedUpdates: Partial<TestData>[] = [];
    const signalCoordinator = new SignalCoordinator<TestContext, TestData>({
        getFlows: () => flows,
        signalProcessor: options?.signalProcessor,
    });
    const pipeline = new ResponsePipeline<TestContext, TestData>(
        { name: "pipeline-test-agent", provider },
        () => flows,
        new FlowRouter<TestContext, TestData>(),
        signalCoordinator,
        async (updates) => {
            collectedUpdates.push(updates);
        },
        () => TEST_SCHEMA,
    );
    return { pipeline, collectedUpdates };
}

function userHistory(content: string) {
    return historyToEvents([{ role: "user" as const, content, name: "User" }]);
}

// ─── Fix 1: parallel signals + routing keep both sides' mutations ────────────

describe("ResponsePipeline: signals+routing session combine", () => {
    test("router-entered flow's initialData survives the parallel signal combine", async () => {
        const provider = new PipelineProbeProvider();
        // User is mid-flow Alpha; routing scores strongly favor Beta, whose
        // initialData must be merged by the router and survive the combine.
        provider.routingScores = { alpha: 10, beta: 90 };

        const flows: Flow<TestContext, TestData>[] = [
            new Flow<TestContext, TestData>({
                id: "alpha",
                title: "Alpha",
                steps: [
                    { id: "a1", prompt: "Alpha one" },
                    { id: "a2", prompt: "Alpha two" },
                ],
            }),
            new Flow<TestContext, TestData>({
                id: "beta",
                title: "Beta",
                initialData: { tier: "gold" },
                steps: [{ id: "b1", prompt: "Beta entry" }],
            }),
        ];

        const { pipeline } = makePipeline(provider, flows, {
            signalProcessor: makeEscalationSignalProcessor(),
        });

        let session = createSession<TestData>();
        session = enterFlow(session, "alpha", "Alpha");
        session = enterStep(session, "a1");

        const result = await pipeline.routeAndSelectStep({
            session,
            history: userHistory("switch me to beta please"),
            context: { userId: "u1" },
        });

        // Router decision applied
        expect(result.session.currentFlow?.id).toBe("beta");
        // THE FIX: router-merged initialData is no longer dropped by the combiner
        expect(result.session.data.tier).toBe("gold");
        // Signal-phase handler data write still applied
        expect(result.session.data.sentiment).toBe("frustrated");
        // Signal-phase trigger state still applied
        expect(result.session.signals?.triggers?.["escalation_sig"]?.count).toBe(1);
    });

    test("routing-skip turn keeps extraction merges alongside signal mutations", async () => {
        const provider = new PipelineProbeProvider();
        provider.extractionData = { name: "Alice" };

        const gamma = new Flow<TestContext, TestData>({
            id: "gamma",
            title: "Gamma",
            steps: [
                { id: "g1", prompt: "What is your name?", collect: ["name"] },
                { id: "g2", prompt: "Thanks!" },
            ],
        });

        const { pipeline } = makePipeline(provider, [gamma], {
            signalProcessor: makeEscalationSignalProcessor(),
        });

        let session = createSession<TestData>();
        session = enterFlow(session, "gamma", "Gamma");
        session = enterStep(session, "g1");

        const result = await pipeline.routeAndSelectStep({
            session,
            history: userHistory("I'm Alice"),
            context: { userId: "u1" },
        });

        // Routing was skipped (step-scoped extraction populated the collect field)
        expect(provider.callsWithSchema("routing_output").length).toBe(0);
        // Skip-result extraction merge survived the signal combine
        expect(result.session.data.name).toBe("Alice");
        // Signal-phase mutations survived too
        expect(result.session.data.sentiment).toBe("frustrated");
        expect(result.session.signals?.triggers?.["escalation_sig"]?.count).toBe(1);
        // Position retained
        expect(result.session.currentFlow?.id).toBe("gamma");
    });
});

// ─── Fix 2: routing-skip optimization scoping and cost ───────────────────────

describe("ResponsePipeline: routing-skip scoping and extraction cost", () => {
    function makeCollectFlows(): Flow<TestContext, TestData>[] {
        return [
            new Flow<TestContext, TestData>({
                id: "registration",
                title: "Registration",
                requiredFields: ["name", "email"],
                steps: [
                    { id: "ask_name", prompt: "What is your name?", collect: ["name"] },
                    { id: "ask_email", prompt: "What is your email?", collect: ["email"] },
                ],
            }),
            new Flow<TestContext, TestData>({
                id: "support",
                title: "Support",
                requiredFields: ["query"],
                steps: [{ id: "ask_query", prompt: "What do you need?", collect: ["query"] }],
            }),
        ];
    }

    async function sessionOnAskName(data: Partial<TestData>) {
        let session = createSession<TestData>({ data });
        session = enterFlow(session, "registration", "Registration");
        session = enterStep(session, "ask_name");
        return session;
    }

    test("(a) skip-probe extraction schema is restricted to the current step's collect fields", async () => {
        const provider = new PipelineProbeProvider();
        provider.extractionData = {}; // nothing found → fall through to routing
        provider.routingScores = { registration: 30, support: 85 };

        const { pipeline } = makePipeline(provider, makeCollectFlows());
        const session = await sessionOnAskName({});

        await pipeline.routeAndSelectStep({
            session,
            history: userHistory("actually switch me to Support"),
            context: { userId: "u1" },
        });

        const probes = provider.callsWithSchema("data_extraction");
        expect(probes.length).toBeGreaterThanOrEqual(1);
        // The probe schema exposes ONLY the current step's collect field —
        // incidental mentions of other agent fields cannot influence the turn.
        expect(probes[0].schemaProperties).toEqual(["name"]);
        // And since nothing was extracted, the switch intent got scored
        expect(provider.callsWithSchema("routing_output").length).toBeGreaterThanOrEqual(1);
    });

    test("(b) a non-firing turn costs exactly ONE extraction call (no duplicate)", async () => {
        const provider = new PipelineProbeProvider();
        provider.extractionData = {}; // probe finds nothing
        provider.routingScores = { registration: 80, support: 20 };

        const { pipeline } = makePipeline(provider, makeCollectFlows());
        const session = await sessionOnAskName({});

        await pipeline.routeAndSelectStep({
            session,
            history: userHistory("hmm let me think"),
            context: { userId: "u1" },
        });

        expect(provider.callsWithSchema("data_extraction").length).toBe(1);
        expect(provider.callsWithSchema("routing_output").length).toBe(1);
    });

    test("(c) all collect fields already populated → no probe extraction, normal path only", async () => {
        const provider = new PipelineProbeProvider();
        provider.extractionData = { name: "Bob" }; // would re-return the same value
        provider.routingScores = { registration: 80, support: 20 };

        const { pipeline } = makePipeline(provider, makeCollectFlows());
        const session = await sessionOnAskName({ name: "Bob" });

        await pipeline.routeAndSelectStep({
            session,
            history: userHistory("anyway..."),
            context: { userId: "u1" },
        });

        // Exactly one extraction call this turn, and it is the NORMAL
        // full-schema extraction (the skip probe never ran).
        const extractionCalls = provider.callsWithSchema("data_extraction");
        expect(extractionCalls.length).toBe(1);
        expect(extractionCalls[0].schemaProperties).toContain("name");
        expect(extractionCalls[0].schemaProperties).toContain("query");
        expect(provider.callsWithSchema("routing_output").length).toBe(1);
    });

    test("(d) contract preserved: skip fires only when a NEW collect field is populated", async () => {
        const provider = new PipelineProbeProvider();
        provider.extractionData = { name: "Alice" };
        provider.routingScores = { registration: 20, support: 85 }; // would switch if scored

        const { pipeline } = makePipeline(provider, makeCollectFlows());
        const session = await sessionOnAskName({});

        const result = await pipeline.routeAndSelectStep({
            session,
            history: userHistory("I'm Alice"),
            context: { userId: "u1" },
        });

        // Skip fired: routing never ran, position retained
        expect(provider.callsWithSchema("routing_output").length).toBe(0);
        expect(result.session.currentFlow?.id).toBe("registration");
        expect(result.session.currentStep?.id).toBe("ask_name");
        expect(result.session.data.name).toBe("Alice");
    });
});

// ─── Fix 3: a branch beats the router's completion verdict ───────────────────

/**
 * The router calls "flow complete" from the LINEAR chain alone — the current
 * step has no transition, so it is an implicit terminus — and it does so
 * BEFORE branches run. `determineNextStep` then lets branches override that
 * verdict. It used to override only when the branch changed FLOW, so a branch
 * parking on a step of its own flow (`then: '<stepId>'`, `then: { reset }`)
 * resolved a step that the caller immediately discarded: the turn ended as a
 * silent completion (no LLM call, empty reply) and the flow was marked
 * completed — dead for the rest of the session.
 */
describe("ResponsePipeline: branches override the router's completion verdict", () => {
    /** Last step is an implicit terminus (no transition) that parks on itself. */
    function parkingFlow(branches?: { then: string }[]) {
        return new Flow<TestContext, TestData>({
            id: "support",
            title: "Support",
            steps: [
                { id: "ask_query", prompt: "What do you need?", collect: ["query"] },
                { id: "wrap_up", prompt: "Anything else?", ...(branches ? { branches } : {}) },
            ],
        });
    }

    async function turnAtWrapUp(flow: Flow<TestContext, TestData>) {
        const provider = new PipelineProbeProvider();
        const { pipeline } = makePipeline(provider, [flow]);

        let session = createSession<TestData>({ data: { query: "pricing" } });
        session = enterFlow(session, "support", "Support");
        session = enterStep(session, "wrap_up");

        const result = await pipeline.routeAndSelectStep({
            session,
            history: userHistory("show me the photo"),
            context: { userId: "u1" },
        });
        return { result, provider };
    }

    test("a self-parking branch on the last step keeps the turn alive", async () => {
        const { result } = await turnAtWrapUp(parkingFlow([{ then: "wrap_up" }]));

        // THE FIX: the branch resolved a step, so the flow is NOT complete —
        // the caller renders `wrap_up` and calls the LLM instead of releasing
        // the session to idle with an empty reply.
        expect(result.isFlowComplete).toBe(false);
        expect(result.selectedStep?.id).toBe("wrap_up");
        expect(result.selectedFlow?.id).toBe("support");
        expect(result.session.currentStep?.id).toBe("wrap_up");
    });

    test("contract preserved: the same last step without branches still completes", async () => {
        const { result } = await turnAtWrapUp(parkingFlow());

        expect(result.isFlowComplete).toBe(true);
        expect(result.selectedStep).toBeUndefined();
    });

    test("end to end: the parked turn answers instead of dying silently", async () => {
        const provider = new PipelineProbeProvider();
        const agent = new Agent<TestContext, TestData>({
            name: "ParkingAgent",
            provider,
            context: { userId: "u1" },
            schema: TEST_SCHEMA,
            flows: [
                {
                    title: "Support",
                    steps: [
                        { id: "ask_query", prompt: "What do you need?", collect: ["query"] },
                        { id: "wrap_up", prompt: "Anything else?", branches: [{ then: "wrap_up" }] },
                    ],
                },
            ],
        });

        const flow = agent.getFlows()[0];
        let session = createSession<TestData>({ data: { query: "pricing" } });
        session = enterFlow(session, flow.id, flow.title);
        session = enterStep(session, "wrap_up");

        const response = await agent.respond({
            history: [{ role: "user", content: "show me the photo" }],
            session,
        });

        // The turn rendered the step: a message came back and the session is
        // still live. Before the fix this returned an empty message with
        // isFlowComplete=true and a session released to idle.
        expect(response.message).toBe("OK");
        expect(response.isFlowComplete).toBe(false);
        expect(response.session!.currentFlow?.id).toBe(flow.id);
        expect(response.session!.currentStep?.id).toBe("wrap_up");
        expect(response.executedSteps).toContainEqual({ id: "wrap_up", flowId: flow.id });
    });
});
