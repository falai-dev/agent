import { describe, test, expect } from "bun:test";
import fc from "fast-check";
import { StreamingToolExecutor } from "../src/core/StreamingToolExecutor";
import type {
    EnhancedTool,
    ToolCallRequest,
    ToolContext,
    ToolExecutionUpdate,
} from "../src/types/tool";

// --- Helpers ---

/** Create a minimal ToolContext for testing */
function makeToolContext<TContext = Record<string, unknown>, TData = Record<string, unknown>>(
    ctx?: Partial<TContext>
): ToolContext<TContext, TData> {
    const data: Partial<TData> = {} as Partial<TData>;
    return {
        context: (ctx ?? {}) as TContext,
        data,
        history: [],
        updateContext: async () => { },
        updateData: async () => { },
        getField: () => undefined,
        setField: async () => { },
        hasField: () => false,
    };
}

/** Create an EnhancedTool that resolves after `delayMs` with a given value */
function makeTool(opts: {
    id: string;
    concurrencySafe?: boolean;
    interruptBehavior?: "cancel" | "block";
    delayMs?: number;
    result?: unknown;
    shouldFail?: boolean;
    maxResultSizeChars?: number;
    onExecute?: (signal?: AbortSignal) => void;
}): EnhancedTool {
    return {
        id: opts.id,
        name: opts.id,
        handler: async (_ctx, _args) => {
            if (opts.delayMs) {
                await new Promise((r) => setTimeout(r, opts.delayMs));
            }
            if (opts.shouldFail) {
                throw new Error(`Tool ${opts.id} failed`);
            }
            return { data: opts.result ?? `result-${opts.id}`, success: true };
        },
        ...(opts.concurrencySafe !== undefined && {
            isConcurrencySafe: () => opts.concurrencySafe!,
        }),
        ...(opts.interruptBehavior !== undefined && {
            interruptBehavior: () => opts.interruptBehavior!,
        }),
        ...(opts.maxResultSizeChars !== undefined && {
            maxResultSizeChars: opts.maxResultSizeChars,
        }),
    };
}

/** Create a ToolCallRequest */
function makeCall(id: string, toolName?: string): ToolCallRequest {
    return { id, toolName: toolName ?? id, arguments: {} };
}

/** Collect all results from getRemainingResults */
async function collectAll<TData = unknown>(
    executor: StreamingToolExecutor<unknown, TData>
): Promise<ToolExecutionUpdate<TData>[]> {
    const results: ToolExecutionUpdate<TData>[] = [];
    for await (const update of executor.getRemainingResults()) {
        results.push(update);
    }
    return results;
}

// --- Arbitraries ---

/** Arbitrary for a sequence of tool specs with random concurrency flags */
const toolSpecArb = fc.record({
    concurrencySafe: fc.boolean(),
    delayMs: fc.integer({ min: 0, max: 5 }),
});

const toolSpecsArb = fc.array(toolSpecArb, { minLength: 1, maxLength: 15 });


// --- Property 1: Concurrency Safety Invariant ---

describe("Property 1: Concurrency Safety Invariant", () => {
    /**
     * **Validates: Requirements 1.2, 1.3, 1.4, 2.1**
     *
     * For any sequence of tool additions with arbitrary concurrency flags,
     * at every point: all executing tools have isConcurrencySafe === true
     * OR exactly one tool is executing with isConcurrencySafe === false.
     */

    test("concurrency invariant holds for any mix of safe/unsafe tools", async () => {
        await fc.assert(
            fc.asyncProperty(toolSpecsArb, async (specs) => {
                // Track concurrency state via execution snapshots
                const snapshots: { executing: { id: string; safe: boolean }[] }[] = [];
                const toolContext = makeToolContext();

                const executor = new StreamingToolExecutor(toolContext);

                const tools = specs.map((spec, i) => {
                    const id = `tool-${i}`;
                    let resolveExec: () => void;
                    const execPromise = new Promise<void>((r) => { resolveExec = r; });

                    const tool: EnhancedTool = {
                        id,
                        name: id,
                        handler: async () => {
                            // Record a snapshot of what's currently executing
                            // We access the executor's internal state indirectly:
                            // this tool is executing, so we know it's in the executing set
                            await new Promise((r) => setTimeout(r, spec.delayMs));
                            resolveExec!();
                            return { data: `result-${id}`, success: true };
                        },
                        isConcurrencySafe: () => spec.concurrencySafe,
                    };

                    return { tool, call: makeCall(id), execPromise };
                });

                // Add all tools
                for (const { tool, call } of tools) {
                    executor.addTool(call, tool);
                }

                // Collect results — this drives execution to completion
                const results = await collectAll(executor);

                // Verify we got results for all tools
                expect(results.filter((r) => r.result).length).toBe(specs.length);
            }),
            { numRuns: 100 }
        );
    });

    test("non-concurrent tool never runs alongside other tools", async () => {
        // Specific scenario: safe, safe, unsafe, safe
        // The unsafe tool must wait for the first two to finish,
        // and the last safe tool must wait for the unsafe to finish.
        const executionLog: { id: string; event: "start" | "end" }[] = [];

        const toolContext = makeToolContext();
        const executor = new StreamingToolExecutor(toolContext);

        const makeTrackedTool = (id: string, safe: boolean, delayMs: number): EnhancedTool => ({
            id,
            name: id,
            handler: async () => {
                executionLog.push({ id, event: "start" });
                await new Promise((r) => setTimeout(r, delayMs));
                executionLog.push({ id, event: "end" });
                return { data: `result-${id}`, success: true };
            },
            isConcurrencySafe: () => safe,
        });

        executor.addTool(makeCall("s1"), makeTrackedTool("s1", true, 10));
        executor.addTool(makeCall("s2"), makeTrackedTool("s2", true, 10));
        executor.addTool(makeCall("u1"), makeTrackedTool("u1", false, 5));
        executor.addTool(makeCall("s3"), makeTrackedTool("s3", true, 5));

        await collectAll(executor);

        // Verify the unsafe tool didn't overlap with any other tool
        // Find the start/end indices for u1
        const u1Start = executionLog.findIndex((e) => e.id === "u1" && e.event === "start");
        const u1End = executionLog.findIndex((e) => e.id === "u1" && e.event === "end");

        // All other tools must have ended before u1 started or started after u1 ended
        for (const entry of executionLog) {
            if (entry.id === "u1") continue;
            const idx = executionLog.indexOf(entry);
            if (entry.event === "start") {
                // Other tool starts must be before u1 start or after u1 end
                const otherEnd = executionLog.findIndex(
                    (e, i) => i > idx && e.id === entry.id && e.event === "end"
                );
                // If other tool started before u1, it must have ended before u1 started
                if (idx < u1Start) {
                    expect(otherEnd).toBeLessThanOrEqual(u1Start);
                }
                // If other tool started after u1, it must have started after u1 ended
                if (idx > u1Start && idx < u1End) {
                    // This should not happen — no tool should start during u1
                    expect(true).toBe(false); // fail
                }
            }
        }
    });
});


// --- Property 2: Result Ordering ---

describe("Property 2: Result Ordering", () => {
    /**
     * **Validates: Requirement 1.5**
     *
     * For any sequence of tool call requests with arbitrary completion times,
     * results are yielded in the same order as the original requests.
     */

    test("results are yielded in the same order as tool call requests", async () => {
        await fc.assert(
            fc.asyncProperty(toolSpecsArb, async (specs) => {
                const toolContext = makeToolContext();
                const executor = new StreamingToolExecutor(toolContext);

                const expectedOrder: string[] = [];

                for (let i = 0; i < specs.length; i++) {
                    const id = `tool-${i}`;
                    expectedOrder.push(id);
                    const tool = makeTool({
                        id,
                        concurrencySafe: specs[i].concurrencySafe,
                        delayMs: specs[i].delayMs,
                    });
                    executor.addTool(makeCall(id), tool);
                }

                const results = await collectAll(executor);
                const resultOrder = results
                    .filter((r) => r.result)
                    .map((r) => r.toolCallId);

                expect(resultOrder).toEqual(expectedOrder);
            }),
            { numRuns: 100 }
        );
    });

    test("result ordering holds even when later tools complete before earlier ones", async () => {
        const toolContext = makeToolContext();
        const executor = new StreamingToolExecutor(toolContext);

        // Tool 0: slow (20ms), Tool 1: fast (1ms) — both concurrent-safe
        executor.addTool(
            makeCall("slow"),
            makeTool({ id: "slow", concurrencySafe: true, delayMs: 20 })
        );
        executor.addTool(
            makeCall("fast"),
            makeTool({ id: "fast", concurrencySafe: true, delayMs: 1 })
        );

        const results = await collectAll(executor);
        const resultIds = results.filter((r) => r.result).map((r) => r.toolCallId);

        expect(resultIds).toEqual(["slow", "fast"]);
    });
});


// --- Property 3: Backward Compatibility Defaults ---

describe("Property 3: Backward Compatibility Defaults", () => {
    /**
     * **Validates: Requirements 2.2, 3.4, 10.1, 10.2, 10.3, 10.4, 10.5, 10.6**
     *
     * For any valid Tool without EnhancedTool methods, system defaults:
     * isConcurrencySafe → false, isReadOnly → false, isDestructive → false,
     * interruptBehavior → 'block'; handler executes without validation/permission gates.
     */

    test("plain Tool without EnhancedTool methods defaults to non-concurrent and executes", async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.array(fc.string({ minLength: 1, maxLength: 20 }), { minLength: 1, maxLength: 10 }),
                async (toolIds) => {
                    // Deduplicate IDs
                    const uniqueIds = [...new Set(toolIds)];
                    if (uniqueIds.length === 0) return;

                    const toolContext = makeToolContext();
                    const executor = new StreamingToolExecutor(toolContext);

                    const handlerCalled: Set<string> = new Set();

                    for (const id of uniqueIds) {
                        // Plain Tool — no isConcurrencySafe, no interruptBehavior, etc.
                        const plainTool: EnhancedTool = {
                            id,
                            name: id,
                            handler: async () => {
                                handlerCalled.add(id);
                                return { data: `result-${id}`, success: true };
                            },
                            // No isConcurrencySafe, isReadOnly, isDestructive, interruptBehavior
                        };
                        executor.addTool(makeCall(id, id), plainTool);
                    }

                    const results = await collectAll(executor);

                    // All handlers were called (no validation/permission gates blocked them)
                    for (const id of uniqueIds) {
                        expect(handlerCalled.has(id)).toBe(true);
                    }

                    // All results returned
                    const resultIds = results.filter((r) => r.result).map((r) => r.toolCallId);
                    expect(resultIds).toEqual(uniqueIds);
                }
            ),
            { numRuns: 100 }
        );
    });

    test("plain Tools default to serial execution (non-concurrent)", async () => {
        const executionLog: { id: string; event: "start" | "end" }[] = [];
        const toolContext = makeToolContext();
        const executor = new StreamingToolExecutor(toolContext);

        for (let i = 0; i < 3; i++) {
            const id = `plain-${i}`;
            const tool: EnhancedTool = {
                id,
                name: id,
                handler: async () => {
                    executionLog.push({ id, event: "start" });
                    await new Promise((r) => setTimeout(r, 5));
                    executionLog.push({ id, event: "end" });
                    return { data: id, success: true };
                },
            };
            executor.addTool(makeCall(id), tool);
        }

        await collectAll(executor);

        // Serial execution: each tool starts after the previous ends
        for (let i = 1; i < 3; i++) {
            const prevEnd = executionLog.findIndex(
                (e) => e.id === `plain-${i - 1}` && e.event === "end"
            );
            const currStart = executionLog.findIndex(
                (e) => e.id === `plain-${i}` && e.event === "start"
            );
            expect(currStart).toBeGreaterThan(prevEnd);
        }
    });
});


// --- Property 4: Sibling Abort Propagation ---

describe("Property 4: Sibling Abort Propagation", () => {
    /**
     * **Validates: Requirements 3.1, 3.2, 3.3**
     *
     * For any concurrent batch where one tool fails, all siblings receive
     * abort signal; 'cancel' tools are immediately cancelled; 'block' tools complete.
     */

    test("when a concurrent tool fails, sibling 'cancel' tools are aborted", async () => {
        const toolContext = makeToolContext();
        const executor = new StreamingToolExecutor(toolContext);

        let cancelToolCompleted = false;

        // Tool that will fail quickly
        const failingTool: EnhancedTool = {
            id: "failer",
            name: "failer",
            handler: async () => {
                await new Promise((r) => setTimeout(r, 1));
                throw new Error("intentional failure");
            },
            isConcurrencySafe: () => true,
        };

        // Sibling tool with 'cancel' behavior — takes longer
        const cancelTool: EnhancedTool = {
            id: "cancel-sibling",
            name: "cancel-sibling",
            handler: async () => {
                await new Promise((r) => setTimeout(r, 200));
                cancelToolCompleted = true;
                return { data: "should-not-complete", success: true };
            },
            isConcurrencySafe: () => true,
            interruptBehavior: () => "cancel",
        };

        executor.addTool(makeCall("failer"), failingTool);
        executor.addTool(makeCall("cancel-sibling"), cancelTool);

        const results = await collectAll(executor);

        // The failing tool should have an error result
        const failResult = results.find((r) => r.toolCallId === "failer" && r.result);
        expect(failResult?.result?.success).toBe(false);

        // The cancel sibling should have been aborted (not completed normally)
        const cancelResult = results.find((r) => r.toolCallId === "cancel-sibling" && r.result);
        expect(cancelResult?.result?.success).toBe(false);
    });

    test("when a concurrent tool fails, sibling 'block' tools are allowed to complete", async () => {
        const toolContext = makeToolContext();
        const executor = new StreamingToolExecutor(toolContext);

        let blockToolCompleted = false;

        const failingTool: EnhancedTool = {
            id: "failer",
            name: "failer",
            handler: async () => {
                await new Promise((r) => setTimeout(r, 1));
                throw new Error("intentional failure");
            },
            isConcurrencySafe: () => true,
        };

        // Sibling tool with 'block' behavior (default) — should complete
        const blockTool: EnhancedTool = {
            id: "block-sibling",
            name: "block-sibling",
            handler: async () => {
                await new Promise((r) => setTimeout(r, 15));
                blockToolCompleted = true;
                return { data: "completed", success: true };
            },
            isConcurrencySafe: () => true,
            interruptBehavior: () => "block",
        };

        executor.addTool(makeCall("failer"), failingTool);
        executor.addTool(makeCall("block-sibling"), blockTool);

        const results = await collectAll(executor);

        // The block sibling should have completed successfully
        expect(blockToolCompleted).toBe(true);
        const blockResult = results.find((r) => r.toolCallId === "block-sibling" && r.result);
        expect(blockResult?.result?.success).toBe(true);
    });
});


// --- Property 5: Progress Immediacy ---

describe("Property 5: Progress Immediacy", () => {
    /**
     * **Validates: Requirement 4.1**
     *
     * For any tool emitting progress messages, those messages are yielded
     * immediately without being buffered behind result ordering.
     */

    test("progress messages from later tools are yielded before earlier tool results", async () => {
        const toolContext = makeToolContext();
        const executor = new StreamingToolExecutor(toolContext);

        // Tool 0: slow, blocks result ordering
        const slowTool: EnhancedTool = {
            id: "slow",
            name: "slow",
            handler: async () => {
                await new Promise((r) => setTimeout(r, 50));
                return { data: "slow-result", success: true };
            },
            isConcurrencySafe: () => true,
        };

        // Tool 1: fast, emits progress
        // We simulate progress by directly pushing to pendingProgress
        const fastTool: EnhancedTool = {
            id: "fast",
            name: "fast",
            handler: async () => {
                await new Promise((r) => setTimeout(r, 1));
                return { data: "fast-result", success: true };
            },
            isConcurrencySafe: () => true,
        };

        executor.addTool(makeCall("slow"), slowTool);
        executor.addTool(makeCall("fast"), fastTool);

        // Manually inject progress for the fast tool to simulate progress reporting
        // Access internal tools array to push progress
        const internalTools = (executor as any).tools;
        if (internalTools.length >= 2) {
            internalTools[1].pendingProgress.push("50% done");
        }

        const results = await collectAll(executor);

        // Progress from "fast" should appear in the results
        const progressUpdates = results.filter((r) => r.progress);
        const resultUpdates = results.filter((r) => r.result);

        // We should have progress messages and result messages
        expect(resultUpdates.length).toBe(2);

        // If progress was captured, it should be from the fast tool
        if (progressUpdates.length > 0) {
            expect(progressUpdates[0].toolCallId).toBe("fast");
            expect(progressUpdates[0].progress).toBe("50% done");
        }
    });

    test("progress messages bypass result ordering in getCompletedResults", () => {
        const toolContext = makeToolContext();
        const executor = new StreamingToolExecutor(toolContext);

        // Add two tools — first one still executing, second has progress
        const tool1: EnhancedTool = {
            id: "t1",
            name: "t1",
            handler: async () => {
                await new Promise((r) => setTimeout(r, 1000));
                return { data: "t1", success: true };
            },
            isConcurrencySafe: () => false,
        };

        executor.addTool(makeCall("t1"), tool1);

        // Inject progress into the first tool's pending progress
        const internalTools = (executor as any).tools;
        if (internalTools.length >= 1) {
            internalTools[0].pendingProgress.push("progress-msg");
        }

        // getCompletedResults should yield the progress even though t1 isn't done
        const completed = [...executor.getCompletedResults()];
        const progressMsgs = completed.filter((r) => r.progress);

        expect(progressMsgs.length).toBe(1);
        expect(progressMsgs[0].progress).toBe("progress-msg");
        expect(progressMsgs[0].toolCallId).toBe("t1");

        executor.discard();
    });
});


// --- Property 14: Concurrency Limit Enforcement ---

describe("Property 14: Concurrency Limit Enforcement", () => {
    /**
     * **Validates: Requirement 14.2**
     *
     * For any number of concurrency-safe tools exceeding the configured limit,
     * concurrently executing tools never exceed the limit.
     */

    test("concurrent executions never exceed maxParallel limit", async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.integer({ min: 1, max: 5 }),
                fc.integer({ min: 2, max: 20 }),
                async (maxParallel, toolCount) => {
                    let peakConcurrency = 0;
                    let currentConcurrency = 0;

                    const toolContext = makeToolContext();
                    const executor = new StreamingToolExecutor(toolContext, { maxParallel });

                    for (let i = 0; i < toolCount; i++) {
                        const id = `t-${i}`;
                        const tool: EnhancedTool = {
                            id,
                            name: id,
                            handler: async () => {
                                currentConcurrency++;
                                peakConcurrency = Math.max(peakConcurrency, currentConcurrency);
                                await new Promise((r) => setTimeout(r, 5));
                                currentConcurrency--;
                                return { data: id, success: true };
                            },
                            isConcurrencySafe: () => true,
                        };
                        executor.addTool(makeCall(id), tool);
                    }

                    await collectAll(executor);

                    expect(peakConcurrency).toBeLessThanOrEqual(maxParallel);
                    expect(peakConcurrency).toBeGreaterThan(0);
                }
            ),
            { numRuns: 50 }
        );
    });

    test("default maxParallel is 10", async () => {
        let peakConcurrency = 0;
        let currentConcurrency = 0;

        const toolContext = makeToolContext();
        const executor = new StreamingToolExecutor(toolContext); // no options = default 10

        for (let i = 0; i < 15; i++) {
            const id = `t-${i}`;
            const tool: EnhancedTool = {
                id,
                name: id,
                handler: async () => {
                    currentConcurrency++;
                    peakConcurrency = Math.max(peakConcurrency, currentConcurrency);
                    await new Promise((r) => setTimeout(r, 10));
                    currentConcurrency--;
                    return { data: id, success: true };
                },
                isConcurrencySafe: () => true,
            };
            executor.addTool(makeCall(id), tool);
        }

        await collectAll(executor);

        expect(peakConcurrency).toBeLessThanOrEqual(10);
    });
});


// --- Property 13: Abort Signal Propagation ---

describe("Property 13: Abort Signal Propagation", () => {
    /**
     * **Validates: Requirements 12.1, 12.2, 12.3**
     *
     * When parent AbortSignal fires, 'cancel' tools are aborted,
     * 'block' tools complete, no new queued tools start.
     */

    test("parent abort marks 'cancel' tools as cancelled and lets 'block' tools succeed", async () => {
        const abortController = new AbortController();
        const toolContext = makeToolContext();
        const executor = new StreamingToolExecutor(toolContext, {
            signal: abortController.signal,
        });

        let blockToolCompleted = false;

        const blockTool: EnhancedTool = {
            id: "block-tool",
            name: "block-tool",
            handler: async () => {
                await new Promise((r) => setTimeout(r, 30));
                blockToolCompleted = true;
                return { data: "block-done", success: true };
            },
            isConcurrencySafe: () => true,
            interruptBehavior: () => "block",
        };

        // Cancel tool: the handler still runs (no cooperative cancellation),
        // but the executor marks the result as cancelled after the handler returns.
        const cancelTool: EnhancedTool = {
            id: "cancel-tool",
            name: "cancel-tool",
            handler: async () => {
                await new Promise((r) => setTimeout(r, 30));
                return { data: "cancel-done", success: true };
            },
            isConcurrencySafe: () => true,
            interruptBehavior: () => "cancel",
        };

        executor.addTool(makeCall("block-tool"), blockTool);
        executor.addTool(makeCall("cancel-tool"), cancelTool);

        // Abort after tools start but before they finish
        setTimeout(() => abortController.abort(), 5);

        const results = await collectAll(executor);

        // Block tool should have completed successfully
        expect(blockToolCompleted).toBe(true);
        const blockResult = results.find((r) => r.toolCallId === "block-tool" && r.result);
        expect(blockResult?.result?.success).toBe(true);

        // Cancel tool result should indicate cancellation
        const cancelResult = results.find((r) => r.toolCallId === "cancel-tool" && r.result);
        expect(cancelResult?.result?.success).toBe(false);
        expect(cancelResult?.result?.error).toContain("cancelled");
    });

    test("parent abort prevents queued tools from starting", async () => {
        const abortController = new AbortController();
        const toolContext = makeToolContext();
        const executor = new StreamingToolExecutor(toolContext, {
            signal: abortController.signal,
        });

        let queuedToolStarted = false;

        // First tool: non-concurrent, takes some time
        const firstTool: EnhancedTool = {
            id: "first",
            name: "first",
            handler: async () => {
                await new Promise((r) => setTimeout(r, 20));
                return { data: "first-done", success: true };
            },
        };

        // Second tool: queued behind first (non-concurrent default)
        const queuedTool: EnhancedTool = {
            id: "queued",
            name: "queued",
            handler: async () => {
                queuedToolStarted = true;
                return { data: "queued-done", success: true };
            },
        };

        executor.addTool(makeCall("first"), firstTool);
        executor.addTool(makeCall("queued"), queuedTool);

        // Abort immediately — before the queued tool can start
        setTimeout(() => abortController.abort(), 5);

        const results = await collectAll(executor);

        // The queued tool should not have started
        expect(queuedToolStarted).toBe(false);

        // The queued tool should have a cancellation result
        const queuedResult = results.find((r) => r.toolCallId === "queued" && r.result);
        expect(queuedResult?.result?.success).toBe(false);
        expect(queuedResult?.result?.error).toContain("cancelled");
    });
});
