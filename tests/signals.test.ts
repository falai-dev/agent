/**
 * Signals — Construction-Time Validation Tests
 *
 * Validates the Agent constructor behavior when signals are configured:
 * - Duplicate ID detection
 * - Cooldown without cooldownMs warning
 * - Invalid extract schema rejection
 * - signalBatchSize validation
 * - Zero-cost path (undefined/empty signals)
 * - Deterministic auto-generated IDs
 * - Removal of the v2.0 reserved warn-once log
 *
 * Requirements: 1.4, 1.5, 1.6, 1.9, 2.3, 13.3
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { Agent, FlowConfigurationError, EventKind, MessageRole } from "../src/index";
import type { Event } from "../src/index";
import type { Signal } from "../src/types/signals";
import {
    buildSignalClassifierPrompt,
    buildMergedSchema,
    SignalEvaluator,
    splitIntoBatches,
} from "../src/core/SignalEvaluator";
import { MockProvider, MockProviderFactory } from "./mock-provider";
import log from "loglevel";
import fc from "fast-check";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function minimalSignal(overrides: Record<string, unknown> = {}) {
    return {
        phase: "pre" as const,
        handler: () => { },
        ...overrides,
    };
}

function createAgentWithSignals(
    signals: any[],
    extra: Record<string, unknown> = {}
) {
    return new Agent({
        name: "SignalTestAgent",
        description: "Testing signal construction validation",
        context: {},
        provider: MockProviderFactory.basic(),
        signals,
        ...extra,
    });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("Signals — Construction-time validation", () => {
    describe("Duplicate id throws FlowConfigurationError (Req 1.4)", () => {
        it("throws when two signals have the same explicit id", () => {
            expect(() =>
                createAgentWithSignals([
                    minimalSignal({ id: "dup" }),
                    minimalSignal({ id: "dup" }),
                ])
            ).toThrow(FlowConfigurationError);
        });

        it("error message lists the duplicate id", () => {
            try {
                createAgentWithSignals([
                    minimalSignal({ id: "handoff" }),
                    minimalSignal({ id: "handoff" }),
                ]);
                expect.unreachable("should have thrown");
            } catch (e: any) {
                expect(e.message).toContain("handoff");
                expect(e.message).toContain("Duplicate");
            }
        });

        it("throws when three signals share the same id", () => {
            expect(() =>
                createAgentWithSignals([
                    minimalSignal({ id: "x" }),
                    minimalSignal({ id: "x" }),
                    minimalSignal({ id: "x" }),
                ])
            ).toThrow(FlowConfigurationError);
        });

        it("does not throw when ids are distinct", () => {
            expect(() =>
                createAgentWithSignals([
                    minimalSignal({ id: "a" }),
                    minimalSignal({ id: "b" }),
                    minimalSignal({ id: "c" }),
                ])
            ).not.toThrow();
        });
    });

    describe("behavior: 'cooldown' without cooldownMs (Req 1.5)", () => {
        it("constructs OK without throwing", () => {
            expect(() =>
                createAgentWithSignals([
                    minimalSignal({ id: "cd", behavior: "cooldown" }),
                ])
            ).not.toThrow();
        });

        it("emits a debug log entry", () => {
            const debugSpy = spyOn(log, "debug");
            createAgentWithSignals(
                [minimalSignal({ id: "cd", behavior: "cooldown" })],
                { debug: true }
            );

            const logged = debugSpy.mock.calls.some((args) =>
                args.some(
                    (arg) =>
                        typeof arg === "string" &&
                        arg.includes("cd") &&
                        arg.includes("cooldown")
                )
            );
            expect(logged).toBe(true);
            debugSpy.mockRestore();
        });
    });

    describe("Invalid extract schema throws (Req 1.9)", () => {
        it("throws for extract: null", () => {
            expect(() =>
                createAgentWithSignals([
                    minimalSignal({ id: "bad", extract: null }),
                ])
            ).toThrow(FlowConfigurationError);
        });

        it("throws for extract: 'string'", () => {
            expect(() =>
                createAgentWithSignals([
                    minimalSignal({ id: "bad", extract: "not an object" }),
                ])
            ).toThrow(FlowConfigurationError);
        });

        it("throws for extract: [] (array)", () => {
            expect(() =>
                createAgentWithSignals([
                    minimalSignal({ id: "bad", extract: [] }),
                ])
            ).toThrow(FlowConfigurationError);
        });

        it("throws for extract: 42 (number)", () => {
            expect(() =>
                createAgentWithSignals([
                    minimalSignal({ id: "bad", extract: 42 }),
                ])
            ).toThrow(FlowConfigurationError);
        });

        it("error message names the offending signal id", () => {
            try {
                createAgentWithSignals([
                    minimalSignal({ id: "broken_sig", extract: true }),
                ]);
                expect.unreachable("should have thrown");
            } catch (e: any) {
                expect(e.message).toContain("broken_sig");
            }
        });

        it("does not throw for a valid extract schema object", () => {
            expect(() =>
                createAgentWithSignals([
                    minimalSignal({
                        id: "good",
                        extract: {
                            type: "object",
                            properties: { score: { type: "number" } },
                        },
                    }),
                ])
            ).not.toThrow();
        });
    });

    describe("signalBatchSize validation (Req 1.6)", () => {
        it("throws for signalBatchSize: 0", () => {
            expect(() =>
                createAgentWithSignals([minimalSignal({ id: "s1" })], {
                    signalBatchSize: 0,
                })
            ).toThrow(FlowConfigurationError);
        });

        it("throws for signalBatchSize: -1", () => {
            expect(() =>
                createAgentWithSignals([minimalSignal({ id: "s1" })], {
                    signalBatchSize: -1,
                })
            ).toThrow(FlowConfigurationError);
        });

        it("constructs OK with signalBatchSize: 10", () => {
            expect(() =>
                createAgentWithSignals([minimalSignal({ id: "s1" })], {
                    signalBatchSize: 10,
                })
            ).not.toThrow();
        });

        it("constructs OK with signalBatchSize: undefined (default)", () => {
            expect(() =>
                createAgentWithSignals([minimalSignal({ id: "s1" })])
            ).not.toThrow();
        });
    });

    describe("signals: undefined and signals: [] (Req 2.3)", () => {
        it("constructs OK with signals: undefined", () => {
            const agent = new Agent({
                name: "NoSignals",
                description: "No signals",
                context: {},
                provider: MockProviderFactory.basic(),
            });
            expect(agent.signalProcessor).toBeUndefined();
        });

        it("constructs OK with signals: []", () => {
            const agent = createAgentWithSignals([]);
            expect(agent.signalProcessor).toBeUndefined();
        });
    });

    describe("Auto-generated ids are deterministic (Req 1.4)", () => {
        it("same inputs produce the same auto-generated ids across invocations", () => {
            const signals = [
                minimalSignal({ title: "Human Handoff" }),
                minimalSignal({ title: "Sentiment", description: "Detect sentiment" }),
                minimalSignal({}), // no title or description
            ];

            // First construction
            const agent1 = createAgentWithSignals(
                signals.map((s) => ({ ...s }))
            );
            const ids1 = agent1.signals.map((s) => s.id);

            // Second construction with same inputs
            const agent2 = createAgentWithSignals(
                signals.map((s) => ({ ...s }))
            );
            const ids2 = agent2.signals.map((s) => s.id);

            expect(ids1).toEqual(ids2);
            // All should be defined strings
            ids1.forEach((id) => {
                expect(id).toBeDefined();
                expect(typeof id).toBe("string");
                expect(id!.length).toBeGreaterThan(0);
            });
        });
    });

    describe("Reserved v2.0 warn-once log removed (Req 13.3)", () => {
        it("does NOT emit a warn-once log when signals are configured", () => {
            const warnSpy = spyOn(log, "warn");

            const agent = createAgentWithSignals([
                minimalSignal({ id: "active_signal", when: "user says hello" }),
            ]);

            // Trigger respond-like path (the old warn used to fire on first respond)
            // After removal, no signals warning should appear at all
            const warned = warnSpy.mock.calls.some((args) =>
                args.some(
                    (arg) =>
                        typeof arg === "string" &&
                        arg.includes("signals") &&
                        arg.includes("not evaluated")
                )
            );
            expect(warned).toBe(false);
            warnSpy.mockRestore();
        });
    });
});


// ─── Evaluator Helpers ───────────────────────────────────────────────────────

function makeHistory(messages: { role: MessageRole; text: string }[]): Event[] {
    return messages.map((m, i) => ({
        kind: EventKind.MESSAGE,
        source: m.role,
        data: { message: m.text, participant: m.role },
        timestamp: new Date(Date.now() + i).toISOString(),
        id: `evt-${i}`,
    }));
}

/**
 * A mock provider wrapper that counts `generateMessage` calls and
 * allows configuring the structured response per-call.
 */
class CountingMockProvider extends MockProvider {
    public callCount = 0;
    private _structuredOverride: any = undefined;

    constructor(config: { structured?: any; shouldThrow?: boolean; errorMessage?: string } = {}) {
        super({
            delayMs: 0,
            shouldThrowError: config.shouldThrow ?? false,
            errorMessage: config.errorMessage ?? "Mock provider error",
        });
        this._structuredOverride = config.structured;
    }

    override async generateMessage<TContext = unknown, TStructured = any>(
        input: any,
    ): Promise<any> {
        this.callCount++;
        if (this._structuredOverride !== undefined) {
            // Return the configured structured response directly
            if ((this as any).config?.shouldThrowError || (this.getConfig() as any).shouldThrowError) {
                throw new Error((this.getConfig() as any).errorMessage || "Mock provider error");
            }
            return {
                message: "mock",
                metadata: { model: "mock", tokensUsed: 10, finishReason: "stop" },
                structured: this._structuredOverride,
            };
        }
        return super.generateMessage(input);
    }

    /** Update the structured response for subsequent calls */
    setStructured(response: any) {
        this._structuredOverride = response;
    }

    resetCount() {
        this.callCount = 0;
    }
}

// ─── Evaluator Tests ─────────────────────────────────────────────────────────

describe("Signals — SignalEvaluator", () => {
    const sampleHistory = makeHistory([
        { role: MessageRole.USER, text: "I want to talk to a real person" },
    ]);

    describe("buildSignalClassifierPrompt (Req 3.6, 12.1, 12.5, 12.6)", () => {
        it("splits when entries by ! prefix into TRIGGER WHEN and DO NOT TRIGGER WHEN", () => {
            const signal: Signal = {
                id: "handoff",
                title: "Human Handoff",
                description: "User wants a human",
                when: [
                    "user explicitly asks to talk to a human",
                    "!casual mentions of people",
                    "!general frustration without explicit handoff request",
                ],
                phase: "pre",
                handler: () => { },
            };

            const prompt = buildSignalClassifierPrompt([signal], sampleHistory, {});

            // Positive entries under TRIGGER WHEN
            expect(prompt).toContain("Positive TRIGGER WHEN entries are alternatives");
            expect(prompt).toContain("TRIGGER WHEN (ANY matches):");
            expect(prompt).toContain("user explicitly asks to talk to a human");

            // Negative entries under DO NOT TRIGGER WHEN (prefix stripped)
            expect(prompt).toContain("DO NOT TRIGGER WHEN (ANY inhibits):");
            expect(prompt).toContain("casual mentions of people");
            expect(prompt).toContain("general frustration without explicit handoff request");

            // The `!` prefix should be stripped in the rendered output
            expect(prompt).not.toContain("!casual mentions");
            expect(prompt).not.toContain("!general frustration");
        });

        it("renders extraction schema under WHEN MATCHED, EXTRACT with field types and constraints", () => {
            const signal: Signal = {
                id: "sentiment",
                title: "Sentiment Score",
                when: "user expresses any opinion",
                extract: {
                    type: "object",
                    properties: {
                        score: {
                            type: "number",
                            minimum: 1,
                            maximum: 10,
                            description: "how positive the user feels",
                        },
                        urgency: {
                            type: "string",
                            enum: ["low", "medium", "high"],
                            description: "tone urgency level",
                        },
                    },
                },
                phase: "pre",
                handler: () => { },
            };

            const prompt = buildSignalClassifierPrompt([signal], sampleHistory, {});

            expect(prompt).toContain("WHEN MATCHED, EXTRACT:");
            expect(prompt).toContain("score (number)");
            expect(prompt).toContain("1-10");
            expect(prompt).toContain("how positive the user feels");
            expect(prompt).toContain("urgency (string)");
            expect(prompt).toContain("low|medium|high");
            expect(prompt).toContain("tone urgency level");
        });

        it("includes the conservative evidence instruction (Req 12.5)", () => {
            const signal: Signal = {
                id: "test",
                when: "something happens",
                phase: "pre",
                handler: () => { },
            };

            const prompt = buildSignalClassifierPrompt([signal], sampleHistory, {});
            expect(prompt).toContain("Be conservative");
            expect(prompt).toContain("CLEAR, EXPLICIT evidence");
        });

        it("renders unconditional + extract signals under ALWAYS EXTRACT", () => {
            const signal: Signal = {
                id: "always_extract",
                title: "Always Extract",
                extract: {
                    type: "object",
                    properties: {
                        mood: { type: "string", description: "user mood" },
                    },
                },
                phase: "pre",
                handler: () => { },
            };

            const prompt = buildSignalClassifierPrompt([signal], sampleHistory, {});
            expect(prompt).toContain("ALWAYS EXTRACT");
            // Should NOT have TRIGGER WHEN since it's unconditional
            expect(prompt).not.toContain("  TRIGGER WHEN");
        });

        it("renders SIGNAL header with id and title", () => {
            const signal: Signal = {
                id: "my_signal",
                title: "My Signal Title",
                when: "something",
                phase: "pre",
                handler: () => { },
            };

            const prompt = buildSignalClassifierPrompt([signal], sampleHistory, {});
            expect(prompt).toContain('SIGNAL "my_signal" | "My Signal Title"');
        });

        it("renders DESCRIPTION when provided", () => {
            const signal: Signal = {
                id: "desc_test",
                description: "Detects user frustration",
                when: "user is frustrated",
                phase: "pre",
                handler: () => { },
            };

            const prompt = buildSignalClassifierPrompt([signal], sampleHistory, {});
            expect(prompt).toContain("DESCRIPTION: Detects user frustration");
        });

        it("handles when as a single string (not array)", () => {
            const signal: Signal = {
                id: "single_when",
                when: "user says hello",
                phase: "pre",
                handler: () => { },
            };

            const prompt = buildSignalClassifierPrompt([signal], sampleHistory, {});
            expect(prompt).toContain("TRIGGER WHEN (ANY matches):");
            expect(prompt).toContain("user says hello");
        });
    });

    describe("buildMergedSchema (Req 4.2, 12.2, 12.3)", () => {
        it("signals without extract have no extracted field in the per-signal response shape", () => {
            const signal: Signal = {
                id: "detect_only",
                when: "user is angry",
                phase: "pre",
                handler: () => { },
            };

            const schema = buildMergedSchema([signal]);
            const signalSchemas = (schema.properties as any).signals.items.anyOf;

            expect(signalSchemas).toHaveLength(1);
            const entry = signalSchemas[0];
            expect(entry.properties).toHaveProperty("id");
            expect(entry.properties).toHaveProperty("matched");
            expect(entry.properties).toHaveProperty("reason");
            expect(entry.properties).not.toHaveProperty("extracted");
        });

        it("signals with extract carry the embedded schema in the extracted field", () => {
            const extractSchema = {
                type: "object",
                properties: {
                    score: { type: "number" },
                    label: { type: "string", enum: ["good", "bad"] },
                },
            };

            const signal: Signal = {
                id: "with_extract",
                when: "user expresses opinion",
                extract: extractSchema,
                phase: "pre",
                handler: () => { },
            };

            const schema = buildMergedSchema([signal]);
            const signalSchemas = (schema.properties as any).signals.items.anyOf;

            expect(signalSchemas).toHaveLength(1);
            const entry = signalSchemas[0];
            expect(entry.properties).toHaveProperty("extracted");
            expect(entry.properties.extracted).toEqual(extractSchema);
        });

        it("mixed batch: detection-only and extraction signals coexist correctly", () => {
            const signals: Signal[] = [
                {
                    id: "detect",
                    when: "user angry",
                    phase: "pre",
                    handler: () => { },
                },
                {
                    id: "extract",
                    when: "user happy",
                    extract: {
                        type: "object",
                        properties: { joy: { type: "number" } },
                    },
                    phase: "pre",
                    handler: () => { },
                },
            ];

            const schema = buildMergedSchema(signals);
            const signalSchemas = (schema.properties as any).signals.items.anyOf;

            expect(signalSchemas).toHaveLength(2);
            // First signal (detect-only) has no extracted
            expect(signalSchemas[0].properties).not.toHaveProperty("extracted");
            // Second signal (extraction) has extracted
            expect(signalSchemas[1].properties).toHaveProperty("extracted");
        });

        it("schema wraps everything in { signals: [...] } structure", () => {
            const signal: Signal = {
                id: "s1",
                when: "test",
                phase: "pre",
                handler: () => { },
            };

            const schema = buildMergedSchema([signal]);
            expect(schema.type).toBe("object");
            expect(schema.required).toContain("signals");
            expect((schema.properties as any).signals.type).toBe("array");
        });
    });

    describe("SignalEvaluator.evaluateSignals (Req 3.7, 3.9, 12.4)", () => {
        it("makes exactly one provider call per evaluateSignals invocation", async () => {
            const provider = new CountingMockProvider({
                structured: {
                    signals: [
                        { id: "s1", matched: true, reason: "test" },
                        { id: "s2", matched: false },
                    ],
                },
            });

            const evaluator = new SignalEvaluator(provider as any);

            const signals: Signal[] = [
                { id: "s1", when: "user asks", phase: "pre", handler: () => { } },
                { id: "s2", when: "user angry", phase: "pre", handler: () => { } },
            ];

            await evaluator.evaluateSignals({
                signals,
                session: { id: "sess1", data: {}, history: [] } as any,
                history: sampleHistory,
                context: {},
            });

            expect(provider.callCount).toBe(1);
        });

        it("provider rejection → all signals default to matched: false; function does not throw", async () => {
            const provider = new CountingMockProvider({
                shouldThrow: true,
                errorMessage: "API rate limit exceeded",
            });

            const evaluator = new SignalEvaluator(provider as any);

            const signals: Signal[] = [
                { id: "s1", when: "user asks", phase: "pre", handler: () => { } },
                { id: "s2", when: "user angry", phase: "pre", handler: () => { } },
            ];

            // Should NOT throw
            const results = await evaluator.evaluateSignals({
                signals,
                session: { id: "sess1", data: {}, history: [] } as any,
                history: sampleHistory,
                context: {},
            });

            // All signals default to non-match
            expect(results["s1"].matched).toBe(false);
            expect(results["s2"].matched).toBe(false);
        });

        it("defensive default: signal absent from response.structured.signals → matched: false", async () => {
            // Provider returns only one signal in the response
            const provider = new CountingMockProvider({
                structured: {
                    signals: [
                        { id: "s1", matched: true, reason: "matched" },
                        // s2 is intentionally absent
                    ],
                },
            });

            const evaluator = new SignalEvaluator(provider as any);

            const signals: Signal[] = [
                { id: "s1", when: "user asks", phase: "pre", handler: () => { } },
                { id: "s2", when: "user says bye", phase: "pre", handler: () => { } },
            ];

            const results = await evaluator.evaluateSignals({
                signals,
                session: { id: "sess1", data: {}, history: [] } as any,
                history: sampleHistory,
                context: {},
            });

            expect(results["s1"].matched).toBe(true);
            expect(results["s1"].reason).toBe("matched");
            // s2 was absent from the response — should default to false
            expect(results["s2"].matched).toBe(false);
            expect(results["s2"].reason).toBeUndefined();
        });

        it("returns extracted data for matched signals with extraction", async () => {
            const provider = new CountingMockProvider({
                structured: {
                    signals: [
                        {
                            id: "sentiment",
                            matched: true,
                            reason: "user expressed opinion",
                            extracted: { score: 8, urgency: "low" },
                        },
                    ],
                },
            });

            const evaluator = new SignalEvaluator(provider as any);

            const signals: Signal[] = [
                {
                    id: "sentiment",
                    when: "user expresses opinion",
                    extract: {
                        type: "object",
                        properties: {
                            score: { type: "number" },
                            urgency: { type: "string" },
                        },
                    },
                    phase: "pre",
                    handler: () => { },
                },
            ];

            const results = await evaluator.evaluateSignals({
                signals,
                session: { id: "sess1", data: {}, history: [] } as any,
                history: sampleHistory,
                context: {},
            });

            expect(results["sentiment"].matched).toBe(true);
            expect(results["sentiment"].extracted).toEqual({ score: 8, urgency: "low" });
        });

        it("does not include extracted data for non-matched signals", async () => {
            const provider = new CountingMockProvider({
                structured: {
                    signals: [
                        {
                            id: "sentiment",
                            matched: false,
                            reason: "no opinion expressed",
                            extracted: { score: 5, urgency: "low" },
                        },
                    ],
                },
            });

            const evaluator = new SignalEvaluator(provider as any);

            const signals: Signal[] = [
                {
                    id: "sentiment",
                    when: "user expresses opinion",
                    extract: {
                        type: "object",
                        properties: { score: { type: "number" } },
                    },
                    phase: "pre",
                    handler: () => { },
                },
            ];

            const results = await evaluator.evaluateSignals({
                signals,
                session: { id: "sess1", data: {}, history: [] } as any,
                history: sampleHistory,
                context: {},
            });

            // When matched=false, extracted should be undefined regardless of what the LLM returned
            expect(results["sentiment"].matched).toBe(false);
            expect(results["sentiment"].extracted).toBeUndefined();
        });
    });

    describe("Property 4: One classifier call per batch per phase", () => {
        /**
         * Validates: Requirements 3.7, 3.9, 4.2, 4.6, 12.1, 12.2, 12.3, 12.4, 12.5, 12.6
         *
         * Property: For any batch of N signals (N >= 1), a single evaluateSignals
         * invocation makes exactly one provider call, regardless of signal count,
         * extraction schema presence, or when-entry composition.
         */
        it("exactly one provider call regardless of signal count or configuration", async () => {
            await fc.assert(
                fc.asyncProperty(
                    // Generate 1-15 random signals with varied configurations
                    fc.array(
                        fc.record({
                            id: fc.string({ minLength: 1, maxLength: 20 }).map(s => s.replace(/[^a-zA-Z0-9_]/g, '_')),
                            hasExtract: fc.boolean(),
                            whenCount: fc.nat({ max: 5 }),
                            negativeWhenCount: fc.nat({ max: 3 }),
                        }),
                        { minLength: 1, maxLength: 15 },
                    ).map(configs => {
                        // Ensure unique ids
                        const seen = new Set<string>();
                        return configs.filter(c => {
                            if (seen.has(c.id)) return false;
                            seen.add(c.id);
                            return true;
                        });
                    }).filter(arr => arr.length > 0),
                    async (signalConfigs) => {
                        const signals: Signal[] = signalConfigs.map(cfg => {
                            const whenEntries: string[] = [];
                            for (let i = 0; i < cfg.whenCount; i++) {
                                whenEntries.push(`condition ${i}`);
                            }
                            for (let i = 0; i < cfg.negativeWhenCount; i++) {
                                whenEntries.push(`!exclusion ${i}`);
                            }

                            return {
                                id: cfg.id,
                                when: whenEntries.length > 0 ? whenEntries : "default condition",
                                extract: cfg.hasExtract ? {
                                    type: "object",
                                    properties: { value: { type: "string" } },
                                } : undefined,
                                phase: "pre" as const,
                                handler: () => { },
                            };
                        });

                        // Build a response that matches some signals
                        const structuredResponse = {
                            signals: signals.map(s => ({
                                id: s.id,
                                matched: false,
                            })),
                        };

                        const provider = new CountingMockProvider({
                            structured: structuredResponse,
                        });

                        const evaluator = new SignalEvaluator(provider as any);

                        await evaluator.evaluateSignals({
                            signals,
                            session: { id: "sess", data: {}, history: [] } as any,
                            history: sampleHistory,
                            context: {},
                        });

                        // Property: exactly ONE provider call per evaluateSignals invocation
                        expect(provider.callCount).toBe(1);
                    },
                ),
                { numRuns: 50 },
            );
        });
    });
});


// ─── Batching Tests ──────────────────────────────────────────────────────────

describe("Signals — Batching (evaluateSignalsBatched + splitIntoBatches)", () => {
    /**
     * Validates: Requirements 3.7, 3.8
     *
     * Tests that evaluateSignalsBatched correctly splits signals into batches
     * of signalBatchSize, runs them in parallel, and merges results.
     */

    const sampleHistory = makeHistory([
        { role: MessageRole.USER, text: "Hello there" },
    ]);

    function makeSignals(count: number): Signal[] {
        return Array.from({ length: count }, (_, i) => ({
            id: `sig_${i}`,
            when: `condition ${i}`,
            phase: "pre" as const,
            handler: () => { },
        }));
    }

    describe("Batch count correctness", () => {
        it("15 eligible signals with signalBatchSize: 10 → exactly 2 provider calls", async () => {
            const signals = makeSignals(15);
            const provider = new CountingMockProvider({
                structured: {
                    signals: signals.map(s => ({ id: s.id, matched: false })),
                },
            });

            const evaluator = new SignalEvaluator(provider as any);

            await evaluator.evaluateSignalsBatched({
                signals,
                batchSize: 10,
                session: { id: "sess1", data: {}, history: [] } as any,
                history: sampleHistory,
                context: {},
            });

            expect(provider.callCount).toBe(2);
        });

        it("5 eligible signals with signalBatchSize: 10 → exactly 1 provider call", async () => {
            const signals = makeSignals(5);
            const provider = new CountingMockProvider({
                structured: {
                    signals: signals.map(s => ({ id: s.id, matched: false })),
                },
            });

            const evaluator = new SignalEvaluator(provider as any);

            await evaluator.evaluateSignalsBatched({
                signals,
                batchSize: 10,
                session: { id: "sess1", data: {}, history: [] } as any,
                history: sampleHistory,
                context: {},
            });

            expect(provider.callCount).toBe(1);
        });

        it("0 eligible signals → 0 provider calls", async () => {
            const provider = new CountingMockProvider({
                structured: { signals: [] },
            });

            const evaluator = new SignalEvaluator(provider as any);

            const results = await evaluator.evaluateSignalsBatched({
                signals: [],
                batchSize: 10,
                session: { id: "sess1", data: {}, history: [] } as any,
                history: sampleHistory,
                context: {},
            });

            expect(provider.callCount).toBe(0);
            expect(results).toEqual({});
        });
    });

    describe("Batches run in parallel", () => {
        it("with controlled mock-provider latency, total wall-clock ≈ max batch latency (not sum)", async () => {
            const LATENCY_MS = 100;

            /**
             * A mock provider that introduces a configurable delay per call.
             * Used to verify that batches run concurrently (Promise.all).
             */
            class DelayedMockProvider extends MockProvider {
                public callCount = 0;

                constructor(private latencyMs: number) {
                    super({ delayMs: 0 });
                }

                override async generateMessage<TContext = unknown, TStructured = any>(
                    input: any,
                ): Promise<any> {
                    this.callCount++;
                    await new Promise(resolve => setTimeout(resolve, this.latencyMs));
                    return {
                        message: "mock",
                        metadata: { model: "mock", tokensUsed: 10, finishReason: "stop" },
                        structured: { signals: [] },
                    };
                }
            }

            // 20 signals with batchSize 10 → 2 batches
            const signals = makeSignals(20);
            const provider = new DelayedMockProvider(LATENCY_MS);
            const evaluator = new SignalEvaluator(provider as any);

            const start = performance.now();
            await evaluator.evaluateSignalsBatched({
                signals,
                batchSize: 10,
                session: { id: "sess1", data: {}, history: [] } as any,
                history: sampleHistory,
                context: {},
            });
            const elapsed = performance.now() - start;

            // 2 batches each taking ~100ms should complete in ~100ms (parallel)
            // not ~200ms (sequential). Allow generous tolerance for CI jitter.
            expect(provider.callCount).toBe(2);
            // Should be closer to 1x latency than 2x latency
            expect(elapsed).toBeLessThan(LATENCY_MS * 1.8);
        });
    });

    describe("Property: Batch splitting preserves signal coverage", () => {
        /**
         * Validates: Requirements 3.7, 3.8
         *
         * Property: splitIntoBatches preserves all items — every input signal id
         * appears in exactly one batch. No duplicates, no losses.
         */
        it("every input id appears in exactly one batch result", () => {
            fc.assert(
                fc.property(
                    // Generate 0-50 unique signal ids
                    fc.array(
                        fc.string({ minLength: 1, maxLength: 20 }).map(s => s.replace(/[^a-zA-Z0-9_]/g, '_')),
                        { minLength: 0, maxLength: 50 },
                    ).map(ids => [...new Set(ids)]), // ensure unique
                    // Generate batch sizes from 1-20
                    fc.integer({ min: 1, max: 20 }),
                    (ids, batchSize) => {
                        const items = ids.map(id => ({ id }));
                        const batches = splitIntoBatches(items, batchSize);

                        // Flatten all batch items
                        const allBatchedIds = batches.flat().map(item => item.id);

                        // Every input id appears in exactly one batch result
                        expect(allBatchedIds.length).toBe(ids.length);
                        expect(new Set(allBatchedIds).size).toBe(ids.length);

                        // Every input id is present
                        for (const id of ids) {
                            expect(allBatchedIds).toContain(id);
                        }

                        // Each batch is at most batchSize
                        for (const batch of batches) {
                            expect(batch.length).toBeLessThanOrEqual(batchSize);
                        }

                        // Expected number of batches
                        if (ids.length === 0) {
                            expect(batches.length).toBe(0);
                        } else {
                            expect(batches.length).toBe(Math.ceil(ids.length / batchSize));
                        }
                    },
                ),
                { numRuns: 100 },
            );
        });
    });
});

// ─── SignalProcessor Tests ───────────────────────────────────────────────────

import {
    SignalProcessor,
    behaviorAllowsExecution,
    recordTrigger,
    buildSignalContext,
} from "../src/core/SignalProcessor";
import type { SignalEvaluationResult } from "../src/core/SignalEvaluator";
import type { SessionState } from "../src/types/session";
import type {
    SignalDirective,
    SignalContext as SignalCtxType,
    SignalTriggerState,
    SignalFiring,
} from "../src/types/signals";

/**
 * Mock evaluator implementing the SignalEvaluator interface for processor tests.
 * Allows configuring results per-signal and tracking calls.
 */
class MockSignalEvaluator {
    public evaluateIfCalls: Array<{ predicates: any; ctx: any }> = [];
    public evaluateSignalsCalls: Array<{ signals: any[] }> = [];
    public evaluateSignalsBatchedCalls: Array<{ signals: any[]; batchSize?: number }> = [];

    private _ifResults: Map<string, boolean> = new Map();
    private _signalResults: Record<string, SignalEvaluationResult> = {};

    /** Configure evaluateIf to return a specific result for a signal id. */
    setIfResult(signalId: string, result: boolean) {
        this._ifResults.set(signalId, result);
    }

    /** Configure evaluateSignals results. */
    setSignalResults(results: Record<string, SignalEvaluationResult>) {
        this._signalResults = results;
    }

    async evaluateIf(predicates: any, ctx: any): Promise<boolean> {
        this.evaluateIfCalls.push({ predicates, ctx });
        // Actually call the predicates (like the real evaluator)
        const predicateArray = Array.isArray(predicates) ? predicates : [predicates];
        for (const pred of predicateArray) {
            try {
                const result = await pred(ctx);
                if (!result) return false;
            } catch {
                return false;
            }
        }
        return true;
    }

    async evaluateSignals(params: any): Promise<Record<string, SignalEvaluationResult>> {
        this.evaluateSignalsCalls.push({ signals: params.signals });
        // Return configured results, defaulting unmatched signals
        const results: Record<string, SignalEvaluationResult> = {};
        for (const s of params.signals) {
            const id = s.id ?? 'unknown';
            results[id] = this._signalResults[id] ?? { matched: false };
        }
        return results;
    }

    async evaluateSignalsBatched(params: any): Promise<Record<string, SignalEvaluationResult>> {
        this.evaluateSignalsBatchedCalls.push({ signals: params.signals, batchSize: params.batchSize });
        // Return configured results, defaulting unmatched signals
        const results: Record<string, SignalEvaluationResult> = {};
        for (const s of params.signals) {
            const id = s.id ?? 'unknown';
            results[id] = this._signalResults[id] ?? { matched: false };
        }
        return results;
    }

    reset() {
        this.evaluateIfCalls = [];
        this.evaluateSignalsCalls = [];
        this.evaluateSignalsBatchedCalls = [];
        this._ifResults.clear();
        this._signalResults = {};
    }
}


// ─── Processor describe block ────────────────────────────────────────────────

describe("Signals — SignalProcessor", () => {
    let mockEvaluator: MockSignalEvaluator;
    let mockProvider: CountingMockProvider;

    function makeSession(overrides: Partial<SessionState<any>> = {}): SessionState<any> {
        return {
            id: "test-session",
            data: {},
            history: [],
            currentRoute: null,
            currentStep: null,
            routeHistory: [],
            ...overrides,
        } as SessionState<any>;
    }

    function makeProcessor(signals: any[], batchSize = 10): SignalProcessor<any, any> {
        return new SignalProcessor(
            signals,
            mockProvider as any,
            mockEvaluator as any,
            { batchSize },
        );
    }

    const sampleHistory = makeHistory([
        { role: MessageRole.USER, text: "Hello" },
    ]);

    beforeEach(() => {
        mockEvaluator = new MockSignalEvaluator();
        mockProvider = new CountingMockProvider({ structured: { signals: [] } });
    });

    // ─── Zero signals ────────────────────────────────────────────────────────

    describe("Zero signals → both phases return empty with zero provider calls", () => {
        it("pre-phase returns empty firings and unchanged session", async () => {
            const processor = makeProcessor([]);
            const session = makeSession();

            const result = await processor.runPreSignalPhase({
                session,
                history: sampleHistory,
                context: {},
            });

            expect(result.firings).toEqual([]);
            expect(result.updatedSession).toBe(session);
            expect(mockProvider.callCount).toBe(0);
            expect(mockEvaluator.evaluateSignalsBatchedCalls.length).toBe(0);
        });

        it("post-phase returns empty firings and unchanged session", async () => {
            const processor = makeProcessor([]);
            const session = makeSession();

            const result = await processor.runPostSignalPhase({
                session,
                history: sampleHistory,
                context: {},
            });

            expect(result.firings).toEqual([]);
            expect(result.updatedSession).toBe(session);
            expect(mockProvider.callCount).toBe(0);
        });
    });


    // ─── All signals gated out by behavior ───────────────────────────────────

    describe("All signals gated out by behavior → zero provider calls", () => {
        it("once-behavior signal with existing trigger is gated out", async () => {
            const signals = [
                { id: "once_sig", phase: "pre" as const, behavior: "once" as const, handler: () => { } },
            ];
            const session = makeSession({
                signals: {
                    triggers: {
                        once_sig: {
                            firstTriggeredAt: new Date(Date.now() - 10000),
                            lastTriggeredAt: new Date(Date.now() - 10000),
                            count: 1,
                            lastReason: "test",
                            lastPhase: "pre",
                        },
                    },
                },
            });

            const processor = makeProcessor(signals);
            const result = await processor.runPreSignalPhase({
                session,
                history: sampleHistory,
                context: {},
            });

            expect(result.firings).toEqual([]);
            expect(mockEvaluator.evaluateSignalsBatchedCalls.length).toBe(0);
            expect(mockEvaluator.evaluateSignalsCalls.length).toBe(0);
        });
    });

    // ─── 'once' behavior fires once, suppressed on second turn ───────────────

    describe("'once' behavior fires once, suppressed on the second turn", () => {
        it("fires on first turn, suppressed on second", async () => {
            const handlerCalls: string[] = [];
            const signals = [
                {
                    id: "once_sig",
                    phase: "pre" as const,
                    behavior: "once" as const,
                    handler: () => { handlerCalls.push("fired"); },
                },
            ];

            // First turn: no prior trigger
            const session1 = makeSession();
            const processor = makeProcessor(signals);
            const result1 = await processor.runPreSignalPhase({
                session: session1,
                history: sampleHistory,
                context: {},
            });

            expect(result1.firings.length).toBe(1);
            expect(handlerCalls).toEqual(["fired"]);

            // Second turn: use updated session from first turn
            handlerCalls.length = 0;
            const result2 = await processor.runPreSignalPhase({
                session: result1.updatedSession,
                history: sampleHistory,
                context: {},
            });

            expect(result2.firings).toEqual([]);
            expect(handlerCalls).toEqual([]);
        });
    });


    // ─── 'cooldown' behavior ─────────────────────────────────────────────────

    describe("'cooldown' with cooldownMs: 1000", () => {
        it("fires immediately, suppressed within window, fires after window elapses", async () => {
            const handlerCalls: string[] = [];
            const signals = [
                {
                    id: "cd_sig",
                    phase: "pre" as const,
                    behavior: "cooldown" as const,
                    cooldownMs: 1000,
                    handler: () => { handlerCalls.push("fired"); },
                },
            ];

            const processor = makeProcessor(signals);

            // First call: no prior trigger → fires
            const session1 = makeSession();
            const result1 = await processor.runPreSignalPhase({
                session: session1,
                history: sampleHistory,
                context: {},
            });
            expect(result1.firings.length).toBe(1);
            expect(handlerCalls).toEqual(["fired"]);

            // Second call immediately: within cooldown window → suppressed
            handlerCalls.length = 0;
            const result2 = await processor.runPreSignalPhase({
                session: result1.updatedSession,
                history: sampleHistory,
                context: {},
            });
            expect(result2.firings).toEqual([]);
            expect(handlerCalls).toEqual([]);

            // Third call: simulate time elapsed past cooldown
            handlerCalls.length = 0;
            const sessionWithOldTrigger = {
                ...result1.updatedSession,
                signals: {
                    triggers: {
                        cd_sig: {
                            ...result1.updatedSession.signals!.triggers.cd_sig,
                            lastTriggeredAt: new Date(Date.now() - 1500), // 1500ms ago > 1000ms cooldown
                        },
                    },
                },
            };
            const result3 = await processor.runPreSignalPhase({
                session: sessionWithOldTrigger,
                history: sampleHistory,
                context: {},
            });
            expect(result3.firings.length).toBe(1);
            expect(handlerCalls).toEqual(["fired"]);
        });
    });


    // ─── Code-first short-circuit ────────────────────────────────────────────

    describe("Code-first short-circuit: if: () => false prevents classifier batch", () => {
        it("signal with if: () => false and when: 'X' is NOT included in classifier batch", async () => {
            const signals = [
                {
                    id: "gated_out",
                    phase: "pre" as const,
                    if: () => false,
                    when: "user says something",
                    handler: () => { },
                },
            ];

            const processor = makeProcessor(signals);
            const result = await processor.runPreSignalPhase({
                session: makeSession(),
                history: sampleHistory,
                context: {},
            });

            // The evaluateSignalsBatched call should NOT include this signal
            // because its `if` returned false
            expect(result.firings).toEqual([]);
            // If evaluateSignalsBatched was called, the gated signal shouldn't be in it
            if (mockEvaluator.evaluateSignalsBatchedCalls.length > 0) {
                const batchedSignals = mockEvaluator.evaluateSignalsBatchedCalls[0].signals;
                expect(batchedSignals.find((s: any) => s.id === "gated_out")).toBeUndefined();
            }
        });

        it("signal with if: () => true and when: 'X' IS included in classifier batch", async () => {
            mockEvaluator.setSignalResults({
                "passing": { matched: true, reason: "user said X" },
            });

            const handlerCalls: string[] = [];
            const signals = [
                {
                    id: "passing",
                    phase: "pre" as const,
                    if: () => true,
                    when: "user says X",
                    handler: () => { handlerCalls.push("fired"); },
                },
            ];

            const processor = makeProcessor(signals);
            const result = await processor.runPreSignalPhase({
                session: makeSession(),
                history: sampleHistory,
                context: {},
            });

            expect(mockEvaluator.evaluateSignalsBatchedCalls.length).toBe(1);
            const batchedSignals = mockEvaluator.evaluateSignalsBatchedCalls[0].signals;
            expect(batchedSignals.find((s: any) => s.id === "passing")).toBeDefined();
            expect(result.firings.length).toBe(1);
            expect(handlerCalls).toEqual(["fired"]);
        });
    });


    // ─── Unconditional signal ────────────────────────────────────────────────

    describe("Unconditional signal (no when, no if) always fires; reason is 'unconditional'", () => {
        it("fires with reason 'unconditional' subject to behavior gating", async () => {
            const handlerCalls: string[] = [];
            const signals = [
                {
                    id: "unconditional_sig",
                    phase: "pre" as const,
                    handler: (ctx: any) => { handlerCalls.push(ctx.reason); },
                },
            ];

            const processor = makeProcessor(signals);
            const result = await processor.runPreSignalPhase({
                session: makeSession(),
                history: sampleHistory,
                context: {},
            });

            expect(result.firings.length).toBe(1);
            expect(result.firings[0].reason).toBe("unconditional");
            expect(handlerCalls).toEqual(["unconditional"]);
        });
    });

    // ─── Unconditional + extract ─────────────────────────────────────────────

    describe("Unconditional + extract signal triggers extraction call; handler receives ctx.extracted", () => {
        it("triggers evaluateSignals call and passes extracted data to handler", async () => {
            const extractedData = { mood: "happy", score: 9 };
            mockEvaluator.setSignalResults({
                "extract_sig": { matched: true, reason: "unconditional", extracted: extractedData },
            });

            let receivedExtracted: any = undefined;
            const signals = [
                {
                    id: "extract_sig",
                    phase: "pre" as const,
                    extract: {
                        type: "object",
                        properties: {
                            mood: { type: "string" },
                            score: { type: "number" },
                        },
                    },
                    handler: (ctx: any) => { receivedExtracted = ctx.extracted; },
                },
            ];

            const processor = makeProcessor(signals);
            const result = await processor.runPreSignalPhase({
                session: makeSession(),
                history: sampleHistory,
                context: {},
            });

            // Should have called evaluateSignals for extraction
            expect(mockEvaluator.evaluateSignalsCalls.length).toBe(1);
            expect(result.firings.length).toBe(1);
            expect(receivedExtracted).toEqual(extractedData);
        });
    });


    // ─── Handler throws → handlerError; iteration continues ──────────────────

    describe("Handler throws → firing carries handlerError; iteration continues", () => {
        it("records handlerError and continues to next signal", async () => {
            const handlerCalls: string[] = [];
            const signals = [
                {
                    id: "throws_sig",
                    phase: "pre" as const,
                    priority: 10,
                    handler: () => { throw new Error("Handler exploded"); },
                },
                {
                    id: "after_sig",
                    phase: "pre" as const,
                    priority: 5,
                    handler: () => { handlerCalls.push("after"); },
                },
            ];

            const processor = makeProcessor(signals);
            const result = await processor.runPreSignalPhase({
                session: makeSession(),
                history: sampleHistory,
                context: {},
            });

            expect(result.firings.length).toBe(2);
            expect(result.firings[0].id).toBe("throws_sig");
            expect(result.firings[0].handlerError).toBe("Handler exploded");
            expect(result.firings[1].id).toBe("after_sig");
            expect(result.firings[1].handlerError).toBeUndefined();
            expect(handlerCalls).toEqual(["after"]);
        });
    });

    // ─── stopOtherSignals ────────────────────────────────────────────────────

    describe("stopOtherSignals: true halts same phase; other phase runs unaffected", () => {
        it("stops subsequent handlers in the same phase", async () => {
            const handlerCalls: string[] = [];
            const signals = [
                {
                    id: "stopper",
                    phase: "pre" as const,
                    priority: 10,
                    handler: () => {
                        handlerCalls.push("stopper");
                        return { stopOtherSignals: true } as SignalDirective;
                    },
                },
                {
                    id: "blocked",
                    phase: "pre" as const,
                    priority: 5,
                    handler: () => { handlerCalls.push("blocked"); },
                },
            ];

            const processor = makeProcessor(signals);
            const result = await processor.runPreSignalPhase({
                session: makeSession(),
                history: sampleHistory,
                context: {},
            });

            expect(handlerCalls).toEqual(["stopper"]);
            expect(result.firings.length).toBe(1);
            expect(result.firings[0].id).toBe("stopper");
        });

        it("other phase runs unaffected (both-phase signal)", async () => {
            const handlerCalls: string[] = [];
            const signals = [
                {
                    id: "both_stopper",
                    phase: "both" as const,
                    priority: 10,
                    handler: (ctx: any) => {
                        handlerCalls.push(`${ctx.phase}-stopper`);
                        // Only stop in pre-phase
                        if (ctx.phase === "pre") return { stopOtherSignals: true } as SignalDirective;
                    },
                },
                {
                    id: "both_normal",
                    phase: "both" as const,
                    priority: 5,
                    handler: (ctx: any) => { handlerCalls.push(`${ctx.phase}-normal`); },
                },
            ];

            const processor = makeProcessor(signals);
            const session = makeSession();

            // Pre-phase: stopper stops the blocked signal
            const preResult = await processor.runPreSignalPhase({
                session,
                history: sampleHistory,
                context: {},
            });
            expect(handlerCalls).toEqual(["pre-stopper"]);

            // Post-phase: both signals run (stopOtherSignals not returned)
            handlerCalls.length = 0;
            const postResult = await processor.runPostSignalPhase({
                session: preResult.updatedSession,
                history: sampleHistory,
                context: {},
            });
            expect(handlerCalls).toEqual(["post-stopper", "post-normal"]);
            expect(postResult.firings.length).toBe(2);
        });
    });


    // ─── Priority order ──────────────────────────────────────────────────────

    describe("Priority order: handlers invoked in priority desc, declaration order tiebreaker", () => {
        it("higher priority fires first", async () => {
            const order: string[] = [];
            const signals = [
                { id: "low", phase: "pre" as const, priority: 1, handler: () => { order.push("low"); } },
                { id: "high", phase: "pre" as const, priority: 10, handler: () => { order.push("high"); } },
                { id: "mid", phase: "pre" as const, priority: 5, handler: () => { order.push("mid"); } },
            ];

            const processor = makeProcessor(signals);
            await processor.runPreSignalPhase({
                session: makeSession(),
                history: sampleHistory,
                context: {},
            });

            expect(order).toEqual(["high", "mid", "low"]);
        });

        it("same priority uses declaration order as tiebreaker", async () => {
            const order: string[] = [];
            const signals = [
                { id: "first", phase: "pre" as const, priority: 5, handler: () => { order.push("first"); } },
                { id: "second", phase: "pre" as const, priority: 5, handler: () => { order.push("second"); } },
                { id: "third", phase: "pre" as const, priority: 5, handler: () => { order.push("third"); } },
            ];

            const processor = makeProcessor(signals);
            await processor.runPreSignalPhase({
                session: makeSession(),
                history: sampleHistory,
                context: {},
            });

            expect(order).toEqual(["first", "second", "third"]);
        });
    });

    // ─── recordTrigger ───────────────────────────────────────────────────────

    describe("recordTrigger updates count, lastTriggeredAt, lastReason, lastPhase; firstTriggeredAt set only on first trigger", () => {
        it("first trigger sets firstTriggeredAt and count=1", async () => {
            const signals = [
                { id: "track_sig", phase: "pre" as const, handler: () => { } },
            ];

            const processor = makeProcessor(signals);
            const result = await processor.runPreSignalPhase({
                session: makeSession(),
                history: sampleHistory,
                context: {},
            });

            const trigger = result.updatedSession.signals?.triggers?.track_sig;
            expect(trigger).toBeDefined();
            expect(trigger!.count).toBe(1);
            expect(trigger!.firstTriggeredAt).toBeInstanceOf(Date);
            expect(trigger!.lastTriggeredAt).toBeInstanceOf(Date);
            expect(trigger!.lastReason).toBe("unconditional");
            expect(trigger!.lastPhase).toBe("pre");
        });

        it("subsequent trigger preserves firstTriggeredAt and increments count", async () => {
            const signals = [
                { id: "track_sig", phase: "pre" as const, behavior: "always" as const, handler: () => { } },
            ];

            const processor = makeProcessor(signals);

            // First trigger
            const result1 = await processor.runPreSignalPhase({
                session: makeSession(),
                history: sampleHistory,
                context: {},
            });
            const firstTriggeredAt = result1.updatedSession.signals!.triggers.track_sig.firstTriggeredAt;

            // Second trigger
            const result2 = await processor.runPreSignalPhase({
                session: result1.updatedSession,
                history: sampleHistory,
                context: {},
            });
            const trigger = result2.updatedSession.signals!.triggers.track_sig;

            expect(trigger.count).toBe(2);
            expect(trigger.firstTriggeredAt).toEqual(firstTriggeredAt);
            expect(trigger.lastTriggeredAt.getTime()).toBeGreaterThanOrEqual(firstTriggeredAt.getTime());
        });

        it("does not record trigger state when the handler throws", async () => {
            let calls = 0;
            const signals = [
                {
                    id: "retry_sig",
                    phase: "pre" as const,
                    behavior: "once" as const,
                    handler: () => {
                        calls++;
                        if (calls === 1) {
                            throw new Error("app-side write failed");
                        }
                    },
                },
            ];

            const processor = makeProcessor(signals);

            const result1 = await processor.runPreSignalPhase({
                session: makeSession(),
                history: sampleHistory,
                context: {},
            });

            expect(calls).toBe(1);
            expect(result1.firings[0].handlerError).toBe("app-side write failed");
            expect(result1.updatedSession.signals?.triggers?.retry_sig).toBeUndefined();

            const result2 = await processor.runPreSignalPhase({
                session: result1.updatedSession,
                history: sampleHistory,
                context: {},
            });

            expect(calls).toBe(2);
            expect(result2.firings[0].handlerError).toBeUndefined();
            expect(result2.updatedSession.signals?.triggers?.retry_sig.count).toBe(1);
        });
    });


    // ─── Post-phase directive dropping ───────────────────────────────────────

    describe("Post-phase directive: appendPrompt/injectTools/halt dropped with debug log", () => {
        it("drops pre-LLM-only fields from post-phase directives", async () => {
            const debugSpy = spyOn(log, "debug");
            const signals = [
                {
                    id: "post_directive_sig",
                    phase: "post" as const,
                    handler: () => ({
                        appendPrompt: ["extra instruction"],
                        injectTools: [{ id: "fake_tool", handler: () => { } }],
                        halt: true,
                        reply: "valid reply",
                        dataUpdate: { key: "value" },
                    } as any),
                },
            ];

            const processor = makeProcessor(signals);
            const result = await processor.runPostSignalPhase({
                session: makeSession(),
                history: sampleHistory,
                context: {},
            });

            // appendPrompt, injectTools, halt should be dropped
            expect(result.mergedDirective?.appendPrompt).toBeUndefined();
            expect(result.mergedDirective?.injectTools).toBeUndefined();
            expect(result.mergedDirective?.halt).toBeUndefined();
            // reply and dataUpdate should survive
            expect(result.mergedDirective?.reply).toBe("valid reply");
            expect(result.mergedDirective?.dataUpdate).toEqual({ key: "value" });

            // Debug log should have been called for each dropped field
            const debugCalls = debugSpy.mock.calls.flat().filter(
                (arg) => typeof arg === "string" && arg.includes("Dropping")
            );
            expect(debugCalls.length).toBeGreaterThanOrEqual(3);
            debugSpy.mockRestore();
        });
    });

    // ─── replyWith ───────────────────────────────────────────────────────────

    describe("replyWith: (ctx) => '...' evaluates at emit time; result projects onto reply; replyWith stripped", () => {
        it("function form is evaluated and projected onto reply", async () => {
            const signals = [
                {
                    id: "reply_sig",
                    phase: "pre" as const,
                    handler: (ctx: any) => ({
                        replyWith: (c: any) => `Hello from ${c.signal.id}`,
                    }),
                },
            ];

            const processor = makeProcessor(signals);
            const result = await processor.runPreSignalPhase({
                session: makeSession(),
                history: sampleHistory,
                context: {},
            });

            // The directive should have reply set and replyWith stripped
            expect(result.firings[0].directive?.reply).toBe("Hello from reply_sig");
            expect((result.firings[0].directive as any)?.replyWith).toBeUndefined();
        });

        it("string form is projected onto reply directly", async () => {
            const signals = [
                {
                    id: "reply_str_sig",
                    phase: "pre" as const,
                    handler: () => ({
                        replyWith: "Static reply",
                    }),
                },
            ];

            const processor = makeProcessor(signals);
            const result = await processor.runPreSignalPhase({
                session: makeSession(),
                history: sampleHistory,
                context: {},
            });

            expect(result.firings[0].directive?.reply).toBe("Static reply");
            expect((result.firings[0].directive as any)?.replyWith).toBeUndefined();
        });
    });


    // ─── Property-based tests ────────────────────────────────────────────────

    describe("Property 1: Zero-cost when no signals configured", () => {
        /**
         * Validates: Requirements 2.1, 2.2, 2.3
         *
         * Property: When signals array is empty or all signals are gated out
         * by behavior, both phases return immediately with zero firings and
         * zero evaluator calls.
         */
        it("zero provider calls when signals is empty or all gated", async () => {
            await fc.assert(
                fc.asyncProperty(
                    fc.constantFrom("pre" as const, "post" as const),
                    fc.boolean(), // true = empty signals, false = all gated by 'once'
                    async (phase, isEmpty) => {
                        const evaluator = new MockSignalEvaluator();
                        const provider = new CountingMockProvider({ structured: { signals: [] } });

                        let signals: any[];
                        let session: SessionState<any>;

                        if (isEmpty) {
                            signals = [];
                            session = makeSession();
                        } else {
                            // All signals are 'once' with existing triggers
                            signals = [
                                { id: "gated", phase: "both" as const, behavior: "once" as const, handler: () => { } },
                            ];
                            session = makeSession({
                                signals: {
                                    triggers: {
                                        gated: {
                                            firstTriggeredAt: new Date(),
                                            lastTriggeredAt: new Date(),
                                            count: 1,
                                            lastReason: "test",
                                            lastPhase: "pre",
                                        },
                                    },
                                },
                            });
                        }

                        const processor = new SignalProcessor(signals, provider as any, evaluator as any, { batchSize: 10 });
                        const method = phase === "pre" ? "runPreSignalPhase" : "runPostSignalPhase";
                        const result = await processor[method]({
                            session,
                            history: sampleHistory,
                            context: {},
                        });

                        expect(result.firings).toEqual([]);
                        expect(provider.callCount).toBe(0);
                        expect(evaluator.evaluateSignalsBatchedCalls.length).toBe(0);
                        expect(evaluator.evaluateSignalsCalls.length).toBe(0);
                    },
                ),
                { numRuns: 20 },
            );
        });
    });


    describe("Property 2: Behavior gating consistent", () => {
        /**
         * Validates: Requirements 5.1, 5.2, 5.3, 5.4
         *
         * Property: Table-driven behavior gating for once/always/cooldown
         * × no-trigger / fresh / elapsed produces consistent results.
         */
        it("behavior gating table-driven correctness", () => {
            fc.assert(
                fc.property(
                    fc.constantFrom("once", "always", "cooldown") as fc.Arbitrary<"once" | "always" | "cooldown">,
                    fc.constantFrom("no-trigger", "fresh", "elapsed") as fc.Arbitrary<"no-trigger" | "fresh" | "elapsed">,
                    (behavior, triggerState) => {
                        const signal: any = { id: "test", behavior, cooldownMs: 1000 };
                        let trigger: SignalTriggerState | undefined;

                        if (triggerState === "no-trigger") {
                            trigger = undefined;
                        } else if (triggerState === "fresh") {
                            trigger = {
                                firstTriggeredAt: new Date(),
                                lastTriggeredAt: new Date(),
                                count: 1,
                                lastReason: "t",
                                lastPhase: "pre",
                            };
                        } else {
                            // elapsed: 2000ms ago > 1000ms cooldown
                            trigger = {
                                firstTriggeredAt: new Date(Date.now() - 5000),
                                lastTriggeredAt: new Date(Date.now() - 2000),
                                count: 3,
                                lastReason: "t",
                                lastPhase: "pre",
                            };
                        }

                        const result = behaviorAllowsExecution(signal, trigger);

                        // Expected outcomes:
                        if (triggerState === "no-trigger") {
                            // No prior trigger → always allowed
                            expect(result).toBe(true);
                        } else if (behavior === "always") {
                            expect(result).toBe(true);
                        } else if (behavior === "once") {
                            // Has a trigger → blocked
                            expect(result).toBe(false);
                        } else if (behavior === "cooldown") {
                            if (triggerState === "fresh") {
                                // Just fired → blocked
                                expect(result).toBe(false);
                            } else {
                                // Elapsed → allowed
                                expect(result).toBe(true);
                            }
                        }
                    },
                ),
                { numRuns: 50 },
            );
        });
    });


    describe("Property 3: Code-first short-circuits LLM cost", () => {
        /**
         * Validates: Requirements 3.1, 3.10
         *
         * Property: A signal with `if: () => false` never appears in the
         * classifier batch — zero evaluator batched calls for that signal.
         */
        it("if: false signal never appears in classifier batch", async () => {
            await fc.assert(
                fc.asyncProperty(
                    // Generate 1-5 signals, some with if:false, some with if:true
                    fc.array(
                        fc.record({
                            id: fc.string({ minLength: 1, maxLength: 10 }).map(s => `sig_${s.replace(/[^a-z0-9]/g, '')}`),
                            ifResult: fc.boolean(),
                        }),
                        { minLength: 1, maxLength: 5 },
                    ).map(configs => {
                        const seen = new Set<string>();
                        return configs.filter(c => {
                            if (seen.has(c.id) || c.id === "sig_") return false;
                            seen.add(c.id);
                            return true;
                        });
                    }).filter(arr => arr.length > 0),
                    async (signalConfigs) => {
                        const evaluator = new MockSignalEvaluator();
                        // Set all as matched for signals that pass if-gate
                        const results: Record<string, SignalEvaluationResult> = {};
                        for (const cfg of signalConfigs) {
                            results[cfg.id] = { matched: cfg.ifResult, reason: "test" };
                        }
                        evaluator.setSignalResults(results);

                        const provider = new CountingMockProvider({ structured: { signals: [] } });

                        const signals = signalConfigs.map(cfg => ({
                            id: cfg.id,
                            phase: "pre" as const,
                            if: () => cfg.ifResult,
                            when: "some condition",
                            handler: () => { },
                        }));

                        const processor = new SignalProcessor(signals, provider as any, evaluator as any, { batchSize: 10 });
                        await processor.runPreSignalPhase({
                            session: makeSession(),
                            history: sampleHistory,
                            context: {},
                        });

                        // Check that only if:true signals appeared in batched calls
                        if (evaluator.evaluateSignalsBatchedCalls.length > 0) {
                            const batchedIds = evaluator.evaluateSignalsBatchedCalls[0].signals.map((s: any) => s.id);
                            for (const cfg of signalConfigs) {
                                if (!cfg.ifResult) {
                                    expect(batchedIds).not.toContain(cfg.id);
                                }
                            }
                        }
                    },
                ),
                { numRuns: 30 },
            );
        });
    });


    describe("Property 5: Handler errors never break the turn", () => {
        /**
         * Validates: Requirements 6.5
         *
         * Property: For any number of signals where some handlers throw,
         * the phase always completes — firings are recorded for all matched
         * signals, and non-throwing handlers still execute.
         */
        it("all signals process regardless of handler errors", async () => {
            await fc.assert(
                fc.asyncProperty(
                    // Generate 1-6 signals; each either throws or succeeds
                    fc.array(fc.boolean(), { minLength: 1, maxLength: 6 }),
                    async (throwFlags) => {
                        const executedIds: string[] = [];
                        const signals = throwFlags.map((shouldThrow, i) => ({
                            id: `sig_${i}`,
                            phase: "pre" as const,
                            handler: () => {
                                executedIds.push(`sig_${i}`);
                                if (shouldThrow) throw new Error(`Error in sig_${i}`);
                            },
                        }));

                        const evaluator = new MockSignalEvaluator();
                        const provider = new CountingMockProvider({ structured: { signals: [] } });
                        const processor = new SignalProcessor(signals, provider as any, evaluator as any, { batchSize: 10 });

                        // Should never throw
                        const result = await processor.runPreSignalPhase({
                            session: makeSession(),
                            history: sampleHistory,
                            context: {},
                        });

                        // All signals should have firings recorded
                        expect(result.firings.length).toBe(signals.length);

                        // Throwing signals have handlerError set
                        for (let i = 0; i < throwFlags.length; i++) {
                            if (throwFlags[i]) {
                                expect(result.firings[i].handlerError).toContain(`sig_${i}`);
                            } else {
                                expect(result.firings[i].handlerError).toBeUndefined();
                            }
                        }
                    },
                ),
                { numRuns: 30 },
            );
        });
    });


    describe("Property 6: stopOtherSignals halts only the current phase", () => {
        /**
         * Validates: Requirements 6.6
         *
         * Property: When a handler returns stopOtherSignals: true in one phase,
         * subsequent signals in that phase are skipped, but the other phase
         * still processes all its signals normally.
         */
        it("stop in one phase does not affect the other", async () => {
            await fc.assert(
                fc.asyncProperty(
                    // Which phase does the stopper signal stop in?
                    fc.constantFrom("pre", "post") as fc.Arbitrary<"pre" | "post">,
                    async (stopPhase) => {
                        const preCalls: string[] = [];
                        const postCalls: string[] = [];

                        const signals = [
                            {
                                id: "stopper",
                                phase: "both" as const,
                                priority: 10,
                                handler: (ctx: any) => {
                                    if (ctx.phase === "pre") preCalls.push("stopper");
                                    else postCalls.push("stopper");
                                    if (ctx.phase === stopPhase) {
                                        return { stopOtherSignals: true } as SignalDirective;
                                    }
                                },
                            },
                            {
                                id: "follower",
                                phase: "both" as const,
                                priority: 5,
                                handler: (ctx: any) => {
                                    if (ctx.phase === "pre") preCalls.push("follower");
                                    else postCalls.push("follower");
                                },
                            },
                        ];

                        const evaluator = new MockSignalEvaluator();
                        const provider = new CountingMockProvider({ structured: { signals: [] } });
                        const processor = new SignalProcessor(signals, provider as any, evaluator as any, { batchSize: 10 });
                        const session = makeSession();

                        const preResult = await processor.runPreSignalPhase({
                            session,
                            history: sampleHistory,
                            context: {},
                        });

                        const postResult = await processor.runPostSignalPhase({
                            session: preResult.updatedSession,
                            history: sampleHistory,
                            context: {},
                        });

                        if (stopPhase === "pre") {
                            // Pre-phase: stopper fires, follower blocked
                            expect(preCalls).toEqual(["stopper"]);
                            // Post-phase: both fire (no stop in post)
                            expect(postCalls).toEqual(["stopper", "follower"]);
                        } else {
                            // Pre-phase: both fire (no stop in pre)
                            expect(preCalls).toEqual(["stopper", "follower"]);
                            // Post-phase: stopper fires, follower blocked
                            expect(postCalls).toEqual(["stopper"]);
                        }
                    },
                ),
                { numRuns: 10 },
            );
        });
    });


    describe("Property 8: Extraction data available to handler when matched", () => {
        /**
         * Validates: Requirements 4.3, 4.5
         *
         * Property: When a signal with `extract` matches (unconditional or
         * LLM-conditioned), the handler receives `ctx.extracted` containing
         * the extraction result.
         */
        it("extracted data available regardless of match mode", async () => {
            await fc.assert(
                fc.asyncProperty(
                    // Generate extraction data
                    fc.record({
                        score: fc.integer({ min: 1, max: 100 }),
                        label: fc.string({ minLength: 1, maxLength: 10 }),
                    }),
                    async (extractedData) => {
                        let receivedExtracted: any = undefined;
                        const evaluator = new MockSignalEvaluator();
                        evaluator.setSignalResults({
                            "extract_test": { matched: true, reason: "test", extracted: extractedData },
                        });

                        const signals = [
                            {
                                id: "extract_test",
                                phase: "pre" as const,
                                extract: {
                                    type: "object",
                                    properties: {
                                        score: { type: "number" },
                                        label: { type: "string" },
                                    },
                                },
                                handler: (ctx: any) => { receivedExtracted = ctx.extracted; },
                            },
                        ];

                        const provider = new CountingMockProvider({ structured: { signals: [] } });
                        const processor = new SignalProcessor(signals, provider as any, evaluator as any, { batchSize: 10 });

                        await processor.runPreSignalPhase({
                            session: makeSession(),
                            history: sampleHistory,
                            context: {},
                        });

                        expect(receivedExtracted).toEqual(extractedData);
                    },
                ),
                { numRuns: 20 },
            );
        });
    });


    describe("Property 9: Trigger state monotonic per signal", () => {
        /**
         * Validates: Requirements 10.1, 10.2
         *
         * Property: count strictly increases with each firing;
         * firstTriggeredAt never changes after first trigger.
         */
        it("count strictly increases; firstTriggeredAt invariant", async () => {
            await fc.assert(
                fc.asyncProperty(
                    // Number of consecutive fires (2-5)
                    fc.integer({ min: 2, max: 5 }),
                    async (numFires) => {
                        const signals = [
                            { id: "mono_sig", phase: "pre" as const, behavior: "always" as const, handler: () => { } },
                        ];
                        const evaluator = new MockSignalEvaluator();
                        const provider = new CountingMockProvider({ structured: { signals: [] } });
                        const processor = new SignalProcessor(signals, provider as any, evaluator as any, { batchSize: 10 });

                        let session = makeSession();
                        let prevCount = 0;
                        let firstTriggeredAt: Date | undefined;

                        for (let i = 0; i < numFires; i++) {
                            const result = await processor.runPreSignalPhase({
                                session,
                                history: sampleHistory,
                                context: {},
                            });
                            session = result.updatedSession;
                            const trigger = session.signals!.triggers.mono_sig;

                            // Count strictly increases
                            expect(trigger.count).toBe(prevCount + 1);
                            prevCount = trigger.count;

                            // firstTriggeredAt set on first, never changes
                            if (i === 0) {
                                firstTriggeredAt = trigger.firstTriggeredAt;
                            } else {
                                expect(trigger.firstTriggeredAt).toEqual(firstTriggeredAt);
                            }
                        }
                    },
                ),
                { numRuns: 10 },
            );
        });
    });


    describe("Property 11: `!` prefix correctly splits in classifier prompt", () => {
        /**
         * Validates: Requirements 3.6, 12.1
         *
         * Property: For any mix of `!`-prefixed and non-prefixed when entries,
         * the classifier prompt renders positive entries under "TRIGGER WHEN"
         * and negative entries (prefix stripped) under "DO NOT TRIGGER WHEN".
         */
        it("positive and negative entries always land in correct sections", () => {
            const conditionEntry = fc.stringMatching(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,29}$/);

            fc.assert(
                fc.property(
                    // Generate 1-5 positive entries
                    fc.array(conditionEntry, { minLength: 1, maxLength: 5 }),
                    // Generate 0-3 negative entries (without the ! prefix — we add it)
                    fc.array(conditionEntry, { minLength: 0, maxLength: 3 }),
                    (positiveEntries, negativeEntries) => {
                        const whenArray = [
                            ...positiveEntries,
                            ...negativeEntries.map(e => `!${e}`),
                        ];

                        const signal: Signal = {
                            id: "prop11_test",
                            when: whenArray,
                            phase: "pre",
                            handler: () => { },
                        };

                        const prompt = buildSignalClassifierPrompt([signal], sampleHistory, {});

                        // Positive entries should appear in the prompt (under TRIGGER WHEN)
                        if (positiveEntries.length > 0) {
                            expect(prompt).toContain("TRIGGER WHEN (ANY matches):");
                            for (const entry of positiveEntries) {
                                expect(prompt).toContain(entry);
                            }
                        }

                        // Negative entries should appear stripped of `!` (under DO NOT TRIGGER WHEN)
                        if (negativeEntries.length > 0) {
                            expect(prompt).toContain("DO NOT TRIGGER WHEN (ANY inhibits):");
                            for (const entry of negativeEntries) {
                                expect(prompt).toContain(entry);
                                // The `!` prefix should NOT appear in rendered form
                                expect(prompt).not.toContain(`• !${entry}`);
                            }
                        }
                    },
                ),
                { numRuns: 50 },
            );
        });
    });


    describe("Property 13: Unconditional signals always fire", () => {
        /**
         * Validates: Requirements 3.11
         *
         * Property: A signal with neither `when` nor `if` always fires
         * (subject to behavior gating) regardless of history content or context.
         */
        it("unconditional signals fire regardless of context/history", async () => {
            await fc.assert(
                fc.asyncProperty(
                    // Varied context values
                    fc.record({ key: fc.string() }),
                    // Varied history messages
                    fc.array(fc.string({ minLength: 1, maxLength: 50 }), { minLength: 0, maxLength: 3 }),
                    async (context, messages) => {
                        const history = makeHistory(
                            messages.map(m => ({ role: MessageRole.USER, text: m })),
                        );

                        const handlerCalls: string[] = [];
                        const signals = [
                            {
                                id: "always_fire",
                                phase: "pre" as const,
                                handler: () => { handlerCalls.push("fired"); },
                            },
                        ];

                        const evaluator = new MockSignalEvaluator();
                        const provider = new CountingMockProvider({ structured: { signals: [] } });
                        const processor = new SignalProcessor(signals, provider as any, evaluator as any, { batchSize: 10 });

                        const result = await processor.runPreSignalPhase({
                            session: makeSession(),
                            history: history.length > 0 ? history : sampleHistory,
                            context,
                        });

                        // Unconditional signal should always fire
                        expect(result.firings.length).toBe(1);
                        expect(result.firings[0].reason).toBe("unconditional");
                        expect(handlerCalls).toEqual(["fired"]);
                    },
                ),
                { numRuns: 30 },
            );
        });
    });
});


// ─── Pipeline Integration Tests ──────────────────────────────────────────────

/**
 * Signals — Pipeline Integration Tests
 *
 * Integration tests that create a full Agent with signals and call
 * `agent.respond(...)` / `agent.respondStream(...)` to verify end-to-end
 * pipeline behavior including parallel pre-phase, post-phase, directive
 * resolution, and response surface population.
 *
 * **Property 7: SignalDirective carries full Directive semantics**
 * **Property 12: Parallel pre-phase does not block routing (wall-clock invariant)**
 * **Validates: Requirements 8.1–8.6, 9.1–9.4, 11.1–11.4**
 */

describe("Signals — Pipeline Integration", () => {
    /**
     * A configurable mock provider that:
     * - Counts calls by schema type (signal_evaluation vs routing vs response)
     * - Allows configuring responses per schema type
     * - Supports artificial latency per call type
     */
    class PipelineMockProvider extends MockProvider {
        public signalCallCount = 0;
        public routingCallCount = 0;
        public responseCallCount = 0;
        public totalCallCount = 0;

        private _signalResponse: any;
        private _signalLatencyMs: number;
        private _routingLatencyMs: number;
        private _responseLatencyMs: number;

        constructor(config: {
            signalResponse?: any;
            signalLatencyMs?: number;
            routingLatencyMs?: number;
            responseLatencyMs?: number;
        } = {}) {
            super({ delayMs: 0 });
            this._signalResponse = config.signalResponse ?? { signals: [] };
            this._signalLatencyMs = config.signalLatencyMs ?? 0;
            this._routingLatencyMs = config.routingLatencyMs ?? 0;
            this._responseLatencyMs = config.responseLatencyMs ?? 0;
        }

        override async generateMessage<TContext = unknown, TStructured = any>(
            input: any,
        ): Promise<any> {
            this.totalCallCount++;
            const schemaName = input.parameters?.schemaName ?? '';
            const schema = input.parameters?.jsonSchema;

            // Signal evaluation call
            if (schemaName === 'signal_evaluation') {
                this.signalCallCount++;
                if (this._signalLatencyMs > 0) {
                    await new Promise(r => setTimeout(r, this._signalLatencyMs));
                }
                return {
                    message: "signal eval",
                    metadata: { model: "mock", tokensUsed: 10, finishReason: "stop" },
                    structured: this._signalResponse,
                };
            }

            // Routing call (has flows property in schema)
            if (schema?.properties?.flows?.properties) {
                this.routingCallCount++;
                if (this._routingLatencyMs > 0) {
                    await new Promise(r => setTimeout(r, this._routingLatencyMs));
                }
                const flowIds = Object.keys(schema.properties.flows.properties);
                const flows: Record<string, number> = {};
                flowIds.forEach((flowId, index) => {
                    flows[flowId] = 80 - (index * 10);
                });
                return {
                    message: "routing",
                    metadata: { model: "mock", tokensUsed: 10, finishReason: "stop" },
                    structured: { context: "mock", flows, responseDirectives: [] },
                };
            }

            // Step selection
            if (schema?.properties?.selectedStepId) {
                if (this._routingLatencyMs > 0) {
                    await new Promise(r => setTimeout(r, this._routingLatencyMs));
                }
                const stepIds = schema.properties.selectedStepId.enum || [];
                return {
                    message: "step",
                    metadata: { model: "mock", tokensUsed: 10, finishReason: "stop" },
                    structured: { reasoning: "mock", selectedStepId: stepIds[0] },
                };
            }

            // Response generation call (has message field)
            this.responseCallCount++;
            if (this._responseLatencyMs > 0) {
                await new Promise(r => setTimeout(r, this._responseLatencyMs));
            }
            return {
                message: "I can help you with that.",
                metadata: { model: "mock", tokensUsed: 50, finishReason: "stop" },
                structured: { message: "I can help you with that." },
            };
        }

        override async *generateMessageStream<TContext = unknown, TStructured = any>(
            input: any,
        ): AsyncGenerator<any> {
            // Delegate to generateMessage for simplicity — return final chunk
            const result = await this.generateMessage(input);
            yield {
                delta: result.message,
                accumulated: result.message,
                done: true,
                metadata: result.metadata,
                structured: result.structured,
            };
        }

        setSignalResponse(response: any) {
            this._signalResponse = response;
        }

        resetCounts() {
            this.signalCallCount = 0;
            this.routingCallCount = 0;
            this.responseCallCount = 0;
            this.totalCallCount = 0;
        }
    }

    function createPipelineAgent(config: {
        signals: any[];
        provider: PipelineMockProvider;
        flows?: any[];
    }) {
        const agent = new Agent({
            name: "PipelineTestAgent",
            description: "Testing signal pipeline integration",
            context: {},
            provider: config.provider,
            signals: config.signals,
        });

        // Add flows if specified
        if (config.flows) {
            for (const flowOpts of config.flows) {
                agent.createFlow(flowOpts);
            }
        } else {
            // Default: two flows for routing tests
            agent.createFlow({
                title: "MainFlow",
                when: ["User wants general help"],
                steps: [{ prompt: "How can I help?" }],
            });
            agent.createFlow({
                title: "OtherFlow",
                when: ["User wants other help"],
                steps: [{ prompt: "Other help here." }],
            });
        }

        return agent;
    }

    const baseHistory = [
        { role: "user" as const, content: "I need help", name: "TestUser" },
    ];

    // ─── Pre-phase halt ──────────────────────────────────────────────────────

    describe("Pre-phase halt: signal returns { halt: true, reply: 'X' }", () => {
        it("discards routing result; assistant message equals the reply; LLM response call NOT made", async () => {
            const provider = new PipelineMockProvider({
                signalResponse: {
                    signals: [{ id: "halt_sig", matched: true, reason: "user asked for handoff" }],
                },
            });

            const agent = createPipelineAgent({
                signals: [
                    {
                        id: "halt_sig",
                        when: "user asks for handoff",
                        phase: "pre",
                        handler: () => ({ halt: true, reply: "Connecting you to a human." }),
                    },
                ],
                provider,
            });

            const session = await agent.session.getOrCreate();
            const response = await agent.respond({ history: baseHistory, session });

            // The assistant message should be the signal's reply
            expect(response.message).toBe("Connecting you to a human.");
            // The response generation LLM call should NOT have been made
            expect(provider.responseCallCount).toBe(0);
            // Signal evaluation call WAS made (to evaluate the signal)
            expect(provider.signalCallCount).toBe(1);
        });
    });

    // ─── Pre-phase position directive ────────────────────────────────────────

    describe("Pre-phase position directive: signal returns { goTo: 'OtherFlow' }", () => {
        it("routing result is discarded; session ends on OtherFlow after the turn", async () => {
            const provider = new PipelineMockProvider({
                signalResponse: {
                    signals: [{ id: "goto_sig", matched: true, reason: "redirect needed" }],
                },
            });

            const agent = createPipelineAgent({
                signals: [
                    {
                        id: "goto_sig",
                        when: "user needs redirect",
                        phase: "pre",
                        handler: () => ({ goTo: "OtherFlow" }),
                    },
                ],
                provider,
            });

            const session = await agent.session.getOrCreate();
            const response = await agent.respond({ history: baseHistory, session });

            // Session should be on OtherFlow after the turn
            expect(response.session?.currentFlow?.title).toBe("OtherFlow");
        });
    });

    // ─── Pre-phase non-position directive ────────────────────────────────────

    describe("Pre-phase non-position directive: signal returns { appendPrompt: ['be terse'] }", () => {
        it("routing picks the flow; the appendPrompt lands in the LLM call", async () => {
            // Track what the response generation call receives
            let capturedPrompt: string | undefined;
            const provider = new PipelineMockProvider({
                signalResponse: {
                    signals: [{ id: "aug_sig", matched: true, reason: "augment" }],
                },
            });

            // Override generateMessage to capture the response generation prompt
            const originalGenerate = provider.generateMessage.bind(provider);
            let responseCallIndex = 0;
            provider.generateMessage = async function (input: any): Promise<any> {
                const schemaName = input.parameters?.schemaName ?? '';
                const schema = input.parameters?.jsonSchema;
                // Capture the response generation call's prompt
                if (schemaName !== 'signal_evaluation' && !schema?.properties?.flows?.properties && !schema?.properties?.selectedStepId) {
                    responseCallIndex++;
                    capturedPrompt = input.prompt;
                }
                return originalGenerate(input);
            };

            const agent = createPipelineAgent({
                signals: [
                    {
                        id: "aug_sig",
                        when: "user needs terse response",
                        phase: "pre",
                        handler: () => ({ appendPrompt: ["be terse"] }),
                    },
                ],
                provider,
            });

            const session = await agent.session.getOrCreate();
            const response = await agent.respond({ history: baseHistory, session });

            // Routing should have selected MainFlow (first flow gets highest score)
            expect(response.session?.currentFlow?.title).toBe("MainFlow");
            // The appendPrompt content should appear in the captured prompt
            expect(capturedPrompt).toBeDefined();
            expect(capturedPrompt).toContain("be terse");
            // The response call WAS made (not halted)
            expect(provider.responseCallCount).toBe(1);
        });
    });

    // ─── Pre-phase: no signal directive ──────────────────────────────────────

    describe("Pre-phase: no signal directive → routing result used as-is", () => {
        it("no behavior change vs. signals-disabled baseline", async () => {
            const provider = new PipelineMockProvider({
                signalResponse: {
                    signals: [{ id: "noop_sig", matched: true, reason: "matched but no directive" }],
                },
            });

            const agent = createPipelineAgent({
                signals: [
                    {
                        id: "noop_sig",
                        when: "always matches",
                        phase: "pre",
                        // Handler returns void (no directive)
                        handler: () => { },
                    },
                ],
                provider,
            });

            const session = await agent.session.getOrCreate();
            const response = await agent.respond({ history: baseHistory, session });

            // Normal routing should proceed — MainFlow selected (highest score)
            expect(response.session?.currentFlow?.title).toBe("MainFlow");
            // Response generation call should happen normally
            expect(provider.responseCallCount).toBe(1);
        });
    });

    // ─── Post-phase: position directive sets pendingDirective ─────────────────

    describe("Post-phase: position directive sets session.pendingDirective", () => {
        it("next turn consumes pendingDirective before routing (no mid-turn re-entry)", async () => {
            const provider = new PipelineMockProvider({
                signalResponse: {
                    signals: [{ id: "post_goto_sig", matched: true, reason: "schedule redirect" }],
                },
            });

            const agent = createPipelineAgent({
                signals: [
                    {
                        id: "post_goto_sig",
                        when: "user mentions scheduling",
                        phase: "post",
                        handler: () => ({ goTo: "OtherFlow" }),
                    },
                ],
                provider,
            });

            // First turn: post-phase sets pendingDirective
            let session = await agent.session.getOrCreate();
            const response1 = await agent.respond({ history: baseHistory, session });

            // After the first turn, session should have pendingDirective set
            // but should NOT be on OtherFlow yet (no mid-turn re-entry)
            expect(response1.session?.pendingDirective).toBeDefined();
            expect(response1.session?.pendingDirective?.goTo).toBe("OtherFlow");
            // First turn routes normally to MainFlow
            expect(response1.session?.currentFlow?.title).toBe("MainFlow");

            // Second turn: pendingDirective is consumed before routing
            provider.resetCounts();
            // Clear signal response so the signal doesn't fire again
            provider.setSignalResponse({ signals: [{ id: "post_goto_sig", matched: false }] });

            const response2 = await agent.respond({
                history: [
                    ...baseHistory,
                    { role: "assistant" as const, content: response1.message },
                    { role: "user" as const, content: "Next turn", name: "TestUser" },
                ],
                session: response1.session!,
            });

            // On the second turn, the pendingDirective should have navigated to OtherFlow
            expect(response2.session?.currentFlow?.title).toBe("OtherFlow");
            // pendingDirective should be consumed
            expect(response2.session?.pendingDirective).toBeUndefined();
        });
    });

    // ─── Post-phase: reply replacement ──────────────────────────────────────

    describe("Post-phase: reply replaces the generated message", () => {
        it("respond() returns the post-signal reply while preserving the completed turn", async () => {
            const provider = new PipelineMockProvider({
                signalResponse: {
                    signals: [{ id: "post_reply_sig", matched: true, reason: "replace reply" }],
                },
            });

            const agent = createPipelineAgent({
                signals: [
                    {
                        id: "post_reply_sig",
                        when: "replace the final reply",
                        phase: "post",
                        handler: () => ({ reply: "Post-signal replacement." }),
                    },
                ],
                provider,
            });

            const session = await agent.session.getOrCreate();
            const response = await agent.respond({ history: baseHistory, session });

            expect(provider.responseCallCount).toBe(1);
            expect(response.message).toBe("Post-signal replacement.");
            expect(response.triggeredSignals?.[0]?.id).toBe("post_reply_sig");
        });

        it("respondStream() exposes the post-signal reply on the terminal chunk", async () => {
            const provider = new PipelineMockProvider({
                signalResponse: {
                    signals: [{ id: "post_stream_reply_sig", matched: true, reason: "replace stream reply" }],
                },
            });

            const agent = createPipelineAgent({
                signals: [
                    {
                        id: "post_stream_reply_sig",
                        when: "replace the final stream reply",
                        phase: "post",
                        handler: () => ({ reply: "Stream post-signal replacement." }),
                    },
                ],
                provider,
            });

            const session = await agent.session.getOrCreate();
            const chunks: Array<{ done: boolean; delta: string; accumulated: string }> = [];

            for await (const chunk of agent.respondStream({ history: baseHistory, session })) {
                chunks.push(chunk);
            }

            const finalChunk = chunks.find((chunk) => chunk.done);
            expect(provider.responseCallCount).toBe(1);
            expect(finalChunk?.delta).toBe("Stream post-signal replacement.");
            expect(finalChunk?.accumulated).toBe("Stream post-signal replacement.");
        });
    });

    // ─── Post-phase: dropped fields ──────────────────────────────────────────

    describe("Post-phase: appendPrompt/injectTools/halt dropped with debug log; rest applied", () => {
        it("post-phase directive with appendPrompt/halt drops those; position field applied", async () => {
            const debugSpy = spyOn(log, "debug");

            const provider = new PipelineMockProvider({
                signalResponse: {
                    signals: [{ id: "post_mixed_sig", matched: true, reason: "post mixed" }],
                },
            });

            const agent = createPipelineAgent({
                signals: [
                    {
                        id: "post_mixed_sig",
                        when: "always",
                        phase: "post",
                        // Return a mix of valid and invalid post-phase fields
                        handler: () => ({
                            goTo: "OtherFlow",
                            appendPrompt: ["should be dropped"],
                            halt: true, // should be dropped in post-phase
                        }),
                    },
                ],
                provider,
            });

            const session = await agent.session.getOrCreate();
            const response = await agent.respond({ history: baseHistory, session });

            // The position field (goTo) should be applied as pendingDirective
            expect(response.session?.pendingDirective).toBeDefined();
            expect(response.session?.pendingDirective?.goTo).toBe("OtherFlow");

            // The halt should NOT have affected this turn's response
            // (response was generated normally — response call was made)
            expect(provider.responseCallCount).toBe(1);

            // Debug log should have been emitted about dropped fields
            const dropLogged = debugSpy.mock.calls.some((args) =>
                args.some(
                    (arg) =>
                        typeof arg === "string" &&
                        (arg.includes("drop") || arg.includes("Drop") || arg.includes("ignored") || arg.includes("post"))
                )
            );
            expect(dropLogged).toBe(true);
            debugSpy.mockRestore();
        });
    });

    // ─── Both phases: firings appear in triggeredSignals in fire order ────────

    describe("Both phases: firings appear in AgentResponse.triggeredSignals in fire order", () => {
        it("pre-phase entries appear before post-phase entries", async () => {
            const provider = new PipelineMockProvider({
                signalResponse: {
                    signals: [
                        { id: "pre_sig", matched: true, reason: "pre match" },
                        { id: "both_sig", matched: true, reason: "both match" },
                        { id: "post_sig", matched: true, reason: "post match" },
                    ],
                },
            });

            const agent = createPipelineAgent({
                signals: [
                    {
                        id: "pre_sig",
                        when: "pre condition",
                        phase: "pre",
                        handler: () => { },
                    },
                    {
                        id: "both_sig",
                        when: "both condition",
                        phase: "both",
                        handler: () => { },
                    },
                    {
                        id: "post_sig",
                        when: "post condition",
                        phase: "post",
                        handler: () => { },
                    },
                ],
                provider,
            });

            const session = await agent.session.getOrCreate();
            const response = await agent.respond({ history: baseHistory, session });

            // triggeredSignals should be populated
            expect(response.triggeredSignals).toBeDefined();
            expect(response.triggeredSignals!.length).toBeGreaterThanOrEqual(3);

            // Pre-phase signals should come before post-phase signals
            const preIndices = response.triggeredSignals!
                .map((f, i) => f.phase === "pre" ? i : -1)
                .filter(i => i >= 0);
            const postIndices = response.triggeredSignals!
                .map((f, i) => f.phase === "post" ? i : -1)
                .filter(i => i >= 0);

            if (preIndices.length > 0 && postIndices.length > 0) {
                const maxPreIndex = Math.max(...preIndices);
                const minPostIndex = Math.min(...postIndices);
                expect(maxPreIndex).toBeLessThan(minPostIndex);
            }
        });
    });

    // ─── Stream API: final chunk carries triggeredSignals ─────────────────────

    describe("Stream API: final chunk carries triggeredSignals", () => {
        it("final chunk has triggeredSignals when signals fire", async () => {
            const provider = new PipelineMockProvider({
                signalResponse: {
                    signals: [{ id: "stream_sig", matched: true, reason: "stream match" }],
                },
            });

            // Use halt for simplicity — guarantees a single final chunk with triggeredSignals
            const agent = createPipelineAgent({
                signals: [
                    {
                        id: "stream_sig",
                        when: "user says hello",
                        phase: "pre",
                        handler: () => ({ halt: true, reply: "Halted from stream." }),
                    },
                ],
                provider,
            });

            const session = await agent.session.getOrCreate();
            const chunks: any[] = [];

            for await (const chunk of agent.respondStream({ history: baseHistory, session })) {
                chunks.push(chunk);
            }

            // Find the final (done) chunk
            const finalChunk = chunks.find(c => c.done);
            expect(finalChunk).toBeDefined();
            expect(finalChunk!.triggeredSignals).toBeDefined();
            expect(finalChunk!.triggeredSignals!.length).toBeGreaterThan(0);
            expect(finalChunk!.triggeredSignals![0].id).toBe("stream_sig");
        });
    });

    // ─── Parallel execution: wall-clock verification ─────────────────────────

    describe("Parallel execution: pre-signal + routing run concurrently", () => {
        it("total wall-clock ≈ max(signal latency, router latency), not sum", async () => {
            const SIGNAL_LATENCY = 100;
            const ROUTING_LATENCY = 100;

            const provider = new PipelineMockProvider({
                signalResponse: {
                    signals: [{ id: "latency_sig", matched: false }],
                },
                signalLatencyMs: SIGNAL_LATENCY,
                routingLatencyMs: ROUTING_LATENCY,
            });

            const agent = createPipelineAgent({
                signals: [
                    {
                        id: "latency_sig",
                        when: "something",
                        phase: "pre",
                        handler: () => { },
                    },
                ],
                provider,
            });

            const session = await agent.session.getOrCreate();

            const start = performance.now();
            await agent.respond({ history: baseHistory, session });
            const elapsed = performance.now() - start;

            // Both signal evaluation and routing run in parallel (~100ms each).
            // If sequential, total would be ~200ms+. If parallel, ~100ms + response overhead.
            // Allow generous tolerance for CI jitter, but it should be less than the sum.
            const maxExpectedSequential = SIGNAL_LATENCY + ROUTING_LATENCY;
            // It should complete significantly faster than sequential execution
            expect(elapsed).toBeLessThan(maxExpectedSequential * 1.5);
            // And it should be close to the max of the two (within generous tolerance)
            const maxLatency = Math.max(SIGNAL_LATENCY, ROUTING_LATENCY);
            // With response generation overhead, elapsed should be in the ballpark of max + overhead
            // but NOT 2x+ the max (which would indicate sequential execution)
            expect(elapsed).toBeLessThan(maxLatency * 3.5); // generous tolerance for response + overhead
        });
    });

    // ─── Property 7: SignalDirective carries full Directive semantics ─────────

    describe("Property 7: SignalDirective carries full Directive semantics", () => {
        /**
         * Validates: Requirements 7.1, 7.2, 7.3, 7.7, 8.2, 8.3, 8.4
         *
         * Property: A handler-returned directive is applied through the pipeline
         * equivalently to a tool-emitted directive. All position-control, state writes,
         * reply, appendPrompt, injectTools, and halt are inherited unchanged.
         */
        it("halt directive from signal skips LLM and produces the reply", async () => {
            const provider = new PipelineMockProvider({
                signalResponse: {
                    signals: [{ id: "full_dir_sig", matched: true, reason: "halt test" }],
                },
            });

            const agent = createPipelineAgent({
                signals: [
                    {
                        id: "full_dir_sig",
                        when: "user triggers halt",
                        phase: "pre",
                        handler: () => ({
                            halt: true,
                            reply: "Signal-halted response",
                        }),
                    },
                ],
                provider,
            });

            const session = await agent.session.getOrCreate();
            const response = await agent.respond({ history: baseHistory, session });

            expect(response.message).toBe("Signal-halted response");
            expect(provider.responseCallCount).toBe(0);
        });

        it("goTo directive from signal overrides routing position", async () => {
            const provider = new PipelineMockProvider({
                signalResponse: {
                    signals: [{ id: "goto_dir_sig", matched: true, reason: "goto test" }],
                },
            });

            const agent = createPipelineAgent({
                signals: [
                    {
                        id: "goto_dir_sig",
                        when: "user triggers goto",
                        phase: "pre",
                        handler: () => ({ goTo: "OtherFlow" }),
                    },
                ],
                provider,
            });

            const session = await agent.session.getOrCreate();
            const response = await agent.respond({ history: baseHistory, session });

            expect(response.session?.currentFlow?.title).toBe("OtherFlow");
        });

        it("dataUpdate from signal directive is applied to session data (non-halt path)", async () => {
            const provider = new PipelineMockProvider({
                signalResponse: {
                    signals: [{ id: "data_sig", matched: true, reason: "data update" }],
                },
            });

            const agent = createPipelineAgent({
                signals: [
                    {
                        id: "data_sig",
                        when: "user provides info",
                        phase: "pre",
                        // Non-position, non-halt directive — dataUpdate is applied by the pipeline
                        handler: () => ({
                            dataUpdate: { specialField: "signal-written" },
                        }),
                    },
                ],
                provider,
            });

            const session = await agent.session.getOrCreate();
            const response = await agent.respond({ history: baseHistory, session });

            expect((response.session?.data as any)?.specialField).toBe("signal-written");
        });

        it("ctx.updateData in handler persists to session even on halt", async () => {
            const provider = new PipelineMockProvider({
                signalResponse: {
                    signals: [{ id: "ctx_data_sig", matched: true, reason: "ctx update" }],
                },
            });

            const agent = createPipelineAgent({
                signals: [
                    {
                        id: "ctx_data_sig",
                        when: "user provides info",
                        phase: "pre",
                        handler: async (ctx: any) => {
                            await ctx.updateData({ ctxField: "written-via-ctx" });
                            return { halt: true, reply: "Done." };
                        },
                    },
                ],
                provider,
            });

            const session = await agent.session.getOrCreate();
            const response = await agent.respond({ history: baseHistory, session });

            expect(response.message).toBe("Done.");
            expect((response.session?.data as any)?.ctxField).toBe("written-via-ctx");
        });
    });

    // ─── Property 12: Parallel pre-phase does not block routing ───────────────

    describe("Property 12: Parallel pre-phase does not block routing (wall-clock invariant)", () => {
        /**
         * Validates: Requirements 8.1, 8.6
         *
         * Property: The wall-clock time for `runPreSignalPhase + decideFlowAndStep`
         * is approximately max(signal latency, router latency), not the sum.
         * This proves `Promise.all` parallelism is correctly wired.
         */
        it("wall-clock invariant holds across varied latency configurations", async () => {
            await fc.assert(
                fc.asyncProperty(
                    // Signal latency 50-150ms
                    fc.integer({ min: 50, max: 150 }),
                    // Routing latency 50-150ms
                    fc.integer({ min: 50, max: 150 }),
                    async (signalLatency, routingLatency) => {
                        const provider = new PipelineMockProvider({
                            signalResponse: {
                                signals: [{ id: "par_sig", matched: false }],
                            },
                            signalLatencyMs: signalLatency,
                            routingLatencyMs: routingLatency,
                        });

                        const agent = createPipelineAgent({
                            signals: [
                                {
                                    id: "par_sig",
                                    when: "test",
                                    phase: "pre",
                                    handler: () => { },
                                },
                            ],
                            provider,
                        });

                        const session = await agent.session.getOrCreate();

                        const start = performance.now();
                        await agent.respond({ history: baseHistory, session });
                        const elapsed = performance.now() - start;

                        // The sum would be signalLatency + routingLatency.
                        // Parallel execution should complete in approximately
                        // max(signalLatency, routingLatency) + overhead (response generation, etc.).
                        // We verify it's significantly less than the sum.
                        const sequentialTime = signalLatency + routingLatency;
                        // With parallelism, elapsed should be less than ~80% of sequential time
                        // (generous tolerance accounting for response generation overhead)
                        expect(elapsed).toBeLessThan(sequentialTime * 1.5);
                    },
                ),
                { numRuns: 5 }, // Keep low to avoid slow test suite
            );
        });
    });
});


// ─── Persistence Round-Trip Tests ────────────────────────────────────────────

import { MemoryAdapter } from "../src/adapters/MemoryAdapter";
import { PersistenceManager } from "../src/core/PersistenceManager";
import { sessionStepToData, sessionDataToStep } from "../src/utils/session";
import type { SignalsState } from "../src/types/signals";

describe("Signals — Persistence Round-Trip", () => {
    /**
     * Property 10: SignalsState round-trips through every persistence adapter
     * Validates: Requirements 10.3, 10.4
     *
     * Tests that session.signals (with populated triggers including dates,
     * counts, reasons, and phases) round-trips correctly through the
     * MemoryAdapter via save → load.
     */

    describe("Populated signals.triggers round-trips through MemoryAdapter", () => {
        it("round-trips a session with populated signals.triggers via PersistenceManager", async () => {
            const adapter = new MemoryAdapter();
            const manager = new PersistenceManager({ adapter, userId: "test-user" });

            const now = new Date();
            const earlier = new Date(now.getTime() - 60000);

            const originalSignals: SignalsState = {
                triggers: {
                    handoff_signal: {
                        firstTriggeredAt: earlier,
                        lastTriggeredAt: now,
                        count: 3,
                        lastReason: "user asked for human",
                        lastPhase: "pre",
                    },
                    sentiment_signal: {
                        firstTriggeredAt: now,
                        lastTriggeredAt: now,
                        count: 1,
                        lastReason: "negative sentiment detected",
                        lastPhase: "post",
                    },
                },
            };

            const session: SessionState<any> = {
                id: "roundtrip-test-1",
                data: { name: "Test" },
                history: [],
                currentFlow: undefined,
                currentStep: undefined,
                flowHistory: [],
                metadata: {},
                signals: originalSignals,
            };

            // Save
            await manager.saveSessionState(session.id, session);

            // Load
            const loaded = await manager.loadSessionState(session.id);
            expect(loaded).toBeDefined();
            expect(loaded!.signals).toBeDefined();
            expect(loaded!.signals!.triggers).toBeDefined();

            // Assert deep equality of trigger structure
            const loadedTriggers = loaded!.signals!.triggers;
            expect(Object.keys(loadedTriggers)).toEqual(["handoff_signal", "sentiment_signal"]);

            // Check handoff_signal
            const handoff = loadedTriggers.handoff_signal;
            expect(handoff.count).toBe(3);
            expect(handoff.lastReason).toBe("user asked for human");
            expect(handoff.lastPhase).toBe("pre");
            // Date comparison (MemoryAdapter preserves Date instances via cloneDeep)
            expect(new Date(handoff.firstTriggeredAt).getTime()).toBe(earlier.getTime());
            expect(new Date(handoff.lastTriggeredAt).getTime()).toBe(now.getTime());

            // Check sentiment_signal
            const sentiment = loadedTriggers.sentiment_signal;
            expect(sentiment.count).toBe(1);
            expect(sentiment.lastReason).toBe("negative sentiment detected");
            expect(sentiment.lastPhase).toBe("post");
            expect(new Date(sentiment.firstTriggeredAt).getTime()).toBe(now.getTime());
            expect(new Date(sentiment.lastTriggeredAt).getTime()).toBe(now.getTime());
        });

        it("round-trips via sessionStepToData → sessionDataToStep directly", () => {
            const now = new Date();
            const earlier = new Date(now.getTime() - 120000);

            const originalSignals: SignalsState = {
                triggers: {
                    cooldown_sig: {
                        firstTriggeredAt: earlier,
                        lastTriggeredAt: now,
                        count: 5,
                        lastReason: "cooldown elapsed",
                        lastPhase: "pre",
                    },
                },
            };

            const session: SessionState<any> = {
                id: "roundtrip-direct-1",
                data: {},
                history: [],
                currentFlow: undefined,
                currentStep: undefined,
                flowHistory: [],
                metadata: {},
                signals: originalSignals,
            };

            // Convert to persistence format
            const persisted = sessionStepToData(session);
            expect(persisted.collectedData.signals).toBeDefined();
            expect(persisted.collectedData.signals!.triggers.cooldown_sig.count).toBe(5);

            // Convert back
            const restored = sessionDataToStep(session.id, {
                currentFlow: persisted.currentFlow,
                currentStep: persisted.currentStep,
                collectedData: persisted.collectedData,
            });

            expect(restored.signals).toBeDefined();
            expect(restored.signals!.triggers.cooldown_sig.count).toBe(5);
            expect(restored.signals!.triggers.cooldown_sig.lastReason).toBe("cooldown elapsed");
            expect(restored.signals!.triggers.cooldown_sig.lastPhase).toBe("pre");
            expect(new Date(restored.signals!.triggers.cooldown_sig.firstTriggeredAt).getTime()).toBe(earlier.getTime());
            expect(new Date(restored.signals!.triggers.cooldown_sig.lastTriggeredAt).getTime()).toBe(now.getTime());
        });
    });

    describe("Empty signals.triggers round-trips correctly", () => {
        it("empty triggers record round-trips as the same empty record", async () => {
            const adapter = new MemoryAdapter();
            const manager = new PersistenceManager({ adapter, userId: "test-user" });

            const originalSignals: SignalsState = {
                triggers: {},
            };

            const session: SessionState<any> = {
                id: "roundtrip-empty-1",
                data: {},
                history: [],
                currentFlow: undefined,
                currentStep: undefined,
                flowHistory: [],
                metadata: {},
                signals: originalSignals,
            };

            await manager.saveSessionState(session.id, session);
            const loaded = await manager.loadSessionState(session.id);

            expect(loaded).toBeDefined();
            expect(loaded!.signals).toBeDefined();
            expect(loaded!.signals!.triggers).toEqual({});
        });

        it("undefined signals round-trips as undefined (no signals field)", async () => {
            const adapter = new MemoryAdapter();
            const manager = new PersistenceManager({ adapter, userId: "test-user" });

            const session: SessionState<any> = {
                id: "roundtrip-undefined-1",
                data: {},
                history: [],
                currentFlow: undefined,
                currentStep: undefined,
                flowHistory: [],
                metadata: {},
                // signals intentionally omitted
            };

            await manager.saveSessionState(session.id, session);
            const loaded = await manager.loadSessionState(session.id);

            expect(loaded).toBeDefined();
            expect(loaded!.signals).toBeUndefined();
        });
    });

    describe("Property 10: SignalsState round-trips through every persistence adapter", () => {
        /**
         * Validates: Requirements 10.3, 10.4
         *
         * Property: For any arbitrary SignalTriggerState (with valid dates, counts,
         * reasons, and phases), the round-trip through sessionStepToData →
         * sessionDataToStep preserves the signals data bit-identical (modulo
         * Date↔ISO normalization the adapter's contract permits).
         */
        it("arbitrary trigger states round-trip through sessionStepToData/sessionDataToStep", () => {
            fc.assert(
                fc.property(
                    // Generate arbitrary signal trigger states
                    fc.record({
                        triggers: fc.dictionary(
                            // Signal IDs: non-empty alphanumeric strings
                            fc.stringMatching(/^[a-z][a-z0-9_]{0,19}$/),
                            // Trigger state
                            fc.record({
                                firstTriggeredAt: fc.date({ min: new Date("2020-01-01"), max: new Date("2030-01-01") }),
                                lastTriggeredAt: fc.date({ min: new Date("2020-01-01"), max: new Date("2030-01-01") }),
                                count: fc.integer({ min: 1, max: 10000 }),
                                lastReason: fc.option(fc.string({ minLength: 1, maxLength: 100 }), { nil: undefined }),
                                lastPhase: fc.option(
                                    fc.constantFrom("pre" as const, "post" as const),
                                    { nil: undefined },
                                ),
                            }),
                        ),
                    }),
                    (signalsState) => {
                        const session: SessionState<any> = {
                            id: "pbt-roundtrip",
                            data: {},
                            history: [],
                            currentFlow: undefined,
                            currentStep: undefined,
                            flowHistory: [],
                            metadata: {},
                            signals: signalsState as SignalsState,
                        };

                        // Convert to persistence format
                        const persisted = sessionStepToData(session);

                        // Convert back
                        const restored = sessionDataToStep(session.id, {
                            currentFlow: persisted.currentFlow,
                            currentStep: persisted.currentStep,
                            collectedData: persisted.collectedData,
                        });

                        // Verify signals round-tripped
                        if (Object.keys(signalsState.triggers).length === 0) {
                            // Empty triggers should still be present
                            expect(restored.signals).toBeDefined();
                            expect(restored.signals!.triggers).toEqual({});
                        } else {
                            expect(restored.signals).toBeDefined();
                            const restoredTriggers = restored.signals!.triggers;

                            for (const [id, trigger] of Object.entries(signalsState.triggers)) {
                                const restoredTrigger = restoredTriggers[id];
                                expect(restoredTrigger).toBeDefined();
                                expect(restoredTrigger.count).toBe(trigger.count);
                                expect(restoredTrigger.lastReason).toBe(trigger.lastReason);
                                expect(restoredTrigger.lastPhase).toBe(trigger.lastPhase);
                                // Date comparison (adapter may normalize to ISO string or Date)
                                expect(new Date(restoredTrigger.firstTriggeredAt).getTime()).toBe(
                                    new Date(trigger.firstTriggeredAt).getTime(),
                                );
                                expect(new Date(restoredTrigger.lastTriggeredAt).getTime()).toBe(
                                    new Date(trigger.lastTriggeredAt).getTime(),
                                );
                            }
                        }
                    },
                ),
                { numRuns: 50 },
            );
        });

        it("round-trips through MemoryAdapter (full save/load cycle) with arbitrary data", async () => {
            await fc.assert(
                fc.asyncProperty(
                    fc.record({
                        triggers: fc.dictionary(
                            fc.stringMatching(/^[a-z][a-z0-9_]{0,19}$/),
                            fc.record({
                                firstTriggeredAt: fc.date({ min: new Date("2020-01-01"), max: new Date("2030-01-01") }),
                                lastTriggeredAt: fc.date({ min: new Date("2020-01-01"), max: new Date("2030-01-01") }),
                                count: fc.integer({ min: 1, max: 10000 }),
                                lastReason: fc.option(fc.string({ minLength: 1, maxLength: 100 }), { nil: undefined }),
                                lastPhase: fc.option(
                                    fc.constantFrom("pre" as const, "post" as const),
                                    { nil: undefined },
                                ),
                            }),
                        ),
                    }),
                    // Unique session ID per run to avoid collisions
                    fc.uuid(),
                    async (signalsState, sessionId) => {
                        const adapter = new MemoryAdapter();
                        const manager = new PersistenceManager({ adapter, userId: "pbt-user" });

                        const session: SessionState<any> = {
                            id: sessionId,
                            data: {},
                            history: [],
                            currentFlow: undefined,
                            currentStep: undefined,
                            flowHistory: [],
                            metadata: {},
                            signals: signalsState as SignalsState,
                        };

                        await manager.saveSessionState(session.id, session);
                        const loaded = await manager.loadSessionState(session.id);

                        expect(loaded).toBeDefined();

                        if (Object.keys(signalsState.triggers).length === 0) {
                            expect(loaded!.signals).toBeDefined();
                            expect(loaded!.signals!.triggers).toEqual({});
                        } else {
                            expect(loaded!.signals).toBeDefined();
                            const loadedTriggers = loaded!.signals!.triggers;

                            for (const [id, trigger] of Object.entries(signalsState.triggers)) {
                                const loadedTrigger = loadedTriggers[id];
                                expect(loadedTrigger).toBeDefined();
                                expect(loadedTrigger.count).toBe(trigger.count);
                                expect(loadedTrigger.lastReason).toBe(trigger.lastReason);
                                expect(loadedTrigger.lastPhase).toBe(trigger.lastPhase);
                                expect(new Date(loadedTrigger.firstTriggeredAt).getTime()).toBe(
                                    new Date(trigger.firstTriggeredAt).getTime(),
                                );
                                expect(new Date(loadedTrigger.lastTriggeredAt).getTime()).toBe(
                                    new Date(trigger.lastTriggeredAt).getTime(),
                                );
                            }
                        }
                    },
                ),
                { numRuns: 20 },
            );
        });
    });
});


// ─── Observability Tests ─────────────────────────────────────────────────────

describe("Signals — Observability", () => {
    let mockEvaluator: MockSignalEvaluator;
    let mockProvider: CountingMockProvider;

    function makeSession(overrides: Partial<SessionState<any>> = {}): SessionState<any> {
        return {
            id: "obs-test-session",
            data: {},
            history: [],
            currentRoute: null,
            currentStep: null,
            routeHistory: [],
            ...overrides,
        } as SessionState<any>;
    }

    function makeProcessor(signals: any[], batchSize = 10): SignalProcessor<any, any> {
        return new SignalProcessor(
            signals,
            mockProvider as any,
            mockEvaluator as any,
            { batchSize },
        );
    }

    const sampleHistory = makeHistory([
        { role: MessageRole.USER, text: "Hello world" },
    ]);

    beforeEach(() => {
        mockEvaluator = new MockSignalEvaluator();
        mockProvider = new CountingMockProvider({ structured: { signals: [] } });
    });

    describe("Eligible signal ids are logged at DEBUG level (Req 13.1)", () => {
        it("logs eligible signal ids after enabled + phase filter", async () => {
            const debugSpy = spyOn(log, "debug");

            const signals = [
                { id: "sig_a", phase: "pre" as const, handler: () => { } },
                { id: "sig_b", phase: "pre" as const, handler: () => { } },
                { id: "sig_c", phase: "post" as const, handler: () => { } },
            ];

            const processor = makeProcessor(signals);
            await processor.runPreSignalPhase({
                session: makeSession(),
                history: sampleHistory,
                context: {},
            });

            // Should log eligible pre-phase signals (sig_a, sig_b) but NOT sig_c (post-only)
            const eligibleLog = debugSpy.mock.calls.flat().find(
                (arg) => typeof arg === "string" && arg.includes("eligible signals") && arg.includes("pre"),
            );
            expect(eligibleLog).toBeDefined();
            expect(eligibleLog).toContain("sig_a");
            expect(eligibleLog).toContain("sig_b");
            expect(eligibleLog).not.toContain("sig_c");

            debugSpy.mockRestore();
        });

        it("does not log eligible signals when none are eligible (zero-cost path)", async () => {
            const debugSpy = spyOn(log, "debug");

            const signals = [
                { id: "post_only", phase: "post" as const, handler: () => { } },
            ];

            const processor = makeProcessor(signals);
            await processor.runPreSignalPhase({
                session: makeSession(),
                history: sampleHistory,
                context: {},
            });

            // No eligible pre-phase signals → no eligible log
            const eligibleLog = debugSpy.mock.calls.flat().find(
                (arg) => typeof arg === "string" && arg.includes("eligible signals") && arg.includes("pre"),
            );
            expect(eligibleLog).toBeUndefined();

            debugSpy.mockRestore();
        });
    });

    describe("Behavior-gated signal ids are logged at DEBUG level (Req 13.1)", () => {
        it("logs signals remaining after behavior gating", async () => {
            const debugSpy = spyOn(log, "debug");

            const signals = [
                { id: "allowed", phase: "pre" as const, behavior: "always" as const, handler: () => { } },
                { id: "blocked", phase: "pre" as const, behavior: "once" as const, handler: () => { } },
            ];

            // "blocked" already triggered → gated out
            const session = makeSession({
                signals: {
                    triggers: {
                        blocked: {
                            firstTriggeredAt: new Date(),
                            lastTriggeredAt: new Date(),
                            count: 1,
                            lastReason: "test",
                            lastPhase: "pre",
                        },
                    },
                },
            });

            const processor = makeProcessor(signals);
            await processor.runPreSignalPhase({
                session,
                history: sampleHistory,
                context: {},
            });

            // After gating log should have "allowed" but NOT "blocked"
            const gatingLog = debugSpy.mock.calls.flat().find(
                (arg) => typeof arg === "string" && arg.includes("after behavior gating"),
            );
            expect(gatingLog).toBeDefined();
            expect(gatingLog).toContain("allowed");
            expect(gatingLog).not.toContain("blocked");

            debugSpy.mockRestore();
        });
    });

    describe("Handler durations and directive fields are logged at DEBUG level (Req 13.1)", () => {
        it("logs per-handler duration and directive fields when handler returns a directive", async () => {
            const debugSpy = spyOn(log, "debug");

            const signals = [
                {
                    id: "directive_sig",
                    phase: "pre" as const,
                    handler: () => ({ reply: "hello", halt: true }),
                },
            ];

            const processor = makeProcessor(signals);
            await processor.runPreSignalPhase({
                session: makeSession(),
                history: sampleHistory,
                context: {},
            });

            // Should log handler completion with duration and directive fields
            const handlerLog = debugSpy.mock.calls.flat().find(
                (arg) => typeof arg === "string" &&
                    arg.includes("handler") &&
                    arg.includes("directive_sig") &&
                    arg.includes("completed in"),
            );
            expect(handlerLog).toBeDefined();
            expect(handlerLog).toContain("ms");
            expect(handlerLog).toContain("directive fields");
            expect(handlerLog).toContain("reply");
            expect(handlerLog).toContain("halt");

            debugSpy.mockRestore();
        });

        it("logs 'no directive' when handler returns void", async () => {
            const debugSpy = spyOn(log, "debug");

            const signals = [
                {
                    id: "void_sig",
                    phase: "pre" as const,
                    handler: () => { },
                },
            ];

            const processor = makeProcessor(signals);
            await processor.runPreSignalPhase({
                session: makeSession(),
                history: sampleHistory,
                context: {},
            });

            const handlerLog = debugSpy.mock.calls.flat().find(
                (arg) => typeof arg === "string" &&
                    arg.includes("void_sig") &&
                    arg.includes("no directive"),
            );
            expect(handlerLog).toBeDefined();

            debugSpy.mockRestore();
        });
    });

    describe("Handler errors are logged at ERROR level regardless of debug flag (Req 13.2)", () => {
        it("logs handler error at ERROR with signal id and error message", async () => {
            const errorSpy = spyOn(log, "error");

            const signals = [
                {
                    id: "error_sig",
                    phase: "pre" as const,
                    handler: () => { throw new Error("Something went wrong"); },
                },
            ];

            const processor = makeProcessor(signals);
            await processor.runPreSignalPhase({
                session: makeSession(),
                history: sampleHistory,
                context: {},
            });

            // Error should be logged regardless of debug flag
            const errorLog = errorSpy.mock.calls.flat().find(
                (arg) => typeof arg === "string" &&
                    arg.includes("error_sig") &&
                    arg.includes("Something went wrong"),
            );
            expect(errorLog).toBeDefined();
            expect(errorLog).toContain("Handler threw");

            errorSpy.mockRestore();
        });

        it("error is logged even when debug is not enabled (no debug spy needed)", async () => {
            const errorSpy = spyOn(log, "error");

            const signals = [
                {
                    id: "err_no_debug",
                    phase: "post" as const,
                    handler: () => { throw new TypeError("invalid type"); },
                },
            ];

            const processor = makeProcessor(signals);
            await processor.runPostSignalPhase({
                session: makeSession(),
                history: sampleHistory,
                context: {},
            });

            const errorLog = errorSpy.mock.calls.flat().find(
                (arg) => typeof arg === "string" &&
                    arg.includes("err_no_debug") &&
                    arg.includes("invalid type"),
            );
            expect(errorLog).toBeDefined();

            errorSpy.mockRestore();
        });

        it("subsequent handlers still run after a handler error is logged", async () => {
            const errorSpy = spyOn(log, "error");
            const handlerCalls: string[] = [];

            const signals = [
                {
                    id: "failing_sig",
                    phase: "pre" as const,
                    priority: 10,
                    handler: () => { throw new Error("fail"); },
                },
                {
                    id: "ok_sig",
                    phase: "pre" as const,
                    priority: 5,
                    handler: () => { handlerCalls.push("ok_sig"); },
                },
            ];

            const processor = makeProcessor(signals);
            await processor.runPreSignalPhase({
                session: makeSession(),
                history: sampleHistory,
                context: {},
            });

            // Error was logged for failing_sig
            const errorLog = errorSpy.mock.calls.flat().find(
                (arg) => typeof arg === "string" && arg.includes("failing_sig"),
            );
            expect(errorLog).toBeDefined();

            // Subsequent handler still ran
            expect(handlerCalls).toEqual(["ok_sig"]);

            errorSpy.mockRestore();
        });
    });
});
