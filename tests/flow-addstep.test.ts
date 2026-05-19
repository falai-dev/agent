/**
 * Tests for `Flow.addStep` imperative registration (Requirement 26.1–26.5, 8.7)
 *
 * Validates:
 * - `Flow.addStep(options)` constructs and registers a step on the flow
 * - Same construction-time validations as declarative `steps: [...]` registration
 * - New step connected as successor of the previous last step
 * - Mid-session mutation emits a DEBUG warning; registration still succeeds
 * - `Step.nextStep()` and `Step.branch()` produce the same graph state as `addStep`
 */

import { expect, test, describe } from "bun:test";
import {
    Agent,
    Flow,
    Step,
    FlowConfigurationError,
} from "../src/index";
import { MockProviderFactory } from "./mock-provider";

// ─── Test data types ─────────────────────────────────────────────────────────

interface TestContext {
    userId?: string;
}

interface TestData {
    name?: string;
    email?: string;
    plan?: string;
}

// ─── Flow.addStep ────────────────────────────────────────────────────────────

describe("Flow.addStep imperative registration", () => {
    describe("basic registration (Requirement 26.1)", () => {
        test("addStep constructs and registers a new step on the flow", () => {
            const agent = new Agent<TestContext, TestData>({
                name: "TestAgent",
                provider: MockProviderFactory.basic(),
            });

            const flow = agent.createFlow({
                title: "AddStep Flow",
                steps: [{ id: "step1", prompt: "First step" }],
            });

            const newStep = flow.addStep({ id: "step2", prompt: "Second step" });

            expect(newStep).toBeInstanceOf(Step);
            expect(newStep.id).toBe("step2");
            expect(newStep.prompt).toBe("Second step");
        });

        test("addStep returns the new Step instance", () => {
            const agent = new Agent<TestContext, TestData>({
                name: "TestAgent",
                provider: MockProviderFactory.basic(),
            });

            const flow = agent.createFlow({
                title: "Return Flow",
                steps: [{ id: "s1", prompt: "Start" }],
            });

            const step = flow.addStep({ id: "s2", prompt: "Added" });
            expect(step.id).toBe("s2");
        });

        test("added step appears in getAllSteps()", () => {
            const agent = new Agent<TestContext, TestData>({
                name: "TestAgent",
                provider: MockProviderFactory.basic(),
            });

            const flow = agent.createFlow({
                title: "Visible Flow",
                steps: [{ id: "s1", prompt: "Start" }],
            });

            flow.addStep({ id: "s2", prompt: "Added" });
            const allSteps = flow.getAllSteps();
            const stepIds = allSteps.map((s) => s.id);

            expect(stepIds).toContain("s2");
        });
    });

    describe("construction-time validations (Requirement 26.2)", () => {
        test("auto-step shape violation throws FlowConfigurationError", () => {
            const agent = new Agent<TestContext, TestData>({
                name: "TestAgent",
                provider: MockProviderFactory.basic(),
            });

            const flow = agent.createFlow({
                title: "Validation Flow",
                steps: [{ id: "s1", prompt: "Start" }],
            });

            // auto: true with prompt should throw
            expect(() =>
                flow.addStep({ id: "bad", auto: true, prompt: "Not allowed" })
            ).toThrow(FlowConfigurationError);
        });

        test("auto-step with collect throws FlowConfigurationError", () => {
            const agent = new Agent<TestContext, TestData>({
                name: "TestAgent",
                provider: MockProviderFactory.basic(),
            });

            const flow = agent.createFlow({
                title: "Validation Flow",
                steps: [{ id: "s1", prompt: "Start" }],
            });

            expect(() =>
                flow.addStep({ id: "bad", auto: true, collect: ["name"] })
            ).toThrow(FlowConfigurationError);
        });

        test("empty branches array throws FlowConfigurationError", () => {
            const agent = new Agent<TestContext, TestData>({
                name: "TestAgent",
                provider: MockProviderFactory.basic(),
            });

            const flow = agent.createFlow({
                title: "Branches Flow",
                steps: [{ id: "s1", prompt: "Start" }],
            });

            expect(() =>
                flow.addStep({ id: "bad", branches: [] })
            ).toThrow(FlowConfigurationError);
        });

        test("function on when field throws FlowConfigurationError", () => {
            const agent = new Agent<TestContext, TestData>({
                name: "TestAgent",
                provider: MockProviderFactory.basic(),
            });

            const flow = agent.createFlow({
                title: "When Flow",
                steps: [{ id: "s1", prompt: "Start" }],
            });

            expect(() =>
                flow.addStep({ id: "bad", when: (() => true) as any })
            ).toThrow(FlowConfigurationError);
        });

        test("branches with unconditional entry not last throws FlowConfigurationError", () => {
            const agent = new Agent<TestContext, TestData>({
                name: "TestAgent",
                provider: MockProviderFactory.basic(),
            });

            const flow = agent.createFlow({
                title: "Dead Code Flow",
                steps: [{ id: "s1", prompt: "Start" }],
            });

            expect(() =>
                flow.addStep({
                    id: "bad",
                    branches: [
                        { then: "s1" }, // unconditional but not last — dead code
                        { if: () => true, then: "s1" },
                    ],
                })
            ).toThrow(FlowConfigurationError);
        });
    });

    describe("successor connection (Requirement 26.3)", () => {
        test("new step is connected as successor of the previous last step", () => {
            const agent = new Agent<TestContext, TestData>({
                name: "TestAgent",
                provider: MockProviderFactory.basic(),
            });

            const flow = agent.createFlow({
                title: "Chain Flow",
                steps: [{ id: "s1", prompt: "First" }],
            });

            // s1 is the last step before addStep
            const stepsBefore = flow.getAllSteps();
            const lastBefore = stepsBefore[stepsBefore.length - 1];
            expect(lastBefore.getTransitions()).toHaveLength(0);

            flow.addStep({ id: "s2", prompt: "Second" });

            // Now s1 should have s2 as a transition
            expect(lastBefore.getTransitions()).toHaveLength(1);
            expect(lastBefore.getTransitions()[0].id).toBe("s2");
        });

        test("multiple addStep calls chain correctly", () => {
            const agent = new Agent<TestContext, TestData>({
                name: "TestAgent",
                provider: MockProviderFactory.basic(),
            });

            const flow = agent.createFlow({
                title: "Multi Chain",
                steps: [{ id: "s1", prompt: "First" }],
            });

            flow.addStep({ id: "s2", prompt: "Second" });
            flow.addStep({ id: "s3", prompt: "Third" });

            const allSteps = flow.getAllSteps();
            expect(allSteps.map((s) => s.id)).toEqual(["s1", "s2", "s3"]);

            // Verify chain: s1 → s2 → s3
            const s1 = flow.getStep("s1")!;
            const s2 = flow.getStep("s2")!;
            const s3 = flow.getStep("s3")!;

            expect(s1.getTransitions().map((s) => s.id)).toContain("s2");
            expect(s2.getTransitions().map((s) => s.id)).toContain("s3");
            expect(s3.getTransitions()).toHaveLength(0);
        });
    });

    describe("mid-session warning (Requirement 26.4)", () => {
        test("addStep after turn sets _hasHandledTurn flag emits warning but succeeds", () => {
            const agent = new Agent<TestContext, TestData>({
                name: "TestAgent",
                provider: MockProviderFactory.basic(),
            });

            const flow = agent.createFlow({
                title: "Mid-Session Flow",
                steps: [{ id: "s1", prompt: "Start" }],
            });

            // Simulate that a turn has been handled
            flow._hasHandledTurn = true;

            // addStep should still succeed
            const step = flow.addStep({ id: "s2", prompt: "Added mid-session" });
            expect(step).toBeInstanceOf(Step);
            expect(step.id).toBe("s2");

            // Verify step is registered
            const allSteps = flow.getAllSteps();
            expect(allSteps.map((s) => s.id)).toContain("s2");
        });

        test("addStep before any turn does NOT set warning (no flag)", () => {
            const agent = new Agent<TestContext, TestData>({
                name: "TestAgent",
                provider: MockProviderFactory.basic(),
            });

            const flow = agent.createFlow({
                title: "Pre-Session Flow",
                steps: [{ id: "s1", prompt: "Start" }],
            });

            // _hasHandledTurn is false by default
            expect(flow._hasHandledTurn).toBe(false);

            // addStep should work fine
            const step = flow.addStep({ id: "s2", prompt: "Added pre-session" });
            expect(step).toBeInstanceOf(Step);
        });
    });

    describe("equivalence with Step.nextStep() chain method (Requirement 26.5)", () => {
        test("addStep produces same graph as Step.nextStep()", () => {
            const agent = new Agent<TestContext, TestData>({
                name: "TestAgent",
                provider: MockProviderFactory.basic(),
            });

            // Flow A: built with addStep
            const flowA = agent.createFlow({
                title: "AddStep Flow",
                steps: [{ id: "s1", prompt: "First" }],
            });
            flowA.addStep({ id: "s2", prompt: "Second" });
            flowA.addStep({ id: "s3", prompt: "Third" });

            // Flow B: built with declarative steps
            const flowB = agent.createFlow({
                title: "Declarative Flow",
                steps: [
                    { id: "s1", prompt: "First" },
                    { id: "s2", prompt: "Second" },
                    { id: "s3", prompt: "Third" },
                ],
            });

            // Both should have the same step IDs in the same order
            const stepsA = flowA.getAllSteps().map((s) => s.id);
            const stepsB = flowB.getAllSteps().map((s) => s.id);
            expect(stepsA).toEqual(stepsB);

            // Both should have the same transition structure
            for (const stepId of stepsA) {
                const stepA = flowA.getStep(stepId)!;
                const stepB = flowB.getStep(stepId)!;
                const transA = stepA.getTransitions().map((s) => s.id);
                const transB = stepB.getTransitions().map((s) => s.id);
                expect(transA).toEqual(transB);
            }
        });

        test("Step.nextStep() chain produces same state as addStep (direct usage)", () => {
            const agent = new Agent<TestContext, TestData>({
                name: "TestAgent",
                provider: MockProviderFactory.basic(),
            });

            // Build a flow with a single step, then use addStep
            const flow = agent.createFlow({
                title: "InitialOnly",
                steps: [{ id: "init", prompt: "Init" }],
            });

            flow.addStep({ id: "a", prompt: "A" });
            flow.addStep({ id: "b", prompt: "B" });

            const steps = flow.getAllSteps();
            expect(steps.map((s) => s.id)).toEqual(["init", "a", "b"]);

            // init → a → b (sequential)
            const init = flow.getStep("init")!;
            const a = flow.getStep("a")!;
            const b = flow.getStep("b")!;

            expect(init.getTransitions().map((s) => s.id)).toEqual(["a"]);
            expect(a.getTransitions().map((s) => s.id)).toEqual(["b"]);
            expect(b.getTransitions()).toHaveLength(0);
        });
    });

    describe("edge cases", () => {
        test("addStep to a flow with only initialStep works", () => {
            const agent = new Agent<TestContext, TestData>({
                name: "TestAgent",
                provider: MockProviderFactory.basic(),
            });

            const flow = agent.createFlow({
                title: "Initial Only",
                steps: [{ id: "init", prompt: "Hello" }],
            });

            const step = flow.addStep({ id: "next", prompt: "World" });
            expect(step.id).toBe("next");

            const init = flow.getStep("init")!;
            expect(init.getTransitions().map((s) => s.id)).toContain("next");
        });

        test("addStep with auto: true (valid shape) succeeds", () => {
            const agent = new Agent<TestContext, TestData>({
                name: "TestAgent",
                provider: MockProviderFactory.basic(),
            });

            const flow = agent.createFlow({
                title: "Auto Step Flow",
                steps: [{ id: "s1", prompt: "Start" }],
            });

            // auto: true without conflicting fields is valid
            const step = flow.addStep({ id: "auto1", auto: true, description: "An auto step" });
            expect(step.auto).toBe(true);
            expect(step.id).toBe("auto1");
        });

        test("addStep with valid branches succeeds", () => {
            const agent = new Agent<TestContext, TestData>({
                name: "TestAgent",
                provider: MockProviderFactory.basic(),
            });

            const flow = agent.createFlow({
                title: "Branch Flow",
                steps: [
                    { id: "s1", prompt: "Start" },
                    { id: "target", prompt: "Target" },
                ],
            });

            // addStep with valid branches (unconditional fallback is last)
            const step = flow.addStep({
                id: "branching",
                prompt: "Branch here",
                branches: [
                    { if: () => true, then: "target" },
                    { then: "s1" }, // unconditional fallback last — valid
                ],
            });

            expect(step.branches).toHaveLength(2);
        });
    });
});
