/**
 * Tests for directive chain cycle detection.
 *
 * Validates: Requirements 22.1, 22.2, 22.3
 *
 * 22.1: Track chain depth per turn with configurable cap `maxDirectiveChain` (default 10)
 * 22.2: On overflow throw FlowConfigurationError listing each directive in chain order
 * 22.3: Chain breaker (abort) stops counting and applies normally
 */

import { describe, test, expect } from "bun:test";
import { DirectiveChainTracker } from "../src/core/DirectiveChainTracker";
import { FlowConfigurationError } from "../src/core/Step";
import { Agent, createSession } from "../src/index";
import type { Directive } from "../src/types";
import { MockProvider } from "./mock-provider";

describe("DirectiveChainTracker", () => {
    describe("22.1: Track chain depth per turn", () => {
        test("tracks depth incrementally", () => {
            const tracker = new DirectiveChainTracker(10);

            tracker.record({ goTo: "FlowA" }, "hook:onEnter");
            expect(tracker.depth).toBe(1);

            tracker.record({ goTo: "FlowB" }, "hook:onComplete");
            expect(tracker.depth).toBe(2);

            tracker.record({ goToStep: "step3" }, "tool:lookup");
            expect(tracker.depth).toBe(3);
        });

        test("default maxDirectiveChain is 10", () => {
            const provider = new MockProvider({ responseMessage: "OK" });
            const agent = new Agent({
                name: "TestAgent",
                description: "Test",
                provider,
                flows: [{ title: "A", when: "test", steps: [{ prompt: "hi" }] }],
            });

            expect(agent.maxDirectiveChain).toBe(10);
        });

        test("records entries with emitter info", () => {
            const tracker = new DirectiveChainTracker(10);

            tracker.record({ goTo: "Booking" }, "pending");
            tracker.record({ goToStep: "confirm" }, "hook:onEnter");

            expect(tracker.entries).toHaveLength(2);
            expect(tracker.entries[0].emitter).toBe("pending");
            expect(tracker.entries[0].description).toContain("goTo:Booking");
            expect(tracker.entries[1].emitter).toBe("hook:onEnter");
            expect(tracker.entries[1].description).toContain("goToStep:confirm");
        });
    });

    describe("22.2: maxDirectiveChain configurable on AgentOptions", () => {
        test("custom maxDirectiveChain is respected", () => {
            const provider = new MockProvider({ responseMessage: "OK" });
            const agent = new Agent({
                name: "TestAgent",
                description: "Test",
                provider,
                maxDirectiveChain: 5,
                flows: [{ title: "A", when: "test", steps: [{ prompt: "hi" }] }],
            });

            expect(agent.maxDirectiveChain).toBe(5);
        });

        test("chain of exactly maxDirectiveChain does not throw", () => {
            const tracker = new DirectiveChainTracker(5);

            // 5 directives should be fine
            for (let i = 0; i < 5; i++) {
                tracker.record({ goTo: `Flow${i}` }, `emitter${i}`);
            }
            expect(tracker.depth).toBe(5);
        });

        test("chain exceeding maxDirectiveChain throws FlowConfigurationError", () => {
            const tracker = new DirectiveChainTracker(5);

            // Fill up to the limit
            for (let i = 0; i < 5; i++) {
                tracker.record({ goTo: `Flow${i}` }, `emitter${i}`);
            }

            // The 6th should throw
            expect(() => {
                tracker.record({ goTo: "FlowOverflow" }, "emitter5");
            }).toThrow(FlowConfigurationError);
        });

        test("overflow error message lists the chain in emission order", () => {
            const tracker = new DirectiveChainTracker(3);

            tracker.record({ goTo: "FlowA" }, "pending");
            tracker.record({ goTo: "FlowB" }, "hook:onEnter");
            tracker.record({ goToStep: "step1" }, "hook:onComplete");

            try {
                tracker.record({ goTo: "FlowC" }, "tool:redirect");
                expect(true).toBe(false); // Should not reach here
            } catch (err) {
                expect(err).toBeInstanceOf(FlowConfigurationError);
                const message = (err as Error).message;
                // Should list all directives in order
                expect(message).toContain("goTo:FlowA");
                expect(message).toContain("goTo:FlowB");
                expect(message).toContain("goToStep:step1");
                expect(message).toContain("goTo:FlowC");
                // Should mention the chain depth and limit
                expect(message).toContain("4");
                expect(message).toContain("3");
                // Should mention cycle detection
                expect(message).toContain("cycle");
            }
        });

        test("default 10: chain of 11 throws", () => {
            const tracker = new DirectiveChainTracker(10);

            for (let i = 0; i < 10; i++) {
                tracker.record({ goTo: `Flow${i}` }, `emitter${i}`);
            }

            expect(() => {
                tracker.record({ goTo: "FlowOverflow" }, "emitter10");
            }).toThrow(FlowConfigurationError);
        });
    });

    describe("22.3: Chain breakers (abort) stop counting", () => {
        test("abort directive returns true (chain breaker)", () => {
            const tracker = new DirectiveChainTracker(10);

            tracker.record({ goTo: "FlowA" }, "pending");
            const isBreaker = tracker.record({ abort: "user cancelled" }, "tool:cancel");

            expect(isBreaker).toBe(true);
        });

        test("non-abort directives return false", () => {
            const tracker = new DirectiveChainTracker(10);

            const result1 = tracker.record({ goTo: "FlowA" }, "pending");
            const result2 = tracker.record({ goToStep: "step1" }, "hook:onEnter");
            const result3 = tracker.record({ complete: true }, "hook:onComplete");
            const result4 = tracker.record({ reset: true }, "hook:onComplete");

            expect(result1).toBe(false);
            expect(result2).toBe(false);
            expect(result3).toBe(false);
            expect(result4).toBe(false);
        });

        test("abort mid-chain does not throw even at limit", () => {
            const tracker = new DirectiveChainTracker(3);

            tracker.record({ goTo: "FlowA" }, "pending");
            tracker.record({ goTo: "FlowB" }, "hook:onEnter");
            tracker.record({ goTo: "FlowC" }, "hook:onComplete");

            // At the limit (3). An abort should NOT throw — it's a chain breaker.
            expect(() => {
                tracker.record({ abort: "emergency stop" }, "tool:abort");
            }).not.toThrow();
        });

        test("abort object form is also a chain breaker", () => {
            const tracker = new DirectiveChainTracker(10);

            const isBreaker = tracker.record(
                { abort: { reason: "timeout", clearSession: true } },
                "system"
            );

            expect(isBreaker).toBe(true);
        });

        test("abort at depth > maxDirectiveChain still does not throw", () => {
            const tracker = new DirectiveChainTracker(2);

            tracker.record({ goTo: "FlowA" }, "pending");
            tracker.record({ goTo: "FlowB" }, "hook:onEnter");

            // Depth is now at the limit (2). Next non-abort would throw.
            // But abort is a chain breaker — it should NOT throw.
            expect(() => {
                tracker.record({ abort: "stop" }, "hook:onComplete");
            }).not.toThrow();
        });
    });

    describe("Directive description formatting", () => {
        test("describes goTo string form", () => {
            const tracker = new DirectiveChainTracker(10);
            tracker.record({ goTo: "Booking" }, "test");
            expect(tracker.entries[0].description).toBe("goTo:Booking");
        });

        test("describes goTo object form", () => {
            const tracker = new DirectiveChainTracker(10);
            tracker.record({ goTo: { flow: "Support", step: "verify" } }, "test");
            expect(tracker.entries[0].description).toBe("goTo:Support");
        });

        test("describes goToStep", () => {
            const tracker = new DirectiveChainTracker(10);
            tracker.record({ goToStep: "payment" }, "test");
            expect(tracker.entries[0].description).toBe("goToStep:payment");
        });

        test("describes complete", () => {
            const tracker = new DirectiveChainTracker(10);
            tracker.record({ complete: true }, "test");
            expect(tracker.entries[0].description).toBe("complete");
        });

        test("describes complete with chained next", () => {
            const tracker = new DirectiveChainTracker(10);
            tracker.record({ complete: { next: { goTo: "Feedback" } } }, "test");
            expect(tracker.entries[0].description).toBe("complete(chained)");
        });

        test("describes abort string form", () => {
            const tracker = new DirectiveChainTracker(10);
            tracker.record({ abort: "timeout" }, "test");
            expect(tracker.entries[0].description).toBe("abort:timeout");
        });

        test("describes abort object form", () => {
            const tracker = new DirectiveChainTracker(10);
            tracker.record({ abort: { reason: "user left", clearSession: true } }, "test");
            expect(tracker.entries[0].description).toBe("abort:user left");
        });

        test("describes reset", () => {
            const tracker = new DirectiveChainTracker(10);
            tracker.record({ reset: true }, "test");
            expect(tracker.entries[0].description).toBe("reset");
        });

        test("describes state-only directive", () => {
            const tracker = new DirectiveChainTracker(10);
            tracker.record({ dataUpdate: { name: "Alice" } } as Directive, "test");
            expect(tracker.entries[0].description).toBe("dataUpdate");
        });

        test("describes reply-only directive", () => {
            const tracker = new DirectiveChainTracker(10);
            tracker.record({ reply: "Hello!" }, "test");
            expect(tracker.entries[0].description).toBe("reply");
        });
    });

    describe("reset()", () => {
        test("clears the chain", () => {
            const tracker = new DirectiveChainTracker(10);
            tracker.record({ goTo: "FlowA" }, "test");
            tracker.record({ goTo: "FlowB" }, "test");
            expect(tracker.depth).toBe(2);

            tracker.reset();
            expect(tracker.depth).toBe(0);
            expect(tracker.entries).toHaveLength(0);
        });
    });
});

describe("Agent.maxDirectiveChain integration", () => {
    test("maxDirectiveChain defaults to 10 when not specified", () => {
        const provider = new MockProvider({ responseMessage: "OK" });
        const agent = new Agent({
            name: "TestAgent",
            description: "Test",
            provider,
            flows: [{ title: "A", when: "test", steps: [{ prompt: "hi" }] }],
        });

        expect(agent.maxDirectiveChain).toBe(10);
    });

    test("maxDirectiveChain can be set to a custom value", () => {
        const provider = new MockProvider({ responseMessage: "OK" });
        const agent = new Agent({
            name: "TestAgent",
            description: "Test",
            provider,
            maxDirectiveChain: 20,
            flows: [{ title: "A", when: "test", steps: [{ prompt: "hi" }] }],
        });

        expect(agent.maxDirectiveChain).toBe(20);
    });

    test("maxDirectiveChain can be set to a low value", () => {
        const provider = new MockProvider({ responseMessage: "OK" });
        const agent = new Agent({
            name: "TestAgent",
            description: "Test",
            provider,
            maxDirectiveChain: 3,
            flows: [{ title: "A", when: "test", steps: [{ prompt: "hi" }] }],
        });

        expect(agent.maxDirectiveChain).toBe(3);
    });
});
