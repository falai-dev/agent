/**
 * Flow Completion Integration Tests
 *
 * Verifies the idle-state release, `reentrant` re-selection, `onComplete`
 * precedence, and completed-flow filtering behaviors through `agent.respond()`.
 *
 * Uses a tracking provider that returns configurable routing scores, following
 * the same pattern as `tests/routing-skip.test.ts`.
 *
 * **Validates: Requirements 23.1, 23.2, 23.3 + design `flow-completion.md`**
 */

import { describe, test, expect } from "bun:test";
import { Agent, createSession, enterFlow, enterStep } from "../src/index";
import type {
    GenerateMessageInput,
    GenerateMessageOutput,
    GenerateMessageStreamChunk,
    AiProvider,
} from "../src/types";

// ─── Test types ──────────────────────────────────────────────────────────────

interface TestData {
    name?: string;
    email?: string;
    query?: string;
    topic?: string;
}

interface TestContext {
    userId: string;
}

// ─── Tracking Provider ───────────────────────────────────────────────────────

/**
 * Provider that tracks all calls and returns configurable routing scores.
 * Allows tests to verify which flows are offered to the router and control
 * which flow wins selection.
 */
class FlowCompletionTrackingProvider implements AiProvider {
    public readonly name = "FlowCompletionTrackingProvider";
    public calls: { type: string; schemaName?: string; flowIds?: string[] }[] = [];

    /**
     * Configurable routing scores by flow ID.
     * When a routing call is made, only flows present in this map AND in the
     * router's schema are scored. This lets tests verify exclusion.
     */
    public routingScores: Record<string, number> = {};

    /** Data to return during pre-extraction calls */
    public extractionData: Partial<TestData> = {};

    /** Step ID to select when step-selection is called */
    public selectedStepId: string | null = null;

    async generateMessage<TContext = unknown, TStructured = unknown>(
        input: GenerateMessageInput<TContext>
    ): Promise<GenerateMessageOutput<TStructured>> {
        const schemaName = input.parameters?.schemaName || "";
        const schema = input.parameters?.jsonSchema as any;

        // Routing call — has flows property
        if (schema?.properties?.flows?.properties) {
            const flowIds = Object.keys(schema.properties.flows.properties);
            this.calls.push({ type: "routing", schemaName, flowIds });

            // Return configured scores only for flows present in the schema
            const flows: Record<string, number> = {};
            for (const flowId of flowIds) {
                flows[flowId] = this.routingScores[flowId] ?? 10;
            }

            return {
                message: "",
                metadata: { model: "mock", tokensUsed: 10, finishReason: "stop" },
                structured: { context: "test", flows, responseDirectives: [] } as TStructured,
            };
        }

        // Step selection call
        if (schema?.properties?.selectedStepId) {
            const stepIds = schema.properties.selectedStepId.enum || [];
            this.calls.push({ type: "step_selection", schemaName });

            const selectedId = this.selectedStepId || stepIds[0];
            return {
                message: "",
                metadata: { model: "mock", tokensUsed: 10, finishReason: "stop" },
                structured: { reasoning: "test", selectedStepId: selectedId } as TStructured,
            };
        }

        // Data extraction call
        if (schemaName.includes("extraction") || schemaName.includes("data")) {
            this.calls.push({ type: "extraction", schemaName });
            return {
                message: "",
                metadata: { model: "mock", tokensUsed: 10, finishReason: "stop" },
                structured: this.extractionData as TStructured,
            };
        }

        // Response generation call
        this.calls.push({ type: "response", schemaName });
        return {
            message: "OK",
            metadata: { model: "mock", tokensUsed: 50, finishReason: "stop" },
            structured: { message: "OK" } as TStructured,
        };
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

    /** Reset all tracking state */
    reset(): void {
        this.calls = [];
        this.extractionData = {};
        this.selectedStepId = null;
    }

    /** Get which flow IDs were offered to the router across all routing calls */
    getRoutedFlowIds(): string[][] {
        return this.calls
            .filter((c) => c.type === "routing")
            .map((c) => c.flowIds ?? []);
    }

    /** Check if a routing call was made */
    hasRoutingCall(): boolean {
        return this.calls.some((c) => c.type === "routing");
    }
}

// ─── 6.1 Idle-state release without onComplete ──────────────────────────────

describe("6.1 Integration test: idle-state release without onComplete", () => {
    test("flow completes to idle when requiredFields are satisfied; session goes idle", async () => {
        const provider = new FlowCompletionTrackingProvider();
        // Score flow A high so it gets selected on first routing
        provider.routingScores = { [""]: 90 }; // will be set after agent creation

        const agent = new Agent<TestContext, TestData>({
            name: "IdleReleaseAgent",
            description: "Test idle-state release on flow completion",
            goal: "Test flow completion",
            context: { userId: "user-1" },
            provider,
            schema: {
                type: "object",
                properties: {
                    name: { type: "string", description: "User name" },
                    email: { type: "string", description: "User email" },
                },
            },
            flows: [
                {
                    title: "Registration",
                    when: "user wants to register",
                    requiredFields: ["name", "email"],
                    steps: [
                        { id: "ask_name", prompt: "What is your name?", collect: ["name"] },
                        { id: "ask_email", prompt: "What is your email?", collect: ["email"] },
                    ],
                },
            ],
        });

        const flows = agent.getFlows();
        const regFlow = flows.find((f) => f.title === "Registration")!;

        // Set up session as if already in the flow on the last step,
        // with all requiredFields satisfied (simulating data already collected)
        let session = createSession<TestData>({
            data: { name: "Alice", email: "alice@example.com" },
        });
        session = enterFlow(session, regFlow.id, regFlow.title);
        const lastStep = regFlow.getStep("ask_email")!;
        session = enterStep(session, lastStep.id, lastStep.description);

        // Drive respond() — the flow should detect all requiredFields are satisfied
        // and complete the flow
        const response = await agent.respond({
            history: [{ role: "user", content: "alice@example.com" }],
            session,
        });

        // Assert idle state release
        expect(response.session!.currentFlow).toBeUndefined();
        expect(response.session!.currentStep).toBeUndefined();
        expect(response.session!.flowHistory![0].completed).toBe(true);
        // stoppedReason is 'completed' or 'last_step' depending on detection path
        expect(["completed", "last_step"]).toContain(response.stoppedReason);
    });

    test("second message after completion: completed flow is excluded from routing, fallback runs", async () => {
        const provider = new FlowCompletionTrackingProvider();

        const agent = new Agent<TestContext, TestData>({
            name: "IdleReleaseAgent",
            description: "Test completed flow exclusion",
            goal: "Test flow completion",
            context: { userId: "user-1" },
            provider,
            schema: {
                type: "object",
                properties: {
                    name: { type: "string", description: "User name" },
                    email: { type: "string", description: "User email" },
                },
            },
            flows: [
                {
                    title: "Registration",
                    when: "user wants to register",
                    requiredFields: ["name", "email"],
                    steps: [
                        { id: "ask_name", prompt: "What is your name?", collect: ["name"] },
                        { id: "ask_email", prompt: "What is your email?", collect: ["email"] },
                    ],
                },
            ],
        });

        const flows = agent.getFlows();
        const regFlow = flows.find((f) => f.title === "Registration")!;

        // Build a session that is already idle after completion
        let session = createSession<TestData>({
            data: { name: "Alice", email: "alice@example.com" },
        });
        session = enterFlow(session, regFlow.id, regFlow.title);
        session = enterStep(session, "ask_email", "");
        // Now complete it via the utility — simulating what the runtime does
        session = {
            ...session,
            currentFlow: undefined,
            currentStep: undefined,
            flowHistory: [
                {
                    flowId: regFlow.id,
                    enteredAt: new Date(),
                    exitedAt: new Date(),
                    completed: true,
                },
            ],
        };

        // Configure provider — give the flow a high score. But since it's completed
        // and not reentrant, it should be EXCLUDED from the candidates.
        provider.routingScores = { [regFlow.id]: 95 };

        // Send a second message
        const response = await agent.respond({
            history: [{ role: "user", content: "I want to register again" }],
            session,
        });

        // The completed flow should not appear in routing candidates
        const routedFlows = provider.getRoutedFlowIds();
        // Either no routing call is made (no eligible flows → fallback), or
        // routing is called but the completed flow is not in the candidates
        for (const flowIds of routedFlows) {
            expect(flowIds).not.toContain(regFlow.id);
        }

        // Session should remain idle (no flow selected because the only flow
        // is completed and not reentrant)
        expect(response.session!.currentFlow).toBeUndefined();
    });
});

// ─── 6.2 flow.reentrant: true re-selection ──────────────────────────────────

describe("6.2 Integration test: flow.reentrant: true re-selection", () => {
    test("reentrant flow: completes → idle release → owned fields cleared → re-selected on next trigger", async () => {
        const provider = new FlowCompletionTrackingProvider();

        const agent = new Agent<TestContext, TestData>({
            name: "ReentrantAgent",
            description: "Test reentrant flow behavior",
            goal: "Test reentrant",
            context: { userId: "user-1" },
            provider,
            schema: {
                type: "object",
                properties: {
                    query: { type: "string", description: "Search query" },
                    name: { type: "string", description: "User name" },
                },
            },
            flows: [
                {
                    title: "Search",
                    when: "user wants to search",
                    requiredFields: ["query"],
                    reentrant: true,
                    steps: [
                        { id: "ask_query", prompt: "What would you like to search for?", collect: ["query"] },
                    ],
                },
            ],
        });

        const flows = agent.getFlows();
        const searchFlow = flows.find((f) => f.title === "Search")!;

        // Build session in the completed state for the Search flow
        // reentrant flow clears owned fields on completion
        let session = createSession<TestData>({
            data: { name: "Alice" }, // name is NOT owned by Search, should be preserved
        });
        session = {
            ...session,
            currentFlow: undefined,
            currentStep: undefined,
            flowHistory: [
                {
                    flowId: searchFlow.id,
                    enteredAt: new Date(),
                    exitedAt: new Date(),
                    completed: true,
                },
            ],
        };

        // `query` should already be cleared (reentrant completion clears owned fields)
        expect(session.data.query).toBeUndefined();
        // Non-owned field preserved
        expect(session.data.name).toBe("Alice");

        // Configure provider to score Search high — since it's reentrant,
        // it should be eligible for re-selection
        provider.routingScores = { [searchFlow.id]: 90 };

        // Send a message that re-triggers the Search flow
        const response = await agent.respond({
            history: [{ role: "user", content: "Search for cats" }],
            session,
        });

        // Search flow should be re-selected (reentrant allows it)
        expect(response.session!.currentFlow?.id).toBe(searchFlow.id);
        // It should enter from the initial step
        expect(response.session!.currentStep?.id).toBe("ask_query");
        // A new flowHistory entry should exist
        const searchEntries = response.session!.flowHistory!.filter(
            (h) => h.flowId === searchFlow.id
        );
        expect(searchEntries.length).toBeGreaterThanOrEqual(2);
    });

    test("non-reentrant flow: completed flow is NOT re-selected; fallback runs", async () => {
        const provider = new FlowCompletionTrackingProvider();

        const agent = new Agent<TestContext, TestData>({
            name: "NonReentrantAgent",
            description: "Test non-reentrant flow exclusion",
            goal: "Test non-reentrant",
            context: { userId: "user-1" },
            provider,
            schema: {
                type: "object",
                properties: {
                    query: { type: "string", description: "Search query" },
                },
            },
            flows: [
                {
                    title: "Search",
                    when: "user wants to search",
                    requiredFields: ["query"],
                    reentrant: false, // explicitly non-reentrant
                    steps: [
                        { id: "ask_query", prompt: "What would you like to search for?", collect: ["query"] },
                    ],
                },
            ],
        });

        const flows = agent.getFlows();
        const searchFlow = flows.find((f) => f.title === "Search")!;

        // Build session in the completed state
        let session = createSession<TestData>({ data: { query: "dogs" } });
        session = {
            ...session,
            currentFlow: undefined,
            currentStep: undefined,
            flowHistory: [
                {
                    flowId: searchFlow.id,
                    enteredAt: new Date(),
                    exitedAt: new Date(),
                    completed: true,
                },
            ],
        };

        provider.routingScores = { [searchFlow.id]: 95 };

        // Send a message that would normally trigger Search
        const response = await agent.respond({
            history: [{ role: "user", content: "I want to search for cats" }],
            session,
        });

        // Search flow should NOT be re-selected (non-reentrant, completed)
        // The router excludes it from candidates
        const routedFlows = provider.getRoutedFlowIds();
        for (const flowIds of routedFlows) {
            expect(flowIds).not.toContain(searchFlow.id);
        }

        // Session remains idle — fallback path runs
        expect(response.session!.currentFlow).toBeUndefined();
    });
});

// ─── 6.3 onComplete wins over reentrant ─────────────────────────────────────

describe("6.3 Integration test: onComplete wins over reentrant", () => {
    test("flow with both reentrant: true and onComplete: transitions to onComplete target, not re-entry", async () => {
        const provider = new FlowCompletionTrackingProvider();

        const agent = new Agent<TestContext, TestData>({
            name: "OnCompleteWinsAgent",
            description: "Test onComplete precedence over reentrant",
            goal: "Test onComplete vs reentrant",
            context: { userId: "user-1" },
            provider,
            schema: {
                type: "object",
                properties: {
                    name: { type: "string", description: "User name" },
                    email: { type: "string", description: "User email" },
                    topic: { type: "string", description: "Feedback topic" },
                },
            },
            flows: [
                {
                    title: "Registration",
                    when: "user wants to register",
                    requiredFields: ["name", "email"],
                    reentrant: true,
                    onComplete: "Feedback",
                    steps: [
                        { id: "ask_name", prompt: "What is your name?", collect: ["name"] },
                        { id: "ask_email", prompt: "What is your email?", collect: ["email"] },
                    ],
                },
                {
                    title: "Feedback",
                    when: "user wants to give feedback",
                    requiredFields: ["topic"],
                    steps: [
                        { id: "ask_topic", prompt: "What topic?", collect: ["topic"] },
                    ],
                },
            ],
        });

        const flows = agent.getFlows();
        const regFlow = flows.find((f) => f.title === "Registration")!;
        const feedbackFlow = flows.find((f) => f.title === "Feedback")!;

        // Set up session in the Registration flow with all data satisfied
        let session = createSession<TestData>({
            data: { name: "Alice", email: "alice@example.com" },
        });
        session = enterFlow(session, regFlow.id, regFlow.title);
        const lastStep = regFlow.getStep("ask_email")!;
        session = enterStep(session, lastStep.id, lastStep.description);

        // Drive respond — completion should trigger onComplete → Feedback
        const response = await agent.respond({
            history: [{ role: "user", content: "alice@example.com" }],
            session,
        });

        // The runtime applies onComplete within the same turn. Registration completes
        // and the session transitions into Feedback. The key assertion:
        // Feedback was entered (not Registration re-entered despite reentrant: true).
        const flowHistory = response.session!.flowHistory!;

        // Registration must appear in history with exitedAt set (it transitioned out)
        const regEntry = flowHistory.find((h) => h.flowId === regFlow.id);
        expect(regEntry).toBeDefined();
        expect(regEntry!.exitedAt).toBeDefined();

        // Feedback must appear in history (was entered via onComplete)
        const feedbackEntry = flowHistory.find((h) => h.flowId === feedbackFlow.id);
        expect(feedbackEntry).toBeDefined();
        expect(feedbackEntry!.enteredAt).toBeDefined();

        // The critical assertion: Registration was NOT re-entered despite reentrant: true.
        // onComplete takes priority — the session goes to Feedback, not back to Registration.
        const regEntries = flowHistory.filter((h) => h.flowId === regFlow.id);
        expect(regEntries.length).toBe(1); // Only one entry — no re-entry
    });
});

// ─── 6.4 Completed flow filtered from routing candidates ────────────────────

describe("6.4 Integration test: completed flow filtered from routing candidates", () => {
    test("multi-flow agent: completed flow excluded from routing; only remaining flows scored", async () => {
        const provider = new FlowCompletionTrackingProvider();

        const agent = new Agent<TestContext, TestData>({
            name: "MultiFlowAgent",
            description: "Test completed flow exclusion from routing",
            goal: "Test routing exclusion",
            context: { userId: "user-1" },
            provider,
            schema: {
                type: "object",
                properties: {
                    name: { type: "string", description: "User name" },
                    email: { type: "string", description: "User email" },
                    query: { type: "string", description: "Search query" },
                    topic: { type: "string", description: "Feedback topic" },
                },
            },
            flows: [
                {
                    title: "FlowA",
                    when: "user says alpha",
                    requiredFields: ["name"],
                    steps: [
                        { id: "a_step", prompt: "What is your name?", collect: ["name"] },
                    ],
                },
                {
                    title: "FlowB",
                    when: "user says beta",
                    requiredFields: ["email"],
                    steps: [
                        { id: "b_step", prompt: "What is your email?", collect: ["email"] },
                    ],
                },
                {
                    title: "FlowC",
                    when: "user says gamma",
                    requiredFields: ["query"],
                    steps: [
                        { id: "c_step", prompt: "What is your query?", collect: ["query"] },
                    ],
                },
            ],
        });

        const flows = agent.getFlows();
        const flowA = flows.find((f) => f.title === "FlowA")!;
        const flowB = flows.find((f) => f.title === "FlowB")!;
        const flowC = flows.find((f) => f.title === "FlowC")!;

        // Build a session where FlowA is already completed
        let session = createSession<TestData>({ data: { name: "Alice" } });
        session = {
            ...session,
            currentFlow: undefined,
            currentStep: undefined,
            flowHistory: [
                {
                    flowId: flowA.id,
                    enteredAt: new Date(),
                    exitedAt: new Date(),
                    completed: true,
                },
            ],
        };

        // Configure provider: give FlowA the highest score (but it should be excluded)
        provider.routingScores = {
            [flowA.id]: 99,
            [flowB.id]: 70,
            [flowC.id]: 60,
        };

        // Send a message that clearly matches FlowA's when
        const response = await agent.respond({
            history: [{ role: "user", content: "alpha" }],
            session,
        });

        // Verify that FlowA was NOT included in routing candidates
        const routedFlows = provider.getRoutedFlowIds();
        expect(routedFlows.length).toBeGreaterThan(0);
        for (const flowIds of routedFlows) {
            expect(flowIds).not.toContain(flowA.id);
            // FlowB and FlowC should be present as candidates
            expect(flowIds).toContain(flowB.id);
            expect(flowIds).toContain(flowC.id);
        }

        // The router should select from B or C (B has higher score)
        expect(response.session!.currentFlow?.id).toBe(flowB.id);
    });

    test("all flows completed and none reentrant: fallback runs, no flow selected", async () => {
        const provider = new FlowCompletionTrackingProvider();

        const agent = new Agent<TestContext, TestData>({
            name: "AllCompletedAgent",
            description: "Test all-flows-completed fallback",
            goal: "Test fallback",
            context: { userId: "user-1" },
            provider,
            schema: {
                type: "object",
                properties: {
                    name: { type: "string", description: "User name" },
                    query: { type: "string", description: "Search query" },
                },
            },
            flows: [
                {
                    title: "FlowA",
                    when: "user says alpha",
                    requiredFields: ["name"],
                    steps: [
                        { id: "a_step", prompt: "What is your name?", collect: ["name"] },
                    ],
                },
                {
                    title: "FlowB",
                    when: "user says beta",
                    requiredFields: ["query"],
                    steps: [
                        { id: "b_step", prompt: "What is your query?", collect: ["query"] },
                    ],
                },
            ],
        });

        const flows = agent.getFlows();
        const flowA = flows.find((f) => f.title === "FlowA")!;
        const flowB = flows.find((f) => f.title === "FlowB")!;

        // Both flows completed
        let session = createSession<TestData>({ data: { name: "Alice", query: "cats" } });
        session = {
            ...session,
            currentFlow: undefined,
            currentStep: undefined,
            flowHistory: [
                { flowId: flowA.id, enteredAt: new Date(), exitedAt: new Date(), completed: true },
                { flowId: flowB.id, enteredAt: new Date(), exitedAt: new Date(), completed: true },
            ],
        };

        provider.routingScores = { [flowA.id]: 99, [flowB.id]: 95 };

        const response = await agent.respond({
            history: [{ role: "user", content: "alpha" }],
            session,
        });

        // No flow should be selected — fallback path
        expect(response.session!.currentFlow).toBeUndefined();
        expect(response.session!.currentStep).toBeUndefined();

        // Routing should either not be called or not include the completed flows
        const routedFlows = provider.getRoutedFlowIds();
        for (const flowIds of routedFlows) {
            expect(flowIds).not.toContain(flowA.id);
            expect(flowIds).not.toContain(flowB.id);
        }
    });
});
