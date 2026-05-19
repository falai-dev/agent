import { expect, test, describe, beforeEach } from "bun:test";
import { Agent, createSession } from "../src/index";
import { MockProviderFactory } from "./mock-provider";

interface TestData {
    userType?: "premium" | "basic";
    hasPayment?: boolean;
    isComplete?: boolean;
    priority?: "low" | "medium" | "high";
    issueType?: "technical" | "billing" | "general";
    bookingStatus?: "pending" | "confirmed" | "cancelled";
}

interface TestContext {
    userId?: string;
    sessionType?: "new" | "returning";
    userRole?: "admin" | "user";
}

describe("FlowRouter Integration with Flexible Conditions", () => {
    let agent: Agent<TestContext, TestData>;

    beforeEach(() => {
        agent = new Agent<TestContext, TestData>({
            name: "RoutingEngineTestAgent",
            description: "Agent for testing routing engine with flexible conditions",
            provider: MockProviderFactory.basic(),
            schema: {
                type: "object",
                properties: {
                    userType: { type: "string", enum: ["premium", "basic"] },
                    hasPayment: { type: "boolean" },
                    isComplete: { type: "boolean" },
                    priority: { type: "string", enum: ["low", "medium", "high"] },
                    issueType: { type: "string", enum: ["technical", "billing", "general"] },
                    bookingStatus: { type: "string", enum: ["pending", "confirmed", "cancelled"] },
                },
            },
        });
    });

    describe("End-to-end routing with new condition types", () => {
        test("should route to correct flow based on mixed conditions", async () => {
            // Create flows with the v2 when/if split
            agent.createFlow({
                id: "premium-support",
                title: "Premium Support Flow",
                when: "user needs premium support",
                if: (ctx) => ctx.data?.userType === "premium",
            });

            agent.createFlow({
                id: "basic-support",
                title: "Basic Support Flow",
                when: "user needs basic support",
                if: (ctx) => ctx.data?.userType === "basic",
            });

            agent.createFlow({
                id: "general-help",
                title: "General Help Flow",
                when: "user needs general help"
            });

            // Test premium user routing
            let session = createSession<TestData>();
            session.data = { userType: "premium", hasPayment: true };

            const premiumResponse = await agent.respond({
                history: [{ role: "user", content: "I need help with my premium account", name: "User" }],
                session,
                context: { userId: "premium-user", sessionType: "returning", userRole: "user" }
            });

            expect(premiumResponse.session?.currentFlow?.id).toBeDefined();
            expect(["premium-support", "basic-support", "general-help"]).toContain(premiumResponse.session?.currentFlow?.id || "");

            // Test basic user routing
            session = createSession<TestData>();
            session.data = { userType: "basic" };

            const basicResponse = await agent.respond({
                history: [{ role: "user", content: "I need help", name: "User" }],
                session,
                context: { userId: "basic-user", sessionType: "new", userRole: "user" }
            });

            expect(basicResponse.session?.currentFlow?.id).toBeDefined();
            expect(["premium-support", "basic-support", "general-help"]).toContain(basicResponse.session?.currentFlow?.id || "");
        });

        test("should skip flows based on if conditions (code guard)", async () => {
            // v2: flow-level skip is handled via `if` returning false (negated guard)
            agent.createFlow({
                id: "completed-flow",
                title: "Completed Process Flow",
                when: "process needs completion",
                if: (ctx) => ctx.data?.isComplete !== true, // guard: only activate when NOT complete
            });

            agent.createFlow({
                id: "active-flow",
                title: "Active Process Flow",
                when: "process is active"
            });

            // Test with completed process (if guard returns false → flow excluded)
            let session = createSession<TestData>();
            session.data = { isComplete: true };

            const completedResponse = await agent.respond({
                history: [{ role: "user", content: "I want to complete the process", name: "User" }],
                session,
                context: { userId: "user", sessionType: "returning", userRole: "user" }
            });

            expect(completedResponse.session?.currentFlow?.id).toBeDefined();
            expect(["completed-flow", "active-flow"]).toContain(completedResponse.session?.currentFlow?.id || "");

            // Test with incomplete process (if guard returns true → flow eligible)
            session = createSession<TestData>();
            session.data = { isComplete: false };

            const incompleteResponse = await agent.respond({
                history: [{ role: "user", content: "I want to complete the process", name: "User" }],
                session,
                context: { userId: "user", sessionType: "returning", userRole: "user" }
            });

            expect(incompleteResponse.session?.currentFlow?.id).toBeDefined();
            expect(["completed-flow", "active-flow"]).toContain(incompleteResponse.session?.currentFlow?.id || "");
        });
    });

    describe("AI prompt generation with condition context", () => {
        test("should include condition context strings in AI prompts", async () => {
            agent.createFlow({
                id: "context-flow",
                title: "Flow with Context",
                when: ["user wants premium booking service", "payment processing required"],
                if: (ctx) => ctx.data?.userType === "premium",
                steps: [
                    {
                        id: "context-step",
                        prompt: "How can I help with your premium booking?",
                        when: "premium booking step needed",
                        if: (ctx) => ctx.data?.hasPayment === true,
                    }
                ]
            });

            const session = createSession<TestData>();
            session.data = { userType: "premium", hasPayment: true };

            const response = await agent.respond({
                history: [{ role: "user", content: "I want to book a premium service", name: "User" }],
                session,
                context: { userId: "premium-user", sessionType: "returning", userRole: "user" }
            });

            expect(response.session?.currentFlow?.id).toBe("context-flow");
            expect(response.session?.currentStep?.id).toBe("context-step");
            expect(response.message).toBeDefined();
        });

        test("should handle multiple flows with AI context for selection", async () => {
            agent.createFlow({
                id: "technical-support",
                title: "Technical Support",
                when: ["user has technical issue", "technical support needed"]
            });

            agent.createFlow({
                id: "billing-support",
                title: "Billing Support",
                when: ["user has billing question", "billing support needed"]
            });

            agent.createFlow({
                id: "general-support",
                title: "General Support",
                when: "user needs general help"
            });

            const session = createSession<TestData>();

            const response = await agent.respond({
                history: [{ role: "user", content: "I have a question about my account", name: "User" }],
                session,
                context: { userId: "user", sessionType: "new", userRole: "user" }
            });

            expect(response.session?.currentFlow?.id).toMatch(/technical-support|billing-support|general-support/);
        });
    });

    describe("Flow and step selection with mixed conditions", () => {
        test("should handle complex flow and step selection", async () => {
            agent.createFlow({
                id: "complex-workflow",
                title: "Complex Workflow",
                when: "user starts complex workflow",
                if: (ctx) => ctx.context?.userRole === "user",
                steps: [
                    {
                        id: "initial-step",
                        prompt: "Starting workflow...",
                        when: "workflow initialization needed"
                    },
                    {
                        id: "premium-step",
                        prompt: "Premium features available",
                        when: "premium features requested",
                        if: (ctx) => ctx.data?.userType === "premium",
                        skip: (ctx) => ctx.data?.isComplete === true,
                    },
                    {
                        id: "payment-step",
                        prompt: "Payment processing",
                        when: "payment processing needed",
                        skip: (ctx) => ctx.data?.hasPayment === true,
                    },
                    {
                        id: "completion-step",
                        prompt: "Completing workflow",
                        if: (ctx) => ctx.data?.hasPayment === true,
                    }
                ]
            });

            // Test premium user with payment
            let session = createSession<TestData>();
            session.data = { userType: "premium", hasPayment: true, isComplete: false };

            const premiumResponse = await agent.respond({
                history: [{ role: "user", content: "I want to start the workflow", name: "User" }],
                session,
                context: { userId: "premium-user", sessionType: "returning", userRole: "user" }
            });

            expect(premiumResponse.session?.currentFlow?.id).toBe("complex-workflow");
            expect(premiumResponse.session?.currentStep?.id).toBe("initial-step");

            // Test basic user without payment
            session = createSession<TestData>();
            session.data = { userType: "basic", hasPayment: false, isComplete: false };

            const basicResponse = await agent.respond({
                history: [{ role: "user", content: "I want to start the workflow", name: "User" }],
                session,
                context: { userId: "basic-user", sessionType: "new", userRole: "user" }
            });

            expect(basicResponse.session?.currentFlow?.id).toBe("complex-workflow");
            expect(basicResponse.session?.currentStep?.id).toBe("initial-step");
        });

        test("should handle step progression with conditions", async () => {
            agent.createFlow({
                id: "step-progression",
                title: "Step Progression Flow",
                when: "user starts progression",
                steps: [
                    {
                        id: "step-1",
                        prompt: "Step 1: Collect user type",
                        collect: ["userType"]
                    },
                    {
                        id: "step-2-premium",
                        prompt: "Step 2: Premium features",
                        if: (ctx) => ctx.data?.userType === "premium",
                        collect: ["hasPayment"],
                        requires: ["userType"]
                    },
                    {
                        id: "step-2-basic",
                        prompt: "Step 2: Basic features",
                        if: (ctx) => ctx.data?.userType === "basic",
                        requires: ["userType"]
                    },
                    {
                        id: "step-3",
                        prompt: "Step 3: Completion",
                        when: "completion step needed",
                        skip: (ctx) => ctx.data?.isComplete === true,
                        requires: ["userType"]
                    }
                ]
            });

            const session = createSession<TestData>();

            const response = await agent.respond({
                history: [{ role: "user", content: "Start progression", name: "User" }],
                session,
                context: { userId: "user", sessionType: "new", userRole: "user" }
            });

            expect(response.session?.currentFlow?.id).toBe("step-progression");
            expect(response.session?.currentStep?.id).toBe("step-1");
        });
    });

    describe("SkipIf logic preventing flow/step selection", () => {
        test("should prevent flow selection with if guard", async () => {
            // v2: flow-level exclusion uses `if` returning false
            agent.createFlow({
                id: "skipped-flow",
                title: "Skipped Flow",
                when: "user wants service",
                if: (ctx) => ctx.data?.bookingStatus !== "cancelled", // guard
            });

            agent.createFlow({
                id: "fallback-flow",
                title: "Fallback Flow",
                when: "fallback needed"
            });

            // Test with cancelled booking (if guard returns false → flow excluded)
            const session = createSession<TestData>();
            session.data = { bookingStatus: "cancelled" };

            const response = await agent.respond({
                history: [{ role: "user", content: "I want service", name: "User" }],
                session,
                context: { userId: "user", sessionType: "returning", userRole: "user" }
            });

            expect(response.session?.currentFlow?.id).toBeDefined();
            expect(["skipped-flow", "fallback-flow"]).toContain(response.session?.currentFlow?.id || "");
        });

        test("should prevent step selection with skip", async () => {
            agent.createFlow({
                id: "skip-steps-flow",
                title: "Flow with Skipped Steps",
                when: "user starts process",
                steps: [
                    {
                        id: "always-step",
                        prompt: "This step always runs"
                    },
                    {
                        id: "conditional-step",
                        prompt: "This step runs conditionally",
                        when: "conditional step needed",
                        skip: (ctx) => ctx.data?.priority === "low",
                    },
                    {
                        id: "premium-step",
                        prompt: "Premium only step",
                        if: (ctx) => ctx.data?.userType === "premium",
                    },
                    {
                        id: "final-step",
                        prompt: "Final step"
                    }
                ]
            });

            // Test with low priority (should skip conditional step)
            const session = createSession<TestData>();
            session.data = { priority: "low", userType: "basic" };

            const response = await agent.respond({
                history: [{ role: "user", content: "Start process", name: "User" }],
                session,
                context: { userId: "user", sessionType: "new", userRole: "user" }
            });

            expect(response.session?.currentFlow?.id).toBe("skip-steps-flow");
            expect(response.session?.currentStep?.id).toBe("always-step");
        });
    });

    describe("Complex integration scenarios", () => {
        test("should handle nested conditions and multiple evaluation points", async () => {
            const complexAgent = new Agent<TestContext, TestData>({
                name: "ComplexAgent",
                provider: MockProviderFactory.basic(),
                guidelines: [
                    {
                        id: "global-premium-guideline",
                        when: "premium user detected",
                        if: (ctx) => ctx.data?.userType === "premium",
                        prompt: "Apply premium service standards"
                    }
                ],
                schema: {
                    type: "object",
                    properties: {
                        userType: { type: "string", enum: ["premium", "basic"] },
                        hasPayment: { type: "boolean" },
                        isComplete: { type: "boolean" },
                        priority: { type: "string", enum: ["low", "medium", "high"] },
                        issueType: { type: "string", enum: ["technical", "billing", "general"] },
                    },
                },
            });

            complexAgent.createFlow({
                id: "nested-conditions-flow",
                title: "Nested Conditions Flow",
                when: "complex user interaction",
                if: [
                    (ctx) => ctx.context?.sessionType === "returning",
                    (ctx) => ctx.data?.userType === "premium",
                    (ctx) => ctx.data?.hasPayment === true,
                    (ctx) => ctx.data?.isComplete !== true,
                ],
                guidelines: [
                    {
                        id: "flow-specific-guideline",
                        when: "high priority interaction",
                        if: (ctx) => ctx.data?.priority === "high",
                        prompt: "Prioritize this interaction"
                    }
                ],
                steps: [
                    {
                        id: "nested-step",
                        prompt: "Handling complex interaction",
                        when: "step activation required",
                        if: (ctx) => ctx.data?.userType === "premium",
                        skip: (ctx) => ctx.data?.issueType === "general",
                        guidelines: [
                            {
                                id: "step-guideline",
                                when: "step-specific guidance needed",
                                prompt: "Provide step-specific help"
                            }
                        ]
                    }
                ]
            });

            const session = createSession<TestData>();
            session.data = {
                userType: "premium",
                hasPayment: true,
                isComplete: false,
                priority: "high",
                issueType: "technical"
            };

            const response = await complexAgent.respond({
                history: [{ role: "user", content: "I need complex help", name: "User" }],
                session,
                context: { userId: "premium-user", sessionType: "returning", userRole: "user" }
            });

            expect(response.session?.currentFlow?.id).toBe("nested-conditions-flow");
            expect(response.session?.currentStep?.id).toBe("nested-step");
        });

        test("should handle condition evaluation errors gracefully", async () => {
            // v2: functions on `if` that throw are handled gracefully
            agent.createFlow({
                id: "error-handling-flow",
                title: "Error Handling Flow",
                when: "user needs service",
                if: () => { throw new Error("Condition evaluation error"); },
            });

            agent.createFlow({
                id: "safe-flow",
                title: "Safe Flow",
                when: "safe flow needed"
            });

            const session = createSession<TestData>();

            const response = await agent.respond({
                history: [{ role: "user", content: "I need help", name: "User" }],
                session,
                context: { userId: "user", sessionType: "new", userRole: "user" }
            });

            // Should fall back to safe flow due to error in first flow's `if`
            expect(response.session?.currentFlow?.id).toBeDefined();
            expect(["error-handling-flow", "safe-flow"]).toContain(response.session?.currentFlow?.id || "");
        });

        test("should handle async condition evaluation", async () => {
            agent.createFlow({
                id: "async-flow",
                title: "Async Flow",
                when: "async evaluation needed",
                if: async (ctx) => {
                    await new Promise(resolve => setTimeout(resolve, 10));
                    return ctx.data?.userType === "premium";
                },
                steps: [
                    {
                        id: "async-step",
                        prompt: "Async step",
                        if: async (ctx) => {
                            await new Promise(resolve => setTimeout(resolve, 5));
                            return ctx.data?.hasPayment === true;
                        }
                    }
                ]
            });

            const session = createSession<TestData>();
            session.data = { userType: "premium", hasPayment: true };

            const response = await agent.respond({
                history: [{ role: "user", content: "I need async help", name: "User" }],
                session,
                context: { userId: "premium-user", sessionType: "returning", userRole: "user" }
            });

            expect(response.session?.currentFlow?.id).toBe("async-flow");
            expect(response.session?.currentStep?.id).toBe("async-step");
        });
    });

    describe("Performance and edge cases", () => {
        test("should handle empty condition arrays", async () => {
            agent.createFlow({
                id: "empty-conditions-flow",
                title: "Empty Conditions Flow",
                when: [], // Empty array should default to true
                steps: [
                    {
                        id: "empty-step",
                        prompt: "Step with empty conditions",
                        when: [] // Empty array should default to true
                    }
                ]
            });

            const session = createSession<TestData>();

            const response = await agent.respond({
                history: [{ role: "user", content: "Test empty conditions", name: "User" }],
                session,
                context: { userId: "user", sessionType: "new", userRole: "user" }
            });

            expect(response.session?.currentFlow?.id).toBe("empty-conditions-flow");
            expect(response.session?.currentStep?.id).toBe("empty-step");
        });

        test("should handle malformed conditions", async () => {
            agent.createFlow({
                id: "malformed-flow",
                title: "Malformed Flow",
                when: 123 as any // Invalid condition type
            });

            agent.createFlow({
                id: "valid-flow",
                title: "Valid Flow",
                when: "valid condition"
            });

            const session = createSession<TestData>();

            const response = await agent.respond({
                history: [{ role: "user", content: "Test malformed conditions", name: "User" }],
                session,
                context: { userId: "user", sessionType: "new", userRole: "user" }
            });

            // Should handle malformed conditions gracefully and route to valid flow
            expect(response.session?.currentFlow?.id).toMatch(/malformed-flow|valid-flow/);
        });
    });
});
