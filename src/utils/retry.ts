/**
 * Retry utility with exponential backoff
 */
import {logger} from './logger'

export interface RetryOptions<T> {
  operation: () => Promise<T>;
  maxRetries: number;
  delay: (attempt: number) => number;
  onRetry?: (attempt: number, error: unknown) => void;
  onFailure?: (error: unknown) => boolean;
}

export async function retry<T>(options: RetryOptions<T>): Promise<T> {
  const { operation, maxRetries, delay, onRetry, onFailure } = options;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error: unknown) {
      lastError = error;

      if (attempt === maxRetries) {
        const shouldRethrow = onFailure ? onFailure(lastError) : true;
        if (shouldRethrow) {
          throw lastError;
        }
        break;
      }

      if (onRetry) {
        onRetry(attempt, lastError);
      }

      const delayMs = delay(attempt);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  // eslint-disable-next-line @typescript-eslint/only-throw-error
  throw lastError ?? new Error("Operation failed");
}

export const withTimeoutAndRetry = async <T>(
  operation: () => Promise<T>,
  timeoutMs: number = 60000,
  maxRetries: number = 3,
  operationName: string = "AI operation"
): Promise<T> => {
  const createTimeoutOperation = () => async (): Promise<T> => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    try {
      const result = await Promise.race([
        operation(),
        new Promise<never>((_, reject) => {
          controller.signal.addEventListener("abort", () => {
            reject(new Error(`Operation timed out after ${timeoutMs}ms`));
          });
        }),
      ]);

      clearTimeout(timeoutId);
      return result;
    } catch (error: unknown) {
      clearTimeout(timeoutId);
      throw error;
    }
  };

  return retry<T>({
    operation: createTimeoutOperation(),
    maxRetries,
    delay: (attempt: number) => Math.min(1000 * Math.pow(2, attempt), 5000),
    onRetry: (attempt: number, error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(
        `[${operationName}] Failed attempt ${attempt + 1}:`,
        message
      );
      const delay = Math.min(1000 * Math.pow(2, attempt), 5000);
      logger.debug(`[${operationName}] Retrying in ${delay}ms...`);
      logger.debug(
        `[${operationName}] Attempt ${attempt + 2}/${maxRetries + 1}`
      );
    },
    onFailure: (_error: unknown) => {
      logger.error(`[${operationName}] All ${maxRetries + 1} attempts failed`);
      return true;
    },
  });
};

export interface StreamRetryOptions {
  /** Maximum number of retries after the first attempt. Defaults to 3. */
  maxRetries?: number;
  /** Backoff before the next attempt, in ms. Defaults to capped exponential. */
  delay?: (attempt: number) => number;
  /** Label used in retry logs. */
  operationName?: string;
}

/**
 * Streaming analog of {@link withTimeoutAndRetry}. Re-runs an async-generator
 * factory as long as it fails *before yielding its first chunk* — e.g. an
 * empty completion that throws "No response", or an error while establishing
 * the stream. Once any chunk has been yielded the stream is committed and
 * further errors propagate, so a retry can never double-emit deltas that the
 * consumer has already received.
 *
 * This mirrors the non-streaming path, where the provider throws on an empty
 * completion inside `withTimeoutAndRetry` and is retried on the same model
 * before the caller falls through to backup models.
 */
export async function* withStreamRetry<T>(
  factory: () => AsyncGenerator<T>,
  options: StreamRetryOptions = {}
): AsyncGenerator<T> {
  const {
    maxRetries = 3,
    delay = (attempt: number) => Math.min(1000 * Math.pow(2, attempt), 5000),
    operationName = "AI stream",
  } = options;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let yielded = false;
    try {
      for await (const chunk of factory()) {
        yielded = true;
        yield chunk;
      }
      return;
    } catch (error: unknown) {
      // Can't retry once deltas are out, and don't retry past the budget.
      if (yielded || attempt === maxRetries) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`[${operationName}] Failed attempt ${attempt + 1}:`, message);
      const delayMs = delay(attempt);
      logger.debug(
        `[${operationName}] Retrying in ${delayMs}ms... (attempt ${attempt + 2}/${maxRetries + 1})`
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}
