/**
 * SessionFinalizer owns end-of-turn session finalization: deterministic
 * history compaction, persistence auto-save, the step `finalize` hook,
 * and syncing the finalized session back to the agent's live session.
 *
 * Every turn finalizes exactly once: the non-streaming path in
 * `respond()` after generation completes; the streaming path in the
 * final-chunk interception loop after the post-signal phase (so
 * post-phase session mutations are persisted), with only the
 * pre-routing signal/auto-chain halt chunks finalizing at their own
 * yield sites.
 */

import type { AgentOptions, SessionState } from "../types/index.js";
import type { CompactionOptions } from "../types/compaction.js";
import type { PersistenceManager } from "./PersistenceManager.js";
import type { StepLifecycle } from "./StepLifecycle.js";
import { flow } from "./flow-namespace.js";
import { CompactionEngine } from "./CompactionEngine.js";
import { boundConversationHistory, DEFAULT_MAX_HISTORY_MESSAGES, logger } from "../utils/index.js";

export class SessionFinalizer<TContext = unknown, TData = unknown> {
    constructor(
        private readonly deps: {
            getCompactionOptions: () => CompactionOptions | undefined;
            getPersistenceManager: () => PersistenceManager<TData> | undefined;
            getAgentOptions: () => AgentOptions<TContext, TData>;
            getCurrentSession: () => SessionState<TData> | undefined;
            setCurrentSession: (session: SessionState<TData>) => void;
            stepLifecycle: StepLifecycle<TContext, TData>;
            /** ResponseModalOptions.enableAutoSave (undefined means enabled). */
            enableAutoSave?: boolean;
        }
    ) { }

    /**
     * Handle session persistence and finalization.
     */
    async finalize(session: SessionState<TData>, context: TContext): Promise<void> {
        const agentOptions = this.deps.getAgentOptions();

        // Hard history bound — backstop when no compaction is configured (or
        // after it ran). Unbounded growth eventually bricks the thread at the
        // provider context limit.
        const historyCap = agentOptions.maxHistoryMessages ?? DEFAULT_MAX_HISTORY_MESSAGES;
        if (historyCap > 0 && session.history && session.history.length > historyCap) {
            const bounded = boundConversationHistory(session.history, historyCap);
            if (bounded !== session.history) {
                logger.warn(
                    `[SessionFinalizer] Session "${session.id}" history exceeded ${historyCap} entries ` +
                    `(${session.history.length}); trimmed the oldest. Configure compaction for ` +
                    `summarization instead of truncation, or raise maxHistoryMessages.`
                );
                session.history = bounded;
            }
        }

        // Deterministic compaction: runs on every finalize (not just addMessage)
        // so respond()-only callers get bounded history too
        const compactionOptions = this.deps.getCompactionOptions();
        if (compactionOptions && session.history && session.history.length > 0) {
            try {
                const result = await CompactionEngine.checkAndCompact(session.history, compactionOptions);
                if (result.strategy !== 'none') {
                    session.history = result.history;
                    logger.info(
                        `[SessionFinalizer] Compaction applied: strategy='${result.strategy}', ` +
                        `estimatedTokens=${result.estimatedTokens}, messagesCompacted=${result.messagesCompacted}`
                    );
                }
            } catch (error) {
                logger.warn("[SessionFinalizer] Compaction failed at finalize, continuing without compaction", error);
            }
        }

        // Execute finalize BEFORE persisting so its state writes (which now
        // land on this turn's session) are captured by the save below. A
        // control-flow directive returned by finalize queues on the session —
        // the pendingDirective applier applies it at the START of the next turn.
        let finalizeDirective;
        try {
            finalizeDirective = await this.deps.stepLifecycle.runFinalize(session, context);
        } catch (error) {
            logger.error("[SessionFinalizer] Step finalize hook failed:", error);
            throw error;
        }
        if (finalizeDirective) {
            flow.queuePending(session, finalizeDirective);
        }

        // Auto-save session step to persistence if configured
        const persistenceManager = this.deps.getPersistenceManager();
        if (
            persistenceManager &&
            session.id &&
            (this.deps.enableAutoSave !== false && agentOptions.persistence?.autoSave !== false)
        ) {
            await persistenceManager.saveSessionState(session.id, session);
            logger.debug(`[SessionFinalizer] Auto-saved session step to persistence: ${session.id}`);
        }

        // Update current session if we have one
        const currentSession = this.deps.getCurrentSession();
        if (currentSession) {
            this.deps.setCurrentSession(session);
        }
    }
}
