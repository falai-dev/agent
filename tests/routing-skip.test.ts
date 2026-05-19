/**
 * Routing skip optimization tests
 *
 * When a step is actively collecting data (has `collect` fields) and
 * pre-extraction populates at least one of those fields from the user's
 * message, routing is skipped for that turn.
 *
 * **Validates: Requirements 20.1, 20.2, 20.3**
 */

import { describe, test, expect } from "bun:test";
import { Agent, createSession, enterFlow, enterStep } from "../src/index";
import type { SessionState, GenerateMessageInput, GenerateMessageOutput, GenerateMessageStreamChunk } from "../src/types";
import type { AiProvider } from "../src/types/ai";

// ─── Test types ──────────────────────────────────────────────────────────────

interface TestData {
    name?: string;
    email?: string;
    phone?: string;
    query?: string;
}

interface TestContext {
    userId: string;
}

// ─── Provider that tracks calls and can simulate extraction ─────────────────

class RoutingTrackingProvider implements AiProvider {
    public readonly name = "RoutingTrackingProvider";
    public calls: { schemaName?: string; prompt: string }[] = [];
    /** Data to return when pre-extraction runs */
    public extractionData: Partial<TestData> = {};

    async generateMessage<TContext = unknown, TStructured = unknown>(
        input: GenerateMessageInput<TContext>
    ): Promise<GenerateMessageOutput<TStructured>> {
        const schemaName = input.parameters?.schemaName || "";
        this.calls.push({ schemaName, prompt: input.prompt });

        // Data extraction call — return configured extraction data
        if (schemaName.includes("extraction") || schemaName.includes("data")) {
            return {
                message: "",
                metadata: { model: "mock", tokensUsed: 10, finishReason: "stop" },
                structured: this.extractionData as TStructured,
            };
        }

        // Routing call — return flow scores
        if (input.parameters?.jsonSchema) {
            const schema = input.parameters.jsonSchema as any;
            if (schema.properties?.flows?.properties) {
                const flowIds = Object.keys(schema.properties.flows.properties);
                const flows: Record<string, number> = {};
                flowIds.forEach((flowId, index) => {
                    flows[flowId] = 80 - index * 10;
                });
                return {
                    message: "",
                    metadata: { model: "mock", tokensUsed: 20, finishReason: "stop" },
                    structured: { context: "test", flows, responseDirectives: [] } as TStructured,
                };
            }
            // Step selection
            if (schema.properties?.selectedStepId) {
                const stepIds = schema.properties.selectedStepId.enum || [];
                return {
                    message: "",
                    metadata: { model: "mock", tokensUsed: 10, finishReason: "stop" },
                    structured: { reasoning: "test", selectedStepId: stepIds[0] } as TStructured,
                };
            }
        }

        // Response generation
        return {
            message: "OK",
            metadata: { model: "mock", tokensUsed: 50, finishReason: "stop" },
            structured: { message: "OK" } as TStructured,
        };
    }

    async *generateMessageStream<TContext = unknown, TStructured = unknown>(
        _input: GenerateMessageInput<TContext>
    ): AsyncGenerator<GenerateMessageStreamChunk<TStructured>> {
        yield { delta: "OK", accumulated: "OK", done: true, metadata: { model: "mock", tokensUsed: 10, finishReason: "stop" } };
    }

    /** Reset call tracking */
    reset(): void {
        this.calls = [];
        this.extractionData = {};
    }

    /** Check if a routing call was made (schema with flows property) */
    hasRoutingCall(): boolean {
        return this.calls.some(c =>
            c.prompt.includes("route") ||
            c.prompt.includes("flow") ||
            c.schemaName === "routing_output"
        );
    }

    /** Get the number of calls with a routing schema */
    getRoutingCallCount(): number {
        return this.calls.filter(c => c.schemaName === "routing_output").length;
    }

    /** Get the number of calls with an extraction schema */
    getExtractionCallCount(): number {
        return this.calls.filter(c =>
            c.schemaName?.includes("extraction") || c.schemaName?.includes("data")
        ).length;
    }
}

// ─── Helper to create an agent with a step that collects data ───────────────

function createCollectAgent(provider: RoutingTrackingProvider) {
    return new Agent<TestContext, TestData>({
        name: "RoutingSkipAgent",
        description: "Agent to test routing skip optimization",
        goal: "Collect user data",
        context: { userId: "test-user" },
        provider,
        schema: {
            type: "object",
            properties: {
                name: { type: "string", description: "User name" },
                email: { type: "string", description: "User email" },
                phone: { type: "string", description: "User phone" },
                query: { type: "string", description: "User query" },
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
            {
                title: "Support",
                when: "user needs help",
                requiredFields: ["query"],
                steps: [
                    { id: "ask_query", prompt: "What do you need help with?", collect: ["query"] },
                ],
            },
        ],
    });
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("Routing skip optimization", () => {
    describe("Requirement 20.1: Skip routing when pre-extraction populates a collect field", () => {
        test("when current step collects 'name' and pre-extraction returns a name, routing is skipped", async () => {
            const provider = new RoutingTrackingProvider();
            const agent = createCollectAgent(provider);

            // Set up session as if already in the Registration flow, on the name-collection step
            const flows = agent.getFlows();
            const regFlow = flows.find(f => f.title === "Registration")!;
            const nameStep = regFlow.getStep("ask_name")!

            let session = createSession<TestData>({ data: {} });
            session = enterFlow(session, regFlow.id, regFlow.title);
            session = enterStep(session, nameStep.id, nameStep.description);

            // Configure provider to return extracted name
            provider.extractionData = { name: "Alice" };

            // Respond with a message that contains a name
            const response = await agent.respond({
                history: [{ role: "user", content: "My name is Alice" }],
                session,
            });

            // The routing call (routing_output schema) should NOT have been made
            expect(provider.getRoutingCallCount()).toBe(0);

            // The session should retain the Registration flow
            expect(response.session.currentFlow?.title).toBe("Registration");
        });

        test("pre-extraction must populate a NEW collect field (not one already filled)", async () => {
            const provider = new RoutingTrackingProvider();
            const agent = createCollectAgent(provider);

            // Set up session with name already populated
            const flows = agent.getFlows();
            const regFlow = flows.find(f => f.title === "Registration")!;
            const nameStep = regFlow.getStep("ask_name")!;

            let session = createSession<TestData>({ data: { name: "Bob" } });
            session = enterFlow(session, regFlow.id, regFlow.title);
            session = enterStep(session, nameStep.id, nameStep.description);

            // Provider returns name again (already populated) — this shouldn't trigger skip
            provider.extractionData = { name: "Bob" };

            await agent.respond({
                history: [{ role: "user", content: "Actually I want help" }],
                session,
            });

            // Routing SHOULD have been called because the collect field wasn't newly populated
            expect(provider.getRoutingCallCount()).toBeGreaterThan(0);
        });
    });

    describe("Requirement 20.2: Retain current flow and step when skip applies", () => {
        test("session stays on same flow and step after routing skip", async () => {
            const provider = new RoutingTrackingProvider();
            const agent = createCollectAgent(provider);

            const flows = agent.getFlows();
            const regFlow = flows.find(f => f.title === "Registration")!;
            const nameStep = regFlow.getStep("ask_name")!;

            let session = createSession<TestData>({ data: {} });
            session = enterFlow(session, regFlow.id, regFlow.title);
            session = enterStep(session, nameStep.id, nameStep.description);

            provider.extractionData = { name: "Charlie" };

            const response = await agent.respond({
                history: [{ role: "user", content: "I'm Charlie" }],
                session,
            });

            // Flow is retained
            expect(response.session.currentFlow?.id).toBe(regFlow.id);
        });
    });

    describe("Requirement 20.3: Off-topic intent recovers next turn (acknowledged tradeoff)", () => {
        test("when user provides collect data AND off-topic intent, routing is skipped THIS turn", async () => {
            const provider = new RoutingTrackingProvider();
            const agent = createCollectAgent(provider);

            const flows = agent.getFlows();
            const regFlow = flows.find(f => f.title === "Registration")!;
            const nameStep = regFlow.getStep("ask_name")!;

            let session = createSession<TestData>({ data: {} });
            session = enterFlow(session, regFlow.id, regFlow.title);
            session = enterStep(session, nameStep.id, nameStep.description);

            // Pre-extraction sees "Alice" → populates name. The "help me" part
            // is off-topic but routing is skipped. It recovers on next turn.
            provider.extractionData = { name: "Alice" };

            const response = await agent.respond({
                history: [{ role: "user", content: "My name is Alice but also help me with something" }],
                session,
            });

            // Routing was skipped (tradeoff: off-topic intent lost this turn)
            expect(provider.getRoutingCallCount()).toBe(0);
            expect(response.session.currentFlow?.title).toBe("Registration");
        });

        test("on the NEXT turn (no collect populated), normal routing runs", async () => {
            const provider = new RoutingTrackingProvider();
            const agent = createCollectAgent(provider);

            const flows = agent.getFlows();
            const regFlow = flows.find(f => f.title === "Registration")!;
            const emailStep = regFlow.getStep("ask_email")!;

            // Session already has name; now on the email step
            let session = createSession<TestData>({ data: { name: "Alice" } });
            session = enterFlow(session, regFlow.id, regFlow.title);
            session = enterStep(session, emailStep.id, emailStep.description);

            // Pre-extraction returns nothing for email — user is off-topic
            provider.extractionData = {};

            await agent.respond({
                history: [{ role: "user", content: "I need support please" }],
                session,
            });

            // Routing SHOULD have run because pre-extraction didn't populate any collect field
            expect(provider.getRoutingCallCount()).toBeGreaterThan(0);
        });
    });

    describe("Edge cases", () => {
        test("no current flow/step → normal routing (no skip)", async () => {
            const provider = new RoutingTrackingProvider();
            const agent = createCollectAgent(provider);

            // Fresh session, no current flow
            const session = createSession<TestData>({ data: {} });
            provider.extractionData = { name: "Doesn't matter" };

            await agent.respond({
                history: [{ role: "user", content: "Hello" }],
                session,
            });

            // Routing should have run
            expect(provider.getRoutingCallCount()).toBeGreaterThan(0);
        });

        test("current step has no collect fields → normal routing (no skip)", async () => {
            const provider = new RoutingTrackingProvider();

            // Create an agent where a step has no collect
            const agent = new Agent<TestContext, TestData>({
                name: "NoCollectAgent",
                description: "Agent with steps that don't collect",
                goal: "Test",
                context: { userId: "test" },
                provider,
                schema: {
                    type: "object",
                    properties: {
                        name: { type: "string", description: "Name" },
                    },
                },
                flows: [
                    {
                        title: "Greeting",
                        when: "user says hello",
                        steps: [
                            { prompt: "Hello! How can I help?" }, // No collect
                        ],
                    },
                    {
                        title: "Other",
                        when: "user wants something else",
                        steps: [{ prompt: "Sure thing." }],
                    },
                ],
            });

            const flows = agent.getFlows();
            const greetFlow = flows.find(f => f.title === "Greeting")!;
            const step = greetFlow.getAllSteps()[0];

            let session = createSession<TestData>({ data: {} });
            session = enterFlow(session, greetFlow.id, greetFlow.title);
            session = enterStep(session, step.id, step.description);

            provider.extractionData = { name: "Alice" };

            await agent.respond({
                history: [{ role: "user", content: "My name is Alice" }],
                session,
            });

            // Routing should have run because step has no collect fields
            expect(provider.getRoutingCallCount()).toBeGreaterThan(0);
        });

        test("pending directive takes priority over routing skip", async () => {
            const provider = new RoutingTrackingProvider();
            const agent = createCollectAgent(provider);

            const flows = agent.getFlows();
            const regFlow = flows.find(f => f.title === "Registration")!;
            const supportFlow = flows.find(f => f.title === "Support")!;
            const nameStep = regFlow.getStep("ask_name")!;

            let session = createSession<TestData>({ data: {} });
            session = enterFlow(session, regFlow.id, regFlow.title);
            session = enterStep(session, nameStep.id, nameStep.description);
            // Set a pending directive that should override everything
            session.pendingDirective = { goTo: supportFlow.id };

            provider.extractionData = { name: "Alice" };

            const response = await agent.respond({
                history: [{ role: "user", content: "My name is Alice" }],
                session,
            });

            // Pending directive should have fired — we should end up in Support, not Registration
            expect(response.session.currentFlow?.title).toBe("Support");
        });
    });
});
