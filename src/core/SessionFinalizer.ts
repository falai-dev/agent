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

import type { AgentOptions, SessionState } from "../types";
import type { CompactionOptions } from "../types/compaction";
import type { PersistenceManager } from "./PersistenceManager";
import type { StepLifecycle } from "./StepLifecycle";
import { CompactionEngine } from "./CompactionEngine";
import { logger } from "../utils";

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
        // Deterministic compaction: runs on every finalize (not just addMessage)
        // so respond()-only callers get bounded history too
        const compactionOptions = this.deps.getCompactionOptions();
        if (compactionOptions && session.history && session.history.length > 0) {
            try {
                const result = await CompactionEngine.checkAndCompact(session.history, compactionOptions);
                if (result.strategy !== 'none') {
                    session.history = result.history;
                    logger.info(
                        `[ResponseModal] Compaction applied: strategy='${result.strategy}', ` +
                        `estimatedTokens=${result.estimatedTokens}, messagesCompacted=${result.messagesCompacted}`
                    );
                }
            } catch (error) {
                logger.warn("[ResponseModal] Compaction failed at finalize, continuing without compaction", error);
            }
        }

        // Auto-save session step to persistence if configured
        const persistenceManager = this.deps.getPersistenceManager();
        const agentOptions = this.deps.getAgentOptions();
        if (
            persistenceManager &&
            session.id &&
            (this.deps.enableAutoSave !== false && agentOptions.persistence?.autoSave !== false)
        ) {
            await persistenceManager.saveSessionState(session.id, session);
            logger.debug(`[ResponseModal] Auto-saved session step to persistence: ${session.id}`);
        }

        // Execute finalize function
        await this.deps.stepLifecycle.runFinalize(session, context);

        // Update current session if we have one
        const currentSession = this.deps.getCurrentSession();
        if (currentSession) {
            this.deps.setCurrentSession(session);
        }
    }
}
