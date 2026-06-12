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
    BranchPredicateContext,
    Directive,
} from "../types/flow";
import type { AiProvider } from "../types/ai";
import type { Event } from "../types/history";
import { eventsToHistory, logger } from "../utils";
import { splitWhenConditions, evaluateIfPredicates, type WhenConditionGroups } from "../utils/condition";

/**
 * The AI condition evaluator function signature.
 * Accepts split condition strings and returns whether the condition passes:
 * (no positives OR any positive is satisfied) AND no exclusion is satisfied.
 *
 * This is the same evaluation mechanism used by `step.when` — condition
 * strings are evaluated by the AI provider against the conversation context.
 */
export type AiConditionEvaluator = (conditions: WhenConditionGroups) => Promise<boolean>;

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
    return async (conditions: WhenConditionGroups): Promise<boolean> => {
        if (conditions.positive.length === 0 && conditions.negative.length === 0) {
            return true;
        }

        const positiveText = conditions.positive.length === 0
            ? "None. Treat the positive side as satisfied unless an exclusion matches."
            : conditions.positive.map((c, i) => `${i + 1}. ${c}`).join("\n");
        const negativeText = conditions.negative.length === 0
            ? "None."
            : conditions.negative.map((c, i) => `${i + 1}. ${c}`).join("\n");

        const prompt = [
            "Evaluate whether the following condition rule passes based on the conversation so far.",
            "",
            "Positive condition(s) (OR):",
            positiveText,
            "",
            "Exclusion condition(s) (OR, any match inhibits):",
            negativeText,
            "",
            "Return JSON with a single boolean field `result`: true only when (there are no positive conditions OR ANY positive condition is satisfied) AND NO exclusion condition is satisfied.",
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
                            description: "Whether the positive/exclusion condition rule passes based on the conversation context",
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
                const ifPassed = await evaluateIfPredicates<BranchPredicateContext<TContext, TData>>(
                    entry.if, ctx, "BranchEvaluator"
                );
                if (!ifPassed) {
                    continue; // skip this entry; do NOT evaluate `when`
                }
            }

            // AI condition (costs tokens — only reached if `if` passed or was absent)
            if (entry.when) {
                const conditions = splitWhenConditions(entry.when);

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
