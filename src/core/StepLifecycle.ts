/**
 * StepLifecycle executes step `prepare` and `finalize` handlers.
 *
 * A handler may be a function, a registered tool id, or an inline tool.
 * Used by the response prepare phase (prepare) and by SessionFinalizer
 * (finalize).
 *
 * Handlers may emit directives three ways: a function's return value,
 * `ctx.dispatch()` inside a tool, or a `{ directive }` tool return. All are
 * merged via the canonical Algorithm 4 (`flow.merge`) and validated with
 * `flow.validate`. State writes (`dataUpdate`/`contextUpdate`) are applied
 * immediately to the TURN session — never to agent-level live state — so
 * persistence captures them. Remaining control-flow fields (position fields,
 * verbatim replies, halts) are returned to the caller to act on.
 */

import type { Directive, PrepareResult, SessionState, Tool } from "../types";
import type { Flow } from "./Flow";
import type { Step } from "./Step";
import type { ToolManager } from "./ToolManager";
import { flow } from "./flow-namespace";
import { logger } from "../utils";

/** Fields a caller can still act on after state writes have been applied. */
const CONTROL_FIELDS = [
    "goTo",
    "goToStep",
    "reset",
    "complete",
    "abort",
    "reply",
    "halt",
    "appendPrompt",
    "injectTools",
] as const;

function hasControlFields(directive: Directive): boolean {
    return CONTROL_FIELDS.some(
        (field) =>
            (directive as Record<string, unknown>)[field] !== undefined &&
            (directive as Record<string, unknown>)[field] !== null
    );
}

export class StepLifecycle<TContext = unknown, TData = unknown> {
    constructor(
        private readonly deps: {
            getFlows: () => Flow<TContext, TData>[];
            toolManager: ToolManager<TContext, TData>;
            updateContext: (updates: Partial<TContext>) => Promise<void>;
            updateData: (updates: Partial<TData>) => Promise<void>;
        }
    ) { }

    /**
     * Execute prepare for the session's current step if available.
     * Returns the merged control-flow directive, if the handler emitted one.
     * Auto-steps are skipped — their prepare is handled by AutoChainExecutor.
     */
    async runPrepare(
        session: SessionState<TData>,
        context: TContext
    ): Promise<Directive<TContext, TData> | undefined> {
        if (session.currentFlow && session.currentStep) {
            const currentFlow = this.deps.getFlows().find(
                (r) => r.id === session.currentFlow?.id
            );
            if (currentFlow) {
                const currentStep = currentFlow.getStep(session.currentStep.id);
                // Skip auto-steps — their prepare is handled by AutoChainExecutor
                if (currentStep?.auto) {
                    logger.debug(`[StepLifecycle] Skipping pre-routing prepare for auto-step: ${currentStep.id}`);
                    return undefined;
                }
                if (currentStep?.prepare) {
                    logger.debug(`[StepLifecycle] Executing prepare for step: ${currentStep.id}`);
                    return this.executePrepareFinalize(
                        currentStep.prepare,
                        context,
                        session,
                        currentFlow,
                        currentStep
                    );
                }
            }
        }
        return undefined;
    }

    /**
     * Execute finalize for the session's current step if available.
     * Returns the merged control-flow directive, if the handler emitted one.
     */
    async runFinalize(
        session: SessionState<TData>,
        context: TContext
    ): Promise<Directive<TContext, TData> | undefined> {
        if (session.currentFlow && session.currentStep) {
            const currentFlow = this.deps.getFlows().find(
                (r) => r.id === session.currentFlow?.id
            );
            if (currentFlow) {
                const currentStep = currentFlow.getStep(session.currentStep.id);
                if (currentStep?.finalize) {
                    logger.debug(
                        `[StepLifecycle] Executing finalize for step: ${currentStep.id}`
                    );
                    return this.executePrepareFinalize(
                        currentStep.finalize,
                        context,
                        session,
                        currentFlow,
                        currentStep
                    );
                }
            }
        }
        return undefined;
    }

    /**
     * Execute a prepare or finalize handler and resolve its emitted directives.
     */
    private async executePrepareFinalize(
        prepareOrFinalize:
            | string
            | Tool<TContext, TData>
            | ((context: TContext, data?: Partial<TData>) => void | PrepareResult<TContext, TData> | Promise<void | PrepareResult<TContext, TData>>)
            | undefined,
        context: TContext,
        session: SessionState<TData>,
        flowRef?: Flow<TContext, TData>,
        step?: Step<TContext, TData>
    ): Promise<Directive<TContext, TData> | undefined> {
        if (!prepareOrFinalize) return undefined;

        const collected: Directive<TContext, TData>[] = [];

        /** State writes land on the TURN session so persistence captures them. */
        const writeToSession = (updates: Partial<TData> | Record<string, unknown> | undefined): void => {
            if (!updates) return;
            session.data = { ...(session.data ?? {}), ...updates };
        };

        if (typeof prepareOrFinalize === "function") {
            // It's a function - call it and honor its return value
            const result = await prepareOrFinalize(context, session.data);
            if (result && typeof result === "object") {
                collected.push(result);
            }
        } else {
            // It's a tool reference - find and execute the tool
            let tool: Tool<TContext, TData> | undefined;

            if (typeof prepareOrFinalize === "string") {
                // Tool ID - use ToolManager for unified resolution
                tool = this.deps.toolManager.find(prepareOrFinalize, undefined, step, flowRef);
            } else {
                // Tool object - use directly
                tool = prepareOrFinalize;
            }

            if (tool) {
                // Use ToolManager for unified tool execution. updateData writes
                // into the turn session (previously it mutated the agent's live
                // session, losing writes made after the persistence snapshot).
                const result = await this.deps.toolManager.executeTool({
                    tool,
                    context,
                    updateContext: this.deps.updateContext,
                    updateData: async (updates) => {
                        writeToSession(updates);
                        await this.deps.updateData(updates);
                    },
                    history: [], // Empty history for prepare/finalize
                    data: session.data,
                });

                if (!result.success) {
                    logger.error(
                        `[StepLifecycle] Tool execution failed in prepare/finalize: ${result.error}`
                    );
                    throw new Error(`Tool execution failed: ${result.error}`);
                }

                // Collect directives (ctx.dispatch / {directive} returns)
                if (result.directives?.length) {
                    collected.push(...(result.directives as Directive<TContext, TData>[]));
                }
                // Honor ToolResult-level state updates
                writeToSession(result.dataUpdate as Partial<TData> | undefined);
                if (result.contextUpdate) {
                    await this.deps.updateContext(result.contextUpdate as Partial<TContext>);
                }
            } else {
                logger.warn(
                    `[StepLifecycle] Tool not found for prepare/finalize: ${typeof prepareOrFinalize === "string"
                        ? prepareOrFinalize
                        : "inline tool"
                    }`
                );
            }
        }

        if (collected.length === 0) return undefined;

        // Canonical merge + validation — one algorithm shared with tools,
        // signals, and auto-steps.
        for (const directive of collected) {
            flow.validate(directive);
        }
        const merged = flow.mergeAll(collected);
        if (!merged) return undefined;

        // Apply state writes immediately; they are not control flow.
        writeToSession(merged.dataUpdate);
        if (merged.contextUpdate) {
            await this.deps.updateContext(merged.contextUpdate);
        }

        if (!hasControlFields(merged)) return undefined;

        // Pre-LLM augmentation fields (appendPrompt / injectTools / halt / reply)
        // have no sink on non-auto steps yet — surface loudly instead of silently
        // dropping them.
        if (
            (merged.appendPrompt?.length || merged.injectTools?.length || merged.halt || merged.reply) &&
            !step?.auto
        ) {
            logger.warn(
                `[StepLifecycle] Directive from "${step?.id ?? "step"}" ${flowRef ? `in flow "${flowRef.title}" ` : ""}` +
                `carries pre-LLM fields (appendPrompt/injectTools/halt/reply) that only auto-steps honor today. ` +
                `Use an auto step for prompt augmentation or a signal handler for halt+reply.`
            );
        }

        const control = { ...merged };
        delete control.dataUpdate;
        delete control.contextUpdate;
        return control;
    }
}
