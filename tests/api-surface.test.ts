/**
 * API Surface Integration Tests
 *
 * Phase D verification that the public API surface is correct at the
 * integration level. Covers:
 * - createAgent constructs correctly with schema+provider+flows
 * - Invalid collect field throws FlowConfigurationError at construction
 * - routerMode validation (NotImplementedError for non-'ai' values)
 * - Public surface: StepRef importable, ResponsePipeline not exported
 * - Routing skip integration (pre-extraction populated collect → no router call)
 *
 * **Validates: Requirements 14.1–14.7, 15.1–15.4, 20.1–20.3, 21.1–21.3**
 */

import { describe, test, expect } from "bun:test";
import {
    createAgent,
    Agent,
    NotImplementedError,
    FlowConfigurationError,
    createSession,
    enterFlow,
    enterStep,
} from "../src/index";
import type { StepRef } from "../src/index";
import type {
    GenerateMessageInput,
    GenerateMessageOutput,
    GenerateMessageStreamChunk,
} from "../src/types";
import type { AiProvider } from "../src/types/ai";

// ─── Test types ──────────────────────────────────────────────────────────────

interface TestData {
    name?: string;
    email?: string;
    age?: number;
}

interface TestContext {
    userId: string;
}

// ─── Provider that tracks call counts ────────────────────────────────────────

class CallTrackingProvider implements AiProvider {
    public readonly name = "CallTrackingProvider";
    public calls: { schemaName?: string; prompt: string }[] = [];
    public extractionData: Partial<TestData> = {};

    async generateMessage<TContext = unknown, TStructured = unknown>(
        input: GenerateMessageInput<TContext>
    ): Promise<GenerateMessageOutput<TStructured>> {
        const schemaName = input.parameters?.schemaName || "";
        this.calls.push({ schemaName, prompt: input.prompt });

        // Data extraction call
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
                flowIds.forEach((flowId, i) => {
                    flows[flowId] = 80 - i * 10;
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
        yield {
            delta: "OK",
            accumulated: "OK",
            done: true,
            metadata: { model: "mock", tokensUsed: 10, finishReason: "stop" },
        };
    }

    reset(): void {
        this.calls = [];
        this.extractionData = {};
    }

    getRoutingCallCount(): number {
        return this.calls.filter((c) => c.schemaName === "routing_output").length;
    }
}

// ─── Minimal mock provider for construction tests ────────────────────────────

const minimalProvider: AiProvider = {
    name: "MinimalMock",
    async generateMessage() {
        return {
            message: "ok",
            metadata: { model: "mock", tokensUsed: 10, finishReason: "stop" },
            structured: { message: "ok" },
        };
    },
    async *generateMessageStream() {
        yield { delta: "ok", accumulated: "ok", done: true, metadata: { model: "mock", tokensUsed: 10, finishReason: "stop" } };
    },
} as any;

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("API Surface Integration", () => {
    describe("createAgent({ schema, provider, flows }) — Requirement 14.1–14.7", () => {
        test("constructs an agent with full generic inference from schema through flows", () => {
            const agent = createAgent<TestContext, TestData>({
                name: "IntegrationBot",
                provider: minimalProvider,
                context: { userId: "u1" },
                schema: {
                    type: "object",
                    properties: {
                        name: { type: "string", description: "User name" },
                        email: { type: "string", description: "User email" },
                        age: { type: "number", description: "User age" },
                    },
                },
                flows: [
                    {
                        title: "Onboarding",
                        when: "user wants to register",
                        requiredFields: ["name", "email"],
                        steps: [
                            { description: "ask_name", prompt: "What is your name?", collect: ["name"] },
                            { description: "ask_email", prompt: "What is your email?", collect: ["email"] },
                        ],
                    },
                ],
            });

            expect(agent).toBeInstanceOf(Agent);
            expect(agent.flows.length).toBe(1);
            expect(agent.flows[0].title).toBe("Onboarding");
        });

        test("agent.createFlow still available as escape hatch (Requirement 14.6)", () => {
            const agent = createAgent({
                name: "EscapeBot",
                provider: minimalProvider,
            });

            expect(typeof agent.createFlow).toBe("function");
        });
    });

    describe("Invalid collect field throws FlowConfigurationError — Requirement 14.5", () => {
        test("collect referencing non-schema key throws at construction", () => {
            expect(() => {
                createAgent<TestContext, TestData>({
                    name: "BadBot",
                    provider: minimalProvider,
                    schema: {
                        type: "object",
                        properties: {
                            name: { type: "string", description: "User name" },
                            email: { type: "string", description: "User email" },
                        },
                    },
                    flows: [
                        {
                            title: "Bad Flow",
                            steps: [
                                {
                                    description: "bad_step",
                                    prompt: "Collecting invalid field",
                                    collect: ["name", "nonexistent_field"] as any,
                                },
                            ],
                        },
                    ],
                });
            }).toThrow(/invalid collect fields.*nonexistent_field|nonexistent_field/i);
        });

        test("valid collect fields pass construction without error", () => {
            const agent = createAgent<TestContext, TestData>({
                name: "GoodBot",
                provider: minimalProvider,
                schema: {
                    type: "object",
                    properties: {
                        name: { type: "string", description: "User name" },
                        email: { type: "string", description: "User email" },
                    },
                },
                flows: [
                    {
                        title: "Good Flow",
                        steps: [
                            { description: "s1", prompt: "Name?", collect: ["name"] as any },
                            { description: "s2", prompt: "Email?", collect: ["email"] as any },
                        ],
                    },
                ],
            });

            expect(agent.flows.length).toBe(1);
        });
    });

    describe("routerMode reservation — Requirement 21.1–21.3", () => {
        test("routerMode: 'embedding' throws NotImplementedError naming the value", () => {
            expect(() => {
                createAgent({
                    name: "EmbedBot",
                    provider: minimalProvider,
                    routerMode: "embedding",
                } as any);
            }).toThrow(NotImplementedError);

            try {
                createAgent({
                    name: "EmbedBot",
                    provider: minimalProvider,
                    routerMode: "embedding",
                } as any);
            } catch (err) {
                expect(err).toBeInstanceOf(NotImplementedError);
                expect((err as Error).message).toContain("embedding");
            }
        });

        test("routerMode: 'ai' constructs OK", () => {
            const agent = createAgent({
                name: "AiBot",
                provider: minimalProvider,
                routerMode: "ai",
            } as any);

            expect(agent).toBeInstanceOf(Agent);
        });
    });

    describe("Public surface audit — Requirement 15.1–15.4", () => {
        test("StepRef is importable from @falai/agent", () => {
            // This test validates that the StepRef type is accessible.
            // If this compiles and runs, StepRef is part of the public surface.
            const ref: StepRef = { id: "step-1", description: "Test step" };
            expect(ref.id).toBe("step-1");
        });

        test("ResponsePipeline is NOT exported from the package", () => {
            // Runtime check: attempt to access ResponsePipeline from the index exports.
            // The public barrel (src/index.ts) should NOT re-export it.
            const exports = require("../src/index");
            expect(exports.ResponsePipeline).toBeUndefined();
        });

        test("internal classes are not on the public surface", () => {
            const exports = require("../src/index");
            // Requirement 15.2: these should NOT be exported
            expect(exports.BatchExecutor).toBeUndefined();
            expect(exports.BatchPromptBuilder).toBeUndefined();
            expect(exports.PromptComposer).toBeUndefined();
            expect(exports.PromptSectionCache).toBeUndefined();
            expect(exports.CompactionEngine).toBeUndefined();
            expect(exports.FlowRouter).toBeUndefined();
            expect(exports.AutoChainExecutor).toBeUndefined();
        });

        test("removed v1 types are not on the public surface (Requirement 15.3)", () => {
            const exports = require("../src/index");
            expect(exports.FlowDirective).toBeUndefined();
            expect(exports.GoToFlowDirective).toBeUndefined();
            expect(exports.GoToStepDirective).toBeUndefined();
            expect(exports.CompleteDirective).toBeUndefined();
            expect(exports.AbortDirective).toBeUndefined();
            expect(exports.ResetDirective).toBeUndefined();
            expect(exports.FlowTransitionConfig).toBeUndefined();
            expect(exports.FlowCompletionHandler).toBeUndefined();
        });

        test("stable surface elements ARE exported (Requirement 15.1)", () => {
            const exports = require("../src/index");
            expect(exports.Agent).toBeDefined();
            expect(exports.Flow).toBeDefined();
            expect(exports.Step).toBeDefined();
            expect(exports.createAgent).toBeDefined();
            expect(exports.NotImplementedError).toBeDefined();
            expect(exports.FlowConfigurationError).toBeDefined();
        });
    });

    describe("Routing skip integration — Requirement 20.1–20.3", () => {
        test("pre-extraction populated collect field → no FlowRouter call this turn", async () => {
            const provider = new CallTrackingProvider();

            const agent = new Agent<TestContext, TestData>({
                name: "RoutingSkipBot",
                description: "Tests routing skip",
                goal: "Collect data",
                context: { userId: "u1" },
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
                    {
                        title: "Support",
                        when: "user needs help",
                        steps: [{ id: "ask_q", prompt: "How can I help?" }],
                    },
                ],
            });

            // Set up session in the Registration flow, on the name-collection step
            const flows = agent.getFlows();
            const regFlow = flows.find((f) => f.title === "Registration")!;
            const nameStep = regFlow.getStep("ask_name")!;

            let session = createSession<TestData>({ data: {} });
            session = enterFlow(session, regFlow.id, regFlow.title);
            session = enterStep(session, nameStep.id, nameStep.description);

            // Configure provider to return extracted name field (populates collect)
            provider.extractionData = { name: "Alice" };

            const response = await agent.respond({
                history: [{ role: "user", content: "My name is Alice" }],
                session,
            });

            // Routing call count should be 0 — routing was skipped
            expect(provider.getRoutingCallCount()).toBe(0);
            // Flow is retained
            expect(response.session.currentFlow?.title).toBe("Registration");
        });
    });
});
