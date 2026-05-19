/**
 * Per-turn directive chain depth tracker.
 *
 * When directives chain (e.g., tool emits goTo → flow.onEnter emits goTo →
 * flow.onComplete emits complete.next → …), the chain can theoretically loop
 * forever. This tracker counts each directive application within a single turn
 * and throws `FlowConfigurationError` when the configured cap is exceeded.
 *
 * Chain breakers (`abort` mid-chain) stop counting and apply the
 * chain-terminating directive immediately.
 *
 * Validates: Requirements 22.1, 22.2, 22.3
 */

import { FlowConfigurationError } from "./Step";
import { logger } from "../utils";
import type { Directive } from "../types/flow";

/**
 * Entry in the directive chain log — records what was emitted and by whom.
 */
export interface DirectiveChainEntry {
    /** Human-readable description of the directive (e.g., "goTo:Booking", "complete", "abort:timeout") */
    description: string;
    /** Identifier of the emitter (e.g., "tool:lookup_order", "hook:onEnter", "pending") */
    emitter: string;
}

/**
 * Tracks directive chain depth within a single turn.
 * Create one instance per turn; discard at turn end.
 */
export class DirectiveChainTracker {
    private chain: DirectiveChainEntry[] = [];
    private readonly maxDepth: number;

    constructor(maxDirectiveChain: number) {
        this.maxDepth = maxDirectiveChain;
    }

    /**
     * Record a directive application in the chain.
     * Throws `FlowConfigurationError` if the chain exceeds `maxDirectiveChain`.
     *
     * @param directive - The directive being applied
     * @param emitter - Identifier of the emitter (for diagnostics)
     * @returns `true` if the directive is a chain breaker (abort) — caller should
     *          apply it and stop the chain without further counting.
     */
    record(directive: Directive, emitter: string): boolean {
        const description = describeDirective(directive);

        // Check if this is a chain breaker (abort)
        if (directive.abort !== undefined) {
            this.chain.push({ description, emitter });
            logger.debug(
                `[DirectiveChainTracker] Chain breaker (abort) at depth ${this.chain.length}: ${description} from ${emitter}`
            );
            return true; // Chain breaker — apply and stop
        }

        this.chain.push({ description, emitter });

        if (this.chain.length > this.maxDepth) {
            const chainDescription = this.chain
                .map((entry, i) => `  ${i + 1}. ${entry.description} (from: ${entry.emitter})`)
                .join("\n");

            throw new FlowConfigurationError(
                `[FlowConfigurationError] Directive chain cycle detected: ` +
                `chain depth (${this.chain.length}) exceeded maxDirectiveChain (${this.maxDepth}). ` +
                `Review flow hooks and tool handlers for circular redirections.\n` +
                `Chain (in emission order):\n${chainDescription}`
            );
        }

        logger.debug(
            `[DirectiveChainTracker] Chain depth ${this.chain.length}/${this.maxDepth}: ${description} from ${emitter}`
        );

        return false; // Not a chain breaker — continue normally
    }

    /** Current chain depth. */
    get depth(): number {
        return this.chain.length;
    }

    /** The full chain log (read-only). */
    get entries(): ReadonlyArray<DirectiveChainEntry> {
        return this.chain;
    }

    /** Reset the tracker (e.g., for testing or if the turn is restarted). */
    reset(): void {
        this.chain = [];
    }
}

/**
 * Produce a human-readable one-line description of a directive for diagnostics.
 */
function describeDirective(directive: Directive): string {
    if (directive.abort !== undefined) {
        const reason = typeof directive.abort === "string"
            ? directive.abort
            : typeof directive.abort === "object"
                ? directive.abort.reason
                : "";
        return `abort${reason ? `:${reason}` : ""}`;
    }
    if (directive.goTo !== undefined) {
        const target = typeof directive.goTo === "string"
            ? directive.goTo
            : typeof directive.goTo === "object"
                ? directive.goTo.flow ?? "(no flow)"
                : "";
        return `goTo:${target}`;
    }
    if (directive.goToStep !== undefined) {
        const target = typeof directive.goToStep === "string"
            ? directive.goToStep
            : typeof directive.goToStep === "object"
                ? directive.goToStep.step
                : "";
        return `goToStep:${target}`;
    }
    if (directive.complete !== undefined) {
        if (directive.complete === true) return "complete";
        if (typeof directive.complete === "object" && directive.complete.next) {
            return "complete(chained)";
        }
        return "complete";
    }
    if (directive.reset !== undefined) {
        return "reset";
    }
    // State-only or reply-only directive
    const parts: string[] = [];
    if (directive.reply) parts.push("reply");
    if (directive.dataUpdate) parts.push("dataUpdate");
    if (directive.contextUpdate) parts.push("contextUpdate");
    return parts.length > 0 ? parts.join("+") : "(empty)";
}
