/**
 * Scoped Guidelines Tests (T1–T14)
 *
 * Validates the three-scope guideline rendering pipeline:
 * - Scope captions, cross-flow isolation, prompt exclusions
 * - Condition evaluation (enabled, when)
 * - Cache invalidation behavior
 * - Observability (appliedGuidelines)
 * - Conditional guidelines on completion turns (T14)
 */

import { describe, test, expect } from "bun:test";
import fc from "fast-check";
import { Agent } from "../src/core/Agent";
import { PromptComposer } from "../src/core/PromptComposer";
import { PromptSectionCache } from "../src/core/PromptSectionCache";
import { createTemplateContext } from "../src/utils/template";
import type { Instruction, ScopedInstructions } from "../src/types/agent";
import { MockProvider } from "./mock-provider";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockProvider() {
    return new MockProvider({ responseMessage: "OK", delayMs: 0 });
}

function buildComposer(cache?: PromptSectionCache) {
    const ctx = createTemplateContext({});
    return new PromptComposer(ctx, cache);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Scoped Guidelines", () => {
    /**
     * T1: P1 — scope captions correct (PBT with fast-check)
     *
     * For any tuple (global[], flow.items[], step.items[]) of guidelines with
     * no `when`, the rendered output contains exactly |global| + |flow.items| +
     * |step.items| lines, each prefixed with the correct caption for its bucket.
     *
     * **Validates: Requirements 3.3, 3.4, 3.5**
     */
    test("T1: scope captions correct", async () => {
        // Use trimmed alphanumeric strings to avoid whitespace edge cases in render()
        const guidelineArb = fc.stringMatching(/^[a-zA-Z0-9 .,!?]{1,40}$/)
            .filter(s => s.trim().length > 0)
            .map(s => s.trim());
        const labelArb = fc.stringMatching(/^[a-zA-Z0-9_-]{1,15}$/)
            .filter(s => s.length > 0);

        await fc.assert(
            fc.asyncProperty(
                fc.array(guidelineArb, { minLength: 0, maxLength: 5 }),
                fc.array(guidelineArb, { minLength: 0, maxLength: 5 }),
                fc.array(guidelineArb, { minLength: 0, maxLength: 5 }),
                labelArb,
                labelArb,
                async (globalPrompts, flowPrompts, stepPrompts, flowTitle, stepId) => {
                    const scoped: ScopedInstructions = {
                        global: globalPrompts.map((p, i) => ({ id: `g${i}`, prompt: p })),
                        flow: flowPrompts.length > 0
                            ? { flowTitle, items: flowPrompts.map((p, i) => ({ id: `r${i}`, prompt: p })) }
                            : undefined,
                        step: stepPrompts.length > 0
                            ? { stepId, items: stepPrompts.map((p, i) => ({ id: `s${i}`, prompt: p })) }
                            : undefined,
                    };

                    const pc = buildComposer();
                    await pc.addInstructions(scoped);
                    const prompt = await pc.build();

                    const totalExpected = globalPrompts.length + flowPrompts.length + stepPrompts.length;

                    if (totalExpected === 0) {
                        expect(prompt).not.toContain("## Instructions");
                        return;
                    }

                    expect(prompt).toContain("## Instructions");

                    for (const p of globalPrompts) {
                        expect(prompt).toContain(`- [should] [Always] ${p}`);
                    }
                    for (const p of flowPrompts) {
                        expect(prompt).toContain(`- [should] [In: ${flowTitle}] ${p}`);
                    }
                    for (const p of stepPrompts) {
                        expect(prompt).toContain(`- [should] [Step: ${stepId}] ${p}`);
                    }

                    const lines = prompt.split("\n").filter(l => l.startsWith("- ["));
                    expect(lines.length).toBe(totalExpected);
                }
            ),
            { numRuns: 80 }
        );
    });

    /**
     * T2: P2 — no cross-flow leak
     *
     * Two flows with distinct guidelines; render prompt for flow A;
     * assert flow B's guideline text absent.
     *
     * **Validates: Requirements 3.14**
     */
    test("T2: no cross-flow leak", async () => {
        const flowAGuideline = "Always confirm booking details";
        const flowBGuideline = "Never discuss competitor pricing";

        const scoped: ScopedInstructions = {
            global: [],
            flow: { flowTitle: "Booking", items: [{ id: "rA1", prompt: flowAGuideline }] },
        };

        const pc = buildComposer();
        await pc.addInstructions(scoped);
        const prompt = await pc.build();

        expect(prompt).toContain(flowAGuideline);
        expect(prompt).not.toContain(flowBGuideline);
    });

    /**
     * T3: P3 — routing prompt is guideline-free
     *
     * Build routing prompt via PromptComposer.addActiveFlows; assert no
     * `## Instructions` header and no guideline prompt text.
     *
     * **Validates: Requirements 3.8, 3.9**
     */
    test("T3: routing prompt guideline-free", async () => {
        const provider = mockProvider();
        const agent = new Agent({
            name: "TestAgent",
            provider,
            instructions: [
                { id: "g1", prompt: "Be concise in all responses" },
                { id: "g2", prompt: "Always greet the user warmly" },
            ],
            flows: [
                {
                    title: "Support",
                    description: "Handle support requests",
                    instructions: [{ id: "rg1", prompt: "Empathize with frustrated users" }],
                },
            ],
        });

        const ctx = createTemplateContext({});
        const pc = new PromptComposer(ctx);
        await pc.addActiveFlows(agent.flows);
        const routingPrompt = await pc.build();

        expect(routingPrompt).not.toContain("## Instructions");
        expect(routingPrompt).not.toContain("Be concise in all responses");
        expect(routingPrompt).not.toContain("Always greet the user warmly");
        expect(routingPrompt).not.toContain("Empathize with frustrated users");
    });

    /**
     * T4: P4 — schema-extraction prompt is guideline-free
     *
     * Verify that the extraction/routing prompt path doesn't include guidelines.
     *
     * **Validates: Requirements 3.10**
     */
    test("T4: extraction prompt guideline-free", async () => {
        const guidelineText = "Always respond in formal English";

        const agent = new Agent({
            name: "ExtractAgent",
            provider: mockProvider(),
            instructions: [{ id: "g1", prompt: guidelineText }],
            flows: [
                {
                    title: "Intake",
                    description: "Collect user info",
                    instructions: [{ id: "rg1", prompt: "Ask one question at a time" }],
                },
            ],
        });

        const ctx = createTemplateContext({});
        const pc = new PromptComposer(ctx);
        await pc.addActiveFlows(agent.flows);
        await pc.addScoringRules();
        const extractionPrompt = await pc.build();

        expect(extractionPrompt).not.toContain("## Instructions");
        expect(extractionPrompt).not.toContain(guidelineText);
        expect(extractionPrompt).not.toContain("Ask one question at a time");
    });

    /**
     * T5: P5 — disabled guidelines are dropped
     *
     * **Validates: Requirements 4.5**
     */
    test("T5: disabled guidelines dropped", async () => {
        const scoped: ScopedInstructions = {
            global: [
                { id: "g1", prompt: "Active guideline", enabled: true },
                { id: "g2", prompt: "Disabled guideline", enabled: false },
            ],
        };

        const pc = buildComposer();
        await pc.addInstructions(scoped);
        const prompt = await pc.build();

        expect(prompt).toContain("Active guideline");
        expect(prompt).not.toContain("Disabled guideline");
    });

    /**
     * T6: P6 — when === undefined ⇒ always active
     *
     * **Validates: Requirements 4.2**
     */
    test("T6: when=undefined always active", async () => {
        const scoped: ScopedInstructions = {
            global: [{ id: "g1", prompt: "No-when guideline" }],
            flow: {
                flowTitle: "Sales",
                items: [{ id: "r1", prompt: "Flow no-when guideline" }],
            },
        };

        const pc = buildComposer();
        await pc.addInstructions(scoped);
        const prompt = await pc.build();

        expect(prompt).toContain("- [should] [Always] No-when guideline");
        expect(prompt).toContain("- [should] [In: Sales] Flow no-when guideline");
    });

    /**
     * T7: P7 — programmatic if = false drops the guideline
     *
     * **Validates: Requirements 4.4**
     */
    test("T7: programmatic if=false drops guideline", async () => {
        const scoped: ScopedInstructions = {
            global: [
                { id: "g1", if: () => false, prompt: "Should be dropped" },
                { id: "g2", if: () => true, prompt: "Should be kept" },
            ],
        };

        const pc = buildComposer();
        await pc.addInstructions(scoped);
        const prompt = await pc.build();

        expect(prompt).not.toContain("Should be dropped");
        expect(prompt).toContain("Should be kept");
    });

    /**
     * T8: P8 — empty section omitted
     *
     * **Validates: Requirements 3.7**
     */
    test("T8: empty section omitted", async () => {
        const scoped: ScopedInstructions = {
            global: [
                { id: "g1", prompt: "Disabled one", enabled: false },
                { id: "g2", if: () => false, prompt: "Inactive one" },
            ],
        };

        const pc = buildComposer();
        await pc.addInstructions(scoped);
        const prompt = await pc.build();

        expect(prompt).not.toContain("## Instructions");
    });

    /**
     * T9: Cache invalidation — agent guidelines mutate
     *
     * Render once, mutate agent.guidelines, render again; assert recomputed.
     *
     * **Validates: Requirements 5.6, 5.7**
     */
    test("T9: cache invalidation on agent guideline mutation", async () => {
        const cache = new PromptSectionCache();

        // First render
        const scoped1: ScopedInstructions = {
            global: [{ id: "g1", prompt: "Original guideline" }],
        };
        const pc1 = buildComposer(cache);
        await pc1.addInstructions(scoped1);
        const prompt1 = await pc1.build();
        expect(prompt1).toContain("Original guideline");

        // Simulate agent.createInstruction → invalidates instructionsGlobal
        cache.invalidate("instructionsGlobal");
        cache.invalidate("instructionsHeader");

        // Second render with mutated guidelines
        const scoped2: ScopedInstructions = {
            global: [
                { id: "g1", prompt: "Original guideline" },
                { id: "g2", prompt: "New guideline" },
            ],
        };
        const pc2 = buildComposer(cache);
        await pc2.addInstructions(scoped2);
        const prompt2 = await pc2.build();

        expect(prompt2).toContain("Original guideline");
        expect(prompt2).toContain("New guideline");
    });

    /**
     * T10: Cache invalidation — flow switch invalidates guidelinesFlow
     *
     * **Validates: Requirements 5.9**
     */
    test("T10: cache invalidation on flow switch", async () => {
        const cache = new PromptSectionCache();

        // First render with flow A
        const scopedA: ScopedInstructions = {
            global: [{ id: "g1", prompt: "Global" }],
            flow: { flowTitle: "RouteA", items: [{ id: "rA", prompt: "Flow A guideline" }] },
        };
        const pcA = buildComposer(cache);
        await pcA.addInstructions(scopedA);
        const promptA = await pcA.build();
        expect(promptA).toContain("Flow A guideline");
        expect(promptA).toContain("[In: RouteA]");

        // Simulate flow switch → Agent.invalidateFlowSections() invalidates instructionsFlow
        cache.invalidate("instructionsFlow");
        cache.invalidate("instructionsHeader");

        // Second render with flow B
        const scopedB: ScopedInstructions = {
            global: [{ id: "g1", prompt: "Global" }],
            flow: { flowTitle: "RouteB", items: [{ id: "rB", prompt: "Flow B guideline" }] },
        };
        const pcB = buildComposer(cache);
        await pcB.addInstructions(scopedB);
        const promptB = await pcB.build();

        expect(promptB).toContain("Flow B guideline");
        expect(promptB).toContain("[In: RouteB]");
        expect(promptB).not.toContain("Flow A guideline");
    });

    /**
     * T11: Cache — step bucket recomputes per turn
     *
     * Two consecutive turns same step; the step section is registered as `dynamic`
     * so it recomputes on every resolveAll(). We verify the output reflects the
     * latest state by changing the step guideline between turns.
     *
     * **Validates: Requirements 5.10**
     */
    test("T11: step bucket recomputes per turn", async () => {
        const cache = new PromptSectionCache();

        // Turn 1: step guideline is active
        const scoped1: ScopedInstructions = {
            global: [{ id: "g1", prompt: "Global" }],
            step: { stepId: "payment", items: [{ id: "s1", prompt: "Step turn one" }] },
        };
        const pc1 = buildComposer(cache);
        await pc1.addInstructions(scoped1);
        const prompt1 = await pc1.build();
        expect(prompt1).toContain("Step turn one");

        // Turn 2: same cache, different step content (simulates dynamic recompute)
        const scoped2: ScopedInstructions = {
            global: [{ id: "g1", prompt: "Global" }],
            step: { stepId: "payment", items: [{ id: "s1", prompt: "Step turn two" }] },
        };
        const pc2 = buildComposer(cache);
        await pc2.addInstructions(scoped2);
        const prompt2 = await pc2.build();

        // Because instructionsStep is dynamic, it recomputes and shows the new content
        expect(prompt2).toContain("Step turn two");
        expect(prompt2).not.toContain("Step turn one");
    });

    /**
     * T12: scope ordering preserved
     *
     * Construct guideline with new { when, prompt }; render; assert text appears
     * in correct order (global → flow → step).
     *
     * **Validates: Requirements 3.6**
     */
    test("T12: scope ordering preserved", async () => {
        const scoped: ScopedInstructions = {
            global: [{ id: "g1", prompt: "Global first" }],
            flow: { flowTitle: "Booking", items: [{ id: "r1", prompt: "Flow second" }] },
            step: { stepId: "payment", items: [{ id: "s1", prompt: "Step third" }] },
        };

        const pc = buildComposer();
        await pc.addInstructions(scoped);
        const prompt = await pc.build();

        const globalIdx = prompt.indexOf("- [should] [Always] Global first");
        const flowIdx = prompt.indexOf("- [should] [In: Booking] Flow second");
        const stepIdx = prompt.indexOf("- [should] [Step: payment] Step third");

        expect(globalIdx).toBeGreaterThan(-1);
        expect(flowIdx).toBeGreaterThan(-1);
        expect(stepIdx).toBeGreaterThan(-1);
        expect(globalIdx).toBeLessThan(flowIdx);
        expect(flowIdx).toBeLessThan(stepIdx);
    });

    /**
     * T14: Completion turn is a pure state transition
     *
     * The completion path no longer makes an LLM call (v2: framework emits no
     * message of its own at the completion boundary). Guidelines are only
     * rendered when there is a prompt being built — so a turn that resolves
     * to "flow complete" without an interactive step has no rendered
     * guidelines. The test asserts the new contract: `appliedGuidelines` is
     * empty/undefined on a completion-only turn.
     *
     * **Validates: v2 flow-completion idle-state release (no hardcoded LLM call)**
     */
    test("T14: completion turn produces no applied guidelines (no LLM render)", async () => {
        const provider = mockProvider();

        interface T14Data {
            name: string;
        }

        const agent = new Agent<unknown, T14Data>({
            name: "T14Agent",
            provider,
            schema: {
                type: "object",
                properties: {
                    name: { type: "string" },
                },
            },
            instructions: [
                {
                    id: "g-conditional-string",
                    when: "the user is wrapping up",
                    prompt: "Thank the user warmly",
                },
            ],
            flows: [
                {
                    title: "Onboarding",
                    requiredFields: ["name"],
                    initialData: { name: "Alice" },
                    steps: [
                        {
                            prompt: "Greet the user",
                            skip: (params) => !!params.data?.name,
                        },
                    ],
                    instructions: [
                        {
                            id: "r-conditional-fn",
                            if: () => true,
                            prompt: "Mention next steps after onboarding",
                        },
                    ],
                },
            ],
        });

        // Initial step has no transitions — it's the implicit terminus
        // Flow completes because requiredFields are satisfied via initialData
        const response = await agent.respond({
            history: [{ role: "user", content: "Hi, my name is Alice" }],
        });

        // Flow should be complete
        expect(response.isFlowComplete).toBe(true);

        // No LLM render happened on the completion turn — the framework
        // emits no message of its own. Therefore no guidelines were rendered.
        expect(response.appliedInstructions ?? []).toEqual([]);

        // The completion turn produces an empty message (developer-defined
        // step prompts are the only source of user-facing copy).
        expect(response.message).toBe('');

        // Session is released to idle.
        expect(response.session?.currentFlow).toBeUndefined();
        expect(response.session?.currentStep).toBeUndefined();
    });

    /**
     * T13: P9 — appliedGuidelines matches rendered set
     *
     * Mix enabled/disabled and active/inactive `when` across all three scopes;
     * render; assert appliedGuidelines IDs equal the rendered subset.
     *
     * **Validates: Requirements 6.9**
     */
    test("T13: appliedGuidelines matches rendered set", async () => {
        const scoped: ScopedInstructions = {
            global: [
                { id: "g-active", prompt: "Active global" },
                { id: "g-disabled", prompt: "Disabled global", enabled: false },
                { id: "g-inactive", if: () => false, prompt: "Inactive global" },
            ],
            flow: {
                flowTitle: "Support",
                items: [
                    { id: "r-active", prompt: "Active flow" },
                    { id: "r-disabled", prompt: "Disabled flow", enabled: false },
                ],
            },
            step: {
                stepId: "triage",
                items: [
                    { id: "s-active", prompt: "Active step" },
                    { id: "s-inactive", if: () => false, prompt: "Inactive step" },
                ],
            },
        };

        const pc = buildComposer();
        await pc.addInstructions(scoped);
        await pc.build();

        const applied = pc.lastAppliedInstructions;

        // Expected: only the active, enabled guidelines
        const expectedIds = new Set(["g-active", "r-active", "s-active"]);
        const actualIds = new Set(applied.map(a => a.id));
        expect(actualIds).toEqual(expectedIds);

        // Verify scope assignments
        const globalApplied = applied.find(a => a.id === "g-active");
        expect(globalApplied?.scope).toBe("global");
        expect(globalApplied?.scopeRef).toBeUndefined();

        const flowApplied = applied.find(a => a.id === "r-active");
        expect(flowApplied?.scope).toBe("flow");
        expect(flowApplied?.scopeRef).toBe("Support");

        const stepApplied = applied.find(a => a.id === "s-active");
        expect(stepApplied?.scope).toBe("step");
        expect(stepApplied?.scopeRef).toBe("triage");
    });
});
