/**
 * Shared provider error utilities: classification of SDK/HTTP errors onto
 * normalized ProviderErrorCode values, backup-model eligibility, and
 * wrapping of terminal failures in ProviderError.
 *
 * The classification is derived once and reused for both backup-model
 * decisions and final error wrapping, so the two can never drift apart.
 */

import { ProviderError, type ProviderErrorCode } from "../types/errors";

/**
 * Shape of errors with status/code properties thrown by provider SDKs
 */
export interface ErrorWithStatus {
  status?: number;
  code?: string;
  message?: string;
  type?: string;
}

/**
 * Type guard to check if error is ErrorWithStatus
 */
export function isErrorWithStatus(error: unknown): error is ErrorWithStatus {
  return (
    typeof error === "object" &&
    error !== null &&
    ("status" in error || "code" in error || "message" in error)
  );
}

/**
 * Safely extract error message
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (isErrorWithStatus(error) && error.message) {
    return error.message;
  }
  return String(error);
}

/**
 * Provider-specific signals treated as "overloaded/unavailable", in
 * addition to the shared defaults (HTTP 500/503 and the common message
 * substrings below).
 */
export interface ErrorClassificationOptions {
  /** Extra HTTP statuses treated as overloaded (e.g. Anthropic's 529) */
  overloadedStatuses?: readonly number[];
  /** Error `code` values treated as overloaded/unavailable (e.g. "model_not_found") */
  overloadedCodes?: readonly string[];
  /** Error `type` values treated as overloaded (e.g. Anthropic's "overloaded_error") */
  overloadedTypes?: readonly string[];
  /** Extra message substrings treated as overloaded (e.g. OpenRouter's "capacity") */
  overloadedMessages?: readonly string[];
}

/**
 * Message substrings every provider historically treated as
 * overloaded/unavailable for backup-model purposes.
 */
const DEFAULT_OVERLOADED_MESSAGES: readonly string[] = [
  "overloaded",
  "unavailable",
  "internal error",
  "Internal error",
];

/**
 * Classify an unknown error into a normalized ProviderErrorCode.
 *
 * Overload/availability checks run first so that backup-model decisions
 * (rate_limited/overloaded) match the historical shouldUseBackupModel
 * predicate exactly.
 */
export function classifyProviderError(
  error: unknown,
  options: ErrorClassificationOptions = {}
): ProviderErrorCode {
  if (!isErrorWithStatus(error)) {
    return "unknown";
  }

  const { status, code, type } = error;
  const message = getErrorMessage(error);

  // Server errors / overload
  if (status === 500 || status === 503) {
    return "overloaded";
  }

  // Rate limiting
  if (status === 429) {
    return "rate_limited";
  }

  // Provider-specific overload/unavailability signals
  if (status !== undefined && options.overloadedStatuses?.includes(status)) {
    return "overloaded";
  }
  if (code !== undefined && options.overloadedCodes?.includes(code)) {
    return "overloaded";
  }
  if (type !== undefined && options.overloadedTypes?.includes(type)) {
    return "overloaded";
  }
  const overloadedMessages = options.overloadedMessages
    ? [...DEFAULT_OVERLOADED_MESSAGES, ...options.overloadedMessages]
    : DEFAULT_OVERLOADED_MESSAGES;
  if (overloadedMessages.some((pattern) => message.includes(pattern))) {
    return "overloaded";
  }

  // Non-retriable classifications (never triggered backup models)
  if (status === 401 || status === 403) {
    return "auth";
  }
  if (status === 400 || status === 404 || status === 422) {
    return "invalid_request";
  }
  if (
    status === 408 ||
    message.includes("timed out") ||
    message.includes("timeout")
  ) {
    return "timeout";
  }
  if (
    message.includes("fetch failed") ||
    message.includes("ECONNREFUSED") ||
    message.includes("ECONNRESET") ||
    message.includes("ETIMEDOUT") ||
    message.includes("network")
  ) {
    return "network";
  }

  return "unknown";
}

/**
 * Whether an error code qualifies for trying backup models.
 * Mirrors the historical shouldUseBackupModel predicate.
 */
export function isBackupEligible(code: ProviderErrorCode): boolean {
  return code === "rate_limited" || code === "overloaded";
}

/**
 * Wrap a terminal failure (after retries/backup exhaustion) in a
 * normalized ProviderError, preserving the original error as `cause`.
 * Already-wrapped errors pass through untouched.
 */
export function toProviderError(
  error: unknown,
  provider: string,
  options?: ErrorClassificationOptions
): ProviderError {
  if (error instanceof ProviderError) {
    return error;
  }
  return new ProviderError(
    classifyProviderError(error, options),
    provider,
    getErrorMessage(error),
    error
  );
}
