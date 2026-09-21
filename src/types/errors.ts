/**
 * Typed error classes for @falai/agent.
 */

/**
 * The normalized provider failure, and the kinds it comes in.
 *
 * v3 re-exports these from `@providerkit/core` rather than keeping a second
 * copy. The taxonomy is wider there — thirteen kinds named by what actually
 * fixes them, where this package had eight — so a caller can now tell an
 * exhausted balance from a per-minute throttle, a plan that never included the
 * API from a wrong key, and an outgrown context window from a bad request.
 *
 * Breaking: the kind lives on `error.kind`, not `error.code`, and the spellings
 * changed with the taxonomy (`rate_limited` is `rate`, `overloaded` is
 * `overload`, `invalid_request` splits into `invalid`, `context`, `model` and
 * `content`). `schema_rejected` is gone: nothing ever produced it.
 */
export { ProviderError } from "@providerkit/core";
export type { ErrorKind } from "@providerkit/core";

/**
 * Thrown by the persistence layer when a session save carries a stale
 * `version` — i.e. another writer persisted the session after this one
 * loaded it (concurrent turn() calls, parallel webhooks, two tabs).
 *
 * Handlers should reload the session and retry or surface the conflict.
 */
export class SessionConflictError extends Error {
    constructor(
        public readonly sessionId: string,
        public readonly expectedVersion: number,
        public readonly actualVersion: number | undefined,
    ) {
        super(
            `[SessionConflictError] Session "${sessionId}" was modified concurrently: ` +
            `expected version ${expectedVersion}, found ${actualVersion ?? 'none'}. ` +
            `Reload the session and retry the operation.`
        );
        this.name = 'SessionConflictError';
    }
}

/**
 * Thrown when a flow cannot run as written: an unknown field, action, event,
 * condition or step id, a duplicate or reserved step id, or a jump with no
 * way out. Raised at agent construction and by `validateFlow`.
 */
export class FlowConfigurationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'FlowConfigurationError';
    }
}
