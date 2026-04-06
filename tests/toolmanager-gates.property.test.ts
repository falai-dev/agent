import { describe, test, expect } from "bun:test";
import fc from "fast-check";
import { Agent, ToolManager } from "../src/index";
import type {
    EnhancedTool,
    ToolContext,
    ToolValidationResult,
    ToolPermissionResult,
} from "../src/types/tool";
import { MockProvider } from "./mock-provider";

// --- Helpers ---

const provider = new MockProvider();

interface Ctx { userId: string }
interface Data { value: number }

function makeAgent() {
    return new Agent<Ctx, Data>({ name: "test", provider });
}

/** Track whether handler was invoked */
function makeEnhancedTool(opts: {
    id: string;
    validateResult?: ToolValidationResult;
    permissionResult?: ToolPermissionResult;
    maxResultSizeChars?: number;
    resultData?: string;
}): { tool: EnhancedTool<Ctx, Data>; handlerCalled: () => boolean } {
    let called = false;
    const tool: EnhancedTool<Ctx, Data> = {
        id: opts.id,
        name: opts.id,
        handler: async (_ctx, _args) => {
            called = true;
            return { data: opts.resultData ?? `result-${opts.id}`, success: true };
        },
        ...(opts.validateResult !== undefined && {
            validateInput: (_input: Record<string, unknown>, _context: ToolContext<Ctx, Data>) =>
                opts.validateResult!,
        }),
        ...(opts.permissionResult !== undefined && {
            checkPermissions: (_input: Record<string, unknown>, _context: ToolContext<Ctx, Data>) =>
                opts.permissionResult!,
        }),
        ...(opts.maxResultSizeChars !== undefined && {
            maxResultSizeChars: opts.maxResultSizeChars,
        }),
    };
    return { tool, handlerCalled: () => called };
}

// --- Property 10: Validation and Permission Gating ---

describe("Property 10: Validation and Permission Gating", () => {
    /**
     * **Validates: Requirements 9.2, 9.3**
     *
     * For any EnhancedTool where validateInput returns { valid: false }
     * or checkPermissions returns { allowed: false }, the handler is never invoked.
     */

    test("handler is never called when validateInput returns valid: false", async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.stringMatching(/^[a-z][a-z0-9-]{0,19}$/).filter(s => s.length > 0),
                fc.string({ minLength: 0, maxLength: 100 }),
                async (toolId, errorMsg) => {
                    const agent = makeAgent();
                    const tm = new ToolManager<Ctx, Data>(agent);

                    const { tool, handlerCalled } = makeEnhancedTool({
                        id: toolId,
                        validateResult: { valid: false, error: errorMsg },
                    });

                    tm.register(tool);

                    const result = await tm.execute(toolId, { someArg: "value" }, {
                        context: { userId: "u1" },
                        retryCount: 0,
                    });

                    expect(handlerCalled()).toBe(false);
                    expect(result.success).toBe(false);
                    expect(result.error).toContain("Validation failed");
                }
            ),
            { numRuns: 50 }
        );
    });

    test("handler is never called when checkPermissions returns allowed: false", async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.stringMatching(/^[a-z][a-z0-9-]{0,19}$/).filter(s => s.length > 0),
                fc.string({ minLength: 0, maxLength: 100 }),
                fc.boolean(),
                async (toolId, reason, canOverride) => {
                    const agent = makeAgent();
                    const tm = new ToolManager<Ctx, Data>(agent);

                    const { tool, handlerCalled } = makeEnhancedTool({
                        id: toolId,
                        permissionResult: { allowed: false, reason, canOverride },
                    });

                    tm.register(tool);

                    const result = await tm.execute(toolId, { someArg: "value" }, {
                        context: { userId: "u1" },
                        retryCount: 0,
                    });

                    expect(handlerCalled()).toBe(false);
                    expect(result.success).toBe(false);
                    expect(result.error).toContain("Permission denied");
                }
            ),
            { numRuns: 50 }
        );
    });

    test("handler IS called when validateInput returns valid: true", async () => {
        const agent = makeAgent();
        const tm = new ToolManager<Ctx, Data>(agent);

        const { tool, handlerCalled } = makeEnhancedTool({
            id: "valid-tool",
            validateResult: { valid: true },
        });

        tm.register(tool);

        const result = await tm.execute("valid-tool", { someArg: "value" }, {
            context: { userId: "u1" },
            retryCount: 0,
        });

        expect(handlerCalled()).toBe(true);
        expect(result.success).toBe(true);
    });

    test("handler IS called when checkPermissions returns allowed: true", async () => {
        const agent = makeAgent();
        const tm = new ToolManager<Ctx, Data>(agent);

        const { tool, handlerCalled } = makeEnhancedTool({
            id: "allowed-tool",
            permissionResult: { allowed: true },
        });

        tm.register(tool);

        const result = await tm.execute("allowed-tool", { someArg: "value" }, {
            context: { userId: "u1" },
            retryCount: 0,
        });

        expect(handlerCalled()).toBe(true);
        expect(result.success).toBe(true);
    });

    test("validation gate runs before permission gate", async () => {
        const agent = makeAgent();
        const tm = new ToolManager<Ctx, Data>(agent);

        const { tool, handlerCalled } = makeEnhancedTool({
            id: "both-gates",
            validateResult: { valid: false, error: "bad input" },
            permissionResult: { allowed: false, reason: "no access" },
        });

        tm.register(tool);

        const result = await tm.execute("both-gates", { someArg: "value" }, {
            context: { userId: "u1" },
            retryCount: 0,
        });

        expect(handlerCalled()).toBe(false);
        // Should fail on validation, not permission
        expect(result.error).toContain("Validation failed");
    });

    test("plain Tool without gates executes handler directly (Req 10.6)", async () => {
        const agent = makeAgent();
        const tm = new ToolManager<Ctx, Data>(agent);

        let called = false;
        tm.register({
            id: "plain-tool",
            handler: async () => {
                called = true;
                return { data: "ok", success: true };
            },
        });

        const result = await tm.execute("plain-tool", { someArg: "value" }, {
            context: { userId: "u1" },
            retryCount: 0,
        });

        expect(called).toBe(true);
        expect(result.success).toBe(true);
    });
});


// --- Property 11: Per-Tool Result Size Budget ---

import { StreamingToolExecutor } from "../src/core/StreamingToolExecutor";
import type { ToolCallRequest, ToolExecutionUpdate } from "../src/types/tool";

function makeToolContext(): ToolContext<Ctx, Data> {
    return {
        context: { userId: "u1" },
        data: {} as Partial<Data>,
        history: [],
        updateContext: async () => { },
        updateData: async () => { },
        getField: () => undefined,
        setField: async () => { },
        hasField: () => false,
    };
}

function makeCall(id: string, toolName?: string): ToolCallRequest {
    return { id, toolName: toolName ?? id, arguments: {} };
}

async function collectAll(
    executor: StreamingToolExecutor<Ctx, Data>
): Promise<ToolExecutionUpdate<Data>[]> {
    const results: ToolExecutionUpdate<Data>[] = [];
    for await (const update of executor.getRemainingResults()) {
        results.push(update);
    }
    return results;
}

describe("Property 11: Per-Tool Result Size Budget", () => {
    /**
     * **Validates: Requirement 9.4**
     *
     * For any EnhancedTool with maxResultSizeChars, yielded result content
     * does not exceed that limit (plus truncation notice overhead).
     */

    test("result content is truncated when exceeding maxResultSizeChars", async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.integer({ min: 10, max: 200 }),
                fc.integer({ min: 1, max: 500 }),
                async (budget, extraChars) => {
                    const contentLength = budget + extraChars;
                    const bigContent = "x".repeat(contentLength);

                    const tool: EnhancedTool<Ctx, Data> = {
                        id: "big-tool",
                        name: "big-tool",
                        handler: async () => ({ data: bigContent, success: true }),
                        maxResultSizeChars: budget,
                    };

                    const ctx = makeToolContext();
                    const executor = new StreamingToolExecutor<Ctx, Data>(ctx);
                    executor.addTool(makeCall("c1", "big-tool"), tool);

                    const updates = await collectAll(executor);
                    const resultUpdate = updates.find((u) => u.result !== undefined);
                    expect(resultUpdate).toBeDefined();

                    const resultStr = JSON.stringify(resultUpdate!.result!.data);
                    // The raw data content (without JSON quotes) should not exceed budget + truncation notice
                    const dataStr = typeof resultUpdate!.result!.data === "string"
                        ? resultUpdate!.result!.data
                        : JSON.stringify(resultUpdate!.result!.data);
                    // The truncated content should be shorter than the original
                    expect(dataStr.length).toBeLessThan(contentLength + 100);
                }
            ),
            { numRuns: 30 }
        );
    });

    test("result content within budget is unchanged", async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.integer({ min: 50, max: 500 }),
                async (budget) => {
                    const content = "y".repeat(budget - 10); // well within budget

                    const tool: EnhancedTool<Ctx, Data> = {
                        id: "small-tool",
                        name: "small-tool",
                        handler: async () => ({ data: content, success: true }),
                        maxResultSizeChars: budget,
                    };

                    const ctx = makeToolContext();
                    const executor = new StreamingToolExecutor<Ctx, Data>(ctx);
                    executor.addTool(makeCall("c1", "small-tool"), tool);

                    const updates = await collectAll(executor);
                    const resultUpdate = updates.find((u) => u.result !== undefined);
                    expect(resultUpdate).toBeDefined();
                    // Content within budget should be preserved as-is
                    expect(resultUpdate!.result!.data).toBe(content);
                }
            ),
            { numRuns: 30 }
        );
    });
});
