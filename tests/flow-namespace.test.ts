/**
 * flow namespace helpers — unit tests
 *
 * Tests for `flow.isDirective`, `flow.merge`, and `flow.validate`.
 *
 * **Validates: Requirements 1.4, 1.5, 1.14, 1.15**
 */
import { describe, test, expect } from "bun:test";
import { flow } from "../src/core/flow-namespace";
import { FlowConfigurationError } from "../src/core/Step";
import type { Directive } from "../src/types/flow";

// ─── flow.isDirective ────────────────────────────────────────────────────────

describe("flow.isDirective", () => {
    test("returns true for a plain empty object", () => {
        expect(flow.isDirective({})).toBe(true);
    });

    test("returns true for a directive with position field", () => {
        expect(flow.isDirective({ goTo: "Booking" })).toBe(true);
    });

    test("returns true for a directive with only state writes", () => {
        expect(flow.isDirective({ dataUpdate: { name: "Alice" } })).toBe(true);
    });

    test("returns false for null", () => {
        expect(flow.isDirective(null)).toBe(false);
    });

    test("returns false for undefined", () => {
        expect(flow.isDirective(undefined)).toBe(false);
    });

    test("returns false for a string", () => {
        expect(flow.isDirective("goTo")).toBe(false);
    });

    test("returns false for a number", () => {
        expect(flow.isDirective(42)).toBe(false);
    });

    test("returns false for an array", () => {
        expect(flow.isDirective([{ goTo: "X" }])).toBe(false);
    });

    test("returns false for a function", () => {
        expect(flow.isDirective(() => ({ goTo: "X" }))).toBe(false);
    });
});

// ─── flow.validate ───────────────────────────────────────────────────────────

describe("flow.validate", () => {
    test("does not throw for a valid single-position directive", () => {
        expect(() => flow.validate({ goTo: "Booking" })).not.toThrow();
        expect(() => flow.validate({ complete: true })).not.toThrow();
        expect(() => flow.validate({ abort: "timeout" })).not.toThrow();
        expect(() => flow.validate({ reset: true })).not.toThrow();
        expect(() => flow.validate({ goToStep: "step_2" })).not.toThrow();
    });

    test("does not throw for a state-only directive (no position)", () => {
        expect(() =>
            flow.validate({ dataUpdate: { x: 1 }, contextUpdate: { y: 2 } })
        ).not.toThrow();
    });

    test("does not throw for a reply-only directive", () => {
        expect(() => flow.validate({ reply: "Hello!" })).not.toThrow();
    });

    test("does not throw for reply + complete (valid combo)", () => {
        expect(() =>
            flow.validate({ complete: true, reply: "Goodbye!" })
        ).not.toThrow();
    });

    test("does not throw for reply + goTo (valid combo)", () => {
        expect(() =>
            flow.validate({ goTo: "NextFlow", reply: "Transferring..." })
        ).not.toThrow();
    });

    test("throws FlowConfigurationError for multiple position fields", () => {
        expect(() =>
            flow.validate({ goTo: "X", complete: true })
        ).toThrow(FlowConfigurationError);
    });

    test("error message lists conflicting fields", () => {
        try {
            flow.validate({ goTo: "X", abort: "reason", reset: true } as Directive);
            expect(true).toBe(false);
        } catch (e: unknown) {
            expect(e).toBeInstanceOf(FlowConfigurationError);
            expect((e as Error).message).toContain("goTo");
            expect((e as Error).message).toContain("abort");
            expect((e as Error).message).toContain("reset");
        }
    });

    test("throws FlowConfigurationError for empty goTo object", () => {
        expect(() => flow.validate({ goTo: {} } as Directive)).toThrow(
            FlowConfigurationError
        );
    });

    test("error message for empty goTo mentions flow id", () => {
        try {
            flow.validate({ goTo: {} } as Directive);
            expect(true).toBe(false);
        } catch (e: unknown) {
            expect(e).toBeInstanceOf(FlowConfigurationError);
            expect((e as Error).message).toContain("flow id or title");
        }
    });

    test("does not throw for goTo with flow set", () => {
        expect(() =>
            flow.validate({ goTo: { flow: "Booking" } })
        ).not.toThrow();
    });

    test("throws FlowConfigurationError for reply + abort", () => {
        expect(() =>
            flow.validate({ reply: "bye", abort: "done" })
        ).toThrow(FlowConfigurationError);
    });

    test("does not throw for an empty directive", () => {
        expect(() => flow.validate({})).not.toThrow();
    });
});

// ─── flow.merge ──────────────────────────────────────────────────────────────

describe("flow.merge", () => {
    describe("position field precedence", () => {
        test("abort wins over complete", () => {
            const result = flow.merge(
                { complete: true } as Directive,
                { abort: "critical" } as Directive
            );
            expect(result.abort).toBe("critical");
            expect(result.complete).toBeUndefined();
        });

        test("abort wins over goTo", () => {
            const result = flow.merge(
                { goTo: "X" } as Directive,
                { abort: "err" } as Directive
            );
            expect(result.abort).toBe("err");
            expect(result.goTo).toBeUndefined();
        });

        test("complete wins over goTo", () => {
            const result = flow.merge(
                { goTo: "X" } as Directive,
                { complete: true } as Directive
            );
            expect(result.complete).toBe(true);
            expect(result.goTo).toBeUndefined();
        });

        test("complete wins over reset", () => {
            const result = flow.merge(
                { reset: true } as Directive,
                { complete: true } as Directive
            );
            expect(result.complete).toBe(true);
            expect(result.reset).toBeUndefined();
        });

        test("goTo wins over reset", () => {
            const result = flow.merge(
                { reset: true } as Directive,
                { goTo: "Flow2" } as Directive
            );
            expect(result.goTo).toBe("Flow2");
            expect(result.reset).toBeUndefined();
        });

        test("same precedence: b wins (last-wins)", () => {
            const result = flow.merge(
                { goTo: "A" } as Directive,
                { goToStep: "step_x" } as Directive
            );
            expect(result.goToStep).toBe("step_x");
            expect(result.goTo).toBeUndefined();
        });

        test("b wins over a at same precedence (goTo vs goTo)", () => {
            const result = flow.merge(
                { goTo: "A" } as Directive,
                { goTo: "B" } as Directive
            );
            expect(result.goTo).toBe("B");
        });
    });

    describe("reply: last-wins", () => {
        test("b.reply overrides a.reply", () => {
            const result = flow.merge(
                { reply: "Hello" } as Directive,
                { reply: "Goodbye" } as Directive
            );
            expect(result.reply).toBe("Goodbye");
        });

        test("a.reply preserved when b has no reply", () => {
            const result = flow.merge(
                { reply: "Hello" } as Directive,
                { dataUpdate: { x: 1 } } as Directive
            );
            expect(result.reply).toBe("Hello");
        });
    });

    describe("dataUpdate / contextUpdate: shallow merge", () => {
        test("merges dataUpdate from both", () => {
            const result = flow.merge(
                { dataUpdate: { a: 1, b: 2 } } as Directive,
                { dataUpdate: { b: 99, c: 3 } } as Directive
            );
            expect(result.dataUpdate).toEqual({ a: 1, b: 99, c: 3 });
        });

        test("merges contextUpdate from both", () => {
            const result = flow.merge(
                { contextUpdate: { x: "old" } } as Directive,
                { contextUpdate: { x: "new", y: "added" } } as Directive
            );
            expect(result.contextUpdate).toEqual({ x: "new", y: "added" });
        });

        test("only a has dataUpdate", () => {
            const result = flow.merge(
                { dataUpdate: { a: 1 } } as Directive,
                {} as Directive
            );
            expect(result.dataUpdate).toEqual({ a: 1 });
        });
    });

    describe("appendPrompt (PreDirective): concatenate", () => {
        test("concatenates arrays from both", () => {
            const a = { appendPrompt: ["line1"] } as unknown as Directive;
            const b = { appendPrompt: ["line2", "line3"] } as unknown as Directive;
            const result = flow.merge(a, b) as unknown as { appendPrompt: string[] };
            expect(result.appendPrompt).toEqual(["line1", "line2", "line3"]);
        });

        test("only a has appendPrompt", () => {
            const a = { appendPrompt: ["line1"] } as unknown as Directive;
            const b = {} as Directive;
            const result = flow.merge(a, b) as unknown as { appendPrompt: string[] };
            expect(result.appendPrompt).toEqual(["line1"]);
        });
    });

    describe("injectTools (PreDirective): concatenate then dedupe by id", () => {
        test("deduplicates by id, last wins", () => {
            const toolA = { id: "t1", handler: () => ({}) };
            const toolB = { id: "t1", handler: () => ({ v: 2 }) };
            const toolC = { id: "t2", handler: () => ({}) };
            const a = { injectTools: [toolA, toolC] } as unknown as Directive;
            const b = { injectTools: [toolB] } as unknown as Directive;
            const result = flow.merge(a, b) as unknown as {
                injectTools: Array<{ id: string }>;
            };
            expect(result.injectTools).toHaveLength(2);
            expect(result.injectTools[0].id).toBe("t1");
            expect(result.injectTools[0]).toBe(toolB); // last wins
            expect(result.injectTools[1].id).toBe("t2");
        });
    });

    describe("halt (PreDirective): logical OR", () => {
        test("true if either is true", () => {
            const a = { halt: false } as unknown as Directive;
            const b = { halt: true } as unknown as Directive;
            const result = flow.merge(a, b) as unknown as { halt: boolean };
            expect(result.halt).toBe(true);
        });

        test("true if a is true and b is false", () => {
            const a = { halt: true } as unknown as Directive;
            const b = { halt: false } as unknown as Directive;
            const result = flow.merge(a, b) as unknown as { halt: boolean };
            expect(result.halt).toBe(true);
        });

        test("not set if neither has halt", () => {
            const result = flow.merge(
                { goTo: "X" } as Directive,
                { reply: "hi" } as Directive
            );
            expect((result as unknown as Record<string, unknown>).halt).toBeUndefined();
        });
    });

    describe("combined merge", () => {
        test("position + state + reply all merge correctly", () => {
            const a: Directive = {
                goTo: "FlowA",
                reply: "old reply",
                dataUpdate: { x: 1 },
                contextUpdate: { env: "dev" },
            };
            const b: Directive = {
                abort: "critical",
                reply: "new reply",
                dataUpdate: { y: 2 },
                contextUpdate: { env: "prod" },
            };
            const result = flow.merge(a, b);
            // abort wins over goTo
            expect(result.abort).toBe("critical");
            expect(result.goTo).toBeUndefined();
            // reply: last wins
            expect(result.reply).toBe("new reply");
            // state: shallow merge
            expect(result.dataUpdate).toEqual({ x: 1, y: 2 });
            expect(result.contextUpdate).toEqual({ env: "prod" });
        });
    });
});

// ─── Requirement 1.5 / 1.15: No builder constructors on namespace ────────────

describe("flow namespace surface", () => {
    test("only exposes isDirective, merge, validate", () => {
        const keys = Object.keys(flow).sort();
        expect(keys).toEqual(["isDirective", "merge", "validate"]);
    });

    test("does not expose goTo, complete, abort, reset, goToStep constructors", () => {
        expect((flow as Record<string, unknown>).goTo).toBeUndefined();
        expect((flow as Record<string, unknown>).complete).toBeUndefined();
        expect((flow as Record<string, unknown>).abort).toBeUndefined();
        expect((flow as Record<string, unknown>).reset).toBeUndefined();
        expect((flow as Record<string, unknown>).goToStep).toBeUndefined();
    });
});

// ─── Requirement 1.14: flow namespace exported from src/index.ts ─────────────

describe("flow namespace export", () => {
    test("flow is importable from the package barrel", async () => {
        const barrel = await import("../src/index");
        expect(barrel.flow).toBeDefined();
        expect(barrel.flow.isDirective).toBeTypeOf("function");
        expect(barrel.flow.merge).toBeTypeOf("function");
        expect(barrel.flow.validate).toBeTypeOf("function");
    });
});
