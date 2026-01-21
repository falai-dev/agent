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
    HistoryItem,
    Tool,
    Event,
    ToolEventData,
    AgentStructuredResponse,
    Term,
    StoppedReason,
} from "../types";
import { EventKind, MessageRole } from "../types";
import type { Agent } from "./Agent";
import type { Route } from "./Route";
import { Step } from "./Step";
import { ResponseEngine } from "./ResponseEngine";
import { ResponsePipeline } from "./ResponsePipeline";
import { BatchExecutor, type HookFunction } from "./BatchExecutor";
import { BatchPromptBuilder } from "./BatchPromptBuilder";
import { cloneDeep, mergeCollected, enterStep, getLastMessageFromHistory, render, logger, historyToEvents } from "../utils";
import { createTemplateContext } from "../utils/template";
import type { ToolManager } from "./ToolManager";
import { END_ROUTE_ID } from "../constants";
import type { StepOptions } from "../types/route";

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
export interface RespondParams<TContext = unknown, TData = unknown> extends Record<string, unknown> {
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
 * Error details for response generation failures
 */
interface ResponseGenerationErrorDetails {
    originalError?: unknown;
    params?: Record<string, unknown>;
    phase?: string;
    context?: Record<string, unknown>;
}

/**
 * Error class for response generation failures
 */
export class ResponseGenerationError extends Error {
    constructor(
        message: string,
        public readonly details?: ResponseGenerationErrorDetails
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
    static fromError(
        error: unknown,
        phase: string,
        params?: Record<string, unknown>,
        context?: Record<string, unknown>
    ): ResponseGenerationError {
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
    history: HistoryItem[]; // Keep as HistoryItem[] for external API compatibility
    selectedRoute?: Route<TContext, TData>;
    selectedStep?: Step<TContext, TData>;
    responseDirectives?: string[];
    isRouteComplete: boolean;
    /** Batch of steps to execute (for multi-step execution) */
    batchSteps?: StepOptions<TContext, TData>[];
    /** Reason why batch determination stopped */
    batchStoppedReason?: StoppedReason;
    /** Step that caused batch to stop (if applicable) */
    batchStoppedAtStep?: StepOptions<TContext, TData>;
}

/**
 * ResponseModal class that encapsulates all response generation logic
 * Uses unified approach for both streaming and non-streaming responses
 */
export class ResponseModal<TContext = unknown, TData = unknown> {
    private readonly responseEngine: ResponseEngine<TContext, TData>;
    private readonly responsePipeline: ResponsePipeline<TContext, TData>;
    private readonly batchExecutor: BatchExecutor<TContext, TData>;
    private readonly batchPromptBuilder: BatchPromptBuilder<TContext, TData>;

    constructor(
        private readonly agent: Agent<TContext, TData>,
        private readonly options?: ResponseModalOptions
    ) {
        // Initialize response engine
        this.responseEngine = new ResponseEngine<TContext, TData>();

        // Initialize response pipeline with agent dependencies
        this.responsePipeline = new ResponsePipeline<TContext, TData>(
            this.agent.getAgentOptions(),
            () => this.agent.getRoutes(), // Pass a function to get routes dynamically
            this.agent.getTools(),
            this.agent.getRoutingEngine(),
            this.agent.updateContext.bind(this.agent),
            this.agent.getUpdateDataMethod(),
            this.agent.updateCollectedData.bind(this.agent),
            this.getToolManager()
        );

        // Initialize batch executor for multi-step execution
        this.batchExecutor = new BatchExecutor<TContext, TData>();

        // Initialize batch prompt builder for combined prompts
        this.batchPromptBuilder = new BatchPromptBuilder<TContext, TData>();
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

    /**
     * Get the ToolManager instance from the agent
     * @private
     */
    private getToolManager(): ToolManager<TContext, TData> | undefined {
        // Check if agent has a tool property (ToolManager)
        if (this.agent && 'tool' in this.agent && this.agent.tool) {
            return this.agent.tool;
        }
        
        // Log warning if ToolManager is not available
        logger.warn(`[ResponseModal] ToolManager not available on agent - tool execution will use fallback methods`);
        return undefined;
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

            // Convert HistoryItem[] to Event[] for internal processing
            const historyEvents = historyToEvents(simpleHistory);
            // Keep original HistoryItem[] format for external APIs
            const history = simpleHistory;

            // Use ResponsePipeline for optimized context and session preparation
            // This leverages existing optimizations and avoids code duplication
            let responseContext: {
                effectiveContext: TContext;
                session: SessionState<TData>;
            };
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
            // Also performs pre-extraction and batch determination
            let routingResult: {
                selectedRoute?: Route<TContext, TData>;
                selectedStep?: Step<TContext, TData>;
                responseDirectives?: string[];
                session: SessionState<TData>;
                isRouteComplete: boolean;
                batchSteps?: StepOptions<TContext, TData>[];
                batchStoppedReason?: StoppedReason;
                batchStoppedAtStep?: StepOptions<TContext, TData>;
            };
            try {
                routingResult = await this.handleUnifiedRoutingAndStepSelection({
                    session,
                    history: historyEvents,
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
                batchSteps: routingResult.batchSteps,
                batchStoppedReason: routingResult.batchStoppedReason,
                batchStoppedAtStep: routingResult.batchStoppedAtStep,
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
        history: Event[]; // Use Event[] for internal processing
        context: TContext;
        signal?: AbortSignal;
    }): Promise<{
        selectedRoute?: Route<TContext, TData>;
        selectedStep?: Step<TContext, TData>;
        responseDirectives?: string[];
        session: SessionState<TData>;
        isRouteComplete: boolean;
        /** Batch of steps to execute (for multi-step execution) */
        batchSteps?: StepOptions<TContext, TData>[];
        /** Reason why batch determination stopped */
        batchStoppedReason?: StoppedReason;
        /** Step that caused batch to stop (if applicable) */
        batchStoppedAtStep?: StepOptions<TContext, TData>;
    }> {
        try {
            // Use the ResponsePipeline for optimized routing and step selection
            // This avoids duplicate logic and leverages existing optimizations
            // ResponsePipeline expects Event[] for history
            const routingResult = await this.responsePipeline.handleRoutingAndStepSelection({
                session: params.session,
                history: params.history, // Already Event[]
                context: params.context,
                signal: params.signal,
            });

            let updatedSession = routingResult.session;
            let isRouteComplete = routingResult.isRouteComplete;

            // PRE-EXTRACTION: If entering a route that collects data, extract data from user message first
            // This allows us to skip steps whose data is already provided
            // Requirement 3.1: Perform Pre_Extraction before determining the Batch
            if (routingResult.selectedRoute && !isRouteComplete) {
                // Always pre-extract when route collects data (not just on new route entry)
                // This ensures batch determination has the most up-to-date data
                if (this.shouldPreExtractData(routingResult.selectedRoute)) {
                    logger.debug(
                        `[ResponseModal] Pre-extracting data for route: ${routingResult.selectedRoute.title}`
                    );

                    const extractedData = await this.preExtractRouteData({
                        route: routingResult.selectedRoute,
                        history: params.history,
                        context: params.context,
                        session: updatedSession,
                        signal: params.signal,
                    });

                    if (extractedData && Object.keys(extractedData).length > 0) {
                        logger.debug(
                            `[ResponseModal] Pre-extracted data:`,
                            extractedData
                        );
                        // Requirement 3.3: Merge pre-extracted data into session before batch determination
                        updatedSession = mergeCollected(updatedSession, extractedData);
                        // Also update agent's collected data
                        await this.agent.updateCollectedData(extractedData);

                        // Re-check route completion after pre-extraction
                        const allRequiredFieldsCollected = routingResult.selectedRoute.isComplete(updatedSession.data || {});
                        if (allRequiredFieldsCollected) {
                            logger.debug(
                                `[ResponseModal] Route ${routingResult.selectedRoute.title} completed after pre-extraction`
                            );
                            isRouteComplete = true;
                        }
                    }
                }
            }

            // BATCH DETERMINATION: Use BatchExecutor to determine which steps can execute together
            // Requirement 3.4: Pre-extraction results affect batch determination
            let batchSteps: StepOptions<TContext, TData>[] | undefined;
            let batchStoppedReason: StoppedReason | undefined;
            let batchStoppedAtStep: StepOptions<TContext, TData> | undefined;

            if (routingResult.selectedRoute && !isRouteComplete) {
                // Determine current step position for batch determination
                const currentStep = routingResult.selectedStep || 
                    (updatedSession.currentStep ? routingResult.selectedRoute.getStep(updatedSession.currentStep.id) : undefined);

                logger.debug(`[ResponseModal] Determining batch starting from step: ${currentStep?.id || 'initial'}`);

                const batchResult = await this.batchExecutor.determineBatch({
                    route: routingResult.selectedRoute,
                    currentStep,
                    sessionData: updatedSession.data || {},
                    context: params.context,
                });

                batchSteps = batchResult.steps;
                batchStoppedReason = batchResult.stoppedReason;
                batchStoppedAtStep = batchResult.stoppedAtStep;

                logger.debug(`[ResponseModal] Batch determined: ${batchSteps.length} steps, stopped reason: ${batchStoppedReason}`);
            }

            // Determine next step using pipeline method for consistency
            const stepResult = await this.responsePipeline.determineNextStep({
                selectedRoute: routingResult.selectedRoute,
                selectedStep: routingResult.selectedStep,
                session: updatedSession, // Use updated session with pre-extracted data
                isRouteComplete, // Use updated completion status
            });

            return {
                selectedRoute: routingResult.selectedRoute,
                selectedStep: stepResult.nextStep, // Use the determined next step
                responseDirectives: routingResult.responseDirectives,
                session: stepResult.session,
                isRouteComplete, // Use updated completion status
                batchSteps,
                batchStoppedReason,
                batchStoppedAtStep,
            };
        } catch (error) {
            throw ResponseGenerationError.fromError(error, 'routing_optimization', params);
        }
    }

    /**
     * Check if a route should pre-extract data before determining the initial step
     * @private
     */
    private shouldPreExtractData(route: Route<TContext, TData>): boolean {
        // Pre-extract if route has declared required or optional fields
        if (route.requiredFields && route.requiredFields.length > 0) {
            return true;
        }
        if (route.optionalFields && route.optionalFields.length > 0) {
            return true;
        }

        // Pre-extract if any step in the route collects data
        const steps = route.getAllSteps();
        const hasDataCollectionSteps = steps.some(
            step => step.collect && step.collect.length > 0
        );

        return hasDataCollectionSteps;
    }

    /**
     * Pre-extract data from user message when entering a route
     * This allows skipping steps whose data is already provided
     * @private
     */
    private async preExtractRouteData(params: {
        route: Route<TContext, TData>;
        history: Event[];
        context: TContext;
        session: SessionState<TData>;
        signal?: AbortSignal;
    }): Promise<Partial<TData>> {
        const { route, history, context, signal } = params;

        // Build a schema for data extraction based on route's fields
        const extractionSchema = this.agent.getSchema();
        if (!extractionSchema) {
            logger.warn(`[ResponseModal] No schema available for pre-extraction`);
            return {};
        }

        // Get last user message
        const lastMessage = getLastMessageFromHistory(history);

        // Build extraction prompt
        const extractionPrompt = [
            `Extract any relevant information from the user's message that matches the following data fields.`,
            `Only extract information that is explicitly stated or clearly implied.`,
            ``,
            `User's message: "${lastMessage}"`,
            ``,
            `Extract data for these fields if present:`,
        ];

        // Add field descriptions
        if (route.requiredFields) {
            extractionPrompt.push(`Required fields: ${route.requiredFields.join(', ')}`);
        }
        if (route.optionalFields) {
            extractionPrompt.push(`Optional fields: ${route.optionalFields.join(', ')}`);
        }

        extractionPrompt.push(
            ``,
            `Return ONLY the extracted data as JSON. If no data can be extracted, return an empty object {}.`
        );

        // Call AI to extract data
        const agentOptions = this.agent.getAgentOptions();
        try {
            const result = await agentOptions.provider.generateMessage<TContext, Partial<TData>>({
                prompt: extractionPrompt.join('\n'),
                history,
                context,
                signal,
                parameters: {
                    jsonSchema: extractionSchema,
                    schemaName: 'data_extraction',
                },
            });

            return result.structured || {};
        } catch (error) {
            logger.error(`[ResponseModal] Pre-extraction failed:`, error);
            return {};
        }
    }

    /**
     * Unified response generation for non-streaming responses
     * @private
     */
    private async generateUnifiedResponse(
        responseContext: ResponseContext<TContext, TData>
    ): Promise<AgentResponse<TData>> {
        const { 
            effectiveContext, 
            session: initialSession, 
            history, 
            selectedRoute, 
            selectedStep, 
            responseDirectives, 
            isRouteComplete,
            batchSteps,
            batchStoppedReason,
        } = responseContext;
        let session = initialSession;

        // Get last user message (needed for both route and completion handling)
        // Convert HistoryItem[] to Event[] for internal processing
        const historyEvents = historyToEvents(history);
        const lastMessageText = getLastMessageFromHistory(historyEvents);

        let message: string;
        let toolCalls: Array<{ toolName: string; arguments: Record<string, unknown> }> | undefined = undefined;
        let executedSteps: StepRef[] | undefined;
        let stoppedReason: StoppedReason | undefined;


        
        if (selectedRoute && !isRouteComplete) {
            // Check if we have batch steps to execute
            if (batchSteps && batchSteps.length > 0) {
                // BATCH EXECUTION: Execute multiple steps in a single LLM call
                logger.debug(`[ResponseModal] Executing batch of ${batchSteps.length} steps`);

                const batchResult = await this.executeBatchResponse({
                    selectedRoute,
                    batchSteps,
                    responseDirectives,
                    session,
                    history,
                    context: effectiveContext,
                    historyEvents,
                });

                message = batchResult.message;
                toolCalls = batchResult.toolCalls;
                session = batchResult.session;
                executedSteps = batchResult.executedSteps;
                stoppedReason = batchStoppedReason;

            } else {
                // SINGLE STEP EXECUTION: Fall back to single-step processing
                // This happens when batch determination returns empty (first step needs input)
                const result = await this.processRouteResponse({
                    selectedRoute,
                    selectedStep,
                    responseDirectives,
                    session,
                    history,
                    context: effectiveContext,
                    lastMessageText,
                    historyEvents,
                    signal: undefined,
                });

                message = result.message;
                toolCalls = result.toolCalls;
                session = result.session;
                
                // Track executed step for single-step execution
                if (selectedStep) {
                    executedSteps = [{
                        id: selectedStep.id,
                        routeId: selectedRoute.id,
                    }];
                }
                stoppedReason = batchStoppedReason || 'needs_input';
            }

        } else if (isRouteComplete && selectedRoute) {
            // Handle route completion
            logger.debug(`[ResponseModal] Generating completion message for route: ${selectedRoute.title}`);

            try {
                message = await this.handleRouteCompletion({
                    selectedRoute,
                    session,
                    context: effectiveContext,
                    lastMessageText,
                    historyEvents,
                    signal: undefined,
                });

                // Set step to END_ROUTE marker
                session = enterStep(session, END_ROUTE_ID, "Route completed");
                stoppedReason = 'route_complete';
                logger.debug(`[ResponseModal] Route ${selectedRoute.title} completed. Entered END_ROUTE step.`);
            } catch (error) {
                logger.error(`[ResponseModal] Error generating completion message:`, error);
                // Fallback to simple completion message
                message = `Thank you! I've recorded all the information for your ${selectedRoute.title.toLowerCase()}.`;
                session = enterStep(session, END_ROUTE_ID, "Route completed");
                stoppedReason = 'route_complete';
            }

        } else {
            // Fallback: No routes defined, generate a simple response

            message = await this.generateFallbackResponse({
                history: historyEvents, // Use Event[] for fallback response
                context: effectiveContext,
                session,
            });
            
            // For fallback responses, set empty executedSteps and no stoppedReason
            // since there's no route/step execution happening
            executedSteps = [];
            stoppedReason = undefined;
        }

        // Ensure response structure completeness (Requirement 8.1, 8.2, 8.3)
        // - executedSteps: array of steps executed (empty array if none)
        // - stoppedReason: why execution stopped (undefined for fallback)
        // - session.currentStep: reflects final step position
        return {
            message,
            session,
            toolCalls,
            isRouteComplete,
            executedSteps: executedSteps || [],
            stoppedReason,
        };
    }

    /**
     * Execute a batch of steps with a single LLM call
     * 
     * This method:
     * 1. Executes all prepare hooks for steps in the batch (in order)
     * 2. Builds a combined prompt using BatchPromptBuilder
     * 3. Makes a single LLM call
     * 4. Collects data from the response for all steps
     * 5. Executes all finalize hooks for steps in the batch (in order)
     * 
     * @private
     * **Validates: Requirements 1.1, 4.4, 5.1, 5.2**
     */
    private async executeBatchResponse(params: {
        selectedRoute: Route<TContext, TData>;
        batchSteps: StepOptions<TContext, TData>[];
        responseDirectives?: string[];
        session: SessionState<TData>;
        history: HistoryItem[];
        context: TContext;
        historyEvents: Event[];
        signal?: AbortSignal;
    }): Promise<{
        message: string;
        toolCalls?: Array<{ toolName: string; arguments: Record<string, unknown> }>;
        session: SessionState<TData>;
        executedSteps: StepRef[];
    }> {
        const { selectedRoute, batchSteps, history, context, historyEvents, signal } = params;
        let session = params.session;

        logger.debug(`[ResponseModal] Starting batch execution for ${batchSteps.length} steps`);

        // Create hook executor function
        const executeHook = async (
            hook: HookFunction<TContext, TData>,
            hookContext: TContext,
            data?: Partial<TData>,
            step?: StepOptions<TContext, TData>
        ): Promise<void> => {
            // Find the route for this step
            const route = selectedRoute;
            // Convert StepOptions to Step if needed for executePrepareFinalize
            const stepInstance = step?.id ? route.getStep(step.id) : undefined;
            await this.executePrepareFinalize(hook, hookContext, data, route, stepInstance);
        };

        // PHASE 1: Execute all prepare hooks (Requirement 5.1)
        logger.debug(`[ResponseModal] Executing prepare hooks for batch`);
        const prepareResult = await this.batchExecutor.executePrepareHooks({
            steps: batchSteps,
            context,
            data: session.data,
            executeHook,
        });

        if (!prepareResult.success) {
            // Prepare hook failed - return error response
            logger.error(`[ResponseModal] Prepare hook failed:`, prepareResult.error);
            throw new ResponseGenerationError(
                `Prepare hook failed: ${prepareResult.error?.message}`,
                { 
                    phase: 'prepare_hooks', 
                    context: { 
                        stepId: prepareResult.error?.stepId,
                        executedSteps: prepareResult.executedSteps,
                    } 
                }
            );
        }

        // PHASE 2: Build combined prompt using BatchPromptBuilder (Requirement 4.4)
        logger.debug(`[ResponseModal] Building batch prompt`);
        const batchPromptResult = await this.batchPromptBuilder.buildBatchPrompt({
            steps: batchSteps,
            route: selectedRoute,
            history: historyEvents,
            context,
            session,
            agentOptions: this.agent.getAgentOptions(),
        });

        logger.debug(`[ResponseModal] Batch prompt built with ${batchPromptResult.stepCount} steps, collecting: ${batchPromptResult.collectFields.join(', ')}`);

        // Build response schema for batch (includes all collect fields)
        const responseSchema = this.buildBatchResponseSchema(batchPromptResult.collectFields);

        // Collect available tools for AI (from all steps in batch)
        const availableTools = this.collectBatchAvailableTools(selectedRoute, batchSteps);

        // PHASE 3: Make single LLM call (Requirement 4.4)
        logger.debug(`[ResponseModal] Making LLM call for batch`);
        const agentOptions = this.agent.getAgentOptions();
        const result = await agentOptions.provider.generateMessage({
            prompt: batchPromptResult.prompt,
            history: historyEvents,
            context,
            tools: availableTools,
            signal,
            parameters: responseSchema ? { jsonSchema: responseSchema, schemaName: "batch_response" } : undefined,
        });

        let message = result.structured?.message || result.message;
        let toolCalls = result.structured?.toolCalls;

        logger.debug(`[ResponseModal] LLM response received for batch`);

        // Execute tools if any
        if (toolCalls && toolCalls.length > 0) {
            const toolResult = await this.executeUnifiedToolLoop({
                toolCalls,
                context,
                session,
                history,
                selectedRoute,
                responsePrompt: batchPromptResult.prompt,
                availableTools,
                responseSchema,
                signal,
            });

            session = toolResult.session;
            toolCalls = toolResult.finalToolCalls;
            if (toolResult.finalMessage) {
                message = toolResult.finalMessage;
            }
        }

        // PHASE 4: Collect data from response for all steps (Requirement 6.1, 6.2, 6.3)
        logger.debug(`[ResponseModal] Collecting batch data`);
        const collectResult = this.batchExecutor.collectBatchData({
            steps: batchSteps,
            llmResponse: result.structured || {},
            session,
            schema: this.agent.getSchema(),
        });

        session = collectResult.session;

        if (collectResult.collectedData && Object.keys(collectResult.collectedData).length > 0) {
            // Update agent's collected data
            await this.agent.updateCollectedData(collectResult.collectedData);
            logger.debug(`[ResponseModal] Batch collected data:`, collectResult.collectedData);
        }

        if (collectResult.validationErrors && collectResult.validationErrors.length > 0) {
            logger.warn(`[ResponseModal] Batch data validation errors:`, collectResult.validationErrors);
        }

        // Update session to final step position
        const lastStep = batchSteps[batchSteps.length - 1];
        if (lastStep?.id) {
            session = enterStep(session, lastStep.id, lastStep.description);
            logger.debug(`[ResponseModal] Updated session to final batch step: ${lastStep.id}`);
        }

        // PHASE 5: Execute all finalize hooks (Requirement 5.2)
        logger.debug(`[ResponseModal] Executing finalize hooks for batch`);
        const finalizeResult = await this.batchExecutor.executeFinalizeHooks({
            steps: batchSteps,
            context,
            data: session.data,
            executeHook,
        });

        if (finalizeResult.errors && finalizeResult.errors.length > 0) {
            // Log finalize errors but don't fail (Requirement 5.5)
            logger.warn(`[ResponseModal] Some finalize hooks failed:`, finalizeResult.errors);
        }

        // Build executed steps list
        const executedSteps: StepRef[] = batchSteps
            .filter(step => step.id)
            .map(step => ({
                id: step.id!,
                routeId: selectedRoute.id,
            }));

        logger.debug(`[ResponseModal] Batch execution complete. Executed ${executedSteps.length} steps`);

        return {
            message,
            toolCalls,
            session,
            executedSteps,
        };
    }

    /**
     * Build response schema for batch execution
     * @private
     */
    private buildBatchResponseSchema(collectFields: string[]): Record<string, unknown> {
        const properties: Record<string, unknown> = {
            message: {
                type: "string",
                description: "Your response to the user",
            },
        };

        // Add collect fields to schema
        for (const field of collectFields) {
            properties[field] = {
                type: "string",
                description: `Collected value for ${field}`,
            };
        }

        return {
            type: "object",
            properties,
            required: ["message"],
            additionalProperties: true,
        };
    }

    /**
     * Collect available tools from all steps in the batch
     * @private
     */
    private collectBatchAvailableTools(
        route: Route<TContext, TData>,
        batchSteps: StepOptions<TContext, TData>[]
    ): Array<{
        id: string;
        name: string;
        description?: string;
        parameters?: unknown;
    }> {
        const availableTools = new Map<string, Tool<TContext, TData>>();

        // Add agent-level tools
        this.agent.getTools().forEach((tool) => {
            availableTools.set(tool.id, tool);
        });

        // Add route-level tools
        route.getTools().forEach((tool: Tool<TContext, TData>) => {
            availableTools.set(tool.id, tool);
        });

        // Add step-level tools from all batch steps
        for (const step of batchSteps) {
            if (step.tools) {
                for (const toolRef of step.tools) {
                    if (typeof toolRef === "string") {
                        // Reference to registered tool - already in availableTools
                    } else if (typeof toolRef === 'object' && 'id' in toolRef && toolRef.id) {
                        // Inline tool definition
                        availableTools.set(toolRef.id, toolRef);
                    }
                }
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
     * Unified streaming response generation
     * @private
     */
    private async *generateUnifiedStreamingResponse(
        responseContext: ResponseContext<TContext, TData>
    ): AsyncGenerator<AgentResponseStreamChunk<TData>> {
        const { 
            effectiveContext, 
            session: initialSession, 
            history, 
            selectedRoute, 
            selectedStep, 
            responseDirectives, 
            isRouteComplete,
            batchSteps,
            batchStoppedReason,
        } = responseContext;
        const session = initialSession;

        // Get last user message (needed for both route and completion handling)
        // Convert HistoryItem[] to Event[] for internal processing
        const historyEvents = historyToEvents(history);
        const lastMessageText = getLastMessageFromHistory(historyEvents);

        if (selectedRoute && !isRouteComplete) {
            // Check if we have batch steps to execute
            if (batchSteps && batchSteps.length > 0) {
                // BATCH EXECUTION: Execute multiple steps with streaming
                // Note: For streaming, we still use batch execution but stream the response
                logger.debug(`[ResponseModal] Streaming batch execution for ${batchSteps.length} steps`);

                yield* this.streamBatchResponse({
                    selectedRoute,
                    batchSteps,
                    responseDirectives,
                    session,
                    history,
                    context: effectiveContext,
                    historyEvents,
                    batchStoppedReason,
                });
            } else {
                // SINGLE STEP EXECUTION: Fall back to single-step streaming
                yield* this.processRouteStreamingResponse({
                    selectedRoute,
                    selectedStep,
                    responseDirectives,
                    session,
                    history,
                    context: effectiveContext,
                    lastMessageText,
                    historyEvents,
                });
            }

        } else if (isRouteComplete && selectedRoute) {
            // Handle route completion streaming
            yield* this.streamRouteCompletion({
                selectedRoute,
                session,
                context: effectiveContext,
                lastMessageText,
                historyEvents,
            });

        } else {
            // Fallback: No routes defined, stream a simple response
            yield* this.streamFallbackResponse({
                history: historyEvents, // Use Event[] for fallback response
                context: effectiveContext,
                session,
            });
        }
    }

    /**
     * Stream a batch response with multiple steps
     * 
     * Similar to executeBatchResponse but streams the LLM response.
     * 
     * @private
     */
    private async *streamBatchResponse(params: {
        selectedRoute: Route<TContext, TData>;
        batchSteps: StepOptions<TContext, TData>[];
        responseDirectives?: string[];
        session: SessionState<TData>;
        history: HistoryItem[];
        context: TContext;
        historyEvents: Event[];
        batchStoppedReason?: StoppedReason;
        signal?: AbortSignal;
    }): AsyncGenerator<AgentResponseStreamChunk<TData>> {
        const { selectedRoute, batchSteps, context, historyEvents, batchStoppedReason, signal } = params;
        let session = params.session;

        // Create hook executor function
        const executeHook = async (
            hook: HookFunction<TContext, TData>,
            hookContext: TContext,
            data?: Partial<TData>,
            step?: StepOptions<TContext, TData>
        ): Promise<void> => {
            const route = selectedRoute;
            const stepInstance = step?.id ? route.getStep(step.id) : undefined;
            await this.executePrepareFinalize(hook, hookContext, data, route, stepInstance);
        };

        // PHASE 1: Execute all prepare hooks
        const prepareResult = await this.batchExecutor.executePrepareHooks({
            steps: batchSteps,
            context,
            data: session.data,
            executeHook,
        });

        if (!prepareResult.success) {
            // Yield error chunk
            yield {
                delta: "",
                accumulated: "",
                done: true,
                session,
                error: new ResponseGenerationError(
                    `Prepare hook failed: ${prepareResult.error?.message}`,
                    { phase: 'prepare_hooks' }
                ),
            };
            return;
        }

        // PHASE 2: Build combined prompt
        const batchPromptResult = await this.batchPromptBuilder.buildBatchPrompt({
            steps: batchSteps,
            route: selectedRoute,
            history: historyEvents,
            context,
            session,
            agentOptions: this.agent.getAgentOptions(),
        });

        const responseSchema = this.buildBatchResponseSchema(batchPromptResult.collectFields);
        const availableTools = this.collectBatchAvailableTools(selectedRoute, batchSteps);

        // PHASE 3: Stream LLM response
        const agentOptions = this.agent.getAgentOptions();
        const stream = agentOptions.provider.generateMessageStream({
            prompt: batchPromptResult.prompt,
            history: historyEvents,
            context,
            tools: availableTools,
            signal,
            parameters: responseSchema ? { jsonSchema: responseSchema, schemaName: "batch_stream_response" } : undefined,
        });

        // Build executed steps list
        const executedSteps: StepRef[] = batchSteps
            .filter(step => step.id)
            .map(step => ({
                id: step.id!,
                routeId: selectedRoute.id,
            }));

        // Stream chunks
        for await (const chunk of stream) {
            // On final chunk, collect data and execute finalize hooks
            if (chunk.done) {
                // Collect data from response
                if (chunk.structured) {
                    const collectResult = this.batchExecutor.collectBatchData({
                        steps: batchSteps,
                        llmResponse: chunk.structured,
                        session,
                        schema: this.agent.getSchema(),
                    });

                    session = collectResult.session;

                    if (collectResult.collectedData && Object.keys(collectResult.collectedData).length > 0) {
                        await this.agent.updateCollectedData(collectResult.collectedData);
                    }
                }

                // Update session to final step position
                const lastStep = batchSteps[batchSteps.length - 1];
                if (lastStep?.id) {
                    session = enterStep(session, lastStep.id, lastStep.description);
                }

                // Execute finalize hooks
                await this.batchExecutor.executeFinalizeHooks({
                    steps: batchSteps,
                    context,
                    data: session.data,
                    executeHook,
                });

                // Finalize session
                await this.finalizeSession(session, context);
            }

            yield {
                delta: chunk.delta,
                accumulated: chunk.accumulated,
                done: chunk.done,
                session,
                toolCalls: chunk.structured?.toolCalls,
                isRouteComplete: false,
                executedSteps: chunk.done ? executedSteps : undefined,
                stoppedReason: chunk.done ? batchStoppedReason : undefined,
                metadata: chunk.metadata,
                structured: chunk.structured,
            };
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
        selectedRoute: Route<TContext, TData>;
        selectedStep?: Step<TContext, TData>;
        responseDirectives?: string[];
        session: SessionState<TData>;
        history: HistoryItem[]; // Keep as HistoryItem[] for AI provider compatibility
        context: TContext;
        lastMessageText: string; // String version for buildResponsePrompt
        historyEvents: Event[]; // Event[] version for buildResponsePrompt
        signal?: AbortSignal;
    }): Promise<{
        message: string;
        toolCalls?: Array<{ toolName: string; arguments: Record<string, unknown> }>;
        session: SessionState<TData>;
    }> {
        const { selectedRoute, selectedStep, responseDirectives, history, context, lastMessageText, historyEvents, signal } = params;
        let session = params.session;

        // Determine next step
        let nextStep: Step<TContext, TData>;
        if (selectedStep) {
            nextStep = selectedStep;
        } else {
            // Determine current step from session if we're already in this route
            const isInSameRoute = session.currentRoute?.id === selectedRoute.id;
            const currentStep = isInSameRoute && session.currentStep
                ? selectedRoute.getStep(session.currentStep.id)
                : undefined;

            logger.debug(`[ResponseModal] Step determination: route match=${isInSameRoute}, currentRoute=${session.currentRoute?.id}, selectedRoute=${selectedRoute.id}, currentStep=${currentStep?.id || 'none'}`);

            // Get candidate steps based on current position in the route
            const routingEngine = this.agent.getRoutingEngine();
            const candidates = await routingEngine.getCandidateStepsWithConditions(
                selectedRoute, 
                currentStep, // Pass current step instead of undefined to maintain progression
                createTemplateContext({ data: session.data, session, context })
            );
            
            logger.debug(`[ResponseModal] Found ${candidates.length} candidate steps${currentStep ? ' from current step ' + currentStep.id : ' (new route entry)'}`);
            
            if (candidates.length > 0) {
                nextStep = candidates[0].step;
                logger.debug(`[ResponseModal] Using first valid step: ${nextStep.id}${currentStep ? ' (progressing from ' + currentStep.id + ')' : ' for new route'}`);
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
            history: historyEvents, // Use Event[] for buildResponsePrompt
            lastMessage: lastMessageText, // Use string for buildResponsePrompt
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
            history: historyEvents, // Use Event[] for AI provider
            context,
            tools: availableTools,
            signal,
            parameters: responseSchema ? { jsonSchema: responseSchema, schemaName: "response_output" } : undefined,
        });

        let message = result.structured?.message || result.message;
        let toolCalls = result.structured?.toolCalls;

        // Debug: Log initial AI response
        logger.debug(`[ResponseModal] Initial AI response:`, {
            hasMessage: !!message,
            messageLength: message?.length || 0,
            hasToolCalls: !!toolCalls,
            toolCallsCount: toolCalls?.length || 0,
            toolNames: toolCalls?.map(tc => tc.toolName) || [],
        });

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
        selectedRoute: Route<TContext, TData>;
        selectedStep?: Step<TContext, TData>;
        responseDirectives?: string[];
        session: SessionState<TData>;
        history: HistoryItem[];
        context: TContext;
        lastMessageText: string; // String version for buildResponsePrompt
        historyEvents: Event[]; // Event[] version for buildResponsePrompt
        signal?: AbortSignal;
    }): AsyncGenerator<AgentResponseStreamChunk<TData>> {
        const { selectedRoute, selectedStep, responseDirectives, history, context, lastMessageText, historyEvents, signal } = params;
        let session = params.session;

        // Determine next step (same logic as non-streaming)
        let nextStep: Step<TContext, TData>;
        if (selectedStep) {
            nextStep = selectedStep;
        } else {
            // Determine current step from session if we're already in this route
            const currentStep = session.currentRoute?.id === selectedRoute.id && session.currentStep
                ? selectedRoute.getStep(session.currentStep.id)
                : undefined;

            // Get candidate steps based on current position in the route
            const routingEngine = this.agent.getRoutingEngine();
            const candidates = await routingEngine.getCandidateStepsWithConditions(
                selectedRoute, 
                currentStep, // Pass current step instead of undefined to maintain progression
                createTemplateContext({ data: session.data, session, context })
            );
            
            if (candidates.length > 0) {
                nextStep = candidates[0].step;
                logger.debug(`[ResponseModal] Using first valid step: ${nextStep.id}${currentStep ? ' (progressing from ' + currentStep.id + ')' : ' for new route'}`);
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
            history: historyEvents, // Use Event[] for buildResponsePrompt
            lastMessage: lastMessageText, // Use string for buildResponsePrompt
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
            history: historyEvents, // Use Event[] for AI provider
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

            // Response structure completeness (Requirement 8.1, 8.2, 8.3)
            // - executedSteps: single step executed in this response
            // - stoppedReason: 'needs_input' for single-step execution (waiting for user input)
            // - session.currentStep: reflects the executed step
            yield {
                delta: chunk.delta,
                accumulated: chunk.accumulated,
                done: chunk.done,
                session,
                toolCalls,
                isRouteComplete: false,
                executedSteps: chunk.done ? [{ id: nextStep.id, routeId: selectedRoute.id }] : undefined,
                stoppedReason: chunk.done ? 'needs_input' : undefined,
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
        history: HistoryItem[];
        selectedRoute?: Route<TContext, TData>;
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
    }> {
        try {
            const { context, history, selectedRoute, responsePrompt, availableTools, responseSchema, signal } = params;
            let { toolCalls, session } = params;

            // Convert HistoryItem[] to Event[] for internal processing
            const historyEvents = historyToEvents(history);

            // Execute initial dynamic tool calls
            if (toolCalls && toolCalls.length > 0) {
                logger.debug(`[ResponseModal] Executing ${toolCalls.length} dynamic tool calls:`, toolCalls.map(tc => tc.toolName));

                for (const toolCall of toolCalls) {
                    const tool = this.findAvailableTool(toolCall.toolName, selectedRoute);
                    if (!tool) {
                        logger.warn(`[ResponseModal] Tool not found: ${toolCall.toolName}`);
                        continue;
                    }

                    try {
                        // Use ToolManager for unified tool execution
                        const toolManager = this.getToolManager();
                        let toolResult;

                        if (toolManager) {
                            toolResult = await toolManager.executeTool({
                                tool: tool,
                                context,
                                updateContext: this.agent.updateContext.bind(this.agent),
                                updateData: this.agent.updateCollectedData.bind(this.agent),
                                history: historyEvents, // Use Event[] for tool execution
                                data: session.data,
                                toolArguments: toolCall.arguments,
                            });
                        } else {
                            // Fallback: execute tool directly if ToolManager not available
                            throw new Error(`ToolManager not available for tool execution: ${toolCall.toolName}`);
                        }

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

                        logger.debug(`[ResponseModal] Executed dynamic tool: ${toolCall.toolName} (success: ${toolResult.success})`);
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
                logger.debug(`[ResponseModal] Starting tool loop ${toolLoopCount}/${MAX_TOOL_LOOPS} with ${toolCalls?.length || 0} tool calls`);

                // Create tool result events with proper Event format structure
                const toolResultEvents: Event<ToolEventData>[] = [];
                for (const toolCall of toolCalls || []) {
                    const tool = this.findAvailableTool(toolCall.toolName, selectedRoute);
                    if (tool) {
                        // Create proper Event format for tool results
                        const toolResultEvent: Event<ToolEventData> = {
                            kind: EventKind.TOOL,
                            source: MessageRole.AGENT,
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
                        };
                        toolResultEvents.push(toolResultEvent);
                    }
                }

                // Create updated history with tool results (combine Event arrays)
                const updatedHistoryEvents = [...historyEvents, ...toolResultEvents];

                // Make follow-up AI call to see if more tools are needed
                // After first iteration, don't provide tools to force a text response
                const agentOptions = this.agent.getAgentOptions();
                const shouldProvideTools = toolLoopCount === 1;
                
                logger.debug(`[ResponseModal] Making follow-up AI call (loop ${toolLoopCount}):`, {
                    providingTools: shouldProvideTools,
                    toolsCount: shouldProvideTools ? availableTools.length : 0,
                    addingTextInstruction: toolLoopCount > 1,
                });

                const followUpResult = await agentOptions.provider.generateMessage({
                    prompt: responsePrompt + (toolLoopCount > 1 ? "\n\nProvide a text response to the user based on the tool results." : ""),
                    history: updatedHistoryEvents, // Use Event[] for AI provider
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

                logger.debug(`[ResponseModal] Follow-up AI response (loop ${toolLoopCount}):`, {
                    hasMessage: !!followUpResult.message,
                    messageLength: followUpResult.message?.length || 0,
                    hasToolCalls,
                    toolCallsCount: followUpToolCalls?.length || 0,
                    toolNames: followUpToolCalls?.map(tc => tc.toolName) || [],
                });

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
                            // Use ToolManager for unified tool execution
                            const toolManager = this.getToolManager();
                            let toolResult;

                            if (toolManager) {
                                toolResult = await toolManager.executeTool({
                                    tool: tool,
                                    context,
                                    updateContext: this.agent.updateContext.bind(this.agent),
                                    updateData: this.agent.updateCollectedData.bind(this.agent),
                                    history: updatedHistoryEvents, // Use Event[] for tool execution
                                    data: session.data,
                                    toolArguments: toolCall.arguments,
                                });
                            } else {
                                // Fallback: execute tool directly if ToolManager not available
                                throw new Error(`ToolManager not available for follow-up tool execution: ${toolCall.toolName}`);
                            }

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

                            logger.debug(`[ResponseModal] Executed follow-up tool: ${toolCall.toolName} (success: ${toolResult.success})`);
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

            logger.debug(`[ResponseModal] Tool loop completed:`, {
                totalIterations: toolLoopCount,
                hasFinalMessage: !!finalMessage,
                finalMessageLength: finalMessage?.length || 0,
                finalToolCallsCount: toolCalls?.length || 0,
            });

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
    }    /**
     * Unified data collection from AI response
     * @private
     */
    private async collectDataFromResponse(params: {
        result: { structured?: AgentStructuredResponse };
        selectedRoute?: Route<TContext, TData>;
        nextStep?: Step<TContext, TData>;
        session: SessionState<TData>;
    }): Promise<SessionState<TData>> {
        try {
            const { result, selectedRoute, nextStep, session } = params;
            let updatedSession = session;

            // Extract collected data from final response (only for route-based interactions)
            if (selectedRoute && result.structured) {
                try {
                    const collectedData: Record<string, unknown> = {};
                    // AgentStructuredResponse extends Record<string, unknown>, so we can safely access properties
                    const structuredData = result.structured;

                    // Collect ALL route fields (required + optional) from structured response
                    const allRouteFields = new Set<string>();
                    
                    // Add route required fields
                    if (selectedRoute.requiredFields) {
                        selectedRoute.requiredFields.forEach(field => allRouteFields.add(String(field)));
                    }
                    
                    // Add route optional fields
                    if (selectedRoute.optionalFields) {
                        selectedRoute.optionalFields.forEach(field => allRouteFields.add(String(field)));
                    }
                    
                    // Also include current step's collect fields (in case they're not in route fields)
                    if (nextStep?.collect) {
                        nextStep.collect.forEach(field => allRouteFields.add(String(field)));
                    }

                    // Extract all available fields from structured response
                    for (const field of allRouteFields) {
                        const fieldKey = String(field);
                        if (fieldKey in structuredData && structuredData[fieldKey] !== undefined && structuredData[fieldKey] !== null) {
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
            // Since AgentStructuredResponse extends Record<string, unknown>, we can safely check for additional properties
            if (result.structured && "contextUpdate" in result.structured) {
                try {
                    const contextUpdate = (result.structured as AgentStructuredResponse & { contextUpdate?: Partial<TContext> }).contextUpdate;
                    if (contextUpdate) {
                        await this.agent.updateContext(contextUpdate);
                    }
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
        selectedRoute: Route<TContext, TData>;
        session: SessionState<TData>;
        context: TContext;
        lastMessageText: string; // String version for buildResponsePrompt
        historyEvents: Event[]; // Event[] version for buildResponsePrompt
        signal?: AbortSignal;
    }): Promise<string> {
        const { selectedRoute, session, context, lastMessageText, historyEvents, signal } = params;

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

        // Build response schema for completion (message only, no data collection)
        const completionSchema = {
            type: "object",
            properties: {
                message: {
                    type: "string",
                    description: "Completion message confirming what was accomplished",
                },
            },
            required: ["message"],
            additionalProperties: false,
        };
        
        const templateContext = createTemplateContext({ context, session, history: historyEvents });

        // Build completion response prompt using ResponseEngine
        // Filter out conditional guidelines - only include always-active ones
        const alwaysActiveGuidelines = [
            ...this.agent.getGuidelines().filter(g => !g.condition),
            ...selectedRoute.getGuidelines().filter(g => !g.condition),
        ];
        let completitionPrompt =  "Summarize what was accomplished and confirm completion"
        if(endStepSpec.prompt){
            completitionPrompt = await render(endStepSpec.prompt, templateContext)
        }

        const completionPrompt = await this.responseEngine.buildResponsePrompt({
            route: selectedRoute,
            currentStep: completionStep,
            rules: selectedRoute.getRules(),
            prohibitions: selectedRoute.getProhibitions(),
            directives: [
                `Task completed: ${selectedRoute.title}`,
                `Collected data: ${JSON.stringify(session.data, null, 2)}`,
                "Do NOT ask for more information - the task is complete",
                completitionPrompt,
            ],
            history: historyEvents,
            lastMessage: lastMessageText,
            agentOptions: this.agent.getAgentOptions(),
            combinedGuidelines: alwaysActiveGuidelines, // Only non-conditional guidelines
            combinedTerms: this.mergeTerms(this.agent.getTerms(), selectedRoute.getTerms()),
            context,
            session,
            agentSchema: undefined, // No data collection schema for completion
        });

        // Generate completion message using AI provider
        const agentOptions = this.agent.getAgentOptions();
        logger.debug(`[ResponseModal] Calling AI provider for completion message...`);

        const completionResult = await agentOptions.provider.generateMessage({
            prompt: completionPrompt,
            history: historyEvents,
            context,
            signal,
            parameters: { jsonSchema: completionSchema, schemaName: "completion_message" },
        });

        logger.debug(`[ResponseModal] AI provider returned completion result`);
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
        selectedRoute: Route<TContext, TData>;
        session: SessionState<TData>;
        context: TContext;
        lastMessageText: string; // String version for buildResponsePrompt
        historyEvents: Event[]; // Event[] version for buildResponsePrompt
        signal?: AbortSignal;
    }): AsyncGenerator<AgentResponseStreamChunk<TData>> {
        const { selectedRoute, context, lastMessageText, historyEvents, signal } = params;
        let session = params.session;

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
        const templateContext = createTemplateContext({ context, session, history: historyEvents }); // Use Event[] for template context

        // Build completion response prompt
        const completionPrompt = await this.responseEngine.buildResponsePrompt({
            route: selectedRoute,
            currentStep: completionStep,
            rules: selectedRoute.getRules(),
            prohibitions: selectedRoute.getProhibitions(),
            directives: undefined, // No directives for completion
            history: historyEvents, // Use Event[] for buildResponsePrompt
            lastMessage: lastMessageText, // Use string for buildResponsePrompt
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
            history: historyEvents, // Use Event[] for AI provider
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

            // Response structure completeness (Requirement 8.1, 8.2, 8.3)
            // - executedSteps: empty for route completion (no new steps executed)
            // - stoppedReason: 'route_complete' for completed routes
            // - session.currentStep: set to END_ROUTE
            yield {
                delta: chunk.delta,
                accumulated: chunk.accumulated,
                done: chunk.done,
                session,
                toolCalls: undefined,
                isRouteComplete: true,
                executedSteps: chunk.done ? [] : undefined,
                stoppedReason: chunk.done ? 'route_complete' : undefined,
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
        history: Event[]; // Use Event[] for buildFallbackPrompt
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
        history: Event[]; // Use Event[] for buildFallbackPrompt
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

            // Response structure completeness (Requirement 8.1, 8.2, 8.3)
            // - executedSteps: empty for fallback (no route/step execution)
            // - stoppedReason: undefined for fallback (no route context)
            // - session.currentStep: unchanged (no step progression)
            yield {
                delta: chunk.delta,
                accumulated: chunk.accumulated,
                done: chunk.done,
                session,
                toolCalls: undefined,
                isRouteComplete: false,
                executedSteps: chunk.done ? [] : undefined,
                stoppedReason: undefined,
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
     * Find an available tool by name for the given route using ToolManager
     * Delegates to ToolManager for unified tool resolution
     * @private
     */
    private findAvailableTool(
        toolName: string,
        route?: Route<TContext, TData>
    ): Tool<TContext, TData> | undefined {
        // Use ToolManager for unified tool resolution
        const toolManager = this.getToolManager();
        if (toolManager) {
            return toolManager.find(toolName, undefined, undefined, route);
        }

        // Fallback to legacy resolution if ToolManager not available
        logger.warn(`[ResponseModal] ToolManager not available, using legacy tool resolution for: ${toolName}`);
        
        // Check route-level tools first (if route provided)
        if (route) {
            const routeTool = route
                .getTools()
                .find((tool: Tool<TContext, TData>) => tool.id === toolName || tool.name === toolName);
            if (routeTool) return routeTool;
        }

        // Fall back to agent-level tools
        const agentTools = this.agent.getTools();
        return agentTools.find(
            (tool) => tool.id === toolName || tool.name === toolName
        );
    }

    /**
     * Collect all available tools for the given route and step context using ToolManager
     * Delegates to ToolManager for unified tool resolution and deduplication
     * @private
     */
    private collectAvailableTools(
        route?: Route<TContext, TData>,
        step?: Step<TContext, TData>
    ): Array<{
        id: string;
        name: string;
        description?: string;
        parameters?: unknown;
    }> {
        // Use ToolManager for unified tool collection if available
        const toolManager = this.getToolManager();
        if (toolManager) {
            const availableTools = toolManager.getAvailable(undefined, step, route);
            return availableTools.map((tool) => ({
                id: tool.id,
                name: tool.name || tool.id,
                description: tool.description,
                parameters: tool.parameters,
            }));
        }

        // Fallback to legacy collection logic if ToolManager not available
        logger.warn(`[ResponseModal] ToolManager not available, using legacy tool collection`);
        
        const availableTools = new Map<string, Tool<TContext, TData>>();

        // Add agent-level tools
        this.agent.getTools().forEach((tool) => {
            availableTools.set(tool.id, tool);
        });

        // Add route-level tools (these take precedence)
        if (route) {
            route.getTools().forEach((tool: Tool<TContext, TData>) => {
                availableTools.set(tool.id, tool);
            });
        }

        // Filter by step-level allowed tools if specified
        if (step?.tools) {
            const allowedToolIds = new Set<string>();
            const stepTools: Tool<TContext, TData>[] = [];

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
                const filteredTools = new Map<string, Tool<TContext, TData>>();
                for (const toolId of Array.from(allowedToolIds)) {
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
            | Tool<TContext, TData>
            | ((context: TContext, data?: Partial<TData>) => void | Promise<void>)
            | undefined,
        context: TContext,
        data?: Partial<TData>,
        route?: Route<TContext, TData>,
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
                const toolManager = this.getToolManager();
                if (toolManager) {
                    tool = toolManager.find(prepareOrFinalize, undefined, step, route);
                } else {
                    // Fallback to legacy resolution if ToolManager not available
                    logger.warn(`[ResponseModal] ToolManager not available, using legacy tool resolution for prepare/finalize: ${prepareOrFinalize}`);
                    
                    const availableTools = new Map<string, Tool<TContext, TData>>();

                    // Add agent-level tools
                    this.agent.getTools().forEach((t) => {
                        availableTools.set(t.id, t);
                    });

                    // Add route-level tools
                    if (route) {
                        route.getTools().forEach((t: Tool<TContext, TData>) => {
                            availableTools.set(t.id, t);
                        });
                    }

                    // Add step-level tools
                    if (step?.tools) {
                        for (const toolRef of step.tools) {
                            if (typeof toolRef === "string") {
                                // Keep as is
                            } else if (typeof toolRef === 'object' && 'id' in toolRef && toolRef.id) {
                                availableTools.set(toolRef.id, toolRef);
                            }
                        }
                    }

                    tool = availableTools.get(prepareOrFinalize);
                }
            } else {
                // Tool object - use directly
                tool = prepareOrFinalize;
            }

            if (tool) {
                // Use ToolManager for unified tool execution
                const toolManager = this.getToolManager();
                let result;

                if (toolManager) {
                    result = await toolManager.executeTool({
                        tool,
                        context,
                        updateContext: this.agent.updateContext.bind(this.agent),
                        updateData: this.agent.updateCollectedData.bind(this.agent),
                        history: [], // Empty history for prepare/finalize
                        data,
                    });
                } else {
                    // Fallback: execute tool directly if ToolManager not available
                    throw new Error(`ToolManager not available for prepare/finalize tool execution: ${typeof prepareOrFinalize === "string" ? prepareOrFinalize : "inline tool"}`);
                }

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
        agentTerms: Term<TContext, TData>[],
        routeTerms: Term<TContext, TData>[]
    ): Term<TContext, TData>[] {
        const merged = new Map<string, Term<TContext, TData>>();

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