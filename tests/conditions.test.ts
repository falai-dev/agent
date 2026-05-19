/**
 * Tests for the v2 `when` / `if` split (Requirement 5.1–5.9)
 *
 * Validates:
 * - `when` (string) is AI-evaluated; `if` (function) is code-evaluated
 * - Both set: `if` runs first; `when` only runs when `if` passes
 * - Function on `when` throws FlowConfigurationError at construction
 * - `Step.skip` (renamed from `skipIf`) uses if-only shape
 * - `ConditionTemplate` is NOT exported from public surface
 */

import { expect, test, describe } from "bun:test";
import {
    Agent,
    Flow,
    Step,
    FlowConfigurationError,
} from "../src/index";
import { MockProviderFactory } from "./mock-provider";
import { createTemplateContext } from "../src/utils/template";

// ─── Test data types ─────────────────────────────────────────────────────────

interface TestContext {
    userId?: string;
    isPremium?: boolean;
}

interface TestData {
    name?: string;
    email?: string;
    plan?: string;
}

// ─── FlowOptions: when / if split ───────────────────────────────────────────

describe("Conditions: when/if split", () => {
    describe("FlowOptions.when (AI-evaluated, string only)", () => {
        test("string when activates flow with AI context", async () => {
            const agent = new Agent<TestContext, TestData>({
                name: "TestAgent",
                provider: MockProviderFactory.basic(),
            });

            const flow = agent.createFlow({
                title: "String When Flow",
                when: "user wants to subscribe",
                steps: [{ id: "s1", prompt: "Hello" }],
            });

            const ctx = createTemplateContext<TestContext, TestData>({ data: {} });
            const result = await flow.evaluateWhen(ctx);

            expect(result.programmaticResult).toBe(true);
            expect(result.aiContextStrings).toEqual(["user wants to subscribe"]);
        });

        test("array of strings on when combines with AND (all passed to AI)", async () => {
            const agent = new Agent<TestContext, TestData>({
                name: "TestAgent",
                provider: MockProviderFactory.basic(),
            });

            const flow = agent.createFlow({
                title: "Array When Flow",
                when: ["user wants to subscribe", "user has payment method"],
                steps: [{ id: "s1", prompt: "Hello" }],
            });

            const ctx = createTemplateContext<TestContext, TestData>({ data: {} });
            const result = await flow.evaluateWhen(ctx);

            expect(result.programmaticResult).toBe(true);
            expect(result.aiContextStrings).toEqual([
                "user wants to subscribe",
                "user has payment method",
            ]);
        });

        test("function on when throws FlowConfigurationError at construction", () => {
            const agent = new Agent<TestContext, TestData>({
                name: "TestAgent",
                provider: MockProviderFactory.basic(),
            });

            expect(() => {
                agent.createFlow({
                    title: "Bad Flow",
                    when: (() => true) as any,
                    steps: [{ id: "s1", prompt: "Hello" }],
                });
            }).toThrow(FlowConfigurationError);
        });

        test("function in when array throws FlowConfigurationError at construction", () => {
            const agent = new Agent<TestContext, TestData>({
                name: "TestAgent",
                provider: MockProviderFactory.basic(),
            });

            expect(() => {
                agent.createFlow({
                    title: "Bad Array Flow",
                    when: ["valid string", (() => true) as any] as any,
                    steps: [{ id: "s1", prompt: "Hello" }],
                });
            }).toThrow(FlowConfigurationError);
        });
    });

    describe("FlowOptions.if (code-evaluated, function only)", () => {
        test("if predicate returning true activates flow", async () => {
            const agent = new Agent<TestContext, TestData>({
                name: "TestAgent",
                provider: MockProviderFactory.basic(),
            });

            const flow = agent.createFlow({
                title: "If Flow",
                if: (ctx) => ctx.context.isPremium === true,
                steps: [{ id: "s1", prompt: "Hello" }],
            });

            const ctx = createTemplateContext<TestContext, TestData>({
                context: { isPremium: true },
                data: {},
            });
            const result = await flow.evaluateWhen(ctx);

            expect(result.programmaticResult).toBe(true);
            expect(result.hasProgrammaticConditions).toBe(true);
        });

        test("if predicate returning false deactivates flow", async () => {
            const agent = new Agent<TestContext, TestData>({
                name: "TestAgent",
                provider: MockProviderFactory.basic(),
            });

            const flow = agent.createFlow({
                title: "If Flow False",
                if: (ctx) => ctx.context.isPremium === true,
                steps: [{ id: "s1", prompt: "Hello" }],
            });

            const ctx = createTemplateContext<TestContext, TestData>({
                context: { isPremium: false },
                data: {},
            });
            const result = await flow.evaluateWhen(ctx);

            expect(result.programmaticResult).toBe(false);
        });

        test("array of if predicates combines with AND", async () => {
            const agent = new Agent<TestContext, TestData>({
                name: "TestAgent",
                provider: MockProviderFactory.basic(),
            });

            const flow = agent.createFlow({
                title: "Array If Flow",
                if: [
                    (ctx) => ctx.context.isPremium === true,
                    (ctx) => !!ctx.context.userId,
                ],
                steps: [{ id: "s1", prompt: "Hello" }],
            });

            // Both pass
            const ctx1 = createTemplateContext<TestContext, TestData>({
                context: { isPremium: true, userId: "u1" },
                data: {},
            });
            const result1 = await flow.evaluateWhen(ctx1);
            expect(result1.programmaticResult).toBe(true);

            // One fails
            const ctx2 = createTemplateContext<TestContext, TestData>({
                context: { isPremium: true, userId: undefined },
                data: {},
            });
            const result2 = await flow.evaluateWhen(ctx2);
            expect(result2.programmaticResult).toBe(false);
        });
    });

    describe("Both when and if set: if first, when only when if passes", () => {
        test("if passes → when strings are returned for AI scoring", async () => {
            const agent = new Agent<TestContext, TestData>({
                name: "TestAgent",
                provider: MockProviderFactory.basic(),
            });

            const flow = agent.createFlow({
                title: "Both Flow",
                when: "user wants to subscribe",
                if: (ctx) => ctx.context.isPremium === true,
                steps: [{ id: "s1", prompt: "Hello" }],
            });

            const ctx = createTemplateContext<TestContext, TestData>({
                context: { isPremium: true },
                data: {},
            });
            const result = await flow.evaluateWhen(ctx);

            expect(result.programmaticResult).toBe(true);
            expect(result.aiContextStrings).toEqual(["user wants to subscribe"]);
            expect(result.hasProgrammaticConditions).toBe(true);
        });

        test("if fails → when is NOT evaluated (token saving)", async () => {
            const agent = new Agent<TestContext, TestData>({
                name: "TestAgent",
                provider: MockProviderFactory.basic(),
            });

            const flow = agent.createFlow({
                title: "Both Flow Fail",
                when: "user wants to subscribe",
                if: (ctx) => ctx.context.isPremium === true,
                steps: [{ id: "s1", prompt: "Hello" }],
            });

            const ctx = createTemplateContext<TestContext, TestData>({
                context: { isPremium: false },
                data: {},
            });
            const result = await flow.evaluateWhen(ctx);

            // if failed → short-circuit, no AI strings returned
            expect(result.programmaticResult).toBe(false);
            expect(result.aiContextStrings).toEqual([]);
        });
    });

    describe("StepOptions: when/if split", () => {
        test("step when (string) returns AI context strings", async () => {
            const agent = new Agent<TestContext, TestData>({
                name: "TestAgent",
                provider: MockProviderFactory.basic(),
            });

            const flow = agent.createFlow({
                title: "Step When Flow",
                steps: [
                    {
                        id: "s1",
                        prompt: "Hello",
                        when: "user is ready to proceed",
                    },
                ],
            });

            const step = flow.getStep("s1")!;
            const ctx = createTemplateContext<TestContext, TestData>({ data: {} });
            const result = await step.evaluateWhen(ctx);

            expect(result.shouldActivate).toBe(true);
            expect(result.aiContextStrings).toEqual(["user is ready to proceed"]);
        });

        test("step if (function) evaluates code predicate", async () => {
            const agent = new Agent<TestContext, TestData>({
                name: "TestAgent",
                provider: MockProviderFactory.basic(),
            });

            const flow = agent.createFlow({
                title: "Step If Flow",
                steps: [
                    {
                        id: "s1",
                        prompt: "Hello",
                        if: (ctx) => !!ctx.data.name,
                    },
                ],
            });

            const step = flow.getStep("s1")!;

            // if passes
            const ctx1 = createTemplateContext<TestContext, TestData>({ data: { name: "Alice" } });
            const result1 = await step.evaluateWhen(ctx1);
            expect(result1.shouldActivate).toBe(true);

            // if fails
            const ctx2 = createTemplateContext<TestContext, TestData>({ data: {} });
            const result2 = await step.evaluateWhen(ctx2);
            expect(result2.shouldActivate).toBe(false);
        });

        test("step with both when and if: if evaluated first", async () => {
            const agent = new Agent<TestContext, TestData>({
                name: "TestAgent",
                provider: MockProviderFactory.basic(),
            });

            const flow = agent.createFlow({
                title: "Step Both Flow",
                steps: [
                    {
                        id: "s1",
                        prompt: "Hello",
                        when: "user greeting detected",
                        if: (ctx) => !!ctx.data.name,
                    },
                ],
            });

            const step = flow.getStep("s1")!;

            // if fails → when not evaluated
            const ctx1 = createTemplateContext<TestContext, TestData>({ data: {} });
            const result1 = await step.evaluateWhen(ctx1);
            expect(result1.shouldActivate).toBe(false);
            expect(result1.aiContextStrings).toEqual([]);

            // if passes → when returned
            const ctx2 = createTemplateContext<TestContext, TestData>({ data: { name: "Alice" } });
            const result2 = await step.evaluateWhen(ctx2);
            expect(result2.shouldActivate).toBe(true);
            expect(result2.aiContextStrings).toEqual(["user greeting detected"]);
        });

        test("function on step when throws FlowConfigurationError at construction", () => {
            const agent = new Agent<TestContext, TestData>({
                name: "TestAgent",
                provider: MockProviderFactory.basic(),
            });

            expect(() => {
                agent.createFlow({
                    title: "Bad Step Flow",
                    steps: [
                        {
                            id: "s1",
                            prompt: "Hello",
                            when: (() => true) as any,
                        },
                    ],
                });
            }).toThrow(FlowConfigurationError);
        });
    });

    describe("Step.skip (renamed from skipIf, if-only shape)", () => {
        test("skip with function returning true skips the step", async () => {
            const agent = new Agent<TestContext, TestData>({
                name: "TestAgent",
                provider: MockProviderFactory.basic(),
            });

            const flow = agent.createFlow({
                title: "Skip Flow",
                steps: [
                    {
                        id: "s1",
                        prompt: "Hello",
                        skip: (ctx) => !!ctx.data.name,
                    },
                ],
            });

            const step = flow.getStep("s1")!;

            // skip returns true → should skip
            const ctx1 = createTemplateContext<TestContext, TestData>({ data: { name: "Alice" } });
            const result1 = await step.evaluateSkip(ctx1);
            expect(result1.shouldSkip).toBe(true);

            // skip returns false → should not skip
            const ctx2 = createTemplateContext<TestContext, TestData>({ data: {} });
            const result2 = await step.evaluateSkip(ctx2);
            expect(result2.shouldSkip).toBe(false);
        });

        test("skip with array of functions uses OR semantics", async () => {
            const agent = new Agent<TestContext, TestData>({
                name: "TestAgent",
                provider: MockProviderFactory.basic(),
            });

            const flow = agent.createFlow({
                title: "Skip Array Flow",
                steps: [
                    {
                        id: "s1",
                        prompt: "Hello",
                        skip: [
                            (ctx) => !!ctx.data.name,
                            (ctx) => !!ctx.data.email,
                        ],
                    },
                ],
            });

            const step = flow.getStep("s1")!;

            // First predicate true → skip
            const ctx1 = createTemplateContext<TestContext, TestData>({ data: { name: "Alice" } });
            const result1 = await step.evaluateSkip(ctx1);
            expect(result1.shouldSkip).toBe(true);

            // Neither true → don't skip
            const ctx2 = createTemplateContext<TestContext, TestData>({ data: {} });
            const result2 = await step.evaluateSkip(ctx2);
            expect(result2.shouldSkip).toBe(false);
        });

        test("no skip field means step is never skipped", async () => {
            const agent = new Agent<TestContext, TestData>({
                name: "TestAgent",
                provider: MockProviderFactory.basic(),
            });

            const flow = agent.createFlow({
                title: "No Skip Flow",
                steps: [{ id: "s1", prompt: "Hello" }],
            });

            const step = flow.getStep("s1")!;
            const ctx = createTemplateContext<TestContext, TestData>({ data: {} });
            const result = await step.evaluateSkip(ctx);
            expect(result.shouldSkip).toBe(false);
        });
    });

    describe("ConditionTemplate removed from public surface", () => {
        test("ConditionTemplate is NOT exported from @falai/agent", () => {
            // TypeScript compile-time enforcement + runtime check
            const exports = require("../src/index");
            expect(exports.ConditionTemplate).toBeUndefined();
        });
    });

    describe("Error cases", () => {
        test("if predicate throwing is handled gracefully (step not activated)", async () => {
            const agent = new Agent<TestContext, TestData>({
                name: "TestAgent",
                provider: MockProviderFactory.basic(),
            });

            const flow = agent.createFlow({
                title: "Error If Flow",
                steps: [
                    {
                        id: "s1",
                        prompt: "Hello",
                        if: () => { throw new Error("boom"); },
                    },
                ],
            });

            const step = flow.getStep("s1")!;
            const ctx = createTemplateContext<TestContext, TestData>({ data: {} });
            const result = await step.evaluateWhen(ctx);

            // Error in if → treated as false (not activated)
            expect(result.shouldActivate).toBe(false);
        });

        test("skip predicate throwing is handled gracefully (step not skipped)", async () => {
            const agent = new Agent<TestContext, TestData>({
                name: "TestAgent",
                provider: MockProviderFactory.basic(),
            });

            const flow = agent.createFlow({
                title: "Error Skip Flow",
                steps: [
                    {
                        id: "s1",
                        prompt: "Hello",
                        skip: () => { throw new Error("boom"); },
                    },
                ],
            });

            const step = flow.getStep("s1")!;
            const ctx = createTemplateContext<TestContext, TestData>({ data: {} });
            const result = await step.evaluateSkip(ctx);

            // Error in skip → treated as false (not skipped)
            expect(result.shouldSkip).toBe(false);
        });
    });
});
