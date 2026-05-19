/**
 * routerMode reservation tests
 *
 * Validates: Requirements 21.1, 21.2, 21.3
 *
 * - routerMode?: 'ai' on AgentOptions
 * - Only 'ai' accepted in v2.0
 * - Non-'ai' values throw NotImplementedError at construction
 * - Other construction errors fail normally regardless of routerMode value
 */

import { describe, test, expect } from "bun:test";
import { Agent, NotImplementedError } from "../src/index";
import { MockProvider } from "./mock-provider";

describe("routerMode reservation", () => {
    const baseOptions = {
        name: "Test Agent",
        provider: new MockProvider(),
    };

    test("constructs OK with routerMode omitted (defaults to ai)", () => {
        const agent = new Agent({ ...baseOptions });
        expect(agent).toBeInstanceOf(Agent);
    });

    test("constructs OK with routerMode: 'ai'", () => {
        const agent = new Agent({ ...baseOptions, routerMode: "ai" } as any);
        expect(agent).toBeInstanceOf(Agent);
    });

    test("throws NotImplementedError for routerMode: 'embedding'", () => {
        expect(() => {
            new Agent({ ...baseOptions, routerMode: "embedding" } as any);
        }).toThrow(NotImplementedError);
    });

    test("throws NotImplementedError for routerMode: 'rule-based'", () => {
        expect(() => {
            new Agent({ ...baseOptions, routerMode: "rule-based" } as any);
        }).toThrow(NotImplementedError);
    });

    test("NotImplementedError message names the offending value", () => {
        try {
            new Agent({ ...baseOptions, routerMode: "embedding" } as any);
            throw new Error("Expected NotImplementedError");
        } catch (err) {
            expect(err).toBeInstanceOf(NotImplementedError);
            expect((err as Error).message).toContain("embedding");
            expect((err as Error).message).toContain("ai");
        }
    });

    test("NotImplementedError is a proper subclass of Error", () => {
        const err = new NotImplementedError("test");
        expect(err).toBeInstanceOf(Error);
        expect(err).toBeInstanceOf(NotImplementedError);
        expect(err.name).toBe("NotImplementedError");
    });

    test("other construction errors fail normally regardless of routerMode value", () => {
        // When routerMode is 'ai' but another option is bad, the other error is thrown
        expect(() => {
            new Agent({
                ...baseOptions,
                routerMode: "ai",
                context: { foo: "bar" },
                contextProvider: () => ({ foo: "baz" }),
            } as any);
        }).toThrow("Cannot provide both 'context' and 'contextProvider'");
    });
});
