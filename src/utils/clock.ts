/**
 * Time you can hold still: a fake clock for `AgentOptions.clock` and an
 * in-memory scheduler that fires `schedule[]` entries on demand. Tests and
 * the playground use both; production hosts bring their own queue.
 */

import type { Clock, ScheduleEntry } from "../types/agent.js";
import type { Duration } from "../types/flow.js";
import { parseDuration } from "./duration.js";

export interface FakeClock extends Clock {
  now(): Date;
  /** Move forward by a duration (`'24h'`) or a number of milliseconds. */
  advance(by: Duration | number): Date;
  set(iso: string): Date;
}

/** A clock that only moves when told to. Pass it as `clock` to the agent. */
export function fakeClock(iso: string): FakeClock {
  let at = parseIso(iso);
  const clock = (): Date => new Date(at);
  return Object.assign(clock, {
    now: clock,
    advance(by: Duration | number): Date {
      at += typeof by === "number" ? by : parseDuration(by);
      return clock();
    },
    set(next: string): Date {
      at = parseIso(next);
      return clock();
    },
  });
}

function parseIso(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`fakeClock: "${iso}" is not a date.`);
  return ms;
}

/**
 * Holds `schedule[]` entries and hands back the ones that are due. A new
 * entry with the same key replaces the old one; `replaces` removes that key.
 */
export class MemoryScheduler {
  private readonly entries = new Map<string, ScheduleEntry>();

  add(entry: ScheduleEntry): void {
    if (entry.replaces) this.entries.delete(entry.replaces);
    this.entries.delete(entry.key);
    this.entries.set(entry.key, { ...entry, at: new Date(entry.at) });
  }

  remove(key: string): void {
    this.entries.delete(key);
  }

  get size(): number {
    return this.entries.size;
  }

  /** Removes and returns every entry whose `at` is not after `now`, earliest first. */
  due(now: Date): ScheduleEntry[] {
    const fired = [...this.entries.values()]
      .filter((e) => e.at.getTime() <= now.getTime())
      .sort((a, b) => a.at.getTime() - b.at.getTime());
    for (const e of fired) this.entries.delete(e.key);
    return fired;
  }
}
