/**
 * Tests for the createAgent factory function.
 *
 * **Validates: Requirements 14.1–14.7**
 */
import { describe, test, expect } from "bun:test";
import { createAgent, Agent } from "../src/index";

// Minimal mock provider for testing
const mockProvider = {
    generateMessage: async () => ({
        content: "test",
        history: [],
        tokenUsage: { input: 0, output: 0 },
        toolCalls: [],
        refusal: null,
    }),
    supportsStreaming: false,
    supportsToolCalling: false,
    model: "test",
};

describe("createAgent factory", () => {
    test("should create an Agent instance from options (Requirement 14.1)", () => {
        const agent = createAgent({
            name: "TestBot",
            provider: mockProvider as any,
        });

        expect(agent).toBeInstanceOf(Agent);
        expect(agent.name).toBe("TestBot");
    });

    test("should accept schema, provider, instructions, and flows (Requirement 14.2)", () => {
        const agent = createAgent({
            name: "SchemaBot",
            provider: mockProvider as any,
            schema: {
                type: "object",
                properties: {
                    name: { type: "string", description: "User name" },
                    email: { type: "string", description: "User email" },
                },
                required: ["name", "email"],
            },
            instructions: [
                { kind: "must", prompt: "Always greet the user" },
            ],
            flows: [
                {
                    title: "Onboarding",
                    steps: [
                        {
                            description: "collect_name",
                            prompt: "What is your name?",
                            collect: ["name"] as any,
                        },
                        {
                            description: "collect_email",
                            prompt: "What is your email?",
                            collect: ["email"] as any,
                        },
                    ],
                },
            ],
        });

        expect(agent).toBeInstanceOf(Agent);
        expect(agent.flows.length).toBe(1);
        expect(agent.instructions.length).toBe(1);
    });

    test("should construct flow graph from declarative flows option (Requirement 14.3)", () => {
        const agent = createAgent({
            name: "FlowBot",
            provider: mockProvider as any,
            flows: [
                {
                    title: "Booking",
                    steps: [
                        { description: "ask_date", prompt: "When?" },
                        { description: "ask_guests", prompt: "How many guests?" },
                    ],
                },
                {
                    title: "Feedback",
                    steps: [
                        { description: "ask_rating", prompt: "Rate us?" },
                    ],
                },
            ],
        });

        expect(agent.flows.length).toBe(2);
        expect(agent.flows[0].title).toBe("Booking");
        expect(agent.flows[1].title).toBe("Feedback");
    });

    test("should throw FlowConfigurationError for invalid collect fields (Requirement 14.5)", () => {
        expect(() => {
            createAgent({
                name: "BadCollectBot",
                provider: mockProvider as any,
                schema: {
                    type: "object",
                    properties: {
                        name: { type: "string", description: "User name" },
                        email: { type: "string", description: "User email" },
                    },
                    required: ["name"],
                },
                flows: [
                    {
                        title: "Onboarding",
                        steps: [
                            {
                                description: "collect_info",
                                prompt: "Tell me about yourself",
                                collect: ["name", "phone_number"] as any, // phone_number is not in schema
                            },
                        ],
                    },
                ],
            });
        }).toThrow(/invalid collect fields.*phone_number/i);
    });

    test("should allow valid collect fields that match schema keys (Requirement 14.5)", () => {
        const agent = createAgent({
            name: "ValidCollectBot",
            provider: mockProvider as any,
            schema: {
                type: "object",
                properties: {
                    name: { type: "string", description: "User name" },
                    email: { type: "string", description: "User email" },
                    age: { type: "number", description: "User age" },
                },
                required: ["name", "email"],
            },
            flows: [
                {
                    title: "Profile",
                    steps: [
                        {
                            description: "collect_basics",
                            prompt: "Name and email?",
                            collect: ["name", "email"] as any,
                        },
                        {
                            description: "collect_age",
                            prompt: "How old are you?",
                            collect: ["age"] as any,
                        },
                    ],
                },
            ],
        });

        expect(agent.flows.length).toBe(1);
    });

    test("should still expose agent.createFlow as escape hatch (Requirement 14.6)", () => {
        const agent = createAgent({
            name: "EscapeHatchBot",
            provider: mockProvider as any,
        });

        expect(typeof agent.createFlow).toBe("function");

        const flow = agent.createFlow({
            title: "DynamicFlow",
            steps: [{ description: "step1", prompt: "Hello" }],
        });

        expect(agent.flows.length).toBe(1);
        expect(flow.title).toBe("DynamicFlow");
    });

    test("should preserve generic inference from schema (Requirement 14.5 - type-level)", () => {
        // This test validates that the TypeScript generics work correctly.
        // If this compiles, generic inference is preserved.
        interface MyData {
            name: string;
            email: string;
        }

        const agent = createAgent<unknown, MyData>({
            name: "TypedBot",
            provider: mockProvider as any,
            schema: {
                type: "object",
                properties: {
                    name: { type: "string", description: "User name" },
                    email: { type: "string", description: "User email" },
                },
                required: ["name", "email"],
            },
            flows: [
                {
                    title: "Typed Flow",
                    steps: [
                        {
                            description: "collect_name",
                            prompt: "Name?",
                            collect: ["name"], // This should type-check against keyof MyData
                        },
                    ],
                },
            ],
        });

        expect(agent).toBeInstanceOf(Agent);
    });

    test("should not throw for steps without collect when schema is present", () => {
        const agent = createAgent({
            name: "NoCollectBot",
            provider: mockProvider as any,
            schema: {
                type: "object",
                properties: {
                    name: { type: "string", description: "User name" },
                },
                required: ["name"],
            },
            flows: [
                {
                    title: "Simple",
                    steps: [
                        { description: "greet", prompt: "Hello! How can I help?" },
                    ],
                },
            ],
        });

        expect(agent.flows.length).toBe(1);
    });

    test("should not validate collect when no schema is provided", () => {
        // Without a schema, any collect field should be allowed (no validation)
        const agent = createAgent({
            name: "NoSchemaBot",
            provider: mockProvider as any,
            flows: [
                {
                    title: "Free Form",
                    steps: [
                        {
                            description: "collect_anything",
                            prompt: "Tell me stuff",
                            collect: ["anything", "goes"] as any,
                        },
                    ],
                },
            ],
        });

        expect(agent.flows.length).toBe(1);
    });
});
