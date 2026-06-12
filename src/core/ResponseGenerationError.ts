/**
 * Error type for response-generation failures, shared by the response
 * coordinator and its collaborators.
 */

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
