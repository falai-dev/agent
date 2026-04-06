/**
 * PromptSectionCache - Memoizes static prompt sections across turns,
 * recomputing only dynamic sections per-turn.
 *
 * Static sections (agent identity, glossary, knowledge base, route descriptions)
 * are cached after first computation. Dynamic sections (current step context,
 * directives, available tools) are recomputed on every resolveAll() call.
 */

/** Section type: static sections are cached, dynamic sections recompute every turn */
export type PromptSectionType = "static" | "dynamic";

/** Configuration for prompt section caching behavior */
export interface PromptCacheConfig {
    /** Whether to enable section memoization (default: true) */
    enabled?: boolean;
    /** Keys of sections that should always recompute every turn, even if registered as static */
    volatileKeys?: string[];
}

/** Compute function that produces a section's content */
export type SectionCompute = () => string | null | Promise<string | null>;

/** Internal entry tracking a registered section */
interface PromptSectionEntry {
    key: string;
    type: PromptSectionType;
    compute: SectionCompute;
    /** undefined = not yet computed; null = computed to null; string = cached value */
    cachedValue?: string | null;
}

const SENTINEL = Symbol("NOT_COMPUTED");

export class PromptSectionCache {
    private sections: Map<string, PromptSectionEntry> = new Map();
    private insertionOrder: string[] = [];
    private config: Required<PromptCacheConfig>;

    constructor(config?: PromptCacheConfig) {
        this.config = {
            enabled: config?.enabled ?? true,
            volatileKeys: config?.volatileKeys ?? [],
        };
    }

    /**
     * Register a section with its compute function and type.
     * Sections are resolved in registration order during resolveAll().
     */
    register(key: string, type: PromptSectionType, compute: SectionCompute): void {
        const existing = this.sections.has(key);
        this.sections.set(key, { key, type, compute, cachedValue: undefined });
        if (!existing) {
            this.insertionOrder.push(key);
        }
    }

    /**
     * Get a section's value. Static sections return cached value if available;
     * dynamic sections always recompute.
     */
    async get(key: string): Promise<string | null> {
        const entry = this.sections.get(key);
        if (!entry) {
            return null;
        }
        if (this.shouldRecompute(entry)) {
            const value = await entry.compute();
            entry.cachedValue = value;
            return value;
        }
        // cachedValue is defined (string or null) — return it
        return entry.cachedValue!;
    }

    /**
     * Resolve all registered sections in registration order.
     * Static sections use cache when available; dynamic sections always recompute.
     */
    async resolveAll(): Promise<(string | null)[]> {
        const results: (string | null)[] = [];
        for (const key of this.insertionOrder) {
            results.push(await this.get(key));
        }
        return results;
    }

    /**
     * Invalidate a specific section's cache, forcing recomputation on next resolve.
     */
    invalidate(key: string): void {
        const entry = this.sections.get(key);
        if (entry) {
            entry.cachedValue = undefined;
        }
    }

    /**
     * Invalidate all cached sections (e.g., on session change or /clear).
     */
    invalidateAll(): void {
        for (const entry of this.sections.values()) {
            entry.cachedValue = undefined;
        }
    }

    /**
     * Check whether a section has a cached value.
     */
    has(key: string): boolean {
        return this.sections.has(key);
    }

    /**
     * Determine if a section needs recomputation.
     */
    private shouldRecompute(entry: PromptSectionEntry): boolean {
        // Caching disabled — always recompute
        if (!this.config.enabled) {
            return true;
        }
        // Dynamic sections always recompute
        if (entry.type === "dynamic") {
            return true;
        }
        // Volatile keys always recompute
        if (this.config.volatileKeys.includes(entry.key)) {
            return true;
        }
        // Static section not yet computed
        if (entry.cachedValue === undefined) {
            return true;
        }
        // Static section with cached value — use cache
        return false;
    }
}
