/**
 * Retry utility with exponential backoff
 */

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
      console.error(
        `[${operationName}] Failed attempt ${attempt + 1}:`,
        message
      );
      const delay = Math.min(1000 * Math.pow(2, attempt), 5000);
      console.log(`[${operationName}] Retrying in ${delay}ms...`);
      console.log(
        `[${operationName}] Attempt ${attempt + 2}/${maxRetries + 1}`
      );
    },
    onFailure: (_error: unknown) => {
      console.error(`[${operationName}] All ${maxRetries + 1} attempts failed`);
      return true;
    },
  });
};
