/**
 * Tests for ToolContext.dispatch and ToolResult.directive
 *
 * Validates: Requirements 6.4, 6.5, 6.6
 *
 * 6.4: ToolContext SHALL expose dispatch(directive: Directive): void
 * 6.5: ToolResult SHALL expose optional directive?: Directive field
 * 6.6: WHEN a tool handler calls ctx.dispatch(d) AND returns { directive: d2 },
 *       THE Agent SHALL place both d and d2 onto the per-turn directive bus.
 */
import { expect, test, describe } from "bun:test";
import { Agent, ToolManager } from "../src/index";
import type { Tool, ToolResult, ToolContext } from "../src/types";
import type { Directive } from "../src/types/flow";
import { MockProvider } from "./mock-provider";

interface TestContext {
    userId: string;
}

interface TestData {
    name?: string;
    email?: string;
}

const provider = new MockProvider();

function createTestAgent() {
    return new Agent<TestContext, TestData>({
        name: "DirectiveToolTestAgent",
        description: "Agent for testing tool directive dispatch",
        context: { userId: "test-user" },
        provider,
    });
}

describe("ToolContext.dispatch (Requirement 6.4)", () => {
    test("dispatch method is available on ToolContext and emits a directive", async () => {
        const agent = createTestAgent();
        const toolManager = new ToolManager<TestContext, TestData>(agent);

        const goToDirective: Directive<TestContext, TestData> = { goTo: "SomeFlow" };

        const tool: Tool<TestContext, TestData> = {
            id: "dispatch-tool",
            description: "Tool that dispatches a directive",
            handler: async (ctx: ToolContext<TestContext, TestData>) => {
                ctx.dispatch(goToDirective);
                return { data: "done", success: true };
            },
        };

        const result = await toolManager.executeTool({
            tool,
            context: { userId: "test-user" },
            updateContext: async () => { },
            updateData: async () => { },
            history: [],
            data: {},
        });

        expect(result.success).toBe(true);
        expect(result.directives).toBeDefined();
        expect(result.directives).toHaveLength(1);
        expect(result.directives![0]).toEqual(goToDirective);
    });

    test("multiple dispatch calls in one handler are all collected", async () => {
        const agent = createTestAgent();
        const toolManager = new ToolManager<TestContext, TestData>(agent);

        const d1: Directive<TestContext, TestData> = { goTo: "FlowA" };
        const d2: Directive<TestContext, TestData> = { dataUpdate: { name: "Alice" } };

        const tool: Tool<TestContext, TestData> = {
            id: "multi-dispatch-tool",
            description: "Tool that dispatches multiple directives",
            handler: async (ctx: ToolContext<TestContext, TestData>) => {
                ctx.dispatch(d1);
                ctx.dispatch(d2);
                return { data: "done", success: true };
            },
        };

        const result = await toolManager.executeTool({
            tool,
            context: { userId: "test-user" },
            updateContext: async () => { },
            updateData: async () => { },
            history: [],
            data: {},
        });

        expect(result.directives).toBeDefined();
        expect(result.directives).toHaveLength(2);
        expect(result.directives![0]).toEqual(d1);
        expect(result.directives![1]).toEqual(d2);
    });

    test("dispatch with no calls results in no directives field", async () => {
        const agent = createTestAgent();
        const toolManager = new ToolManager<TestContext, TestData>(agent);

        const tool: Tool<TestContext, TestData> = {
            id: "no-dispatch-tool",
            description: "Tool that does not dispatch",
            handler: async () => {
                return { data: "done", success: true };
            },
        };

        const result = await toolManager.executeTool({
            tool,
            context: { userId: "test-user" },
            updateContext: async () => { },
            updateData: async () => { },
            history: [],
            data: {},
        });

        expect(result.success).toBe(true);
        expect(result.directives).toBeUndefined();
    });
});

describe("ToolResult.directive (Requirement 6.5)", () => {
    test("directive returned in ToolResult is collected", async () => {
        const agent = createTestAgent();
        const toolManager = new ToolManager<TestContext, TestData>(agent);

        const resultDirective: Directive<TestContext, TestData> = { goTo: "TargetFlow" };

        const tool: Tool<TestContext, TestData> = {
            id: "result-directive-tool",
            description: "Tool that returns a directive in its result",
            handler: async (): Promise<ToolResult<string, TestContext, TestData>> => {
                return {
                    data: "done",
                    success: true,
                    directive: resultDirective,
                };
            },
        };

        const result = await toolManager.executeTool({
            tool,
            context: { userId: "test-user" },
            updateContext: async () => { },
            updateData: async () => { },
            history: [],
            data: {},
        });

        expect(result.success).toBe(true);
        expect(result.directives).toBeDefined();
        expect(result.directives).toHaveLength(1);
        expect(result.directives![0]).toEqual(resultDirective);
    });

    test("ToolResult without directive field produces no directives", async () => {
        const agent = createTestAgent();
        const toolManager = new ToolManager<TestContext, TestData>(agent);

        const tool: Tool<TestContext, TestData> = {
            id: "plain-result-tool",
            description: "Tool that returns a plain result",
            handler: async (): Promise<ToolResult<string, TestContext, TestData>> => {
                return { data: "result", success: true };
            },
        };

        const result = await toolManager.executeTool({
            tool,
            context: { userId: "test-user" },
            updateContext: async () => { },
            updateData: async () => { },
            history: [],
            data: {},
        });

        expect(result.success).toBe(true);
        expect(result.directives).toBeUndefined();
    });
});

describe("ctx.dispatch AND ToolResult.directive both reach the bus (Requirement 6.6)", () => {
    test("both ctx.dispatch(d) and result.directive reach the directive bus", async () => {
        const agent = createTestAgent();
        const toolManager = new ToolManager<TestContext, TestData>(agent);

        const dispatchedDirective: Directive<TestContext, TestData> = { goTo: "FlowA" };
        const returnedDirective: Directive<TestContext, TestData> = { dataUpdate: { name: "Bob" } };

        const tool: Tool<TestContext, TestData> = {
            id: "both-directives-tool",
            description: "Tool that uses both dispatch and result.directive",
            handler: async (ctx: ToolContext<TestContext, TestData>): Promise<ToolResult<string, TestContext, TestData>> => {
                ctx.dispatch(dispatchedDirective);
                return {
                    data: "done",
                    success: true,
                    directive: returnedDirective,
                };
            },
        };

        const result = await toolManager.executeTool({
            tool,
            context: { userId: "test-user" },
            updateContext: async () => { },
            updateData: async () => { },
            history: [],
            data: {},
        });

        expect(result.success).toBe(true);
        expect(result.directives).toBeDefined();
        expect(result.directives).toHaveLength(2);
        // dispatch() calls come first (emission order), then result.directive
        expect(result.directives![0]).toEqual(dispatchedDirective);
        expect(result.directives![1]).toEqual(returnedDirective);
    });

    test("multiple dispatch calls plus result.directive all collected in order", async () => {
        const agent = createTestAgent();
        const toolManager = new ToolManager<TestContext, TestData>(agent);

        const d1: Directive<TestContext, TestData> = { contextUpdate: { userId: "updated" } };
        const d2: Directive<TestContext, TestData> = { goTo: "FlowB" };
        const d3: Directive<TestContext, TestData> = { complete: true };

        const tool: Tool<TestContext, TestData> = {
            id: "triple-directive-tool",
            description: "Tool that dispatches twice and returns a directive",
            handler: async (ctx: ToolContext<TestContext, TestData>): Promise<ToolResult<string, TestContext, TestData>> => {
                ctx.dispatch(d1);
                ctx.dispatch(d2);
                return {
                    data: "done",
                    success: true,
                    directive: d3,
                };
            },
        };

        const result = await toolManager.executeTool({
            tool,
            context: { userId: "test-user" },
            updateContext: async () => { },
            updateData: async () => { },
            history: [],
            data: {},
        });

        expect(result.directives).toBeDefined();
        expect(result.directives).toHaveLength(3);
        expect(result.directives![0]).toEqual(d1);
        expect(result.directives![1]).toEqual(d2);
        expect(result.directives![2]).toEqual(d3);
    });
});
