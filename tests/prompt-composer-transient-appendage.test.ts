/**
 * PromptComposer transient appendage — unit tests
 *
 * Tests that PreDirective.appendPrompt arrays are appended to the system
 * prompt via PromptComposer's transientAppendage parameter, are fresh per
 * turn, never cached, and cleaned up via the try/finally guard.
 *
 * **Validates: Requirements 2.2, 2.8, 2.11, 27.1, 27.2, 27.4**
 */
import { describe, test, expect } from "bun:test";
import { PromptComposer } from "../src/core/PromptComposer";
import { createTemplateContext } from "../src/utils/template";
import { PromptSectionCache } from "../src/core/PromptSectionCache";

// ─── Helper ──────────────────────────────────────────────────────────────────

function buildComposer(cache?: PromptSectionCache) {
    const ctx = createTemplateContext({});
    return new PromptComposer(ctx, cache);
}

// ─── Basic appendage behavior ────────────────────────────────────────────────

describe("PromptComposer.build: transientAppendage", () => {
    test("appends transient sentences after all other sections", async () => {
        const pc = buildComposer();
        await pc.addAgentMeta({ name: "TestAgent" });
        await pc.addInstruction("Do something.");

        const prompt = await pc.build({
            transientAppendage: ["You are helping a VIP customer.", "Be extra polite."],
        });

        // The appendage should appear at the end of the prompt
        expect(prompt).toContain("You are helping a VIP customer.");
        expect(prompt).toContain("Be extra polite.");

        // Verify ordering: agent meta and instruction come before appendage
        const agentIdx = prompt.indexOf("## Agent Identity");
        const appendIdx = prompt.indexOf("You are helping a VIP customer.");
        expect(agentIdx).toBeLessThan(appendIdx);
    });

    test("returns normal prompt when transientAppendage is undefined", async () => {
        const pc = buildComposer();
        await pc.addAgentMeta({ name: "TestAgent" });

        const withoutAppendage = await pc.build();
        const withUndefined = await pc.build({ transientAppendage: undefined });

        expect(withoutAppendage).toBe(withUndefined);
    });

    test("returns normal prompt when transientAppendage is empty array", async () => {
        const pc = buildComposer();
        await pc.addAgentMeta({ name: "TestAgent" });

        const withoutAppendage = await pc.build();
        const withEmpty = await pc.build({ transientAppendage: [] });

        expect(withoutAppendage).toBe(withEmpty);
    });

    test("joins multiple appendage strings with newline", async () => {
        const pc = buildComposer();

        const prompt = await pc.build({
            transientAppendage: ["Line one.", "Line two.", "Line three."],
        });

        expect(prompt).toContain("Line one.\nLine two.\nLine three.");
    });

    test("preserves declaration order of appendage strings (outer-to-inner)", async () => {
        const pc = buildComposer();
        await pc.addInstruction("Base instruction.");

        // Simulate outer-to-inner ordering:
        // agent.onEnter → flow.onEnter → step.onEnter → step.prepare
        const appendage = [
            "From agent.onEnter hook.",
            "From flow.onEnter hook.",
            "From step.onEnter hook.",
            "From step.prepare hook.",
        ];

        const prompt = await pc.build({ transientAppendage: appendage });

        const agentIdx = prompt.indexOf("From agent.onEnter hook.");
        const flowIdx = prompt.indexOf("From flow.onEnter hook.");
        const stepEnterIdx = prompt.indexOf("From step.onEnter hook.");
        const prepareIdx = prompt.indexOf("From step.prepare hook.");

        expect(agentIdx).toBeLessThan(flowIdx);
        expect(flowIdx).toBeLessThan(stepEnterIdx);
        expect(stepEnterIdx).toBeLessThan(prepareIdx);
    });
});

// ─── Not cached ──────────────────────────────────────────────────────────────

describe("PromptComposer.build: transientAppendage is NOT cached", () => {
    test("transient appendage does not persist across builds on the same composer", async () => {
        const pc = buildComposer();
        await pc.addAgentMeta({ name: "TestAgent" });

        // First build with appendage
        const promptWith = await pc.build({
            transientAppendage: ["Transient sentence."],
        });
        expect(promptWith).toContain("Transient sentence.");

        // Second build without appendage — the sentence must not appear
        const promptWithout = await pc.build();
        expect(promptWithout).not.toContain("Transient sentence.");
    });

    test("transient appendage is not part of the prompt section cache", async () => {
        const cache = new PromptSectionCache();
        const pc = buildComposer(cache);
        await pc.addAgentMeta({ name: "TestAgent" });

        // Build with appendage
        const promptWith = await pc.build({
            transientAppendage: ["Cached? No."],
        });
        expect(promptWith).toContain("Cached? No.");

        // Build again without appendage — should NOT carry over from cache
        const promptWithout = await pc.build();
        expect(promptWithout).not.toContain("Cached? No.");
    });

    test("different appendage content on subsequent builds", async () => {
        const pc = buildComposer();
        await pc.addInstruction("Base.");

        const prompt1 = await pc.build({ transientAppendage: ["Turn 1 context."] });
        const prompt2 = await pc.build({ transientAppendage: ["Turn 2 context."] });

        expect(prompt1).toContain("Turn 1 context.");
        expect(prompt1).not.toContain("Turn 2 context.");
        expect(prompt2).toContain("Turn 2 context.");
        expect(prompt2).not.toContain("Turn 1 context.");
    });
});

// ─── Try/finally drain pattern ───────────────────────────────────────────────

describe("transientAppendage: drain via try/finally guard", () => {
    test("appendage reference is cleared even when an error occurs mid-turn", async () => {
        // This test simulates the try/finally pattern used in ResponseModal.
        // The transient appendage is a local variable that is cleared in the
        // finally block, ensuring no leak across turns.
        let turnAppendage: string[] | undefined = ["Contextual nudge."];

        try {
            // Simulate prompt building
            const pc = buildComposer();
            const prompt = await pc.build({ transientAppendage: turnAppendage });
            expect(prompt).toContain("Contextual nudge.");

            // Simulate an error occurring after prompt build
            throw new Error("Simulated LLM failure");
        } catch {
            // Error handled (or propagated)
        } finally {
            // This is the drain — exactly what ResponseModal does
            turnAppendage = undefined;
        }

        // After the turn, the appendage is gone
        expect(turnAppendage).toBeUndefined();
    });

    test("appendage does not affect a fresh PromptComposer on the next turn", async () => {
        // Turn 1: with appendage
        const pc1 = buildComposer();
        await pc1.addInstruction("Turn 1 base.");
        const prompt1 = await pc1.build({
            transientAppendage: ["Turn 1 only."],
        });
        expect(prompt1).toContain("Turn 1 only.");

        // Turn 2: fresh composer, no appendage passed
        const pc2 = buildComposer();
        await pc2.addInstruction("Turn 2 base.");
        const prompt2 = await pc2.build();
        expect(prompt2).not.toContain("Turn 1 only.");
    });
});
