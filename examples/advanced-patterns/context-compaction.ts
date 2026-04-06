/**
 * Context Compaction Example
 *
 * Demonstrates the CompactionEngine for managing conversation history size.
 * Shows agent-level compaction config and how long conversations trigger
 * automatic compaction through layered strategies.
 *
 * Key concepts:
 * - Agent-level compaction configuration via `AgentCompactionConfig`
 * - Token estimation using character-based heuristic (~4 chars/token)
 * - Layered compaction strategies: tool_result_budget → micro_compact → auto_compact
 * - Preservation of recent messages during compaction
 * - Manual compaction via CompactionEngine API
 */

import {
    Agent,
    CompactionEngine,
    GeminiProvider,
    type HistoryItem,
    type CompactionOptions,
} from "../../src/index";

// --- Agent-level compaction config ---

async function demonstrateAgentCompaction() {
    console.log("=== Agent-Level Compaction Config ===\n");

    const provider = new GeminiProvider({
        apiKey: process.env.GEMINI_API_KEY || "demo-key",
        model: "models/gemini-2.5-flash",
    });

    // Compaction is configured at the agent level.
    // The agent validates options on construction and wires the CompactionEngine
    // into the SessionManager so compaction happens transparently.
    const agent = new Agent({
        name: "LongConversationAgent",
        description: "An agent that handles long conversations gracefully",
        provider,
        compaction: {
            maxTokens: 100_000,
            compactionThreshold: 0.8,   // compact at 80% of budget
            preserveRecentCount: 10,    // always keep last 10 messages
            maxToolResultChars: 5_000,  // truncate tool results over 5k chars
            enabled: true,
        },
    });

    console.log("Agent created with compaction config:");
    console.log("  maxTokens:           100,000");
    console.log("  compactionThreshold: 0.8 (triggers at 80k tokens)");
    console.log("  preserveRecentCount: 10");
    console.log("  maxToolResultChars:  5,000");
    console.log();
    console.log("Compaction runs automatically in SessionManager when history grows.");
    console.log("No manual intervention needed for typical usage.\n");
}

// --- Manual CompactionEngine usage ---

async function demonstrateManualCompaction() {
    console.log("=== Manual CompactionEngine Usage ===\n");

    // Build a synthetic history with large tool results
    const history: HistoryItem[] = [
        { role: "user", content: "Analyze the codebase for security issues." },
        { role: "assistant", content: "I'll scan the files for common vulnerabilities." },
        { role: "tool", tool_call_id: "tc_1", name: "scan_files", content: "x".repeat(20_000) },
        { role: "assistant", content: "Found some issues. Let me check more files." },
        { role: "tool", tool_call_id: "tc_2", name: "scan_files", content: "y".repeat(15_000) },
        { role: "user", content: "What about SQL injection?" },
        { role: "assistant", content: "Let me search for raw SQL queries." },
        { role: "tool", tool_call_id: "tc_3", name: "search_code", content: "z".repeat(10_000) },
        { role: "user", content: "Summarize the findings." },
        { role: "assistant", content: "Here is a summary of the security audit." },
    ];

    // 1. Token estimation
    const tokens = CompactionEngine.estimateTokens(history);
    console.log(`Estimated tokens: ${tokens}`);
    console.log(`Total messages:   ${history.length}\n`);

    // 2. Tool result budgeting (no LLM call needed)
    const budgeted = CompactionEngine.applyToolResultBudget(history, 5_000);
    const budgetedTokens = CompactionEngine.estimateTokens(budgeted);
    console.log("After tool result budget (maxChars=5000):");
    console.log(`  Tokens: ${tokens} → ${budgetedTokens}`);

    for (let i = 0; i < budgeted.length; i++) {
        if (budgeted[i].role === "tool") {
            const truncated = budgeted[i].content.length < history[i].content.length;
            console.log(`  Message ${i} (tool): ${truncated ? "truncated" : "unchanged"} (${budgeted[i].content.length} chars)`);
        }
    }
    console.log();

    // 3. Full compaction with a mock provider
    // In real usage you'd pass the agent's provider for LLM summarization.
    // Here we show the layered strategy selection.
    const mockProvider = {
        generateMessage: async () => ({
            content: "Security audit found 3 potential SQL injection points and 2 XSS vulnerabilities.",
            toolCalls: [],
        }),
    };

    const options: CompactionOptions = {
        maxTokens: 5_000,           // tight budget to force compaction
        compactionThreshold: 0.8,
        preserveRecentCount: 4,
        maxToolResultChars: 2_000,
        provider: mockProvider as any,
    };

    const result = await CompactionEngine.checkAndCompact(history, options);

    console.log("Full compaction result:");
    console.log(`  Strategy:          ${result.strategy}`);
    console.log(`  Estimated tokens:  ${result.estimatedTokens}`);
    console.log(`  Messages compacted: ${result.messagesCompacted}`);
    console.log(`  History length:    ${result.history.length} (was ${history.length})`);
    if (result.summary) {
        console.log(`  Summary:           "${result.summary}"`);
    }
}

// --- Demonstrating compaction strategies ---

async function demonstrateStrategies() {
    console.log("\n=== Compaction Strategy Ladder ===\n");

    const smallHistory: HistoryItem[] = [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there!" },
    ];

    const mockProvider = {
        generateMessage: async () => ({
            content: "Conversation summary.",
            toolCalls: [],
        }),
    };

    const baseOptions: CompactionOptions = {
        maxTokens: 10_000,
        compactionThreshold: 0.8,
        preserveRecentCount: 2,
        maxToolResultChars: 1_000,
        provider: mockProvider as any,
    };

    // Strategy: 'none' — history is well under budget
    const r1 = await CompactionEngine.checkAndCompact(smallHistory, baseOptions);
    console.log(`Small history (${CompactionEngine.estimateTokens(smallHistory)} tokens):`);
    console.log(`  → Strategy: ${r1.strategy}\n`);

    // Strategy: 'tool_result_budget' — large tool results push over threshold
    const mediumHistory: HistoryItem[] = [
        { role: "user", content: "Analyze this." },
        { role: "tool", tool_call_id: "tc_m1", name: "analyze", content: "a".repeat(30_000) },
        { role: "user", content: "Thanks." },
        { role: "assistant", content: "You're welcome." },
    ];

    const r2 = await CompactionEngine.checkAndCompact(mediumHistory, {
        ...baseOptions,
        maxTokens: 2_000,
    });
    console.log(`Medium history with large tool result (${CompactionEngine.estimateTokens(mediumHistory)} tokens):`);
    console.log(`  → Strategy: ${r2.strategy}`);
    console.log(`  → Tokens after: ${r2.estimatedTokens}\n`);

    // Strategy: 'auto_compact' — many messages push well over budget
    const longHistory: HistoryItem[] = Array.from({ length: 50 }, (_, i) => ({
        role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
        content: `Message ${i}: ${"lorem ipsum ".repeat(100)}`,
    }));

    const r3 = await CompactionEngine.checkAndCompact(longHistory, {
        ...baseOptions,
        maxTokens: 5_000,
    });
    console.log(`Long history (${CompactionEngine.estimateTokens(longHistory)} tokens, ${longHistory.length} messages):`);
    console.log(`  → Strategy: ${r3.strategy}`);
    console.log(`  → Tokens after: ${r3.estimatedTokens}`);
    console.log(`  → Messages compacted: ${r3.messagesCompacted}`);
}

// --- Validation demo ---

function demonstrateValidation() {
    console.log("\n=== CompactionOptions Validation ===\n");

    const invalidConfigs = [
        { label: "threshold too low (0.3)", opts: { compactionThreshold: 0.3, preserveRecentCount: 4, maxToolResultChars: 1000, maxTokens: 10000 } },
        { label: "threshold too high (0.99)", opts: { compactionThreshold: 0.99, preserveRecentCount: 4, maxToolResultChars: 1000, maxTokens: 10000 } },
        { label: "preserveRecentCount < 2", opts: { compactionThreshold: 0.8, preserveRecentCount: 1, maxToolResultChars: 1000, maxTokens: 10000 } },
        { label: "maxToolResultChars <= 0", opts: { compactionThreshold: 0.8, preserveRecentCount: 4, maxToolResultChars: 0, maxTokens: 10000 } },
    ];

    for (const { label, opts } of invalidConfigs) {
        try {
            CompactionEngine.validateOptions(opts as any);
            console.log(`  ${label}: accepted (unexpected)`);
        } catch (e) {
            console.log(`  ${label}: rejected — ${(e as Error).message}`);
        }
    }
}

async function main() {
    await demonstrateAgentCompaction();
    await demonstrateManualCompaction();
    await demonstrateStrategies();
    demonstrateValidation();
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch(console.error);
}

export { main };
