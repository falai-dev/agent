/**
 * Prompt section cache configuration types.
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
