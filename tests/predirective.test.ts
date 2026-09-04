/**
 * PreDirective integration tests
 *
 * Tests integration-level scenarios that span multiple components:
 * - PromptComposer: appendPrompt lands in the system prompt via the transient appendage slot, current turn only
 * - ToolManager: injectTools available this turn via the transient tool layer, gone next turn
 * - flow.merge: canonical merge of multiple pre-LLM emissions (Algorithm 4) —
 *   appendPrompt concat in outer-to-inner order, injectTools dedup by id, halt OR, reply last-wins
 * - createPersistedState strips all PreDirective fields before persistence
 *
 * **Validates: Requirements 2.1–2.12, 24.5, 24.6, 27.1–27.4**
 */
import { describe, test, expect } from "bun:test";
import { flow } from "../src/index.js";
import { PromptComposer } from "../src/core/PromptComposer.js";
import { ToolManager } from "../src/core/ToolManager.js";
import { Agent } from "../src/core/Agent.js";
import { createPersistedState } from "../src/utils/session.js";
import { createTemplateContext } from "../src/utils/template.js";
import type { Directive, SessionState, Tool } from "../src/types/index.js";
import { MockProvider } from "./mock-provider.js";

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

// ─── 1. PromptComposer: appendPrompt → per-turn transient appendage ──────────
// Validates: Requirements 2.2, 2.8, 2.11, 27.1, 27.2

describe("PreDirective integration: appendPrompt → PromptComposer", () => {
    test("appendPrompt from a prepare hook lands in the system prompt for the current turn only", async () => {
        // Simulate: prepare hook emitted { appendPrompt: [...] } — the pipeline
        // hands it to PromptComposer's transientAppendage slot (the handoff).
        const ctx = createTemplateContext({});
        const composer = new PromptComposer(ctx);
        await composer.addInstruction("Help the user with their order.");

        const promptThisTurn = await composer.build({
            transientAppendage: ["The user is a VIP. Prioritize their request."],
        });

        // The appendage should appear in the system prompt
        expect(promptThisTurn).toContain("The user is a VIP. Prioritize their request.");

        // Next turn: no appendage → the sentence is gone (the slot is per-build)
        const promptNextTurn = await composer.build();
        expect(promptNextTurn).not.toContain("The user is a VIP. Prioritize their request.");
    });

    test("appendPrompt is for current turn only — a build without an appendage carries nothing over", async () => {
        // Turn 1: prepare hook emits an appendage
        const ctx = createTemplateContext({});
        const composer = new PromptComposer(ctx);
        const prompt1 = await composer.build({ transientAppendage: ["Turn 1 context."] });
        expect(prompt1).toContain("Turn 1 context.");

        // Turn 2: no emissions → fresh build without the appendage option
        const prompt2 = await composer.build();
        expect(prompt2).not.toContain("Turn 1 context.");
    });
});

// ─── 2. ToolManager: injectTools → transient layer ───────────────────────────
// Validates: Requirements 2.3, 2.4, 2.8, 2.12, 27.3

describe("PreDirective integration: injectTools → ToolManager transient layer", () => {
    test("injectTools from a prepare hook resolves before flow/agent tools; gone next turn", () => {
        const agent = makeAgent();
        const toolManager = new ToolManager<TestContext, TestData>(agent);

        // Agent-level tool
        agent.addTool({
            id: "agent-tool",
            description: "Always available",
            handler: async () => "agent result",
        });

        // Simulate: prepare hook returned PreDirective with injectTools;
        // the pipeline feeds the array into ToolManager's transient layer.
        const injectedTool: Tool = { id: "transient-lookup", description: "Per-turn lookup", handler: async () => "transient result" };
        toolManager.setTransientTools([injectedTool]);

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
            description: "agent-version",
            handler: async () => "agent",
        });

        // Inject transient tool with same id
        const transientVersion: Tool = { id: "shared-tool", description: "transient-version", handler: async () => "transient" };
        toolManager.setTransientTools([transientVersion]);

        // Transient version wins
        const found = toolManager.find("shared-tool");
        expect(found?.description).toBe("transient-version");

        // After clear, agent version returns
        toolManager.clearTransientTools();
        const foundAfter = toolManager.find("shared-tool");
        expect(foundAfter?.description).toBe("agent-version");
    });
});

// ─── 3. Multiple emitters in one turn merge via flow.merge ───────────────────
// Validates: Requirements 2.8, 10.7, 10.8, 10.9, 27.1–27.4

describe("PreDirective integration: multiple emitters merge via flow.merge", () => {
    test("appendPrompt arrays concatenate in outer-to-inner order", async () => {
        // Outer-to-inner: agent.onEnter → flow.onEnter → step.onEnter → step.prepare,
        // folded through the canonical merge exactly as the pipeline does.
        const emissions: Directive[] = [
            { appendPrompt: ["Agent-level context."] },
            { appendPrompt: ["Flow-level context."] },
            { appendPrompt: ["Step-level context."] },
            { appendPrompt: ["Prepare-level context."] },
        ];
        const merged = emissions.reduce((a, b) => flow.merge(a, b));

        // Concatenated in emission (outer-to-inner) order
        expect(merged.appendPrompt).toEqual([
            "Agent-level context.",
            "Flow-level context.",
            "Step-level context.",
            "Prepare-level context.",
        ]);

        // PromptComposer preserves that order in the system prompt
        const composer = new PromptComposer(createTemplateContext({}));
        const prompt = await composer.build({ transientAppendage: merged.appendPrompt });

        const agentIdx = prompt.indexOf("Agent-level context.");
        const flowIdx = prompt.indexOf("Flow-level context.");
        const stepIdx = prompt.indexOf("Step-level context.");
        const prepareIdx = prompt.indexOf("Prepare-level context.");

        expect(agentIdx).toBeLessThan(flowIdx);
        expect(flowIdx).toBeLessThan(stepIdx);
        expect(stepIdx).toBeLessThan(prepareIdx);
    });

    test("injectTools concatenate then deduplicate by id with last-definition-wins", () => {
        const toolV1: Tool = { id: "lookup", description: "v1", handler: async () => "v1" };
        const toolV2: Tool = { id: "lookup", description: "v2", handler: async () => "v2" };
        const toolUnique: Tool = { id: "search", description: "search", handler: async () => "search" };

        const merged = flow.merge(
            { injectTools: [toolV1, toolUnique] } as Directive,
            { injectTools: [toolV2] } as Directive,
        );

        // Deduped: 'lookup' appears once with v2 (last-definition-wins), 'search' kept
        expect(merged.injectTools).toHaveLength(2);
        const lookupTool = merged.injectTools!.find(t => t.id === "lookup");
        expect(lookupTool?.description).toBe("v2");
        const searchTool = merged.injectTools!.find(t => t.id === "search");
        expect(searchTool?.description).toBe("search");

        // Feed into ToolManager to verify resolution
        const agent = makeAgent();
        const tm = new ToolManager<TestContext, TestData>(agent);
        tm.setTransientTools(merged.injectTools!);

        expect(tm.find("lookup")?.description).toBe("v2");
        expect(tm.find("search")?.description).toBe("search");
    });

    test("halt is logical-OR across multiple emitters", () => {
        const emissions: Directive[] = [{ halt: false }, { halt: false }, { halt: true }];
        const merged = emissions.reduce((a, b) => flow.merge(a, b));

        // Any emitter setting halt=true → merged halt is true (logical OR)
        expect(merged.halt).toBe(true);
    });

    test("halt + reply from two emitters: halt ORs to true, reply is last-wins", () => {
        const merged = flow.merge(
            { halt: false, reply: "First reply" } as Directive,
            { halt: true, reply: "Override reply" } as Directive,
        );

        // Pipeline contract: merged.halt=true + reply → the reply becomes the
        // assistant message this turn (stoppedReason 'reply').
        expect(merged.halt).toBe(true);
        expect(merged.reply).toBe("Override reply");
    });

    test("halt without reply merges alongside other fields — position survives, reply stays unset", () => {
        const emissions: Directive[] = [{ goTo: "Maintenance" }, { halt: true }];
        const merged = emissions.reduce((a, b) => flow.merge(a, b));

        // Pipeline contract: merged.halt=true + no reply → empty content with
        // stoppedReason 'halt', while other directive fields still apply.
        expect(merged.goTo).toBe("Maintenance");
        expect(merged.halt).toBe(true);
        expect(merged.reply).toBeUndefined();
    });

    test("all three PreDirective fields merge correctly across multiple emitters", () => {
        const toolA: Tool = { id: "t1", handler: async () => "a" };
        const toolB: Tool = { id: "t2", handler: async () => "b" };

        const merged = flow.merge(
            {
                appendPrompt: ["From onEnter."],
                injectTools: [toolA],
                halt: false,
            } as Directive,
            {
                appendPrompt: ["From prepare."],
                injectTools: [toolB],
                halt: true,
                reply: "Halted!",
            } as Directive,
        );

        // appendPrompt: concatenated
        expect(merged.appendPrompt).toEqual(["From onEnter.", "From prepare."]);
        // injectTools: deduped (no collision here, so both present)
        expect(merged.injectTools).toHaveLength(2);
        expect(merged.injectTools![0].id).toBe("t1");
        expect(merged.injectTools![1].id).toBe("t2");
        // halt: logical OR
        expect(merged.halt).toBe(true);
        // reply: last-wins
        expect(merged.reply).toBe("Halted!");
    });
});

// ─── 4. Persisted directive does not carry appendPrompt/injectTools/halt ─────
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
            } as unknown as SessionState<TestData>["pendingDirective"],
        });

        const persisted = createPersistedState(session);

        // Directive fields preserved
        expect(persisted.pendingDirective!.goTo).toBe("Support");
        expect(persisted.pendingDirective!.reply).toBe("Redirecting you.");
        expect(persisted.pendingDirective!.contextUpdate).toEqual({ userId: "u1" });

        // PreDirective fields stripped
        expect("appendPrompt" in persisted.pendingDirective!).toBe(false);
        expect("injectTools" in persisted.pendingDirective!).toBe(false);
        expect("halt" in persisted.pendingDirective!).toBe(false);
    });

    test("persisted directive with only PreDirective fields becomes effectively empty but retains Directive structure", () => {
        const session = makeSession({
            pendingDirective: {
                appendPrompt: ["Transient only."],
                halt: true,
            } as unknown as SessionState<TestData>["pendingDirective"],
        });

        const persisted = createPersistedState(session);

        // After stripping, the directive has no meaningful fields
        // but createPersistedState still includes it if the object is non-undefined
        if (persisted.pendingDirective) {
            expect("appendPrompt" in persisted.pendingDirective).toBe(false);
            expect("halt" in persisted.pendingDirective).toBe(false);
        }
    });

    test("session without pendingDirective: key omitted from persisted state", () => {
        const session = makeSession({ pendingDirective: undefined });

        const persisted = createPersistedState(session);

        expect("pendingDirective" in persisted).toBe(false);
    });
});
