import { describe, expect, test } from "bun:test";
import { Agent } from "../src";
import { MockProviderFactory } from "./mock-provider";

interface DemoData {
    username: string;
}

describe("Route Completion Fix", () => {
    test("route should NOT complete immediately simply because data is already satisfied", async () => {
        const agent = new Agent<unknown, DemoData>({
            name: "Routing Fix Demo Agent",
            provider: MockProviderFactory.basic(),
            schema: {
                type: "object",
                properties: {
                    username: { type: "string" },
                },
            }
        });

        // Create a route that requires 'username', but also has two distinct conversational steps before ending.
        const route = agent.createRoute({
            title: "Flow Route",
            requiredFields: ["username"],
            initialData: {
                username: "TestUser", // Providing the required data immediately!
            }
        });

        const step1 = route.initialStep.nextStep({
            id: "hello_step",
            prompt: "Say hello",
        });

        const step2 = step1.nextStep({
            id: "how_are_you_step",
            prompt: "Say how are you",
        });

        step2.endRoute();

        // Turn 1
        const response1 = await agent.respond({
            history: [{ role: "user", content: "Start" }]
        });

        // Before the fix: this would return isRouteComplete = true immediately.
        // After the fix: it progresses to "hello_step".
        expect(response1.isRouteComplete).toBe(false);
        expect(response1.session?.currentStep?.id).toBe(route.initialStep.id);

        // Turn 2
        const response2 = await agent.respond({
            history: [
                { role: "user", content: "Start" },
                { role: "assistant", content: response1.message },
                { role: "user", content: "Hi" }
            ],
            session: response1.session
        });

        // Should progress to "hello_step".
        expect(response2.isRouteComplete).toBe(false);
        expect(response2.session?.currentStep?.id).toBe("hello_step");

        // Turn 3
        const response3 = await agent.respond({
            history: [
                { role: "user", content: "Start" },
                { role: "assistant", content: response1.message },
                { role: "user", content: "Hi" },
                { role: "assistant", content: response2.message },
                { role: "user", content: "Good" }
            ],
            session: response2.session
        });

        // Should progress to "how_are_you_step".
        expect(response3.isRouteComplete).toBe(false);
        expect(response3.session?.currentStep?.id).toBe("how_are_you_step");

        // Turn 4
        const response4 = await agent.respond({
            history: [
                { role: "user", content: "Start" },
                { role: "assistant", content: response1.message },
                { role: "user", content: "Hi" },
                { role: "assistant", content: response2.message },
                { role: "user", content: "Good" },
                { role: "assistant", content: response3.message },
                { role: "user", content: "Great" }
            ],
            session: response3.session
        });

        // NOW it hit END_ROUTE
        expect(response4.isRouteComplete).toBe(true);
    });
});
