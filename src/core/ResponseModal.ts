/**
 * ResponseModal handles all response generation logic for the Agent
 * Provides both streaming and non-streaming response generation with unified logic
 */

import type {
    AgentResponse,
    AgentResponseStreamChunk,
    History,
    SessionState,
    StepRef,
} from "../types";
import type { Agent } from "./Agent";
import { ResponseEngine } from "./ResponseEngine";
import { ResponsePipeline } from "./ResponsePipeline";
import { normalizeHistory, cloneDeep, mergeCollected, enterStep, getLastMessageFromHistory, render, logger } from "../utils";
import { ToolExecutor } from "./ToolExecutor";
import { Step } from "./Step";
import { END_ROUTE_ID } from "../constants";

/**
 * Configuration options for ResponseModal
 */
export interface ResponseModalOptions {
    /** Maximum number of tool loops allowed during response generation */
    maxToolLoops?: number;
    /** Enable automatic session saving after response generation */
    enableAutoSave?: boolean;
    /** Enable debug mode for detailed logging */
    debugMode?: boolean;
}

/**
 * Parameters for respond and respondStream methods
 */
export interface RespondParams<TContext = unknown, TData = unknown> {
    history: History;
    step?: StepRef;
    session?: SessionState<TData>;
    contextOverride?: Partial<TContext>;
    signal?: AbortSignal;
}

/**
 * Options for the modern stream() method
 */
export interface StreamOptions<TContext = unknown> {
    contextOverride?: Partial<TContext>;
    signal?: AbortSignal;
    history?: History; // Optional: override session history
}

/**
 * Options for the modern generate() method
 */
export interface GenerateOptions<TContext = unknown> {
    contextOverride?: Partial<TContext>;
    signal?: AbortSignal;
    history?: History; // Optional: override session history
}

/**
 * Error class for response generation failures
 */
export class ResponseGenerationError extends Error {
    constructor(
        message: string,
        public readonly details?: {
            originalError?: unknown;
            params?: any;
            phase?: string;
            context?: any;
        }
    ) {
        super(message);
        this.name = 'ResponseGenerationError';

        // Preserve stack trace from original error if available
        if (details?.originalError instanceof Error && details.originalError.stack) {
            this.stack = `${this.stack}\nCaused by: ${details.originalError.stack}`;
        }
    }

    /**
     * Create a ResponseGenerationError from an unknown error
     */
    static fromError(error: unknown, phase: string, params?: any, context?: any): ResponseGenerationError {
        const message = error instanceof Error ? error.message : String(error);
        return new ResponseGenerationError(
            `Response generation failed in ${phase}: ${message}`,
            { originalError: error, params, phase, context }
        );
    }

    /**
     * Check if an error is a ResponseGenerationError
     */
    static isResponseGenerationError(error: unknown): error is ResponseGenerationError {
        return error instanceof ResponseGenerationError;
    }
}

/**
 * Common response context used across all response methods
 */
interface ResponseContext<TContext = unknown, TData = unknown> {
    effectiveContext: TContext;
    session: SessionState<TData>;
    history: any[];
    selectedRoute?: any;
    selectedStep?: any;
    responseDirectives?: string[];
    isRouteComplete: boolean;
}

/**
 * ResponseModal class that encapsulates all response generation logic
 * Uses unified approach for both streaming and non-streaming responses
 */
export class ResponseModal<TContext = unknown, TData = unknown> {
    private readonly responseEngine: ResponseEngine<TContext, TData>;
    private readonly responsePipeline: ResponsePipeline<TContext, TData>;

    constructor(
        private readonly agent: Agent<TContext, TData>,
        private readonly options?: ResponseModalOptions
    ) {
        // Initialize response engine
        this.responseEngine = new ResponseEngine<TContext, TData>();

        // Initialize response pipeline with agent dependencies
        this.responsePipeline = new ResponsePipeline<TContext, TData>(
            this.agent.getAgentOptions(),
            this.agent.getRoutes(),
            this.agent.getTools(),
            this.agent.getRoutingEngine(),
            this.agent.updateContext.bind(this.agent),
            this.agent.getUpdateDataMethod(),
            this.agent.updateCollectedData.bind(this.agent)
        );
    }

    /**
     * Generate a non-streaming response using unified logic
     */
    async respond(params: RespondParams<TContext, TData>): Promise<AgentResponse<TData>> {
        try {
            // Use unified response preparation and routing
            const responseContext = await this.prepareUnifiedResponseContext(params);

            // Generate response using unified logic
            const result = await this.generateUnifiedResponse(responseContext);

            // Finalize session
            await this.finalizeSession(result.session!, responseContext.effectiveContext);

            return result;

        } catch (error) {
            throw new ResponseGenerationError(
                `Failed to generate response: ${error instanceof Error ? error.message : String(error)}`,
                { originalError: error, params, phase: 'response_generation' }
            );
        }
    }

    /**
     * Generate a streaming response using unified logic
     */
    async *respondStream(params: RespondParams<TContext, TData>): AsyncGenerator<AgentResponseStreamChunk<TData>> {
        try {
            // Use unified response preparation and routing
            const responseContext = await this.prepareUnifiedResponseContext(params);

            // Generate streaming response using unified logic
            yield* this.generateUnifiedStreamingResponse(responseContext);

        } catch (error) {
            // Stream error to caller
            yield {
                delta: "",
                accumulated: "",
                done: true,
                session: params.session || await this.agent.session.getOrCreate(),
                error: new ResponseGenerationError(
                    `Streaming response failed: ${error instanceof Error ? error.message : String(error)}`,
                    { originalError: error, params, phase: 'streaming' }
                ),
            } as AgentResponseStreamChunk<TData>;
        }
    }

    /**
     * Modern streaming API - simple interface like chat()
     */
    async *stream(
        message?: string,
        options?: StreamOptions<TContext>
    ): AsyncGenerator<AgentResponseStreamChunk<TData>> {
        // Determine which history to use
        let history: History;
        if (options?.history) {
            // Use provided history for this response only
            history = options.history;
        } else {
            // Add user message to session history if provided
            if (message) {
                await this.agent.session.addMessage("user", message);
            }
            history = this.agent.session.getHistory();
        }

        // Get or create session
        let session = await this.agent.session.getOrCreate();

        // Merge agent's collected data into session (agent data takes precedence)
        const collectedData = this.agent.getCollectedData();
        if (Object.keys(collectedData).length > 0) {
            session = mergeCollected(session, collectedData);
            // Update the session manager with the merged data
            await this.agent.session.setData(collectedData);
            logger.debug("[ResponseModal] Merged agent collected data into stream session:", collectedData);
        }

        // Stream response using existing respondStream method
        let finalMessage = "";
        for await (const chunk of this.respondStream({
            history,
            session,
            contextOverride: options?.contextOverride,
            signal: options?.signal,
        })) {
            // Accumulate the final message for session history
            if (chunk.done) {
                finalMessage = chunk.accumulated;
            }

            yield chunk;
        }

        // Add agent response to session history (only if not using override history)
        if (!options?.history && finalMessage) {
            await this.agent.session.addMessage("assistant", finalMessage);
        }
    }

    /**
     * Modern non-streaming API - equivalent to chat() but more explicit
     */
    async generate(
        message?: string,
        options?: GenerateOptions<TContext>
    ): Promise<AgentResponse<TData>> {
        // Determine which history to use
        let history: History;
        if (options?.history) {
            // Use provided history for this response only
            history = options.history;
        } else {
            // Add user message to session history if provided
            if (message) {
                await this.agent.session.addMessage("user", message);
            }
            history = this.agent.session.getHistory();
        }

        // Get or create session
        let session = await this.agent.session.getOrCreate();

        // Merge agent's collected data into session (agent data takes precedence)
        const collectedData = this.agent.getCollectedData();
        if (Object.keys(collectedData).length > 0) {
            session = mergeCollected(session, collectedData);
            // Update the session manager with the merged data
            await this.agent.session.setData(collectedData);
            logger.debug("[ResponseModal] Merged agent collected data into generate session:", collectedData);
        }

        // Generate response using existing respond method
        const result = await this.respond({
            history,
            session,
            contextOverride: options?.contextOverride,
            signal: options?.signal,
        });

        // Add agent response to session history (only if not using override history)
        if (!options?.history) {
            await this.agent.session.addMessage("assistant", result.message);
        }

        // Ensure the result includes the current session
        return {
            ...result,
            session: result.session || this.agent.session.current,
        };
    }

    /**
     * Get the response engine instance
     * @internal
     */
    getResponseEngine(): ResponseEngine<TContext, TData> {
        return this.responseEngine;
    }

    /**
     * Get the response pipeline instance
     * @internal
     */
    getResponsePipeline(): ResponsePipeline<TContext, TData> {
        return this.responsePipeline;
    }

    // UNIFIED RESPONSE LOGIC - Consolidates common logic between streaming and non-streaming
    // ============================================================================

    /**
     * Unified response preparation - handles context setup, session management, and routing
     * This consolidates common logic between streaming and non-streaming responses
     * @private
     */
    private async prepareUnifiedResponseContext(params: RespondParams<TContext, TData>): Promise<ResponseContext<TContext, TData>> {
        try {
            const { history: simpleHistory, contextOverride, signal } = params;

            // Validate input parameters
            if (!simpleHistory) {
                throw new ResponseGenerationError('History is required for response generation', { params, phase: 'validation' });
            }

            const history = normalizeHistory(simpleHistory);

            // Use ResponsePipeline for optimized context and session preparation
            // This leverages existing optimizations and avoids code duplication
            let responseContext: any;
            try {
                // Set current context and session in pipeline for consistency
                this.responsePipeline.setContext(await this.agent.getContext());
                this.responsePipeline.setCurrentSession(this.agent.getCurrentSession());

                responseContext = await this.responsePipeline.prepareResponseContext({
                    contextOverride,
                    session: params.session ? cloneDeep(params.session) : undefined,
                });
            } catch (error) {
                throw ResponseGenerationError.fromError(error, 'pipeline_context_preparation', params);
            }

            const { effectiveContext } = responseContext;
            let session = responseContext.session;

            // Update our stored context if it was modified by beforeRespond hook
            const storedContext = this.responsePipeline.getStoredContext();
            if (storedContext !== undefined) {
                try {
                    await this.agent.updateContext(storedContext as Partial<TContext>);
                } catch (error) {
                    throw ResponseGenerationError.fromError(error, 'context_update_from_pipeline', params, { storedContext });
                }
            }

            // Merge agent's collected data into session (agent data takes precedence)
            const collectedData = this.agent.getCollectedData();
            if (Object.keys(collectedData).length > 0) {
                try {
                    session = mergeCollected(session, collectedData);
                    logger.debug("[ResponseModal] Merged agent collected data into session:", collectedData);
                } catch (error) {
                    throw ResponseGenerationError.fromError(error, 'data_merging', params, { collectedData });
                }
            }

            // PHASE 1: PREPARE - Execute prepare function if current step has one
            try {
                await this.executeStepPrepare(session, effectiveContext);
            } catch (error) {
                throw ResponseGenerationError.fromError(error, 'step_preparation', params, { session, effectiveContext });
            }

            // PHASE 2: ROUTING + STEP SELECTION - Determine which route and step to use
            let routingResult: any;
            try {
                routingResult = await this.handleUnifiedRoutingAndStepSelection({
                    session,
                    history,
                    context: effectiveContext,
                    signal,
                });
            } catch (error) {
                throw ResponseGenerationError.fromError(error, 'routing_and_step_selection', params, { session, effectiveContext });
            }

            return {
                effectiveContext,
                session: routingResult.session,
                history,
                selectedRoute: routingResult.selectedRoute,
                selectedStep: routingResult.selectedStep,
                responseDirectives: routingResult.responseDirectives,
                isRouteComplete: routingResult.isRouteComplete,
            };
        } catch (error) {
            // Re-throw ResponseGenerationError as-is, wrap others
            if (ResponseGenerationError.isResponseGenerationError(error)) {
                throw error;
            }
            throw ResponseGenerationError.fromError(error, 'preparation', params);
        }
    }

    /**
     * Unified routing and step selection logic using ResponsePipeline for optimization
     * @private
     */
    private async handleUnifiedRoutingAndStepSelection(params: {
        session: SessionState<TData>;
        history: any[];
        context: TContext;
        signal?: AbortSignal;
    }): Promise<{
        selectedRoute?: any;
        selectedStep?: any;
        responseDirectives?: string[];
        session: SessionState<TData>;
        isRouteComplete: boolean;
    }> {
        try {
            // Use the ResponsePipeline for optimized routing and step selection
            // This avoids duplicate logic and leverages existing optimizations
            const routingResult = await this.responsePipeline.handleRoutingAndStepSelection({
                session: params.session,
                history: params.history,
                context: params.context,
                signal: params.signal,
            });

            // Determine next step using pipeline method for consistency
            const stepResult = this.responsePipeline.determineNextStep({
                selectedRoute: routingResult.selectedRoute,
                selectedStep: routingResult.selectedStep,
                session: routingResult.session,
                isRouteComplete: routingResult.isRouteComplete,
            });

            return {
                selectedRoute: routingResult.selectedRoute,
                selectedStep: stepResult.nextStep, // Use the determined next step
                responseDirectives: routingResult.responseDirectives,
                session: stepResult.session,
                isRouteComplete: routingResult.isRouteComplete,
            };
        } catch (error) {
            throw ResponseGenerationError.fromError(error, 'routing_optimization', params);
        }
    }

    /**
     * Unified response generation for non-streaming responses
     * @private
     */
    private async generateUnifiedResponse(
        responseContext: ResponseContext<TContext, TData>
    ): Promise<AgentResponse<TData>> {
        const { effectiveContext, session: initialSession, history, selectedRoute, selectedStep, responseDirectives, isRouteComplete } = responseContext;
        let session = initialSession;

        // Get last user message (needed for both route and completion handling)
        const lastUserMessage = getLastMessageFromHistory(history);

        let message: string;
        let toolCalls: Array<{ toolName: string; arguments: Record<string, unknown> }> | undefined = undefined;

        if (selectedRoute && !isRouteComplete) {
            // Handle normal route processing
            const result = await this.processRouteResponse({
                selectedRoute,
                selectedStep,
                responseDirectives,
                session,
                history,
                context: effectiveContext,
                lastUserMessage,
                signal: responseContext.history ? undefined : undefined, // TODO: Fix signal passing
            });

            message = result.message;
            toolCalls = result.toolCalls;
            session = result.session;

        } else if (isRouteComplete && selectedRoute) {
            // Handle route completion
            message = await this.handleRouteCompletion({
                selectedRoute,
                session,
                history,
                context: effectiveContext,
                lastUserMessage,
            });

            // Set step to END_ROUTE marker
            session = enterStep(session, END_ROUTE_ID, "Route completed");
            logger.debug(`[ResponseModal] Route ${selectedRoute.title} completed. Entered END_ROUTE step.`);

        } else {
            // Fallback: No routes defined, generate a simple response
            message = await this.generateFallbackResponse({
                history,
                context: effectiveContext,
                session,
            });
        }

        return {
            message,
            session,
            toolCalls,
            isRouteComplete,
        };
    }

    /**
     * Unified streaming response generation
     * @private
     */
    private async *generateUnifiedStreamingResponse(
        responseContext: ResponseContext<TContext, TData>
    ): AsyncGenerator<AgentResponseStreamChunk<TData>> {
        const { effectiveContext, session: initialSession, history, selectedRoute, selectedStep, responseDirectives, isRouteComplete } = responseContext;
        let session = initialSession;

        // Get last user message (needed for both route and completion handling)
        const lastUserMessage = getLastMessageFromHistory(history);

        if (selectedRoute && !isRouteComplete) {
            // Handle normal route processing with streaming
            yield* this.processRouteStreamingResponse({
                selectedRoute,
                selectedStep,
                responseDirectives,
                session,
                history,
                context: effectiveContext,
                lastUserMessage,
            });

        } else if (isRouteComplete && selectedRoute) {
            // Handle route completion streaming
            yield* this.streamRouteCompletion({
                selectedRoute,
                session,
                history,
                context: effectiveContext,
                lastUserMessage,
            });

        } else {
            // Fallback: No routes defined, stream a simple response
            yield* this.streamFallbackResponse({
                history,
                context: effectiveContext,
                session,
            });
        }
    }
    /**
       * Execute prepare function for current step if available
       * @private
       */
    private async executeStepPrepare(session: SessionState<TData>, context: TContext): Promise<void> {
        if (session.currentRoute && session.currentStep) {
            const currentRoute = this.agent.getRoutes().find(
                (r) => r.id === session.currentRoute?.id
            );
            if (currentRoute) {
                const currentStep = currentRoute.getStep(session.currentStep.id);
                if (currentStep?.prepare) {
                    logger.debug(`[ResponseModal] Executing prepare for step: ${currentStep.id}`);
                    await this.executePrepareFinalize(
                        currentStep.prepare,
                        context,
                        session.data,
                        currentRoute,
                        currentStep
                    );
                }
            }
        }
    }

    /**
     * Execute finalize function for current step if available
     * @private
     */
    private async executeStepFinalize(session: SessionState<TData>, context: TContext): Promise<void> {
        if (session.currentRoute && session.currentStep) {
            const currentRoute = this.agent.getRoutes().find(
                (r) => r.id === session.currentRoute?.id
            );
            if (currentRoute) {
                const currentStep = currentRoute.getStep(session.currentStep.id);
                if (currentStep?.finalize) {
                    logger.debug(
                        `[ResponseModal] Executing finalize for step: ${currentStep.id}`
                    );
                    await this.executePrepareFinalize(
                        currentStep.finalize,
                        context,
                        session.data,
                        currentRoute,
                        currentStep
                    );
                }
            }
        }
    }

    /**
     * Process route response with unified tool execution and data collection
     * @private
     */
    private async processRouteResponse(params: {
        selectedRoute: any;
        selectedStep?: any;
        responseDirectives?: string[];
        session: SessionState<TData>;
        history: any[];
        context: TContext;
        lastUserMessage: any;
        signal?: AbortSignal;
    }): Promise<{
        message: string;
        toolCalls?: Array<{ toolName: string; arguments: Record<string, unknown> }>;
        session: SessionState<TData>;
    }> {
        let { selectedRoute, selectedStep, responseDirectives, session, history, context, lastUserMessage, signal } = params;

        // Determine next step
        let nextStep: any;
        if (selectedStep) {
            nextStep = selectedStep;
        } else {
            // New route or no step selected - get initial step or first valid step
            const routingEngine = this.agent.getRoutingEngine();
            const candidates = routingEngine.getCandidateSteps(selectedRoute, undefined, session.data || {});
            if (candidates.length > 0) {
                nextStep = candidates[0].step;
                logger.debug(`[ResponseModal] Using first valid step: ${nextStep.id} for new route`);
            } else {
                // Fallback to initial step even if it should be skipped
                nextStep = selectedRoute.initialStep;
                logger.warn(`[ResponseModal] No valid steps found, using initial step: ${nextStep.id}`);
            }
        }

        // Update session with next step
        session = enterStep(session, nextStep.id, nextStep.description);
        logger.debug(`[ResponseModal] Entered step: ${nextStep.id}`);

        // Build response schema for this route (with collect fields from step)
        const responseSchema = this.responseEngine.responseSchemaForRoute(selectedRoute, nextStep, this.agent.getSchema());

        // Build response prompt
        const responsePrompt = await this.responseEngine.buildResponsePrompt({
            route: selectedRoute,
            currentStep: nextStep,
            rules: selectedRoute.getRules(),
            prohibitions: selectedRoute.getProhibitions(),
            directives: responseDirectives,
            history,
            lastMessage: lastUserMessage,
            agentOptions: this.agent.getAgentOptions(),
            combinedGuidelines: [...this.agent.getGuidelines(), ...selectedRoute.getGuidelines()],
            combinedTerms: this.mergeTerms(this.agent.getTerms(), selectedRoute.getTerms()),
            context,
            session,
            agentSchema: this.agent.getSchema(),
        });

        // Collect available tools for AI
        const availableTools = this.collectAvailableTools(selectedRoute, nextStep);

        // Generate message using AI provider
        const agentOptions = this.agent.getAgentOptions();
        const result = await agentOptions.provider.generateMessage({
            prompt: responsePrompt,
            history,
            context,
            tools: availableTools,
            signal,
            parameters: responseSchema ? { jsonSchema: responseSchema, schemaName: "response_output" } : undefined,
        });

        let message = result.structured?.message || result.message;
        let toolCalls = result.structured?.toolCalls;

        // Execute tools with unified loop handling
        const toolResult = await this.executeUnifiedToolLoop({
            toolCalls,
            context,
            session,
            history,
            selectedRoute,
            responsePrompt,
            availableTools,
            responseSchema,
            signal,
        });

        session = toolResult.session;
        toolCalls = toolResult.finalToolCalls;
        if (toolResult.finalMessage) {
            message = toolResult.finalMessage;
        }

        // Collect data from response
        session = await this.collectDataFromResponse({ result, selectedRoute, nextStep, session });

        return { message, toolCalls, session };
    }

    /**
     * Process route streaming response with unified tool execution and data collection
     * @private
     */
    private async *processRouteStreamingResponse(params: {
        selectedRoute: any;
        selectedStep?: any;
        responseDirectives?: string[];
        session: SessionState<TData>;
        history: any[];
        context: TContext;
        lastUserMessage: any;
        signal?: AbortSignal;
    }): AsyncGenerator<AgentResponseStreamChunk<TData>> {
        let { selectedRoute, selectedStep, responseDirectives, session, history, context, lastUserMessage, signal } = params;

        // Determine next step (same logic as non-streaming)
        let nextStep: any;
        if (selectedStep) {
            nextStep = selectedStep;
        } else {
            const routingEngine = this.agent.getRoutingEngine();
            const candidates = routingEngine.getCandidateSteps(selectedRoute, undefined, session.data || {});
            if (candidates.length > 0) {
                nextStep = candidates[0].step;
                logger.debug(`[ResponseModal] Using first valid step: ${nextStep.id} for new route`);
            } else {
                nextStep = selectedRoute.initialStep;
                logger.warn(`[ResponseModal] No valid steps found, using initial step: ${nextStep.id}`);
            }
        }

        // Update session with next step
        session = enterStep(session, nextStep.id, nextStep.description);
        logger.debug(`[ResponseModal] Entered step: ${nextStep.id}`);

        // Build response schema and prompt (same as non-streaming)
        const responseSchema = this.responseEngine.responseSchemaForRoute(selectedRoute, nextStep, this.agent.getSchema());
        const responsePrompt = await this.responseEngine.buildResponsePrompt({
            route: selectedRoute,
            currentStep: nextStep,
            rules: selectedRoute.getRules(),
            prohibitions: selectedRoute.getProhibitions(),
            directives: responseDirectives,
            history,
            lastMessage: lastUserMessage,
            agentOptions: this.agent.getAgentOptions(),
            combinedGuidelines: [...this.agent.getGuidelines(), ...selectedRoute.getGuidelines()],
            combinedTerms: this.mergeTerms(this.agent.getTerms(), selectedRoute.getTerms()),
            context,
            session,
            agentSchema: this.agent.getSchema(),
        });

        // Collect available tools for AI
        const availableTools = this.collectAvailableTools(selectedRoute, nextStep);

        // Generate message stream using AI provider
        const agentOptions = this.agent.getAgentOptions();
        const stream = agentOptions.provider.generateMessageStream({
            prompt: responsePrompt,
            history,
            context,
            tools: availableTools,
            signal,
            parameters: { jsonSchema: responseSchema, schemaName: "response_stream_output" },
        });

        // Stream chunks with unified tool handling
        for await (const chunk of stream) {
            let toolCalls: Array<{ toolName: string; arguments: Record<string, unknown> }> | undefined = undefined;

            // Extract tool calls from AI response on final chunk
            if (chunk.done && chunk.structured?.toolCalls) {
                toolCalls = chunk.structured.toolCalls;

                // Execute tools with unified loop handling
                const toolResult = await this.executeUnifiedToolLoop({
                    toolCalls,
                    context,
                    session,
                    history,
                    selectedRoute,
                    responsePrompt,
                    availableTools,
                    responseSchema,
                    signal,
                });

                session = toolResult.session;
                toolCalls = toolResult.finalToolCalls;
            }

            // Extract collected data on final chunk
            if (chunk.done && chunk.structured && nextStep.collect) {
                session = await this.collectDataFromResponse({
                    result: { structured: chunk.structured },
                    selectedRoute,
                    nextStep,
                    session,
                });
            }

            // Handle session finalization on final chunk
            if (chunk.done) {
                await this.finalizeSession(session, context);
            }

            yield {
                delta: chunk.delta,
                accumulated: chunk.accumulated,
                done: chunk.done,
                session,
                toolCalls,
                isRouteComplete: false,
                metadata: chunk.metadata,
                structured: chunk.structured,
            };
        }
    }

    /**
     * Unified tool execution logic with loop handling
     * Consolidates the complex tool execution logic from both streaming and non-streaming responses
     * @private
     */
    private async executeUnifiedToolLoop(params: {
        toolCalls?: Array<{ toolName: string; arguments: Record<string, unknown> }>;
        context: TContext;
        session: SessionState<TData>;
        history: any[];
        selectedRoute?: any;
        responsePrompt: string;
        availableTools: Array<{
            id: string;
            name: string;
            description?: string;
            parameters?: unknown;
        }>;
        responseSchema?: any;
        signal?: AbortSignal;
    }): Promise<{
        session: SessionState<TData>;
        finalToolCalls?: Array<{ toolName: string; arguments: Record<string, unknown> }>;
        finalMessage?: string;
    }> {
        try {
            let { toolCalls, context, session, history, selectedRoute, responsePrompt, availableTools, responseSchema, signal } = params;

            // Execute initial dynamic tool calls
            if (toolCalls && toolCalls.length > 0) {
                logger.debug(`[ResponseModal] Executing ${toolCalls.length} dynamic tool calls`);

                for (const toolCall of toolCalls) {
                    const tool = this.findAvailableTool(toolCall.toolName, selectedRoute);
                    if (!tool) {
                        logger.warn(`[ResponseModal] Tool not found: ${toolCall.toolName}`);
                        continue;
                    }

                    try {
                        const toolExecutor = new ToolExecutor<TContext, TData>();
                        const toolResult = await toolExecutor.executeTool({
                            tool: tool,
                            context,
                            updateContext: this.agent.updateContext.bind(this.agent),
                            updateData: this.agent.updateCollectedData.bind(this.agent),
                            history,
                            data: session.data,
                            toolArguments: toolCall.arguments,
                        });

                        // Check if tool execution was successful
                        if (!toolResult.success) {
                            logger.error(`[ResponseModal] Tool execution failed: ${toolCall.toolName} - ${toolResult.error}`);
                            // Continue with other tools rather than failing completely
                            continue;
                        }

                        // Update context with tool results
                        if (toolResult.contextUpdate) {
                            try {
                                await this.agent.updateContext(toolResult.contextUpdate as Partial<TContext>);
                            } catch (error) {
                                logger.error(`[ResponseModal] Failed to update context from tool ${toolCall.toolName}:`, error);
                                // Continue execution but log the error
                            }
                        }

                        // Update collected data with tool results
                        if (toolResult.dataUpdate) {
                            try {
                                const updateDataMethod = this.agent.getUpdateDataMethod();
                                session = await updateDataMethod(session, toolResult.dataUpdate as Partial<TData>);
                                logger.debug(`[ResponseModal] Tool updated collected data:`, toolResult.dataUpdate);
                            } catch (error) {
                                logger.error(`[ResponseModal] Failed to update data from tool ${toolCall.toolName}:`, error);
                                // Continue execution but log the error
                            }
                        }

                        logger.debug(`[ResponseModal] Executed dynamic tool: ${toolResult.toolName} (success: ${toolResult.success})`);
                    } catch (error) {
                        logger.error(`[ResponseModal] Tool execution error for ${toolCall.toolName}:`, error);
                        // Continue with other tools rather than failing the entire response
                        continue;
                    }
                }
            }

            // TOOL LOOP: Allow AI to make follow-up tool calls after initial tool execution
            const MAX_TOOL_LOOPS = this.options?.maxToolLoops || 5;
            let toolLoopCount = 0;
            let hasToolCalls = toolCalls && toolCalls.length > 0;
            let finalMessage: string | undefined;

            while (hasToolCalls && toolLoopCount < MAX_TOOL_LOOPS) {
                toolLoopCount++;
                logger.debug(`[ResponseModal] Starting tool loop ${toolLoopCount}/${MAX_TOOL_LOOPS}`);

                // Add tool execution results to history so AI knows what happened
                const toolResultsEvents: any[] = [];
                for (const toolCall of toolCalls || []) {
                    const tool = this.findAvailableTool(toolCall.toolName, selectedRoute);
                    if (tool) {
                        toolResultsEvents.push({
                            kind: "TOOL",
                            source: "AGENT",
                            timestamp: new Date().toISOString(),
                            data: {
                                tool_calls: [
                                    {
                                        tool_id: toolCall.toolName,
                                        arguments: toolCall.arguments,
                                        result: {
                                            data: "Tool executed successfully",
                                        },
                                    },
                                ],
                            },
                        });
                    }
                }

                // Create updated history with tool results
                const updatedHistory = [...history, ...toolResultsEvents];

                // Make follow-up AI call to see if more tools are needed
                const agentOptions = this.agent.getAgentOptions();
                const followUpResult = await agentOptions.provider.generateMessage({
                    prompt: responsePrompt,
                    history: updatedHistory,
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

                if (hasToolCalls) {
                    logger.debug(`[ResponseModal] Follow-up call produced ${followUpToolCalls!.length} additional tool calls`);

                    // Execute the follow-up tool calls
                    for (const toolCall of followUpToolCalls!) {
                        const tool = this.findAvailableTool(toolCall.toolName, selectedRoute);
                        if (!tool) {
                            logger.warn(`[ResponseModal] Tool not found in follow-up: ${toolCall.toolName}`);
                            continue;
                        }

                        try {
                            const toolExecutor = new ToolExecutor<TContext, TData>();
                            const toolResult = await toolExecutor.executeTool({
                                tool: tool,
                                context,
                                updateContext: this.agent.updateContext.bind(this.agent),
                                updateData: this.agent.updateCollectedData.bind(this.agent),
                                history: updatedHistory,
                                data: session.data,
                                toolArguments: toolCall.arguments,
                            });

                            // Check if tool execution was successful
                            if (!toolResult.success) {
                                logger.error(`[ResponseModal] Follow-up tool execution failed: ${toolCall.toolName} - ${toolResult.error}`);
                                continue;
                            }

                            // Update context with follow-up tool results
                            if (toolResult.contextUpdate) {
                                try {
                                    await this.agent.updateContext(toolResult.contextUpdate as Partial<TContext>);
                                } catch (error) {
                                    logger.error(`[ResponseModal] Failed to update context from follow-up tool ${toolCall.toolName}:`, error);
                                }
                            }

                            if (toolResult.dataUpdate) {
                                try {
                                    const updateDataMethod = this.agent.getUpdateDataMethod();
                                    session = await updateDataMethod(session, toolResult.dataUpdate as Partial<TData>);
                                    logger.debug(`[ResponseModal] Follow-up tool updated collected data:`, toolResult.dataUpdate);
                                } catch (error) {
                                    logger.error(`[ResponseModal] Failed to update data from follow-up tool ${toolCall.toolName}:`, error);
                                }
                            }

                            logger.debug(`[ResponseModal] Executed follow-up tool: ${toolResult.toolName} (success: ${toolResult.success})`);
                        } catch (error) {
                            logger.error(`[ResponseModal] Follow-up tool execution error for ${toolCall.toolName}:`, error);
                            continue;
                        }
                    }

                    // Update toolCalls for next iteration or final response
                    toolCalls = followUpToolCalls;
                } else {
                    logger.debug(`[ResponseModal] Tool loop completed after ${toolLoopCount} iterations`);
                    // Update final message and toolCalls from follow-up result if no more tools
                    finalMessage = followUpResult.structured?.message || followUpResult.message;
                    toolCalls = followUpToolCalls || [];
                    break;
                }
            }

            if (toolLoopCount >= MAX_TOOL_LOOPS) {
                logger.warn(`[ResponseModal] Tool loop limit reached (${MAX_TOOL_LOOPS}), stopping`);
            }

            return {
                session,
                finalToolCalls: toolCalls,
                finalMessage,
            };
        } catch (error) {
            throw ResponseGenerationError.fromError(error, 'tool_execution', params, {
                toolCallsCount: params.toolCalls?.length || 0,
                availableToolsCount: params.availableTools.length
            });
        }
    }  /*
*
   * Unified data collection from AI response
   * @private
   */
    private async collectDataFromResponse(params: {
        result: any;
        selectedRoute?: any;
        nextStep?: any;
        session: SessionState<TData>;
    }): Promise<SessionState<TData>> {
        try {
            const { result, selectedRoute, nextStep, session } = params;
            let updatedSession = session;

            // Extract collected data from final response (only for route-based interactions)
            if (selectedRoute && result.structured && nextStep?.collect) {
                try {
                    const collectedData: Record<string, unknown> = {};
                    // The structured response includes both base fields and collected extraction fields
                    const structuredData = result.structured as any & Record<string, unknown>;

                    for (const field of nextStep.collect) {
                        const fieldKey = String(field);
                        if (fieldKey in structuredData) {
                            collectedData[fieldKey] = structuredData[fieldKey];
                        }
                    }

                    // Merge collected data into session using agent-level data validation
                    if (Object.keys(collectedData).length > 0) {
                        try {
                            // Update agent-level collected data with validation
                            await this.agent.updateCollectedData(collectedData as Partial<TData>);

                            // Update session with validated data
                            const updateDataMethod = this.agent.getUpdateDataMethod();
                            updatedSession = await updateDataMethod(updatedSession, collectedData as Partial<TData>);
                            logger.debug(`[ResponseModal] Collected data:`, collectedData);
                        } catch (error) {
                            logger.error(`[ResponseModal] Failed to update collected data:`, error);
                            // Continue without updating data rather than failing completely
                        }
                    }
                } catch (error) {
                    logger.error(`[ResponseModal] Error during data collection:`, error);
                    // Continue without collecting data rather than failing completely
                }
            }

            // Extract any additional data from structured response
            if (result.structured && typeof result.structured === "object" && "contextUpdate" in result.structured) {
                try {
                    await this.agent.updateContext(
                        (result.structured as { contextUpdate?: Partial<TContext> }).contextUpdate as Partial<TContext>
                    );
                } catch (error) {
                    logger.error(`[ResponseModal] Failed to update context from structured response:`, error);
                    // Continue without updating context rather than failing completely
                }
            }

            return updatedSession;
        } catch (error) {
            logger.error(`[ResponseModal] Error in collectDataFromResponse:`, error);
            // Return original session if data collection fails completely
            return params.session;
        }
    }

    /**
     * Handle route completion logic
     * @private
     */
    private async handleRouteCompletion(params: {
        selectedRoute: any;
        session: SessionState<TData>;
        history: any[];
        context: TContext;
        lastUserMessage: any;
        signal?: AbortSignal;
    }): Promise<string> {
        const { selectedRoute, session, history, context, lastUserMessage, signal } = params;

        // Get endStep spec from route
        const endStepSpec = selectedRoute.endStepSpec;

        // Create a temporary step for completion message generation using endStep configuration
        const completionStep = new Step<TContext, TData>(selectedRoute.id, {
            description: endStepSpec.description,
            id: endStepSpec.id || END_ROUTE_ID,
            collect: endStepSpec.collect,
            requires: endStepSpec.requires,
            prompt: endStepSpec.prompt || "Summarize what was accomplished and confirm completion based on the conversation history and collected data",
        });

        // Build response schema for completion
        const responseSchema = this.responseEngine.responseSchemaForRoute(selectedRoute, completionStep, this.agent.getSchema());
        const templateContext = { context, session, history };

        // Build completion response prompt
        const completionPrompt = await this.responseEngine.buildResponsePrompt({
            route: selectedRoute,
            currentStep: completionStep,
            rules: selectedRoute.getRules(),
            prohibitions: selectedRoute.getProhibitions(),
            directives: undefined, // No directives for completion
            history,
            lastMessage: lastUserMessage,
            agentOptions: this.agent.getAgentOptions(),
            combinedGuidelines: [...this.agent.getGuidelines(), ...selectedRoute.getGuidelines()],
            combinedTerms: this.mergeTerms(this.agent.getTerms(), selectedRoute.getTerms()),
            context,
            session,
            agentSchema: this.agent.getSchema(),
        });

        // Generate completion message using AI provider
        const agentOptions = this.agent.getAgentOptions();
        const completionResult = await agentOptions.provider.generateMessage({
            prompt: completionPrompt,
            history,
            context,
            signal,
            parameters: { jsonSchema: responseSchema, schemaName: "completion_message" },
        });

        const message = completionResult.structured?.message || completionResult.message;
        logger.debug(`[ResponseModal] Generated completion message for route: ${selectedRoute.title}`);

        // Check for onComplete transition
        const transitionConfig = await selectedRoute.evaluateOnComplete({ data: session.data }, context);

        if (transitionConfig) {
            // Find target route by ID or title
            const targetRoute = this.agent.getRoutes().find(
                (r) => r.id === transitionConfig.nextStep || r.title === transitionConfig.nextStep
            );

            if (targetRoute) {
                const renderedCondition = await render(transitionConfig.condition, templateContext);
                // Set pending transition in session
                session.pendingTransition = {
                    targetRouteId: targetRoute.id,
                    condition: renderedCondition,
                    reason: "route_complete",
                };
                logger.debug(`[ResponseModal] Route ${selectedRoute.title} completed with pending transition to: ${targetRoute.title}`);
            } else {
                logger.warn(`[ResponseModal] Route ${selectedRoute.title} completed but target route not found: ${transitionConfig.nextStep}`);
            }
        }

        return message;
    }

    /**
     * Stream route completion response
     * @private
     */
    private async *streamRouteCompletion(params: {
        selectedRoute: any;
        session: SessionState<TData>;
        history: any[];
        context: TContext;
        lastUserMessage: any;
        signal?: AbortSignal;
    }): AsyncGenerator<AgentResponseStreamChunk<TData>> {
        let { selectedRoute, session, history, context, lastUserMessage, signal } = params;

        // Get endStep spec from route
        const endStepSpec = selectedRoute.endStepSpec;

        // Create a temporary step for completion message generation using endStep configuration
        const completionStep = new Step<TContext, TData>(selectedRoute.id, {
            description: endStepSpec.description,
            id: endStepSpec.id || END_ROUTE_ID,
            collect: endStepSpec.collect,
            requires: endStepSpec.requires,
            prompt: endStepSpec.prompt || "Summarize what was accomplished and confirm completion based on the conversation history and collected data",
        });

        // Build response schema for completion
        const responseSchema = this.responseEngine.responseSchemaForRoute(selectedRoute, completionStep, this.agent.getSchema());
        const templateContext = { context, session, history };

        // Build completion response prompt
        const completionPrompt = await this.responseEngine.buildResponsePrompt({
            route: selectedRoute,
            currentStep: completionStep,
            rules: selectedRoute.getRules(),
            prohibitions: selectedRoute.getProhibitions(),
            directives: undefined, // No directives for completion
            history,
            lastMessage: lastUserMessage,
            agentOptions: this.agent.getAgentOptions(),
            combinedGuidelines: [...this.agent.getGuidelines(), ...selectedRoute.getGuidelines()],
            combinedTerms: this.mergeTerms(this.agent.getTerms(), selectedRoute.getTerms()),
            context,
            session,
            agentSchema: this.agent.getSchema(),
        });

        // Stream completion message using AI provider
        const agentOptions = this.agent.getAgentOptions();
        const stream = agentOptions.provider.generateMessageStream({
            prompt: completionPrompt,
            history,
            context,
            signal,
            parameters: { jsonSchema: responseSchema, schemaName: "completion_message_stream" },
        });

        logger.debug(`[ResponseModal] Streaming completion message for route: ${selectedRoute.title}`);

        // Check for onComplete transition
        const transitionConfig = await selectedRoute.evaluateOnComplete({ data: session.data }, context);

        if (transitionConfig) {
            // Find target route by ID or title
            const targetRoute = this.agent.getRoutes().find(
                (r) => r.id === transitionConfig.nextStep || r.title === transitionConfig.nextStep
            );

            if (targetRoute) {
                const renderedCondition = await render(transitionConfig.condition, templateContext);
                // Set pending transition in session
                session = {
                    ...session,
                    pendingTransition: {
                        targetRouteId: targetRoute.id,
                        condition: renderedCondition,
                        reason: "route_complete",
                    },
                };
                logger.debug(`[ResponseModal] Route ${selectedRoute.title} completed with pending transition to: ${targetRoute.title}`);
            } else {
                logger.warn(`[ResponseModal] Route ${selectedRoute.title} completed but target route not found: ${transitionConfig.nextStep}`);
            }
        }

        // Set step to END_ROUTE marker
        session = enterStep(session, END_ROUTE_ID, "Route completed");
        logger.debug(`[ResponseModal] Route ${selectedRoute.title} completed. Entered END_ROUTE step.`);

        // Stream completion chunks
        for await (const chunk of stream) {
            // Update current session if we have one
            if (chunk.done) {
                await this.finalizeSession(session, context);
            }

            yield {
                delta: chunk.delta,
                accumulated: chunk.accumulated,
                done: chunk.done,
                session,
                toolCalls: undefined,
                isRouteComplete: true,
                metadata: chunk.metadata,
                structured: chunk.structured,
            };
        }
    }

    /**
     * Generate fallback response when no routes are available
     * @private
     */
    private async generateFallbackResponse(params: {
        history: any[];
        context: TContext;
        session: SessionState<TData>;
        signal?: AbortSignal;
    }): Promise<string> {
        const { history, context, session, signal } = params;

        logger.debug(`[ResponseModal] No route selected, generating basic response`);

        // Build basic response prompt without route context
        const fallbackPrompt = await this.responseEngine.buildFallbackPrompt({
            history,
            agentOptions: this.agent.getAgentOptions(),
            terms: this.agent.getTerms(),
            guidelines: this.agent.getGuidelines(),
            context,
            session,
        });

        const agentOptions = this.agent.getAgentOptions();
        const result = await agentOptions.provider.generateMessage({
            prompt: fallbackPrompt,
            history,
            context,
            signal,
            parameters: {
                jsonSchema: {
                    type: "object",
                    properties: { message: { type: "string" } },
                    required: ["message"],
                    additionalProperties: false,
                },
                schemaName: "fallback_response",
            },
        });

        return result.structured?.message || result.message;
    }

    /**
     * Stream fallback response when no routes are available
     * @private
     */
    private async *streamFallbackResponse(params: {
        history: any[];
        context: TContext;
        session: SessionState<TData>;
        signal?: AbortSignal;
    }): AsyncGenerator<AgentResponseStreamChunk<TData>> {
        const { history, context, session, signal } = params;

        const fallbackPrompt = await this.responseEngine.buildFallbackPrompt({
            history,
            agentOptions: this.agent.getAgentOptions(),
            terms: this.agent.getTerms(),
            guidelines: this.agent.getGuidelines(),
            context,
            session,
        });

        const agentOptions = this.agent.getAgentOptions();
        const stream = agentOptions.provider.generateMessageStream({
            prompt: fallbackPrompt,
            history,
            context,
            signal,
            parameters: {
                jsonSchema: {
                    type: "object",
                    properties: { message: { type: "string" } },
                    required: ["message"],
                    additionalProperties: false,
                },
                schemaName: "fallback_stream_response",
            },
        });

        for await (const chunk of stream) {
            // Update current session if we have one
            if (chunk.done) {
                await this.finalizeSession(session, context);
            }

            yield {
                delta: chunk.delta,
                accumulated: chunk.accumulated,
                done: chunk.done,
                session,
                toolCalls: undefined,
                isRouteComplete: false,
                metadata: chunk.metadata,
                structured: chunk.structured,
            };
        }
    }

    /**
     * Handle session persistence and finalization
     * @private
     */
    private async finalizeSession(session: SessionState<TData>, context: TContext): Promise<void> {
        // Auto-save session step to persistence if configured
        const persistenceManager = this.agent.getPersistenceManager();
        const agentOptions = this.agent.getAgentOptions();
        if (
            persistenceManager &&
            session.id &&
            (this.options?.enableAutoSave !== false && agentOptions.persistence?.autoSave !== false)
        ) {
            await persistenceManager.saveSessionState(session.id, session);
            logger.debug(`[ResponseModal] Auto-saved session step to persistence: ${session.id}`);
        }

        // Execute finalize function
        await this.executeStepFinalize(session, context);

        // Update current session if we have one
        const currentSession = this.agent.getCurrentSession();
        if (currentSession) {
            this.agent.setCurrentSession(session);
        }
    }
    // ============================================================================
    // UTILITY METHODS - Helper methods for tool management and other utilities
    // ============================================================================

    /**
     * Find an available tool by name for the given route
     * Route-level tools take precedence over agent-level tools
     * @private
     */
    private findAvailableTool(
        toolName: string,
        route?: any
    ): any | undefined {
        // Check route-level tools first (if route provided)
        if (route) {
            const routeTool = route
                .getTools()
                .find((tool: any) => tool.id === toolName || tool.name === toolName);
            if (routeTool) return routeTool;
        }

        // Fall back to agent-level tools
        const agentTools = this.agent.getTools();
        return agentTools.find(
            (tool) => tool.id === toolName || tool.name === toolName
        );
    }

    /**
     * Collect all available tools for the given route and step context
     * @private
     */
    private collectAvailableTools(
        route?: any,
        step?: any
    ): Array<{
        id: string;
        name: string;
        description?: string;
        parameters?: unknown;
    }> {
        const availableTools = new Map<string, any>();

        // Add agent-level tools
        this.agent.getTools().forEach((tool) => {
            availableTools.set(tool.id, tool);
        });

        // Add route-level tools (these take precedence)
        if (route) {
            route.getTools().forEach((tool: any) => {
                availableTools.set(tool.id, tool);
            });
        }

        // Filter by step-level allowed tools if specified
        if (step?.tools) {
            const allowedToolIds = new Set<string>();
            const stepTools: any[] = [];

            for (const toolRef of step.tools) {
                if (typeof toolRef === "string") {
                    // Reference to registered tool
                    allowedToolIds.add(toolRef);
                } else {
                    // Inline tool definition
                    if (toolRef.id) {
                        allowedToolIds.add(toolRef.id);
                        stepTools.push(toolRef);
                    }
                }
            }

            // If step specifies tools, only include those
            if (allowedToolIds.size > 0) {
                const filteredTools = new Map<string, any>();
                for (const toolId of allowedToolIds) {
                    const tool = availableTools.get(toolId);
                    if (tool) {
                        filteredTools.set(toolId, tool);
                    }
                }
                // Add inline tools
                stepTools.forEach((tool) => {
                    if (tool.id) {
                        filteredTools.set(tool.id, tool);
                    }
                });
                availableTools.clear();
                filteredTools.forEach((tool, id) => availableTools.set(id, tool));
            }
        }

        // Convert to the format expected by AI providers
        return Array.from(availableTools.values()).map((tool) => ({
            id: tool.id,
            name: tool.name || tool.id,
            description: tool.description,
            parameters: tool.parameters,
        }));
    }

    /**
     * Execute a prepare or finalize function/tool
     * @private
     */
    private async executePrepareFinalize(
        prepareOrFinalize:
            | string
            | any
            | ((context: TContext, data?: Partial<TData>) => void | Promise<void>)
            | undefined,
        context: TContext,
        data?: Partial<TData>,
        route?: any,
        step?: any
    ): Promise<void> {
        if (!prepareOrFinalize) return;

        if (typeof prepareOrFinalize === "function") {
            // It's a function - call it directly
            await prepareOrFinalize(context, data);
        } else {
            // It's a tool reference - find and execute the tool
            let tool: any | undefined;

            if (typeof prepareOrFinalize === "string") {
                // Tool ID - find it in available tools
                const availableTools = new Map<string, any>();

                // Add agent-level tools
                this.agent.getTools().forEach((t) => {
                    availableTools.set(t.id, t);
                });

                // Add route-level tools
                if (route) {
                    route.getTools().forEach((t: any) => {
                        availableTools.set(t.id, t);
                    });
                }

                // Add step-level tools
                if (step?.tools) {
                    for (const toolRef of step.tools) {
                        if (typeof toolRef === "string") {
                            // Keep as is
                        } else if (toolRef.id) {
                            availableTools.set(toolRef.id, toolRef);
                        }
                    }
                }

                tool = availableTools.get(prepareOrFinalize);
            } else {
                // Tool object - use directly
                tool = prepareOrFinalize;
            }

            if (tool) {
                const toolExecutor = new ToolExecutor<TContext, TData>();
                const result = await toolExecutor.executeTool({
                    tool,
                    context,
                    updateContext: this.agent.updateContext.bind(this.agent),
                    updateData: this.agent.updateCollectedData.bind(this.agent),
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

    /**
     * Merge terms with route-specific taking precedence on conflicts
     * @private
     */
    private mergeTerms(
        agentTerms: any[],
        routeTerms: any[]
    ): any[] {
        const merged = new Map<string, any>();

        // Add agent terms first
        agentTerms.forEach((term) => {
            const name =
                typeof term.name === "string" ? term.name : term.name.toString();
            merged.set(name, term);
        });

        // Add route terms (these take precedence)
        routeTerms.forEach((term) => {
            const name =
                typeof term.name === "string" ? term.name : term.name.toString();
            merged.set(name, term);
        });

        return Array.from(merged.values());
    }
}