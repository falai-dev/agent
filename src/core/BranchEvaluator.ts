/**
 * Branch Evaluator — Resolution Algorithm (Algorithm 2 from design.md)
 *
 * Pure function that evaluates a BranchMap in declaration order.
 * Code-first evaluation: `if` predicates run before `when` (AI) conditions
 * to save tokens. First matching entry wins.
 *
 * @module BranchEvaluator
 */

import type {
    BranchMap,
    BranchPredicate,
    BranchPredicateContext,
    Directive,
} from "../types/flow";
import type { AiProvider } from "../types/ai";
import type { Event } from "../types/history";
import { eventsToHistory, logger } from "../utils";

/**
 * The AI condition evaluator function signature.
 * Accepts an array of condition strings (OR semantics) and returns
 * whether any condition is satisfied.
 *
 * This is the same evaluation mechanism used by `step.when` — condition
 * strings are evaluated by the AI provider against the conversation context.
 */
export type AiConditionEvaluator = (conditions: string[]) => Promise<boolean>;

/**
 * Creates an `AiConditionEvaluator` bound to a provider and conversation context.
 *
 * Reuses the same evaluation pattern as `step.when` array forms: condition
 * strings are passed to the AI provider for evaluation against the conversation
 * history. No new prompt scaffolding — the provider evaluates whether the
 * conditions are met based on the conversation so far.
 *
 * String form (`when: "some condition"`) is normalized to a single-element
 * array by the caller (`evaluateBranches`) for uniformity before reaching
 * this function.
 *
 * @param provider - The AI provider to use for condition evaluation
 * @param history - Conversation history (events) for context
 * @param context - Agent-level context
 * @returns An `AiConditionEvaluator` function
 */
export function createAiConditionEvaluator<TContext = unknown>(
    provider: AiProvider,
    history: Event[],
    context: TContext,
): AiConditionEvaluator {
    return async (conditions: string[]): Promise<boolean> => {
        if (conditions.length === 0) {
            return true;
        }

        const conditionText = conditions.length === 1
            ? conditions[0]
            : conditions.map((c, i) => `${i + 1}. ${c}`).join("\n");

        const prompt = [
            "Evaluate whether the following condition(s) are met based on the conversation so far.",
            "",
            "Condition(s):",
            conditionText,
            "",
            "Return JSON with a single boolean field `result`: true if ANY condition is satisfied, false otherwise.",
        ].join("\n");

        const result = await provider.generateMessage<TContext, { result: boolean }>({
            prompt,
            history: eventsToHistory(history),
            context,
            parameters: {
                jsonSchema: {
                    type: "object",
                    properties: {
                        result: {
                            type: "boolean",
                            description: "Whether any condition is met based on the conversation context",
                        },
                    },
                    required: ["result"],
                    additionalProperties: false,
                },
                schemaName: "condition_evaluation",
            },
        });

        return result.structured?.result ?? false;
    };
}

/**
 * Evaluates a BranchMap in declaration order, returning the first matching
 * entry's `then` value, or `undefined` if no entry matches.
 *
 * Resolution rules per entry:
 * 1. Unconditional (no `when`, no `if`) → return `then` immediately.
 * 2. `if` first: normalize to array, await each predicate, short-circuit on first falsy.
 * 3. `when` second: only if `if` passed (or absent); call evaluateAi with condition strings.
 * 4. Both passed (or only one set and it passed) → return `then`.
 *
 * Errors in predicates or AI evaluation are caught, logged at ERROR, and
 * cause `evaluateBranches` to return `undefined` (graceful degradation).
 */
export async function evaluateBranches<TContext = unknown, TData = unknown>(
    branches: BranchMap<TContext, TData>,
    ctx: BranchPredicateContext<TContext, TData>,
    evaluateAi: AiConditionEvaluator,
): Promise<string | Directive<TContext, TData> | undefined> {
    try {
        for (let i = 0; i < branches.length; i++) {
            const entry = branches[i];

            // Unconditional fallback: entry has neither `when` nor `if`.
            // Validation guarantees this is the LAST entry.
            if (!entry.when && !entry.if) {
                return entry.then;
            }

            // Code predicate first (free evaluation)
            if (entry.if) {
                const predicates: BranchPredicate<TContext, TData>[] = Array.isArray(entry.if)
                    ? entry.if
                    : [entry.if];

                let ifPassed = true;
                for (const predicate of predicates) {
                    const result = await predicate(ctx);
                    if (!result) {
                        ifPassed = false;
                        break;
                    }
                }

                if (!ifPassed) {
                    continue; // skip this entry; do NOT evaluate `when`
                }
            }

            // AI condition (costs tokens — only reached if `if` passed or was absent)
            if (entry.when) {
                const conditions: string[] = Array.isArray(entry.when)
                    ? entry.when
                    : [entry.when];

                const aiResult = await evaluateAi(conditions);
                if (!aiResult) {
                    continue; // skip this entry
                }
            }

            // Both passed (or only one was set and it passed)
            return entry.then;
        }

        // No entry matched
        return undefined;
    } catch (error) {
        logger.error(
            `[BranchEvaluator] Error during branch evaluation: ${error instanceof Error ? error.message : String(error)}`
        );
        return undefined;
    }
}
