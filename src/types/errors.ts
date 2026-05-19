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
