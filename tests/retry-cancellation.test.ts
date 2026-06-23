/**
 * Real-cancellation tests for the retry helpers.
 *
 * On an abandoned attempt (a deadline that fires) the helpers must abort the
 * signal they hand the operation, so the upstream SDK call is actually torn
 * down — not left running while the retry stacks a second concurrent call.
 * `combineAbortSignals` is the primitive that merges caller cancellation with
 * the per-attempt deadline; both providers' streaming and non-streaming paths
 * pass the combined signal to the SDK.
 */
import { expect, test, describe } from "bun:test";

import { combineAbortSignals, withTimeoutAndRetry } from "../src/utils/retry";

describe("combineAbortSignals", () => {
  test("returns undefined when no signals are present", () => {
    expect(combineAbortSignals(undefined, undefined)).toBeUndefined();
  });

  test("returns the sole signal without wrapping it", () => {
    const c = new AbortController();
    expect(combineAbortSignals(undefined, c.signal)).toBe(c.signal);
  });

  test("aborts as soon as any input aborts", () => {
    const a = new AbortController();
    const b = new AbortController();
    const merged = combineAbortSignals(a.signal, b.signal)!;
    expect(merged.aborted).toBe(false);
    b.abort();
    expect(merged.aborted).toBe(true);
  });

  test("is already aborted when an input was aborted beforehand", () => {
    const a = new AbortController();
    a.abort();
    const b = new AbortController();
    expect(combineAbortSignals(a.signal, b.signal)!.aborted).toBe(true);
  });
});

describe("withTimeoutAndRetry cancellation", () => {
  test("aborts the operation's signal when the timeout fires", async () => {
    let signal: AbortSignal | undefined;
    await expect(
      withTimeoutAndRetry(
        async (s) => {
          signal = s;
          // Hang until cancelled — a real SDK call is aborted here on timeout
          // instead of running free while the helper moves on.
          await new Promise<void>((resolve) =>
            s.addEventListener("abort", () => resolve(), { once: true })
          );
          return "never";
        },
        20, // timeoutMs
        0, // no retries — fail fast, no backoff
        "test op"
      )
    ).rejects.toThrow(/timed out/i);
    expect(signal?.aborted).toBe(true);
  });
});
