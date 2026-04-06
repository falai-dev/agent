/**
 * CompactionEngine - Manages conversation history size through multi-layered compaction strategies.
 *
 * Strategies are applied in order of cost:
 * 1. none - history is under threshold, no action needed
 * 2. tool_result_budget - truncate oversized tool results (no LLM call)
 * 3. micro_compact - compress verbose tool outputs inline (no LLM call)
 * 4. auto_compact - summarize old messages via LLM provider
 */

import log from "loglevel";
import type { HistoryItem } from "../types/history";
import type { CompactionOptions, CompactionResult } from "../types/compaction";

export class CompactionEngine {
    /**
     * Validate CompactionOptions. Throws on invalid values.
     */
    static validateOptions(options: CompactionOptions): void {
        if (
            typeof options.compactionThreshold !== "number" ||
            options.compactionThreshold < 0.5 ||
            options.compactionThreshold > 0.95
        ) {
            throw new Error(
                `compactionThreshold must be between 0.5 and 0.95, got ${options.compactionThreshold}`
            );
        }
        if (
            typeof options.preserveRecentCount !== "number" ||
            options.preserveRecentCount < 2
        ) {
            throw new Error(
                `preserveRecentCount must be >= 2, got ${options.preserveRecentCount}`
            );
        }
        if (
            typeof options.maxToolResultChars !== "number" ||
            options.maxToolResultChars <= 0
        ) {
            throw new Error(
                `maxToolResultChars must be > 0, got ${options.maxToolResultChars}`
            );
        }
    }

    /**
     * Estimate token count using a character-based heuristic (~4 chars/token).
     *
     * For each HistoryItem: count content length + name length (if present) + 4 (role overhead).
     * Returns Math.ceil(totalChars / 4). Empty history returns 0.
     * Deterministic for the same input.
     */
    static estimateTokens(history: HistoryItem[]): number {
        if (history.length === 0) return 0;

        let totalChars = 0;
        for (const item of history) {
            const content = item.content;
            const contentLength =
                typeof content === "string" ? content.length : JSON.stringify(content ?? "").length;
            totalChars += contentLength;
            if ("name" in item && typeof item.name === "string") {
                totalChars += item.name.length;
            }
            totalChars += 4; // role overhead
        }
        return Math.ceil(totalChars / 4);
    }

    /**
     * Truncate tool results that exceed the per-message character budget.
     *
     * For HistoryItem with role === 'tool' whose content exceeds maxChars,
     * truncate to maxChars and append truncation notice.
     * Items within budget are returned unchanged.
     */
    static applyToolResultBudget(
        history: HistoryItem[],
        maxCharsPerResult: number
    ): HistoryItem[] {
        return history.map((item) => {
            if (item.role !== "tool") return item;

            const contentStr =
                typeof item.content === "string"
                    ? item.content
                    : JSON.stringify(item.content ?? "");
            const totalChars = contentStr.length;

            if (totalChars <= maxCharsPerResult) return item;

            const preview = contentStr.slice(0, maxCharsPerResult);
            const truncatedContent = `${preview}\n\n[Truncated: ${totalChars} chars total, showing first ${maxCharsPerResult}]`;
            return { ...item, content: truncatedContent };
        });
    }

    /**
     * Micro-compact: compress verbose tool outputs inline.
     * Strips excessive whitespace and shortens JSON-like content in tool results.
     * Preserves the last `preserveCount` messages unchanged.
     */
    private static microCompact(
        history: HistoryItem[],
        preserveCount: number
    ): HistoryItem[] {
        const cutoff = Math.max(0, history.length - preserveCount);
        const compactable = history.slice(0, cutoff);
        const preserved = history.slice(cutoff);

        const compacted = compactable.map((item) => {
            if (item.role !== "tool") return item;

            const contentStr =
                typeof item.content === "string"
                    ? item.content
                    : JSON.stringify(item.content ?? "");

            // Strip excessive whitespace: collapse runs of whitespace to single space
            const compressed = contentStr
                .replace(/\s+/g, " ")
                .trim();

            return { ...item, content: compressed };
        });

        return [...compacted, ...preserved];
    }

    /**
     * Count how many messages differ between original and compacted history.
     */
    private static countDifferences(
        original: HistoryItem[],
        compacted: HistoryItem[]
    ): number {
        let count = 0;
        const len = Math.min(original.length, compacted.length);
        for (let i = 0; i < len; i++) {
            if (original[i] !== compacted[i]) count++;
        }
        // If lengths differ, count the extra messages
        count += Math.abs(original.length - compacted.length);
        return count;
    }

    /**
     * Summarize old messages via LLM provider.
     * On failure, returns null (caller should fall back).
     */
    private static async summarizeMessages(
        messages: HistoryItem[],
        options: CompactionOptions
    ): Promise<string | null> {
        try {
            const messagesText = messages
                .map((m) => {
                    const content =
                        typeof m.content === "string"
                            ? m.content
                            : JSON.stringify(m.content ?? "");
                    return `[${m.role}]: ${content}`;
                })
                .join("\n");

            const result = await options.provider.generateMessage({
                prompt: `Summarize the following conversation concisely, preserving key facts, decisions, and context:\n\n${messagesText}`,
                history: [],
                context: {},
                parameters: {
                    maxOutputTokens: 1024,
                    jsonSchema: {},
                },
            });

            return result.message;
        } catch {
            return null;
        }
    }

    /**
     * Aggressive truncation fallback: remove oldest messages (no LLM needed).
     * Keeps only the most recent messages that fit within the token budget.
     */
    private static aggressiveTruncate(
        history: HistoryItem[],
        options: CompactionOptions
    ): HistoryItem[] {
        const threshold = options.maxTokens * options.compactionThreshold;
        const preserveCount = options.preserveRecentCount;

        // Always preserve the last preserveRecentCount messages
        const preserved = history.slice(-preserveCount);

        // Try to keep as many older messages as fit within budget
        const older = history.slice(0, -preserveCount);
        const result: HistoryItem[] = [];

        // Add older messages from most recent backwards until we'd exceed budget
        for (let i = older.length - 1; i >= 0; i--) {
            const candidate = [older[i], ...result, ...preserved];
            if (CompactionEngine.estimateTokens(candidate) < threshold) {
                result.unshift(older[i]);
            } else {
                break;
            }
        }

        return [...result, ...preserved];
    }

    /**
     * Multi-layered compaction strategy.
     *
     * Layer 1 (none): If estimatedTokens < maxTokens * compactionThreshold, return unchanged
     * Layer 2 (tool_result_budget): Apply applyToolResultBudget, check if under threshold
     * Layer 3 (micro_compact): Compress verbose tool outputs inline
     * Layer 4 (auto_compact): Summarize old messages via LLM provider
     *
     * The last `preserveRecentCount` messages are NEVER modified or removed.
     */
    static async checkAndCompact(
        history: HistoryItem[],
        options: CompactionOptions
    ): Promise<CompactionResult> {
        CompactionEngine.validateOptions(options);

        const threshold = options.maxTokens * options.compactionThreshold;
        const estimatedTokens = CompactionEngine.estimateTokens(history);

        // Layer 1: No compaction needed
        if (estimatedTokens < threshold) {
            return {
                history,
                strategy: "none",
                estimatedTokens,
                messagesCompacted: 0,
            };
        }

        // Layer 2: Tool result budgeting (cheapest — no LLM call)
        // Apply budget but preserve recent messages
        const preserveCount = Math.min(options.preserveRecentCount, history.length);
        const cutoff2 = Math.max(0, history.length - preserveCount);
        const budgeted = [
            ...CompactionEngine.applyToolResultBudget(
                history.slice(0, cutoff2),
                options.maxToolResultChars
            ),
            ...history.slice(cutoff2),
        ];
        let newEstimate = CompactionEngine.estimateTokens(budgeted);
        if (newEstimate < threshold) {
            return {
                history: budgeted,
                strategy: "tool_result_budget",
                estimatedTokens: newEstimate,
                messagesCompacted: CompactionEngine.countDifferences(history, budgeted),
            };
        }

        // Layer 3: Micro-compaction (compress verbose tool outputs)
        const microCompacted = CompactionEngine.microCompact(budgeted, preserveCount);
        newEstimate = CompactionEngine.estimateTokens(microCompacted);
        if (newEstimate < threshold) {
            return {
                history: microCompacted,
                strategy: "micro_compact",
                estimatedTokens: newEstimate,
                messagesCompacted: CompactionEngine.countDifferences(
                    history,
                    microCompacted
                ),
            };
        }

        // Layer 4: Auto-compact (summarize old messages via LLM)
        const oldMessages = microCompacted.slice(0, -preserveCount);
        const recentMessages = microCompacted.slice(-preserveCount);

        const summary = await CompactionEngine.summarizeMessages(
            oldMessages,
            options
        );

        if (summary !== null) {
            const summaryItem: HistoryItem = {
                role: "system",
                content: `[Conversation Summary]\n${summary}`,
            };
            const finalHistory = [summaryItem, ...recentMessages];
            return {
                history: finalHistory,
                strategy: "auto_compact",
                estimatedTokens: CompactionEngine.estimateTokens(finalHistory),
                messagesCompacted: oldMessages.length,
                summary,
            };
        }

        // Fallback: LLM summarization failed — aggressive truncation
        log.warn(
            "CompactionEngine: LLM summarization failed, falling back to aggressive truncation"
        );
        const truncated = CompactionEngine.aggressiveTruncate(
            microCompacted,
            options
        );
        return {
            history: truncated,
            strategy: "auto_compact",
            estimatedTokens: CompactionEngine.estimateTokens(truncated),
            messagesCompacted: history.length - truncated.length,
        };
    }
}
