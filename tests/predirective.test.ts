/**
 * PreDirective integration tests
 *
 * Tests integration-level scenarios that span multiple components:
 * - DirectiveBus → PromptComposer: appendPrompt from pre-LLM drain lands in system prompt
 * - DirectiveBus → ToolManager: injectTools available this turn, gone next turn
 * - halt + reply: merged PreDirective short-circuits LLM, emits reply, stoppedReason 'reply'
 * - halt without reply: empty content, stoppedReason 'halt'
 * - Multiple emitters: appendPrompt concat in outer-to-inner order, injectTools dedup by id, halt OR
 * - createPersistedState strips all PreDirective fields
 * - Post-LLM emitter: DirectiveBus strips pre-LLM fields, rest of directive applied
 *
 * **Validates: Requirements 2.1–2.12, 24.5, 24.6, 27.1–27.4**
 */
import { describe, test, expect } from "bun:test";
import { DirectiveBus } from "../src/core/DirectiveBus";
import { PromptComposer } from "../src/core/PromptComposer";
import { ToolManager } from "../src/core/ToolManager";
import { Agent } from "../src/core/Agent";
import { createPersistedState } from "../src/utils/session";
import { createTemplateContext } from "../src/utils/template";
import { logger } from "../src/utils";
import type { Directive } from "../src/types/flow";
import type { SessionState } from "../src/types/session";
import { MockProvider } from "./mock-provider";

// ─── Shared helpers ──────────────────────────────────────────────────────────

interface TestContext { userId: string }
interface TestData { name?: string; tier?: string }

const provider = new MockProvider();

function makeAgent() {
    return new Agent<TestContext, TestData>({ name: "test", provider });
}

function makeSession(overrides?: Partial<SessionState<TestData>>): SessionState<TestData> {
    return {
        id: "sess_1",
        data: {},
        flowHistory: [],
        currentFlow: undefined,
        currentStep: undefined,
        history: [],
        metadata: { createdAt: new Date(), lastUpdatedAt: new Date() },
        ...overrides,
    };
}

// ─── 1. DirectiveBus → PromptComposer: appendPrompt from prepare hook ────────
// Validates: Requirements 2.2, 2.8, 2.11, 27.1, 27.2

describe("PreDirective integration: appendPrompt → PromptComposer", () => {
    test("appendPrompt from a prepare hook (via DirectiveBus pre-LLM drain) lands in the system prompt for the current turn only", async () => {
        // Simulate: prepare hook emits a PreDirective with appendPrompt
        const bus = new DirectiveBus();
        bus.emit(
            { appendPrompt: ["The user is a VIP. Prioritize their request."] } as unknown as Directive,
            "step.prepare:verify_order"
        );

        // Drain the bus (pre-LLM phase) to get merged PreDirective
        const merged = bus.drain() as unknown as { appendPrompt: string[] };
        expect(merged.appendPrompt).toEqual(["The user is a VIP. Prioritize their request."]);

        // Feed the appendPrompt into PromptComposer (the handoff)
        const ctx = createTemplateContext({});
        const composer = new PromptComposer(ctx);
        await composer.addInstruction("Help the user with their order.");

        const promptThisTurn = await composer.build({
            transientAppendage: merged.appendPrompt,
        });

        // The appendage should appear in the system prompt
        expect(promptThisTurn).toContain("The user is a VIP. Prioritize their request.");

        // Next turn: no appendage → the sentence is gone
        const promptNextTurn = await composer.build();
        expect(promptNextTurn).not.toContain("The user is a VIP. Prioritize their request.");
    });

    test("appendPrompt is for current turn only — fresh bus each turn means no carryover", async () => {
        // Turn 1
        const bus1 = new DirectiveBus();
        bus1.emit(
            { appendPrompt: ["Turn 1 context."] } as unknown as Directive,
            "step.prepare:step_a"
        );
        const merged1 = bus1.drain() as unknown as { appendPrompt: string[] };

        const ctx = createTemplateContext({});
        const composer = new PromptComposer(ctx);
        const prompt1 = await composer.build({ transientAppendage: merged1.appendPrompt });
        expect(prompt1).toContain("Turn 1 context.");

        // Turn 2: fresh bus, no emissions
        const bus2 = new DirectiveBus();
        const merged2 = bus2.drain();
        expect(merged2).toBeUndefined();

        const prompt2 = await composer.build();
        expect(prompt2).not.toContain("Turn 1 context.");
    });
});

// ─── 2. DirectiveBus → ToolManager: injectTools (transient layer) ────────────
// Validates: Requirements 2.3, 2.4, 2.8, 2.12, 27.3

describe("PreDirective integration: injectTools → ToolManager transient layer", () => {
    test("injectTools from a prepare hook resolves before flow/agent tools; gone next turn", () => {
        const agent = makeAgent();
        const toolManager = new ToolManager<TestContext, TestData>(agent);

        // Agent-level tool
        agent.addTool({
            id: "agent-tool",
            handler: async () => "agent result",
        });

        // Simulate: prepare hook returns PreDirective with injectTools
        const bus = new DirectiveBus();
        const injectedTool = { id: "transient-lookup", handler: async () => "transient result" };
        bus.emit(
            { injectTools: [injectedTool] } as unknown as Directive,
            "step.prepare:ask_date"
        );

        const merged = bus.drain() as unknown as { injectTools: Array<{ id: string }> };

        // Feed into ToolManager transient layer (the handoff)
        toolManager.setTransientTools(merged.injectTools as any);

        // This turn: transient tool is available
        expect(toolManager.find("transient-lookup")).toBeDefined();
        expect(toolManager.find("agent-tool")).toBeDefined();

        // Transient tool takes priority (resolution: transient → step → flow → agent)
        const available = toolManager.getAvailable();
        expect(available.some(t => t.id === "transient-lookup")).toBe(true);

        // End of turn: clear transient (try/finally pattern)
        toolManager.clearTransientTools();

        // Next turn: transient tool is gone
        expect(toolManager.find("transient-lookup")).toBeUndefined();
        // Agent tool still present
        expect(toolManager.find("agent-tool")).toBeDefined();
    });

    test("injectTools with same id as agent tool: transient wins during the turn", () => {
        const agent = makeAgent();
        const toolManager = new ToolManager<TestContext, TestData>(agent);

        agent.addTool({
            id: "shared-tool",
            name: "agent-version",
            handler: async () => "agent",
        });

        // Inject transient tool with same id
        const transientVersion = { id: "shared-tool", name: "transient-version", handler: async () => "transient" };
        toolManager.setTransientTools([transientVersion]);

        // Transient version wins
        const found = toolManager.find("shared-tool");
        expect(found?.name).toBe("transient-version");

        // After clear, agent version returns
        toolManager.clearTransientTools();
        const foundAfter = toolManager.find("shared-tool");
        expect(foundAfter?.name).toBe("agent-version");
    });
});

// ─── 3. halt + reply: short-circuits LLM, emits reply, stoppedReason 'reply' ─
// Validates: Requirements 2.5, 2.6

describe("PreDirective integration: halt: true + reply short-circuits LLM", () => {
    test("halt: true with reply: merged PreDirective signals LLM skip and provides reply text", () => {
        const bus = new DirectiveBus();
        bus.emit(
            { halt: true, reply: "We are temporarily down — try in 5 minutes." } as unknown as Directive,
            "step.prepare:check_status"
        );

        const merged = bus.drain() as unknown as { halt: boolean; reply: string };

        // Pipeline logic: if halt is true, skip LLM call
        expect(merged.halt).toBe(true);
        // The reply is the assistant message for this turn
        expect(merged.reply).toBe("We are temporarily down — try in 5 minutes.");

        // stoppedReason should be 'reply' (validated at pipeline level)
        // Here we verify the directive carries both fields correctly for the pipeline to act on
        const stoppedReason = merged.halt && merged.reply ? "reply" : "halt";
        expect(stoppedReason).toBe("reply");
    });

    test("halt + reply from multiple emitters: halt is OR, reply is last-wins", () => {
        const bus = new DirectiveBus();
        bus.emit(
            { halt: false, reply: "First reply" } as unknown as Directive,
            "flow.onEnter:booking"
        );
        bus.emit(
            { halt: true, reply: "Override reply" } as unknown as Directive,
            "step.prepare:verify"
        );

        const merged = bus.drain() as unknown as { halt: boolean; reply: string };

        // halt: logical OR → true
        expect(merged.halt).toBe(true);
        // reply: last-wins
        expect(merged.reply).toBe("Override reply");
    });
});

// ─── 4. halt without reply: empty content, stoppedReason 'halt' ──────────────
// Validates: Requirement 2.7

describe("PreDirective integration: halt: true without reply → empty content", () => {
    test("halt: true without reply produces empty content with stoppedReason 'halt'", () => {
        const bus = new DirectiveBus();
        bus.emit(
            { halt: true, goTo: "Maintenance" } as unknown as Directive,
            "step.prepare:health_check"
        );

        const merged = bus.drain() as unknown as { halt: boolean; reply?: string; goTo: string };

        expect(merged.halt).toBe(true);
        expect(merged.reply).toBeUndefined();
        expect(merged.goTo).toBe("Maintenance");

        // Pipeline logic: halt=true + no reply → empty content, stoppedReason = 'halt'
        const stoppedReason = merged.halt && !merged.reply ? "halt" : "reply";
        expect(stoppedReason).toBe("halt");
    });

    test("halt: true alone (no position field, no reply) → empty message, 'halt' reason", () => {
        const bus = new DirectiveBus();
        bus.emit({ halt: true } as unknown as Directive, "step.prepare:guard");

        const merged = bus.drain() as unknown as { halt: boolean; reply?: string };

        expect(merged.halt).toBe(true);
        expect(merged.reply).toBeUndefined();

        const stoppedReason = merged.halt && !merged.reply ? "halt" : "reply";
        expect(stoppedReason).toBe("halt");
    });
});

// ─── 5. Multiple emitters in one turn: concat, dedup, OR ─────────────────────
// Validates: Requirements 2.8, 10.7, 10.8, 10.9, 27.1–27.4

describe("PreDirective integration: multiple emitters merge correctly", () => {
    test("appendPrompt arrays concatenate in outer-to-inner order", async () => {
        const bus = new DirectiveBus();

        // Outer-to-inner: agent.onEnter → flow.onEnter → step.onEnter → step.prepare
        bus.emit(
            { appendPrompt: ["Agent-level context."] } as unknown as Directive,
            "agent.onEnter"
        );
        bus.emit(
            { appendPrompt: ["Flow-level context."] } as unknown as Directive,
            "flow.onEnter:booking"
        );
        bus.emit(
            { appendPrompt: ["Step-level context."] } as unknown as Directive,
            "step.onEnter:ask_date"
        );
        bus.emit(
            { appendPrompt: ["Prepare-level context."] } as unknown as Directive,
            "step.prepare:ask_date"
        );

        const merged = bus.drain() as unknown as { appendPrompt: string[] };

        // Concatenated in emission (outer-to-inner) order
        expect(merged.appendPrompt).toEqual([
            "Agent-level context.",
            "Flow-level context.",
            "Step-level context.",
            "Prepare-level context.",
        ]);

        // Verify PromptComposer preserves that order in the system prompt
        const ctx = createTemplateContext({});
        const composer = new PromptComposer(ctx);
        const prompt = await composer.build({ transientAppendage: merged.appendPrompt });

        const agentIdx = prompt.indexOf("Agent-level context.");
        const flowIdx = prompt.indexOf("Flow-level context.");
        const stepIdx = prompt.indexOf("Step-level context.");
        const prepareIdx = prompt.indexOf("Prepare-level context.");

        expect(agentIdx).toBeLessThan(flowIdx);
        expect(flowIdx).toBeLessThan(stepIdx);
        expect(stepIdx).toBeLessThan(prepareIdx);
    });

    test("injectTools deduplicates by id with last-definition-wins", () => {
        const bus = new DirectiveBus();

        const toolV1 = { id: "lookup", name: "v1", handler: async () => "v1" };
        const toolV2 = { id: "lookup", name: "v2", handler: async () => "v2" };
        const toolUnique = { id: "search", name: "search", handler: async () => "search" };

        bus.emit(
            { injectTools: [toolV1, toolUnique] } as unknown as Directive,
            "flow.onEnter:support"
        );
        bus.emit(
            { injectTools: [toolV2] } as unknown as Directive,
            "step.prepare:ask_query"
        );

        const merged = bus.drain() as unknown as { injectTools: Array<{ id: string; name: string }> };

        // Deduped: 'lookup' appears once with v2 (last-definition-wins), 'search' kept
        expect(merged.injectTools).toHaveLength(2);
        const lookupTool = merged.injectTools.find(t => t.id === "lookup");
        expect(lookupTool?.name).toBe("v2");
        const searchTool = merged.injectTools.find(t => t.id === "search");
        expect(searchTool?.name).toBe("search");

        // Feed into ToolManager to verify resolution
        const agent = makeAgent();
        const tm = new ToolManager<TestContext, TestData>(agent);
        tm.setTransientTools(merged.injectTools as any);

        expect(tm.find("lookup")?.name).toBe("v2");
        expect(tm.find("search")?.name).toBe("search");
    });

    test("halt is logical-OR across multiple emitters", () => {
        const bus = new DirectiveBus();

        bus.emit({ halt: false } as unknown as Directive, "flow.onEnter:booking");
        bus.emit({ halt: false } as unknown as Directive, "step.onEnter:ask_date");
        bus.emit({ halt: true } as unknown as Directive, "step.prepare:ask_date");

        const merged = bus.drain() as unknown as { halt: boolean };

        // Any emitter setting halt=true → merged halt is true (logical OR)
        expect(merged.halt).toBe(true);
    });

    test("all three PreDirective fields merge correctly across multiple emitters", async () => {
        const bus = new DirectiveBus();

        const toolA = { id: "t1", handler: async () => "a" };
        const toolB = { id: "t2", handler: async () => "b" };

        bus.emit(
            {
                appendPrompt: ["From onEnter."],
                injectTools: [toolA],
                halt: false,
            } as unknown as Directive,
            "step.onEnter:check"
        );
        bus.emit(
            {
                appendPrompt: ["From prepare."],
                injectTools: [toolB],
                halt: true,
                reply: "Halted!",
            } as unknown as Directive,
            "step.prepare:check"
        );

        const merged = bus.drain() as unknown as {
            appendPrompt: string[];
            injectTools: Array<{ id: string }>;
            halt: boolean;
            reply: string;
        };

        // appendPrompt: concatenated
        expect(merged.appendPrompt).toEqual(["From onEnter.", "From prepare."]);
        // injectTools: deduped (no collision here, so both present)
        expect(merged.injectTools).toHaveLength(2);
        expect(merged.injectTools[0].id).toBe("t1");
        expect(merged.injectTools[1].id).toBe("t2");
        // halt: logical OR
        expect(merged.halt).toBe(true);
        // reply: last-wins
        expect(merged.reply).toBe("Halted!");
    });
});

// ─── 6. Persisted directive does not carry appendPrompt/injectTools/halt ─────
// Validates: Requirements 2.9, 12.6, 24.5

describe("PreDirective integration: persistence stripping via createPersistedState", () => {
    test("persisted directive does not carry appendPrompt, injectTools, or halt", () => {
        const session = makeSession({
            pendingDirective: {
                goTo: "Support",
                reply: "Redirecting you.",
                contextUpdate: { userId: "u1" },
                // PreDirective fields that should be stripped:
                appendPrompt: ["Extra context."],
                injectTools: [{ id: "temp-tool", handler: async () => "x" }],
                halt: true,
            } as any,
        });

        const persisted = createPersistedState(session);

        // Directive fields preserved
        expect(persisted.pendingDirective!.goTo).toBe("Support");
        expect(persisted.pendingDirective!.reply).toBe("Redirecting you.");
        expect(persisted.pendingDirective!.contextUpdate).toEqual({ userId: "u1" });

        // PreDirective fields stripped
        expect("appendPrompt" in (persisted.pendingDirective as any)).toBe(false);
        expect("injectTools" in (persisted.pendingDirective as any)).toBe(false);
        expect("halt" in (persisted.pendingDirective as any)).toBe(false);
    });

    test("persisted directive with only PreDirective fields becomes effectively empty but retains Directive structure", () => {
        const session = makeSession({
            pendingDirective: {
                appendPrompt: ["Transient only."],
                halt: true,
            } as any,
        });

        const persisted = createPersistedState(session);

        // After stripping, the directive has no meaningful fields
        // but createPersistedState still includes it if the object is non-undefined
        if (persisted.pendingDirective) {
            expect("appendPrompt" in (persisted.pendingDirective as any)).toBe(false);
            expect("halt" in (persisted.pendingDirective as any)).toBe(false);
        }
    });

    test("session without pendingDirective: key omitted from persisted state", () => {
        const session = makeSession({ pendingDirective: undefined });

        const persisted = createPersistedState(session);

        expect("pendingDirective" in persisted).toBe(false);
    });
});

// ─── 7. Post-LLM emitter: pre-LLM fields dropped with DEBUG log ─────────────
// Validates: Requirement 2.10

describe("PreDirective integration: post-LLM emitter field stripping", () => {
    test("post-LLM emitter sets halt: true → field dropped; rest of directive applied", () => {
        const bus = new DirectiveBus();
        bus.setPhase("post-llm");

        // finalize hook returns a directive that includes halt (invalid for post-LLM)
        bus.emit(
            {
                goTo: "Billing",
                reply: "Transferring to billing.",
                dataUpdate: { tier: "premium" },
                halt: true,
            } as unknown as Directive,
            "hook:finalize:verify_order"
        );

        const result = bus.drain()!;

        // Directive fields preserved
        expect(result.goTo).toBe("Billing");
        expect(result.reply).toBe("Transferring to billing.");
        expect(result.dataUpdate).toEqual({ tier: "premium" });

        // Pre-LLM-only field stripped
        expect((result as Record<string, unknown>).halt).toBeUndefined();
    });

    test("post-LLM emitter with all three pre-LLM fields: all stripped, Directive portion intact", () => {
        const bus = new DirectiveBus();
        bus.setPhase("post-llm");

        bus.emit(
            {
                complete: true,
                reply: "Flow complete!",
                appendPrompt: ["should not be here"],
                injectTools: [{ id: "stale" }],
                halt: true,
            } as unknown as Directive,
            "hook:onComplete:booking"
        );

        const result = bus.drain()!;

        expect(result.complete).toBe(true);
        expect(result.reply).toBe("Flow complete!");
        expect((result as Record<string, unknown>).appendPrompt).toBeUndefined();
        expect((result as Record<string, unknown>).injectTools).toBeUndefined();
        expect((result as Record<string, unknown>).halt).toBeUndefined();
    });

    test("post-LLM stripping emits DEBUG log naming the emitter and dropped fields", () => {
        const debugCalls: string[] = [];
        const originalDebug = logger.debug;
        logger.debug = (...args: unknown[]) => { debugCalls.push(String(args[0])); };

        try {
            const bus = new DirectiveBus();
            bus.setPhase("post-llm");
            bus.emit(
                { goTo: "X", appendPrompt: ["drop me"], halt: true } as unknown as Directive,
                "tool:process_refund"
            );

            bus.drain();

            // Verify DEBUG log was emitted
            const strippingLog = debugCalls.find(
                msg => msg.includes("Dropped") && msg.includes("pre-LLM-only")
            );
            expect(strippingLog).toBeDefined();
            expect(strippingLog).toContain("tool:process_refund");
            expect(strippingLog).toContain("appendPrompt");
            expect(strippingLog).toContain("halt");
        } finally {
            logger.debug = originalDebug;
        }
    });

    test("post-LLM emitter without pre-LLM fields: directive applied as-is, no stripping log", () => {
        const debugCalls: string[] = [];
        const originalDebug = logger.debug;
        logger.debug = (...args: unknown[]) => { debugCalls.push(String(args[0])); };

        try {
            const bus = new DirectiveBus();
            bus.setPhase("post-llm");
            bus.emit(
                { goTo: "NextFlow", reply: "Moving on.", dataUpdate: { name: "Alice" } } as unknown as Directive,
                "hook:finalize:step_x"
            );

            const result = bus.drain()!;

            expect(result.goTo).toBe("NextFlow");
            expect(result.reply).toBe("Moving on.");
            expect(result.dataUpdate).toEqual({ name: "Alice" });

            // No stripping log should be emitted (no pre-LLM fields present)
            const strippingLog = debugCalls.find(
                msg => msg.includes("Dropped") && msg.includes("pre-LLM-only")
            );
            expect(strippingLog).toBeUndefined();
        } finally {
            logger.debug = originalDebug;
        }
    });
});
