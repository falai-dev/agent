import { describe, test, expect } from "bun:test";
import fc from "fast-check";
import { CompactionEngine } from "../src/core/CompactionEngine";
import type { HistoryItem } from "../src/types/history";

// --- Arbitraries for HistoryItem variants ---

const userHistoryItemArb: fc.Arbitrary<HistoryItem> = fc.record({
    role: fc.constant("user" as const),
    content: fc.string(),
    name: fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
});

const toolCallArb = fc.record({
    id: fc.string({ minLength: 1 }),
    name: fc.string({ minLength: 1 }),
    arguments: fc.dictionary(fc.string({ minLength: 1 }), fc.jsonValue()),
});

const assistantHistoryItemArb: fc.Arbitrary<HistoryItem> = fc.record({
    role: fc.constant("assistant" as const),
    content: fc.option(fc.string(), { nil: null }),
    tool_calls: fc.option(fc.array(toolCallArb, { minLength: 0, maxLength: 3 }), {
        nil: undefined,
    }),
});

const toolHistoryItemArb: fc.Arbitrary<HistoryItem> = fc.record({
    role: fc.constant("tool" as const),
    tool_call_id: fc.string({ minLength: 1 }),
    name: fc.string({ minLength: 1 }),
    content: fc.oneof(fc.string(), fc.jsonValue()),
});

const systemHistoryItemArb: fc.Arbitrary<HistoryItem> = fc.record({
    role: fc.constant("system" as const),
    content: fc.string(),
});

const historyItemArb: fc.Arbitrary<HistoryItem> = fc.oneof(
    userHistoryItemArb,
    assistantHistoryItemArb,
    toolHistoryItemArb,
    systemHistoryItemArb
);

const historyArb: fc.Arbitrary<HistoryItem[]> = fc.array(historyItemArb, {
    minLength: 0,
    maxLength: 30,
});

// --- Property 8: Token Estimation Consistency ---

describe("Property 8: Token Estimation Consistency", () => {
    /**
     * **Validates: Requirements 6.1, 6.2, 6.3**
     *
     * For any history, estimateTokens returns a deterministic non-negative integer;
     * empty history returns 0; same input always produces same output.
     */

    test("estimateTokens always returns a non-negative integer for any history", () => {
        fc.assert(
            fc.property(historyArb, (history) => {
                const result = CompactionEngine.estimateTokens(history);
                expect(result).toBeGreaterThanOrEqual(0);
                expect(Number.isInteger(result)).toBe(true);
            }),
            { numRuns: 200 }
        );
    });

    test("estimateTokens is deterministic: same input always produces same output", () => {
        fc.assert(
            fc.property(historyArb, (history) => {
                const first = CompactionEngine.estimateTokens(history);
                const second = CompactionEngine.estimateTokens(history);
                expect(first).toBe(second);
            }),
            { numRuns: 200 }
        );
    });

    test("estimateTokens returns 0 for empty history", () => {
        expect(CompactionEngine.estimateTokens([])).toBe(0);
    });
});

// --- Property 7: Tool Result Budget Enforcement ---

describe("Property 7: Tool Result Budget Enforcement", () => {
    /**
     * **Validates: Requirements 5.3, 13.1, 13.2, 13.3**
     *
     * For any history with tool results, after applyToolResultBudget:
     * messages exceeding limit are truncated with notice;
     * messages within budget are unchanged.
     */

    // Arbitrary for tool items with string content of controlled length
    const toolItemWithContentArb = (minLen: number, maxLen: number): fc.Arbitrary<HistoryItem> =>
        fc.record({
            role: fc.constant("tool" as const),
            tool_call_id: fc.string({ minLength: 1 }),
            name: fc.string({ minLength: 1 }),
            content: fc.string({ minLength: minLen, maxLength: maxLen }),
        });

    const maxCharsArb = fc.integer({ min: 1, max: 500 });

    test("tool results within budget are returned as the same reference (unchanged)", () => {
        fc.assert(
            fc.property(
                maxCharsArb,
                fc.array(toolItemWithContentArb(0, 500), { minLength: 1, maxLength: 20 }),
                (maxChars, history) => {
                    const result = CompactionEngine.applyToolResultBudget(history, maxChars);
                    for (let i = 0; i < history.length; i++) {
                        const original = history[i] as { content: string };
                        if (original.content.length <= maxChars) {
                            // Within budget: same reference
                            expect(result[i]).toBe(history[i]);
                        }
                    }
                }
            ),
            { numRuns: 200 }
        );
    });

    test("tool results exceeding budget are truncated with correct notice format", () => {
        fc.assert(
            fc.property(
                fc.integer({ min: 1, max: 200 }),
                fc.array(toolItemWithContentArb(1, 1000), { minLength: 1, maxLength: 20 }),
                (maxChars, history) => {
                    const result = CompactionEngine.applyToolResultBudget(history, maxChars);
                    for (let i = 0; i < history.length; i++) {
                        const original = history[i] as { content: string };
                        const totalChars = original.content.length;
                        if (totalChars > maxChars) {
                            const truncated = result[i] as { content: string };
                            const expectedNotice = `[Truncated: ${totalChars} chars total, showing first ${maxChars}]`;
                            expect(truncated.content).toContain(expectedNotice);
                            // The preview portion is the first maxChars of original content
                            expect(truncated.content).toContain(original.content.slice(0, maxChars));
                        }
                    }
                }
            ),
            { numRuns: 200 }
        );
    });

    test("non-tool messages are never modified regardless of content length", () => {
        const nonToolItemArb: fc.Arbitrary<HistoryItem> = fc.oneof(
            userHistoryItemArb,
            assistantHistoryItemArb,
            systemHistoryItemArb
        );

        fc.assert(
            fc.property(
                maxCharsArb,
                fc.array(nonToolItemArb, { minLength: 1, maxLength: 20 }),
                (maxChars, history) => {
                    const result = CompactionEngine.applyToolResultBudget(history, maxChars);
                    expect(result.length).toBe(history.length);
                    for (let i = 0; i < history.length; i++) {
                        // Non-tool items should be the exact same reference
                        expect(result[i]).toBe(history[i]);
                    }
                }
            ),
            { numRuns: 200 }
        );
    });
});

// --- Property 6: Compaction Preservation of Recent Messages ---

import type { CompactionOptions } from "../src/types/compaction";
import type { AiProvider } from "../src/types/ai";

/**
 * Mock AiProvider that returns a simple summary string.
 */
const mockProvider: AiProvider = {
    name: "mock-provider",
    async generateMessage() {
        return { message: "Summary of previous conversation." };
    },
    async *generateMessageStream() {
        yield { delta: "Summary", accumulated: "Summary", done: true };
    },
};

/**
 * Arbitrary for CompactionOptions with valid ranges.
 * Uses the mock provider.
 */
const compactionOptionsArb: fc.Arbitrary<CompactionOptions> = fc.record({
    maxTokens: fc.integer({ min: 1, max: 5000 }),
    compactionThreshold: fc.double({ min: 0.5, max: 0.95, noNaN: true }),
    preserveRecentCount: fc.integer({ min: 2, max: 10 }),
    maxToolResultChars: fc.integer({ min: 1, max: 500 }),
    provider: fc.constant(mockProvider),
});

/**
 * Generate a history that is large enough to trigger compaction for the given options.
 * We produce enough messages so that the token estimate exceeds the threshold.
 */
function largeHistoryArb(options: CompactionOptions): fc.Arbitrary<HistoryItem[]> {
    const threshold = options.maxTokens * options.compactionThreshold;
    // Each message needs ~4 chars/token. We need totalChars > threshold * 4.
    // Each message contributes at least (content.length + 4) chars.
    // Use content of ~100 chars each, so each message ≈ 26 tokens.
    // We need at least ceil(threshold / 26) + preserveRecentCount messages.
    const minMessages = Math.max(
        options.preserveRecentCount + 2,
        Math.ceil(threshold / 26) + options.preserveRecentCount
    );
    const count = Math.min(minMessages + 5, 80); // cap to keep tests fast

    return fc.array(
        fc.oneof(
            fc.record({
                role: fc.constant("user" as const),
                content: fc.string({ minLength: 80, maxLength: 150 }),
            }),
            fc.record({
                role: fc.constant("assistant" as const),
                content: fc.string({ minLength: 80, maxLength: 150 }),
                tool_calls: fc.constant(undefined),
            }),
            fc.record({
                role: fc.constant("tool" as const),
                tool_call_id: fc.string({ minLength: 1 }),
                name: fc.string({ minLength: 1 }),
                content: fc.string({ minLength: 80, maxLength: 150 }),
            }),
        ),
        { minLength: count, maxLength: count }
    );
}

describe("Property 6: Compaction Preservation of Recent Messages", () => {
    /**
     * **Validates: Requirement 5.5**
     *
     * For any compaction operation, the last `preserveRecentCount` messages
     * are identical (same reference) to the corresponding messages in the original history.
     */

    test("last preserveRecentCount messages are identical to originals after compaction", async () => {
        await fc.assert(
            fc.asyncProperty(
                compactionOptionsArb.chain((opts) =>
                    largeHistoryArb(opts).map((history) => ({ history, opts }))
                ),
                async ({ history, opts }) => {
                    const result = await CompactionEngine.checkAndCompact(history, opts);

                    const preserveCount = Math.min(opts.preserveRecentCount, history.length);
                    const originalTail = history.slice(-preserveCount);
                    const resultTail = result.history.slice(-preserveCount);

                    expect(resultTail.length).toBe(originalTail.length);

                    for (let i = 0; i < preserveCount; i++) {
                        // Same reference — not just deep equal, but the exact same object
                        expect(resultTail[i]).toBe(originalTail[i]);
                    }
                }
            ),
            { numRuns: 50 }
        );
    });
});


// --- Property 9: Compaction Idempotency ---

describe("Property 9: Compaction Idempotency", () => {
    /**
     * **Validates: Requirements 7.1, 7.2**
     *
     * For any history, `compact(compact(h, opts), opts) === compact(h, opts)`;
     * history below threshold returns unchanged with strategy `'none'`.
     */

    test("history below compaction threshold is returned unchanged with strategy 'none'", async () => {
        // Use options with a high enough maxTokens so that a small history
        // (up to 5 messages with short content) stays below the threshold.
        // Each message ≈ (content.length + 4) / 4 tokens. With content ≤ 10 chars
        // and 5 messages: max ≈ 5 * ceil((10+4)/4) = 5 * 4 = 20 tokens.
        // So maxTokens >= 40 with threshold 0.5 gives threshold of 20, which is safe.
        const safeOptionsArb: fc.Arbitrary<CompactionOptions> = fc.record({
            maxTokens: fc.integer({ min: 500, max: 5000 }),
            compactionThreshold: fc.double({ min: 0.5, max: 0.95, noNaN: true }),
            preserveRecentCount: fc.integer({ min: 2, max: 10 }),
            maxToolResultChars: fc.integer({ min: 1, max: 500 }),
            provider: fc.constant(mockProvider),
        });

        await fc.assert(
            fc.asyncProperty(
                safeOptionsArb.chain((opts) => {
                    // Compute the max tokens we can use for the small history.
                    const threshold = opts.maxTokens * opts.compactionThreshold;
                    // Each message: ceil((contentLen + 4) / 4). With content ≤ maxContentLen
                    // and up to maxMsgs messages, total tokens ≤ maxMsgs * ceil((maxContentLen+4)/4).
                    // We want total < threshold, so maxMsgs * ceil((maxContentLen+4)/4) < threshold.
                    const maxContentLen = 10;
                    const tokensPerMsg = Math.ceil((maxContentLen + 4) / 4);
                    const maxMsgs = Math.min(5, Math.floor(threshold / tokensPerMsg) - 1);

                    if (maxMsgs <= 0) {
                        // Threshold too low for even 1 message; generate empty history
                        return fc.constant({ history: [] as HistoryItem[], opts });
                    }

                    const smallHistoryArb = fc.array(
                        fc.oneof(
                            fc.record({
                                role: fc.constant("user" as const),
                                content: fc.string({ minLength: 0, maxLength: maxContentLen }),
                            }),
                            fc.record({
                                role: fc.constant("assistant" as const),
                                content: fc.string({ minLength: 0, maxLength: maxContentLen }),
                                tool_calls: fc.constant(undefined),
                            }),
                        ),
                        { minLength: 0, maxLength: maxMsgs }
                    );
                    return smallHistoryArb.map((history) => ({ history, opts }));
                }),
                async ({ history, opts }) => {
                    const result = await CompactionEngine.checkAndCompact(history, opts);

                    expect(result.strategy).toBe("none");
                    expect(result.history).toBe(history);
                    expect(result.messagesCompacted).toBe(0);
                }
            ),
            { numRuns: 100 }
        );
    });

    test("applying checkAndCompact twice produces the same result as once (idempotency)", async () => {
        // Use options with maxTokens large enough that the compacted result
        // (summary message + preserved recent messages) fits under the threshold.
        // The mock provider returns "Summary of previous conversation." (38 chars).
        // Summary system message ≈ ceil((len("[Conversation Summary]\n") + 38 + 4) / 4) ≈ 17 tokens.
        // Plus preserveRecentCount messages (each up to ~40 tokens with 150 char content).
        // We need maxTokens * threshold > summary tokens + preserved tokens.
        // Using maxTokens >= 500 ensures the compacted result fits comfortably.
        const idempotentOptionsArb: fc.Arbitrary<CompactionOptions> = fc.record({
            maxTokens: fc.integer({ min: 500, max: 5000 }),
            compactionThreshold: fc.double({ min: 0.5, max: 0.95, noNaN: true }),
            preserveRecentCount: fc.integer({ min: 2, max: 5 }),
            maxToolResultChars: fc.integer({ min: 1, max: 500 }),
            provider: fc.constant(mockProvider),
        });

        await fc.assert(
            fc.asyncProperty(
                idempotentOptionsArb.chain((opts) =>
                    largeHistoryArb(opts).map((history) => ({ history, opts }))
                ),
                async ({ history, opts }) => {
                    // First compaction
                    const first = await CompactionEngine.checkAndCompact(history, opts);
                    // Second compaction on the already-compacted history
                    const second = await CompactionEngine.checkAndCompact(first.history, opts);

                    // The second compaction should produce the same history as the first
                    expect(second.history.length).toBe(first.history.length);
                    for (let i = 0; i < first.history.length; i++) {
                        const a = first.history[i];
                        const b = second.history[i];
                        expect(b.role).toBe(a.role);
                        expect(b.content).toEqual(a.content);
                        if ("name" in a) {
                            expect((b as any).name).toEqual((a as any).name);
                        }
                        if ("tool_call_id" in a) {
                            expect((b as any).tool_call_id).toEqual((a as any).tool_call_id);
                        }
                        if ("tool_calls" in a) {
                            expect((b as any).tool_calls).toEqual((a as any).tool_calls);
                        }
                    }

                    // Strategy should be 'none' on second pass (already compacted)
                    expect(second.strategy).toBe("none");
                    expect(second.messagesCompacted).toBe(0);
                }
            ),
            { numRuns: 50 }
        );
    });
});


// --- Property 12: CompactionOptions Validation ---

describe("Property 12: CompactionOptions Validation", () => {
    /**
     * **Validates: Requirements 11.2, 11.3, 11.4**
     *
     * For any CompactionOptions, reject compactionThreshold outside [0.5, 0.95],
     * preserveRecentCount < 2, maxToolResultChars <= 0.
     */

    // Valid base options to use when testing a single invalid field
    const validBase: Omit<CompactionOptions, "provider"> = {
        maxTokens: 1000,
        compactionThreshold: 0.8,
        preserveRecentCount: 5,
        maxToolResultChars: 100,
    };

    test("rejects compactionThreshold below 0.5", () => {
        fc.assert(
            fc.property(
                fc.double({ min: -10, max: 0.49, noNaN: true }),
                (threshold) => {
                    const opts: CompactionOptions = {
                        ...validBase,
                        compactionThreshold: threshold,
                        provider: mockProvider,
                    };
                    expect(() => CompactionEngine.validateOptions(opts)).toThrow();
                }
            ),
            { numRuns: 200 }
        );
    });

    test("rejects compactionThreshold above 0.95", () => {
        fc.assert(
            fc.property(
                fc.double({ min: 0.96, max: 10, noNaN: true }),
                (threshold) => {
                    const opts: CompactionOptions = {
                        ...validBase,
                        compactionThreshold: threshold,
                        provider: mockProvider,
                    };
                    expect(() => CompactionEngine.validateOptions(opts)).toThrow();
                }
            ),
            { numRuns: 200 }
        );
    });

    test("rejects preserveRecentCount less than 2", () => {
        fc.assert(
            fc.property(
                fc.integer({ min: -100, max: 1 }),
                (count) => {
                    const opts: CompactionOptions = {
                        ...validBase,
                        preserveRecentCount: count,
                        provider: mockProvider,
                    };
                    expect(() => CompactionEngine.validateOptions(opts)).toThrow();
                }
            ),
            { numRuns: 200 }
        );
    });

    test("rejects maxToolResultChars of 0 or less", () => {
        fc.assert(
            fc.property(
                fc.integer({ min: -100, max: 0 }),
                (chars) => {
                    const opts: CompactionOptions = {
                        ...validBase,
                        maxToolResultChars: chars,
                        provider: mockProvider,
                    };
                    expect(() => CompactionEngine.validateOptions(opts)).toThrow();
                }
            ),
            { numRuns: 200 }
        );
    });

    test("accepts valid CompactionOptions without throwing", () => {
        fc.assert(
            fc.property(
                compactionOptionsArb,
                (opts) => {
                    expect(() => CompactionEngine.validateOptions(opts)).not.toThrow();
                }
            ),
            { numRuns: 200 }
        );
    });
});
