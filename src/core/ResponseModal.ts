/**
 * ResponseModal handles all response generation logic for the Agent
 * Provides both streaming and non-streaming response generation with unified logic
 */

import type {
    AgentOptions,
    AgentResponse,
    AgentResponseStreamChunk,
    History,
    SessionState,
    StepRef,
    HistoryItem,
    Event,
    AgentStructuredResponse,
    GenerateMessageStreamChunk,
    StoppedReason,
    ScopedInstructions,
    AppliedInstruction,
    Directive,
    Instruction,
    Term,
    StructuredSchema,
    CompactionOptions,
} from "../types";
import type { SignalFiring } from "../types/signals";
import type { SessionManager } from "./SessionManager";
import type { SignalProcessor } from "./SignalProcessor";
import type { PromptSectionCache } from "./PromptSectionCache";
import type { FlowRouter } from "./FlowRouter";
import type { PersistenceManager } from "./PersistenceManager";
import type { Flow } from "./Flow";
import { Step } from "./Step";
import { ResponseEngine } from "./ResponseEngine";
import { ResponsePipeline } from "./ResponsePipeline";
import { AutoChainExecutor, type AutoChainResult } from "./AutoChainExecutor";
import { StepLifecycle } from "./StepLifecycle";
import { SessionFinalizer } from "./SessionFinalizer";
import { ToolLoopExecutor } from "./ToolLoopExecutor";
import { SignalCoordinator } from "./SignalCoordinator";
import { ResponseGenerationError } from "./ResponseGenerationError";
import { cloneDeep, mergeCollected, logger, historyToEvents, completeCurrentFlow, render } from "../utils";
import { createTemplateContext } from "../utils/template";
import { StreamingMessageDecoder } from "../utils/streamingMessage";
import type { ToolManager } from "./ToolManager";

/**
 * The narrow surface ResponseModal (and its collaborators) need from the
 * Agent. Agent implements this; the response layer is constructible and
 * testable against this interface without a full Agent.
 */
export interface ResponseModalDeps<TContext = unknown, TData = unknown> {
    /** Session manager (history, live session, sync). */
    readonly session: SessionManager<TData>;
    /** Tool registry/resolver and single-tool executor. */
    readonly tool: ToolManager<TContext, TData>;
    readonly signalProcessor: SignalProcessor<TContext, TData> | undefined;
    readonly promptSectionCache: PromptSectionCache;
    readonly instructions: Instruction<TContext, TData>[];
    readonly schema: StructuredSchema | undefined;
    readonly maxAutoStepsPerTurn: number;
    /** The agent's live session reference (read and replaced at finalize). */
    currentSession: SessionState<TData> | undefined;
    getAgentOptions(): AgentOptions<TContext, TData>;
    getFlows(): Flow<TContext, TData>[];
    getTerms(): Term<TContext, TData>[];
    getFlowRouter(): FlowRouter<TContext, TData>;
    getContext(): Promise<TContext | undefined>;
    getCompactionOptions(): CompactionOptions | undefined;
    getPersistenceManager(): PersistenceManager<TData> | undefined;
    getUpdateDataMethod(): (
        session: SessionState<TData>,
        dataUpdate: Partial<TData>
    ) => Promise<SessionState<TData>>;
    updateContext(updates: Partial<TContext>): Promise<void>;
    updateCollectedData(updates: Partial<TData>): Promise<void>;
    /** Drain data staged before any session existed. */
    consumePendingData(): Partial<TData>;
}

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
    signalPreDirective?: Directive<TContext, TData>;
    /** Whether the pre-signal phase emitted a halt directive. */
    signalHalted?: boolean;
    /** Reply from a halt directive. */
    signalHaltReply?: string;
}

/**
 * The terminal shape of a turn, decided once by {@link ResponseModal.planTurn}
 * and rendered by either the streaming or non-streaming path. Abstracting the
 * decision (rather than the rendering) is what keeps the two paths in lockstep.
 */
type TurnOutcome<TContext, TData> =
    /** No LLM call — emit a verbatim message (signal halt or auto-chain halt). */
    | { kind: 'halt'; message: string; stoppedReason: StoppedReason; runPostPhase: boolean }
    /** Flow finished — pure state transition, no message of the framework's own. */
    | { kind: 'flowComplete'; selectedFlow: Flow<TContext, TData>; stoppedReason: StoppedReason }
    /** Render one interactive step via the LLM (the happy path). */
    | { kind: 'flowStep'; selectedFlow: Flow<TContext, TData>; step?: Step<TContext, TData>; responseDirectives?: string[]; signalPreDirective?: Directive<TContext, TData> }
    /** No flows defined — a simple unstructured response. */
    | { kind: 'fallback' };

/** The output of {@link ResponseModal.planTurn}: the outcome plus shared turn state. */
interface TurnPlan<TContext, TData> {
    outcome: TurnOutcome<TContext, TData>;
    /** Session after any auto-chain mutation. */
    session: SessionState<TData>;
    /** Live firing accumulator, seeded with pre-signal phase firings. */
    signalFirings: SignalFiring<TContext, TData>[];
    effectiveContext: TContext;
    history: HistoryItem[];
    historyEvents: Event[];
    signal?: AbortSignal;
}

/**
 * ResponseModal class that encapsulates all response generation logic
 * Uses unified approach for both streaming and non-streaming responses
 */
export class ResponseModal<TContext = unknown, TData = unknown> {
    private readonly responseEngine: ResponseEngine<TContext, TData>;
    private readonly responsePipeline: ResponsePipeline<TContext, TData>;
    private readonly stepLifecycle: StepLifecycle<TContext, TData>;
    private readonly sessionFinalizer: SessionFinalizer<TContext, TData>;
    private readonly toolLoopExecutor: ToolLoopExecutor<TContext, TData>;
    private readonly signalCoordinator: SignalCoordinator<TContext, TData>;

    constructor(
        private readonly agent: ResponseModalDeps<TContext, TData>,
        private readonly options?: ResponseModalOptions
    ) {
        // Initialize response engine
        this.responseEngine = new ResponseEngine<TContext, TData>(this.agent.promptSectionCache);

        // Signal pre/post phase orchestration
        this.signalCoordinator = new SignalCoordinator<TContext, TData>({
            getFlows: () => this.agent.getFlows(),
            signalProcessor: this.agent.signalProcessor,
        });

        // Initialize response pipeline with agent dependencies
        this.responsePipeline = new ResponsePipeline<TContext, TData>(
            this.agent.getAgentOptions(),
            () => this.agent.getFlows(), // Pass a function to get flows dynamically
            this.agent.getFlowRouter(),
            this.signalCoordinator,
            this.agent.updateCollectedData.bind(this.agent),
            () => this.agent.schema
        );

        // Step prepare/finalize execution, shared by the prepare phase and finalizer
        this.stepLifecycle = new StepLifecycle<TContext, TData>({
            getFlows: () => this.agent.getFlows(),
            toolManager: this.getToolManager(),
            updateContext: this.agent.updateContext.bind(this.agent),
            updateData: this.agent.updateCollectedData.bind(this.agent),
        });

        // Single owner of end-of-turn finalization (compaction + persistence + sync)
        this.sessionFinalizer = new SessionFinalizer<TContext, TData>({
            getCompactionOptions: () => this.agent.getCompactionOptions(),
            getPersistenceManager: () => this.agent.getPersistenceManager(),
            getAgentOptions: () => this.agent.getAgentOptions(),
            getCurrentSession: () => this.agent.currentSession,
            setCurrentSession: (session) => { this.agent.currentSession = session; },
            stepLifecycle: this.stepLifecycle,
            enableAutoSave: this.options?.enableAutoSave,
        });

        // Tool follow-up loop (run tools, ask the LLM again) + streaming batch execution
        this.toolLoopExecutor = new ToolLoopExecutor<TContext, TData>({
            toolManager: this.getToolManager(),
            getAgentOptions: () => this.agent.getAgentOptions(),
            updateContext: this.agent.updateContext.bind(this.agent),
            updateCollectedData: this.agent.updateCollectedData.bind(this.agent),
            updateSessionData: this.agent.getUpdateDataMethod(),
            maxToolLoops: this.options?.maxToolLoops,
        });

    }

    /**
     * Generate a non-streaming response using unified logic
     */
    async respond(params: RespondParams<TContext, TData>): Promise<AgentResponse<TData>> {
        // Snapshot the managed session so a failed turn has no in-memory effect:
        // without this, mutations made before the failure leave the live session
        // diverged from persisted state
        const preTurnSession = this.agent.session.current
            ? cloneDeep(this.agent.session.current)
            : undefined;
        try {
            // Use unified response preparation and routing
            const responseContext = await this.prepareUnifiedResponseContext(params);
            // Generate response using unified logic
            const result = await this.generateUnifiedResponse(responseContext);

            // Finalize session — the non-streaming turn's single finalize
            await this.sessionFinalizer.finalize(result.session!, responseContext.effectiveContext);

            return result;

        } catch (error) {
            if (preTurnSession) {
                this.agent.session.syncSession(preTurnSession);
            }
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
        // Same failed-turn rollback semantics as respond()
        const preTurnSession = this.agent.session.current
            ? cloneDeep(this.agent.session.current)
            : undefined;
        try {
            // Use unified response preparation and routing
            const responseContext = await this.prepareUnifiedResponseContext(params);

            // Generate streaming response using unified logic
            yield* this.generateUnifiedStreamingResponse(responseContext);

        } catch (error) {
            if (preTurnSession) {
                this.agent.session.syncSession(preTurnSession);
            }
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

        // Get or create session — session.data is the single source of truth,
        // so no agent-side data merge is needed
        const session = await this.agent.session.getOrCreate();

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

        // Get or create session — session.data is the single source of truth,
        // so no agent-side data merge is needed
        const session = await this.agent.session.getOrCreate();

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
     * Get the ToolManager instance from the agent.
     * @private
     */
    private getToolManager(): ToolManager<TContext, TData> {
        return this.agent.tool;
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

            // Use ResponsePipeline for context and session preparation; context
            // and session are passed explicitly — the pipeline holds no state
            let responseContext: {
                effectiveContext: TContext;
                session: SessionState<TData>;
                contextAfterHook?: TContext;
            };
            try {
                responseContext = await this.responsePipeline.prepareResponseContext({
                    contextOverride,
                    session: params.session ? cloneDeep(params.session) : undefined,
                    currentContext: await this.agent.getContext(),
                    currentSession: this.agent.currentSession,
                });
            } catch (error) {
                throw ResponseGenerationError.fromError(error, 'pipeline_context_preparation', params);
            }

            const { effectiveContext, contextAfterHook } = responseContext;
            let session = responseContext.session;

            // Sync the beforeRespond hook's context result back to the agent
            if (contextAfterHook !== undefined) {
                try {
                    await this.agent.updateContext(contextAfterHook as Partial<TContext>);
                } catch (error) {
                    throw ResponseGenerationError.fromError(error, 'context_update_from_pipeline', params, { contextAfterHook });
                }
            }

            // Apply data staged before any session existed (initialData,
            // pre-session updateCollectedData calls). Reading the live session's
            // data here would leak state across sessions when an explicit
            // session is passed, so only the staging buffer is merged.
            const stagedData = this.agent.consumePendingData();
            if (Object.keys(stagedData).length > 0) {
                try {
                    session = mergeCollected(session, stagedData);
                    logger.debug("[ResponseModal] Merged staged agent data into session:", stagedData);
                } catch (error) {
                    throw ResponseGenerationError.fromError(error, 'data_merging', params, { stagedData });
                }
            }

            // PHASE 1: PREPARE - Execute prepare function if current step has one
            try {
                await this.stepLifecycle.runPrepare(session, effectiveContext);
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
                signalPreDirective?: Directive<TContext, TData>;
                signalHalted?: boolean;
                signalHaltReply?: string;
            };
            try {
                routingResult = await this.responsePipeline.routeAndSelectStep({
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
     * Plan a turn: run signal-halt detection, the auto-chain walk, and flow/step
     * selection, collapsing them into a single {@link TurnOutcome}. This is the
     * shared decision spine for both the streaming and non-streaming paths — the
     * only logic that genuinely differs between them is how each *renders* the
     * outcome (await a value vs. yield chunks) and the leaf provider primitive it
     * uses. Centralizing the decision here is what keeps the two paths from
     * drifting (the class of bug behind the 2.4.x retry/empty fixes).
     *
     * The returned `session` reflects any auto-chain mutation; `signalFirings`
     * is seeded with the pre-signal phase firings and is the live accumulator the
     * post-phase tail appends to.
     * @private
     */
    private async planTurn(
        responseContext: ResponseContext<TContext, TData>
    ): Promise<TurnPlan<TContext, TData>> {
        const {
            effectiveContext,
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
        let session = responseContext.session;

        // Accumulator for signal firings across both phases (fire order)
        const signalFirings: SignalFiring<TContext, TData>[] = [...(preSignalFirings || [])];
        // Convert HistoryItem[] to Event[] for internal processing
        const historyEvents = historyToEvents(history);

        const base = { effectiveContext, history, historyEvents, signal, signalFirings };

        // ── SIGNAL HALT (Requirement 8.2) ─────────────────────────────────────
        // Pre-signal phase emitted halt → skip LLM call entirely. The post-signal
        // phase still runs (it sees the complete turn context).
        if (signalHalted) {
            const haltMessage = signalHaltReply || '';
            return {
                ...base, session,
                outcome: { kind: 'halt', message: haltMessage, stoppedReason: haltMessage ? 'reply' : 'halt', runPostPhase: true },
            };
        }

        if (selectedFlow && !isFlowComplete) {
            // AUTO-CHAIN: Walk consecutive auto-steps before any LLM work. If the
            // current step is auto, the executor advances through it (and any
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

                // Halt: emit the verbatim reply, no LLM call. Unlike signal halt,
                // the auto-chain halt is a hard short-circuit that does NOT run the
                // post-signal phase (preserved across both paths).
                if (autoResult.stoppedReason === 'halt') {
                    return {
                        ...base, session,
                        outcome: { kind: 'halt', message: autoResult.mergedDirective?.reply || '', stoppedReason: 'halt', runPostPhase: false },
                    };
                }

                // Flow completion or cross-flow redirect from auto-chain: the chain
                // ended without resolving to an interactive step (last_step: no
                // successor; completed: explicit complete; goto: cross-flow redirect).
                if (autoResult.stoppedReason === 'last_step' || autoResult.stoppedReason === 'completed' || autoResult.stoppedReason === 'goto') {
                    logger.debug(`[ResponseModal] Auto-chain ended with ${autoResult.stoppedReason}`);
                    return {
                        ...base, session,
                        outcome: { kind: 'flowComplete', selectedFlow, stoppedReason: autoResult.stoppedReason },
                    };
                }

                // Normal case: auto-chain resolved to an interactive step.
                resolvedStep = autoResult.resolvedStep;
            }

            return {
                ...base, session,
                outcome: { kind: 'flowStep', selectedFlow, step: resolvedStep, responseDirectives, signalPreDirective },
            };
        }

        if (isFlowComplete && selectedFlow) {
            // Flow completion path: pure state transition, no LLM call. The reason
            // is 'last_step' (implicit terminus — no successor or all skipped).
            logger.debug(`[ResponseModal] Releasing session to idle for completed flow: ${selectedFlow.title}`);
            return {
                ...base, session,
                outcome: { kind: 'flowComplete', selectedFlow, stoppedReason: 'last_step' },
            };
        }

        // Fallback: no flows defined, generate a simple response.
        return { ...base, session, outcome: { kind: 'fallback' } };
    }

    /**
     * The shared post-signal phase tail (Requirement 9.1–9.4). Runs after the
     * turn's message is known and before persistence, so post-phase signals see
     * the complete turn result (assistant message, collected data, tool results)
     * and can override the reply or wire a pendingDirective.
     *
     * `runPostPhase` is false only for the auto-chain halt short-circuit, which
     * deliberately bypasses the post-phase in both paths; that branch still
     * surfaces any pre-phase firings via `triggeredSignals`.
     * @private
     */
    private async applyTurnPostPhase(params: {
        session: SessionState<TData>;
        context: TContext;
        historyEvents: Event[];
        message: string;
        signalFirings: SignalFiring<TContext, TData>[];
        runPostPhase: boolean;
    }): Promise<{
        session: SessionState<TData>;
        message: string;
        replyOverridden: boolean;
        triggeredSignals?: SignalFiring<TContext, TData>[];
    }> {
        const { session, context, historyEvents, message, signalFirings, runPostPhase } = params;

        if (!runPostPhase) {
            return {
                session, message, replyOverridden: false,
                triggeredSignals: signalFirings.length > 0 ? signalFirings : undefined,
            };
        }

        const post = await this.signalCoordinator.applyPostPhase({ session, context, historyEvents, message });
        signalFirings.push(...post.firings);
        return {
            session: post.session,
            message: post.message,
            replyOverridden: post.replyOverridden ?? false,
            triggeredSignals: signalFirings.length > 0 ? signalFirings : undefined,
        };
    }

    /**
     * Unified response generation for non-streaming responses.
     * Renders the shared {@link planTurn} outcome by awaiting the leaf primitive
     * and running the shared post-phase tail; respond() owns the single finalize.
     * @private
     */
    private async generateUnifiedResponse(
        responseContext: ResponseContext<TContext, TData>
    ): Promise<AgentResponse<TData>> {
        const plan = await this.planTurn(responseContext);
        const { effectiveContext, history, historyEvents, signal, signalFirings } = plan;
        let session = plan.session;

        let message = '';
        let toolCalls: Array<{ toolName: string; arguments: Record<string, unknown> }> | undefined = undefined;
        let executedSteps: StepRef[] = [];
        let stoppedReason: StoppedReason | undefined;
        let isFlowComplete = false;
        let appliedInstructions: AppliedInstruction[] | undefined;
        let runPostPhase = true;

        switch (plan.outcome.kind) {
            case 'halt': {
                message = plan.outcome.message;
                stoppedReason = plan.outcome.stoppedReason;
                runPostPhase = plan.outcome.runPostPhase;
                break;
            }
            case 'flowComplete': {
                session = await this.applyFlowCompletion({
                    selectedFlow: plan.outcome.selectedFlow,
                    session,
                    context: effectiveContext,
                    history,
                });
                isFlowComplete = true;
                stoppedReason = plan.outcome.stoppedReason;
                break;
            }
            case 'flowStep': {
                const result = await this.processFlowResponse({
                    selectedFlow: plan.outcome.selectedFlow,
                    selectedStep: plan.outcome.step,
                    responseDirectives: plan.outcome.responseDirectives,
                    session,
                    history,
                    context: effectiveContext,
                    historyEvents,
                    signal,
                    // Propagate signal pre-directive's appendPrompt for this turn's LLM call (Requirement 8.4)
                    transientAppendage: plan.outcome.signalPreDirective?.appendPrompt,
                    // Merge signal pre-directive (halt/reply/injectTools) into the pre-LLM bus
                    mergedPreDirective: plan.outcome.signalPreDirective,
                });
                message = result.message;
                toolCalls = result.toolCalls;
                session = result.session;
                appliedInstructions = result.appliedInstructions;
                if (plan.outcome.step) {
                    executedSteps = [{ id: plan.outcome.step.id, flowId: plan.outcome.selectedFlow.id }];
                }
                // Use stoppedReason from processFlowResponse if set (halt/reply),
                // otherwise default to 'needs_input' for normal LLM responses.
                stoppedReason = result.stoppedReason || 'needs_input';
                break;
            }
            case 'fallback': {
                const fallbackResult = await this.generateFallbackResponse({
                    history,
                    context: effectiveContext,
                    session,
                    signal,
                });
                message = fallbackResult.message;
                appliedInstructions = fallbackResult.appliedInstructions;
                break;
            }
        }

        const tail = await this.applyTurnPostPhase({
            session, context: effectiveContext, historyEvents, message, signalFirings, runPostPhase,
        });

        return {
            message: tail.message,
            session: tail.session,
            toolCalls,
            isFlowComplete,
            executedSteps,
            stoppedReason,
            appliedInstructions,
            triggeredSignals: tail.triggeredSignals,
        };
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
         * Per-turn transient appendage from merged directive.appendPrompt.
         * Fresh every turn, never cached, never persisted.
         */
        transientAppendage?: string[];
        /**
         * Merged directive from the directive bus's pre-LLM phase drain.
         * When `halt: true`, the LLM call is skipped entirely.
         */
        mergedPreDirective?: Directive<TContext, TData>;
    }): Promise<{
        message: string;
        toolCalls?: Array<{ toolName: string; arguments: Record<string, unknown> }>;
        session: SessionState<TData>;
        appliedInstructions?: AppliedInstruction[];
        stoppedReason?: StoppedReason;
    }> {
        const { selectedFlow, selectedStep, responseDirectives, history, context, historyEvents, signal, transientAppendage, mergedPreDirective } = params;
        let session = params.session;

        // Resolve the step to render (branches win over linear chain; requires enforced)
        const stepResolution = await this.responsePipeline.resolveRenderStep({
            selectedFlow,
            selectedStep,
            session,
            context,
        });
        if (stepResolution.flowTransition) {
            // Flow transition or completion — no local step to render
            // Return empty message with updated session; caller handles flow transition
            return { message: '', session: stepResolution.session };
        }
        const nextStep = stepResolution.nextStep!;
        session = stepResolution.session;

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
        // If prepare returned a Directive with `reply`, that overrides
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

        // Transient appendage: per-turn slot from Directive.appendPrompt.
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
            const toolResult = await this.toolLoopExecutor.runLoop({
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
            // This ensures Directive.appendPrompt does not leak to subsequent
            // turns even when the turn terminates abnormally (error, abort, reject).
            turnTransientAppendage = undefined;
        }
    }

    /**
     * Unified streaming response generation.
     * Renders the shared {@link planTurn} outcome as a chunk stream and runs the
     * shared post-phase tail on the final chunk (finalizing exactly once).
     * @private
     */
    private async *generateUnifiedStreamingResponse(
        responseContext: ResponseContext<TContext, TData>
    ): AsyncGenerator<AgentResponseStreamChunk<TData>> {
        const plan = await this.planTurn(responseContext);
        const { effectiveContext, history, historyEvents, signal, signalFirings } = plan;
        const session = plan.session;

        // Build the inner chunk stream for the planned outcome. `runPostPhase` is
        // the single post-phase gate (false only for auto-chain halt).
        let innerStream: AsyncGenerator<AgentResponseStreamChunk<TData>>;
        let runPostPhase = true;

        switch (plan.outcome.kind) {
            case 'halt': {
                runPostPhase = plan.outcome.runPostPhase;
                innerStream = this.streamTerminalMessage({
                    message: plan.outcome.message,
                    stoppedReason: plan.outcome.stoppedReason,
                    session,
                });
                break;
            }
            case 'flowComplete': {
                innerStream = this.streamFlowCompletion({
                    selectedFlow: plan.outcome.selectedFlow,
                    session,
                    context: effectiveContext,
                    history,
                    historyEvents,
                    stoppedReason: plan.outcome.stoppedReason,
                });
                break;
            }
            case 'flowStep': {
                innerStream = this.processFlowStreamingResponse({
                    selectedFlow: plan.outcome.selectedFlow,
                    selectedStep: plan.outcome.step,
                    responseDirectives: plan.outcome.responseDirectives,
                    session,
                    history,
                    context: effectiveContext,
                    historyEvents,
                    signal,
                    transientAppendage: plan.outcome.signalPreDirective?.appendPrompt,
                    mergedPreDirective: plan.outcome.signalPreDirective,
                });
                break;
            }
            case 'fallback': {
                innerStream = this.streamFallbackResponse({
                    history,
                    context: effectiveContext,
                    session,
                    signal,
                });
                break;
            }
        }

        // ── Intercept the inner stream on the final chunk ──────────────────────
        // Mirrors the non-streaming tail: post-signal phase runs first (when
        // applicable), then the session is finalized exactly once, attaching
        // triggeredSignals to the final chunk (Requirement 11.2).
        for await (const chunk of innerStream) {
            if (chunk.done) {
                const tail = await this.applyTurnPostPhase({
                    session: chunk.session || session,
                    context: effectiveContext,
                    historyEvents,
                    message: chunk.accumulated,
                    signalFirings,
                    runPostPhase,
                });

                const accumulated = tail.message;
                const delta = tail.replyOverridden ? accumulated : chunk.delta;

                // Single streaming exit: finalize the post-phase session so
                // post-signal mutations (e.g. pendingDirective) are persisted.
                await this.sessionFinalizer.finalize(tail.session, effectiveContext);

                yield {
                    ...chunk,
                    delta,
                    accumulated,
                    session: tail.session,
                    triggeredSignals: tail.triggeredSignals,
                } as AgentResponseStreamChunk<TData>;
            } else {
                yield chunk;
            }
        }
    }

    /**
     * Emit a framework-authored message (a halt reply) as a single terminal
     * chunk, to flow through the shared post-phase tail like any other inner
     * stream. No LLM call, no provider text — so nothing to extract or finalize
     * here; the caller's tail owns post-phase + finalize.
     * @private
     */
    // eslint-disable-next-line @typescript-eslint/require-await -- yield-only async generator; must be `async *` to satisfy the AsyncGenerator return type the caller switches on
    private async *streamTerminalMessage(params: {
        message: string;
        stoppedReason: StoppedReason;
        session: SessionState<TData>;
    }): AsyncGenerator<AgentResponseStreamChunk<TData>> {
        yield {
            delta: params.message,
            accumulated: params.message,
            done: true,
            session: params.session,
            toolCalls: undefined,
            isFlowComplete: false,
            stoppedReason: params.stoppedReason,
            executedSteps: [],
        } as AgentResponseStreamChunk<TData>;
    }

    /**
     * Wrap a provider message stream so each chunk's `delta`/`accumulated` carry
     * clean message text instead of the raw structured-JSON wrapper. The single
     * point where streamed JSON is unwrapped — every streaming response variant
     * (flow step, fallback) consumes provider chunks through here, so consumers
     * and stored history never see `{"message":...}` fragments. `structured`,
     * `done`, and `metadata` pass through untouched.
     * @private
     */
    private async *decodeMessageStream(
        stream: AsyncGenerator<GenerateMessageStreamChunk<AgentStructuredResponse>>
    ): AsyncGenerator<GenerateMessageStreamChunk<AgentStructuredResponse>> {
        const decoder = new StreamingMessageDecoder();
        for await (const chunk of stream) {
            const clean = decoder.push(chunk.accumulated);
            yield { ...chunk, delta: clean.delta, accumulated: clean.message };
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
         * Per-turn transient appendage from merged directive.appendPrompt.
         * Fresh every turn, never cached, never persisted.
         */
        transientAppendage?: string[];
        /**
         * Merged directive from the directive bus's pre-LLM phase drain.
         * When `halt: true`, the LLM call is skipped entirely.
         */
        mergedPreDirective?: Directive<TContext, TData>;
    }): AsyncGenerator<AgentResponseStreamChunk<TData>> {
        const { selectedFlow, selectedStep, responseDirectives, history, context, historyEvents, signal, transientAppendage, mergedPreDirective } = params;
        let session = params.session;

        // Resolve the step to render (same logic as non-streaming)
        const stepResolution = await this.responsePipeline.resolveRenderStep({
            selectedFlow,
            selectedStep,
            session,
            context,
        });
        if (stepResolution.flowTransition) {
            // Flow transition or completion — no step to render
            yield {
                delta: '',
                accumulated: '',
                done: true,
                session: stepResolution.session,
            } as AgentResponseStreamChunk<TData>;
            return;
        }
        const nextStep = stepResolution.nextStep!;
        session = stepResolution.session;

        // Build response schema and prompt (same as non-streaming)
        const responseSchema = this.responseEngine.responseSchemaForFlow(selectedFlow, nextStep, this.agent.schema);

        // ── HALT SHORT-CIRCUIT (Requirement 2.5, 2.6, 2.7) ──────────────────────
        // After pre-LLM emissions are merged, if `halt: true` then skip the LLM
        // call entirely. Emit a single done chunk with the appropriate content.
        if (mergedPreDirective?.halt) {
            const reply = mergedPreDirective.reply || '';
            const reason: StoppedReason = mergedPreDirective.reply ? 'reply' : 'halt';
            logger.debug(`[ResponseModal] Halt (streaming) — skipping LLM call for step ${nextStep.id}, stoppedReason: ${reason}`);
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
        // a Directive with `reply`, that overrides the step-declared reply.
        if (nextStep.reply != null) {
            const effectiveReply = mergedPreDirective?.reply ?? await render(
                nextStep.reply,
                createTemplateContext({ data: session.data || {}, context, session })
            );
            logger.debug(`[ResponseModal] Step.reply (streaming) — skipping LLM call for step ${nextStep.id}`);
            yield {
                delta: effectiveReply,
                accumulated: effectiveReply,
                done: true,
                session,
                stoppedReason: 'reply',
                executedSteps: [{ id: nextStep.id, flowId: selectedFlow.id }],
            } as AgentResponseStreamChunk<TData>;
            return;
        }

        // Transient appendage: per-turn slot from Directive.appendPrompt.
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

            // Stream chunks with unified tool handling. decodeMessageStream gives
            // each chunk clean message text in delta/accumulated, so the non-done
            // deltas, the final accumulated, the post-phase message input, and the
            // assistant message stored by stream() are all clean — never the raw
            // JSON wrapper (matching the non-streaming structured.message extraction).
            for await (const chunk of this.decodeMessageStream(stream)) {
                let toolCalls: Array<{ toolName: string; arguments: Record<string, unknown> }> | undefined = undefined;
                // Final message/structured may be replaced by a forced post-tool
                // response (see runStreamingBatch / gap: tools-ran-but-no-text).
                let finalDelta = chunk.delta;
                let finalAccumulated = chunk.accumulated;
                let finalStructured = chunk.structured;

                // Extract tool calls from AI response on final chunk
                if (chunk.done && chunk.structured?.toolCalls) {
                    toolCalls = chunk.structured.toolCalls;

                    // Concurrent execution for the initial batch of tool calls,
                    // yielding tool-progress chunks as they arrive. The accumulated
                    // preamble is already clean text.
                    const batchResult = yield* this.toolLoopExecutor.runStreamingBatch({
                        toolCalls,
                        context,
                        session,
                        history,
                        selectedFlow,
                        step: nextStep,
                        accumulated: chunk.accumulated,
                        responsePrompt,
                        availableTools,
                        responseSchema,
                        signal,
                    });
                    session = batchResult.session;
                    toolCalls = batchResult.toolCalls;

                    // Prefer the post-tool follow-up structured for collection and
                    // emission whenever present — independent of whether a closing
                    // message was forced — matching the non-streaming path's
                    // `toolResult.structured ?? result` selection.
                    finalStructured = batchResult.structured ?? finalStructured;

                    // Tools ran but the model produced no result-aware text — use
                    // the forced closing message (already clean) so we never emit the
                    // bare preamble (or an empty message) as the final response. Its
                    // delta is the portion not already streamed as the preamble.
                    if (batchResult.finalMessage) {
                        finalAccumulated = batchResult.finalMessage;
                        finalDelta = batchResult.finalMessage.startsWith(chunk.accumulated)
                            ? batchResult.finalMessage.slice(chunk.accumulated.length)
                            : batchResult.finalMessage;
                    }
                }

                // Collect data on the final chunk for any flow step — flow
                // required/optional fields are valid targets even without a step
                // `collect` — preferring the post-tool follow-up structured so a
                // tool-driven turn harvests fields the model produced after tools.
                if (chunk.done && finalStructured) {
                    session = await this.collectDataFromResponse({
                        result: { structured: finalStructured },
                        selectedFlow,
                        nextStep,
                        session,
                    });
                }

                // Response structure completeness (Requirement 8.1, 8.2, 8.3)
                // - executedSteps: single step executed in this response
                // - stoppedReason: 'needs_input' for single-step execution (waiting for user input)
                // - session.currentStep: reflects the executed step
                yield {
                    delta: finalDelta,
                    accumulated: finalAccumulated,
                    done: chunk.done,
                    session,
                    toolCalls,
                    isFlowComplete: false,
                    executedSteps: chunk.done ? [{ id: nextStep.id, flowId: selectedFlow.id }] : undefined,
                    stoppedReason: chunk.done ? 'needs_input' : undefined,
                    metadata: chunk.metadata,
                    structured: finalStructured,
                    appliedInstructions: chunk.done ? appliedInstructions : undefined,
                };
            }
        } finally {
            // Drain the transient appendage at end of turn.
            // This ensures Directive.appendPrompt does not leak to subsequent
            // turns even when the turn terminates abnormally (error, abort, reject).
            turnTransientAppendage = undefined;
        }
    }

    /**
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

        // Decode the JSON wrapper to clean message text (same as the flow path).
        for await (const chunk of this.decodeMessageStream(stream)) {
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

    // ============================================================================
    // UTILITY METHODS - Helper methods for tool management and other utilities
    // ============================================================================


    /**
     * Collect all available tools for the given flow and step context.
     * Delegates to ToolManager for unified tool resolution and deduplication.
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
        const availableTools = this.getToolManager().getAvailable(undefined, step, flow);
        return availableTools.map((tool) => ({
            id: tool.id,
            name: tool.id,
            description: tool.description,
            parameters: tool.parameters,
        }));
    }

}
