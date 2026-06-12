/**
 * StepLifecycle executes step `prepare` and `finalize` handlers.
 *
 * A handler may be a function, a registered tool id, or an inline tool.
 * Used by the response prepare phase (prepare) and by SessionFinalizer
 * (finalize).
 */

import type { PrepareResult, SessionState, Tool } from "../types";
import type { Flow } from "./Flow";
import type { Step } from "./Step";
import type { ToolManager } from "./ToolManager";
import { logger } from "../utils";

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
     * Execute prepare function for the session's current step if available.
     * Auto-steps are skipped — their prepare is handled by AutoChainExecutor.
     */
    async runPrepare(session: SessionState<TData>, context: TContext): Promise<void> {
        if (session.currentFlow && session.currentStep) {
            const currentFlow = this.deps.getFlows().find(
                (r) => r.id === session.currentFlow?.id
            );
            if (currentFlow) {
                const currentStep = currentFlow.getStep(session.currentStep.id);
                // Skip auto-steps — their prepare is handled by AutoChainExecutor
                if (currentStep?.auto) {
                    logger.debug(`[ResponseModal] Skipping pre-routing prepare for auto-step: ${currentStep.id}`);
                    return;
                }
                if (currentStep?.prepare) {
                    logger.debug(`[ResponseModal] Executing prepare for step: ${currentStep.id}`);
                    await this.executePrepareFinalize(
                        currentStep.prepare,
                        context,
                        session.data,
                        currentFlow,
                        currentStep
                    );
                }
            }
        }
    }

    /**
     * Execute finalize function for the session's current step if available.
     */
    async runFinalize(session: SessionState<TData>, context: TContext): Promise<void> {
        if (session.currentFlow && session.currentStep) {
            const currentFlow = this.deps.getFlows().find(
                (r) => r.id === session.currentFlow?.id
            );
            if (currentFlow) {
                const currentStep = currentFlow.getStep(session.currentStep.id);
                if (currentStep?.finalize) {
                    logger.debug(
                        `[ResponseModal] Executing finalize for step: ${currentStep.id}`
                    );
                    await this.executePrepareFinalize(
                        currentStep.finalize,
                        context,
                        session.data,
                        currentFlow,
                        currentStep
                    );
                }
            }
        }
    }

    /**
     * Execute a prepare or finalize function/tool.
     */
    private async executePrepareFinalize(
        prepareOrFinalize:
            | string
            | Tool<TContext, TData>
            | ((context: TContext, data?: Partial<TData>) => void | PrepareResult | Promise<void | PrepareResult>)
            | undefined,
        context: TContext,
        data?: Partial<TData>,
        flow?: Flow<TContext, TData>,
        step?: Step<TContext, TData>
    ): Promise<void> {
        if (!prepareOrFinalize) return;

        if (typeof prepareOrFinalize === "function") {
            // It's a function - call it directly
            await prepareOrFinalize(context, data);
        } else {
            // It's a tool reference - find and execute the tool
            let tool: Tool<TContext, TData> | undefined;

            if (typeof prepareOrFinalize === "string") {
                // Tool ID - use ToolManager for unified resolution
                tool = this.deps.toolManager.find(prepareOrFinalize, undefined, step, flow);
            } else {
                // Tool object - use directly
                tool = prepareOrFinalize;
            }

            if (tool) {
                // Use ToolManager for unified tool execution
                const result = await this.deps.toolManager.executeTool({
                    tool,
                    context,
                    updateContext: this.deps.updateContext,
                    updateData: this.deps.updateData,
                    history: [], // Empty history for prepare/finalize
                    data,
                });

                if (!result.success) {
                    logger.error(
                        `[ResponseModal] Tool execution failed in prepare/finalize: ${result.error}`
                    );
                    throw new Error(`Tool execution failed: ${result.error}`);
                }
            } else {
                logger.warn(
                    `[ResponseModal] Tool not found for prepare/finalize: ${typeof prepareOrFinalize === "string"
                        ? prepareOrFinalize
                        : "inline tool"
                    }`
                );
            }
        }
    }
}
