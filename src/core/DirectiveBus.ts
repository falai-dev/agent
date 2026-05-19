/**
 * DirectiveBus — per-turn collection mechanism for directives emitted by
 * hooks, tools, and branches.
 *
 * Two phases per turn:
 * 1. Pre-LLM: collects from `prepare` hooks and `onEnter` hooks.
 * 2. Post-LLM: collects from `finalize`, tools via `executeToolCalls`,
 *    branches via `evaluateBranches`.
 *
 * Each entry is stamped with an emitter ID for debug logging. At phase
 * boundaries, the bus contents are merged using `flow.merge` and the
 * result is returned via `drain()`.
 *
 * Algorithm 4: position precedence `abort > complete > goTo/goToStep > reset`,
 * ties broken by emission order (last wins).
 *
 * **Validates: Requirements 1.3, 10.4, 10.5, 10.6**
 */

import type { Directive } from "../types/flow";
import { flow } from "./flow-namespace";
import { logger } from "../utils";

/** Phase of the turn pipeline the bus is currently collecting for. */
export type DirectiveBusPhase = "pre-llm" | "post-llm";

/** A single entry on the bus, stamped with its emitter for debug logging. */
export interface DirectiveBusEntry<TContext = unknown, TData = unknown> {
    directive: Directive<TContext, TData>;
    emitterId: string;
    phase: DirectiveBusPhase;
    /** Monotonically increasing emission index within the phase. */
    order: number;
}

/**
 * Per-turn directive collection bus.
 *
 * Usage:
 * ```ts
 * const bus = new DirectiveBus();
 * bus.setPhase('pre-llm');
 * bus.emit({ goTo: 'Booking' }, 'step.onEnter:ask_date');
 * bus.emit({ appendPrompt: ['Be concise.'] }, 'step.prepare:ask_date');
 * const merged = bus.drain(); // merges all collected directives
 * bus.setPhase('post-llm');
 * // ... collect post-LLM emissions ...
 * const postMerged = bus.drain();
 * ```
 */
export class DirectiveBus<TContext = unknown, TData = unknown> {
    private entries: DirectiveBusEntry<TContext, TData>[] = [];
    private currentPhase: DirectiveBusPhase = "pre-llm";
    private orderCounter = 0;

    /** Set the current collection phase. Resets the order counter for the new phase. */
    setPhase(phase: DirectiveBusPhase): void {
        this.currentPhase = phase;
        // Order counter is NOT reset — emission order is global within the turn
        // so that cross-phase comparisons (if ever needed) remain consistent.
    }

    /** Get the current phase. */
    getPhase(): DirectiveBusPhase {
        return this.currentPhase;
    }

    /**
     * Emit a directive onto the bus.
     *
     * @param directive - The directive to collect.
     * @param emitterId - Human-readable identifier of the emitter (for debug logging).
     */
    emit(directive: Directive<TContext, TData>, emitterId: string): void {
        if (!directive || typeof directive !== "object" || Array.isArray(directive)) {
            return; // Silently ignore non-object values (void returns from hooks)
        }

        // Check if the directive has any meaningful fields set
        const hasFields = Object.keys(directive).some(
            (k) => (directive as Record<string, unknown>)[k] !== undefined
        );
        if (!hasFields) {
            return; // Empty directive — nothing to collect
        }

        this.entries.push({
            directive,
            emitterId,
            phase: this.currentPhase,
            order: this.orderCounter++,
        });

        logger.debug(
            `[DirectiveBus] Collected directive from "${emitterId}" (phase=${this.currentPhase}, order=${this.orderCounter - 1})`
        );
    }

    /**
     * Drain the bus: merge all collected directives for the current phase
     * using Algorithm 4 (position precedence, last-wins tie-breaking,
     * shallow-merge for state writes).
     *
     * Returns `undefined` if no directives were collected.
     * After draining, the entries for the current phase are cleared.
     */
    drain(): Directive<TContext, TData> | undefined {
        const phaseEntries = this.entries.filter(
            (e) => e.phase === this.currentPhase
        );

        if (phaseEntries.length === 0) {
            return undefined;
        }

        // Log conflicts when multiple emitters set position or reply fields
        this.logConflicts(phaseEntries);

        // Merge all directives in emission order using flow.merge (pairwise reduction).
        // flow.merge implements Algorithm 4: position precedence with last-wins tie-breaking.
        let merged: Directive<TContext, TData> = phaseEntries[0].directive;
        for (let i = 1; i < phaseEntries.length; i++) {
            merged = flow.merge(merged, phaseEntries[i].directive);
        }

        // Strip pre-LLM-only fields from post-LLM phase emissions
        if (this.currentPhase === "post-llm") {
            const asAny = merged as Record<string, unknown>;
            const preLlmFields = ["appendPrompt", "injectTools", "halt"] as const;

            // Identify which fields are present BEFORE stripping (the merge may
            // alias phaseEntries[0].directive when there is a single emitter, so
            // we must collect emitter names first).
            const droppedFields: string[] = [];
            for (const f of preLlmFields) {
                if (asAny[f] !== undefined) {
                    droppedFields.push(f);
                }
            }

            if (droppedFields.length > 0) {
                // Identify emitters that contributed the dropped fields.
                const emitters = phaseEntries
                    .filter((e) => {
                        const d = e.directive as Record<string, unknown>;
                        return droppedFields.some((f) => d[f] !== undefined);
                    })
                    .map((e) => e.emitterId);

                // Now strip the fields from the merged result.
                for (const f of droppedFields) {
                    delete asAny[f];
                }

                logger.debug(
                    `[DirectiveBus] Dropped pre-LLM-only fields [${droppedFields.join(", ")}] from post-LLM emitters: ${emitters.join(", ")}`
                );
            }
        }

        // Clear entries for the drained phase
        this.entries = this.entries.filter((e) => e.phase !== this.currentPhase);

        return merged;
    }

    /**
     * Drain ALL entries regardless of phase. Used for final turn cleanup.
     * Returns `undefined` if no directives were collected.
     */
    drainAll(): Directive<TContext, TData> | undefined {
        if (this.entries.length === 0) {
            return undefined;
        }

        this.logConflicts(this.entries);

        let merged: Directive<TContext, TData> = this.entries[0].directive;
        for (let i = 1; i < this.entries.length; i++) {
            merged = flow.merge(merged, this.entries[i].directive);
        }

        this.entries = [];
        return merged;
    }

    /** Clear all collected entries and reset the bus for a new turn. */
    clear(): void {
        this.entries = [];
        this.orderCounter = 0;
        this.currentPhase = "pre-llm";
    }

    /** Get the number of entries currently on the bus. */
    get size(): number {
        return this.entries.length;
    }

    /** Get all entries (for inspection/testing). */
    getEntries(): ReadonlyArray<DirectiveBusEntry<TContext, TData>> {
        return this.entries;
    }

    /** Check if the bus has any entries for the current phase. */
    hasEntries(): boolean {
        return this.entries.some((e) => e.phase === this.currentPhase);
    }

    // ─── Private helpers ─────────────────────────────────────────────────────

    /**
     * Log debug-level conflict warnings when multiple emitters set position
     * fields or reply fields in the same phase.
     */
    private logConflicts(
        entries: DirectiveBusEntry<TContext, TData>[]
    ): void {
        // Check for position field conflicts
        const positionEmitters: Array<{ emitterId: string; field: string }> = [];
        for (const entry of entries) {
            const d = entry.directive as Record<string, unknown>;
            for (const field of ["abort", "complete", "goTo", "goToStep", "reset"]) {
                if (d[field] !== undefined) {
                    positionEmitters.push({ emitterId: entry.emitterId, field });
                }
            }
        }
        if (positionEmitters.length > 1) {
            const details = positionEmitters
                .map((e) => `${e.emitterId}(${e.field})`)
                .join(", ");
            logger.debug(
                `[DirectiveBus] Multiple position fields in one turn — conflict resolution applied. Emitters: ${details}`
            );
        }

        // Check for reply conflicts
        const replyEmitters = entries.filter(
            (e) => (e.directive as Record<string, unknown>).reply !== undefined
        );
        if (replyEmitters.length > 1) {
            const emitterIds = replyEmitters.map((e) => e.emitterId).join(", ");
            logger.debug(
                `[DirectiveBus] Multiple reply fields in one turn — using last emission. Emitters: ${emitterIds}`
            );
        }
    }
}
