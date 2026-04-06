import { describe, test, expect } from "bun:test";
import fc from "fast-check";
import { PromptSectionCache } from "../src/core/PromptSectionCache";

/**
 * Property 17: Cache Invalidation on State Change
 *
 * After context update, session change, or route switch, affected cached
 * sections are invalidated and recomputed on next resolve.
 *
 * Validates: Requirements 16.1, 16.2, 16.3
 *
 * This test simulates the invalidation patterns that Agent.ts will use:
 * - Context update → invalidate context-dependent sections (agentMeta, knowledgeBase)
 * - Session change → invalidateAll()
 * - Route switch → invalidate route-dependent sections (activeRoutes, rules, prohibitions, routeKnowledgeBase)
 */

// Section keys matching the design doc's classification
const CONTEXT_DEPENDENT_KEYS = ["agentMeta", "knowledgeBase"];
const ROUTE_DEPENDENT_KEYS = ["activeRoutes", "routeRules", "routeProhibitions", "routeKnowledgeBase"];
const ALL_STATIC_KEYS = [...CONTEXT_DEPENDENT_KEYS, ...ROUTE_DEPENDENT_KEYS, "glossary", "scoringRules"];
const DYNAMIC_KEYS = ["instruction", "directives", "availableTools", "lastMessage"];

describe("Property 17: Cache Invalidation on State Change", () => {

    /**
     * Helper: creates a cache with all standard sections registered,
     * tracking call counts per key. Returns the cache and call count map.
     */
    function createStandardCache() {
        const cache = new PromptSectionCache({ enabled: true });
        const callCounts = new Map<string, number>();
        const values = new Map<string, string>();

        for (const key of ALL_STATIC_KEYS) {
            callCounts.set(key, 0);
            values.set(key, `${key}-v1`);
            cache.register(key, "static", () => {
                callCounts.set(key, (callCounts.get(key) ?? 0) + 1);
                return values.get(key)!;
            });
        }
        for (const key of DYNAMIC_KEYS) {
            callCounts.set(key, 0);
            values.set(key, `${key}-v1`);
            cache.register(key, "dynamic", () => {
                callCounts.set(key, (callCounts.get(key) ?? 0) + 1);
                return values.get(key)!;
            });
        }

        return { cache, callCounts, values };
    }

    /** Simulate context update: invalidate context-dependent sections */
    function simulateContextUpdate(cache: PromptSectionCache) {
        for (const key of CONTEXT_DEPENDENT_KEYS) {
            cache.invalidate(key);
        }
    }

    /** Simulate session change: invalidate all */
    function simulateSessionChange(cache: PromptSectionCache) {
        cache.invalidateAll();
    }

    /** Simulate route switch: invalidate route-dependent sections */
    function simulateRouteSwitch(cache: PromptSectionCache) {
        for (const key of ROUTE_DEPENDENT_KEYS) {
            cache.invalidate(key);
        }
    }

    test("context update invalidates context-dependent sections and recomputes them", async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.integer({ min: 1, max: 5 }),
                async (updateCount) => {
                    const { cache, callCounts } = createStandardCache();

                    // Initial resolve — all sections computed once
                    await cache.resolveAll();

                    for (let i = 0; i < updateCount; i++) {
                        simulateContextUpdate(cache);
                        await cache.resolveAll();
                    }

                    // Context-dependent static sections should have been computed 1 + updateCount times
                    for (const key of CONTEXT_DEPENDENT_KEYS) {
                        expect(callCounts.get(key)).toBe(1 + updateCount);
                    }

                    // Non-context static sections should still be computed only once
                    const nonContextStatic = ALL_STATIC_KEYS.filter(
                        (k) => !CONTEXT_DEPENDENT_KEYS.includes(k)
                    );
                    for (const key of nonContextStatic) {
                        expect(callCounts.get(key)).toBe(1);
                    }
                }
            ),
            { numRuns: 20 }
        );
    });

    test("session change invalidates all cached sections", async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.integer({ min: 1, max: 3 }),
                async (changeCount) => {
                    const { cache, callCounts } = createStandardCache();

                    await cache.resolveAll();

                    for (let i = 0; i < changeCount; i++) {
                        simulateSessionChange(cache);
                        await cache.resolveAll();
                    }

                    // All sections (static and dynamic) should have been computed 1 + changeCount times
                    // (dynamic sections recompute every call anyway, so they get 1 + changeCount too)
                    for (const key of ALL_STATIC_KEYS) {
                        expect(callCounts.get(key)).toBe(1 + changeCount);
                    }
                    // Dynamic sections: initial resolve + changeCount resolves = 1 + changeCount
                    for (const key of DYNAMIC_KEYS) {
                        expect(callCounts.get(key)).toBe(1 + changeCount);
                    }
                }
            ),
            { numRuns: 20 }
        );
    });

    test("route switch invalidates route-dependent sections only", async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.integer({ min: 1, max: 5 }),
                async (switchCount) => {
                    const { cache, callCounts } = createStandardCache();

                    await cache.resolveAll();

                    for (let i = 0; i < switchCount; i++) {
                        simulateRouteSwitch(cache);
                        await cache.resolveAll();
                    }

                    // Route-dependent static sections should have been recomputed
                    for (const key of ROUTE_DEPENDENT_KEYS) {
                        expect(callCounts.get(key)).toBe(1 + switchCount);
                    }

                    // Non-route static sections should still be cached
                    const nonRouteStatic = ALL_STATIC_KEYS.filter(
                        (k) => !ROUTE_DEPENDENT_KEYS.includes(k)
                    );
                    for (const key of nonRouteStatic) {
                        expect(callCounts.get(key)).toBe(1);
                    }
                }
            ),
            { numRuns: 20 }
        );
    });

    test("mixed state changes: context update + route switch invalidate correct subsets", async () => {
        type StateChange = "context" | "route" | "session";
        const stateChangeArb: fc.Arbitrary<StateChange> = fc.oneof(
            fc.constant("context" as const),
            fc.constant("route" as const),
            fc.constant("session" as const)
        );

        await fc.assert(
            fc.asyncProperty(
                fc.array(stateChangeArb, { minLength: 1, maxLength: 8 }),
                async (changes) => {
                    const { cache, callCounts } = createStandardCache();

                    await cache.resolveAll();

                    // Track expected recomputation counts per key
                    const expectedCounts = new Map<string, number>();
                    for (const key of [...ALL_STATIC_KEYS, ...DYNAMIC_KEYS]) {
                        expectedCounts.set(key, 1); // initial resolve
                    }

                    for (const change of changes) {
                        if (change === "context") {
                            simulateContextUpdate(cache);
                            // Only context-dependent keys get invalidated
                            for (const key of CONTEXT_DEPENDENT_KEYS) {
                                // Will recompute on next resolve
                            }
                        } else if (change === "route") {
                            simulateRouteSwitch(cache);
                        } else {
                            simulateSessionChange(cache);
                        }

                        await cache.resolveAll();

                        // After resolve, all sections get +1 to their count
                        // But only invalidated static sections actually recompute
                        // Dynamic sections always recompute
                        for (const key of DYNAMIC_KEYS) {
                            expectedCounts.set(key, (expectedCounts.get(key) ?? 0) + 1);
                        }

                        if (change === "session") {
                            // All static sections recompute
                            for (const key of ALL_STATIC_KEYS) {
                                expectedCounts.set(key, (expectedCounts.get(key) ?? 0) + 1);
                            }
                        } else if (change === "context") {
                            for (const key of CONTEXT_DEPENDENT_KEYS) {
                                expectedCounts.set(key, (expectedCounts.get(key) ?? 0) + 1);
                            }
                        } else if (change === "route") {
                            for (const key of ROUTE_DEPENDENT_KEYS) {
                                expectedCounts.set(key, (expectedCounts.get(key) ?? 0) + 1);
                            }
                        }
                    }

                    // Verify all counts match
                    for (const [key, expected] of expectedCounts) {
                        expect(callCounts.get(key)).toBe(expected);
                    }
                }
            ),
            { numRuns: 50 }
        );
    });

    test("recomputed sections reflect updated values after state change", async () => {
        const cache = new PromptSectionCache({ enabled: true });
        let contextVersion = 1;

        cache.register("agentMeta", "static", () => `meta-v${contextVersion}`);
        cache.register("glossary", "static", () => `glossary-v1`);

        // Initial resolve
        const r1 = await cache.resolveAll();
        expect(r1).toEqual(["meta-v1", "glossary-v1"]);

        // Simulate context update with new value
        contextVersion = 2;
        cache.invalidate("agentMeta");

        const r2 = await cache.resolveAll();
        expect(r2).toEqual(["meta-v2", "glossary-v1"]); // agentMeta updated, glossary cached
    });
});
