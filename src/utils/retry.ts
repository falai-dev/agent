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

/** Provider timeout (ms) + retry count, after defaults are applied. */
export interface RetryConfig {
  timeout: number;
  retries: number;
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  timeout: 60000,
  retries: 3,
};

/**
 * Normalize a provider's optional retry config against the defaults. `timeout`
 * uses `||` (a 0ms timeout is degenerate — it aborts every call immediately — so
 * fall back to the default), while `retries` uses `??` so an explicit
 * `retries: 0` (disable retries) is honored rather than treated as unset. Single
 * definition so this distinction can't drift between providers.
 */
export function resolveRetryConfig(input?: {
  timeout?: number;
  retries?: number;
}): RetryConfig {
  return {
    timeout: input?.timeout || DEFAULT_RETRY_CONFIG.timeout,
    retries: input?.retries ?? DEFAULT_RETRY_CONFIG.retries,
  };
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

/** Capped exponential backoff (1s, 2s, 4s, … max 5s) shared by the retry helpers. */
const defaultBackoff = (attempt: number): number =>
  Math.min(1000 * Math.pow(2, attempt), 5000);

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
    delay: defaultBackoff,
    onRetry: (attempt: number, error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(
        `[${operationName}] Failed attempt ${attempt + 1}:`,
        message
      );
      const delay = defaultBackoff(attempt);
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
  /**
   * Max ms to wait for the *first* chunk (time-to-first-token) before treating
   * the attempt as failed. Guards a provider that opens a stream and then
   * stalls. Only the first chunk is bounded — later chunks are unbounded so a
   * long but healthy stream is never cut off. `0`/omitted disables the deadline.
   */
  firstChunkTimeoutMs?: number;
}

/** Reject if `next` hasn't settled within `timeoutMs`; always clears its timer. */
function raceFirstChunk<T>(
  next: Promise<IteratorResult<T>>,
  timeoutMs: number,
  operationName: string
): Promise<IteratorResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `[${operationName}] Stream timed out: no first chunk within ${timeoutMs}ms`
          )
        ),
      timeoutMs
    );
  });
  return Promise.race([next, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Streaming analog of {@link withTimeoutAndRetry}. Re-runs an async-generator
 * factory as long as it fails *before yielding its first chunk* — an empty
 * completion that throws "No response", an error while establishing the stream,
 * or (with `firstChunkTimeoutMs`) a stall before the first token. Once any chunk
 * has been yielded the stream is committed and further errors propagate, so a
 * retry can never double-emit deltas the consumer has already received.
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
    delay = defaultBackoff,
    operationName = "AI stream",
    firstChunkTimeoutMs,
  } = options;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const iterator = factory();
    let yielded = false;
    let completed = false;
    try {
      // Drive the iterator by hand so the first chunk can be raced against a
      // deadline; for-await would give no hook for that.
      for (;;) {
        const result =
          !yielded && firstChunkTimeoutMs
            ? await raceFirstChunk(iterator.next(), firstChunkTimeoutMs, operationName)
            : await iterator.next();
        if (result.done) {
          completed = true;
          return;
        }
        yielded = true;
        yield result.value;
      }
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
    } finally {
      // Dispose the iterator unless it completed on its own — covers the
      // error/timeout path and a consumer that breaks early. Fire-and-forget:
      // a stalled generator's return() may never settle, so we must not await it.
      if (!completed) {
        void iterator.return?.(undefined)?.catch(() => undefined);
      }
    }
  }
}
