/**
 * Context compaction types for managing conversation history size
 */

import type { AiProvider } from "./ai";
import type { HistoryItem } from "./history";

/**
 * Configuration for the compaction engine.
 *
 * Validation constraints:
 * - `compactionThreshold` must be between 0.5 and 0.95
 * - `preserveRecentCount` must be >= 2
 * - `maxToolResultChars` must be > 0
 */
export interface CompactionOptions {
    /** Maximum token budget for the conversation */
    maxTokens: number;
    /**
     * Threshold ratio (0–1) at which to trigger compaction.
     * Must be between 0.5 and 0.95.
     */
    compactionThreshold: number;
    /**
     * Number of recent messages to always preserve unchanged.
     * Must be >= 2.
     */
    preserveRecentCount: number;
    /**
     * Maximum characters per tool result before truncation.
     * Must be > 0.
     */
    maxToolResultChars: number;
    /** Provider to use for LLM summarization during auto-compact */
    provider: AiProvider;
}

/**
 * Result of a compaction operation
 */
export interface CompactionResult<_TData = unknown> {
    /** The compacted history */
    history: HistoryItem[];
    /** Strategy that was applied */
    strategy: 'none' | 'tool_result_budget' | 'micro_compact' | 'auto_compact';
    /** Estimated tokens after compaction */
    estimatedTokens: number;
    /** Number of messages removed/compacted */
    messagesCompacted: number;
    /** Summary text (if auto-compact was used) */
    summary?: string;
}
