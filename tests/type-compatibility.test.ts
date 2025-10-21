/**
 * Type Compatibility Tests
 *
 * Tests that verify interface compatibility with Record<string, unknown>
 * and other type constraints required by the ResponseModal fixes.
 */

import { expect, test, describe } from "bun:test";

import type { RespondParams } from "../src/core/ResponseModal";
import type { AgentStructuredResponse } from "../src/types/ai";
import type { SessionState } from "../src/types";

// Test context and data types
interface TestContext {
    userId: string;
    sessionCount: number;
}

interface TestData {
    name?: string;
    email?: string;
    issue?: string;
}

describe("RespondParams Type Compatibility", () => {
    test("should be compatible with Record<string, unknown>", () => {
        const params: RespondParams<TestContext, TestData> = {
            history: [
                { role: "user", content: "Hello" },
            ],
            session: {
                id: "test-session",
                data: { name: "Test User" },
            },
            contextOverride: {
                userId: "test-user-123",
                sessionCount: 5,
            },
        };

        // This should compile without errors - RespondParams extends Record<string, unknown>
        const asRecord: Record<string, unknown> = params;

        expect(asRecord).toBeDefined();
        expect(asRecord.history).toBeDefined();
        expect(asRecord.session).toBeDefined();
        expect(asRecord.contextOverride).toBeDefined();
    });

    test("should allow additional properties as Record<string, unknown>", () => {
        const params: RespondParams<TestContext, TestData> = {
            history: [
                { role: "user", content: "Hello" },
            ],
            // Additional properties should be allowed
            customProperty: "custom value",
            anotherProperty: { nested: "object" },
            numericProperty: 42,
            booleanProperty: true,
        };

        const asRecord: Record<string, unknown> = params;

        expect(asRecord.customProperty).toBe("custom value");
        expect(asRecord.anotherProperty).toEqual({ nested: "object" });
        expect(asRecord.numericProperty).toBe(42);
        expect(asRecord.booleanProperty).toBe(true);
    });

    test("should work with minimal required properties", () => {
        const minimalParams: RespondParams = {
            history: [],
        };

        const asRecord: Record<string, unknown> = minimalParams;

        expect(asRecord).toBeDefined();
        expect(asRecord.history).toEqual([]);
    });

    test("should work with all optional properties", () => {
        const fullParams: RespondParams<TestContext, TestData> = {
            history: [
                { role: "user", content: "Test message" },
                { role: "assistant", content: "Test response" },
            ],
            step: {
                id: "test-step",
                routeId: "test-route",
            },
            session: {
                id: "test-session-full",
                data: {
                    name: "Full Test User",
                    email: "test@example.com",
                    issue: "Test issue",
                },
            },
            contextOverride: {
                userId: "full-test-user",
                sessionCount: 10,
            },
            signal: new AbortController().signal,
        };

        const asRecord: Record<string, unknown> = fullParams;

        expect(asRecord).toBeDefined();
        expect(asRecord.history).toBeDefined();
        expect(asRecord.step).toBeDefined();
        expect(asRecord.session).toBeDefined();
        expect(asRecord.contextOverride).toBeDefined();
        expect(asRecord.signal).toBeDefined();
    });

    test("should handle nested objects in properties", () => {
        const paramsWithNested: RespondParams<TestContext, TestData> = {
            history: [
                {
                    role: "assistant",
                    content: "I'll help you with that",
                    tool_calls: [
                        {
                            id: "call_123",
                            name: "search_tool",
                            arguments: { query: "test", limit: 10 },
                        },
                    ],
                },
            ],
            session: {
                id: "nested-test",
                data: {
                    name: "Nested User",
                    email: "nested@example.com",
                },
            },
            contextOverride: {
                userId: "nested-user",
                sessionCount: 3,
            },
        };

        const asRecord: Record<string, unknown> = paramsWithNested;

        expect(asRecord).toBeDefined();
        expect(Array.isArray(asRecord.history)).toBe(true);
        expect(typeof asRecord.session).toBe("object");
        expect(typeof asRecord.contextOverride).toBe("object");
    });
});

describe("AgentStructuredResponse Type Compatibility", () => {
    test("should be compatible with Record<string, unknown>", () => {
        const response: AgentStructuredResponse = {
            message: "Hello! How can I help you today?",
            route: "support",
            step: "collect_issue",
            toolCalls: [
                {
                    toolName: "search_database",
                    arguments: { query: "user issue" },
                },
            ],
            reasoning: "User needs help, routing to support flow",
        };

        // This should compile without errors - AgentStructuredResponse extends Record<string, unknown>
        const asRecord: Record<string, unknown> = response;

        expect(asRecord).toBeDefined();
        expect(asRecord.message).toBe("Hello! How can I help you today?");
        expect(asRecord.route).toBe("support");
        expect(asRecord.step).toBe("collect_issue");
        expect(asRecord.toolCalls).toBeDefined();
        expect(asRecord.reasoning).toBe("User needs help, routing to support flow");
    });

    test("should allow additional properties as Record<string, unknown>", () => {
        const response: AgentStructuredResponse = {
            message: "Response with extra properties",
            // Additional properties should be allowed
            customField: "custom value",
            metadata: {
                timestamp: new Date().toISOString(),
                version: "1.0.0",
            },
            confidence: 0.95,
            tags: ["support", "urgent"],
        };

        const asRecord: Record<string, unknown> = response;

        expect(asRecord.customField).toBe("custom value");
        expect(asRecord.metadata).toEqual({
            timestamp: expect.any(String),
            version: "1.0.0",
        });
        expect(asRecord.confidence).toBe(0.95);
        expect(asRecord.tags).toEqual(["support", "urgent"]);
    });

    test("should work with minimal required properties", () => {
        const minimalResponse: AgentStructuredResponse = {
            message: "Minimal response",
        };

        const asRecord: Record<string, unknown> = minimalResponse;

        expect(asRecord).toBeDefined();
        expect(asRecord.message).toBe("Minimal response");
        expect(asRecord.route).toBeUndefined();
        expect(asRecord.step).toBeUndefined();
        expect(asRecord.toolCalls).toBeUndefined();
        expect(asRecord.reasoning).toBeUndefined();
    });

    test("should work with null values for optional properties", () => {
        const responseWithNulls: AgentStructuredResponse = {
            message: "Response with nulls",
            route: null,
            step: null,
            toolCalls: undefined,
            reasoning: undefined,
        };

        const asRecord: Record<string, unknown> = responseWithNulls;

        expect(asRecord).toBeDefined();
        expect(asRecord.message).toBe("Response with nulls");
        expect(asRecord.route).toBe(null);
        expect(asRecord.step).toBe(null);
        expect(asRecord.toolCalls).toBeUndefined();
        expect(asRecord.reasoning).toBeUndefined();
    });

    test("should handle complex tool calls structure", () => {
        const responseWithComplexTools: AgentStructuredResponse = {
            message: "I'll execute multiple tools for you",
            route: "data_processing",
            step: "execute_tools",
            toolCalls: [
                {
                    toolName: "fetch_data",
                    arguments: {
                        source: "database",
                        filters: {
                            date_range: {
                                start: "2024-01-01",
                                end: "2024-12-31",
                            },
                            status: ["active", "pending"],
                        },
                        limit: 100,
                    },
                },
                {
                    toolName: "process_data",
                    arguments: {
                        operation: "aggregate",
                        groupBy: ["category", "region"],
                        metrics: ["count", "sum", "average"],
                    },
                },
            ],
            reasoning: "User requested data analysis, need to fetch and process data",
        };

        const asRecord: Record<string, unknown> = responseWithComplexTools;

        expect(asRecord).toBeDefined();
        expect(Array.isArray(asRecord.toolCalls)).toBe(true);
        expect((asRecord.toolCalls as any[])).toHaveLength(2);

        const firstTool = (asRecord.toolCalls as any[])[0];
        expect(firstTool.toolName).toBe("fetch_data");
        expect(typeof firstTool.arguments).toBe("object");
        expect(firstTool.arguments.source).toBe("database");
    });

    test("should work in generic contexts", () => {
        // Test that AgentStructuredResponse can be used in generic functions
        // that expect Record<string, unknown>
        function processRecord<T extends Record<string, unknown>>(record: T): T {
            return { ...record };
        }

        const response: AgentStructuredResponse = {
            message: "Generic test response",
            route: "test_route",
            customProperty: "should work",
        };

        const processed = processRecord(response);

        expect(processed).toEqual(response);
        expect(processed.message).toBe("Generic test response");
        expect(processed.route).toBe("test_route");
        expect(processed.customProperty).toBe("should work");
    });

    test("should maintain type safety while being compatible", () => {
        const response: AgentStructuredResponse = {
            message: "Type safety test",
            route: "safety_route",
            step: "safety_step",
        };

        // Should work as Record<string, unknown>
        const asRecord: Record<string, unknown> = response;
        expect(asRecord.message).toBe("Type safety test");

        // Should still maintain AgentStructuredResponse type properties
        expect(response.message).toBe("Type safety test");
        expect(response.route).toBe("safety_route");
        expect(response.step).toBe("safety_step");

        // TypeScript should enforce required properties
        // This would cause a compile error if uncommented:
        // const invalidResponse: AgentStructuredResponse = { route: "test" }; // Missing required 'message'
    });
});

describe("Type Compatibility in Error Handling", () => {
    test("should handle RespondParams in error contexts", () => {
        const params: RespondParams<TestContext, TestData> = {
            history: [{ role: "user", content: "Error test" }],
            session: {
                id: "error-test",
                data: { name: "Error User" },
            },
        };

        // Simulate error handling that expects Record<string, unknown>
        function handleError(errorParams: Record<string, unknown>) {
            return {
                error: "Test error",
                params: errorParams,
            };
        }

        const errorResult = handleError(params);

        expect(errorResult.error).toBe("Test error");
        expect(errorResult.params).toBeDefined();
        expect((errorResult.params as any).history).toBeDefined();
        expect((errorResult.params as any).session).toBeDefined();
    });

    test("should handle AgentStructuredResponse in error contexts", () => {
        const response: AgentStructuredResponse = {
            message: "Error response test",
            route: "error_route",
        };

        // Simulate error handling that expects Record<string, unknown>
        function logResponse(responseData: Record<string, unknown>) {
            return {
                logged: true,
                data: responseData,
            };
        }

        const logResult = logResponse(response);

        expect(logResult.logged).toBe(true);
        expect(logResult.data).toBeDefined();
        expect((logResult.data as any).message).toBe("Error response test");
        expect((logResult.data as any).route).toBe("error_route");
    });
});

describe("Template Context Compatibility", () => {
    test("should work with Event[] history in template contexts", () => {
        // This test verifies that template contexts can work with Event[] format
        // which is required by the type fixes

        interface MockTemplateContext {
            history?: any[]; // Using any[] to simulate the Event[] requirement
            session?: SessionState<TestData>;
            context?: TestContext;
        }

        const templateContext: MockTemplateContext = {
            history: [
                {
                    kind: "MESSAGE",
                    source: "USER",
                    timestamp: new Date().toISOString(),
                    data: {
                        participant: { display_name: "User" },
                        message: "Template test",
                    },
                },
            ],
            session: {
                id: "template-test",
                data: { name: "Template User" },
            },
            context: {
                userId: "template-user",
                sessionCount: 1,
            },
        };

        expect(templateContext).toBeDefined();
        expect(Array.isArray(templateContext.history)).toBe(true);
        expect(templateContext.history).toHaveLength(1);
        expect(templateContext.session).toBeDefined();
        expect(templateContext.context).toBeDefined();
    });
});