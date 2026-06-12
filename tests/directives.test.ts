/**
 * Directive pipeline integration tests
 *
 * Exercises the FULL directive pipeline end-to-end. Focus is on integration
 * points that span multiple components (Agent, flow namespace, DirectiveBus,
 * DirectiveChainTracker, ToolManager).
 *
 * **Validates: Requirements 1.1–1.16, 6.4–6.6, 9.1–9.9, 10.1–10.6, 22.1–22.3, 24.1, 24.3**
 */

import { describe, test, expect } from "bun:test";
import {
    Agent,
    FlowConfigurationError,
    ToolManager,
    createSession,
    flow,
} from "../src/index";
// Internal — not part of the public barrel since v2.4
import { DirectiveChainTracker } from "../src/core/DirectiveChainTracker";
import type {
    Directive,
    SessionState,
    Tool,
    ToolContext,
    ToolResult,
} from "../src/types";
import { DirectiveBus } from "../src/core/DirectiveBus";
import { MockProvider } from "./mock-provider";

// ─── Test types ──────────────────────────────────────────────────────────────

interface TestContext {
    userId: string;
    role?: string;
}

interface TestData {
    name?: string;
    email?: string;
    query?: string;
    amount?: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function createTestAgent(opts?: { maxDirectiveChain?: number }) {
    const provider = new MockProvider({ responseMessage: "OK" });
    return new Agent<TestContext, TestData>({
        name: "DirectiveIntegrationAgent",
        description: "Integration test agent for directive pipeline",
        goal: "Test directive flow end-to-end",
        context: { userId: "user-123" },
        provider,
        maxDirectiveChain: opts?.maxDirectiveChain,
        flows: [
            {
                title: "Booking",
                when: "user wants to book",
                steps: [
                    { prompt: "What would you like to book?" },
                    { prompt: "Please confirm your booking." },
                ],
            },
            {
                title: "Feedback",
                when: "user wants to give feedback",
                steps: [{ prompt: "Please share your feedback." }],
            },
            {
                title: "Support",
                when: "user needs support",
                requiredFields: ["query"],
                steps: [{ prompt: "Describe your issue.", collect: ["query"] }],
            },
            {
                title: "Refund",
                when: "user wants a refund",
                requiredFields: ["amount"],
                steps: [{ prompt: "How much was the charge?", collect: ["amount"] }],
            },
        ],
    });
}

// ─── 1. Plain object literal directives apply (no builder API) ───────────────

describe("Plain object literal directives apply (no builder API)", () => {
    test("plain { goTo: 'Booking' } object literal applies via applyDirective", () => {
        const agent = createTestAgent();
        const session = createSession<TestData>({ data: {} });

        const result = agent.applyDirective({ goTo: "Booking" }, session);

        expect(result.currentFlow?.title).toBe("Booking");
    });

    test("plain { complete: true } object literal applies", () => {
        const agent = createTestAgent();
        const session = createSession<TestData>({
            data: {},
            currentFlow: { id: "booking", title: "Booking" },
            flowHistory: [{ flowId: "booking", completed: false }],
        });

        const result = agent.applyDirective({ complete: true }, session);

        expect(result.currentFlow).toBeUndefined();
    });

    test("plain { dataUpdate: {...} } applies state writes without position change", () => {
        const agent = createTestAgent();
        const session = createSession<TestData>({ data: { name: "Alice" } });

        const result = agent.applyDirective(
            { dataUpdate: { email: "alice@test.com" } },
            session
        );

        expect(result.data).toEqual({ name: "Alice", email: "alice@test.com" });
    });

    test("combined { goTo, dataUpdate, reply } literal all applied in one call", () => {
        const agent = createTestAgent();
        const session = createSession<TestData>({ data: {} });

        const result = agent.applyDirective(
            { goTo: "Support", dataUpdate: { query: "help" }, reply: "Transferring..." },
            session
        );

        expect(result.currentFlow?.title).toBe("Support");
        expect(result.data.query).toBe("help");
    });

    test("no builder functions exist on the flow namespace (Req 1.15)", () => {
        expect((flow as Record<string, unknown>).goTo).toBeUndefined();
        expect((flow as Record<string, unknown>).complete).toBeUndefined();
        expect((flow as Record<string, unknown>).abort).toBeUndefined();
        expect((flow as Record<string, unknown>).reset).toBeUndefined();
        expect((flow as Record<string, unknown>).goToStep).toBeUndefined();
    });
});

// ─── 2. Multiple position fields throw FlowConfigurationError ────────────────

describe("Multiple position fields throw FlowConfigurationError listing conflicts", () => {
    test("goTo + complete throws listing both fields", () => {
        const agent = createTestAgent();
        const session = createSession<TestData>({ data: {} });

        try {
            agent.applyDirective(
                { goTo: "Booking", complete: true } as Directive<TestContext, TestData>,
                session
            );
            expect(true).toBe(false); // Should not reach
        } catch (err: any) {
            expect(err).toBeInstanceOf(FlowConfigurationError);
            expect(err.message).toContain("goTo");
            expect(err.message).toContain("complete");
        }
    });

    test("goTo + abort + reset throws listing all three fields", () => {
        const agent = createTestAgent();
        const session = createSession<TestData>({ data: {} });

        try {
            agent.applyDirective(
                { goTo: "Booking", abort: "nope", reset: true } as Directive<TestContext, TestData>,
                session
            );
            expect(true).toBe(false);
        } catch (err: any) {
            expect(err).toBeInstanceOf(FlowConfigurationError);
            expect(err.message).toContain("goTo");
            expect(err.message).toContain("abort");
            expect(err.message).toContain("reset");
        }
    });

    test("empty goTo: {} throws mentioning flow field requirement", () => {
        const agent = createTestAgent();
        const session = createSession<TestData>({ data: {} });

        try {
            agent.applyDirective({ goTo: {} } as any, session);
            expect(true).toBe(false);
        } catch (err: any) {
            expect(err).toBeInstanceOf(FlowConfigurationError);
            expect(err.message).toContain("goTo");
            expect(err.message).toContain("flow");
        }
    });

    test("session state not mutated when validation throws", () => {
        const agent = createTestAgent();
        const session = createSession<TestData>({ data: { name: "Alice" } });
        const originalData = { ...session.data };

        try {
            agent.applyDirective(
                { goTo: "Booking", abort: "nope" } as Directive<TestContext, TestData>,
                session
            );
        } catch {
            // Expected
        }

        expect(session.data).toEqual(originalData);
        expect(session.currentFlow).toBeUndefined();
    });

    test("flow.validate also throws for multiple position fields (standalone)", () => {
        expect(() =>
            flow.validate({ goTo: "X", goToStep: "Y" } as Directive)
        ).toThrow(FlowConfigurationError);
    });
});

// ─── 3. String sugar forms desugar correctly ─────────────────────────────────

describe("String sugar forms desugar correctly", () => {
    test("goTo: 'Booking' desugars to { goTo: { flow: 'Booking' } } semantics", () => {
        const agent = createTestAgent();
        const session = createSession<TestData>({ data: {} });

        // String goTo should enter the named flow
        const result = agent.applyDirective({ goTo: "Booking" }, session);
        expect(result.currentFlow?.title).toBe("Booking");
    });

    test("abort: 'timeout' desugars correctly", () => {
        const agent = createTestAgent();
        const session = createSession<TestData>({
            data: { name: "Alice" },
            currentFlow: { id: "booking", title: "Booking" },
        });

        const result = agent.applyDirective({ abort: "timeout" }, session);

        // Abort should clear the flow
        expect(result.currentFlow).toBeUndefined();
    });

    test("complete: true desugars correctly", () => {
        const agent = createTestAgent();
        const session = createSession<TestData>({
            data: {},
            currentFlow: { id: "booking", title: "Booking" },
            flowHistory: [{ flowId: "booking", completed: false }],
        });

        const result = agent.applyDirective({ complete: true }, session);
        expect(result.currentFlow).toBeUndefined();
    });

    test("reset: true desugars correctly — re-enters current flow at initial step", () => {
        const agent = createTestAgent();
        const session = createSession<TestData>({
            data: { name: "Bob" },
            currentFlow: { id: "booking", title: "Booking" },
            currentStep: { id: "step_2" },
        });

        const result = agent.applyDirective({ reset: true }, session);

        // Should re-enter same flow from beginning
        expect(result.currentFlow?.title).toBe("Booking");
        expect(result.currentStep).toBeUndefined();
    });

    test("dispatch string sugar: Agent.dispatch('Feedback') sets goTo: 'Feedback'", async () => {
        const agent = createTestAgent();
        const session = createSession<TestData>({ data: {} });

        const result = await agent.dispatch("Feedback", session);

        expect(result.pendingDirective).toBeDefined();
        expect(result.pendingDirective!.goTo).toBe("Feedback");
    });
});

// ─── 4. Agent.dispatch sets pendingDirective without applying ────────────────

describe("Agent.dispatch sets pendingDirective without applying", () => {
    test("dispatch('Booking') sets pendingDirective but does NOT enter the flow", async () => {
        const agent = createTestAgent();
        const session = createSession<TestData>({ data: {} });

        const result = await agent.dispatch("Booking", session);

        // pendingDirective is set
        expect(result.pendingDirective).toBeDefined();
        expect(result.pendingDirective!.goTo).toBe("Booking");

        // Flow NOT entered yet
        expect(result.currentFlow?.title).not.toBe("Booking");
    });

    test("dispatch with full Directive also only sets pendingDirective", async () => {
        const agent = createTestAgent();
        const session = createSession<TestData>({ data: {} });

        const result = await agent.dispatch(
            { goTo: "Support", dataUpdate: { query: "help" } },
            session
        );

        expect(result.pendingDirective).toBeDefined();
        expect(result.pendingDirective!.goTo).toBe("Support");
        expect(result.pendingDirective!.dataUpdate).toEqual({ query: "help" });
        // Flow NOT entered yet
        expect(result.currentFlow?.title).not.toBe("Support");
    });

    test("dispatch without session arg updates agent's current session", async () => {
        const agent = createTestAgent();
        const session = createSession<TestData>({ data: {} });
        agent.currentSession = session;

        await agent.dispatch("Feedback");

        expect(agent.currentSession!.pendingDirective).toBeDefined();
        expect(agent.currentSession!.pendingDirective!.goTo).toBe("Feedback");
    });

    test("dispatch strips PreDirective-only fields from stored pendingDirective", async () => {
        const agent = createTestAgent();
        const session = createSession<TestData>({ data: {} });

        const result = await agent.dispatch(
            {
                goTo: "Booking",
                appendPrompt: ["Be polite"],
                injectTools: [{ id: "t1", handler: async () => ({}) }],
                halt: true,
            } as unknown as Directive<TestContext, TestData>,
            session
        );

        const pending = result.pendingDirective as any;
        expect(pending.goTo).toBe("Booking");
        expect(pending.appendPrompt).toBeUndefined();
        expect(pending.injectTools).toBeUndefined();
        expect(pending.halt).toBeUndefined();
    });

    test("dispatch with unknown flow throws FlowConfigurationError", async () => {
        const agent = createTestAgent();
        const session = createSession<TestData>({ data: {} });

        try {
            await agent.dispatch("NonExistentFlow", session);
            expect(true).toBe(false);
        } catch (err: any) {
            expect(err).toBeInstanceOf(FlowConfigurationError);
            expect(err.message).toContain("NonExistentFlow");
        }
    });

    test("dispatch with invalid directive (multi-position) throws", async () => {
        const agent = createTestAgent();
        const session = createSession<TestData>({ data: {} });

        await expect(
            agent.dispatch(
                { goTo: "Booking", abort: "nope" } as Directive<TestContext, TestData>,
                session
            )
        ).rejects.toThrow(FlowConfigurationError);
    });
});

// ─── 5. Agent.applyDirective is synchronous and idempotent modulo timestamps ─

describe("Agent.applyDirective is synchronous and idempotent modulo timestamps", () => {
    test("applyDirective returns a SessionState synchronously (not a Promise)", () => {
        const agent = createTestAgent();
        const session = createSession<TestData>({ data: {} });

        const result = agent.applyDirective({ goTo: "Booking" }, session);

        // Must NOT be a Promise — should have session-like properties immediately
        expect(result.id).toBeDefined();
        expect(result.data).toBeDefined();
        expect(typeof (result as any).then).not.toBe("function");
    });

    test("applying the same directive twice yields equivalent state (idempotent modulo timestamps)", () => {
        const agent = createTestAgent();

        const directive: Directive<TestContext, TestData> = {
            goTo: "Feedback",
            dataUpdate: { name: "Alice" },
        };

        const session1 = createSession<TestData>({ data: {} });
        const result1 = agent.applyDirective(directive, session1);

        const session2 = createSession<TestData>({ data: {} });
        const result2 = agent.applyDirective(directive, session2);

        // Same flow entered
        expect(result1.currentFlow?.title).toBe(result2.currentFlow?.title);
        // Same data state
        expect(result1.data.name).toBe(result2.data.name);
    });

    test("applyDirective with dataUpdate is cumulative (second call adds more data)", () => {
        const agent = createTestAgent();
        const session = createSession<TestData>({ data: {} });

        // First apply
        const result1 = agent.applyDirective(
            { dataUpdate: { name: "Alice" } },
            session
        );
        expect(result1.data.name).toBe("Alice");

        // Second apply on the same session
        const result2 = agent.applyDirective(
            { dataUpdate: { email: "alice@test.com" } },
            result1
        );
        expect(result2.data.name).toBe("Alice");
        expect(result2.data.email).toBe("alice@test.com");
    });

    test("applyDirective with goTo.data merges data before entering", () => {
        const agent = createTestAgent();
        const session = createSession<TestData>({ data: { name: "Bob" } });

        const result = agent.applyDirective(
            { goTo: { flow: "Support", data: { query: "help me" } } },
            session
        );

        expect(result.currentFlow?.title).toBe("Support");
        expect(result.data.name).toBe("Bob");
        expect(result.data.query).toBe("help me");
    });
});

// ─── 6. Two emitters merge per Algorithm 4 ──────────────────────────────────

describe("Two emitters in one turn merge per Algorithm 4", () => {
    test("position precedence: abort > complete > goTo > reset", () => {
        const bus = new DirectiveBus();
        bus.emit({ goTo: "FlowA" } as Directive, "tool:first");
        bus.emit({ abort: "critical" } as Directive, "tool:second");

        const result = bus.drain()!;
        expect(result.abort).toBe("critical");
        expect(result.goTo).toBeUndefined();
    });

    test("last-wins tie-breaking for same-precedence position fields", () => {
        const bus = new DirectiveBus();
        bus.emit({ goTo: "FlowA" } as Directive, "tool:first");
        bus.emit({ goTo: "FlowB" } as Directive, "tool:second");

        const result = bus.drain()!;
        expect(result.goTo).toBe("FlowB");
    });

    test("dataUpdate shallow-merge: later overrides on key collision", () => {
        const bus = new DirectiveBus();
        bus.emit({ dataUpdate: { name: "Alice", email: "a@a.com" } } as Directive, "hook:prepare");
        bus.emit({ dataUpdate: { email: "b@b.com", query: "help" } } as Directive, "tool:lookup");

        const result = bus.drain()!;
        expect(result.dataUpdate).toEqual({ name: "Alice", email: "b@b.com", query: "help" });
    });

    test("contextUpdate shallow-merge: later overrides on key collision", () => {
        const bus = new DirectiveBus();
        bus.emit({ contextUpdate: { userId: "u1", role: "user" } } as Directive, "hook:onEnter");
        bus.emit({ contextUpdate: { role: "admin" } } as Directive, "tool:elevate");

        const result = bus.drain()!;
        expect(result.contextUpdate).toEqual({ userId: "u1", role: "admin" });
    });

    test("reply: last emission wins", () => {
        const bus = new DirectiveBus();
        bus.emit({ reply: "First message" } as Directive, "hook:onEnter");
        bus.emit({ reply: "Second message" } as Directive, "hook:prepare");

        const result = bus.drain()!;
        expect(result.reply).toBe("Second message");
    });

    test("appendPrompt arrays concatenate in emission order (PreDirective)", () => {
        const bus = new DirectiveBus();
        bus.emit({ appendPrompt: ["line1"] } as unknown as Directive, "flow.onEnter");
        bus.emit({ appendPrompt: ["line2", "line3"] } as unknown as Directive, "step.prepare");

        const result = bus.drain() as unknown as { appendPrompt: string[] };
        expect(result.appendPrompt).toEqual(["line1", "line2", "line3"]);
    });

    test("injectTools concatenate then dedupe by id (last wins)", () => {
        const toolV1 = { id: "search", handler: () => ({}) };
        const toolV2 = { id: "search", handler: () => ({ v: 2 }) };
        const toolOther = { id: "lookup", handler: () => ({}) };

        const bus = new DirectiveBus();
        bus.emit({ injectTools: [toolV1, toolOther] } as unknown as Directive, "flow.onEnter");
        bus.emit({ injectTools: [toolV2] } as unknown as Directive, "step.prepare");

        const result = bus.drain() as unknown as { injectTools: Array<{ id: string }> };
        expect(result.injectTools).toHaveLength(2);
        expect(result.injectTools[0]).toBe(toolV2); // last wins for 'search'
        expect(result.injectTools[1].id).toBe("lookup");
    });
});

// ─── 7. Tool ctx.dispatch AND ToolResult.directive both reach the bus ────────

describe("Tool ctx.dispatch(d) AND ToolResult.directive both reach the bus", () => {
    test("both dispatched and returned directives are collected", async () => {
        const agent = createTestAgent();
        const toolManager = new ToolManager<TestContext, TestData>(agent);

        const dispatchedDirective: Directive<TestContext, TestData> = { goTo: "Feedback" };
        const returnedDirective: Directive<TestContext, TestData> = { dataUpdate: { name: "Bob" } };

        const tool: Tool<TestContext, TestData> = {
            id: "dual-directive-tool",
            description: "Tool using both dispatch and return",
            handler: async (ctx: ToolContext<TestContext, TestData>): Promise<ToolResult<string, TestContext, TestData>> => {
                ctx.dispatch(dispatchedDirective);
                return { data: "done", success: true, directive: returnedDirective };
            },
        };

        const result = await toolManager.executeTool({
            tool,
            context: { userId: "user-123" },
            updateContext: async () => { },
            updateData: async () => { },
            history: [],
            data: {},
        });

        expect(result.directives).toBeDefined();
        expect(result.directives).toHaveLength(2);
        // dispatch() first, then result.directive
        expect(result.directives![0]).toEqual(dispatchedDirective);
        expect(result.directives![1]).toEqual(returnedDirective);
    });

    test("multiple dispatch calls plus ToolResult.directive all in order", async () => {
        const agent = createTestAgent();
        const toolManager = new ToolManager<TestContext, TestData>(agent);

        const d1: Directive<TestContext, TestData> = { contextUpdate: { role: "admin" } };
        const d2: Directive<TestContext, TestData> = { dataUpdate: { query: "search" } };
        const d3: Directive<TestContext, TestData> = { goTo: "Support" };

        const tool: Tool<TestContext, TestData> = {
            id: "triple-tool",
            description: "Three directives",
            handler: async (ctx: ToolContext<TestContext, TestData>): Promise<ToolResult<string, TestContext, TestData>> => {
                ctx.dispatch(d1);
                ctx.dispatch(d2);
                return { data: "done", success: true, directive: d3 };
            },
        };

        const result = await toolManager.executeTool({
            tool,
            context: { userId: "user-123" },
            updateContext: async () => { },
            updateData: async () => { },
            history: [],
            data: {},
        });

        expect(result.directives).toHaveLength(3);
        expect(result.directives![0]).toEqual(d1);
        expect(result.directives![1]).toEqual(d2);
        expect(result.directives![2]).toEqual(d3);
    });
});

// ─── 8. Cycle detection: chain of 11 forced redirects throws ─────────────────

describe("Cycle detection: chain of 11 forced redirects throws with chain listed", () => {
    test("default maxDirectiveChain is 10; chain of 11 throws", () => {
        const tracker = new DirectiveChainTracker(10);

        // Record 10 directives (at the limit)
        for (let i = 0; i < 10; i++) {
            tracker.record({ goTo: `Flow${i}` }, `emitter${i}`);
        }
        expect(tracker.depth).toBe(10);

        // The 11th exceeds the limit and throws
        expect(() => {
            tracker.record({ goTo: "FlowOverflow" }, "emitter10");
        }).toThrow(FlowConfigurationError);
    });

    test("overflow error message lists the full chain in order", () => {
        const tracker = new DirectiveChainTracker(10);

        for (let i = 0; i < 10; i++) {
            tracker.record({ goTo: `Flow${i}` }, `emitter${i}`);
        }

        try {
            tracker.record({ goTo: "FlowOverflow" }, "emitter10");
            expect(true).toBe(false);
        } catch (err: any) {
            expect(err).toBeInstanceOf(FlowConfigurationError);
            const message = err.message;
            // Should contain representative chain entries
            expect(message).toContain("goTo:Flow0");
            expect(message).toContain("goTo:Flow9");
            expect(message).toContain("goTo:FlowOverflow");
            // Should mention chain/cycle
            expect(message.toLowerCase()).toContain("cycle");
        }
    });

    test("abort mid-chain is a chain breaker — does not throw even beyond the limit", () => {
        const tracker = new DirectiveChainTracker(3);

        tracker.record({ goTo: "A" }, "e1");
        tracker.record({ goTo: "B" }, "e2");
        tracker.record({ goTo: "C" }, "e3");

        // At the limit. Abort should NOT throw.
        expect(() => {
            tracker.record({ abort: "emergency" }, "e4");
        }).not.toThrow();
    });

    test("agent exposes maxDirectiveChain with default 10", () => {
        const agent = createTestAgent();
        expect(agent.maxDirectiveChain).toBe(10);
    });

    test("custom maxDirectiveChain from AgentOptions is respected", () => {
        const agent = createTestAgent({ maxDirectiveChain: 5 });
        expect(agent.maxDirectiveChain).toBe(5);
    });

    test("chain of 6 with maxDirectiveChain=5 throws", () => {
        const tracker = new DirectiveChainTracker(5);

        for (let i = 0; i < 5; i++) {
            tracker.record({ goTo: `Flow${i}` }, `e${i}`);
        }

        expect(() => {
            tracker.record({ goTo: "Overflow" }, "e5");
        }).toThrow(FlowConfigurationError);
    });
});
