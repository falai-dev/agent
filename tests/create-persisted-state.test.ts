/**
 * Tests for createPersistedState — the shared persistence helper that strips
 * PreDirective-only fields (appendPrompt, injectTools, halt) from
 * session.pendingDirective before serialization.
 *
 * Validates: Requirements 2.9, 12.6, 24.5
 */
import { expect, test, describe } from "bun:test";
import { createPersistedState } from "../src/utils/session";
import type { SessionState } from "../src/types/session";
import type { Directive } from "../src/types/flow";

describe("createPersistedState", () => {
    const baseSession: SessionState<{ name?: string }> = {
        id: "session_test_1",
        data: { name: "Alice" },
        flowHistory: [{ flowId: "greet", enteredAt: new Date(), completed: false }],
        currentFlow: { id: "greet", title: "Greeting" },
        currentStep: { id: "ask_name", description: "Ask the user their name" },
        history: [],
        metadata: { createdAt: new Date(), lastUpdatedAt: new Date() },
    };

    test("passes through a session without pendingDirective unchanged (key omitted)", () => {
        const result = createPersistedState(baseSession);

        expect(result.id).toBe("session_test_1");
        expect(result.data).toEqual({ name: "Alice" });
        expect(result.currentFlow).toEqual(baseSession.currentFlow);
        expect(result.currentStep).toEqual(baseSession.currentStep);
        // pendingDirective key should NOT be present
        expect("pendingDirective" in result).toBe(false);
    });

    test("preserves a clean Directive on pendingDirective (no PreDirective fields)", () => {
        const directive: Directive<unknown, { name?: string }> = {
            goTo: "Feedback",
            reply: "Transferring you now.",
            dataUpdate: { name: "Bob" },
        };
        const session: SessionState<{ name?: string }> = {
            ...baseSession,
            pendingDirective: directive,
        };

        const result = createPersistedState(session);

        expect(result.pendingDirective).toEqual(directive);
        expect(result.pendingDirective!.goTo).toBe("Feedback");
        expect(result.pendingDirective!.reply).toBe("Transferring you now.");
        expect(result.pendingDirective!.dataUpdate).toEqual({ name: "Bob" });
    });

    test("strips appendPrompt from pendingDirective", () => {
        const session: SessionState<{ name?: string }> = {
            ...baseSession,
            pendingDirective: {
                goTo: "Support",
                appendPrompt: ["Be extra polite this turn."],
            } as any,
        };

        const result = createPersistedState(session);

        expect(result.pendingDirective).toEqual({ goTo: "Support" });
        expect("appendPrompt" in (result.pendingDirective as any)).toBe(false);
    });

    test("strips injectTools from pendingDirective", () => {
        const fakeTool = { id: "lookup", description: "Lookup", parameters: {}, handler: () => ({}) };
        const session: SessionState<{ name?: string }> = {
            ...baseSession,
            pendingDirective: {
                goToStep: "verify",
                injectTools: [fakeTool],
            } as any,
        };

        const result = createPersistedState(session);

        expect(result.pendingDirective).toEqual({ goToStep: "verify" });
        expect("injectTools" in (result.pendingDirective as any)).toBe(false);
    });

    test("strips halt from pendingDirective", () => {
        const session: SessionState<{ name?: string }> = {
            ...baseSession,
            pendingDirective: {
                reply: "We are down.",
                halt: true,
            } as any,
        };

        const result = createPersistedState(session);

        expect(result.pendingDirective).toEqual({ reply: "We are down." });
        expect("halt" in (result.pendingDirective as any)).toBe(false);
    });

    test("strips all three PreDirective-only fields simultaneously", () => {
        const fakeTool = { id: "t1", description: "Tool", parameters: {}, handler: () => ({}) };
        const session: SessionState<{ name?: string }> = {
            ...baseSession,
            pendingDirective: {
                goTo: "Billing",
                contextUpdate: { tier: "premium" },
                appendPrompt: ["Focus on billing."],
                injectTools: [fakeTool],
                halt: true,
            } as any,
        };

        const result = createPersistedState(session);

        expect(result.pendingDirective).toEqual({
            goTo: "Billing",
            contextUpdate: { tier: "premium" },
        });
        expect("appendPrompt" in (result.pendingDirective as any)).toBe(false);
        expect("injectTools" in (result.pendingDirective as any)).toBe(false);
        expect("halt" in (result.pendingDirective as any)).toBe(false);
    });

    test("strips halt: false (any defined value of halt is removed)", () => {
        const session: SessionState<{ name?: string }> = {
            ...baseSession,
            pendingDirective: {
                goTo: "Help",
                halt: false,
            } as any,
        };

        const result = createPersistedState(session);

        expect(result.pendingDirective).toEqual({ goTo: "Help" });
        expect("halt" in (result.pendingDirective as any)).toBe(false);
    });

    test("omits pendingDirective key when directive is undefined", () => {
        const session: SessionState<{ name?: string }> = {
            ...baseSession,
            pendingDirective: undefined,
        };

        const result = createPersistedState(session);

        expect("pendingDirective" in result).toBe(false);
    });

    test("does not mutate the original session", () => {
        const directive = {
            goTo: "X",
            appendPrompt: ["extra"],
            halt: true,
        } as any;
        const session: SessionState<{ name?: string }> = {
            ...baseSession,
            pendingDirective: directive,
        };

        createPersistedState(session);

        // Original should still have the PreDirective fields
        expect((session.pendingDirective as any).appendPrompt).toEqual(["extra"]);
        expect((session.pendingDirective as any).halt).toBe(true);
    });
});
