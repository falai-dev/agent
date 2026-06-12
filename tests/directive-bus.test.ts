/**
 * DirectiveBus — unit tests
 *
 * Tests the per-turn directive collection mechanism: emission, phase management,
 * merge via Algorithm 4, conflict logging, and pre-LLM field stripping.
 *
 * **Validates: Requirements 1.3, 10.4, 10.5, 10.6**
 */
import { describe, test, expect } from "bun:test";
import { DirectiveBus } from "../src/core/DirectiveBus";
import type { Directive } from "../src/types/flow";

// ─── Basic emission and drain ────────────────────────────────────────────────

describe("DirectiveBus: basic emission", () => {
    test("emit collects a directive with emitter id and phase", () => {
        const bus = new DirectiveBus();
        bus.emit({ goTo: "Booking" }, "tool:lookup_order");

        const entries = bus.getEntries();
        expect(entries).toHaveLength(1);
        expect(entries[0].directive).toEqual({ goTo: "Booking" });
        expect(entries[0].emitterId).toBe("tool:lookup_order");
        expect(entries[0].phase).toBe("pre-llm");
        expect(entries[0].order).toBe(0);
    });

    test("emit stamps entries with monotonically increasing order", () => {
        const bus = new DirectiveBus();
        bus.emit({ goTo: "A" }, "emitter1");
        bus.emit({ goTo: "B" }, "emitter2");
        bus.emit({ goTo: "C" }, "emitter3");

        const entries = bus.getEntries();
        expect(entries[0].order).toBe(0);
        expect(entries[1].order).toBe(1);
        expect(entries[2].order).toBe(2);
    });

    test("emit ignores null/undefined/non-object values", () => {
        const bus = new DirectiveBus();
        bus.emit(null as unknown as Directive, "x");
        bus.emit(undefined as unknown as Directive, "y");
        bus.emit("string" as unknown as Directive, "z");
        bus.emit([] as unknown as Directive, "arr");

        expect(bus.size).toBe(0);
    });

    test("emit ignores empty directives (all fields undefined)", () => {
        const bus = new DirectiveBus();
        bus.emit({}, "empty");

        expect(bus.size).toBe(0);
    });

    test("hasEntries returns true when entries exist for current phase", () => {
        const bus = new DirectiveBus();
        expect(bus.hasEntries()).toBe(false);

        bus.emit({ reply: "hi" }, "hook");
        expect(bus.hasEntries()).toBe(true);
    });
});

// ─── Phase management ────────────────────────────────────────────────────────

describe("DirectiveBus: phase management", () => {
    test("default phase is pre-llm", () => {
        const bus = new DirectiveBus();
        expect(bus.getPhase()).toBe("pre-llm");
    });

    test("setPhase changes the current phase", () => {
        const bus = new DirectiveBus();
        bus.setPhase("post-llm");
        expect(bus.getPhase()).toBe("post-llm");
    });

    test("entries are tagged with the phase at emission time", () => {
        const bus = new DirectiveBus();
        bus.emit({ reply: "pre" }, "hook:prepare");
        bus.setPhase("post-llm");
        bus.emit({ reply: "post" }, "hook:finalize");

        const entries = bus.getEntries();
        expect(entries[0].phase).toBe("pre-llm");
        expect(entries[1].phase).toBe("post-llm");
    });

    test("drain only returns entries for the current phase", () => {
        const bus = new DirectiveBus();
        bus.emit({ reply: "pre" }, "hook:prepare");
        bus.setPhase("post-llm");
        bus.emit({ reply: "post" }, "hook:finalize");

        // Drain post-llm phase
        const postResult = bus.drain();
        expect(postResult).toBeDefined();
        expect(postResult!.reply).toBe("post");

        // Pre-llm entries still exist
        expect(bus.size).toBe(1);
    });

    test("order counter is global across phases (not reset on setPhase)", () => {
        const bus = new DirectiveBus();
        bus.emit({ goTo: "A" }, "e1");
        bus.emit({ goTo: "B" }, "e2");
        bus.setPhase("post-llm");
        bus.emit({ goTo: "C" }, "e3");

        const entries = bus.getEntries();
        expect(entries[2].order).toBe(2); // continues from 0, 1, 2
    });
});

// ─── Drain and merge (Algorithm 4) ──────────────────────────────────────────

describe("DirectiveBus: drain merges via Algorithm 4", () => {
    test("single directive is returned as-is", () => {
        const bus = new DirectiveBus();
        bus.emit({ goTo: "Booking", reply: "Transferring..." }, "hook:onEnter");

        const result = bus.drain();
        expect(result).toEqual({ goTo: "Booking", reply: "Transferring..." });
    });

    test("returns undefined when no entries for current phase", () => {
        const bus = new DirectiveBus();
        expect(bus.drain()).toBeUndefined();
    });

    test("drain clears entries for the drained phase", () => {
        const bus = new DirectiveBus();
        bus.emit({ goTo: "A" }, "e1");
        bus.drain();
        expect(bus.size).toBe(0);
        expect(bus.drain()).toBeUndefined();
    });

    // ── Requirement 10.4: position precedence ──

    test("abort wins over complete (Req 10.4)", () => {
        const bus = new DirectiveBus();
        bus.emit({ complete: true }, "hook:finalize");
        bus.emit({ abort: "critical" }, "tool:check_status");

        const result = bus.drain()!;
        expect(result.abort).toBe("critical");
        expect(result.complete).toBeUndefined();
    });

    test("complete wins over goTo (Req 10.4)", () => {
        const bus = new DirectiveBus();
        bus.emit({ goTo: "NextFlow" }, "tool:lookup");
        bus.emit({ complete: true }, "hook:onComplete");

        const result = bus.drain()!;
        expect(result.complete).toBe(true);
        expect(result.goTo).toBeUndefined();
    });

    test("goTo wins over reset (Req 10.4)", () => {
        const bus = new DirectiveBus();
        bus.emit({ reset: true }, "hook:prepare");
        bus.emit({ goTo: "OtherFlow" }, "hook:onEnter");

        const result = bus.drain()!;
        expect(result.goTo).toBe("OtherFlow");
        expect(result.reset).toBeUndefined();
    });

    test("same precedence: last emission wins (Req 10.4)", () => {
        const bus = new DirectiveBus();
        bus.emit({ goTo: "FlowA" }, "tool:first");
        bus.emit({ goTo: "FlowB" }, "tool:second");

        const result = bus.drain()!;
        expect(result.goTo).toBe("FlowB");
    });

    test("goTo and goToStep are same precedence — last wins (Req 10.4)", () => {
        const bus = new DirectiveBus();
        bus.emit({ goTo: "FlowA" }, "tool:first");
        bus.emit({ goToStep: "step_x" }, "tool:second");

        const result = bus.drain()!;
        expect(result.goToStep).toBe("step_x");
        expect(result.goTo).toBeUndefined();
    });

    // ── Requirement 10.5: reply last-wins ──

    test("multiple reply fields: last emission wins (Req 10.5)", () => {
        const bus = new DirectiveBus();
        bus.emit({ reply: "First reply" }, "hook:onEnter");
        bus.emit({ reply: "Second reply" }, "hook:prepare");

        const result = bus.drain()!;
        expect(result.reply).toBe("Second reply");
    });

    test("reply from earlier emitter preserved when later has no reply", () => {
        const bus = new DirectiveBus();
        bus.emit({ reply: "Hello", goTo: "A" }, "hook:onEnter");
        bus.emit({ dataUpdate: { x: 1 } } as Directive, "hook:prepare");

        const result = bus.drain()!;
        expect(result.reply).toBe("Hello");
    });

    // ── Requirement 10.6: dataUpdate/contextUpdate shallow-merge ──

    test("multiple dataUpdate fields: shallow-merge in emit order (Req 10.6)", () => {
        const bus = new DirectiveBus();
        bus.emit({ dataUpdate: { a: 1, b: 2 } } as Directive, "tool:first");
        bus.emit({ dataUpdate: { b: 99, c: 3 } } as Directive, "tool:second");

        const result = bus.drain()!;
        expect(result.dataUpdate).toEqual({ a: 1, b: 99, c: 3 });
    });

    test("multiple contextUpdate fields: shallow-merge, last-write-wins on key collision (Req 10.6)", () => {
        const bus = new DirectiveBus();
        bus.emit({ contextUpdate: { env: "dev", region: "us" } } as Directive, "hook:onEnter");
        bus.emit({ contextUpdate: { env: "prod" } } as Directive, "hook:prepare");

        const result = bus.drain()!;
        expect(result.contextUpdate).toEqual({ env: "prod", region: "us" });
    });

    // ── Combined merge ──

    test("position + state + reply all merge correctly across emitters", () => {
        const bus = new DirectiveBus();
        bus.emit(
            { goTo: "FlowA", reply: "old", dataUpdate: { x: 1 } } as Directive,
            "tool:first"
        );
        bus.emit(
            { abort: "critical", reply: "new", dataUpdate: { y: 2 } } as Directive,
            "tool:second"
        );

        const result = bus.drain()!;
        // abort wins over goTo
        expect(result.abort).toBe("critical");
        expect(result.goTo).toBeUndefined();
        // reply: last wins
        expect(result.reply).toBe("new");
        // state: shallow merge
        expect(result.dataUpdate).toEqual({ x: 1, y: 2 });
    });
});

// ─── Pre-LLM augmentation fields ────────────────────────────────────────────

describe("DirectiveBus: PreDirective fields in pre-LLM phase", () => {
    test("appendPrompt arrays are concatenated", () => {
        const bus = new DirectiveBus();
        bus.emit({ appendPrompt: ["line1"] } as unknown as Directive, "flow.onEnter");
        bus.emit({ appendPrompt: ["line2", "line3"] } as unknown as Directive, "step.prepare");

        const result = bus.drain() as unknown as { appendPrompt: string[] };
        expect(result.appendPrompt).toEqual(["line1", "line2", "line3"]);
    });

    test("injectTools are concatenated and deduped by id (last wins)", () => {
        const toolA = { id: "t1", handler: () => ({}) };
        const toolB = { id: "t1", handler: () => ({ v: 2 }) };
        const toolC = { id: "t2", handler: () => ({}) };

        const bus = new DirectiveBus();
        bus.emit({ injectTools: [toolA, toolC] } as unknown as Directive, "flow.onEnter");
        bus.emit({ injectTools: [toolB] } as unknown as Directive, "step.prepare");

        const result = bus.drain() as unknown as { injectTools: Array<{ id: string }> };
        expect(result.injectTools).toHaveLength(2);
        expect(result.injectTools[0]).toBe(toolB); // last wins for t1
        expect(result.injectTools[1].id).toBe("t2");
    });

    test("halt is logical-OR across emitters", () => {
        const bus = new DirectiveBus();
        bus.emit({ halt: false } as unknown as Directive, "flow.onEnter");
        bus.emit({ halt: true } as unknown as Directive, "step.prepare");

        const result = bus.drain() as unknown as { halt: boolean };
        expect(result.halt).toBe(true);
    });
});

// ─── Post-LLM phase: pre-LLM-only field stripping ───────────────────────────
// **Validates: Requirement 2.10**

describe("DirectiveBus: post-LLM field stripping", () => {
    test("appendPrompt is stripped from post-LLM drain", () => {
        const bus = new DirectiveBus();
        bus.setPhase("post-llm");
        bus.emit(
            { goTo: "NextFlow", appendPrompt: ["should be dropped"] } as unknown as Directive,
            "hook:finalize"
        );

        const result = bus.drain()!;
        expect(result.goTo).toBe("NextFlow");
        expect((result as Record<string, unknown>).appendPrompt).toBeUndefined();
    });

    test("injectTools is stripped from post-LLM drain", () => {
        const bus = new DirectiveBus();
        bus.setPhase("post-llm");
        bus.emit(
            { reply: "hi", injectTools: [{ id: "t1" }] } as unknown as Directive,
            "tool:dispatch"
        );

        const result = bus.drain()!;
        expect(result.reply).toBe("hi");
        expect((result as Record<string, unknown>).injectTools).toBeUndefined();
    });

    test("halt is stripped from post-LLM drain", () => {
        const bus = new DirectiveBus();
        bus.setPhase("post-llm");
        bus.emit(
            { complete: true, halt: true } as unknown as Directive,
            "hook:onComplete"
        );

        const result = bus.drain()!;
        expect(result.complete).toBe(true);
        expect((result as Record<string, unknown>).halt).toBeUndefined();
    });

    test("remaining Directive fields are preserved after stripping", () => {
        const bus = new DirectiveBus();
        bus.setPhase("post-llm");
        bus.emit(
            {
                goTo: "Flow2",
                reply: "Transferring",
                dataUpdate: { x: 1 },
                appendPrompt: ["dropped"],
                halt: true,
            } as unknown as Directive,
            "hook:finalize"
        );

        const result = bus.drain()!;
        expect(result.goTo).toBe("Flow2");
        expect(result.reply).toBe("Transferring");
        expect(result.dataUpdate).toEqual({ x: 1 });
        expect((result as Record<string, unknown>).appendPrompt).toBeUndefined();
        expect((result as Record<string, unknown>).halt).toBeUndefined();
    });

    test("finalize emitter: pre-LLM fields dropped, Directive portion retained (Req 2.10)", () => {
        const bus = new DirectiveBus();
        bus.setPhase("post-llm");
        bus.emit(
            { goTo: "Billing", reply: "Transferring to billing", appendPrompt: ["ignore"], injectTools: [{ id: "t" }], halt: true } as unknown as Directive,
            "hook:finalize:verify_order"
        );

        const result = bus.drain()!;
        expect(result.goTo).toBe("Billing");
        expect(result.reply).toBe("Transferring to billing");
        expect((result as Record<string, unknown>).appendPrompt).toBeUndefined();
        expect((result as Record<string, unknown>).injectTools).toBeUndefined();
        expect((result as Record<string, unknown>).halt).toBeUndefined();
    });

    test("onComplete emitter: pre-LLM fields dropped, Directive portion retained (Req 2.10)", () => {
        const bus = new DirectiveBus();
        bus.setPhase("post-llm");
        bus.emit(
            { complete: true, reply: "All done!", halt: true } as unknown as Directive,
            "hook:onComplete:booking"
        );

        const result = bus.drain()!;
        expect(result.complete).toBe(true);
        expect(result.reply).toBe("All done!");
        expect((result as Record<string, unknown>).halt).toBeUndefined();
    });

    test("tool emitter: pre-LLM fields dropped, Directive portion retained (Req 2.10)", () => {
        const bus = new DirectiveBus();
        bus.setPhase("post-llm");
        bus.emit(
            { goToStep: "confirm", dataUpdate: { amount: 100 }, appendPrompt: ["stale"] } as unknown as Directive,
            "tool:process_payment"
        );

        const result = bus.drain()!;
        expect(result.goToStep).toBe("confirm");
        expect(result.dataUpdate).toEqual({ amount: 100 });
        expect((result as Record<string, unknown>).appendPrompt).toBeUndefined();
    });

    test("branch resolver emitter: pre-LLM fields dropped, Directive portion retained (Req 2.10)", () => {
        const bus = new DirectiveBus();
        bus.setPhase("post-llm");
        bus.emit(
            { goTo: "PremiumFlow", injectTools: [{ id: "premium_tool" }] } as unknown as Directive,
            "branch:ask_plan[0]"
        );

        const result = bus.drain()!;
        expect(result.goTo).toBe("PremiumFlow");
        expect((result as Record<string, unknown>).injectTools).toBeUndefined();
    });

    test("post-LLM ctx.dispatch emitter: pre-LLM fields dropped, Directive portion retained (Req 2.10)", () => {
        const bus = new DirectiveBus();
        bus.setPhase("post-llm");
        bus.emit(
            { abort: "rate_limited", halt: true, appendPrompt: ["too late"] } as unknown as Directive,
            "ctx.dispatch:finalize"
        );

        const result = bus.drain()!;
        expect(result.abort).toBe("rate_limited");
        expect((result as Record<string, unknown>).halt).toBeUndefined();
        expect((result as Record<string, unknown>).appendPrompt).toBeUndefined();
    });

    test("multiple post-LLM emitters with mixed pre-LLM fields: all stripped correctly (Req 2.10)", () => {
        const bus = new DirectiveBus();
        bus.setPhase("post-llm");
        bus.emit(
            { goTo: "FlowA", appendPrompt: ["dropped1"] } as unknown as Directive,
            "tool:check_status"
        );
        bus.emit(
            { goTo: "FlowB", halt: true, injectTools: [{ id: "x" }] } as unknown as Directive,
            "hook:finalize:step2"
        );

        const result = bus.drain()!;
        // Last emission wins for same-precedence position field
        expect(result.goTo).toBe("FlowB");
        expect((result as Record<string, unknown>).appendPrompt).toBeUndefined();
        expect((result as Record<string, unknown>).halt).toBeUndefined();
        expect((result as Record<string, unknown>).injectTools).toBeUndefined();
    });

    test("debug log names the emitter and dropped fields (Req 2.10)", () => {
        // Spy on logger.debug to verify the log content
        const { logger } = require("../src/utils");
        const debugCalls: string[] = [];
        const originalDebug = logger.debug;
        logger.debug = (...args: unknown[]) => { debugCalls.push(String(args[0])); };

        try {
            const bus = new DirectiveBus();
            bus.setPhase("post-llm");
            bus.emit(
                { goTo: "NextFlow", appendPrompt: ["x"], halt: true } as unknown as Directive,
                "hook:finalize:my_step"
            );

            bus.drain();

            // Verify a debug log was emitted that names the emitter and dropped fields
            const strippingLog = debugCalls.find(
                (msg) => msg.includes("Dropped") && msg.includes("pre-LLM-only")
            );
            expect(strippingLog).toBeDefined();
            expect(strippingLog).toContain("hook:finalize:my_step");
            expect(strippingLog).toContain("appendPrompt");
            expect(strippingLog).toContain("halt");
        } finally {
            logger.debug = originalDebug;
        }
    });
});

// ─── Clear and drainAll ──────────────────────────────────────────────────────

describe("DirectiveBus: clear and drainAll", () => {
    test("clear resets all state", () => {
        const bus = new DirectiveBus();
        bus.emit({ goTo: "A" }, "e1");
        bus.setPhase("post-llm");
        bus.emit({ goTo: "B" }, "e2");

        bus.clear();
        expect(bus.size).toBe(0);
        expect(bus.getPhase()).toBe("pre-llm");
        expect(bus.drain()).toBeUndefined();
    });

    test("drainAll merges entries from all phases", () => {
        const bus = new DirectiveBus();
        bus.emit({ dataUpdate: { a: 1 } } as Directive, "hook:onEnter");
        bus.setPhase("post-llm");
        bus.emit({ dataUpdate: { b: 2 } } as Directive, "tool:result");

        const result = bus.drainAll()!;
        expect(result.dataUpdate).toEqual({ a: 1, b: 2 });
        expect(bus.size).toBe(0);
    });

    test("drainAll returns undefined when bus is empty", () => {
        const bus = new DirectiveBus();
        expect(bus.drainAll()).toBeUndefined();
    });
});
