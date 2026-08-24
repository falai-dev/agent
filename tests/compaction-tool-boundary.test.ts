import { describe, test, expect } from "bun:test";
import fc from "fast-check";
import { CompactionEngine } from "../src/core/CompactionEngine";
import type { HistoryItem } from "../src/types/history";
import type { CompactionOptions } from "../src/types/compaction";
import type { AiProvider } from "../src/types/ai";

// --- Helpers ---

function mockProvider(opts: { shouldFail?: boolean } = {}): AiProvider {
    return {
        name: "MockProvider",
        // Engine only calls generateMessage for summaries; flags are inert here.
        capabilities: {
            supportsTools: false,
            supportsNativeJsonSchema: false,
            supportsStreaming: true,
            supportsStreamingToolCalls: false,
            supportsPromptCaching: false,
        },
        async generateMessage() {
            if (opts.shouldFail) throw new Error("LLM failure");
            return {
                message: "Summary of conversation.",
                metadata: { model: "mock", tokensUsed: 10, finishReason: "stop" },
            };
        },
        async *generateMessageStream() {
            yield { delta: "", accumulated: "", done: true };
        },
    };
}

function makeOptions(overrides: Partial<CompactionOptions> = {}): CompactionOptions {
    return {
        maxTokens: 200,
        compactionThreshold: 0.8,
        preserveRecentCount: 4,
        // High budget + whitespace-free contents keep layers 2-3 ineffective,
        // so compaction deterministically reaches layer 4.
        maxToolResultChars: 5000,
        provider: mockProvider(),
        ...overrides,
    };
}

function userMsg(content: string): HistoryItem {
    return { role: "user", content };
}

function assistantMsg(content: string): HistoryItem {
    return { role: "assistant", content };
}

function assistantToolCallMsg(toolCallId: string): HistoryItem {
    return {
        role: "assistant",
        content: null,
        tool_calls: [{ id: toolCallId, name: "lookup", arguments: {} }],
    };
}

function toolResultMsg(toolCallId: string, content: string): HistoryItem {
    return { role: "tool", tool_call_id: toolCallId, name: "lookup", content };
}

/**
 * Collect tool results whose assistant tool_calls parent is not present
 * earlier in the history — the shape providers reject at the next request.
 */
function findOrphanedToolIds(history: HistoryItem[]): string[] {
    const open = new Set<string>();
    const orphans: string[] = [];
    for (const item of history) {
        if (item.role === "assistant") {
            open.clear();
            for (const call of item.tool_calls ?? []) open.add(call.id);
        } else if (item.role === "tool") {
            if (!open.has(item.tool_call_id)) orphans.push(item.tool_call_id);
        } else {
            open.clear();
        }
    }
    return orphans;
}

// --- Unit regression ---

describe("CompactionEngine preserved-window boundary", () => {
    /**
     * History [u, a(tc_1), t_1, a(tc_2), t_2, a] with preserveRecentCount=4:
     * the naive message-count slice(-4) is [t_1, a(tc_2), t_2, a], which opens
     * on an orphaned tool result. The window must grow left to include a(tc_1).
     */
    const pairedHistory = (): HistoryItem[] => [
        userMsg("find the widget"),
        assistantToolCallMsg("tc_1"),
        toolResultMsg("tc_1", "w".repeat(400)),
        assistantToolCallMsg("tc_2"),
        toolResultMsg("tc_2", "z".repeat(400)),
        assistantMsg("all done"),
    ];

    test("layer 4 auto_compact never splits an assistant/tool pair at the boundary", async () => {
        const history = pairedHistory();
        const result = await CompactionEngine.checkAndCompact(
            history,
            makeOptions()
        );

        expect(result.strategy).toBe("auto_compact");
        expect(findOrphanedToolIds(result.history)).toEqual([]);
        // Only the first user message was summarized away; the pair stayed intact
        expect(result.messagesCompacted).toBe(1);
        expect(result.history[0].role).toBe("system");
        expect(result.history[1]).toBe(history[1]);
        expect(result.history[2]).toBe(history[2]);
        expect(result.history[result.history.length - 1]).toBe(history[5]);
    });

    test("aggressive-truncation fallback also keeps tool pairs intact", async () => {
        const history = pairedHistory();
        const result = await CompactionEngine.checkAndCompact(
            history,
            makeOptions({ provider: mockProvider({ shouldFail: true }) })
        );

        expect(result.strategy).toBe("auto_compact");
        expect(result.summary).toBeUndefined();
        expect(findOrphanedToolIds(result.history)).toEqual([]);
        // Budget only allows dropping the leading user message
        expect(result.history.length).toBe(history.length - 1);
        for (let i = 0; i < result.history.length; i++) {
            expect(result.history[i]).toBe(history[i + 1]);
        }
    });
});

// --- Property: tool-pair invariant under auto-compaction ---

const hexContent = fc.stringMatching(/^[0-9a-f]{240}$/); // no whitespace

function pairedHistoryArb(): fc.Arbitrary<HistoryItem[]> {
    return fc
        .array(
            fc.record({
                id: fc.integer({ min: 0, max: 1 << 30 }).map((n) => `tc_${n}`),
                userContent: hexContent,
                toolContent: hexContent,
            }),
            { minLength: 3, maxLength: 6 }
        )
        .map((pairs) =>
            pairs.flatMap((p): HistoryItem[] => [
                userMsg(p.userContent),
                assistantToolCallMsg(p.id),
                toolResultMsg(p.id, p.toolContent),
            ])
        );
}

describe("Property: compaction output never orphans a tool result", () => {
    test("auto_compact keeps every tool result adjacent to its parent", async () => {
        await fc.assert(
            fc.asyncProperty(
                pairedHistoryArb(),
                fc.integer({ min: 2, max: 8 }),
                async (history, preserveRecentCount) => {
                    const result = await CompactionEngine.checkAndCompact(
                        history,
                        makeOptions({ preserveRecentCount })
                    );

                    // ~61 tokens per message x >=9 messages far exceeds the
                    // 160-token threshold, so layer 4 always runs here.
                    expect(result.strategy).toBe("auto_compact");

                    // No orphaned tool result in the output
                    expect(findOrphanedToolIds(result.history)).toEqual([]);

                    // The last preserveRecentCount originals survive by
                    // reference, contiguously (window may extend further left)
                    const tail = history.slice(-preserveRecentCount);
                    const start = result.history.indexOf(tail[0]);
                    expect(start).toBeGreaterThanOrEqual(0);
                    for (let i = 0; i < tail.length; i++) {
                        expect(result.history[start + i]).toBe(tail[i]);
                    }
                }
            ),
            { numRuns: 50 }
        );
    });
});
