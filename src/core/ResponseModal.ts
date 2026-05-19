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
    AgentStructuredResponse,
    StoppedReason,
    ToolCallRequest,
    ScopedInstructions,
    AppliedInstruction,
    PrepareResult,
    PreDirective,
} from "../types";
import type { SignalFiring } from "../types/signals";
import type { Agent } from "./Agent";
import type { Flow } from "./Flow";
import { Step } from "./Step";
import { ResponseEngine } from "./ResponseEngine";
import { ResponsePipeline, hasDirectivePositionField } from "./ResponsePipeline";
import { AutoChainExecutor, type AutoChainResult } from "./AutoChainExecutor";
import { cloneDeep, mergeCollected, enterStep, enterFlow, getLastMessageFromHistory, logger, historyToEvents, eventsToHistory, serializeToolResult, completeCurrentFlow, render } from "../utils";
import { createTemplateContext } from "../utils/template";
import type { ToolManager } from "./ToolManager";

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
            `[ResponseGenerationError] Response generation failed in ${phase}: ${message}. ` +
            `Check provider configuration and the ${phase} phase handler.`,
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
    selectedFlow?: Flow<TContext, TData>;
    selectedStep?: Step<TContext, TData>;
    responseDirectives?: string[];
    isFlowComplete: boolean;
    /** AbortSignal for cancellation propagation */
    signal?: AbortSignal;
    /** Signal firings accumulated across both phases (pre + post) for the response surface. */
    signalFirings?: SignalFiring<TContext, TData>[];
    /** Pre-phase merged directive from signals (non-position fields like appendPrompt, injectTools). */
    signalPreDirective?: PreDirective<TContext, TData>;
    /** Whether the pre-signal phase emitted a halt directive. */
    signalHalted?: boolean;
    /** Reply from a halt directive. */
    signalHaltReply?: string;
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
        this.responseEngine = new ResponseEngine<TContext, TData>(this.agent.promptSectionCache);

        // Initialize response pipeline with agent dependencies
        this.responsePipeline = new ResponsePipeline<TContext, TData>(
            this.agent.getAgentOptions(),
            () => this.agent.getFlows(), // Pass a function to get flows dynamically
            this.agent.getTools(),
            this.agent.getFlowRouter(),
            this.agent.updateContext.bind(this.agent),
            this.agent.getUpdateDataMethod(),
            this.agent.updateCollectedData.bind(this.agent),
            this.getToolManager(),
            this.agent.signalProcessor
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
                `[ResponseGenerationError] Response generation failed: ${error instanceof Error ? error.message : String(error)}. ` +
                `Check provider configuration and network connectivity.`,
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
        let finalizedSession: SessionState<TData> | undefined;
        for await (const chunk of this.respondStream({
            history,
            session,
            contextOverride: options?.contextOverride,
            signal: options?.signal,
        })) {
            // Accumulate the final message and capture finalized session
            if (chunk.done) {
                finalMessage = chunk.accumulated;
                finalizedSession = chunk.session;
            }

            yield chunk;
        }

        // Sync finalized session to agent.session.current (skip in override-history mode)
        // Must happen BEFORE addMessage so the assistant message is added on top of the synced session state
        if (!options?.history && finalizedSession) {
            this.agent.session.syncSession(finalizedSession);
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

        // Sync finalized session to agent.session.current (skip in override-history mode)
        // Must happen BEFORE addMessage so the assistant message is added on top of the synced session state
        if (!options?.history && result.session) {
            this.agent.session.syncSession(result.session);
        }

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

    /**
     * Collect scoped instructions from agent, flow, and step into a ScopedInstructions value.
     * @private
     */
    private collectScopedInstructions(
        flow?: Flow<TContext, TData>,
        step?: Step<TContext, TData>,
    ): ScopedInstructions<TContext, TData> {
        return {
            global: this.agent.instructions,
            flow: flow ? { flowTitle: flow.title, items: flow.instructions } : undefined,
            step: step ? { stepId: step.id, items: step.getInstructions() } : undefined,
        };
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
                throw new ResponseGenerationError(
                    '[ResponseGenerationError] Missing history: history is required for response generation. ' +
                    'Pass a valid history array to the respond/stream method.',
                    { params, phase: 'validation' }
                );
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
                this.responsePipeline.setCurrentSession(this.agent.currentSession);

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

            // PHASE 2: ROUTING + STEP SELECTION - Determine which flow and step to use
            // Performs pre-extraction and step selection
            let routingResult: {
                selectedFlow?: Flow<TContext, TData>;
                selectedStep?: Step<TContext, TData>;
                responseDirectives?: string[];
                session: SessionState<TData>;
                isFlowComplete: boolean;
                signalFirings?: SignalFiring<TContext, TData>[];
                signalPreDirective?: PreDirective<TContext, TData>;
                signalHalted?: boolean;
                signalHaltReply?: string;
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
                selectedFlow: routingResult.selectedFlow,
                selectedStep: routingResult.selectedStep,
                responseDirectives: routingResult.responseDirectives,
                isFlowComplete: routingResult.isFlowComplete,
                signal,
                signalFirings: routingResult.signalFirings,
                signalPreDirective: routingResult.signalPreDirective,
                signalHalted: routingResult.signalHalted,
                signalHaltReply: routingResult.signalHaltReply,
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
        selectedFlow?: Flow<TContext, TData>;
        selectedStep?: Step<TContext, TData>;
        responseDirectives?: string[];
        session: SessionState<TData>;
        isFlowComplete: boolean;
        /** Signal firings from the pre-phase (threaded through for response surface). */
        signalFirings?: SignalFiring<TContext, TData>[];
        /** Non-position signal directive for pre-LLM augmentation (appendPrompt, injectTools, etc). */
        signalPreDirective?: PreDirective<TContext, TData>;
        /** Pre-signal phase halted the turn. */
        signalHalted?: boolean;
        /** Reply text from the halt directive. */
        signalHaltReply?: string;
    }> {
        try {
            // Create a fresh chain tracker for this turn (Requirement 22.1)
            this.responsePipeline.createChainTracker();

            // ROUTING SKIP OPTIMIZATION (Requirements 20.1, 20.2, 20.3):
            // When the current step has collect fields AND pre-extraction populates at least
            // one of those fields, skip FlowRouter.decideFlowAndStep for this turn.
            const routingSkipResult = await this.attemptRoutingSkipForCollect(params);
            if (routingSkipResult) {
                // Even when routing is skipped, run pre-signal phase if processor is present
                if (this.agent.signalProcessor) {
                    const signalResult = await this.responsePipeline.runPreSignalPhase(
                        params.session, params.context, params.history,
                    );
                    // If signal halts, override the routing skip result
                    if (signalResult.mergedDirective?.halt) {
                        return {
                            ...routingSkipResult,
                            session: signalResult.updatedSession,
                            signalFirings: signalResult.firings,
                            signalHalted: true,
                            signalHaltReply: signalResult.mergedDirective.reply,
                        };
                    }
                    // If signal has position fields, override routing skip result
                    if (hasDirectivePositionField(signalResult.mergedDirective)) {
                        return this.applySignalPositionDirective(
                            signalResult, params,
                        );
                    }
                    // Non-position directive: propagate for pre-LLM augmentation
                    return {
                        ...routingSkipResult,
                        session: signalResult.updatedSession,
                        signalFirings: signalResult.firings,
                        signalPreDirective: signalResult.mergedDirective || undefined,
                    };
                }
                return routingSkipResult;
            }

            // ── PARALLEL PRE-SIGNAL PHASE + ROUTING (Algorithm 5) ────────────────
            // When signalProcessor is present, run pre-signals in parallel with routing.
            // When absent, call the router directly (zero overhead, preserve current behavior).
            if (this.agent.signalProcessor) {
                // Run pre-signal phase in parallel with routing (Requirement 8.1)
                const [signalResult, routingResult] = await Promise.all([
                    this.responsePipeline.runPreSignalPhase(
                        params.session, params.context, params.history,
                    ),
                    this.responsePipeline.handleRoutingAndStepSelection({
                        session: params.session,
                        history: params.history,
                        context: params.context,
                        signal: params.signal,
                    }),
                ]);

                // ── Requirement 8.2: halt → discard routing, skip LLM ────────────
                if (signalResult.mergedDirective?.halt) {
                    return {
                        selectedFlow: undefined,
                        selectedStep: undefined,
                        session: signalResult.updatedSession,
                        isFlowComplete: false,
                        signalFirings: signalResult.firings,
                        signalHalted: true,
                        signalHaltReply: signalResult.mergedDirective.reply,
                    };
                }

                // ── Requirement 8.3: position directive → discard routing, apply signal position ──
                if (hasDirectivePositionField(signalResult.mergedDirective)) {
                    return this.applySignalPositionDirective(
                        signalResult, params,
                    );
                }

                // ── Requirement 8.4: non-position directive → use routing, propagate augmentation ──
                // ── Requirement 8.5: no directive → use routing as-is ─────────────
                let updatedSession = signalResult.updatedSession;

                // Apply data/context updates from signal to the routed session
                if (signalResult.mergedDirective?.dataUpdate) {
                    updatedSession = mergeCollected(updatedSession, signalResult.mergedDirective.dataUpdate);
                }

                // Use routing result for flow/step, but carry signal session state
                // Merge routing session changes on top of signal session
                const routingSession = routingResult.session;
                updatedSession = {
                    ...updatedSession,
                    currentFlow: routingSession.currentFlow,
                    currentStep: routingSession.currentStep,
                    flowHistory: routingSession.flowHistory,
                    pendingDirective: routingSession.pendingDirective,
                };

                const isFlowComplete = routingResult.isFlowComplete;

                // PRE-EXTRACTION: same logic as below — extract data from user message
                if (routingResult.selectedFlow && !isFlowComplete) {
                    if (this.shouldPreExtractData(routingResult.selectedFlow)) {
                        logger.debug(
                            `[ResponseModal] Pre-extracting data for flow: ${routingResult.selectedFlow.title}`
                        );
                        const extractedData = await this.preExtractFlowData({
                            route: routingResult.selectedFlow,
                            history: params.history,
                            context: params.context,
                            session: updatedSession,
                            signal: params.signal,
                        });
                        if (extractedData && Object.keys(extractedData).length > 0) {
                            logger.debug(`[ResponseModal] Pre-extracted data:`, extractedData);
                            updatedSession = mergeCollected(updatedSession, extractedData);
                            await this.agent.updateCollectedData(extractedData);
                        }
                    }
                }

                // Determine next step
                const stepResult = await this.responsePipeline.determineNextStep({
                    selectedFlow: routingResult.selectedFlow,
                    selectedStep: routingResult.selectedStep,
                    session: updatedSession,
                    isFlowComplete,
                });

                return {
                    selectedFlow: stepResult.flowChanged || routingResult.selectedFlow,
                    selectedStep: stepResult.nextStep,
                    responseDirectives: routingResult.responseDirectives,
                    session: stepResult.session,
                    isFlowComplete: stepResult.flowChanged ? false : isFlowComplete,
                    signalFirings: signalResult.firings,
                    signalPreDirective: signalResult.mergedDirective || undefined,
                };
            }

            // ── No signal processor: existing behavior (zero overhead) ────────────
            const routingResult = await this.responsePipeline.handleRoutingAndStepSelection({
                session: params.session,
                history: params.history,
                context: params.context,
                signal: params.signal,
            });

            let updatedSession = routingResult.session;
            const isFlowComplete = routingResult.isFlowComplete;

            // PRE-EXTRACTION: If entering a flow that collects data, extract data from user message first
            // This allows us to skip steps whose data is already provided
            if (routingResult.selectedFlow && !isFlowComplete) {
                // Always pre-extract when flow collects data (not just on new flow entry)
                // This ensures step selection has the most up-to-date data
                if (this.shouldPreExtractData(routingResult.selectedFlow)) {
                    logger.debug(
                        `[ResponseModal] Pre-extracting data for flow: ${routingResult.selectedFlow.title}`
                    );

                    const extractedData = await this.preExtractFlowData({
                        route: routingResult.selectedFlow,
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
                        // Merge pre-extracted data into session before step selection
                        updatedSession = mergeCollected(updatedSession, extractedData);
                        // Also update agent's collected data
                        await this.agent.updateCollectedData(extractedData);
                    }
                }
            }

            // Determine next step using pipeline method for consistency
            const stepResult = await this.responsePipeline.determineNextStep({
                selectedFlow: routingResult.selectedFlow,
                selectedStep: routingResult.selectedStep,
                session: updatedSession, // Use updated session with pre-extracted data
                isFlowComplete, // Use updated completion status
            });

            return {
                selectedFlow: stepResult.flowChanged || routingResult.selectedFlow,
                selectedStep: stepResult.nextStep, // Use the determined next step
                responseDirectives: routingResult.responseDirectives,
                session: stepResult.session,
                // If a branch changed the flow, the original isFlowComplete no longer applies
                isFlowComplete: stepResult.flowChanged ? false : isFlowComplete,
            };
        } catch (error) {
            throw ResponseGenerationError.fromError(error, 'routing_optimization', params);
        }
    }

    /**
     * Apply a signal's position directive (goTo, goToStep, complete, abort, reset).
     * Discards routing result and uses the signal's position decision.
     * @private
     * @requirements 8.3
     */
    private applySignalPositionDirective(
        signalResult: {
            firings: SignalFiring<TContext, TData>[];
            updatedSession: SessionState<TData>;
            mergedDirective: PreDirective<TContext, TData> | undefined;
        },
        _params: { session: SessionState<TData>; history: Event[]; context: TContext },
    ): {
        selectedFlow?: Flow<TContext, TData>;
        selectedStep?: Step<TContext, TData>;
        responseDirectives?: string[];
        session: SessionState<TData>;
        isFlowComplete: boolean;
        signalFirings?: SignalFiring<TContext, TData>[];
        signalPreDirective?: PreDirective<TContext, TData>;
        signalHalted?: boolean;
        signalHaltReply?: string;
    } {
        const directive = signalResult.mergedDirective!;
        let session = signalResult.updatedSession;
        const flows = this.agent.getFlows();
        let selectedFlow: Flow<TContext, TData> | undefined;
        let selectedStep: Step<TContext, TData> | undefined;
        let isFlowComplete = false;

        // Apply data updates if present alongside position
        if (directive.dataUpdate) {
            session = mergeCollected(session, directive.dataUpdate);
        }

        if (directive.goTo) {
            const flowTarget = typeof directive.goTo === 'string'
                ? directive.goTo
                : directive.goTo.flow ?? directive.goTo.step;

            if (flowTarget) {
                const targetFlow = flows.find(f => f.id === flowTarget || f.title === flowTarget);
                if (targetFlow) {
                    session = enterFlow(session, targetFlow.id, targetFlow.title);
                    selectedFlow = targetFlow;

                    if (typeof directive.goTo === 'object' && directive.goTo.step) {
                        const targetStep = targetFlow.getStep(directive.goTo.step);
                        if (targetStep) {
                            session = enterStep(session, targetStep.id, targetStep.description);
                            selectedStep = targetStep;
                        }
                    }
                } else {
                    logger.warn(`[Signals] Pre-phase goTo target not found: "${flowTarget}". Falling back to no flow.`);
                }
            }
        } else if (directive.goToStep) {
            const stepTarget = typeof directive.goToStep === 'string'
                ? directive.goToStep
                : directive.goToStep.step;
            const flowTarget = typeof directive.goToStep === 'object'
                ? directive.goToStep.flow
                : undefined;

            if (flowTarget) {
                const targetFlow = flows.find(f => f.id === flowTarget || f.title === flowTarget);
                if (targetFlow) {
                    session = enterFlow(session, targetFlow.id, targetFlow.title);
                    selectedFlow = targetFlow;
                    const targetStep = targetFlow.getStep(stepTarget);
                    if (targetStep) {
                        session = enterStep(session, targetStep.id, targetStep.description);
                        selectedStep = targetStep;
                    }
                }
            } else if (session.currentFlow) {
                const currentFlow = flows.find(f => f.id === session.currentFlow?.id);
                if (currentFlow) {
                    selectedFlow = currentFlow;
                    const targetStep = currentFlow.getStep(stepTarget);
                    if (targetStep) {
                        session = enterStep(session, targetStep.id, targetStep.description);
                        selectedStep = targetStep;
                    }
                }
            }
        } else if (directive.complete) {
            isFlowComplete = true;
        } else if (directive.abort) {
            // Abort — no flow, session cleared or marked
            isFlowComplete = true;
        } else if (directive.reset) {
            if (session.currentFlow) {
                const currentFlow = flows.find(f => f.id === session.currentFlow?.id);
                if (currentFlow) {
                    selectedFlow = currentFlow;
                    const resetStep = typeof directive.reset === 'object' && directive.reset.step
                        ? directive.reset.step
                        : undefined;
                    if (resetStep) {
                        const targetStep = currentFlow.getStep(resetStep);
                        if (targetStep) {
                            session = enterStep(session, targetStep.id, targetStep.description);
                            selectedStep = targetStep;
                        }
                    } else {
                        const initialStep = currentFlow.initialStep;
                        session = enterStep(session, initialStep.id, initialStep.description);
                        selectedStep = initialStep;
                    }
                }
            }
        }

        return {
            selectedFlow,
            selectedStep,
            session,
            isFlowComplete,
            signalFirings: signalResult.firings,
            signalPreDirective: signalResult.mergedDirective || undefined,
        };
    }

    /**
     * Routing skip optimization (Requirements 20.1, 20.2, 20.3):
     * When the current step declares `collect` fields AND pre-extraction populates
     * at least one of those fields from the user's message, skip routing for this turn.
     *
     * Returns the routing result if the skip applies, or undefined to fall through
     * to normal routing.
     * @private
     */
    private async attemptRoutingSkipForCollect(params: {
        session: SessionState<TData>;
        history: Event[];
        context: TContext;
        signal?: AbortSignal;
    }): Promise<{
        selectedFlow?: Flow<TContext, TData>;
        selectedStep?: Step<TContext, TData>;
        responseDirectives?: string[];
        session: SessionState<TData>;
        isFlowComplete: boolean;
    } | undefined> {
        const { session } = params;

        // Only applies when we already have a current flow and step
        if (!session.currentFlow || !session.currentStep) {
            return undefined;
        }

        // Also skip this optimization if there's a pending directive (it takes priority)
        if (session.pendingDirective) {
            return undefined;
        }

        // Look up the actual Flow and Step objects to access `collect`
        const currentFlow = this.agent.getFlows().find(
            (f) => f.id === session.currentFlow?.id
        );
        if (!currentFlow) {
            return undefined;
        }

        const currentStep = currentFlow.getStep(session.currentStep.id);
        if (!currentStep || !currentStep.collect || currentStep.collect.length === 0) {
            return undefined;
        }

        // We have a step with collect fields. Run pre-extraction to see if the
        // user's message populates any of them.
        const collectFields = currentStep.collect;

        // Snapshot current data for comparison
        const dataBefore = { ...session.data };

        // Run pre-extraction against the current flow
        const extractedData = await this.preExtractFlowData({
            route: currentFlow,
            history: params.history,
            context: params.context,
            session,
            signal: params.signal,
        });

        if (!extractedData || Object.keys(extractedData).length === 0) {
            return undefined;
        }

        // Determine which collect fields were newly populated by pre-extraction
        const populatedCollectFields: string[] = [];
        for (const field of collectFields) {
            const key = field as string;
            const hadValue = dataBefore[field] !== undefined && dataBefore[field] !== null;
            const hasNewValue = extractedData[field] !== undefined && extractedData[field] !== null;
            if (hasNewValue && !hadValue) {
                populatedCollectFields.push(key);
            }
        }

        if (populatedCollectFields.length === 0) {
            // Pre-extraction didn't populate any declared collect field — no skip
            return undefined;
        }

        // ROUTING SKIP: pre-extraction populated collect fields → retain current flow/step
        logger.debug(
            `[ResponseModal] Routing skip: pre-extraction populated collect fields [${populatedCollectFields.join(', ')}] for step "${currentStep.id}" — skipping FlowRouter`
        );

        // Merge extracted data into session
        const updatedSession = mergeCollected(session, extractedData);
        await this.agent.updateCollectedData(extractedData);

        // Determine next step using pipeline method for consistency
        // Pass the current flow/step as the routing result (retained)
        const stepResult = await this.responsePipeline.determineNextStep({
            selectedFlow: currentFlow,
            selectedStep: currentStep,
            session: updatedSession,
            isFlowComplete: false,
        });

        return {
            selectedFlow: stepResult.flowChanged || currentFlow,
            selectedStep: stepResult.nextStep,
            responseDirectives: undefined,
            session: stepResult.session,
            isFlowComplete: stepResult.flowChanged ? false : false,
        };
    }

    /**
     * Check if a flow should pre-extract data before determining the initial step
     * @private
     */
    private shouldPreExtractData(flow: Flow<TContext, TData>): boolean {
        // Pre-extract if flow has declared required or optional fields
        if (flow.requiredFields && flow.requiredFields.length > 0) {
            return true;
        }
        if (flow.optionalFields && flow.optionalFields.length > 0) {
            return true;
        }

        // Pre-extract if any step in the flow collects data
        const steps = flow.getAllSteps();
        const hasDataCollectionSteps = steps.some(
            step => step.collect && step.collect.length > 0
        );

        return hasDataCollectionSteps;
    }

    /**
     * Pre-extract data from user message when entering a flow
     * This allows skipping steps whose data is already provided
     * @private
     */
    private async preExtractFlowData(params: {
        route: Flow<TContext, TData>;
        history: Event[];
        context: TContext;
        session: SessionState<TData>;
        signal?: AbortSignal;
    }): Promise<Partial<TData>> {
        const { route: flow, history, signal } = params;

        // Build a schema for data extraction based on flow's fields
        const extractionSchema = this.agent.schema;
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
        if (flow.requiredFields) {
            extractionPrompt.push(`Required fields: ${flow.requiredFields.join(', ')}`);
        }
        if (flow.optionalFields) {
            extractionPrompt.push(`Optional fields: ${flow.optionalFields.join(', ')}`);
        }

        extractionPrompt.push(
            ``,
            `Return ONLY the extracted data as JSON. If no data can be extracted, return an empty object {}.`
        );

        // Convert Event[] to HistoryItem[] for provider call
        const historyItems = eventsToHistory(history);

        // Call AI to extract data
        const agentOptions = this.agent.getAgentOptions();
        try {
            const result = await agentOptions.provider.generateMessage<TContext, Partial<TData>>({
                prompt: extractionPrompt.join('\n'),
                history: historyItems,
                context: {} as TContext, // Passed as empty object so AI doesn't "extract" from context
                // NOTE: context is intentionally NOT passed here.
                // Passing context caused the AI to "extract" data from the lead's context
                // (e.g., name, sector, city) instead of from what the user actually said.
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
            selectedFlow,
            selectedStep,
            responseDirectives,
            isFlowComplete,
            signal,
            signalFirings: preSignalFirings,
            signalPreDirective,
            signalHalted,
            signalHaltReply,
        } = responseContext;
        let session = initialSession;

        // Accumulator for signal firings across both phases (fire order)
        const signalFirings: SignalFiring<TContext, TData>[] = [...(preSignalFirings || [])];

        // Get last user message (needed for both flow and completion handling)
        // Convert HistoryItem[] to Event[] for internal processing
        const historyEvents = historyToEvents(history);

        // ── SIGNAL HALT (Requirement 8.2) ─────────────────────────────────────
        // Pre-signal phase emitted halt → skip LLM call entirely.
        if (signalHalted) {
            const haltMessage = signalHaltReply || '';
            // Run post-signal phase even on halt (post-phase sees complete turn context)
            const postResult = await this.responsePipeline.runPostSignalPhase(
                session, effectiveContext, historyEvents,
            );
            session = postResult.updatedSession;
            signalFirings.push(...postResult.firings);

            // Apply post-phase position directive as pendingDirective (Requirement 9.3)
            if (postResult.mergedDirective && hasDirectivePositionField(postResult.mergedDirective)) {
                session = { ...session, pendingDirective: postResult.mergedDirective };
            }

            await this.finalizeSession(session, effectiveContext);
            return {
                message: haltMessage,
                session,
                toolCalls: undefined,
                isFlowComplete: false,
                executedSteps: [],
                stoppedReason: signalHaltReply ? 'reply' : 'halt',
                triggeredSignals: signalFirings.length > 0 ? signalFirings as unknown as SignalFiring<unknown, TData>[] : undefined,
            };
        }

        let message: string;
        let toolCalls: Array<{ toolName: string; arguments: Record<string, unknown> }> | undefined = undefined;
        let executedSteps: StepRef[] | undefined;
        let stoppedReason: StoppedReason | undefined;
        let appliedInstructions: AppliedInstruction[] | undefined;



        if (selectedFlow && !isFlowComplete) {
            // AUTO-CHAIN: Walk consecutive auto-steps before any LLM work.
            // If the current step is auto, the executor advances through it (and any
            // subsequent auto-steps) until an interactive step or terminal condition.
            let resolvedStep = selectedStep;
            const currentStepInstance = session.currentStep
                ? selectedFlow.getStep(session.currentStep.id)
                : selectedStep;

            if (currentStepInstance?.auto) {
                const autoChainExecutor = new AutoChainExecutor<TContext, TData>({
                    maxAutoStepsPerTurn: this.agent.maxAutoStepsPerTurn,
                });
                const autoResult: AutoChainResult<TContext, TData> = await autoChainExecutor.run({
                    session,
                    context: effectiveContext,
                    flow: selectedFlow,
                });

                session = autoResult.session;

                // Handle halt: emit verbatim reply, persist, return — no LLM call.
                if (autoResult.stoppedReason === 'halt') {
                    message = autoResult.mergedDirective?.reply || '';
                    stoppedReason = 'halt';
                    executedSteps = [];

                    await this.finalizeSession(session, effectiveContext);
                    return {
                        message,
                        session,
                        toolCalls: undefined,
                        isFlowComplete: false,
                        executedSteps,
                        stoppedReason,
                    };
                }

                // Handle flow completion or cross-flow redirect from auto-chain.
                // The auto-chain ended without resolving to an interactive step.
                // Possible reasons: last_step (no successor), completed (explicit
                // complete directive), or goto (cross-flow redirect).
                if (autoResult.stoppedReason === 'last_step' || autoResult.stoppedReason === 'completed' || autoResult.stoppedReason === 'goto') {
                    logger.debug(`[ResponseModal] Auto-chain ended with ${autoResult.stoppedReason}`);
                    session = await this.applyFlowCompletion({
                        selectedFlow,
                        session,
                        context: effectiveContext,
                        history,
                    });

                    await this.finalizeSession(session, effectiveContext);
                    return {
                        message: '',
                        session,
                        toolCalls: undefined,
                        isFlowComplete: true,
                        executedSteps: [],
                        stoppedReason: autoResult.stoppedReason,
                    };
                }

                // Normal case: auto-chain resolved to an interactive step.
                resolvedStep = autoResult.resolvedStep;
            }

            // SINGLE STEP EXECUTION: Process the resolved interactive step.
            // The auto-chain (if it ran) already walked auto-steps. Only the
            // interactive step remains for the LLM call.
            const result = await this.processFlowResponse({
                selectedFlow,
                selectedStep: resolvedStep,
                responseDirectives,
                session,
                history,
                context: effectiveContext,
                historyEvents,
                signal,
                // Propagate signal pre-directive's appendPrompt for this turn's LLM call (Requirement 8.4)
                transientAppendage: signalPreDirective?.appendPrompt,
                // Merge signal pre-directive (halt/reply/injectTools) into the pre-LLM bus
                mergedPreDirective: signalPreDirective,
            });

            message = result.message;
            toolCalls = result.toolCalls;
            session = result.session;
            appliedInstructions = result.appliedInstructions;

            // Track executed step for single-step execution
            if (resolvedStep) {
                executedSteps = [{
                    id: resolvedStep.id,
                    flowId: selectedFlow.id,
                }];
            }
            // Use stoppedReason from processFlowResponse if set (halt/reply),
            // otherwise default to 'needs_input' for normal LLM responses.
            stoppedReason = result.stoppedReason || 'needs_input';

        } else if (isFlowComplete && selectedFlow) {
            // Flow completion path: pure state transition, no LLM call.
            // The framework emits no message of its own.
            // stoppedReason is 'last_step' because this completion was detected by
            // implicit terminus (no successor or all successors skipped), not by an
            // explicit `complete` directive.
            logger.debug(`[ResponseModal] Releasing session to idle for completed flow: ${selectedFlow.title}`);

            session = await this.applyFlowCompletion({
                selectedFlow,
                session,
                context: effectiveContext,
                history,
            });
            message = '';
            stoppedReason = 'last_step';
            executedSteps = [];

        } else {
            // Fallback: No flows defined, generate a simple response

            const fallbackResult = await this.generateFallbackResponse({
                history,
                context: effectiveContext,
                session,
            });

            message = fallbackResult.message;
            appliedInstructions = fallbackResult.appliedInstructions;

            // For fallback responses, set empty executedSteps and no stoppedReason
            // since there's no flow/step execution happening
            executedSteps = [];
            stoppedReason = undefined;
        }

        // POST-SIGNAL PHASE (Requirement 9.1, 9.2, 9.3, 9.4)
        // Runs after finalize/onComplete and before session persistence.
        // Post-phase signals see the complete turn result: assistant message in
        // history, collected data, tool results.
        const postResult = await this.responsePipeline.runPostSignalPhase(
            session, effectiveContext, historyEvents,
        );
        session = postResult.updatedSession;

        // Append post-phase firings to the accumulator (preserves fire order)
        signalFirings.push(...postResult.firings);

        // Requirement 9.3: Post-phase position directive sets session.pendingDirective
        // (no mid-turn re-entry per D6 decision). Pre-LLM-only fields are already
        // dropped inside runPostSignalPhase per Phase 4.5.
        if (postResult.mergedDirective && hasDirectivePositionField(postResult.mergedDirective)) {
            session = { ...session, pendingDirective: postResult.mergedDirective };
        }

        // Ensure response structure completeness (Requirement 8.1, 8.2, 8.3)
        // - executedSteps: array of steps executed (empty array if none)
        // - stoppedReason: why execution stopped (undefined for fallback)
        // - session.currentStep: reflects final step position
        return {
            message,
            session,
            toolCalls,
            isFlowComplete: isFlowComplete,
            executedSteps: executedSteps || [],
            stoppedReason,
            appliedInstructions,
            triggeredSignals: signalFirings.length > 0 ? signalFirings as unknown as SignalFiring<unknown, TData>[] : undefined,
        };
    }

    /**
       * Execute prepare function for current step if available
       * @private
       */
    private async executeStepPrepare(session: SessionState<TData>, context: TContext): Promise<void> {
        if (session.currentFlow && session.currentStep) {
            const currentFlow = this.agent.getFlows().find(
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
     * Execute finalize function for current step if available
     * @private
     */
    private async executeStepFinalize(session: SessionState<TData>, context: TContext): Promise<void> {
        if (session.currentFlow && session.currentStep) {
            const currentFlow = this.agent.getFlows().find(
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
     * Process flow response with unified tool execution and data collection
     * @private
     */
    private async processFlowResponse(params: {
        selectedFlow: Flow<TContext, TData>;
        selectedStep?: Step<TContext, TData>;
        responseDirectives?: string[];
        session: SessionState<TData>;
        history: HistoryItem[];
        context: TContext;
        historyEvents: Event[];
        signal?: AbortSignal;
        /**
         * Per-turn transient appendage from merged PreDirective.appendPrompt.
         * Fresh every turn, never cached, never persisted.
         */
        transientAppendage?: string[];
        /**
         * Merged PreDirective from the directive bus's pre-LLM phase drain.
         * When `halt: true`, the LLM call is skipped entirely.
         */
        mergedPreDirective?: PreDirective<TContext, TData>;
    }): Promise<{
        message: string;
        toolCalls?: Array<{ toolName: string; arguments: Record<string, unknown> }>;
        session: SessionState<TData>;
        appliedInstructions?: AppliedInstruction[];
        stoppedReason?: StoppedReason;
    }> {
        const { selectedFlow, selectedStep, responseDirectives, history, context, historyEvents, signal, transientAppendage, mergedPreDirective } = params;
        let session = params.session;

        // Determine next step
        let nextStep: Step<TContext, TData>;
        if (selectedStep) {
            nextStep = selectedStep;
        } else {
            // Determine current step from session if we're already in this flow
            const isInSameFlow = session.currentFlow?.id === selectedFlow.id;
            const currentStep = isInSameFlow && session.currentStep
                ? selectedFlow.getStep(session.currentStep.id)
                : undefined;

            logger.debug(`[ResponseModal] Step determination: flow match=${isInSameFlow}, currentFlow=${session.currentFlow?.id}, selectedFlow=${selectedFlow.id}, currentStep=${currentStep?.id || 'none'}`);

            // STEP 1 (Algorithm 1): branches win over linear chain
            if (currentStep?.branches && currentStep.branches.length > 0) {
                const branchResult = await this.responsePipeline.evaluateStepBranches(
                    currentStep, selectedFlow, session, context
                );
                if (branchResult) {
                    if (branchResult.nextStep) {
                        nextStep = branchResult.nextStep;
                        session = branchResult.session;
                    } else {
                        // Flow transition or completion — no local step to render
                        // Return empty message with updated session; caller handles flow transition
                        return { message: '', session: branchResult.session };
                    }
                }
            }

            if (!nextStep!) {
                // Get candidate steps based on current position in the flow
                const flowRouter = this.agent.getFlowRouter();
                const candidates = await flowRouter.getCandidateStepsWithConditions(
                    selectedFlow,
                    currentStep, // Pass current step instead of undefined to maintain progression
                    createTemplateContext({ data: session.data, session, context })
                );

                logger.debug(`[ResponseModal] Found ${candidates.length} candidate steps${currentStep ? ' from current step ' + currentStep.id : ' (new flow entry)'}`);

                if (candidates.length > 0) {
                    nextStep = candidates[0].step;
                    logger.debug(`[ResponseModal] Using first valid step: ${nextStep.id}${currentStep ? ' (progressing from ' + currentStep.id + ')' : ' for new flow'}`);
                } else {
                    // Fallback to initial step even if it should be skipped
                    nextStep = selectedFlow.initialStep;
                    logger.warn(`[FlowConfigurationError] No valid steps found: all candidates were skipped in flow. Falling back to initial step "${nextStep.id}". Review step skip conditions.`);
                }
            }
        }

        // Update session with next step
        // If the next step has requires fields that are missing, stay at the previous step
        if (nextStep.requires && nextStep.requires.length > 0) {
            const sessionData = session.data || {};
            const missingRequires = nextStep.requires.filter(
                field => (sessionData as Record<string, unknown>)[String(field)] === undefined
            );
            if (missingRequires.length > 0) {
                const warning = `[FlowConfigurationError] Cannot advance to step "${nextStep.description || nextStep.id}": ` +
                    `missing required fields [${missingRequires.join(', ')}]. Staying at current step. Ensure preceding steps collect these fields.`;
                logger.warn(warning);
                console.warn(warning);
                // Stay at the current step - don't enter the next one
                const currentStepId = session.currentStep?.id;
                if (currentStepId) {
                    const currentStepInstance = selectedFlow.getStep(currentStepId);
                    if (currentStepInstance) {
                        nextStep = currentStepInstance;
                        logger.debug(`[ResponseModal] Staying at current step: ${nextStep.id} due to missing requires`);
                    }
                }
            } else {
                session = enterStep(session, nextStep.id, nextStep.description);
                logger.debug(`[ResponseModal] Entered step: ${nextStep.id}`);
            }
        } else {
            session = enterStep(session, nextStep.id, nextStep.description);
            logger.debug(`[ResponseModal] Entered step: ${nextStep.id}`);
        }

        // Build response schema for this flow (with collect fields from step)
        const responseSchema = this.responseEngine.responseSchemaForFlow(selectedFlow, nextStep, this.agent.schema);

        // ── HALT SHORT-CIRCUIT (Requirement 2.5, 2.6, 2.7) ──────────────────────
        // After pre-LLM emissions are merged, if `halt: true` then skip the LLM
        // call entirely. The behavior depends on whether `reply` is also set.
        if (mergedPreDirective?.halt) {
            if (mergedPreDirective.reply) {
                // halt + reply: emit the reply as the assistant message
                logger.debug(`[ResponseModal] Halt with reply — skipping LLM call for step ${nextStep.id}`);
                return { message: mergedPreDirective.reply, session, stoppedReason: 'reply' };
            } else {
                // halt without reply: emit empty assistant content
                logger.debug(`[ResponseModal] Halt without reply — skipping LLM call for step ${nextStep.id}`);
                return { message: '', session, stoppedReason: 'halt' };
            }
        }

        // ── STEP.REPLY SHORT-CIRCUIT (Requirement 25.1–25.7, 17.9) ──────────────
        // A step with `reply` set emits a verbatim template response without LLM.
        // onEnter and prepare have already fired normally at this point.
        // If prepare returned a PreDirective with `reply`, that overrides
        // the step-declared reply (last-emission-wins per Algorithm 4).
        if (nextStep.reply != null) {
            // Determine the effective reply: prepare-emitted reply wins over step-declared
            const effectiveReply = mergedPreDirective?.reply ?? await render(
                nextStep.reply,
                createTemplateContext({ data: session.data || {}, context, session })
            );
            logger.debug(`[ResponseModal] Step.reply — skipping LLM call for step ${nextStep.id}`);
            return { message: effectiveReply, session, stoppedReason: 'reply' };
        }

        // Transient appendage: per-turn slot from PreDirective.appendPrompt.
        // Fresh each turn, never cached, never persisted.
        // Wrapped in try/finally to ensure cleanup even on abnormal termination.
        let turnTransientAppendage: string[] | undefined = transientAppendage;
        try {
            // Build response prompt
            const { prompt: responsePrompt, appliedInstructions } = await this.responseEngine.buildResponsePrompt({
                flow: selectedFlow,
                currentStep: nextStep,
                rules: [],
                prohibitions: [],
                directives: responseDirectives,
                history: historyEvents,
                agentOptions: this.agent.getAgentOptions(),
                instructions: this.collectScopedInstructions(selectedFlow, nextStep),
                combinedTerms: this.agent.getTerms(),
                context,
                session,
                agentSchema: this.agent.schema,
                transientAppendage: turnTransientAppendage,
            });

            // Collect available tools for AI
            const availableTools = this.collectAvailableTools(selectedFlow, nextStep);

            // Generate message using AI provider
            const agentOptions = this.agent.getAgentOptions();
            const result = await agentOptions.provider.generateMessage({
                prompt: responsePrompt,
                history, // Use HistoryItem[] for AI provider
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
                selectedFlow,
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
            // Use follow-up structured data from tool loop when available, fall back to original result
            const dataSource = toolResult.structured
                ? { structured: toolResult.structured }
                : result;
            session = await this.collectDataFromResponse({ result: dataSource, selectedFlow, nextStep, session });

            return { message, toolCalls, session, appliedInstructions };
        } finally {
            // Drain the transient appendage at end of turn.
            // This ensures PreDirective.appendPrompt does not leak to subsequent
            // turns even when the turn terminates abnormally (error, abort, reject).
            turnTransientAppendage = undefined;
        }
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
            selectedFlow,
            selectedStep,
            responseDirectives,
            isFlowComplete,
            signal,
            signalFirings: preSignalFirings,
            signalPreDirective,
            signalHalted,
            signalHaltReply,
        } = responseContext;
        let session = initialSession;

        // Accumulator for signal firings across both phases (fire order)
        const signalFirings: SignalFiring<TContext, TData>[] = [...(preSignalFirings || [])];

        // Convert HistoryItem[] to Event[] for internal processing
        const historyEvents = historyToEvents(history);

        // ── SIGNAL HALT (Requirement 8.2) ─────────────────────────────────────
        if (signalHalted) {
            const haltMessage = signalHaltReply || '';
            // Run post-signal phase even on halt
            const postResult = await this.responsePipeline.runPostSignalPhase(
                session, effectiveContext, historyEvents,
            );
            session = postResult.updatedSession;
            signalFirings.push(...postResult.firings);

            if (postResult.mergedDirective && hasDirectivePositionField(postResult.mergedDirective)) {
                session = { ...session, pendingDirective: postResult.mergedDirective };
            }

            await this.finalizeSession(session, effectiveContext);
            yield {
                delta: haltMessage,
                accumulated: haltMessage,
                done: true,
                session,
                stoppedReason: haltMessage ? 'reply' : 'halt',
                executedSteps: [],
                triggeredSignals: signalFirings.length > 0 ? signalFirings as unknown as SignalFiring<unknown, TData>[] : undefined,
            } as AgentResponseStreamChunk<TData>;
            return;
        }

        // ── Determine the inner stream generator based on flow state ────────
        let innerStream: AsyncGenerator<AgentResponseStreamChunk<TData>>;

        if (selectedFlow && !isFlowComplete) {
            // AUTO-CHAIN: Walk consecutive auto-steps before any LLM work (streaming path).
            let resolvedStep = selectedStep;
            const currentStepInstance = session.currentStep
                ? selectedFlow.getStep(session.currentStep.id)
                : selectedStep;

            if (currentStepInstance?.auto) {
                const autoChainExecutor = new AutoChainExecutor<TContext, TData>({
                    maxAutoStepsPerTurn: this.agent.maxAutoStepsPerTurn,
                });
                const autoResult: AutoChainResult<TContext, TData> = await autoChainExecutor.run({
                    session,
                    context: effectiveContext,
                    flow: selectedFlow,
                });

                session = autoResult.session;

                // Handle halt: emit verbatim reply as a single chunk, done.
                if (autoResult.stoppedReason === 'halt') {
                    const reply = autoResult.mergedDirective?.reply || '';
                    await this.finalizeSession(session, effectiveContext);
                    yield {
                        delta: reply,
                        accumulated: reply,
                        done: true,
                        session,
                        stoppedReason: 'halt',
                        executedSteps: [],
                        triggeredSignals: signalFirings.length > 0 ? signalFirings as unknown as SignalFiring<unknown, TData>[] : undefined,
                    } as AgentResponseStreamChunk<TData>;
                    return;
                }

                // Handle flow completion or cross-flow redirect from auto-chain.
                if (autoResult.stoppedReason === 'last_step' || autoResult.stoppedReason === 'completed' || autoResult.stoppedReason === 'goto') {
                    innerStream = this.streamFlowCompletion({
                        selectedFlow,
                        session,
                        context: effectiveContext,
                        history,
                        historyEvents,
                        stoppedReason: autoResult.stoppedReason,
                    });
                } else {
                    // Normal case: resolved to an interactive step.
                    resolvedStep = autoResult.resolvedStep;
                    innerStream = this.processFlowStreamingResponse({
                        selectedFlow,
                        selectedStep: resolvedStep,
                        responseDirectives,
                        session,
                        history,
                        context: effectiveContext,
                        historyEvents,
                        signal,
                        transientAppendage: signalPreDirective?.appendPrompt,
                        mergedPreDirective: signalPreDirective,
                    });
                }
            } else {
                // No auto-step: directly stream the interactive step.
                innerStream = this.processFlowStreamingResponse({
                    selectedFlow,
                    selectedStep: resolvedStep,
                    responseDirectives,
                    session,
                    history,
                    context: effectiveContext,
                    historyEvents,
                    signal,
                    // Propagate signal pre-directive's appendPrompt for this turn's LLM call
                    transientAppendage: signalPreDirective?.appendPrompt,
                    mergedPreDirective: signalPreDirective,
                });
            }

        } else if (isFlowComplete && selectedFlow) {
            // Handle flow completion streaming — implicit terminus (no successor
            // or all successors skipped), so the reason is 'last_step'.
            innerStream = this.streamFlowCompletion({
                selectedFlow,
                session,
                context: effectiveContext,
                history,
                historyEvents,
                stoppedReason: 'last_step',
            });

        } else {
            // Fallback: No flows defined, stream a simple response
            innerStream = this.streamFallbackResponse({
                history,
                context: effectiveContext,
                session,
            });
        }

        // ── Intercept the inner stream to run post-signal phase on the final chunk ──
        // This mirrors the non-streaming path: post-phase runs after finalize/onComplete
        // and before session persistence, attaching triggeredSignals to the final chunk
        // (Requirement 11.2).
        for await (const chunk of innerStream!) {
            if (chunk.done) {
                // Run post-signal phase on final chunk (Requirement 9.1, 9.2)
                const postResult = await this.responsePipeline.runPostSignalPhase(
                    chunk.session || session, effectiveContext, historyEvents,
                );
                let finalSession = postResult.updatedSession;
                signalFirings.push(...postResult.firings);

                // Requirement 9.3: Post-phase position directive sets session.pendingDirective
                if (postResult.mergedDirective && hasDirectivePositionField(postResult.mergedDirective)) {
                    finalSession = { ...finalSession, pendingDirective: postResult.mergedDirective };
                }

                yield {
                    ...chunk,
                    session: finalSession,
                    triggeredSignals: signalFirings.length > 0 ? signalFirings as unknown as SignalFiring<unknown, TData>[] : undefined,
                } as AgentResponseStreamChunk<TData>;
            } else {
                yield chunk;
            }
        }
    }

    /**
     * Process flow streaming response with unified tool execution and data collection
     * @private
     */
    private async *processFlowStreamingResponse(params: {
        selectedFlow: Flow<TContext, TData>;
        selectedStep?: Step<TContext, TData>;
        responseDirectives?: string[];
        session: SessionState<TData>;
        history: HistoryItem[];
        context: TContext;
        historyEvents: Event[];
        signal?: AbortSignal;
        /**
         * Per-turn transient appendage from merged PreDirective.appendPrompt.
         * Fresh every turn, never cached, never persisted.
         */
        transientAppendage?: string[];
        /**
         * Merged PreDirective from the directive bus's pre-LLM phase drain.
         * When `halt: true`, the LLM call is skipped entirely.
         */
        mergedPreDirective?: PreDirective<TContext, TData>;
    }): AsyncGenerator<AgentResponseStreamChunk<TData>> {
        const { selectedFlow, selectedStep, responseDirectives, history, context, historyEvents, signal, transientAppendage, mergedPreDirective } = params;
        let session = params.session;

        // Determine next step (same logic as non-streaming)
        let nextStep: Step<TContext, TData>;
        if (selectedStep) {
            nextStep = selectedStep;
        } else {
            // Determine current step from session if we're already in this flow
            const currentStep = session.currentFlow?.id === selectedFlow.id && session.currentStep
                ? selectedFlow.getStep(session.currentStep.id)
                : undefined;

            // STEP 1 (Algorithm 1): branches win over linear chain
            if (currentStep?.branches && currentStep.branches.length > 0) {
                const branchResult = await this.responsePipeline.evaluateStepBranches(
                    currentStep, selectedFlow, session, context
                );
                if (branchResult) {
                    // Branch resolved — yield a final chunk with the updated session and return
                    if (branchResult.nextStep) {
                        session = branchResult.session;
                        nextStep = branchResult.nextStep;
                    } else {
                        // Flow transition or completion — no step to render
                        yield {
                            delta: '',
                            accumulated: '',
                            done: true,
                            session: branchResult.session,
                        } as AgentResponseStreamChunk<TData>;
                        return;
                    }
                }
            }

            if (!nextStep!) {
                // Get candidate steps based on current position in the flow
                const flowRouter = this.agent.getFlowRouter();
                const candidates = await flowRouter.getCandidateStepsWithConditions(
                    selectedFlow,
                    currentStep, // Pass current step instead of undefined to maintain progression
                    createTemplateContext({ data: session.data, session, context })
                );

                if (candidates.length > 0) {
                    nextStep = candidates[0].step;
                    logger.debug(`[ResponseModal] Using first valid step: ${nextStep.id}${currentStep ? ' (progressing from ' + currentStep.id + ')' : ' for new flow'}`);
                } else {
                    nextStep = selectedFlow.initialStep;
                    logger.warn(`[FlowConfigurationError] No valid steps found: all candidates were skipped in flow. Falling back to initial step "${nextStep.id}". Review step skip conditions.`);
                }
            }
        }

        // Update session with next step
        // If the next step has requires fields that are missing, stay at the previous step
        if (nextStep.requires && nextStep.requires.length > 0) {
            const sessionData = session.data || {};
            const missingRequires = nextStep.requires.filter(
                field => (sessionData as Record<string, unknown>)[String(field)] === undefined
            );
            if (missingRequires.length > 0) {
                const warning = `[FlowConfigurationError] Cannot advance to step "${nextStep.description || nextStep.id}": ` +
                    `missing required fields [${missingRequires.join(', ')}]. Staying at current step. Ensure preceding steps collect these fields.`;
                logger.warn(warning);
                console.warn(warning);
                const currentStepId = session.currentStep?.id;
                if (currentStepId) {
                    const currentStepInstance = selectedFlow.getStep(currentStepId);
                    if (currentStepInstance) {
                        nextStep = currentStepInstance;
                        logger.debug(`[ResponseModal] Staying at current step: ${nextStep.id} due to missing requires`);
                    }
                }
            } else {
                session = enterStep(session, nextStep.id, nextStep.description);
                logger.debug(`[ResponseModal] Entered step: ${nextStep.id}`);
            }
        } else {
            session = enterStep(session, nextStep.id, nextStep.description);
            logger.debug(`[ResponseModal] Entered step: ${nextStep.id}`);
        }

        // Build response schema and prompt (same as non-streaming)
        const responseSchema = this.responseEngine.responseSchemaForFlow(selectedFlow, nextStep, this.agent.schema);

        // ── HALT SHORT-CIRCUIT (Requirement 2.5, 2.6, 2.7) ──────────────────────
        // After pre-LLM emissions are merged, if `halt: true` then skip the LLM
        // call entirely. Emit a single done chunk with the appropriate content.
        if (mergedPreDirective?.halt) {
            const reply = mergedPreDirective.reply || '';
            const reason: StoppedReason = mergedPreDirective.reply ? 'reply' : 'halt';
            logger.debug(`[ResponseModal] Halt (streaming) — skipping LLM call for step ${nextStep.id}, stoppedReason: ${reason}`);
            await this.finalizeSession(session, context);
            yield {
                delta: reply,
                accumulated: reply,
                done: true,
                session,
                stoppedReason: reason,
                executedSteps: [{ id: nextStep.id, flowId: selectedFlow.id }],
            } as AgentResponseStreamChunk<TData>;
            return;
        }

        // ── STEP.REPLY SHORT-CIRCUIT (Requirement 25.1–25.7, 17.9) ──────────────
        // A step with `reply` set emits a verbatim template response without LLM.
        // onEnter and prepare have already fired normally. If prepare returned
        // a PreDirective with `reply`, that overrides the step-declared reply.
        if (nextStep.reply != null) {
            const effectiveReply = mergedPreDirective?.reply ?? await render(
                nextStep.reply,
                createTemplateContext({ data: session.data || {}, context, session })
            );
            logger.debug(`[ResponseModal] Step.reply (streaming) — skipping LLM call for step ${nextStep.id}`);
            await this.finalizeSession(session, context);
            yield {
                delta: effectiveReply,
                accumulated: effectiveReply,
                done: true,
                session,
                stoppedReason: 'reply' as StoppedReason,
                executedSteps: [{ id: nextStep.id, flowId: selectedFlow.id }],
            } as AgentResponseStreamChunk<TData>;
            return;
        }

        // Transient appendage: per-turn slot from PreDirective.appendPrompt.
        // Fresh each turn, never cached, never persisted.
        // Wrapped in try/finally to ensure cleanup even on abnormal termination.
        let turnTransientAppendage: string[] | undefined = transientAppendage;
        try {
            const { prompt: responsePrompt, appliedInstructions } = await this.responseEngine.buildResponsePrompt({
                flow: selectedFlow,
                currentStep: nextStep,
                rules: [],
                prohibitions: [],
                directives: responseDirectives,
                history: historyEvents,
                agentOptions: this.agent.getAgentOptions(),
                instructions: this.collectScopedInstructions(selectedFlow, nextStep),
                combinedTerms: this.agent.getTerms(),
                context,
                session,
                agentSchema: this.agent.schema,
                transientAppendage: turnTransientAppendage,
            });

            // Collect available tools for AI
            const availableTools = this.collectAvailableTools(selectedFlow, nextStep);

            // Generate message stream using AI provider
            const agentOptions = this.agent.getAgentOptions();
            const stream = agentOptions.provider.generateMessageStream({
                prompt: responsePrompt,
                history, // Use HistoryItem[] for AI provider
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

                    const toolManager = this.getToolManager();

                    // Use concurrent execution for the initial batch of tool calls
                    if (toolManager && typeof toolManager.executeWithConcurrency === 'function') {
                        const toolCallRequests: ToolCallRequest[] = toolCalls.map((tc, i) => ({
                            id: `${tc.toolName}-${i}-${Date.now()}`,
                            toolName: tc.toolName,
                            arguments: tc.arguments,
                        }));

                        const historyEvents = historyToEvents(history);

                        try {
                            for await (const update of toolManager.executeWithConcurrency({
                                toolCalls: toolCallRequests,
                                context,
                                data: session.data,
                                history: historyEvents,
                                signal,
                                flow: selectedFlow,
                                step: nextStep,
                            })) {
                                // Apply context updates
                                if (update.contextUpdate) {
                                    try {
                                        await this.agent.updateContext(update.contextUpdate as Partial<TContext>);
                                    } catch (error) {
                                        logger.error(`[ResponseModal] Failed to update context from concurrent tool:`, error);
                                    }
                                }

                                // Apply data updates
                                if (update.dataUpdate) {
                                    try {
                                        const updateDataMethod = this.agent.getUpdateDataMethod();
                                        session = await updateDataMethod(session, update.dataUpdate);
                                    } catch (error) {
                                        logger.error(`[ResponseModal] Failed to update data from concurrent tool:`, error);
                                    }
                                }

                                // Yield progress updates immediately
                                if (update.progress) {
                                    yield {
                                        delta: '',
                                        accumulated: chunk.accumulated,
                                        done: false,
                                        session,
                                        toolCalls: undefined,
                                        isFlowComplete: false,
                                        metadata: { toolProgress: update.progress, toolCallId: update.toolCallId },
                                    };
                                }
                            }

                            logger.debug(`[ResponseModal] Concurrent tool execution completed for ${toolCallRequests.length} tools`);
                        } catch (error) {
                            logger.error(`[ResponseModal] Concurrent tool execution failed, falling back to sequential:`, error);
                            // Fall back to the unified tool loop on failure
                            const toolResult = await this.executeUnifiedToolLoop({
                                toolCalls, context, session, history, selectedFlow,
                                responsePrompt, availableTools, responseSchema, signal,
                            });
                            session = toolResult.session;
                            toolCalls = toolResult.finalToolCalls;
                        }
                    } else {
                        // Fallback: no ToolManager or no executeWithConcurrency, use unified tool loop
                        const toolResult = await this.executeUnifiedToolLoop({
                            toolCalls, context, session, history, selectedFlow,
                            responsePrompt, availableTools, responseSchema, signal,
                        });
                        session = toolResult.session;
                        toolCalls = toolResult.finalToolCalls;
                    }
                }

                // Extract collected data on final chunk
                if (chunk.done && chunk.structured && nextStep.collect) {
                    session = await this.collectDataFromResponse({
                        result: { structured: chunk.structured },
                        selectedFlow,
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
                    isFlowComplete: false,
                    executedSteps: chunk.done ? [{ id: nextStep.id, flowId: selectedFlow.id }] : undefined,
                    stoppedReason: chunk.done ? 'needs_input' : undefined,
                    metadata: chunk.metadata,
                    structured: chunk.structured,
                    appliedInstructions: chunk.done ? appliedInstructions : undefined,
                };
            }
        } finally {
            // Drain the transient appendage at end of turn.
            // This ensures PreDirective.appendPrompt does not leak to subsequent
            // turns even when the turn terminates abnormally (error, abort, reject).
            turnTransientAppendage = undefined;
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
                logger.debug(`[ResponseModal] Executing ${toolCalls.length} dynamic tool calls:`, toolCalls.map(tc => tc.toolName));

                for (const toolCall of toolCalls) {
                    const tool = this.findAvailableTool(toolCall.toolName, selectedFlow);
                    if (!tool) {
                        logger.warn(`[ToolExecutionError] Tool not found: "${toolCall.toolName}" is not registered in any scope. Skipping this tool call. Register the tool or check the tool name.`);
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

                        // Store the actual tool result data for history
                        toolResultsMap.set(toolCall.toolName, serializeToolResult(toolResult));
                        toolArgsMap.set(toolCall.toolName, toolCall.arguments);

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
            let followUpStructured: AgentStructuredResponse | undefined;

            while (hasToolCalls && toolLoopCount < MAX_TOOL_LOOPS) {
                toolLoopCount++;
                logger.debug(`[ResponseModal] Starting tool loop ${toolLoopCount}/${MAX_TOOL_LOOPS} with ${toolCalls?.length || 0} tool calls`);

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
                const agentOptions = this.agent.getAgentOptions();
                const shouldProvideTools = toolLoopCount === 1;

                logger.debug(`[ResponseModal] Making follow-up AI call (loop ${toolLoopCount}):`, {
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
                        const tool = this.findAvailableTool(toolCall.toolName, selectedFlow);
                        if (!tool) {
                            logger.warn(`[ToolExecutionError] Tool not found in follow-up: "${toolCall.toolName}" is not registered in any scope. Skipping this tool call. Register the tool or check the tool name.`);
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
                                    history: historyToEvents(updatedHistory), // Convert to Event[] for tool execution
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

                            // Store the follow-up tool result for potential next loop iteration
                            toolResultsMap.set(toolCall.toolName, serializeToolResult(toolResult));
                            toolArgsMap.set(toolCall.toolName, toolCall.arguments);

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
                    followUpStructured = followUpResult.structured;
                    toolCalls = followUpToolCalls || [];
                    break;
                }
            }

            if (toolLoopCount >= MAX_TOOL_LOOPS) {
                logger.warn(`[ResponseGenerationError] Tool loop limit reached: ${toolLoopCount} iterations hit the cap (${MAX_TOOL_LOOPS}). Stopping tool execution. Increase MAX_TOOL_LOOPS or reduce recursive tool calls.`);
            }

            // If tools were executed but no final text message was produced,
            // make one more LLM call to generate a proper text response from tool results.
            // This prevents the original tool-invocation message (e.g. "Let me check...")
            // from being returned as the final user-facing response.
            if (!finalMessage && toolLoopCount > 0) {
                logger.debug(`[ResponseModal] No final message after tool loop, making additional LLM call for text response`);

                // Build tool result history from toolResultsMap which contains ALL
                // tool executions (initial + follow-up). We can't use `toolCalls` here
                // because it was reassigned to the (empty) follow-up tool calls when
                // the while loop broke out.
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
                const agentOptions = this.agent.getAgentOptions();

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

                    finalMessage = textResult.structured?.message || textResult.message;
                    if (textResult.structured) {
                        followUpStructured = textResult.structured;
                    }

                    logger.debug(`[ResponseModal] Generated final text response after tool loop:`, {
                        hasMessage: !!finalMessage,
                        messageLength: finalMessage?.length || 0,
                    });
                } catch (error) {
                    logger.error(`[ResponseModal] Failed to generate final text response after tool loop:`, error);
                    // finalMessage remains undefined; caller will use original message as fallback
                }
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
                structured: followUpStructured,
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
        selectedFlow?: Flow<TContext, TData>;
        nextStep?: Step<TContext, TData>;
        session: SessionState<TData>;
    }): Promise<SessionState<TData>> {
        try {
            const { result, selectedFlow, nextStep, session } = params;
            let updatedSession = session;

            // Extract collected data from final response (only for flow-based interactions)
            if (selectedFlow && result.structured) {
                try {
                    const collectedData: Record<string, unknown> = {};
                    // AgentStructuredResponse extends Record<string, unknown>, so we can safely access properties
                    const structuredData = result.structured;

                    // Collect ALL flow fields (required + optional) from structured response
                    const allFlowFields = new Set<string>();

                    // Add flow required fields
                    if (selectedFlow.requiredFields) {
                        selectedFlow.requiredFields.forEach(field => allFlowFields.add(String(field)));
                    }

                    // Add flow optional fields
                    if (selectedFlow.optionalFields) {
                        selectedFlow.optionalFields.forEach(field => allFlowFields.add(String(field)));
                    }

                    // Also include current step's collect fields (in case they're not in flow fields)
                    if (nextStep?.collect) {
                        nextStep.collect.forEach(field => allFlowFields.add(String(field)));
                    }

                    // Extract all available fields from structured response
                    for (const field of allFlowFields) {
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
     * Apply flow completion: release the session to idle state.
     *
     * This is a pure state transition. The framework emits **no message of
     * its own** at the completion boundary — every word delivered to the
     * user comes from a developer-defined step prompt. If the dev wants a
     * closing turn, they add a final interactive step with their own
     * `prompt`; the framework respects that step's natural LLM output.
     *
     * Behavior:
     * - Marks the active `flowHistory` entry as `completed: true` and
     *   stamps `exitedAt`.
     * - Evaluates `flow.onComplete` for an explicit follow-up transition.
     *   When set, populates `session.pendingDirective` (the next turn's
     *   pipeline applies it). When absent, the session is fully idle.
     * - Clears `currentFlow` and `currentStep` to `undefined`.
     * - Clears owned fields when the flow is `reentrant` so subsequent
     *   re-selections start from a clean state.
     *
     * Returns the updated session. Callers compose any reply text from
     * their own sources (an upstream LLM turn, a directive's `reply`, or
     * an empty string for silent completion).
     *
     * @private
     */
    private async applyFlowCompletion(params: {
        selectedFlow: Flow<TContext, TData>;
        session: SessionState<TData>;
        context: TContext;
        history: HistoryItem[];
    }): Promise<SessionState<TData>> {
        const { selectedFlow, session, context } = params;

        // 1) Evaluate onComplete first — needs the still-active session shape.
        const transitionConfig = await selectedFlow.evaluateOnComplete(
            { data: session.data },
            context,
        );

        // 2) Release to idle. If the flow is reentrant, scrub its owned
        //    fields so re-selection on a future turn starts clean. When
        //    onComplete fires we still go idle here — the next turn's
        //    pipeline applies the pendingDirective before any routing.
        const ownedFields = selectedFlow.reentrant
            ? [
                ...(selectedFlow.requiredFields ?? []),
                ...(selectedFlow.optionalFields ?? []),
            ]
            : undefined;

        let nextSession = completeCurrentFlow(session, {
            clearOwnedFields: ownedFields,
        });

        // 3) Wire pendingDirective when onComplete returned a target.
        if (transitionConfig) {
            const goToTarget = typeof transitionConfig.goTo === 'string'
                ? transitionConfig.goTo
                : transitionConfig.goTo?.flow;

            const targetFlow = goToTarget ? this.agent.getFlows().find(
                (r) =>
                    r.id === goToTarget ||
                    r.title === goToTarget,
            ) : undefined;

            if (targetFlow) {
                nextSession = {
                    ...nextSession,
                    pendingDirective: {
                        goTo: targetFlow.id,
                    },
                };
                logger.debug(
                    `[ResponseModal] Flow ${selectedFlow.title} completed with pending directive to: ${targetFlow.title}`,
                );
            } else if (goToTarget) {
                logger.warn(
                    `[FlowConfigurationError] onComplete target not found: flow "${selectedFlow.title}" completed but onComplete target "${goToTarget}" does not match any flow. ` +
                    `Fix the onComplete value to reference an existing flow id/title, or remove onComplete to release the session to idle.`,
                );
            }
        } else {
            logger.debug(
                `[ResponseModal] Flow ${selectedFlow.title} completed; session released to idle.`,
            );
        }

        return nextSession;
    }

    /**
     * Stream flow completion response
     * @private
     */
    /**
     * Stream a flow completion as a single terminal chunk.
     *
     * No LLM call is made. The framework no longer authors a farewell — the
     * completion path is a pure state transition. The chunk emits an empty
     * `delta` and a `done: true` flag with the idle session attached so
     * downstream consumers can finalize cleanly.
     *
     * If the developer wants closing copy in a streaming response, they
     * should add a final interactive step whose own LLM turn delivers it.
     *
     * @private
     */
    private async *streamFlowCompletion(params: {
        selectedFlow: Flow<TContext, TData>;
        session: SessionState<TData>;
        context: TContext;
        history: HistoryItem[];
        historyEvents: Event[];
        stoppedReason?: StoppedReason;
        signal?: AbortSignal;
    }): AsyncGenerator<AgentResponseStreamChunk<TData>> {
        const { selectedFlow, context, history } = params;

        const session = await this.applyFlowCompletion({
            selectedFlow,
            session: params.session,
            context,
            history,
        });

        await this.finalizeSession(session, context);

        yield {
            delta: '',
            accumulated: '',
            done: true,
            session,
            toolCalls: undefined,
            isFlowComplete: true,
            executedSteps: [],
            stoppedReason: params.stoppedReason ?? 'completed',
        };
    }

    /**
     * Generate fallback response when no flows are available
     * @private
     */
    private async generateFallbackResponse(params: {
        history: HistoryItem[];
        context: TContext;
        session: SessionState<TData>;
        signal?: AbortSignal;
    }): Promise<{ message: string; appliedInstructions?: AppliedInstruction[] }> {
        const { history, context, session, signal } = params;

        logger.debug(`[ResponseModal] No flow selected, generating basic response`);

        // Build basic response prompt without flow context
        const { prompt: fallbackPrompt, appliedInstructions } = await this.responseEngine.buildFallbackPrompt({
            agentOptions: this.agent.getAgentOptions(),
            terms: this.agent.getTerms(),
            instructions: this.collectScopedInstructions(),
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

        return { message: result.structured?.message || result.message, appliedInstructions };
    }

    /**
     * Stream fallback response when no flows are available
     * @private
     */
    private async *streamFallbackResponse(params: {
        history: HistoryItem[];
        context: TContext;
        session: SessionState<TData>;
        signal?: AbortSignal;
    }): AsyncGenerator<AgentResponseStreamChunk<TData>> {
        const { history, context, session, signal } = params;

        const { prompt: fallbackPrompt, appliedInstructions } = await this.responseEngine.buildFallbackPrompt({
            agentOptions: this.agent.getAgentOptions(),
            terms: this.agent.getTerms(),
            instructions: this.collectScopedInstructions(),
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
            // - executedSteps: empty for fallback (no flow/step execution)
            // - stoppedReason: undefined for fallback (no flow context)
            // - session.currentStep: unchanged (no step progression)
            yield {
                delta: chunk.delta,
                accumulated: chunk.accumulated,
                done: chunk.done,
                session,
                toolCalls: undefined,
                isFlowComplete: false,
                executedSteps: chunk.done ? [] : undefined,
                stoppedReason: undefined,
                metadata: chunk.metadata,
                structured: chunk.structured,
                appliedInstructions: chunk.done ? appliedInstructions : undefined,
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
        const currentSession = this.agent.currentSession;
        if (currentSession) {
            this.agent.currentSession = session;
        }
    }
    // ============================================================================
    // UTILITY METHODS - Helper methods for tool management and other utilities
    // ============================================================================


    /**
     * Find an available tool by name for the given flow using ToolManager
     * Delegates to ToolManager for unified tool resolution
     * @private
     */
    private findAvailableTool(
        toolName: string,
        flow?: Flow<TContext, TData>
    ): Tool<TContext, TData> | undefined {
        // Use ToolManager for unified tool resolution
        const toolManager = this.getToolManager();
        if (toolManager) {
            return toolManager.find(toolName, undefined, undefined, flow);
        }

        // Fallback to legacy resolution if ToolManager not available
        logger.warn(`[ResponseModal] ToolManager not available, using legacy tool resolution for: ${toolName}`);

        // Check flow-level tools first (if flow provided)
        if (flow) {
            const flowTool = flow
                .getTools()
                .find((tool: Tool<TContext, TData>) => tool.id === toolName || tool.id === toolName);
            if (flowTool) return flowTool;
        }

        // Fall back to agent-level tools
        const agentTools = this.agent.getTools();
        return agentTools.find(
            (tool) => tool.id === toolName || tool.id === toolName
        );
    }

    /**
     * Collect all available tools for the given flow and step context using ToolManager
     * Delegates to ToolManager for unified tool resolution and deduplication
     * @private
     */
    private collectAvailableTools(
        flow?: Flow<TContext, TData>,
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
            const availableTools = toolManager.getAvailable(undefined, step, flow);
            return availableTools.map((tool) => ({
                id: tool.id,
                name: tool.id || tool.id,
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

        // Add flow-level tools (these take precedence)
        if (flow) {
            flow.getTools().forEach((tool: Tool<TContext, TData>) => {
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
            name: tool.id || tool.id,
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
                const toolManager = this.getToolManager();
                if (toolManager) {
                    tool = toolManager.find(prepareOrFinalize, undefined, step, flow);
                } else {
                    // Fallback to legacy resolution if ToolManager not available
                    logger.warn(`[ResponseModal] ToolManager not available, using legacy tool resolution for prepare/finalize: ${prepareOrFinalize}`);

                    const availableTools = new Map<string, Tool<TContext, TData>>();

                    // Add agent-level tools
                    this.agent.getTools().forEach((t) => {
                        availableTools.set(t.id, t);
                    });

                    // Add flow-level tools
                    if (flow) {
                        flow.getTools().forEach((t: Tool<TContext, TData>) => {
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

}