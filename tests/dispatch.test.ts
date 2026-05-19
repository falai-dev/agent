/**
 * Tests for Agent.dispatch and Agent.applyDirective
 *
 * Validates: Requirements 9.1–9.9
 *
 * 9.1: Agent SHALL expose dispatch(target: string | Directive, session?)
 * 9.2: String form desugars to { goTo: target }
 * 9.3: Returns session with pendingDirective set, not yet applied
 * 9.4: Without session arg, updates current session in place
 * 9.5: Strip PreDirective-only fields before storing
 * 9.6: Unknown flow throws FlowConfigurationError listing valid flows
 * 9.7: Invalid directive (fails validation) throws FlowConfigurationError
 * 9.8: Agent SHALL expose applyDirective(directive, session): SessionState
 * 9.9: Agent SHALL NOT expose nextStepFlow or transitionTo
 */

import { describe, test, expect } from "bun:test";
import { Agent, FlowConfigurationError, createSession } from "../src/index";
import type { SessionState, Directive } from "../src/types";
import { MockProvider } from "./mock-provider";

// Test types
interface TestContext {
    userId: string;
}

interface TestData {
    name?: string;
    email?: string;
    query?: string;
}

function createTestAgent() {
    const provider = new MockProvider({ responseMessage: "OK" });
    const agent = new Agent<TestContext, TestData>({
        name: "DispatchTestAgent",
        description: "Agent for testing dispatch/applyDirective",
        goal: "Test directive dispatch",
        context: { userId: "test-user" },
        provider,
        flows: [
            {
                title: "Booking",
                when: "user wants to book",
                steps: [{ prompt: "What would you like to book?" }],
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
        ],
    });
    return agent;
}

describe("Agent.dispatch", () => {
    test("9.1: dispatch method exists with correct signature", () => {
        const agent = createTestAgent();
        expect(typeof agent.dispatch).toBe("function");
    });

    test("9.2: string form desugars to { goTo: target }", async () => {
        const agent = createTestAgent();
        const session = createSession<TestData>({ data: {} });

        const result = await agent.dispatch("Booking", session);

        expect(result.pendingDirective).toBeDefined();
        expect(result.pendingDirective!.goTo).toBe("Booking");
    });

    test("9.3: returns session with pendingDirective set, not yet applied", async () => {
        const agent = createTestAgent();
        const session = createSession<TestData>({ data: {} });

        const result = await agent.dispatch("Feedback", session);

        // pendingDirective is set
        expect(result.pendingDirective).toBeDefined();
        expect(result.pendingDirective!.goTo).toBe("Feedback");

        // NOT applied yet — currentFlow should not be set to Feedback
        expect(result.currentFlow?.title).not.toBe("Feedback");
    });

    test("9.4: without session arg, updates current session in place", async () => {
        const agent = createTestAgent();
        const session = createSession<TestData>({ data: {} });
        agent.currentSession = session;

        await agent.dispatch("Booking");

        // Current session should be updated in place
        expect(agent.currentSession!.pendingDirective).toBeDefined();
        expect(agent.currentSession!.pendingDirective!.goTo).toBe("Booking");
    });

    test("9.4: throws when no session provided and no current session", async () => {
        const agent = createTestAgent();
        // No current session set

        await expect(agent.dispatch("Booking")).rejects.toThrow(
            "No session provided and no current session available"
        );
    });

    test("9.5: strips appendPrompt, injectTools, halt before storing", async () => {
        const agent = createTestAgent();
        const session = createSession<TestData>({ data: {} });

        // Pass a directive with PreDirective-only fields
        const directiveWithPreFields = {
            goTo: "Booking",
            reply: "Transferring you now.",
            appendPrompt: ["Be extra polite"],
            injectTools: [{ id: "test-tool", handler: async () => ({ data: {} }) }],
            halt: true,
        } as unknown as Directive<TestContext, TestData>;

        const result = await agent.dispatch(directiveWithPreFields, session);

        // PreDirective-only fields should be stripped
        const pending = result.pendingDirective as any;
        expect(pending.appendPrompt).toBeUndefined();
        expect(pending.injectTools).toBeUndefined();
        expect(pending.halt).toBeUndefined();

        // Directive fields should remain
        expect(pending.goTo).toBe("Booking");
        expect(pending.reply).toBe("Transferring you now.");
    });

    test("9.6: unknown flow throws FlowConfigurationError listing valid flows", async () => {
        const agent = createTestAgent();
        const session = createSession<TestData>({ data: {} });

        try {
            await agent.dispatch("NonExistentFlow", session);
            expect(true).toBe(false); // Should not reach here
        } catch (err: any) {
            expect(err).toBeInstanceOf(FlowConfigurationError);
            expect(err.message).toContain("NonExistentFlow");
            expect(err.message).toContain("Booking");
            expect(err.message).toContain("Feedback");
            expect(err.message).toContain("Support");
        }
    });

    test("9.6: unknown flow in goTo object throws FlowConfigurationError", async () => {
        const agent = createTestAgent();
        const session = createSession<TestData>({ data: {} });

        try {
            await agent.dispatch({ goTo: { flow: "UnknownFlow" } }, session);
            expect(true).toBe(false);
        } catch (err: any) {
            expect(err).toBeInstanceOf(FlowConfigurationError);
            expect(err.message).toContain("UnknownFlow");
        }
    });

    test("9.7: invalid directive (multiple position fields) throws FlowConfigurationError", async () => {
        const agent = createTestAgent();
        const session = createSession<TestData>({ data: {} });

        try {
            await agent.dispatch(
                { goTo: "Booking", complete: true } as Directive<TestContext, TestData>,
                session
            );
            expect(true).toBe(false);
        } catch (err: any) {
            expect(err).toBeInstanceOf(FlowConfigurationError);
            expect(err.message).toContain("goTo");
            expect(err.message).toContain("complete");
        }
    });

    test("9.7: empty goTo object throws FlowConfigurationError", async () => {
        const agent = createTestAgent();
        const session = createSession<TestData>({ data: {} });

        try {
            await agent.dispatch({ goTo: {} } as any, session);
            expect(true).toBe(false);
        } catch (err: any) {
            expect(err).toBeInstanceOf(FlowConfigurationError);
            expect(err.message).toContain("goTo");
        }
    });

    test("9.6: session is NOT mutated when dispatch throws", async () => {
        const agent = createTestAgent();
        const session = createSession<TestData>({ data: { name: "Alice" } });
        const originalData = { ...session.data };

        try {
            await agent.dispatch("NonExistentFlow", session);
        } catch {
            // Expected
        }

        // Session should not have been mutated
        expect(session.pendingDirective).toBeUndefined();
        expect(session.data).toEqual(originalData);
    });

    test("dispatch with full Directive object (goTo as string)", async () => {
        const agent = createTestAgent();
        const session = createSession<TestData>({ data: {} });

        const result = await agent.dispatch(
            { goTo: "Support", dataUpdate: { query: "help me" } },
            session
        );

        expect(result.pendingDirective!.goTo).toBe("Support");
        expect(result.pendingDirective!.dataUpdate).toEqual({ query: "help me" });
    });

    test("dispatch with goTo object form", async () => {
        const agent = createTestAgent();
        const session = createSession<TestData>({ data: {} });

        const result = await agent.dispatch(
            { goTo: { flow: "Booking", step: "confirm", reason: "user requested" } },
            session
        );

        expect(result.pendingDirective!.goTo).toEqual({
            flow: "Booking",
            step: "confirm",
            reason: "user requested",
        });
    });
});

describe("Agent.applyDirective", () => {
    test("9.8: applyDirective method exists and is synchronous", () => {
        const agent = createTestAgent();
        expect(typeof agent.applyDirective).toBe("function");

        // It should return a SessionState directly (not a Promise)
        const session = createSession<TestData>({ data: {} });
        const result = agent.applyDirective({ goTo: "Booking" }, session);
        // If it were async, result would be a Promise — check it's a plain object
        expect(result.id).toBeDefined();
        expect(result.data).toBeDefined();
    });

    test("applyDirective with goTo enters the target flow", () => {
        const agent = createTestAgent();
        const session = createSession<TestData>({ data: {} });

        const result = agent.applyDirective({ goTo: "Booking" }, session);

        expect(result.currentFlow?.title).toBe("Booking");
    });

    test("applyDirective with goTo object form enters flow and step", () => {
        const agent = createTestAgent();
        const session = createSession<TestData>({ data: {} });

        const result = agent.applyDirective(
            { goTo: { flow: "Booking", step: "confirm" } },
            session
        );

        expect(result.currentFlow?.title).toBe("Booking");
        expect(result.currentStep?.id).toBe("confirm");
    });

    test("applyDirective with goToStep updates the step", () => {
        const agent = createTestAgent();
        const session = createSession<TestData>({
            data: {},
            currentFlow: { id: "booking", title: "Booking" },
        });

        const result = agent.applyDirective({ goToStep: "payment" }, session);

        expect(result.currentStep?.id).toBe("payment");
    });

    test("applyDirective with complete marks flow as complete", () => {
        const agent = createTestAgent();
        const session = createSession<TestData>({
            data: {},
            currentFlow: { id: "booking", title: "Booking" },
            flowHistory: [{ flowId: "booking", completed: false }],
        });

        const result = agent.applyDirective({ complete: true }, session);

        expect(result.currentFlow).toBeUndefined();
        expect(result.currentStep).toBeUndefined();
    });

    test("applyDirective with complete.next chains the next directive", () => {
        const agent = createTestAgent();
        const session = createSession<TestData>({
            data: {},
            currentFlow: { id: "booking", title: "Booking" },
            flowHistory: [{ flowId: "booking", completed: false }],
        });

        const result = agent.applyDirective(
            { complete: { next: { goTo: "Feedback" } } },
            session
        );

        expect(result.currentFlow).toBeUndefined();
        expect(result.pendingDirective).toBeDefined();
        expect(result.pendingDirective!.goTo).toBe("Feedback");
    });

    test("applyDirective with abort clears session", () => {
        const agent = createTestAgent();
        const session = createSession<TestData>({
            data: { name: "Alice", email: "alice@test.com" },
            currentFlow: { id: "booking", title: "Booking" },
        });

        const result = agent.applyDirective({ abort: "user cancelled" }, session);

        expect(result.currentFlow).toBeUndefined();
        expect(result.currentStep).toBeUndefined();
        expect(result.data).toEqual({});
    });

    test("applyDirective with abort { clearSession: false } preserves data", () => {
        const agent = createTestAgent();
        const session = createSession<TestData>({
            data: { name: "Alice" },
            currentFlow: { id: "booking", title: "Booking" },
        });

        const result = agent.applyDirective(
            { abort: { reason: "timeout", clearSession: false } },
            session
        );

        expect(result.currentFlow).toBeUndefined();
        expect(result.data).toEqual({ name: "Alice" });
    });

    test("applyDirective with dataUpdate merges data", () => {
        const agent = createTestAgent();
        const session = createSession<TestData>({
            data: { name: "Alice" },
        });

        const result = agent.applyDirective(
            { dataUpdate: { email: "alice@test.com" } },
            session
        );

        expect(result.data).toEqual({ name: "Alice", email: "alice@test.com" });
    });

    test("applyDirective with goTo.data merges data before entering flow", () => {
        const agent = createTestAgent();
        const session = createSession<TestData>({ data: { name: "Alice" } });

        const result = agent.applyDirective(
            { goTo: { flow: "Support", data: { query: "help" } } },
            session
        );

        expect(result.currentFlow?.title).toBe("Support");
        expect(result.data).toEqual({ name: "Alice", query: "help" });
    });

    test("applyDirective validates directive (multiple position fields throws)", () => {
        const agent = createTestAgent();
        const session = createSession<TestData>({ data: {} });

        expect(() =>
            agent.applyDirective(
                { goTo: "Booking", abort: "nope" } as Directive<TestContext, TestData>,
                session
            )
        ).toThrow(FlowConfigurationError);
    });

    test("applyDirective with reset re-enters current flow", () => {
        const agent = createTestAgent();
        const session = createSession<TestData>({
            data: { name: "Alice" },
            currentFlow: { id: "booking", title: "Booking" },
            currentStep: { id: "step_2" },
        });

        const result = agent.applyDirective({ reset: true }, session);

        // Should re-enter the same flow from the beginning
        expect(result.currentFlow?.title).toBe("Booking");
        expect(result.currentStep).toBeUndefined();
    });
});

describe("Agent surface: removed methods (Requirement 9.9)", () => {
    test("9.9: Agent does NOT expose nextStepFlow", () => {
        const agent = createTestAgent();
        expect((agent as any).nextStepFlow).toBeUndefined();
    });

    test("9.9: Agent does NOT expose transitionTo", () => {
        const agent = createTestAgent();
        expect((agent as any).transitionTo).toBeUndefined();
    });
});
