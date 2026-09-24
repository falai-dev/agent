/**
 * Reading stored session blobs.
 *
 * `assertSession` is the v4 shape check every store runs on load.
 * `migrateSession` lifts a 3.x `SessionState` into a v4 `Session` once, at
 * the host's choke point (design §10). Both fail loudly: a row that is
 * neither a v4 session nor a recognisable 3.x blob throws
 * `InvalidSessionError` and never comes back as a fresh conversation, which
 * would silently re-ask every field and re-fire every once-flow.
 */

import type { History } from "../types/history.js";
import type { Run, RunStatus, Session, StepOutcome } from "../types/session.js";
import { isRecord } from "../utils/json.js";

type Rec = Record<string, unknown>;

/** A stored row that cannot be read as a session. */
export class InvalidSessionError extends Error {
  constructor(
    public readonly sessionId: string,
    why: string,
  ) {
    super(
      `[InvalidSessionError] stored session "${sessionId}" is unreadable: ${why}. ` +
        `Repair or delete the row; it is never replaced by a fresh conversation.`,
    );
    this.name = "InvalidSessionError";
  }
}

export interface MigrateOptions {
  sessionId: string;
  /** The v4 flow id that took over a 3.x signal id or flow id. Identity when ids were kept. */
  flowIdOf: (signalKeyOrFlowId: string) => string;
  /** Stamps runs and claims that carry no date of their own. Default: now. */
  now?: Date;
}

const isWhole = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

/** Short description of a value for error messages. */
function describe(value: unknown): string {
  if (value === undefined) return "missing";
  if (value === null) return "null";
  if (Array.isArray(value)) return "a list";
  if (typeof value === "string") return `"${value}"`;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return typeof value === "object" ? "an object" : `a ${typeof value}`;
}

type Bad = (why: string) => InvalidSessionError;

// ── v4 ──────────────────────────────────────────────────────────────────

const RUN_STATUS: ReadonlySet<string> = new Set<RunStatus>(["running", "asking", "waiting", "suspended"]);

/**
 * A v4 blob back to a `Session`, holding only the session keys (a store's
 * own `createdAt`/`updatedAt` are dropped). Throws `InvalidSessionError`
 * when the shape is off.
 */
export function assertSession<D>(blob: unknown, sessionId: string): Session<D> {
  const bad: Bad = (why) => new InvalidSessionError(sessionId, why);
  if (!isRecord(blob)) throw bad(`expected an object, got ${describe(blob)}`);
  if (blob.v !== 4) throw bad(`v is ${describe(blob.v)}, expected 4`);
  if (blob.id !== sessionId) throw bad(`id is ${describe(blob.id)}, expected "${sessionId}"`);

  const { version, data, runs, claims, inputs, metadata, history, lastUserAt, lastAssistantAt } = blob;
  if (!isWhole(version)) throw bad(`version is ${describe(version)}, expected a whole number`);
  if (!isRecord(data)) throw bad(`data is ${describe(data)}, expected an object`);
  if (!Array.isArray(runs)) throw bad(`runs is ${describe(runs)}, expected a list`);
  if (!isRecord(claims) || !Object.values(claims).every((c) => isRecord(c) && typeof c.at === "string")) {
    throw bad("claims is not a map of { at }");
  }
  if (!Array.isArray(inputs) || !inputs.every((i) => typeof i === "string")) throw bad("inputs is not a list of ids");
  if (!isRecord(metadata)) throw bad(`metadata is ${describe(metadata)}, expected an object`);
  if (history !== undefined && !Array.isArray(history)) throw bad(`history is ${describe(history)}, expected a list`);
  if (lastUserAt !== undefined && typeof lastUserAt !== "string") throw bad("lastUserAt is not text");
  if (lastAssistantAt !== undefined && typeof lastAssistantAt !== "string") throw bad("lastAssistantAt is not text");

  const session: Session<D> = {
    id: sessionId,
    v: 4,
    version,
    data: data as Partial<D>,
    runs: runs.map((run, i) => checkRun(run, i, bad)),
    claims: claims as Session["claims"],
    inputs,
    metadata,
  };
  if (lastUserAt !== undefined) session.lastUserAt = lastUserAt;
  if (lastAssistantAt !== undefined) session.lastAssistantAt = lastAssistantAt;
  if (history !== undefined) session.history = history as History;
  return session;
}

function checkRun(raw: unknown, index: number, bad: Bad): Run {
  const at = `runs[${index}]`;
  if (!isRecord(raw)) throw bad(`${at} is ${describe(raw)}, expected an object`);
  const text = (key: string): string => {
    const value = raw[key];
    if (typeof value !== "string") throw bad(`${at}.${key} is ${describe(value)}, expected text`);
    return value;
  };
  const record = (key: string): Rec => {
    const value = raw[key];
    if (!isRecord(value)) throw bad(`${at}.${key} is ${describe(value)}, expected an object`);
    return value;
  };

  const status = text("status");
  if (!RUN_STATUS.has(status)) throw bad(`${at}.status is "${status}"`);
  const { stepId, hop, outcomes, input, waiting, suspendedAt, staying } = raw;
  if (stepId !== null && typeof stepId !== "string") throw bad(`${at}.stepId is ${describe(stepId)}, expected text or null`);
  if (!isWhole(hop)) throw bad(`${at}.hop is ${describe(hop)}, expected a whole number`);
  if (!Array.isArray(outcomes)) throw bad(`${at}.outcomes is ${describe(outcomes)}, expected a list`);
  const trigger = record("trigger");
  if (typeof trigger.kind !== "string" || typeof trigger.key !== "string") throw bad(`${at}.trigger needs kind and key`);
  if (waiting !== undefined && !isRecord(waiting)) throw bad(`${at}.waiting is ${describe(waiting)}, expected an object`);

  // ponytail: outcomes, waiting and the asked/visits counters are trusted below
  // the keys checked here; every writer is this package. Upgrade: a full schema check.
  const run: Run = {
    id: text("id"),
    flowId: text("flowId"),
    anchor: text("anchor"),
    dedupeKey: text("dedupeKey"),
    stepId,
    status: status as RunStatus,
    trigger: trigger as Run["trigger"],
    hop,
    startedAt: text("startedAt"),
    asked: record("asked") as Record<string, number>,
    visits: record("visits") as Record<string, number>,
    outcomes: outcomes as StepOutcome[],
  };
  if (input !== undefined) run.input = input;
  if (waiting !== undefined) run.waiting = waiting as Run["waiting"];
  if (typeof suspendedAt === "string") run.suspendedAt = suspendedAt;
  if (staying === true) run.staying = true;
  return run;
}

// ── 3.x → 4 ─────────────────────────────────────────────────────────────

/**
 * A stored blob to a v4 `Session`. A v4 blob passes through `assertSession`.
 * A 3.x `SessionState` becomes: `data` verbatim; `currentFlow`/`currentStep`
 * one run at the same step; every fired signal and every completed flow a
 * `once` claim, so nothing re-fires; `pendingDirective` dropped; `metadata`
 * kept with its dates as ISO text. Anything else throws `InvalidSessionError`.
 */
export function migrateSession<D>(blob: unknown, options: MigrateOptions): Session<D> {
  const { sessionId } = options;
  const bad: Bad = (why) => new InvalidSessionError(sessionId, why);
  if (!isRecord(blob)) throw bad(`expected an object, got ${describe(blob)}`);
  if ("v" in blob) return assertSession<D>(blob, sessionId);
  return fromLegacy<D>(blob, options, bad);
}

function fromLegacy<D>(blob: Rec, options: MigrateOptions, bad: Bad): Session<D> {
  const { sessionId, flowIdOf } = options;
  const { data, metadata, history, flowHistory, signals } = blob;
  if (!isRecord(data)) throw bad(`data is ${describe(data)}, expected an object; not a 3.x session either`);
  if (metadata !== undefined && !isRecord(metadata)) throw bad(`metadata is ${describe(metadata)}, expected an object`);
  if (history !== undefined && !Array.isArray(history)) throw bad(`history is ${describe(history)}, expected a list`);
  if (flowHistory !== undefined && !Array.isArray(flowHistory)) throw bad(`flowHistory is ${describe(flowHistory)}, expected a list`);
  if (signals !== undefined && !isRecord(signals)) throw bad(`signals is ${describe(signals)}, expected an object`);
  const triggers = signals?.triggers ?? {};
  if (!isRecord(triggers)) throw bad(`signals.triggers is ${describe(triggers)}, expected an object`);

  const fallback = (options.now ?? new Date()).toISOString();
  const claimKey = (key: string): string => `${flowIdOf(key)}:${sessionId}:`;
  const claims: Session["claims"] = {};

  for (const [i, entry] of (flowHistory ?? []).entries()) {
    if (!isRecord(entry) || typeof entry.flowId !== "string") throw bad(`flowHistory[${i}] is not a flow entry`);
    if (entry.completed === true) {
      claims[claimKey(entry.flowId)] = { at: toIso(entry.exitedAt) ?? toIso(entry.enteredAt) ?? fallback };
    }
  }
  for (const [key, state] of Object.entries(triggers)) {
    if (!isRecord(state)) throw bad(`signals.triggers.${key} is not a trigger state`);
    claims[claimKey(key)] = { at: toIso(state.lastTriggeredAt) ?? toIso(state.firstTriggeredAt) ?? fallback };
  }

  const runs: Run[] = [];
  const flowRef = legacyRef(blob.currentFlow, "currentFlow", bad);
  const stepRef = legacyRef(blob.currentStep, "currentStep", bad);
  if (flowRef) {
    const flowId = flowIdOf(flowRef.id);
    const startedAt = toIso(flowRef.enteredAt) ?? fallback;
    const stepId = stepRef?.id ?? null;
    runs.push({
      id: `${flowId}#legacy`,
      flowId,
      anchor: sessionId,
      dedupeKey: `${flowId}:${sessionId}:`,
      stepId,
      // A flow entered before its first step is a fresh run; at a step it is asking there.
      status: stepId === null ? "running" : "asking",
      trigger: { kind: "message", key: "legacy" },
      hop: 0,
      startedAt,
      asked: {},
      visits: {},
      outcomes: [],
    });
    // Invariant I5: a run never exists without its claim.
    claims[`${flowId}:${sessionId}:`] = { at: startedAt };
  }

  const session: Session<D> = {
    id: sessionId,
    v: 4,
    // A migrated session has no v4 row yet: 0 makes the host's first save an insert.
    version: 0,
    data: data as Partial<D>,
    runs,
    claims,
    inputs: [],
    metadata: recordDatesToIso(metadata ?? {}),
  };
  if (history !== undefined) session.history = history as History;
  return session;
}

/** `currentFlow`/`currentStep` as 3.x wrote them: `{ id, enteredAt? }` in the blob, a bare id in a row. */
function legacyRef(value: unknown, name: string, bad: Bad): { id: string; enteredAt?: unknown } | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value ? { id: value } : undefined;
  if (isRecord(value) && typeof value.id === "string") return { id: value.id, enteredAt: value.enteredAt };
  throw bad(`${name} is ${describe(value)}, expected { id } or text`);
}

/** A Date, ISO text or epoch number as ISO text; anything else is nothing. */
function toIso(value: unknown): string | undefined {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
  if (typeof value === "number" || (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value))) {
    const ms = new Date(value).getTime();
    return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
  }
  return undefined;
}

function recordDatesToIso(record: Rec): Rec {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, datesToIso(value)]));
}

function datesToIso(value: unknown): unknown {
  if (value instanceof Date) return toIso(value) ?? null;
  if (Array.isArray(value)) return value.map(datesToIso);
  if (isRecord(value)) return recordDatesToIso(value);
  return value;
}
