/**
 * withStreamRetry Tests
 *
 * The streaming analog of withTimeoutAndRetry: it re-runs a stream factory only
 * while it fails *before yielding its first chunk* (e.g. an empty completion
 * that throws "No response"), and never retries once deltas have been emitted.
 */
import { expect, test, describe } from "bun:test";

import { withStreamRetry } from "../src/utils/retry";

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const chunk of gen) out.push(chunk);
  return out;
}

describe("withStreamRetry", () => {
  test("passes chunks through when the stream succeeds on the first try", async () => {
    let calls = 0;
    const out = await collect(
      withStreamRetry(
        async function* () {
          calls++;
          yield 1;
          yield 2;
          yield 3;
        },
        { maxRetries: 3, delay: () => 0 }
      )
    );
    expect(out).toEqual([1, 2, 3]);
    expect(calls).toBe(1);
  });

  test("retries when the stream throws before yielding, then succeeds", async () => {
    let calls = 0;
    const out = await collect(
      withStreamRetry(
        async function* () {
          calls++;
          if (calls < 3) throw new Error("No response");
          yield "ok";
        },
        { maxRetries: 3, delay: () => 0 }
      )
    );
    expect(out).toEqual(["ok"]);
    expect(calls).toBe(3); // failed twice (pre-yield), succeeded on the third attempt
  });

  test("does NOT retry once a chunk has been yielded", async () => {
    let calls = 0;
    const out: string[] = [];
    await expect(
      (async () => {
        for await (const chunk of withStreamRetry(
          async function* () {
            calls++;
            yield "partial";
            throw new Error("mid-stream failure");
          },
          { maxRetries: 3, delay: () => 0 }
        )) {
          out.push(chunk);
        }
      })()
    ).rejects.toThrow("mid-stream failure");
    expect(out).toEqual(["partial"]);
    expect(calls).toBe(1); // committed after the first yield — no retry, no duplicate deltas
  });

  test("throws the last error after exhausting the retry budget", async () => {
    let calls = 0;
    await expect(
      collect(
        withStreamRetry(
          async function* () {
            calls++;
            throw new Error(`fail ${calls}`);
          },
          { maxRetries: 2, delay: () => 0 }
        )
      )
    ).rejects.toThrow("fail 3"); // initial attempt + 2 retries
    expect(calls).toBe(3);
  });

  test("times out waiting for the first chunk, then retries and succeeds", async () => {
    let calls = 0;
    const out = await collect(
      withStreamRetry(
        async function* () {
          calls++;
          if (calls < 3) {
            // Stalls past the 20ms deadline, but settles so nothing leaks.
            await new Promise((resolve) => setTimeout(resolve, 80));
          }
          yield "ok";
        },
        { maxRetries: 3, delay: () => 0, firstChunkTimeoutMs: 20 }
      )
    );
    expect(out).toEqual(["ok"]);
    expect(calls).toBe(3);
  });

  test("does not bound chunks after the first", async () => {
    // First chunk is immediate; the second arrives after the first-chunk
    // deadline and must NOT be cut off.
    const out = await collect(
      withStreamRetry(
        async function* () {
          yield "a";
          await new Promise((resolve) => setTimeout(resolve, 60));
          yield "b";
        },
        { maxRetries: 0, delay: () => 0, firstChunkTimeoutMs: 20 }
      )
    );
    expect(out).toEqual(["a", "b"]);
  });

  test("throws when the first chunk never arrives and retries are exhausted", async () => {
    let calls = 0;
    await expect(
      collect(
        withStreamRetry(
          async function* () {
            calls++;
            // Stalls past the deadline on every attempt; settles so nothing leaks.
            await new Promise((resolve) => setTimeout(resolve, 80));
            yield "never";
          },
          { maxRetries: 1, delay: () => 0, firstChunkTimeoutMs: 20 }
        )
      )
    ).rejects.toThrow(/no first chunk within 20ms/i);
    expect(calls).toBe(2); // initial attempt + 1 retry
  });

  test("aborts the abandoned attempt's signal on first-chunk timeout, fresh signal per attempt", async () => {
    const signals: AbortSignal[] = [];
    let calls = 0;
    const out = await collect(
      withStreamRetry(
        async function* (signal) {
          calls++;
          signals.push(signal);
          if (calls < 2) {
            // Wait on the abort rather than a fixed sleep: a real provider
            // stream is torn down the instant withStreamRetry abandons the
            // attempt, so the abandoned upstream call can't keep running.
            await new Promise<void>((resolve) =>
              signal.addEventListener("abort", () => resolve(), { once: true })
            );
            return;
          }
          yield "ok";
        },
        { maxRetries: 2, delay: () => 0, firstChunkTimeoutMs: 20 }
      )
    );
    expect(out).toEqual(["ok"]);
    expect(calls).toBe(2);
    // The abandoned attempt was actually cancelled; the committed one was not.
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
  });

  test("aborts the in-flight signal when the consumer breaks early", async () => {
    let signal: AbortSignal | undefined;
    const gen = withStreamRetry(
      async function* (s) {
        signal = s;
        yield "a";
        yield "b";
      },
      { maxRetries: 0, delay: () => 0 }
    );
    // Take one chunk, then abandon the consumer mid-stream.
    const first = await gen.next();
    expect(first.value).toBe("a");
    await gen.return(undefined);
    // The upstream call is cancelled even though deltas had already flowed.
    expect(signal?.aborted).toBe(true);
  });
});
