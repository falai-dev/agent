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
});
