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
    HistoryItem,
    SessionState,
    ToolCallRequest,
} from "../types";
import type { Flow } from "./Flow";
import type { Step } from "./Step";
import type { ToolManager } from "./ToolManager";
import { ResponseGenerationError } from "./ResponseGenerationError";
import { historyToEvents, logger, serializeToolResult } from "../utils";

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
    }> {
        try {
            const { context, history, selectedFlow, responsePrompt, availableTools, responseSchema, signal } = params;
            let { toolCalls, session } = params;

            // Convert HistoryItem[] to Event[] for internal processing
            const historyEvents = historyToEvents(history);

            // Map to store tool execution results for history
            const toolResultsMap = new Map<string, string>();
            // Map to store tool call arguments for history reconstruction
            const toolArgsMap = new Map<string, Record<string, unknown>>();

            // Execute initial dynamic tool calls
            if (toolCalls && toolCalls.length > 0) {
                logger.debug(`[ToolLoopExecutor] Executing ${toolCalls.length} dynamic tool calls:`, toolCalls.map(tc => tc.toolName));

                for (const toolCall of toolCalls) {
                    const tool = this.findAvailableTool(toolCall.toolName, selectedFlow);
                    if (!tool) {
                        logger.warn(`[ToolExecutionError] Tool not found: "${toolCall.toolName}" is not registered in any scope. Skipping this tool call. Register the tool or check the tool name.`);
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
                        toolResultsMap.set(toolCall.toolName, serializeToolResult(toolResult));
                        toolArgsMap.set(toolCall.toolName, toolCall.arguments);

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
                        // Continue with other tools rather than failing the entire response
                        continue;
                    }
                }
            }

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

                // Create tool result history items
                const toolResultHistoryItems: HistoryItem[] = [];
                for (const toolCall of toolCalls || []) {
                    const tool = this.findAvailableTool(toolCall.toolName, selectedFlow);
                    if (tool) {
                        // Create HistoryItem format for tool results
                        // Add assistant message with tool_calls
                        toolResultHistoryItems.push({
                            role: "assistant" as const,
                            content: null,
                            tool_calls: [{
                                id: toolCall.toolName,
                                name: toolCall.toolName,
                                arguments: toolCall.arguments,
                            }],
                        });
                        // Add tool result
                        toolResultHistoryItems.push({
                            role: "tool" as const,
                            tool_call_id: toolCall.toolName,
                            name: toolCall.toolName,
                            content: toolResultsMap.get(toolCall.toolName) || "Tool executed successfully",
                        });
                    }
                }

                // Create updated history with tool results
                const updatedHistory = [...history, ...toolResultHistoryItems];

                // Make follow-up AI call to see if more tools are needed
                // After first iteration, don't provide tools to force a text response
                const agentOptions = this.deps.getAgentOptions();
                const shouldProvideTools = toolLoopCount === 1;

                logger.debug(`[ToolLoopExecutor] Making follow-up AI call (loop ${toolLoopCount}):`, {
                    providingTools: shouldProvideTools,
                    toolsCount: shouldProvideTools ? availableTools.length : 0,
                    addingTextInstruction: toolLoopCount > 1,
                });

                const followUpResult = await agentOptions.provider.generateMessage({
                    prompt: responsePrompt + (toolLoopCount > 1 ? "\n\nProvide a text response to the user based on the tool results." : ""),
                    history: updatedHistory, // Use HistoryItem[] for AI provider
                    context,
                    tools: shouldProvideTools ? availableTools : [], // Only provide tools on first iteration
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
                    for (const toolCall of followUpToolCalls!) {
                        const tool = this.findAvailableTool(toolCall.toolName, selectedFlow);
                        if (!tool) {
                            logger.warn(`[ToolExecutionError] Tool not found in follow-up: "${toolCall.toolName}" is not registered in any scope. Skipping this tool call. Register the tool or check the tool name.`);
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
                            toolResultsMap.set(toolCall.toolName, serializeToolResult(toolResult));
                            toolArgsMap.set(toolCall.toolName, toolCall.arguments);

                            logger.debug(`[ToolLoopExecutor] Executed follow-up tool: ${toolCall.toolName} (success: ${toolResult.success})`);
                        } catch (error) {
                            logger.error(`[ToolLoopExecutor] Follow-up tool execution error for ${toolCall.toolName}:`, error);
                            continue;
                        }
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
                logger.warn(`[ResponseGenerationError] Tool loop limit reached: ${toolLoopCount} iterations hit the cap (${MAX_TOOL_LOOPS}). Stopping tool execution. Increase MAX_TOOL_LOOPS or reduce recursive tool calls.`);
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
                    toolResultsMap,
                    toolArgsMap,
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
        toolResultsMap: Map<string, string>;
        toolArgsMap: Map<string, Record<string, unknown>>;
        responsePrompt: string;
        responseSchema?: Record<string, unknown>;
        context: TContext;
        signal?: AbortSignal;
    }): Promise<{ finalMessage?: string; structured?: AgentStructuredResponse }> {
        const { history, toolResultsMap, toolArgsMap, responsePrompt, responseSchema, context, signal } = params;

        // Reconstruct assistant tool_call + tool result pairs so the follow-up
        // call can see what the tools returned.
        const finalToolResultHistoryItems: HistoryItem[] = [];
        for (const [toolName, toolResult] of toolResultsMap) {
            finalToolResultHistoryItems.push({
                role: "assistant" as const,
                content: null,
                tool_calls: [{
                    id: toolName,
                    name: toolName,
                    arguments: toolArgsMap.get(toolName) || {},
                }],
            });
            finalToolResultHistoryItems.push({
                role: "tool" as const,
                tool_call_id: toolName,
                name: toolName,
                content: toolResult,
            });
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
        }
    > {
        const { context, history, selectedFlow, step, accumulated, responsePrompt, availableTools, responseSchema, signal } = params;
        let { session } = params;
        let toolCalls: Array<{ toolName: string; arguments: Record<string, unknown> }> | undefined = params.toolCalls;

        // Use concurrent execution for the initial batch of tool calls
        const toolCallRequests: ToolCallRequest[] = params.toolCalls.map((tc, i) => ({
            id: `${tc.toolName}-${i}-${Date.now()}`,
            toolName: tc.toolName,
            arguments: tc.arguments,
        }));
        // Map request id -> request so completed results can be attributed back
        // to their tool name/arguments for the forced final-text call.
        const requestById = new Map(toolCallRequests.map((r) => [r.id, r]));
        const toolResultsMap = new Map<string, string>();
        const toolArgsMap = new Map<string, Record<string, unknown>>();

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
                    const req = requestById.get(update.toolCallId);
                    if (req) {
                        toolResultsMap.set(req.toolName, serializeToolResult(update.result));
                        toolArgsMap.set(req.toolName, req.arguments);
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

            // Tools ran but streaming produced no post-tool message — force one
            // from the results, mirroring runLoop. (The streaming chunk only ever
            // carries the pre-tool preamble, never a result-aware response.)
            if (toolResultsMap.size > 0) {
                const forced = await this.forceFinalTextFromTools({
                    history,
                    toolResultsMap,
                    toolArgsMap,
                    responsePrompt,
                    responseSchema,
                    context,
                    signal,
                });
                finalMessage = forced.finalMessage;
                structured = forced.structured;
            }
        } catch (error) {
            logger.error(`[ToolLoopExecutor] Concurrent tool execution failed, falling back to sequential:`, error);
            // Fall back to the unified tool loop on failure
            const toolResult = await this.runLoop({
                toolCalls, context, session, history, selectedFlow,
                responsePrompt, availableTools, responseSchema, signal,
            });
            session = toolResult.session;
            toolCalls = toolResult.finalToolCalls;
            finalMessage = toolResult.finalMessage;
            structured = toolResult.structured;
        }

        return { session, toolCalls, finalMessage, structured };
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
