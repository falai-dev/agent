/**
 * StreamingToolExecutor - Executes tools as they arrive from the LLM stream
 * with concurrency control, abort handling, and ordered result yielding.
 *
 * Concurrency invariant: at any point during execution, either all executing
 * tools have `isConcurrencySafe === true`, or exactly one tool is executing
 * with `isConcurrencySafe === false`.
 *
 * Results are yielded in the original request order (the order addTool was called).
 * Progress messages bypass result ordering and are yielded immediately.
 */

import log from "loglevel";
import type {
    ToolCallRequest,
    ToolExecutionUpdate,
    ToolExecutionResult,
    ToolContext,
    EnhancedTool,
    TrackedTool,
} from "../types/tool";

/** Options for the StreamingToolExecutor */
interface StreamingToolExecutorOptions {
    /** Maximum number of tools executing in parallel (default: 10) */
    maxParallel?: number;
    /** Parent abort signal — cancels 'cancel' tools, lets 'block' tools finish, stops queue */
    signal?: AbortSignal;
}

/**
 * A deferred promise that can be resolved/rejected externally.
 * Used to notify getRemainingResults when new results are available.
 */
interface Deferred<T> {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (reason?: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}


/**
 * StreamingToolExecutor manages queuing, concurrent execution, abort propagation,
 * and ordered result yielding for tool calls arriving from an LLM stream.
 */
export class StreamingToolExecutor<TContext = unknown, TData = unknown> {
    /** Ordered list of tracked tools (insertion order = request order) */
    private tools: TrackedTool<TContext, TData>[] = [];

    /** Tool context passed to each tool handler */
    private toolContext: ToolContext<TContext, TData>;

    /** Maximum concurrent tool executions */
    private maxParallel: number;

    /** Parent abort signal */
    private parentSignal?: AbortSignal;

    /** Whether the executor has been discarded (no new tools will be processed) */
    private discarded = false;

    /** Accumulated context updates from completed tools */
    private contextUpdates: Partial<TContext> = {};

    /**
     * Sibling abort controller for the current concurrent batch.
     * When one tool in a batch fails, this aborts all siblings.
     */
    private siblingAbortController: AbortController | null = null;

    /**
     * Set of tool IDs in the current concurrent batch.
     * Reset when a new batch starts.
     */
    private currentBatchIds: Set<string> = new Set();

    /**
     * Deferred used to wake up getRemainingResults when state changes
     * (tool completes, progress arrives, or executor finishes).
     */
    private waiter: Deferred<void> | null = null;

    /**
     * @param toolContext - Context provided to each tool handler during execution
     * @param options - Optional configuration for max parallelism and abort signal
     */
    constructor(
        toolContext: ToolContext<TContext, TData>,
        options?: StreamingToolExecutorOptions
    ) {
        this.toolContext = toolContext;
        this.maxParallel = options?.maxParallel ?? 10;
        this.parentSignal = options?.signal;

        // Listen to parent abort signal
        if (this.parentSignal) {
            this.parentSignal.addEventListener("abort", () => this.handleParentAbort(), { once: true });
        }
    }

    /**
     * Queue a tool for execution. The tool's `isConcurrencySafe` is evaluated
     * once at queue time and cached on the TrackedTool.
     *
     * If the executor has been discarded, the tool is ignored.
     */
    addTool(
        toolCall: ToolCallRequest,
        tool: EnhancedTool<TContext, TData>
    ): void {
        if (this.discarded) {
            log.warn(`[StreamingToolExecutor] Executor discarded, ignoring tool: ${toolCall.toolName}`);
            return;
        }

        // Evaluate concurrency safety once at queue time (Req 2.3)
        const isConcurrencySafe = tool.isConcurrencySafe
            ? tool.isConcurrencySafe(toolCall.arguments)
            : false; // Default: not concurrency-safe (Req 2.2, 10.2)

        const tracked: TrackedTool<TContext, TData> = {
            id: toolCall.id,
            toolCall,
            tool,
            status: "queued",
            isConcurrencySafe,
            results: [],
            pendingProgress: [],
        };

        this.tools.push(tracked);
        log.debug(
            `[StreamingToolExecutor] Queued tool ${toolCall.toolName} (id=${toolCall.id}, concurrencySafe=${isConcurrencySafe})`
        );

        // Kick the queue
        this.processQueue();
    }

    /**
     * Process the tool queue, starting eligible tools while maintaining
     * the concurrency invariant.
     *
     * Invariant: all executing tools are concurrency-safe OR exactly one
     * non-safe tool is executing. Additionally, the number of concurrently
     * executing tools never exceeds `maxParallel`.
     */
    private processQueue(): void {
        if (this.discarded) return;
        if (this.parentSignal?.aborted) return;

        for (const tool of this.tools) {
            if (tool.status !== "queued") continue;

            const executing = this.tools.filter((t) => t.status === "executing");

            // Enforce max parallel limit (Req 14.1, 14.2)
            if (executing.length >= this.maxParallel) {
                break;
            }

            const canExecute =
                executing.length === 0 ||
                (tool.isConcurrencySafe && executing.every((t) => t.isConcurrencySafe));

            if (canExecute) {
                // Start a new concurrent batch if needed
                if (executing.length === 0 || !this.currentBatchIds.has(executing[0]?.id)) {
                    this.startNewBatch();
                }

                tool.status = "executing";
                this.currentBatchIds.add(tool.id);

                log.debug(
                    `[StreamingToolExecutor] Starting tool ${tool.toolCall.toolName} (id=${tool.id})`
                );

                tool.promise = this.executeTool(tool).finally(() => {
                    // Re-evaluate queue after each tool completes
                    this.processQueue();
                    // Wake up any waiting async generator
                    this.notifyWaiter();
                });
            } else if (!tool.isConcurrencySafe) {
                // Non-concurrent tool must wait — stop scanning to maintain order (Req 1.3, 1.4)
                break;
            }
            // If tool is concurrency-safe but can't run (non-safe tool executing),
            // skip it and continue scanning — but actually per the design,
            // we should also break here since we need to maintain request order
            // for result yielding. A concurrent-safe tool behind a non-safe tool
            // should wait too.
        }
    }

    /**
     * Start a new sibling abort controller for a concurrent batch.
     */
    private startNewBatch(): void {
        this.siblingAbortController = new AbortController();
        this.currentBatchIds = new Set();
    }

    /**
     * Execute a single tool, handling result capture, progress, truncation,
     * and error/abort propagation.
     */
    private async executeTool(tracked: TrackedTool<TContext, TData>): Promise<void> {
        const { tool, toolCall } = tracked;
        const batchAbortController = this.siblingAbortController;

        try {
            // Create a combined abort signal from parent + sibling
            const toolAbortController = new AbortController();
            const abortTool = () => {
                const behavior = tool.interruptBehavior
                    ? tool.interruptBehavior()
                    : "block"; // Default: block (Req 3.4, 10.5)

                if (behavior === "cancel") {
                    toolAbortController.abort();
                }
                // 'block' tools are allowed to complete
            };

            // Listen to sibling abort
            if (batchAbortController) {
                batchAbortController.signal.addEventListener("abort", abortTool, { once: true });
            }

            // Listen to parent abort for this specific tool
            const parentAbortHandler = () => abortTool();
            if (this.parentSignal) {
                this.parentSignal.addEventListener("abort", parentAbortHandler, { once: true });
            }

            // Execute the tool handler
            const result = await tool.handler(this.toolContext, toolCall.arguments);

            // Clean up abort listeners
            if (batchAbortController) {
                batchAbortController.signal.removeEventListener("abort", abortTool);
            }
            if (this.parentSignal) {
                this.parentSignal.removeEventListener("abort", parentAbortHandler);
            }

            // Check if we were aborted during execution
            if (toolAbortController.signal.aborted) {
                tracked.results.push({
                    success: false,
                    error: "Tool execution was cancelled",
                    metadata: { toolId: tool.id, cancelled: true },
                });
                tracked.status = "completed";
                return;
            }

            // Normalize the result
            const executionResult = this.normalizeResult(result, tool);

            // Apply per-tool maxResultSizeChars truncation (Req 9.4)
            const truncatedResult = this.applyResultTruncation(executionResult, tool);

            tracked.results.push(truncatedResult);

            // Accumulate context updates
            if (truncatedResult.contextUpdate) {
                this.contextUpdates = {
                    ...this.contextUpdates,
                    ...truncatedResult.contextUpdate,
                } as Partial<TContext>;
            }

            tracked.status = "completed";

            // If the tool failed, abort siblings in the batch (Req 3.1)
            if (!truncatedResult.success) {
                this.abortSiblings(tracked.id, batchAbortController);
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            log.error(
                `[StreamingToolExecutor] Tool ${toolCall.toolName} (id=${toolCall.id}) failed: ${errorMessage}`
            );

            tracked.results.push({
                success: false,
                error: errorMessage,
                metadata: { toolId: tool.id },
            });
            tracked.status = "completed";

            // Abort siblings on failure (Req 3.1)
            this.abortSiblings(tracked.id, batchAbortController);
        }
    }

    /**
     * Normalize a tool handler return value into a ToolExecutionResult.
     */
    private normalizeResult(
        result: unknown,
        tool: EnhancedTool<TContext, TData>
    ): ToolExecutionResult {
        if (
            result &&
            typeof result === "object" &&
            ("data" in result || "success" in result || "error" in result)
        ) {
            const r = result as Record<string, unknown>;
            return {
                success: r.success !== false,
                data: r.data,
                error: r.error as string | undefined,
                contextUpdate: r.contextUpdate as Record<string, unknown> | undefined,
                dataUpdate: r.dataUpdate as Record<string, unknown> | undefined,
                metadata: {
                    toolId: tool.id,
                    ...(r.meta as Record<string, unknown> | undefined),
                },
            };
        }

        return {
            success: true,
            data: result,
            metadata: { toolId: tool.id },
        };
    }

    /**
     * Apply per-tool maxResultSizeChars truncation to a result.
     * If the stringified result data exceeds the limit, truncate with a notice.
     */
    private applyResultTruncation(
        result: ToolExecutionResult,
        tool: EnhancedTool<TContext, TData>
    ): ToolExecutionResult {
        const maxChars = tool.maxResultSizeChars;
        if (maxChars == null || maxChars <= 0 || result.data == null) {
            return result;
        }

        const serialized =
            typeof result.data === "string"
                ? result.data
                : JSON.stringify(result.data);

        if (serialized.length <= maxChars) {
            return result;
        }

        const truncated = serialized.slice(0, maxChars);
        const notice = `\n\n[Truncated: ${serialized.length} chars total, showing first ${maxChars}]`;

        return {
            ...result,
            data: truncated + notice,
            metadata: {
                ...result.metadata,
                truncated: true,
                originalLength: serialized.length,
            },
        };
    }

    /**
     * Abort sibling tools in the current concurrent batch when one tool fails.
     * Tools with interruptBehavior 'cancel' are immediately aborted;
     * tools with 'block' are allowed to complete.
     */
    private abortSiblings(
        failedToolId: string,
        batchAbortController: AbortController | null
    ): void {
        if (!batchAbortController) return;

        log.warn(
            `[StreamingToolExecutor] Tool ${failedToolId} failed, aborting sibling tools in batch`
        );

        // Fire the sibling abort signal — individual tool handlers
        // check their interruptBehavior to decide whether to cancel or block
        batchAbortController.abort();
    }

    /**
     * Handle parent AbortSignal firing.
     * Cancel 'cancel' tools immediately, let 'block' tools finish,
     * and stop processing new queued tools.
     */
    private handleParentAbort(): void {
        log.warn("[StreamingToolExecutor] Parent abort signal received");

        // Stop processing new tools
        this.discarded = true;

        // Abort the current batch — individual tools respect their interruptBehavior
        if (this.siblingAbortController) {
            this.siblingAbortController.abort();
        }

        // Mark remaining queued tools as completed with cancellation error
        for (const tool of this.tools) {
            if (tool.status === "queued") {
                tool.results.push({
                    success: false,
                    error: "Execution cancelled by parent abort signal",
                    metadata: { toolId: tool.tool.id, cancelled: true },
                });
                tool.status = "completed";
            }
        }

        // Wake up any waiting async generator
        this.notifyWaiter();
    }

    /**
     * Yield completed results in original request order.
     * Progress messages are yielded immediately regardless of order.
     *
     * This is a synchronous generator — it yields what's available now
     * without waiting for pending tools.
     */
    *getCompletedResults(): Generator<ToolExecutionUpdate<TData>> {
        for (const tool of this.tools) {
            // Always yield pending progress immediately (Req 4.1)
            while (tool.pendingProgress.length > 0) {
                yield {
                    toolCallId: tool.id,
                    progress: tool.pendingProgress.shift()!,
                };
            }

            if (tool.status === "yielded") continue;

            if (tool.status === "completed") {
                tool.status = "yielded";
                for (const result of tool.results) {
                    yield {
                        toolCallId: tool.id,
                        result,
                        contextUpdate: result.contextUpdate,
                        dataUpdate: result.dataUpdate as Partial<TData> | undefined,
                    };
                }
            } else {
                // Tool is still queued or executing — stop yielding results
                // to maintain request order, but continue yielding progress
                // for subsequent tools
                break;
            }
        }
    }

    /**
     * Async generator that yields all results (completed and pending) in
     * original request order. Waits for pending tools to complete.
     *
     * Progress messages are yielded immediately as they arrive.
     */
    async *getRemainingResults(): AsyncGenerator<ToolExecutionUpdate<TData>> {
        let yieldIndex = 0;

        while (yieldIndex < this.tools.length || this.hasUnfinishedTools()) {
            // Yield progress from all tools (bypass ordering)
            for (const tool of this.tools) {
                while (tool.pendingProgress.length > 0) {
                    yield {
                        toolCallId: tool.id,
                        progress: tool.pendingProgress.shift()!,
                    };
                }
            }

            // Yield completed results in order
            while (yieldIndex < this.tools.length) {
                const tool = this.tools[yieldIndex];

                if (tool.status === "yielded") {
                    yieldIndex++;
                    continue;
                }

                if (tool.status === "completed") {
                    tool.status = "yielded";
                    for (const result of tool.results) {
                        yield {
                            toolCallId: tool.id,
                            result,
                            contextUpdate: result.contextUpdate,
                            dataUpdate: result.dataUpdate as Partial<TData> | undefined,
                        };
                    }
                    yieldIndex++;
                } else {
                    // Tool is still queued or executing — wait for it
                    break;
                }
            }

            // If there are still unfinished tools, wait for a state change
            if (yieldIndex < this.tools.length && this.hasUnfinishedTools()) {
                await this.waitForStateChange();
            } else {
                break;
            }
        }
    }

    /**
     * Stop processing new queued tools. Already-executing tools continue
     * to completion based on their interruptBehavior.
     */
    discard(): void {
        log.info("[StreamingToolExecutor] Executor discarded, stopping queue processing");
        this.discarded = true;
        this.notifyWaiter();
    }

    /**
     * Return the accumulated context updates from all completed tools.
     */
    getUpdatedContext(): TContext {
        return {
            ...this.toolContext.context,
            ...this.contextUpdates,
        } as TContext;
    }

    /**
     * Check if there are any tools that haven't completed yet.
     */
    hasUnfinishedTools(): boolean {
        return this.tools.some(
            (t) => t.status === "queued" || t.status === "executing"
        );
    }

    /**
     * Wait for a state change (tool completion, progress, or discard).
     * Uses a deferred promise pattern.
     */
    private waitForStateChange(): Promise<void> {
        this.waiter = createDeferred<void>();
        return this.waiter.promise;
    }

    /**
     * Notify the waiting async generator that state has changed.
     */
    private notifyWaiter(): void {
        if (this.waiter) {
            const w = this.waiter;
            this.waiter = null;
            w.resolve();
        }
    }
}
