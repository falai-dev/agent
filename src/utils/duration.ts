/**
 * `Duration` strings: `'30s'`, `'5m'`, `'24h'`, `'3d'` → milliseconds.
 */

import { FlowConfigurationError } from "../types/errors.js";
import type { Duration } from "../types/flow.js";

const PATTERN = /^(\d+(?:\.\d+)?)(s|m|h|d)$/;

const UNIT_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** `'30s'`, `'5m'`, `'24h'`, `'3d'`: a number followed by one unit. */
export function isDuration(value: string): value is Duration {
  return PATTERN.test(value);
}

/** Throws `FlowConfigurationError` unless `value` is a well-formed duration. */
export function assertDuration(value: string, where = "duration"): asserts value is Duration {
  if (!isDuration(value)) {
    throw new FlowConfigurationError(
      `[FlowConfigurationError] ${where} "${value}" is not a duration: expected a number followed by s, m, h or d. ` +
        `Write it like "30s", "5m", "24h" or "3d".`,
    );
  }
}

/** `'5m'` → 300000. Throws on a malformed string. */
export function parseDuration(value: string): number {
  assertDuration(value);
  const match = PATTERN.exec(value);
  if (!match) throw new FlowConfigurationError(`[FlowConfigurationError] duration "${value}" did not parse.`);
  return Math.round(Number(match[1]) * UNIT_MS[match[2]]);
}
