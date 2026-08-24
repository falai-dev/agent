/**
 * Retry classification — transient failures (rate limits, overload, timeout,
 * network) retry with backoff; deterministic failures (auth, invalid request,
 * caller aborts) fail fast on the first attempt.
 */
import { describe, expect, test } from "bun:test";

import {
  isRetriableProviderError,
} from "../src/providers/errorClassification";
import { retry, withStreamRetry } from "../src/utils/retry";

const RETRIABLE_OPTIONS = { overloadedStatuses: [529] };

describe("isRetriableProviderError", () => {
  test.each([401, 403])("auth status %i is NOT retriable", (status) => {
    expect(isRetriableProviderError({ status }, RETRIABLE_OPTIONS)).toBe(false);
  });

  test.each([400, 404, 422])("invalid-request status %i is NOT retriable", (status) => {
    expect(isRetriableProviderError({ status }, RETRIABLE_OPTIONS)).toBe(false);
  });

  test.each([429, 500, 503])("transient status %i IS retriable", (status) => {
    expect(isRetriableProviderError({ status }, RETRIABLE_OPTIONS)).toBe(true);
  });

  test("provider-specific overload statuses are retriable with options", () => {
    expect(
      isRetriableProviderError({ status: 529 }, RETRIABLE_OPTIONS)
    ).toBe(true);
    // …and unknown without them (not classified as an availability error).
    expect(isRetriableProviderError({ status: 529 })).toBe(false);
  });

  test("timeouts and network faults are retriable", () => {
    expect(isRetriableProviderError(new Error("Request timed out"))).toBe(true);
    expect(isRetriableProviderError(new Error("fetch failed"))).toBe(true);
    expect(
      isRetriableProviderError({ code: "ECONNRESET", message: "connect ECONNRESET" })
    ).toBe(true);
  });

  test("caller aborts are NEVER retriable", () => {
    const abort = Object.assign(new Error("Request was aborted"), {
      name: "AbortError",
    });
    expect(isRetriableProviderError(abort)).toBe(false);

    const sdkAbort = Object.assign(new Error("User aborted"), {
      name: "APIUserAbortError",
    });
    expect(isRetriableProviderError(sdkAbort)).toBe(false);
  });
});

describe("retry() honors the isRetriable predicate", () => {
  test("non-retriable errors throw after ONE attempt", async () => {
    let attempts = 0;
    const authError = { status: 401 };

    await expect(
      retry({
        operation: async () => {
          attempts++;
          throw authError;
        },
        maxRetries: 3,
        delay: () => 0,
        isRetriable: (e) => isRetriableProviderError(e),
      })
    ).rejects.toBe(authError);

    expect(attempts).toBe(1);
  });

  test("retriable errors exhaust the full budget before failing", async () => {
    let attempts = 0;
    const rateLimit = { status: 429 };

    await expect(
      retry({
        operation: async () => {
          attempts++;
          throw rateLimit;
        },
        maxRetries: 2,
        delay: () => 0,
        isRetriable: (e) => isRetriableProviderError(e),
      })
    ).rejects.toBe(rateLimit);

    expect(attempts).toBe(3); // initial + 2 retries
  });
});

describe("withStreamRetry honors the isRetriable predicate", () => {
  test("non-retriable pre-first-chunk failure runs the factory once", async () => {
    let factories = 0;
    const authError = { status: 401 };

    const run = async () => {
      for await (const _chunk of withStreamRetry(async function* () {
        factories++;
        throw authError;
      }, { maxRetries: 3, delay: () => 0, isRetriable: (e) => isRetriableProviderError(e) })) {
        // no chunks expected
      }
    };

    await expect(run()).rejects.toBe(authError);
    expect(factories).toBe(1);
  });
});
