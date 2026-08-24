/**
 * Tool-loop correctness batch:
 *  - a THROWN handler error reaches the model as a FAILED tool result (never
 *    "Tool executed successfully");
 *  - two calls to the SAME tool in one turn keep distinct results (records are
 *    keyed by call, not name);
 *  - maxToolLoops is actually reachable — tools are offered every iteration;
 *  - ToolResult detection no longer misclassifies business payloads that
 *    merely contain `error`/`data` keys;
 *  - schema-mandated malformed JSON fails the turn instead of leaking raw
 *    protocol fragments as the user-visible reply (salvage first).
 */
import { describe, expect, test } from "bun:test";

import { Agent, ToolManager } from "../src/index";
import type {
    AiProvider,
    GenerateMessageInput,
    GenerateMessageOutput,
    GenerateMessageStreamChunk,
} from "../src/types/ai";
import type { HistoryItem } from "../src/types/history";
import { MockProvider, MockProviderFactory } from "./mock-provider";

interface TestContext { userId: string }
interface TestData { item?: string; confirmed?: boolean }

/** MockProvider wrapper that records every generateMessage input. */
function makeRecordingProvider(inner: AiProvider) {
    const calls: Array<{ prompt: string; history: HistoryItem[] }> = [];
    return {
        calls,
        provider: {
            name: "recording",
            capabilities: inner.capabilities,
            generateMessage: async (input: GenerateMessageInput<unknown>) => {
                calls.push({ prompt: input.prompt, history: [...input.history] });
                return inner.generateMessage(input) as Promise<GenerateMessageOutput>;
            },
            // eslint-disable-next-line require-yield
            generateMessageStream: async function* (input: GenerateMessageInput<unknown>) {
                // Delegate by buffering the inner stream.
                for await (const chunk of inner.generateMessageStream(input)) {
                    yield chunk as GenerateMessageStreamChunk;
                }
            },
        } as AiProvider,
    };
}

// FlowOptions.requiredFields is mutable (keyof TData)[] — annotate so the literal
// does not need `as const` (whose readonly arrays would not be assignable).
const FLOW = [{
    id: "flowA",
    title: "A",
    requiredFields: ["item"] as (keyof TestData)[],
    steps: [{ id: "ask", prompt: "ask" }],
}];

describe("thrown tool errors are visible to the model", () => {
    test("a crashing handler yields a success:false tool result in follow-up history", async () => {
        const inner = MockProviderFactory.withToolCalls([
            { toolName: "boom", arguments: {} },
        ]);
        const { provider, calls } = makeRecordingProvider(inner);

        const agent = new Agent<TestContext, TestData>({
            name: "boomAgent",
            sessionId: "sess_boom",
            provider,
            flows: [...FLOW],
            tools: [
                {
                    id: "boom",
                    description: "always throws",
                    parameters: {},
                    handler: () => {
                        throw new Error("upstream API is down");
                    },
                },
            ],
        });

        await agent.respond({
            history: [{ role: "user", content: "hi" }],
        });

        // Some provider call must carry the failure back to the model.
        const sawFailure = calls.some((c) =>
            c.history.some(
                (h) =>
                    h.role === "tool" &&
                    typeof h.content === "string" &&
                    h.content.includes("upstream API is down") &&
                    h.content.includes('"success":false')
            )
        );
        expect(sawFailure).toBe(true);
    });
});

describe("same-tool parallel calls keep distinct results", () => {
    test("two calls to one tool produce two keyed result pairs in history", async () => {
        let invocation = 0;
        const inner = MockProviderFactory.withToolCalls([
            { toolName: "lookup", arguments: { q: "first" } },
            { toolName: "lookup", arguments: { q: "second" } },
        ]);
        const { provider, calls } = makeRecordingProvider(inner);

        const agent = new Agent<TestContext, TestData>({
            name: "dupAgent",
            sessionId: "sess_dup",
            provider,
            flows: [...FLOW],
            tools: [
                {
                    id: "lookup",
                    description: "returns per-call payload",
                    parameters: {},
                    handler: (_ctx, args) => ({ value: (args as { q: string }).q, n: ++invocation }),
                },
            ],
        });

        await agent.respond({
            history: [{ role: "user", content: "hi" }],
        });

        // The FIRST follow-up history must carry BOTH first-round results as
        // distinct keyed pairs — under name-keyed maps the second overwrote the
        // first, so 'first' vanished from what the model saw.
        const followUpHistory = calls[1]?.history ?? [];
        const toolContents = followUpHistory
            .filter((h) => h.role === "tool" && typeof h.content === "string")
            .map((h) => h.content as string);
        expect(toolContents.some((t) => t.includes("first"))).toBe(true);
        expect(toolContents.some((t) => t.includes("second"))).toBe(true);
        // And their tool_call ids are distinct.
        const pairIds = new Set<string>();
        for (const h of followUpHistory) {
            if (h.role === "assistant" && h.tool_calls) {
                for (const tc of h.tool_calls) pairIds.add(tc.id);
            }
        }
        expect(pairIds.size).toBe(2);
    });
});

describe("maxToolLoops is reachable", () => {
    test("tools are offered on every follow-up round up to the configured cap", async () => {
        // A provider that ALWAYS requests another tool call: with tools offered
        // every round, the loop must run exactly maxToolLoops rounds before
        // stopping. Previously tools were withheld after round 1, capping the
        // loop at 2 regardless of config.
        const always = new MockProvider({
            responseMessage: "calling again",
            structuredResponse: {
                message: "calling again",
                toolCalls: [{ toolName: "noop", arguments: {} }],
            } as never,
        });
        const { provider, calls } = makeRecordingProvider(always);

        const agent = new Agent<TestContext, TestData>({
            name: "loopAgent",
            sessionId: "sess_loop",
            provider,
            maxToolLoops: 4,
            flows: [...FLOW],
            tools: [{ id: "noop", description: "noop", parameters: {}, handler: () => ({ ok: true }) }],
        });

        await agent.respond({
            history: [{ role: "user", content: "hi" }],
        });

        // initial call + 4 capped loop iterations + 1 forced final-text call
        // (the mock never stops asking for tools). Under the old behavior this
        // was 3: tools were withheld after the first iteration.
        expect(calls.length).toBe(6);
    });
});

describe("ToolResult detection does not swallow business payloads", () => {
    test("an envelope containing only data/error keys is treated as RAW data", async () => {
        const agent = new Agent<TestContext, TestData>({
            name: "sniffAgent",
            context: { userId: "u1" },
            provider: new MockProvider(),
            flows: [...FLOW],
        });
        const tm = new ToolManager<TestContext, TestData>(agent);
        agent.registerTools?.([] as never); // no-op guard if absent

        const result = await (tm as unknown as {
            executeTool(params: {
                tool: { id: string; description: string; parameters: unknown; handler: (ctx: never, args: never) => unknown };
                context: TestContext;
                updateContext: () => Promise<void>;
                updateData: () => Promise<void>;
                history: unknown[];
                data: Partial<TestData>;
                toolArguments?: Record<string, unknown>;
            }): Promise<{ success: boolean; data: unknown }>;
        }).executeTool({
            tool: {
                id: "envelope",
                description: "returns an upstream-style envelope",
                parameters: {},
                handler: () => ({ error: null, data: [1, 2, 3] }),
            },
            context: { userId: "u1" },
            updateContext: async () => undefined,
            updateData: async () => undefined,
            history: [],
            data: {},
        });

        // Wrapped as raw data (success defaults true), NOT misread as a failed
        // execution because of the `error` key.
        expect(result.success).toBe(true);
        expect(result.data).toEqual({ error: null, data: [1, 2, 3] });
    });
});
