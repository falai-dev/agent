import { describe, test, expect } from "bun:test";
import { CompactionEngine } from "../src/core/CompactionEngine";
import type { HistoryItem } from "../src/types/history";
import type { CompactionOptions } from "../src/types/compaction";
import type { AiProvider } from "../src/types/ai";

// --- Helpers ---

function mockProvider(opts: { shouldFail?: boolean; summary?: string } = {}): AiProvider {
    return {
        name: "MockProvider",
        async generateMessage() {
            if (opts.shouldFail) throw new Error("LLM failure");
            return {
                message: opts.summary ?? "Summary of conversation.",
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
        maxTokens: 1000,
        compactionThreshold: 0.8,
        preserveRecentCount: 2,
        maxToolResultChars: 100,
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

function toolMsg(content: string, name = "tool1"): HistoryItem {
    return { role: "tool", tool_call_id: "tc_1", name, content };
}

function systemMsg(content: string): HistoryItem {
    return { role: "system", content };
}

// --- estimateTokens ---

describe("CompactionEngine.estimateTokens", () => {
    test("returns 0 for empty history", () => {
        expect(CompactionEngine.estimateTokens([])).toBe(0);
    });

    test("returns deterministic result for same input", () => {
        const history: HistoryItem[] = [userMsg("hello"), assistantMsg("hi there")];
        const a = CompactionEngine.estimateTokens(history);
        const b = CompactionEngine.estimateTokens(history);
        expect(a).toBe(b);
    });

    test("returns non-negative integer", () => {
        const history: HistoryItem[] = [userMsg("x")];
        const result = CompactionEngine.estimateTokens(history);
        expect(result).toBeGreaterThanOrEqual(0);
        expect(Number.isInteger(result)).toBe(true);
    });

    test("accounts for content length, name, and role overhead", () => {
        // "hello" = 5 chars content + 4 role overhead = 9 chars → ceil(9/4) = 3
        const history: HistoryItem[] = [userMsg("hello")];
        expect(CompactionEngine.estimateTokens(history)).toBe(Math.ceil(9 / 4));
    });

    test("accounts for name field in tool messages", () => {
        const history: HistoryItem[] = [toolMsg("result", "myTool")];
        // content "result" = 6, name "myTool" = 6, overhead = 4 → 16 chars → ceil(16/4) = 4
        expect(CompactionEngine.estimateTokens(history)).toBe(4);
    });

    test("handles non-string content in tool messages", () => {
        const item: HistoryItem = {
            role: "tool",
            tool_call_id: "tc_1",
            name: "t",
            content: { key: "value" },
        };
        const result = CompactionEngine.estimateTokens([item]);
        expect(result).toBeGreaterThan(0);
    });

    test("handles null content in assistant messages", () => {
        const item: HistoryItem = { role: "assistant", content: null };
        const result = CompactionEngine.estimateTokens([item]);
        expect(result).toBeGreaterThan(0);
    });
});

// --- applyToolResultBudget ---

describe("CompactionEngine.applyToolResultBudget", () => {
    test("returns unchanged messages within budget", () => {
        const history: HistoryItem[] = [toolMsg("short")];
        const result = CompactionEngine.applyToolResultBudget(history, 100);
        expect(result[0]).toBe(history[0]); // same reference
    });

    test("truncates tool messages exceeding budget", () => {
        const longContent = "x".repeat(200);
        const history: HistoryItem[] = [toolMsg(longContent)];
        const result = CompactionEngine.applyToolResultBudget(history, 50);
        const content = result[0].content as string;
        expect(content).toContain("[Truncated: 200 chars total, showing first 50]");
        expect(content.startsWith("x".repeat(50))).toBe(true);
    });

    test("does not modify non-tool messages", () => {
        const history: HistoryItem[] = [userMsg("x".repeat(200))];
        const result = CompactionEngine.applyToolResultBudget(history, 50);
        expect(result[0]).toBe(history[0]);
    });

    test("handles non-string tool content", () => {
        const item: HistoryItem = {
            role: "tool",
            tool_call_id: "tc_1",
            name: "t",
            content: { data: "x".repeat(200) },
        };
        const result = CompactionEngine.applyToolResultBudget([item], 10);
        expect((result[0].content as string)).toContain("[Truncated:");
    });
});

// --- validateOptions ---

describe("CompactionEngine.validateOptions", () => {
    test("accepts valid options", () => {
        expect(() => CompactionEngine.validateOptions(makeOptions())).not.toThrow();
    });

    test("rejects compactionThreshold below 0.5", () => {
        expect(() =>
            CompactionEngine.validateOptions(makeOptions({ compactionThreshold: 0.3 }))
        ).toThrow("compactionThreshold must be between 0.5 and 0.95");
    });

    test("rejects compactionThreshold above 0.95", () => {
        expect(() =>
            CompactionEngine.validateOptions(makeOptions({ compactionThreshold: 0.99 }))
        ).toThrow("compactionThreshold must be between 0.5 and 0.95");
    });

    test("accepts compactionThreshold at boundaries", () => {
        expect(() =>
            CompactionEngine.validateOptions(makeOptions({ compactionThreshold: 0.5 }))
        ).not.toThrow();
        expect(() =>
            CompactionEngine.validateOptions(makeOptions({ compactionThreshold: 0.95 }))
        ).not.toThrow();
    });

    test("rejects preserveRecentCount below 2", () => {
        expect(() =>
            CompactionEngine.validateOptions(makeOptions({ preserveRecentCount: 1 }))
        ).toThrow("preserveRecentCount must be >= 2");
    });

    test("rejects maxToolResultChars of 0", () => {
        expect(() =>
            CompactionEngine.validateOptions(makeOptions({ maxToolResultChars: 0 }))
        ).toThrow("maxToolResultChars must be > 0");
    });

    test("rejects negative maxToolResultChars", () => {
        expect(() =>
            CompactionEngine.validateOptions(makeOptions({ maxToolResultChars: -5 }))
        ).toThrow("maxToolResultChars must be > 0");
    });
});

// --- checkAndCompact ---

describe("CompactionEngine.checkAndCompact", () => {
    test("returns 'none' strategy when under threshold", async () => {
        const history: HistoryItem[] = [userMsg("hi"), assistantMsg("hello")];
        const options = makeOptions({ maxTokens: 10000 });
        const result = await CompactionEngine.checkAndCompact(history, options);
        expect(result.strategy).toBe("none");
        expect(result.history).toBe(history);
        expect(result.messagesCompacted).toBe(0);
    });

    test("applies tool_result_budget when truncation is sufficient", async () => {
        // Create history with a large tool result that pushes over threshold
        const bigToolContent = "x".repeat(4000);
        const history: HistoryItem[] = [
            userMsg("analyze this"),
            toolMsg(bigToolContent, "readFile"),
            assistantMsg("done"),
            userMsg("thanks"),
        ];
        const options = makeOptions({
            maxTokens: 500,
            compactionThreshold: 0.8,
            maxToolResultChars: 50,
            preserveRecentCount: 2,
        });
        const result = await CompactionEngine.checkAndCompact(history, options);
        // Should have truncated the tool result
        expect(result.strategy).toBe("tool_result_budget");
        expect(result.estimatedTokens).toBeLessThan(500 * 0.8);
    });

    test("preserves last preserveRecentCount messages unchanged", async () => {
        const bigToolContent = "x".repeat(4000);
        const recent1 = assistantMsg("recent1");
        const recent2 = userMsg("recent2");
        const history: HistoryItem[] = [
            userMsg("old"),
            toolMsg(bigToolContent, "readFile"),
            recent1,
            recent2,
        ];
        const options = makeOptions({
            maxTokens: 500,
            compactionThreshold: 0.8,
            maxToolResultChars: 50,
            preserveRecentCount: 2,
        });
        const result = await CompactionEngine.checkAndCompact(history, options);
        const len = result.history.length;
        // Last 2 messages should be identical to originals
        expect(result.history[len - 2]).toBe(recent1);
        expect(result.history[len - 1]).toBe(recent2);
    });

    test("falls back to auto_compact with LLM summarization", async () => {
        // Create history that's too large for tool_result_budget and micro_compact
        const history: HistoryItem[] = [];
        for (let i = 0; i < 50; i++) {
            history.push(userMsg("a".repeat(100)));
            history.push(assistantMsg("b".repeat(100)));
        }
        const options = makeOptions({
            maxTokens: 200,
            compactionThreshold: 0.5,
            preserveRecentCount: 2,
            maxToolResultChars: 50,
            provider: mockProvider({ summary: "Conversation about letters." }),
        });
        const result = await CompactionEngine.checkAndCompact(history, options);
        expect(result.strategy).toBe("auto_compact");
        expect(result.summary).toBe("Conversation about letters.");
        // Should have a summary system message + preserved recent messages
        expect(result.history[0].role).toBe("system");
        expect((result.history[0].content as string)).toContain("[Conversation Summary]");
    });

    test("falls back to aggressive truncation when LLM fails", async () => {
        const history: HistoryItem[] = [];
        for (let i = 0; i < 50; i++) {
            history.push(userMsg("a".repeat(100)));
            history.push(assistantMsg("b".repeat(100)));
        }
        const options = makeOptions({
            maxTokens: 200,
            compactionThreshold: 0.5,
            preserveRecentCount: 2,
            maxToolResultChars: 50,
            provider: mockProvider({ shouldFail: true }),
        });
        const result = await CompactionEngine.checkAndCompact(history, options);
        expect(result.strategy).toBe("auto_compact");
        expect(result.summary).toBeUndefined();
        // Should still have preserved recent messages
        const len = result.history.length;
        expect(result.history[len - 1]).toBe(history[history.length - 1]);
        expect(result.history[len - 2]).toBe(history[history.length - 2]);
        // Should be fewer messages than original
        expect(result.history.length).toBeLessThan(history.length);
    });

    test("rejects invalid options", async () => {
        const history: HistoryItem[] = [userMsg("hi")];
        await expect(
            CompactionEngine.checkAndCompact(history, makeOptions({ compactionThreshold: 0.1 }))
        ).rejects.toThrow("compactionThreshold");
    });

    test("micro_compact compresses whitespace in tool results", async () => {
        // Create tool results with lots of whitespace that tool_result_budget alone won't fix
        const spacyContent = Array(20).fill("key:   value").join("\n\n\n");
        const history: HistoryItem[] = [];
        for (let i = 0; i < 10; i++) {
            history.push(userMsg("q"));
            history.push(toolMsg(spacyContent, "t"));
        }
        history.push(userMsg("recent1"));
        history.push(assistantMsg("recent2"));

        const options = makeOptions({
            maxTokens: 300,
            compactionThreshold: 0.8,
            maxToolResultChars: 5000, // high budget so tool_result_budget doesn't help
            preserveRecentCount: 2,
        });
        const result = await CompactionEngine.checkAndCompact(history, options);
        // Should use micro_compact or higher strategy
        expect(["micro_compact", "auto_compact"]).toContain(result.strategy);
    });
});
