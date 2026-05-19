/**
 * Auto-step chain executor.
 *
 * Walks consecutive `auto: true` steps in a single turn without making LLM calls.
 * Each auto-step runs its pre-LLM hooks (onEnter, prepare), evaluates skipIf/requires,
 * applies state writes, resolves branches, and advances to the next step.
 *
 * The chain terminates when:
 * - An interactive step (auto !== true) is reached → returned as `resolvedStep`
 * - A `prepare` returns `{ halt: true, reply? }` → turn ends with verbatim reply
 * - A position-changing directive (goTo, goToStep, complete) is returned
 * - The last auto-step has no successor → flow is complete
 * - The chain exceeds `maxAutoStepsPerTurn` → throws FlowConfigurationError
 *
 * Implements Algorithm 1 from `.kiro/specs/auto-steps/design.md`.
 */

import type { SessionState } from "../types";
import type { Event } from "../types/history";
import { FlowConfigurationError, Step } from "./Step";
import { Flow } from "./Flow";
import { enterStep, mergeCollected, logger } from "../utils";
import { createTemplateContext } from "../utils/template";
import type { StoppedReason } from "../types/flow";

/**
 * The directive-like object that `prepare` may return on auto-steps.
 * This is a structural subset of the full PreDirective that v2 will formalize.
 */
export interface AutoStepPrepareResult {
    dataUpdate?: Record<string, unknown>;
    contextUpdate?: Record<string, unknown>;
    halt?: boolean;
    reply?: string;
    /** Position-changing: jump to a step within the current flow. */
    goToStep?: string;
    /** Position-changing: jump to another flow. */
    goTo?: string;
    /** Position-changing: mark the flow as complete. */
    complete?: boolean;
}

/**
 * A branch predicate context passed to `if` functions.
 */
interface BranchPredicateContext<TContext, TData> {
    data: Partial<TData> | undefined;
    context: TContext;
    session: SessionState<TData>;
    history: Event[];
}

/**
 * A branch `then` target — either a string step/flow id or a directive object.
 */
type BranchThen = string | { goToStep?: string; goTo?: string } | undefined;

/**
 * A branch entry on a step. Supports code predicates (`if`), AI predicates (`when`),
 * and a target (`then`).
 */
interface BranchEntry<TContext, TData> {
    if?: ((ctx: BranchPredicateContext<TContext, TData>) => boolean | Promise<boolean>) | Array<(ctx: BranchPredicateContext<TContext, TData>) => boolean | Promise<boolean>>;
    when?: string;
    then?: BranchThen;
}

/**
 * Structural type for a step that may have branches (accessed via cast).
 */
interface StepWithBranches<TContext, TData> {
    branches?: BranchEntry<TContext, TData>[];
    onEnter?: (context: TContext, data: Partial<TData> | undefined) => Promise<unknown>;
}

/**
 * Result of running the auto-chain.
 */
export interface AutoChainResult<TContext = unknown, TData = unknown> {
    /** The interactive step to hand off to the LLM path (undefined if chain ended without one). */
    resolvedStep?: Step<TContext, TData>;
    /** The merged directive from the halting auto-step's prepare (only set when stoppedReason = 'halt'). */
    mergedDirective?: AutoStepPrepareResult;
    /** Why the chain stopped, if it didn't reach an interactive step normally. */
    stoppedReason?: StoppedReason;
    /** Updated session after all auto-step state writes. */
    session: SessionState<TData>;
}

/**
 * Configuration for AutoChainExecutor.
 */
export interface AutoChainExecutorOptions {
    /** Maximum number of auto-steps walked in a single turn before throwing. */
    maxAutoStepsPerTurn: number;
}

/**
 * Parameters for a single chain run.
 */
export interface AutoChainRunParams<TContext, TData> {
    session: SessionState<TData>;
    context: TContext;
    flow: Flow<TContext, TData>;
    /** Conversation history (used for branch predicate context). Optional. */
    history?: Event[];
}

/**
 * Executes the auto-step chain for a single turn.
 *
 * Algorithm 1 from design.md — walks while `currentStep.auto === true`,
 * executing skipIf → requires → onEnter/prepare → state writes →
 * halt check → position directives → branches → linear advance.
 */
export class AutoChainExecutor<TContext = unknown, TData = unknown> {
    constructor(private readonly options: AutoChainExecutorOptions) { }

    /**
     * Run the auto-step chain starting from the current step on the session.
     */
    async run(params: AutoChainRunParams<TContext, TData>): Promise<AutoChainResult<TContext, TData>> {
        const { context, flow, history = [] } = params;
        const { maxAutoStepsPerTurn } = this.options;
        let { session } = params;
        const visited: string[] = [];

        while (true) {
            // Resolve the current step from session
            const currentStepId = session.currentStep?.id;
            if (!currentStepId) {
                // No current step — nothing to walk. Return undefined resolvedStep.
                return { session };
            }

            const step = flow.getStep(currentStepId);
            if (!step) {
                // Step not found in flow — shouldn't happen, but bail gracefully.
                return { session };
            }

            // If the step is not auto, hand off to the interactive path
            if (!step.auto) {
                return { resolvedStep: step, session };
            }

            // Track visited steps for cap/cycle detection
            visited.push(step.id);
            if (visited.length > maxAutoStepsPerTurn) {
                throw new FlowConfigurationError(
                    `[FlowConfigurationError] Auto-step chain exceeded limit: visited ${visited.length} steps which exceeds maxAutoStepsPerTurn (${maxAutoStepsPerTurn}). ` +
                    `Break the cycle or increase maxAutoStepsPerTurn. Visited: ${visited.join(' → ')}.`
                );
            }

            logger.debug(`[AutoChainExecutor] Processing auto-step: ${step.id} (${visited.length}/${maxAutoStepsPerTurn})`);

            // STEP 1: skip evaluation (code-only predicates, OR semantics)
            if (step.skip) {
                const templateContext = createTemplateContext<TContext, TData>({
                    context,
                    data: session.data,
                    session,
                    history,
                });
                const skipResult = await step.evaluateSkip(templateContext);

                if (skipResult.shouldSkip) {
                    logger.debug(`[AutoChainExecutor] Skipping auto-step ${step.id} due to skip condition`);
                    const nextSteps = step.getTransitions();
                    if (nextSteps.length === 0) {
                        // Last step was skipped and has no successor → flow complete
                        return { stoppedReason: 'last_step', session };
                    }
                    session = enterStep(session, nextSteps[0].id, nextSteps[0].description);
                    continue;
                }
            }

            // STEP 2: requires assertion
            if (step.requires && step.requires.length > 0) {
                const sessionData = (session.data || {}) as Record<string, unknown>;
                const missing = step.requires.filter(
                    field => sessionData[String(field)] === undefined
                );
                if (missing.length > 0) {
                    throw new FlowConfigurationError(
                        `[FlowConfigurationError] Auto-step "${step.id}" missing required fields: fields [${missing.join(', ')}] must be populated before this step runs. ` +
                        `Ensure a preceding step or hook populates these fields.`
                    );
                }
            }

            // STEP 3: Run pre-LLM hooks (onEnter, prepare) and collect directives
            const merged = await this.runStepHooks(step, session, context);

            // Apply state writes immediately so subsequent steps see them
            if (merged) {
                if (merged.dataUpdate && Object.keys(merged.dataUpdate).length > 0) {
                    session = mergeCollected(session, merged.dataUpdate);
                    logger.debug(`[AutoChainExecutor] Applied dataUpdate from step ${step.id}`);
                }
                if (merged.contextUpdate && Object.keys(merged.contextUpdate).length > 0) {
                    // contextUpdate is reserved for future agent-level application.
                    // The caller can read mergedDirective.contextUpdate and apply it externally.
                    logger.debug(`[AutoChainExecutor] contextUpdate from step ${step.id} will be applied by caller`);
                }

                // STEP 4: halt short-circuit
                if (merged.halt) {
                    logger.debug(`[AutoChainExecutor] Halt directive from step ${step.id}`);
                    return {
                        resolvedStep: step,
                        mergedDirective: merged,
                        stoppedReason: 'halt',
                        session,
                    };
                }

                // STEP 5: position-changing directive (goToStep, goTo, complete)
                if (merged.goToStep) {
                    const targetStep = flow.getStep(merged.goToStep);
                    if (!targetStep) {
                        throw new FlowConfigurationError(
                            `[FlowConfigurationError] Auto-step "${step.id}" goToStep targets unknown step: "${merged.goToStep}" does not exist in the current flow. ` +
                            `Check the step id or use goTo to target a different flow.`
                        );
                    }
                    session = enterStep(session, targetStep.id, targetStep.description);
                    logger.debug(`[AutoChainExecutor] Position directive goToStep → ${targetStep.id}`);
                    continue; // Re-enter loop at the new step (which may itself be auto)
                }
                if (merged.goTo) {
                    // goTo targets a flow — return to pipeline for cross-flow handling
                    return {
                        resolvedStep: step,
                        mergedDirective: merged,
                        stoppedReason: 'goto',
                        session,
                    };
                }
                if (merged.complete) {
                    return {
                        resolvedStep: step,
                        mergedDirective: merged,
                        stoppedReason: 'completed',
                        session,
                    };
                }
            }

            // STEP 6: branches resolution (if step has branches)
            const stepWithBranches = step as unknown as StepWithBranches<TContext, TData>;
            if (stepWithBranches.branches && Array.isArray(stepWithBranches.branches) && stepWithBranches.branches.length > 0) {
                const branchTarget = await this.evaluateBranches(
                    stepWithBranches.branches,
                    session,
                    context,
                    history
                );
                if (branchTarget) {
                    // Check if it resolves to a step in this flow
                    const targetStep = flow.getStep(branchTarget);
                    if (targetStep) {
                        session = enterStep(session, targetStep.id, targetStep.description);
                        logger.debug(`[AutoChainExecutor] Branch resolved → ${targetStep.id}`);
                        continue;
                    }
                    // Not a step in this flow — treat as a flow id, return to pipeline
                    return {
                        resolvedStep: step,
                        mergedDirective: { goTo: branchTarget },
                        stoppedReason: 'goto',
                        session,
                    };
                }
                // No branch matched — fall through to linear advance
            }

            // STEP 7: linear advance
            const nextSteps = step.getTransitions();
            if (nextSteps.length === 0) {
                // Auto-step is the last step → flow completes
                logger.debug(`[AutoChainExecutor] Auto-step ${step.id} is terminal — flow complete`);
                return { stoppedReason: 'last_step', session };
            }

            // Take the first transition (linear advance)
            session = enterStep(session, nextSteps[0].id, nextSteps[0].description);
        }
    }

    /**
     * Run onEnter and prepare hooks for an auto-step, collecting any
     * PreDirective-like return values.
     */
    private async runStepHooks(
        step: Step<TContext, TData>,
        session: SessionState<TData>,
        context: TContext
    ): Promise<AutoStepPrepareResult | undefined> {
        let merged: AutoStepPrepareResult | undefined;

        // onEnter (future hook — not yet in StepOptions, but handle if present)
        const stepWithHooks = step as unknown as StepWithBranches<TContext, TData>;
        if (typeof stepWithHooks.onEnter === 'function') {
            const onEnterResult = await stepWithHooks.onEnter(context, session.data);
            if (onEnterResult && typeof onEnterResult === 'object') {
                merged = this.mergeDirectives(merged, onEnterResult as AutoStepPrepareResult);
            }
        }

        // prepare hook — for auto-steps, prepare may return a PreDirective-like object
        if (step.prepare) {
            if (typeof step.prepare === 'function') {
                const prepareResult = await (step.prepare as (
                    context: TContext,
                    data?: Partial<TData>
                ) => Promise<unknown>)(
                    context,
                    session.data
                );
                // prepare may return void or a directive-like object
                if (prepareResult && typeof prepareResult === 'object') {
                    merged = this.mergeDirectives(merged, prepareResult as AutoStepPrepareResult);
                }
            } else {
                // Tool reference (string or Tool object) — for auto-steps, tool-based
                // prepare cannot return directives. Log a warning.
                logger.warn(
                    `[FlowConfigurationError] Auto-step "${step.id}" has a tool-based prepare: tool-based prepare on auto-steps cannot return directives. ` +
                    `Use a function-based prepare hook instead.`
                );
            }
        }

        return merged;
    }

    /**
     * Merge two directive-like objects. Later values override earlier ones
     * for scalar fields; object fields (dataUpdate, contextUpdate) are deep-merged.
     */
    private mergeDirectives(
        base: AutoStepPrepareResult | undefined,
        incoming: AutoStepPrepareResult
    ): AutoStepPrepareResult {
        if (!base) return { ...incoming };
        return {
            dataUpdate: incoming.dataUpdate
                ? { ...(base.dataUpdate || {}), ...incoming.dataUpdate }
                : base.dataUpdate,
            contextUpdate: incoming.contextUpdate
                ? { ...(base.contextUpdate || {}), ...incoming.contextUpdate }
                : base.contextUpdate,
            halt: incoming.halt ?? base.halt,
            reply: incoming.reply ?? base.reply,
            goTo: incoming.goTo ?? base.goTo,
            goToStep: incoming.goToStep ?? base.goToStep,
            complete: incoming.complete ?? base.complete,
        };
    }

    /**
     * Evaluate branches on an auto-step. Returns the target step/flow id
     * if a branch matches, or undefined if no branch matched.
     *
     * This is a simplified evaluator for code-only (`if`) branches.
     * AI-evaluated (`when`) branches are not supported in the auto-step
     * context (no LLM call). If a branch entry has only `when`, it is skipped.
     */
    private async evaluateBranches(
        branches: BranchEntry<TContext, TData>[],
        session: SessionState<TData>,
        context: TContext,
        history: Event[]
    ): Promise<string | undefined> {
        for (let i = 0; i < branches.length; i++) {
            const entry = branches[i];

            // Unconditional entry (no `if` and no `when`) — must be last, always matches
            if (!entry.if && !entry.when) {
                return this.resolveBranchThen(entry.then);
            }

            // Code predicate evaluation
            if (entry.if) {
                const predicates = Array.isArray(entry.if) ? entry.if : [entry.if];
                const predicateContext: BranchPredicateContext<TContext, TData> = { data: session.data, context, session, history };

                let allPassed = true;
                for (const predicate of predicates) {
                    if (typeof predicate === 'function') {
                        const result = await predicate(predicateContext);
                        if (!result) {
                            allPassed = false;
                            break;
                        }
                    }
                }

                if (!allPassed) continue;

                // If entry also has `when`, skip it in auto-step context (no LLM available)
                if (entry.when) {
                    logger.debug(
                        `[AutoChainExecutor] Branch entry has 'when' condition — ` +
                        `skipping AI evaluation in auto-step context`
                    );
                    continue;
                }

                return this.resolveBranchThen(entry.then);
            }

            // Entry has only `when` (AI condition) — skip in auto-step context
            if (entry.when && !entry.if) {
                continue;
            }
        }

        return undefined;
    }

    /**
     * Resolve a branch entry's `then` value to a string target.
     * Handles both string targets and Directive objects.
     */
    private resolveBranchThen(then: BranchThen): string | undefined {
        if (typeof then === 'string') {
            return then;
        }
        // Directive object — extract position field
        if (then && typeof then === 'object') {
            if (then.goToStep) return then.goToStep;
            if (then.goTo) return then.goTo;
        }
        return undefined;
    }
}
