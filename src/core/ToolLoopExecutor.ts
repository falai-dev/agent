/**
 * ToolLoopExecutor owns dynamic tool execution during response generation:
 *
 * - `runLoop()` — the run-tools-then-ask-LLM-again follow-up loop used by the
 *   non-streaming path (and as the streaming fallback): executes the initial
 *   tool calls sequentially, asks the provider whether more tools are needed,
 *   reconstructs tool-result history items, and forces a final text response
 *   when tools ran but no message was produced.
 * - `runStreamingBatch()` — the streaming path's initial batch execution via
 *   ToolManager.executeWithConcurrency (StreamingToolExecutor concurrency
 *   rules), yielding tool-progress chunks; falls back to `runLoop()` when
 *   concurrent execution fails.
 *
 * ToolManager remains the registry/resolver and single-tool executor.
 */

import type {
    AgentOptions,
    AgentResponseStreamChunk,
    AgentStructuredResponse,
    Directive,
    HistoryItem,
    SessionState,
    ToolCallRequest,
} from "../types/index.js";
import type { Flow } from "./Flow.js";
import type { Step } from "./Step.js";
import type { ToolManager } from "./ToolManager.js";
import { ResponseGenerationError } from "./ResponseGenerationError.js";
import { flow } from "./flow-namespace.js";
import { historyToEvents, logger, serializeToolResult, assistantMessage, toolMessage } from "../utils/index.js";

/**
 * One attempted tool execution, keyed by CALL (not tool name): parallel or
 * repeated calls to the same tool in one turn keep their own results instead
 * of overwriting each other.
 */
interface ToolExecutionRecord {
    requestId: string;
    toolName: string;
    arguments: Record<string, unknown>;
    /** Which loop round produced this call (0 = the initial streamed batch). */
    round: number;
    /** Serialized result fed back to the model; set EVEN on failure. */
    result?: string;
}

const executionFailure = (toolName: string, error: unknown): string =>
    JSON.stringify({
        success: false,
        error: `${toolName}: ${error instanceof Error ? error.message : String(error)}`,
    });

const toolNotFoundFailure = (toolName: string): string =>
    JSON.stringify({ success: false, error: `Tool "${toolName}" is not registered in any scope.` });

export class ToolLoopExecutor<TContext = unknown, TData = unknown> {
    constructor(
        private readonly deps: {
            toolManager: ToolManager<TContext, TData>;
            getAgentOptions: () => AgentOptions<TContext, TData>;
            updateContext: (updates: Partial<TContext>) => Promise<void>;
            updateCollectedData: (updates: Partial<TData>) => Promise<void>;
            updateSessionData: (
                session: SessionState<TData>,
                dataUpdate: Partial<TData>
            ) => Promise<SessionState<TData>>;
            /** Maximum number of tool loops (defaults to 5). */
            maxToolLoops?: number;
        }
    ) { }

    /**
     * Unified tool execution logic with loop handling.
     * Consolidates the complex tool execution logic from both streaming and
     * non-streaming responses.
     */
    async runLoop(params: {
        toolCalls?: Array<{ toolName: string; arguments: Record<string, unknown> }>;
        context: TContext;
        session: SessionState<TData>;
        history: HistoryItem[];
        selectedFlow?: Flow<TContext, TData>;
        responsePrompt: string;
        availableTools: Array<{
            id: string;
            name: string;
            description?: string;
            parameters?: unknown;
        }>;
        responseSchema?: Record<string, unknown>;
        signal?: AbortSignal;
    }): Promise<{
        session: SessionState<TData>;
        finalToolCalls?: Array<{ toolName: string; arguments: Record<string, unknown> }>;
        finalMessage?: string;
        structured?: AgentStructuredResponse;
        /** Directives emitted by tools this turn (ctx.dispatch / `{directive}` returns), merged. */
        directives?: Directive<TContext, TData>;
    }> {
        try {
            const { context, history, selectedFlow, responsePrompt, availableTools, responseSchema, signal } = params;
            // The follow-up loop (which reassigned toolCalls) now lives in
            // runFollowUpLoop; here toolCalls is only read.
            const { toolCalls } = params;
            let { session } = params;

            // Directives emitted by tools this turn — consumed by the caller
            const collectedDirectives: Directive<TContext, TData>[] = [];

            // Convert HistoryItem[] to Event[] for internal processing
            const historyEvents = historyToEvents(history);

            // Execution records keyed by call — shared with the follow-up loop
            const records: ToolExecutionRecord[] = [];

            // Execute initial dynamic tool calls
            if (toolCalls && toolCalls.length > 0) {
                logger.debug(`[ToolLoopExecutor] Executing ${toolCalls.length} dynamic tool calls:`, toolCalls.map(tc => tc.toolName));

                for (const [callIndex, toolCall] of toolCalls.entries()) {
                    const record: ToolExecutionRecord = {
                        requestId: `init-${callIndex}-${toolCall.toolName}`,
                        toolName: toolCall.toolName,
                        arguments: toolCall.arguments,
                        round: 0,
                    };
                    records.push(record);

                    const tool = this.findAvailableTool(toolCall.toolName, selectedFlow);
                    if (!tool) {
                        logger.warn(`[ToolExecutionError] Tool not found: "${toolCall.toolName}" is not registered in any scope. Register the tool or check the tool name.`);
                        record.result = toolNotFoundFailure(toolCall.toolName);
                        continue;
                    }

                    try {
                        // Use ToolManager for unified tool execution
                        const toolResult = await this.deps.toolManager.executeTool({
                            tool,
                            context,
                            updateContext: this.deps.updateContext,
                            updateData: this.deps.updateCollectedData,
                            history: historyEvents, // Use Event[] for tool execution
                            data: session.data,
                            toolArguments: toolCall.arguments,
                        });

                        // Store the actual tool result data for history
                        record.result = serializeToolResult(toolResult);

                        // Collect tool-emitted directives (ctx.dispatch / {directive})
                        if (toolResult.directives?.length) {
                            collectedDirectives.push(...toolResult.directives as Directive<TContext, TData>[]);
                        }

                        // Check if tool execution was successful
                        if (!toolResult.success) {
                            logger.error(`[ToolLoopExecutor] Tool execution failed: ${toolCall.toolName} - ${toolResult.error}`);
                            // Continue with other tools rather than failing completely
                            continue;
                        }

                        // Update context with tool results
                        if (toolResult.contextUpdate) {
                            try {
                                await this.deps.updateContext(toolResult.contextUpdate as Partial<TContext>);
                            } catch (error) {
                                logger.error(`[ToolLoopExecutor] Failed to update context from tool ${toolCall.toolName}:`, error);
                                // Continue execution but log the error
                            }
                        }

                        // Update collected data with tool results
                        if (toolResult.dataUpdate) {
                            try {
                                session = await this.deps.updateSessionData(session, toolResult.dataUpdate as Partial<TData>);
                                logger.debug(`[ToolLoopExecutor] Tool updated collected data:`, toolResult.dataUpdate);
                            } catch (error) {
                                logger.error(`[ToolLoopExecutor] Failed to update data from tool ${toolCall.toolName}:`, error);
                                // Continue execution but log the error
                            }
                        }

                        logger.debug(`[ToolLoopExecutor] Executed dynamic tool: ${toolCall.toolName} (success: ${toolResult.success})`);
                    } catch (error) {
                        logger.error(`[ToolLoopExecutor] Tool execution error for ${toolCall.toolName}:`, error);
                        // A thrown handler must be visible to the model as a FAILED
                        // tool call — reporting success makes it confirm actions
                        // that never happened.
                        record.result = executionFailure(toolCall.toolName, error);
                        continue;
                    }
                }
            }

            // A tool spoke verbatim this turn: its reply IS the final message —
            // skip the follow-up LLM call (documented dispatch semantics).
            const preLoopDirectives = flow.mergeAll(collectedDirectives);
            if (preLoopDirectives?.reply) {
                logger.debug("[ToolLoopExecutor] Tool directive reply short-circuits follow-up LLM call");
                return {
                    session,
                    finalToolCalls: toolCalls,
                    finalMessage: preLoopDirectives.reply,
                    structured: { message: preLoopDirectives.reply },
                    directives: preLoopDirectives,
                };
            }

            // Hand off to the multi-round follow-up loop shared with the
            // streaming path. The initial batch above already executed
            // sequentially and populated the result maps.
            return await this.runFollowUpLoop({
                toolCalls,
                session,
                records,
                collectedDirectives,
                context,
                history,
                selectedFlow,
                responsePrompt,
                availableTools,
                responseSchema,
                signal,
            });
        } catch (error) {
            throw ResponseGenerationError.fromError(error, 'tool_execution', params, {
                toolCallsCount: params.toolCalls?.length || 0,
                availableToolsCount: params.availableTools.length
            });
        }
    }

    /**
     * The multi-round follow-up loop shared by the non-streaming (`runLoop`) and
     * streaming (`runStreamingBatch`) tool paths: re-prompt the model with the
     * tool results (tools available on the first round so it can chain further
     * calls), execute any further tool calls, repeat up to `maxToolLoops`, then
     * force a result-aware closing message if the model never produced one.
     * Callers run the *initial* batch — sequentially for `runLoop`, concurrently
     * (with progress) for `runStreamingBatch` — and pass the populated result
     * maps; from here both paths behave identically.
     */
    private async runFollowUpLoop(params: {
        toolCalls?: Array<{ toolName: string; arguments: Record<string, unknown> }>;
        session: SessionState<TData>;
        /** Execution records from prior rounds (initial batch = round 0). */
        records: ToolExecutionRecord[];
        /** Shared directive collector — initial-batch emissions land here too. */
        collectedDirectives?: Directive<TContext, TData>[];
        context: TContext;
        history: HistoryItem[];
        selectedFlow?: Flow<TContext, TData>;
        responsePrompt: string;
        availableTools: Array<{
            id: string;
            name: string;
            description?: string;
            parameters?: unknown;
        }>;
        responseSchema?: Record<string, unknown>;
        signal?: AbortSignal;
    }): Promise<{
        session: SessionState<TData>;
        finalToolCalls?: Array<{ toolName: string; arguments: Record<string, unknown> }>;
        finalMessage?: string;
        structured?: AgentStructuredResponse;
        directives?: Directive<TContext, TData>;
    }> {
        const { context, history, selectedFlow, responsePrompt, availableTools, responseSchema, signal, records, collectedDirectives = [] } = params;
        let { toolCalls, session } = params;
        try {
            // TOOL LOOP: Allow AI to make follow-up tool calls after initial tool execution
            // `??` so an explicit `maxToolLoops: 0` is honored instead of being
            // clobbered to the default by a falsy-zero check.
            const MAX_TOOL_LOOPS = this.deps.maxToolLoops ?? 5;
            let toolLoopCount = 0;
            let hasToolCalls = toolCalls && toolCalls.length > 0;
            let finalMessage: string | undefined;
            let followUpStructured: AgentStructuredResponse | undefined;

            while (hasToolCalls && toolLoopCount < MAX_TOOL_LOOPS) {
                toolLoopCount++;
                logger.debug(`[ToolLoopExecutor] Starting tool loop ${toolLoopCount}/${MAX_TOOL_LOOPS} with ${toolCalls?.length || 0} tool calls`);

                // Create tool result history items for the PREVIOUS round's
                // calls. Failures are reported as failures — never as success.
                const previousRound = toolLoopCount - 1;
                const roundRecords = records.filter((r) => r.round === previousRound);
                const toolResultHistoryItems: HistoryItem[] = [];
                for (const record of roundRecords) {
                    toolResultHistoryItems.push(
                        assistantMessage(null, [
                            { id: record.requestId, name: record.toolName, arguments: record.arguments },
                        ]),
                        toolMessage(
                            record.toolName,
                            record.requestId,
                            record.result ?? toolNotFoundFailure(record.toolName),
                        ),
                    );
                }

                // Create updated history with tool results
                const updatedHistory = [...history, ...toolResultHistoryItems];

                // Make follow-up AI call to see if more tools are needed.
                // Tools are offered EVERY iteration — the loop is already bounded
                // by MAX_TOOL_LOOPS, so withholding them after round  only made
                // maxToolLoops values above 2 unreachable.
                const agentOptions = this.deps.getAgentOptions();

                logger.debug(`[ToolLoopExecutor] Making follow-up AI call (loop ${toolLoopCount}):`, {
                    providingTools: true,
                    toolsCount: availableTools.length,
                });

                const followUpResult = await agentOptions.provider.generateMessage({
                    prompt: responsePrompt,
                    history: updatedHistory, // Use HistoryItem[] for AI provider
                    context,
                    tools: availableTools,
                    parameters: responseSchema ? {
                        jsonSchema: responseSchema,
                        schemaName: "tool_followup",
                    } : undefined,
                    signal,
                });

                // Check if follow-up call has more tool calls
                const followUpToolCalls = followUpResult.structured?.toolCalls;
                hasToolCalls = followUpToolCalls && followUpToolCalls.length > 0;

                logger.debug(`[ToolLoopExecutor] Follow-up AI response (loop ${toolLoopCount}):`, {
                    hasMessage: !!followUpResult.message,
                    messageLength: followUpResult.message?.length || 0,
                    hasToolCalls,
                    toolCallsCount: followUpToolCalls?.length || 0,
                    toolNames: followUpToolCalls?.map(tc => tc.toolName) || [],
                });

                if (hasToolCalls) {
                    logger.debug(`[ToolLoopExecutor] Follow-up call produced ${followUpToolCalls!.length} additional tool calls`);

                    // Execute the follow-up tool calls
                    for (const [callIndex, toolCall] of followUpToolCalls!.entries()) {
                        const record: ToolExecutionRecord = {
                            requestId: `fup-${toolLoopCount}-${callIndex}-${toolCall.toolName}`,
                            toolName: toolCall.toolName,
                            arguments: toolCall.arguments,
                            round: toolLoopCount,
                        };
                        records.push(record);

                        const tool = this.findAvailableTool(toolCall.toolName, selectedFlow);
                        if (!tool) {
                            logger.warn(`[ToolExecutionError] Tool not found in follow-up: "${toolCall.toolName}" is not registered in any scope. Register the tool or check the tool name.`);
                            record.result = toolNotFoundFailure(toolCall.toolName);
                            continue;
                        }

                        try {
                            // Use ToolManager for unified tool execution
                            const toolResult = await this.deps.toolManager.executeTool({
                                tool,
                                context,
                                updateContext: this.deps.updateContext,
                                updateData: this.deps.updateCollectedData,
                                history: historyToEvents(updatedHistory), // Convert to Event[] for tool execution
                                data: session.data,
                                toolArguments: toolCall.arguments,
                            });

                            // Check if tool execution was successful
                            if (!toolResult.success) {
                                logger.error(`[ToolLoopExecutor] Follow-up tool execution failed: ${toolCall.toolName} - ${toolResult.error}`);
                                continue;
                            }

                            // Update context with follow-up tool results
                            if (toolResult.contextUpdate) {
                                try {
                                    await this.deps.updateContext(toolResult.contextUpdate as Partial<TContext>);
                                } catch (error) {
                                    logger.error(`[ToolLoopExecutor] Failed to update context from follow-up tool ${toolCall.toolName}:`, error);
                                }
                            }

                            if (toolResult.dataUpdate) {
                                try {
                                    session = await this.deps.updateSessionData(session, toolResult.dataUpdate as Partial<TData>);
                                    logger.debug(`[ToolLoopExecutor] Follow-up tool updated collected data:`, toolResult.dataUpdate);
                                } catch (error) {
                                    logger.error(`[ToolLoopExecutor] Failed to update data from follow-up tool ${toolCall.toolName}:`, error);
                                }
                            }

                            // Store the follow-up tool result for potential next loop iteration
                            record.result = serializeToolResult(toolResult);

                            // Collect tool-emitted directives (ctx.dispatch / {directive})
                            if (toolResult.directives?.length) {
                                collectedDirectives.push(...toolResult.directives as Directive<TContext, TData>[]);
                            }

                            logger.debug(`[ToolLoopExecutor] Executed follow-up tool: ${toolCall.toolName} (success: ${toolResult.success})`);
                        } catch (error) {
                            logger.error(`[ToolLoopExecutor] Follow-up tool execution error for ${toolCall.toolName}:`, error);
                            // Visible failure beats a fabricated success.
                            record.result = executionFailure(toolCall.toolName, error);
                            continue;
                        }
                    }

                    // A tool emitted a verbatim reply this round: it IS the final
                    // message — stop looping and skip any further LLM call.
                    const roundDirectives = flow.mergeAll(collectedDirectives);
                    if (roundDirectives?.reply) {
                        logger.debug("[ToolLoopExecutor] Tool directive reply short-circuits remaining tool loop");
                        finalMessage = roundDirectives.reply;
                        followUpStructured = { message: roundDirectives.reply };
                        hasToolCalls = false;
                        toolCalls = undefined;
                        break;
                    }

                    // Update toolCalls for next iteration or final response
                    toolCalls = followUpToolCalls;
                } else {
                    logger.debug(`[ToolLoopExecutor] Tool loop completed after ${toolLoopCount} iterations`);
                    // Update final message and toolCalls from follow-up result if no more tools
                    finalMessage = followUpResult.structured?.message || followUpResult.message;
                    followUpStructured = followUpResult.structured;
                    toolCalls = followUpToolCalls || [];
                    break;
                }
            }

            if (toolLoopCount >= MAX_TOOL_LOOPS) {
                logger.warn(`[ResponseGenerationError] Tool loop limit reached: ${toolLoopCount} iterations hit the cap (${MAX_TOOL_LOOPS}). Stopping tool execution. Increase the agent's maxToolLoops option or reduce recursive tool calls.`);
            }

            // If tools were executed but no final text message was produced,
            // make one more LLM call to generate a proper text response from tool
            // results. This prevents the original tool-invocation message (e.g.
            // "Let me check...") from being returned as the final user-facing
            // response. Shared with the streaming path via forceFinalTextFromTools.
            if (!finalMessage && toolLoopCount > 0) {
                logger.debug(`[ToolLoopExecutor] No final message after tool loop, making additional LLM call for text response`);
                const forced = await this.forceFinalTextFromTools({
                    history,
                    records,
                    responsePrompt,
                    responseSchema,
                    context,
                    signal,
                });
                if (forced.finalMessage) {
                    finalMessage = forced.finalMessage;
                }
                if (forced.structured) {
                    followUpStructured = forced.structured;
                }
            }

            logger.debug(`[ToolLoopExecutor] Tool loop completed:`, {
                totalIterations: toolLoopCount,
                hasFinalMessage: !!finalMessage,
                finalMessageLength: finalMessage?.length || 0,
                finalToolCallsCount: toolCalls?.length || 0,
            });

            return {
                session,
                finalToolCalls: toolCalls,
                finalMessage,
                structured: followUpStructured,
                directives: flow.mergeAll(collectedDirectives),
            };
        } catch (error) {
            throw ResponseGenerationError.fromError(error, 'tool_execution', params, {
                toolCallsCount: params.toolCalls?.length || 0,
                availableToolsCount: params.availableTools.length
            });
        }
    }

    /**
     * After tools have executed but the model produced no closing text, make one
     * more LLM call (no tools) that turns the tool results into a user-facing
     * message. Shared by the non-streaming tool loop and the streaming batch so
     * both paths behave identically. Returns an empty object if the call fails
     * or yields nothing, leaving the caller to fall back to its prior message.
     */
    private async forceFinalTextFromTools(params: {
        history: HistoryItem[];
        records: ToolExecutionRecord[];
        responsePrompt: string;
        responseSchema?: Record<string, unknown>;
        context: TContext;
        signal?: AbortSignal;
    }): Promise<{ finalMessage?: string; structured?: AgentStructuredResponse }> {
        const { history, records, responsePrompt, responseSchema, context, signal } = params;

        // Reconstruct assistant tool_call + tool result pairs so the follow-up
        // call can see what the tools returned — every executed call, keyed by
        // its own request id.
        const finalToolResultHistoryItems: HistoryItem[] = [];
        for (const record of records) {
            if (!record.result) continue;
            finalToolResultHistoryItems.push(
                assistantMessage(null, [
                    { id: record.requestId, name: record.toolName, arguments: record.arguments },
                ]),
                toolMessage(record.toolName, record.requestId, record.result),
            );
        }

        const finalHistory = [...history, ...finalToolResultHistoryItems];
        const agentOptions = this.deps.getAgentOptions();

        try {
            const textResult = await agentOptions.provider.generateMessage({
                prompt: responsePrompt + "\n\nProvide a text response to the user based on the tool results. Do not call any tools.",
                history: finalHistory,
                context,
                tools: [], // No tools - force text response
                parameters: responseSchema ? {
                    jsonSchema: responseSchema,
                    schemaName: "tool_final_text",
                } : undefined,
                signal,
            });

            const finalMessage = textResult.structured?.message || textResult.message;
            logger.debug(`[ToolLoopExecutor] Generated final text response from tool results:`, {
                hasMessage: !!finalMessage,
                messageLength: finalMessage?.length || 0,
            });
            return { finalMessage, structured: textResult.structured };
        } catch (error) {
            logger.error(`[ToolLoopExecutor] Failed to generate final text response from tool results:`, error);
            // Leave the caller to fall back to its prior message.
            return {};
        }
    }

    /**
     * Execute the streaming path's initial batch of tool calls concurrently
     * via ToolManager.executeWithConcurrency, yielding tool-progress chunks.
     * When tools ran but the model produced no closing text, forces a final
     * text response from the tool results (mirroring `runLoop()`). Falls back
     * to `runLoop()` when concurrent execution fails.
     *
     * Returns the updated session, final tool calls, and any forced closing
     * message/structured response.
     */
    async *runStreamingBatch(params: {
        toolCalls: Array<{ toolName: string; arguments: Record<string, unknown> }>;
        context: TContext;
        session: SessionState<TData>;
        history: HistoryItem[];
        selectedFlow: Flow<TContext, TData>;
        step: Step<TContext, TData>;
        /** Accumulated text of the LLM's final chunk, echoed on progress chunks. */
        accumulated: string;
        responsePrompt: string;
        availableTools: Array<{
            id: string;
            name: string;
            description?: string;
            parameters?: unknown;
        }>;
        responseSchema?: Record<string, unknown>;
        signal?: AbortSignal;
    }): AsyncGenerator<
        AgentResponseStreamChunk<TData>,
        {
            session: SessionState<TData>;
            toolCalls: Array<{ toolName: string; arguments: Record<string, unknown> }> | undefined;
            /** Closing message forced from the tool results, if one was generated. */
            finalMessage?: string;
            structured?: AgentStructuredResponse;
            /** Directives emitted by tools this turn (ctx.dispatch / `{directive}` returns), merged. */
            directives?: Directive<TContext, TData>;
        }
    > {
        const { context, history, selectedFlow, step, accumulated, responsePrompt, availableTools, responseSchema, signal } = params;
        let { session } = params;
        let toolCalls: Array<{ toolName: string; arguments: Record<string, unknown> }> | undefined = params.toolCalls;

        // Directives emitted by tools this turn — surfaced to the caller
        const collectedDirectives: Directive<TContext, TData>[] = [];

        // Use concurrent execution for the initial batch of tool calls
        const toolCallRequests: ToolCallRequest[] = params.toolCalls.map((tc, i) => ({
            id: `${tc.toolName}-${i}-${Date.now()}`,
            toolName: tc.toolName,
            arguments: tc.arguments,
        }));
        // Map request id -> request so completed results can be attributed back
        // to their tool name/arguments for the forced final-text call.
        // Execution records keyed by call id — seeded at queue time so results
        // (and failures) attach to the right call even for same-name calls.
        const records: ToolExecutionRecord[] = toolCallRequests.map((req) => ({
            requestId: req.id,
            toolName: req.toolName,
            arguments: req.arguments,
            round: 0,
        }));
        const recordById = new Map(records.map((r) => [r.requestId, r]));

        const historyEvents = historyToEvents(history);

        let finalMessage: string | undefined;
        let structured: AgentStructuredResponse | undefined;

        try {
            for await (const update of this.deps.toolManager.executeWithConcurrency({
                toolCalls: toolCallRequests,
                context,
                data: session.data,
                history: historyEvents,
                signal,
                flow: selectedFlow,
                step,
            })) {
                // Apply context updates
                if (update.contextUpdate) {
                    try {
                        await this.deps.updateContext(update.contextUpdate as Partial<TContext>);
                    } catch (error) {
                        logger.error(`[ToolLoopExecutor] Failed to update context from concurrent tool:`, error);
                    }
                }

                // Apply data updates
                if (update.dataUpdate) {
                    try {
                        session = await this.deps.updateSessionData(session, update.dataUpdate);
                    } catch (error) {
                        logger.error(`[ToolLoopExecutor] Failed to update data from concurrent tool:`, error);
                    }
                }

                // Capture tool results for the forced final-text call
                if (update.result) {
                    const record = recordById.get(update.toolCallId);
                    if (record) {
                        record.result = serializeToolResult(update.result);
                    }
                    // Collect tool-emitted directives (ctx.dispatch / {directive})
                    if (update.result.directives?.length) {
                        collectedDirectives.push(...update.result.directives as Directive<TContext, TData>[]);
                    }
                }

                // Yield progress updates immediately
                if (update.progress) {
                    yield {
                        delta: '',
                        accumulated,
                        done: false,
                        session,
                        toolCalls: undefined,
                        isFlowComplete: false,
                        metadata: { toolProgress: update.progress, toolCallId: update.toolCallId },
                    };
                }
            }

            logger.debug(`[ToolLoopExecutor] Concurrent tool execution completed for ${toolCallRequests.length} tools`);

            // Multi-round follow-up shared with the non-streaming path: re-prompt
            // with the tool results so the model can chain further tool calls,
            // then produce result-aware closing text (forced if it never does).
            // Previously a single forced-text call — streaming now loops to parity
            // with runLoop, so a streamed turn can chain tools across rounds.
            const followUp = await this.runFollowUpLoop({
                toolCalls,
                session,
                records,
                collectedDirectives,
                context,
                history,
                selectedFlow,
                responsePrompt,
                availableTools,
                responseSchema,
                signal,
            });
            session = followUp.session;
            toolCalls = followUp.finalToolCalls;
            finalMessage = followUp.finalMessage;
            structured = followUp.structured;
        } catch (error) {
            logger.error(`[ToolLoopExecutor] Concurrent batch failed:`, error);
            const executedRecords = records.filter((r) => r.result !== undefined);
            if (executedRecords.length > 0) {
                // Some tools already executed — re-running them would duplicate
                // real-world side effects (sends, writes, charges). Close the
                // turn from the results we have instead.
                logger.warn(
                    `[ToolLoopExecutor] ${executedRecords.length} tool(s) already executed; closing the turn from their results rather than re-executing.`
                );
                const forced = await this.forceFinalTextFromTools({
                    history,
                    records,
                    responsePrompt,
                    responseSchema,
                    context,
                    signal,
                });
                if (forced.finalMessage) {
                    finalMessage = forced.finalMessage;
                }
                structured = structured ?? forced.structured;
            } else {
                // Nothing executed — safe to fall back to the unified loop.
                const toolResult = await this.runLoop({
                    toolCalls, context, session, history, selectedFlow,
                    responsePrompt, availableTools, responseSchema, signal,
                });
                session = toolResult.session;
                toolCalls = toolResult.finalToolCalls;
                finalMessage = toolResult.finalMessage;
                structured = toolResult.structured;
                if (toolResult.directives) {
                    collectedDirectives.length = 0;
                    collectedDirectives.push(toolResult.directives);
                }
            }
        }

        return { session, toolCalls, finalMessage, structured, directives: flow.mergeAll(collectedDirectives) };
    }

    /**
     * Find an available tool by name for the given flow.
     * Delegates to ToolManager for unified tool resolution.
     */
    private findAvailableTool(
        toolName: string,
        flow?: Flow<TContext, TData>
    ) {
        return this.deps.toolManager.find(toolName, undefined, undefined, flow);
    }
}
