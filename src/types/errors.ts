/**
 * Typed error classes for @falai/agent.
 */

/**
 * Typed error for not-yet-implemented surface. Subclass of Error (not of
 * FlowConfigurationError) so handlers can distinguish "not yet built" from
 * "misconfigured".
 *
 * Thrown when a reserved option is set to a value that the current version
 * does not support (e.g. `routerMode: 'embedding'` in v2.0).
 */
export class NotImplementedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'NotImplementedError';
    }
}

/**
 * Normalized error codes for AI provider failures.
 *
 * Providers map their SDK/HTTP errors onto these codes so callers can
 * handle failures uniformly regardless of which provider is configured.
 */
export type ProviderErrorCode =
    | 'rate_limited'
    | 'overloaded'
    | 'auth'
    | 'invalid_request'
    | 'schema_rejected'
    | 'timeout'
    | 'network'
    | 'unknown';

/**
 * Normalized error thrown by AI providers for terminal failures — i.e.
 * after retries and backup models (if any) have been exhausted.
 *
 * The original SDK/HTTP error is preserved as `cause` for debugging and
 * provider-specific handling.
 */
export class ProviderError extends Error {
    constructor(
        public readonly code: ProviderErrorCode,
        public readonly provider: string,
        message: string,
        public readonly cause?: unknown,
    ) {
        super(message);
        this.name = 'ProviderError';
    }
}

/**
 * Thrown by the persistence layer when a session save carries a stale
 * `version` — i.e. another writer persisted the session after this one
 * loaded it (concurrent respond() calls, parallel webhooks, two tabs).
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
