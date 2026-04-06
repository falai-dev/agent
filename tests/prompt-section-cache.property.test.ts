import { describe, test, expect } from "bun:test";
import fc from "fast-check";
import { PromptSectionCache } from "../src/core/PromptSectionCache";
import type { PromptSectionType } from "../src/core/PromptSectionCache";

// --- Arbitraries ---

const sectionKeyArb = fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0);
const sectionValueArb = fc.oneof(fc.string({ minLength: 0, maxLength: 200 }), fc.constant(null));
const sectionTypeArb: fc.Arbitrary<PromptSectionType> = fc.oneof(
    fc.constant("static" as const),
    fc.constant("dynamic" as const)
);

interface SectionDef {
    key: string;
    type: PromptSectionType;
    value: string | null;
}

const sectionDefArb: fc.Arbitrary<SectionDef> = fc.record({
    key: sectionKeyArb,
    type: sectionTypeArb,
    value: sectionValueArb,
});

const uniqueSectionsArb = fc
    .array(sectionDefArb, { minLength: 1, maxLength: 10 })
    .map((sections) => {
        const seen = new Set<string>();
        return sections.filter((s) => {
            if (seen.has(s.key)) return false;
            seen.add(s.key);
            return true;
        });
    })
    .filter((arr) => arr.length > 0);

// --- Property 15: Prompt Section Cache Consistency ---

describe("Property 15: Prompt Section Cache Consistency", () => {
    /**
     * **Validates: Requirements 15.1, 15.2, 15.3, 15.4, 15.5**
     *
     * For any sequence of resolveAll() calls without intervening invalidation,
     * static sections return the same value; dynamic sections are recomputed;
     * after invalidate(key) that section recomputes; after invalidateAll() all recompute.
     */

    test("static sections return cached value across multiple resolveAll() calls", async () => {
        await fc.assert(
            fc.asyncProperty(uniqueSectionsArb, async (sections) => {
                const cache = new PromptSectionCache({ enabled: true });
                const callCounts = new Map<string, number>();

                for (const s of sections) {
                    callCounts.set(s.key, 0);
                    cache.register(s.key, s.type, () => {
                        callCounts.set(s.key, (callCounts.get(s.key) ?? 0) + 1);
                        return s.value;
                    });
                }

                // First resolve — all sections computed
                const result1 = await cache.resolveAll();
                for (const s of sections) {
                    expect(callCounts.get(s.key)).toBe(1);
                }

                // Second resolve — static sections should NOT recompute, dynamic should
                const result2 = await cache.resolveAll();
                for (const s of sections) {
                    if (s.type === "static") {
                        expect(callCounts.get(s.key)).toBe(1); // still 1 — cached
                    } else {
                        expect(callCounts.get(s.key)).toBe(2); // recomputed
                    }
                }

                // Static sections return same value across calls
                for (let i = 0; i < sections.length; i++) {
                    expect(result1[i]).toEqual(result2[i]);
                }
            }),
            { numRuns: 50 }
        );
    });

    test("resolveAll() returns sections in registration order", async () => {
        await fc.assert(
            fc.asyncProperty(uniqueSectionsArb, async (sections) => {
                const cache = new PromptSectionCache({ enabled: true });
                for (const s of sections) {
                    cache.register(s.key, s.type, () => s.value);
                }

                const result = await cache.resolveAll();
                expect(result.length).toBe(sections.length);
                for (let i = 0; i < sections.length; i++) {
                    expect(result[i]).toEqual(sections[i].value);
                }
            }),
            { numRuns: 50 }
        );
    });

    test("invalidate(key) causes that section to recompute on next resolveAll()", async () => {
        await fc.assert(
            fc.asyncProperty(uniqueSectionsArb, async (sections) => {
                const staticSections = sections.filter((s) => s.type === "static");
                if (staticSections.length === 0) return; // skip if no static sections

                const cache = new PromptSectionCache({ enabled: true });
                const callCounts = new Map<string, number>();

                for (const s of sections) {
                    callCounts.set(s.key, 0);
                    cache.register(s.key, s.type, () => {
                        callCounts.set(s.key, (callCounts.get(s.key) ?? 0) + 1);
                        return s.value;
                    });
                }

                // First resolve
                await cache.resolveAll();

                // Invalidate one static section
                const target = staticSections[0];
                cache.invalidate(target.key);

                // Second resolve
                await cache.resolveAll();

                // The invalidated static section should have been recomputed (count = 2)
                expect(callCounts.get(target.key)).toBe(2);

                // Other static sections should still be cached (count = 1)
                for (const s of staticSections.slice(1)) {
                    expect(callCounts.get(s.key)).toBe(1);
                }
            }),
            { numRuns: 50 }
        );
    });

    test("invalidateAll() causes all sections to recompute on next resolveAll()", async () => {
        await fc.assert(
            fc.asyncProperty(uniqueSectionsArb, async (sections) => {
                const cache = new PromptSectionCache({ enabled: true });
                const callCounts = new Map<string, number>();

                for (const s of sections) {
                    callCounts.set(s.key, 0);
                    cache.register(s.key, s.type, () => {
                        callCounts.set(s.key, (callCounts.get(s.key) ?? 0) + 1);
                        return s.value;
                    });
                }

                // First resolve
                await cache.resolveAll();
                // Invalidate all
                cache.invalidateAll();
                // Second resolve
                await cache.resolveAll();

                // All sections should have been computed exactly twice
                for (const s of sections) {
                    expect(callCounts.get(s.key)).toBe(2);
                }
            }),
            { numRuns: 50 }
        );
    });

    test("dynamic sections recompute on every resolveAll() call", async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.integer({ min: 2, max: 5 }),
                async (resolveCount) => {
                    const cache = new PromptSectionCache({ enabled: true });
                    let dynamicCallCount = 0;

                    cache.register("dynamic-section", "dynamic", () => {
                        dynamicCallCount++;
                        return `call-${dynamicCallCount}`;
                    });

                    for (let i = 0; i < resolveCount; i++) {
                        await cache.resolveAll();
                    }

                    expect(dynamicCallCount).toBe(resolveCount);
                }
            ),
            { numRuns: 30 }
        );
    });

    test("when enabled=false, all sections recompute every call", async () => {
        await fc.assert(
            fc.asyncProperty(uniqueSectionsArb, async (sections) => {
                const cache = new PromptSectionCache({ enabled: false });
                const callCounts = new Map<string, number>();

                for (const s of sections) {
                    callCounts.set(s.key, 0);
                    cache.register(s.key, s.type, () => {
                        callCounts.set(s.key, (callCounts.get(s.key) ?? 0) + 1);
                        return s.value;
                    });
                }

                await cache.resolveAll();
                await cache.resolveAll();
                await cache.resolveAll();

                // All sections should have been computed 3 times regardless of type
                for (const s of sections) {
                    expect(callCounts.get(s.key)).toBe(3);
                }
            }),
            { numRuns: 50 }
        );
    });

    test("volatileKeys cause static sections to recompute every call", async () => {
        await fc.assert(
            fc.asyncProperty(uniqueSectionsArb, async (sections) => {
                const staticSections = sections.filter((s) => s.type === "static");
                if (staticSections.length === 0) return;

                const volatileKey = staticSections[0].key;
                const cache = new PromptSectionCache({
                    enabled: true,
                    volatileKeys: [volatileKey],
                });
                const callCounts = new Map<string, number>();

                for (const s of sections) {
                    callCounts.set(s.key, 0);
                    cache.register(s.key, s.type, () => {
                        callCounts.set(s.key, (callCounts.get(s.key) ?? 0) + 1);
                        return s.value;
                    });
                }

                await cache.resolveAll();
                await cache.resolveAll();

                // Volatile static section should recompute every time
                expect(callCounts.get(volatileKey)).toBe(2);

                // Non-volatile static sections should be cached
                for (const s of staticSections.slice(1)) {
                    expect(callCounts.get(s.key)).toBe(1);
                }
            }),
            { numRuns: 50 }
        );
    });

    test("get() returns null for unregistered keys", async () => {
        await fc.assert(
            fc.asyncProperty(sectionKeyArb, async (key) => {
                const cache = new PromptSectionCache({ enabled: true });
                const result = await cache.get(key);
                expect(result).toBeNull();
            }),
            { numRuns: 20 }
        );
    });

    test("async compute functions are supported", async () => {
        const cache = new PromptSectionCache({ enabled: true });
        let callCount = 0;

        cache.register("async-static", "static", async () => {
            callCount++;
            return "async-value";
        });

        const r1 = await cache.resolveAll();
        const r2 = await cache.resolveAll();

        expect(r1).toEqual(["async-value"]);
        expect(r2).toEqual(["async-value"]);
        expect(callCount).toBe(1); // cached after first call
    });
});
