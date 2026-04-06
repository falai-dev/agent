/**
 * Streaming Tool Execution Example
 *
 * Demonstrates the StreamingToolExecutor with mixed read-only and write tools,
 * showing how read-only tools execute in parallel while write tools run serially.
 *
 * Key concepts:
 * - EnhancedTool with `isConcurrencySafe` metadata
 * - Parallel execution of concurrent-safe (read-only) tools
 * - Serial execution of non-concurrent-safe (write) tools
 * - Result ordering preserved regardless of completion order
 * - Progress reporting from long-running tools
 * - Abort signal support
 */

import {
    Agent,
    GeminiProvider,
    StreamingToolExecutor,
    type EnhancedTool,
    type ToolCallRequest,
} from "../../src/index";

// --- Read-only tools (concurrency-safe, run in parallel) ---

const readFileTool: EnhancedTool = {
    id: "read_file",
    name: "Read File",
    description: "Read a file from disk",
    parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
    },
    handler: async (_ctx, args) => {
        const path = args?.path as string;
        // Simulate file read latency
        await new Promise((r) => setTimeout(r, 200));
        return { data: `Contents of ${path}: [mock file data]`, success: true };
    },
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    isDestructive: () => false,
    interruptBehavior: () => "cancel",
    maxResultSizeChars: 50_000,
};

const listDirectoryTool: EnhancedTool = {
    id: "list_directory",
    name: "List Directory",
    description: "List files in a directory",
    parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
    },
    handler: async (_ctx, args) => {
        const path = args?.path as string;
        await new Promise((r) => setTimeout(r, 150));
        return {
            data: `Files in ${path}: index.ts, utils.ts, types.ts`,
            success: true,
        };
    },
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    isDestructive: () => false,
    interruptBehavior: () => "cancel",
};

const searchCodeTool: EnhancedTool = {
    id: "search_code",
    name: "Search Code",
    description: "Search for patterns in the codebase",
    parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
    },
    handler: async (_ctx, args) => {
        const query = args?.query as string;
        await new Promise((r) => setTimeout(r, 300));
        return {
            data: `Found 3 matches for "${query}" in src/`,
            success: true,
        };
    },
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    isDestructive: () => false,
    interruptBehavior: () => "cancel",
};

// --- Write tools (NOT concurrency-safe, run serially) ---

const writeFileTool: EnhancedTool = {
    id: "write_file",
    name: "Write File",
    description: "Write content to a file",
    parameters: {
        type: "object",
        properties: {
            path: { type: "string" },
            content: { type: "string" },
        },
        required: ["path", "content"],
    },
    handler: async (_ctx, args) => {
        const path = args?.path as string;
        await new Promise((r) => setTimeout(r, 250));
        return { data: `Wrote to ${path}`, success: true };
    },
    isConcurrencySafe: () => false,
    isReadOnly: () => false,
    isDestructive: (input) => true,
    interruptBehavior: () => "block",
    maxResultSizeChars: 1_000,
};

const deleteFileTool: EnhancedTool = {
    id: "delete_file",
    name: "Delete File",
    description: "Delete a file from disk",
    parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
    },
    handler: async (_ctx, args) => {
        const path = args?.path as string;
        await new Promise((r) => setTimeout(r, 100));
        return { data: `Deleted ${path}`, success: true };
    },
    isConcurrencySafe: () => false,
    isReadOnly: () => false,
    isDestructive: () => true,
    interruptBehavior: () => "block",
};

// Helper: create a minimal ToolContext for standalone executor usage
function createMockToolContext() {
    return {
        context: {},
        data: {},
        history: [],
        updateContext: async () => { },
        updateData: async () => { },
        getField: () => undefined,
        setField: async () => { },
        hasField: () => false,
    } as any;
}

// --- Direct StreamingToolExecutor usage ---

async function demonstrateDirectExecutor() {
    console.log("=== Direct StreamingToolExecutor Demo ===\n");

    const toolMap = new Map<string, EnhancedTool>([
        ["read_file", readFileTool],
        ["list_directory", listDirectoryTool],
        ["search_code", searchCodeTool],
        ["write_file", writeFileTool],
    ]);

    // Simulate a sequence of tool calls from an LLM response:
    // 3 reads (parallel) followed by 1 write (serial)
    const toolCalls: ToolCallRequest[] = [
        { id: "call_1", toolName: "read_file", arguments: { path: "src/index.ts" } },
        { id: "call_2", toolName: "list_directory", arguments: { path: "src/" } },
        { id: "call_3", toolName: "search_code", arguments: { query: "import" } },
        { id: "call_4", toolName: "write_file", arguments: { path: "out.ts", content: "// generated" } },
    ];

    const executor = new StreamingToolExecutor<unknown, unknown>(
        createMockToolContext(),
        { maxParallel: 5 },
    );

    console.log("Queueing tools as they arrive from the LLM stream...\n");

    for (const call of toolCalls) {
        const tool = toolMap.get(call.toolName)!;
        const safe = tool.isConcurrencySafe?.() ? "parallel" : "serial";
        console.log(`  + Queued: ${call.toolName} (${safe})`);
        executor.addTool(call, tool);
    }

    console.log("\nResults (yielded in original request order):\n");

    for await (const update of executor.getRemainingResults()) {
        if (update.progress) {
            console.log(`  [progress] ${update.toolCallId}: ${update.progress}`);
        }
        if (update.result) {
            console.log(`  [result]   ${update.toolCallId}: ${update.result.data}`);
        }
    }

    console.log("\nAll tools complete.");
}

// --- Agent-level integration ---

async function demonstrateAgentIntegration() {
    console.log("\n=== Agent Integration Demo ===\n");

    const agent = new Agent({
        name: "CodeAssistant",
        description: "An assistant with streaming tool execution",
        provider: new GeminiProvider({
            apiKey: process.env.GEMINI_API_KEY || "demo-key",
            model: "models/gemini-2.5-flash",
        }),
        tools: [readFileTool, listDirectoryTool, searchCodeTool, writeFileTool, deleteFileTool],
    });

    console.log("Tools registered:");
    for (const t of agent.getTools()) {
        const enhanced = t as EnhancedTool;
        const safe = enhanced.isConcurrencySafe?.() ?? false;
        console.log(`  - ${t.id} (concurrencySafe: ${safe})`);
    }

    console.log("\nStreaming tool execution happens automatically during respondStream().");
    console.log("Read-only tools run in parallel; write tools wait for exclusive access.\n");

    // In a real scenario you'd call agent.stream() or agent.respondStream()
    // and the StreamingToolExecutor handles concurrency internally.
    console.log("Example streaming usage:");
    console.log('  for await (const chunk of agent.stream("Read index.ts and list src/")) {');
    console.log("    process.stdout.write(chunk.delta);");
    console.log("  }");
}

// --- Abort signal demo ---

async function demonstrateAbortSignal() {
    console.log("\n=== Abort Signal Demo ===\n");

    const controller = new AbortController();
    const executor = new StreamingToolExecutor<unknown, unknown>(
        createMockToolContext(),
        { maxParallel: 5, signal: controller.signal },
    );

    // Queue a slow read and a write
    executor.addTool(
        { id: "slow_read", toolName: "search_code", arguments: { query: "TODO" } },
        searchCodeTool
    );
    executor.addTool(
        { id: "slow_write", toolName: "write_file", arguments: { path: "tmp.ts", content: "x" } },
        writeFileTool
    );

    // Abort after 100ms — 'cancel' tools abort immediately, 'block' tools finish
    setTimeout(() => {
        console.log("  Aborting...");
        controller.abort();
    }, 100);

    for await (const update of executor.getRemainingResults()) {
        if (update.result) {
            const status = update.result.success ? "ok" : "aborted";
            console.log(`  ${update.toolCallId}: ${status} — ${update.result.data ?? update.result.error}`);
        }
    }

    console.log("  Done (abort handled gracefully).");
}

async function main() {
    await demonstrateDirectExecutor();
    await demonstrateAgentIntegration();
    await demonstrateAbortSignal();
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch(console.error);
}

export { main };
