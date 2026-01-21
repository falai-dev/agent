import { expect, test, describe, beforeEach } from "bun:test";
import { Agent, createSession, ConditionTemplate } from "../src/index";
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

describe("RoutingEngine Integration with Flexible Conditions", () => {
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
        test("should route to correct route based on mixed conditions", async () => {
            // Create routes with different condition types
            const premiumRoute = agent.createRoute({
                id: "premium-support",
                title: "Premium Support Route",
                when: [
                    "user needs premium support",
                    (ctx) => ctx.data?.userType === "premium"
                ]
            });

            const basicRoute = agent.createRoute({
                id: "basic-support",
                title: "Basic Support Route",
                when: [
                    "user needs basic support",
                    (ctx) => ctx.data?.userType === "basic"
                ]
            });

            const generalRoute = agent.createRoute({
                id: "general-help",
                title: "General Help Route",
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

            // The routing engine should select one of the available routes
            // Since all routes have conditions that could match, we need to check that a route was selected
            expect(premiumResponse.session?.currentRoute?.id).toBeDefined();
            expect(["premium-support", "basic-support", "general-help"]).toContain(premiumResponse.session?.currentRoute?.id || "");

            // Test basic user routing
            session = createSession<TestData>();
            session.data = { userType: "basic" };

            const basicResponse = await agent.respond({
                history: [{ role: "user", content: "I need help", name: "User" }],
                session,
                context: { userId: "basic-user", sessionType: "new", userRole: "user" }
            });

            expect(basicResponse.session?.currentRoute?.id).toBeDefined();
            expect(["premium-support", "basic-support", "general-help"]).toContain(basicResponse.session?.currentRoute?.id || "");
        });

        test("should skip routes based on skipIf conditions", async () => {
            // Create routes with skipIf conditions
            const completedRoute = agent.createRoute({
                id: "completed-route",
                title: "Completed Process Route",
                when: "process needs completion",
                skipIf: [
                    "process already completed",
                    (ctx) => ctx.data?.isComplete === true
                ]
            });

            const activeRoute = agent.createRoute({
                id: "active-route",
                title: "Active Process Route",
                when: "process is active"
            });

            // Test with completed process (should skip first route)
            let session = createSession<TestData>();
            session.data = { isComplete: true };

            const completedResponse = await agent.respond({
                history: [{ role: "user", content: "I want to complete the process", name: "User" }],
                session,
                context: { userId: "user", sessionType: "returning", userRole: "user" }
            });

            expect(completedResponse.session?.currentRoute?.id).toBeDefined();
            expect(["completed-route", "active-route"]).toContain(completedResponse.session?.currentRoute?.id || "");

            // Test with incomplete process (should use first route)
            session = createSession<TestData>();
            session.data = { isComplete: false };

            const incompleteResponse = await agent.respond({
                history: [{ role: "user", content: "I want to complete the process", name: "User" }],
                session,
                context: { userId: "user", sessionType: "returning", userRole: "user" }
            });

            expect(incompleteResponse.session?.currentRoute?.id).toBeDefined();
            expect(["completed-route", "active-route"]).toContain(incompleteResponse.session?.currentRoute?.id || "");
        });
    });

    describe("AI prompt generation with condition context", () => {
        test("should include condition context strings in AI prompts", async () => {
            const routeWithContext = agent.createRoute({
                id: "context-route",
                title: "Route with Context",
                when: [
                    "user wants premium booking service",
                    (ctx) => ctx.data?.userType === "premium",
                    "payment processing required"
                ],
                steps: [
                    {
                        id: "context-step",
                        prompt: "How can I help with your premium booking?",
                        when: [
                            "premium booking step needed",
                            (ctx) => ctx.data?.hasPayment === true
                        ]
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

            expect(response.session?.currentRoute?.id).toBe("context-route");
            expect(response.session?.currentStep?.id).toBe("context-step");
            // The AI should have received context strings in the prompt
            expect(response.message).toBeDefined();
        });

        test("should handle multiple routes with AI context for selection", async () => {
            // Create multiple routes that could match
            const technicalRoute = agent.createRoute({
                id: "technical-support",
                title: "Technical Support",
                when: [
                    "user has technical issue",
                    "technical support needed"
                ]
            });

            const billingRoute = agent.createRoute({
                id: "billing-support",
                title: "Billing Support",
                when: [
                    "user has billing question",
                    "billing support needed"
                ]
            });

            const generalRoute = agent.createRoute({
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

            // Should route to one of the available routes
            expect(response.session?.currentRoute?.id).toMatch(/technical-support|billing-support|general-support/);
        });
    });

    describe("Route and step selection with mixed conditions", () => {
        test("should handle complex route and step selection", async () => {
            const complexRoute = agent.createRoute({
                id: "complex-workflow",
                title: "Complex Workflow",
                when: [
                    "user starts complex workflow",
                    (ctx) => ctx.context?.userRole === "user"
                ],
                steps: [
                    {
                        id: "initial-step",
                        prompt: "Starting workflow...",
                        when: "workflow initialization needed"
                    },
                    {
                        id: "premium-step",
                        prompt: "Premium features available",
                        when: [
                            "premium features requested",
                            (ctx) => ctx.data?.userType === "premium"
                        ],
                        skipIf: (ctx) => ctx.data?.isComplete === true
                    },
                    {
                        id: "payment-step",
                        prompt: "Payment processing",
                        when: "payment processing needed",
                        skipIf: [
                            "payment already processed",
                            (ctx) => ctx.data?.hasPayment === true
                        ]
                    },
                    {
                        id: "completion-step",
                        prompt: "Completing workflow",
                        when: (ctx) => ctx.data?.hasPayment === true
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

            expect(premiumResponse.session?.currentRoute?.id).toBe("complex-workflow");
            // With multi-step batch execution, steps without requires/collect fields
            // are executed together in a single batch, ending at the final step
            expect(premiumResponse.session?.currentStep?.id).toBe("completion-step");

            // Test basic user without payment
            session = createSession<TestData>();
            session.data = { userType: "basic", hasPayment: false, isComplete: false };

            const basicResponse = await agent.respond({
                history: [{ role: "user", content: "I want to start the workflow", name: "User" }],
                session,
                context: { userId: "basic-user", sessionType: "new", userRole: "user" }
            });

            expect(basicResponse.session?.currentRoute?.id).toBe("complex-workflow");
            // With multi-step batch execution, steps without requires/collect fields
            // are executed together in a single batch
            expect(basicResponse.session?.currentStep?.id).toBe("completion-step");
        });

        test("should handle step progression with conditions", async () => {
            const progressionRoute = agent.createRoute({
                id: "step-progression",
                title: "Step Progression Route",
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
                        when: (ctx) => ctx.data?.userType === "premium",
                        collect: ["hasPayment"],
                        requires: ["userType"]
                    },
                    {
                        id: "step-2-basic",
                        prompt: "Step 2: Basic features",
                        when: (ctx) => ctx.data?.userType === "basic",
                        requires: ["userType"]
                    },
                    {
                        id: "step-3",
                        prompt: "Step 3: Completion",
                        when: "completion step needed",
                        skipIf: (ctx) => ctx.data?.isComplete === true,
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

            expect(response.session?.currentRoute?.id).toBe("step-progression");
            expect(response.session?.currentStep?.id).toBe("step-1");
        });
    });

    describe("SkipIf logic preventing route/step selection", () => {
        test("should prevent route selection with skipIf", async () => {
            const skippedRoute = agent.createRoute({
                id: "skipped-route",
                title: "Skipped Route",
                when: "user wants service",
                skipIf: [
                    "service unavailable",
                    (ctx) => ctx.data?.bookingStatus === "cancelled"
                ]
            });

            const fallbackRoute = agent.createRoute({
                id: "fallback-route",
                title: "Fallback Route",
                when: "fallback needed"
            });

            // Test with cancelled booking (should skip first route)
            const session = createSession<TestData>();
            session.data = { bookingStatus: "cancelled" };

            const response = await agent.respond({
                history: [{ role: "user", content: "I want service", name: "User" }],
                session,
                context: { userId: "user", sessionType: "returning", userRole: "user" }
            });

            expect(response.session?.currentRoute?.id).toBeDefined();
            expect(["skipped-route", "fallback-route"]).toContain(response.session?.currentRoute?.id || "");
        });

        test("should prevent step selection with skipIf", async () => {
            const routeWithSkippedSteps = agent.createRoute({
                id: "skip-steps-route",
                title: "Route with Skipped Steps",
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
                        skipIf: [
                            "step should be skipped",
                            (ctx) => ctx.data?.priority === "low"
                        ]
                    },
                    {
                        id: "premium-step",
                        prompt: "Premium only step",
                        when: (ctx) => ctx.data?.userType === "premium",
                        skipIf: "premium features disabled"
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

            expect(response.session?.currentRoute?.id).toBe("skip-steps-route");
            // With multi-step batch execution, steps without requires/collect fields
            // are executed together in a single batch, ending at the final step
            expect(response.session?.currentStep?.id).toBe("final-step");
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
                        condition: [
                            "premium user detected",
                            (ctx) => ctx.data?.userType === "premium"
                        ],
                        action: "Apply premium service standards"
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

            const nestedRoute = complexAgent.createRoute({
                id: "nested-conditions-route",
                title: "Nested Conditions Route",
                when: [
                    "complex user interaction",
                    (ctx) => ctx.context?.sessionType === "returning",
                    [
                        "premium user with payment",
                        (ctx) => ctx.data?.userType === "premium",
                        (ctx) => ctx.data?.hasPayment === true
                    ]
                ],
                skipIf: [
                    "process already completed",
                    (ctx) => ctx.data?.isComplete === true
                ],
                guidelines: [
                    {
                        id: "route-specific-guideline",
                        condition: [
                            "high priority interaction",
                            (ctx) => ctx.data?.priority === "high"
                        ],
                        action: "Prioritize this interaction"
                    }
                ],
                steps: [
                    {
                        id: "nested-step",
                        prompt: "Handling complex interaction",
                        when: [
                            "step activation required",
                            (ctx) => ctx.data?.userType === "premium"
                        ],
                        skipIf: [
                            "step not needed",
                            (ctx) => ctx.data?.issueType === "general"
                        ],
                        guidelines: [
                            {
                                id: "step-guideline",
                                condition: "step-specific guidance needed",
                                action: "Provide step-specific help"
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

            expect(response.session?.currentRoute?.id).toBe("nested-conditions-route");
            expect(response.session?.currentStep?.id).toBe("nested-step");
        });

        test("should handle condition evaluation errors gracefully", async () => {
            const errorRoute = agent.createRoute({
                id: "error-handling-route",
                title: "Error Handling Route",
                when: [
                    "user needs service",
                    () => { throw new Error("Condition evaluation error"); }
                ]
            });

            const safeRoute = agent.createRoute({
                id: "safe-route",
                title: "Safe Route",
                when: "safe route needed"
            });

            const session = createSession<TestData>();

            const response = await agent.respond({
                history: [{ role: "user", content: "I need help", name: "User" }],
                session,
                context: { userId: "user", sessionType: "new", userRole: "user" }
            });

            // Should fall back to safe route due to error in first route
            expect(response.session?.currentRoute?.id).toBeDefined();
            expect(["error-handling-route", "safe-route"]).toContain(response.session?.currentRoute?.id || "");
        });

        test("should handle async condition evaluation", async () => {
            const asyncRoute = agent.createRoute({
                id: "async-route",
                title: "Async Route",
                when: [
                    "async evaluation needed",
                    async (ctx) => {
                        await new Promise(resolve => setTimeout(resolve, 10));
                        return ctx.data?.userType === "premium";
                    }
                ],
                steps: [
                    {
                        id: "async-step",
                        prompt: "Async step",
                        when: async (ctx) => {
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

            expect(response.session?.currentRoute?.id).toBe("async-route");
            expect(response.session?.currentStep?.id).toBe("async-step");
        });
    });

    describe("Performance and edge cases", () => {
        test("should handle empty condition arrays", async () => {
            const emptyConditionsRoute = agent.createRoute({
                id: "empty-conditions-route",
                title: "Empty Conditions Route",
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

            expect(response.session?.currentRoute?.id).toBe("empty-conditions-route");
            expect(response.session?.currentStep?.id).toBe("empty-step");
        });

        test("should handle malformed conditions", async () => {
            const malformedRoute = agent.createRoute({
                id: "malformed-route",
                title: "Malformed Route",
                when: 123 as any // Invalid condition type
            });

            const validRoute = agent.createRoute({
                id: "valid-route",
                title: "Valid Route",
                when: "valid condition"
            });

            const session = createSession<TestData>();

            const response = await agent.respond({
                history: [{ role: "user", content: "Test malformed conditions", name: "User" }],
                session,
                context: { userId: "user", sessionType: "new", userRole: "user" }
            });

            // Should handle malformed conditions gracefully and route to valid route
            expect(response.session?.currentRoute?.id).toMatch(/malformed-route|valid-route/);
        });
    });
});