/**
 * Retry utility with exponential backoff
 */
import {logger} from './logger'
import { getErrorMessage } from '../providers/errorClassification'

export interface RetryOptions<T> {
  operation: () => Promise<T>;
  maxRetries: number;
  delay: (attempt: number) => number;
  onRetry?: (attempt: number, error: unknown) => void;
  onFailure?: (error: unknown) => boolean;
  /**
   * Predicate deciding whether an error may be retried at all. When it returns
   * `false` the error is rethrown immediately — no backoff, no further attempts.
   * Providers pass a classifier here so deterministic failures (401, 400,
   * caller aborts) fail fast instead of burning the full retry budget.
   */
  isRetriable?: (error: unknown) => boolean;
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
  const { operation, maxRetries, delay, onRetry, onFailure, isRetriable } = options;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error: unknown) {
      lastError = error;

      // Unretriable errors (auth, invalid request, caller aborts) fail fast —
      // retrying a deterministic failure only adds latency to the same outcome.
      if (isRetriable && !isRetriable(error)) {
        throw error;
      }

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

/**
 * Combine abort signals into one that aborts as soon as any input aborts.
 * `undefined` inputs are skipped, so a caller can pass an optional caller-signal
 * alongside a required per-attempt one. Returns the sole signal when only one is
 * present (no wrapper), or `undefined` when none are.
 *
 * Prefers the platform `AbortSignal.any`, which cleans up its listeners via weak
 * refs — so merging onto a long-lived caller signal that's reused across many
 * calls can't accumulate listeners. Falls back to a manual controller on older
 * runtimes (< Node 20.3); there the listeners live until a source aborts or is
 * garbage-collected, which is fine for the usual per-request signal.
 */
export function combineAbortSignals(
  ...signals: Array<AbortSignal | undefined>
): AbortSignal | undefined {
  const present = signals.filter((s): s is AbortSignal => s != null);
  if (present.length <= 1) return present[0];
  if (typeof AbortSignal.any === "function") return AbortSignal.any(present);

  const controller = new AbortController();
  for (const signal of present) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), {
      once: true,
    });
  }
  return controller.signal;
}

export const withTimeoutAndRetry = async <T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number = 60000,
  maxRetries: number = 3,
  operationName: string = "AI operation",
  isRetriable?: (error: unknown) => boolean
): Promise<T> => {
  const createTimeoutOperation = () => async (): Promise<T> => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    try {
      // Hand the operation the timeout signal so the in-flight upstream call is
      // actually cancelled when the deadline fires — otherwise the abandoned
      // attempt keeps running while the retry stacks a second concurrent call.
      const result = await Promise.race([
        operation(controller.signal),
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
    isRetriable,
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
   * Predicate deciding whether a pre-first-chunk failure may be retried.
   * When it returns `false` the error propagates immediately. Post-first-chunk
   * failures are never retried regardless (the stream is already committed).
   */
  isRetriable?: (error: unknown) => boolean;
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
  factory: (signal: AbortSignal) => AsyncGenerator<T>,
  options: StreamRetryOptions = {}
): AsyncGenerator<T> {
  const {
    maxRetries = 3,
    delay = defaultBackoff,
    operationName = "AI stream",
    firstChunkTimeoutMs,
    isRetriable,
  } = options;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // One controller per attempt: aborting it on abandon cancels the upstream
    // SDK call so a retry can't stack a second concurrent stream.
    const controller = new AbortController();
    const iterator = factory(controller.signal);
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
      // Unretriable errors (auth, invalid request, caller aborts) propagate
      // immediately — no backoff for a deterministic failure.
      if (isRetriable && !isRetriable(error)) {
        throw error;
      }
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
      // Abandoning an attempt (first-chunk timeout, pre-yield error before a
      // retry, or a consumer that breaks early): abort the upstream SDK call
      // first so it's actually torn down — not left running while we retry —
      // then dispose the iterator. Aborting also unblocks a stalled
      // iterator.next() so return() can run the generator's cleanup. Both are
      // fire-and-forget: a wedged generator's return() may never settle, so we
      // must not await it.
      if (!completed) {
        controller.abort();
        void iterator.return?.(undefined)?.catch(() => undefined);
      }
    }
  }
}

/**
 * Inputs shared by {@link withBackupFallback} and {@link streamWithBackupFallback}.
 *
 * The walkers own only control flow: which model runs next and when the walk
 * gives up. Logging and terminal-error wrapping stay with the caller (via the
 * callbacks and a try/catch around the call), so each provider keeps its exact
 * log prefixes, classification options and error normalization.
 */
export interface BackupFallbackBase {
  /**
   * Models to try in order: `[primaryModel, ...backupModels]`. The first
   * successful attempt wins; every failure advances (or stops) the walk.
   */
  models: string[];
  /**
   * Predicate deciding whether a failure may fall through to the remaining
   * models. Returning `false` stops the walk and rethrows the error — a
   * deterministic failure (auth, invalid request) would hit identically on
   * every backup. Must be a pure classifier: it may be evaluated more than
   * once per error (the failure callback recomputes it to annotate logs).
   */
  shouldTryBackup: (error: unknown) => boolean;
  /**
   * Called once per failed model, before the backup decision is applied.
   * `attemptNo` is the 1-based position in `models` (`1` = primary) and
   * `total` is `models.length`, so callers can distinguish the primary
   * failure and tell whether any model remains after this one
   * (`attemptNo < total`).
   */
  onModelFailed?: (
    model: string,
    error: unknown,
    attemptNo: number,
    total: number
  ) => void;
  /**
   * Called before each *backup* attempt (position > 0). `backupNo` and
   * `backupTotal` count backups only (`1..models.length - 1`), matching the
   * historical "Trying backup model 1/2: …" log shape.
   */
  onBackupStart?: (
    model: string,
    backupNo: number,
    backupTotal: number
  ) => void;
  /** Called when a backup succeeds, just before its result is returned/yielded. */
  onBackupSucceeded?: (model: string) => void;
}

export interface BackupFallbackOptions<T> extends BackupFallbackBase {
  /** Run one model. A rejection marks the model failed; the resolved value wins. */
  attempt: (model: string) => Promise<T>;
}

export interface StreamBackupFallbackOptions<T> extends BackupFallbackBase {
  /** Produce one model's chunk stream; consumed lazily via `yield*`. */
  attempt: (model: string) => AsyncGenerator<T>;
}

/**
 * Try `models[0]` (the primary); on failure, if `shouldTryBackup` allows,
 * walk the remaining backup models in order. Resolves with the first
 * successful result; otherwise rethrows the last error seen. Errors are
 * rethrown untouched — wrap them at the call site.
 *
 * Streaming twin: {@link streamWithBackupFallback}.
 */
export async function withBackupFallback<T>(
  opts: BackupFallbackOptions<T>
): Promise<T> {
  const {
    models,
    attempt,
    shouldTryBackup,
    onModelFailed,
    onBackupStart,
    onBackupSucceeded,
  } = opts;

  if (models.length === 0) {
    throw new Error(
      "withBackupFallback: `models` must include a primary model"
    );
  }

  let lastError: unknown;
  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    if (i > 0) onBackupStart?.(model, i, models.length - 1);
    try {
      const result = await attempt(model);
      if (i > 0) onBackupSucceeded?.(model);
      return result;
    } catch (error: unknown) {
      lastError = error;
      onModelFailed?.(model, error, i + 1, models.length);
      // A failure that doesn't qualify for backup ends the walk — the
      // remaining models would hit the same deterministic error. Falling
      // through to the throw covers both this early exit and exhaustion.
      if (!shouldTryBackup(error)) break;
    }
  }

  throw lastError;
}

/**
 * Streaming twin of {@link withBackupFallback}: same walk, consuming each
 * model's chunk stream lazily via `yield*` so chunks flow through unchanged.
 * A stream that errors before completion counts as that model's failure and
 * the walk proceeds exactly as in the non-streaming case.
 */
export async function* streamWithBackupFallback<T>(
  opts: StreamBackupFallbackOptions<T>
): AsyncGenerator<T> {
  const {
    models,
    attempt,
    shouldTryBackup,
    onModelFailed,
    onBackupStart,
    onBackupSucceeded,
  } = opts;

  if (models.length === 0) {
    throw new Error(
      "streamWithBackupFallback: `models` must include a primary model"
    );
  }

  let lastError: unknown;
  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    if (i > 0) onBackupStart?.(model, i, models.length - 1);
    try {
      yield* attempt(model);
      if (i > 0) onBackupSucceeded?.(model);
      return;
    } catch (error: unknown) {
      lastError = error;
      onModelFailed?.(model, error, i + 1, models.length);
      if (!shouldTryBackup(error)) break;
    }
  }

  throw lastError;
}

/**
 * Standard logging observer for the backup-fallback walkers. Holds the
 * per-walk state (primary error message, whether backups were tried) that the
 * terminal "All models failed" log needs, so each provider call site is just
 * `attempt` + `shouldTryBackup` + its own terminal error wrap.
 *
 * ```ts
 * const observer = backupFallbackLogging("[OPENAI]", shouldUseBackupModel);
 * try {
 *   return await withBackupFallback({ models, attempt, shouldTryBackup, ...observer.callbacks });
 * } catch (error) {
 *   observer.logExhausted(error);
 *   throw wrap(error);
 * }
 * ```
 */
export function backupFallbackLogging(
  label: string,
  shouldTryBackup: (error: unknown) => boolean,
  options?: { streaming?: boolean }
): {
  callbacks: Pick<
    BackupFallbackBase,
    "onModelFailed" | "onBackupStart" | "onBackupSucceeded"
  >;
  logExhausted: (lastError: unknown) => void;
} {
  let primaryErrMsg = "";
  // Records that the primary failed but qualified for backups — the only path
  // that reaches the "All models failed" terminal log; an ineligible primary
  // rethrows directly.
  let tryingBackups = false;
  const streamSuffix = options?.streaming ? " for streaming" : "";

  return {
    callbacks: {
      onModelFailed: (model, error, attemptNo, total) => {
        const errMsg = getErrorMessage(error);
        if (attemptNo === 1) {
          primaryErrMsg = errMsg;
          logger.warn(`${label} Primary model ${model} failed: ${errMsg}`);
          if (shouldTryBackup(error)) {
            tryingBackups = true;
            logger.debug(`${label} Trying backup models${streamSuffix}`);
          }
          return;
        }
        logger.warn(`${label} Backup model ${model} failed: ${errMsg}`);
        if (!shouldTryBackup(error) && attemptNo < total) {
          logger.debug(
            `${label} Backup model error doesn't qualify for further attempts`
          );
        }
      },
      onBackupStart: (model, backupNo, backupTotal) => {
        logger.debug(
          `${label} Trying backup model ${backupNo}/${backupTotal}: ${model}`
        );
      },
      onBackupSucceeded: (model) => {
        logger.debug(`${label} Backup model ${model} succeeded`);
      },
    },
    logExhausted: (lastError) => {
      if (tryingBackups) {
        logger.error(
          `${label} All models failed. Primary: ${primaryErrMsg}, Last backup: ${getErrorMessage(lastError)}`
        );
      }
    },
  };
}
