/**
 * Runner: the code half of a turn. Load, Ingest, Decide, Run, Settle and
 * Return (design §4) with one applier, `advance`. Zero provider calls live
 * here: the Agent asks `understandRequest` and `advance` what to judge and
 * what to speak, spends the calls, and hands the plain results back to
 * `decide` and `settle`.
 *
 *   begin ─▶ understandRequest ─(Understand)─▶ decide ─▶ advance ─(Speak)─▶ settle ─▶ finish
 */

import type { AgentOptions, EndReason, TurnInput, TurnResult } from "../types/agent.js";
import type {
  ActionResult,
  Branch,
  DoStep,
  Duration,
  Flow,
  IfStep,
  Next,
  Pred,
  Repeat,
  SayStep,
  Step,
  StepBase,
  TalkStep,
  Trigger,
  WaitEventStep,
  WaitStep,
} from "../types/flow.js";
import type { Run, Session, StepOutcome, StepOutcomeKind, TriggerKind } from "../types/session.js";
import { cloneDeep } from "../utils/clone.js";
import { parseDuration } from "../utils/duration.js";
import { coerceField, DEFAULT_MAX_ASKS, extractMode, isKnown, pendingFields } from "../utils/schema.js";
import { render, renderDeep } from "../utils/template.js";
import type { IdleRequest, InputKind, SpeakOutcome, Spoken, TalkRequest, UnderstandRequest, Understanding } from "./contracts.js";
import { deepEqual, evaluate } from "./predicate.js";

/** A `wait` this short rides as `afterMs` on the next message instead of a real wake. */
const SHORT_WAIT_MS = 10_000;
const MAX_STEPS_PER_TURN = 50;
const MAX_HOP = 5;
/** Kept always-claims per flow and anchor, kept input ids, kept outcomes per run. */
const KEEP = 50;
const RETRY_BACKOFF: Duration[] = ["1m", "5m", "15m"];
const DEFAULT_EVENT_WAIT: Duration = "30d";
const ROUTE_MIN = 40;
const ROUTE_STICKY = 15;

/** What started the turn, already narrowed. */
export type What =
  | { kind: "message"; text: string; id?: string; at: string }
  | { kind: "wake"; key: string }
  | { kind: "event"; name: string; payload: unknown; key: string; hop: number }
  | { kind: "start"; flow: string; input: unknown; key: string; hop: number };

/** The mutable per-turn state. `session` is a deep copy; the input is never touched. */
export interface Turn<C = unknown, D = unknown> {
  readonly input: TurnInput<C, D>;
  readonly what: What;
  readonly kind: InputKind;
  /** Message id, wake key, event key or start key: the trigger key of runs started this turn. */
  readonly triggerKey: string;
  readonly session: Session<D>;
  readonly original?: Session<D>;
  readonly now: Date;
  readonly nowIso: string;
  readonly context: C;
  readonly silenced?: string;
  /** The host gate allows the understand call even though the assistant cannot speak. */
  readonly understandAllowed: boolean;
  /** Set by a short-circuit: the input is a no-op and nothing is saved. */
  ignored: boolean;
  messages: TurnResult<D>["messages"];
  schedule: TurnResult<D>["schedule"];
  outcomes: StepOutcome[];
  started: TurnResult<D>["started"];
  ended: TurnResult<D>["ended"];
  skipped: TurnResult<D>["skipped"];
  llmCalls: number;
  // ── internals ──
  /** The run holding the floor this turn: resolved in Ingest, routed in Decide, or the asker. */
  floorRunId?: string;
  /** A run took or resumed the floor in Ingest: routing is skipped. */
  floorFromIngest: boolean;
  /** True while Ingest runs, so a child chained there counts as taking the floor in Ingest. */
  ingesting: boolean;
  /** Runs that emitted a `say` or an action `spoke: true` this turn. */
  spokeBy: Set<string>;
  /** The assistant produced output this turn (say, spoke, ai message). */
  spoke: boolean;
  /** A short `wait` waiting to ride on the next message. */
  afterMs: number;
  talk?: TalkRequest<C, D>;
  /** Speak already happened (or was skipped): a talk step reached now waits for the next message. */
  speakDone: boolean;
  /** Runs still to move this phase; `follow` appends children. */
  queue: Run[];
}

type MessageTrigger<C, D> = Extract<Trigger<C, D>, { message: string[] }>;
type MentionTrigger<C, D> = Extract<Trigger<C, D>, { mention: string[] }>;
type SilenceTrigger<C, D> = Extract<Trigger<C, D>, { silence: Duration }>;

type TalkOf<C, D> = StepBase<D> & TalkStep<C, D>;
type SayOf<D> = StepBase<D> & SayStep;
type DoOf<D> = StepBase<D> & DoStep<D>;
type WaitOf<C, D> = StepBase<D> & WaitStep<C, D>;
type WaitEventOf<D> = StepBase<D> & WaitEventStep<D>;
type IfOf<C, D> = StepBase<D> & IfStep<C, D>;

function isTalk<C, D>(step: Step<C, D>): step is TalkOf<C, D> {
  return "prompt" in step || "collect" in step;
}
function isSay<C, D>(step: Step<C, D>): step is SayOf<D> {
  return "say" in step;
}
function isDo<C, D>(step: Step<C, D>): step is DoOf<D> {
  return "do" in step;
}
function isWait<C, D>(step: Step<C, D>): step is WaitOf<C, D> {
  return "wait" in step && typeof step.wait === "string";
}
function isWaitEvent<C, D>(step: Step<C, D>): step is WaitEventOf<D> {
  return "wait" in step && typeof step.wait === "object";
}
function isIf<C, D>(step: Step<C, D>): step is IfOf<C, D> {
  return "if" in step;
}

function triggerKind<C, D>(trigger: Trigger<C, D>): TriggerKind {
  if ("message" in trigger) return "message";
  if ("mention" in trigger) return "mention";
  if ("silence" in trigger) return "silence";
  return "event";
}

function defaultRepeat(kind: TriggerKind): Repeat {
  return kind === "message" || kind === "mention" || kind === "silence" ? "once" : "always";
}

function talkKind(step: { collect?: readonly string[] }): StepOutcomeKind {
  return step.collect?.length ? "collect" : "prompt";
}

function kindOf<C, D>(step: Step<C, D> | undefined): StepOutcomeKind {
  if (!step) return "if";
  if (isTalk(step)) return talkKind(step);
  if (isSay(step)) return "say";
  if (isDo(step)) return "do";
  if (isIf(step)) return "if";
  return "wait";
}

function describe<C, D>(input: TurnInput<C, D>, nowIso: string): What {
  if ("message" in input) return { kind: "message", text: input.message, id: input.id, at: input.at ?? nowIso };
  if ("wake" in input) return { kind: "wake", key: input.wake };
  if ("event" in input) return { kind: "event", name: input.event, payload: input.payload, key: input.key, hop: input.hop ?? 0 };
  return { kind: "start", flow: input.start.flow, input: input.start.input, key: input.start.key, hop: input.start.hop ?? 0 };
}

function freshSession<D>(id: string): Session<D> {
  return { id, v: 4, version: 0, data: {}, runs: [], claims: {}, inputs: [], metadata: {} };
}

function keepLast<T>(list: T[], n: number): void {
  if (list.length > n) list.splice(0, list.length - n);
}

export class Runner<C = unknown, D = unknown> {
  private readonly flows: Map<string, Flow<C, D>>;

  constructor(private readonly options: AgentOptions<C, D>) {
    this.flows = new Map((options.flows ?? []).map((flow) => [flow.id, flow]));
  }

  // ── Load + Ingest ─────────────────────────────────────────────────────

  begin(input: TurnInput<C, D>): Turn<C, D> {
    const now = (this.options.clock ?? (() => new Date()))();
    const nowIso = now.toISOString();
    const what = describe(input, nowIso);
    const silenced = typeof input.silenced === "string" ? input.silenced : input.silenced?.reason;
    const turn: Turn<C, D> = {
      input,
      what,
      kind: what.kind,
      triggerKey: what.kind === "message" ? (what.id ?? what.at) : what.key,
      session: input.session ? cloneDeep(input.session) : freshSession<D>(input.sessionId),
      original: input.session,
      now,
      nowIso,
      // `context` is optional only when C allows undefined, so this is C at every call site that compiles.
      context: input.context as C,
      silenced,
      understandAllowed: typeof input.silenced === "object" && input.silenced.understand === true,
      ignored: false,
      messages: [],
      schedule: [],
      outcomes: [],
      started: [],
      ended: [],
      skipped: [],
      llmCalls: 0,
      floorFromIngest: false,
      ingesting: false,
      spokeBy: new Set(),
      spoke: false,
      afterMs: 0,
      speakDone: false,
      queue: [],
    };
    if (what.kind === "wake" && !input.session) {
      this.ignore(turn, "ignorado: sessão inexistente", what.key);
      return turn;
    }
    turn.ingesting = true;
    this.ingest(turn);
    turn.ingesting = false;
    return turn;
  }

  private ingest(turn: Turn<C, D>): void {
    const { what, session } = turn;
    switch (what.kind) {
      case "message": {
        if (what.id) {
          if (session.inputs.includes(what.id)) {
            this.ignore(turn, "ignorado: entrada repetida", what.id);
            return;
          }
          session.inputs.push(what.id);
          keepLast(session.inputs, KEEP);
        }
        session.lastUserAt = what.at;
        this.resolveReplyWaits(turn);
        return;
      }
      case "wake":
        if (what.key.startsWith("silence:")) this.silenceWake(turn, what.key);
        else this.runWake(turn, what.key);
        return;
      case "event": {
        const direction = this.options.events?.[what.name]?.direction;
        if (direction === "inbound") {
          session.lastUserAt = turn.nowIso;
          this.resolveReplyWaits(turn);
        } else if (direction === "outbound") {
          session.lastAssistantAt = turn.nowIso;
        }
        for (const run of [...session.runs]) {
          if (run.waiting?.kind !== "event" || run.waiting.event !== what.name) continue;
          const flow = this.flows.get(run.flowId);
          const step = flow && this.stepOf(flow, run.stepId);
          run.status = "running";
          delete run.waiting;
          if (!flow || !step) continue; // move() reports the missing flow or step
          this.outcome(turn, run, { kind: "wait", status: "ok", detail: "evento chegou", next: nextLabel(step.then) });
          this.follow(turn, run, flow, step, step.then);
          this.takeFloor(turn, run);
        }
        for (const flow of this.flows.values()) {
          for (const trigger of flow.on ?? []) {
            if (!("event" in trigger) || trigger.event !== what.name) continue;
            if (this.startRun(turn, flow, "event", what.key, { trigger, payload: what.payload, hop: what.hop })) break;
          }
        }
        return;
      }
      case "start": {
        const flow = this.flows.get(what.flow);
        if (!flow) {
          turn.skipped.push({ flowId: what.flow, anchor: session.id, triggerKey: what.key, detail: "pulado: fluxo desativado ou removido" });
          return;
        }
        this.startRun(turn, flow, "start", what.key, { payload: what.input, hop: what.hop });
        return;
      }
    }
  }

  /** The lead wrote: every run parked on a timer `wait` with `else` takes `else`, oldest first. */
  private resolveReplyWaits(turn: Turn<C, D>): void {
    for (const run of [...turn.session.runs]) {
      if (run.status !== "waiting" || run.waiting?.kind !== "timer" || run.stepId === null) continue;
      const flow = this.flows.get(run.flowId);
      const step = flow && this.stepOf(flow, run.stepId);
      if (!flow || !step || !isWait(step) || step.else === undefined) continue;
      run.status = "running";
      delete run.waiting;
      const branch = step.branches?.find((b) => "if" in b && this.holds(b.if, turn, run));
      const target = branch ? branch.then : step.else;
      this.outcome(turn, run, { kind: "wait", status: "ok", detail: "respondeu", next: nextLabel(target) });
      this.follow(turn, run, flow, step, target);
      this.takeFloor(turn, run);
    }
  }

  /** Honoured only by the run whose `waiting.key` equals it (I3). */
  private runWake(turn: Turn<C, D>, key: string): void {
    const run = turn.session.runs.find((r) => r.waiting?.key === key);
    if (!run) {
      this.ignore(turn, "ignorado: wake antigo", key);
      return;
    }
    const setAt = run.waiting?.setAt ?? run.startedAt;
    run.status = "running";
    delete run.waiting;
    turn.floorRunId = run.id;
    if (run.stepId === null) return; // parked on the trigger's `after`: enters its first step in advance()
    const flow = this.flows.get(run.flowId);
    const step = flow && this.stepOf(flow, run.stepId);
    if (!flow || !step) return; // move() reports it
    if (isWait(step)) {
      // The reply beat the job: the lead wrote after the wait was set.
      const replied = step.else !== undefined && this.leadWroteSince(turn, setAt, flow);
      const target = replied ? step.else : step.then;
      this.outcome(turn, run, { kind: "wait", status: "ok", detail: replied ? "respondeu" : "sem resposta", next: nextLabel(target) });
      this.follow(turn, run, flow, step, target);
    } else if (isWaitEvent(step)) {
      // ponytail: an event wait that times out without `else` ends the run; nothing sensible follows an event that never came.
      const target = step.else ?? "end";
      this.outcome(turn, run, { kind: "wait", status: "ok", detail: "sem evento", next: nextLabel(target) });
      this.follow(turn, run, flow, step, target);
    }
    // A deferred `do` or a retried talk step re-runs at the same visit in advance(): same key, same idempotency.
  }

  /** `silence:<flowId>:<sessionId>:<lastAssistantAtMs>`, honoured only while the blob still shows that silence. */
  private silenceWake(turn: Turn<C, D>, key: string): void {
    const rest = key.slice("silence:".length);
    const flowId = rest.slice(0, rest.indexOf(":"));
    const ms = Number(rest.slice(rest.lastIndexOf(":") + 1));
    const { lastAssistantAt } = turn.session;
    const flow = this.flows.get(flowId);
    if (!flow) {
      turn.skipped.push({ flowId, anchor: turn.session.id, triggerKey: String(ms), detail: "pulado: fluxo desativado ou removido" });
      return;
    }
    if (!lastAssistantAt || Date.parse(lastAssistantAt) !== ms || this.leadWroteSince(turn, lastAssistantAt, flow)) {
      this.ignore(turn, "ignorado: silêncio quebrado", key);
      return;
    }
    const trigger = (flow.on ?? []).find((t) => "silence" in t);
    const run = this.startRun(turn, flow, "silence", String(ms), { trigger });
    if (run) turn.floorRunId = run.id;
  }

  private ignore(turn: Turn<C, D>, detail: string, key: string): void {
    turn.ignored = true;
    turn.outcomes.push({ kind: "wait", status: "skipped", detail, key, at: turn.nowIso });
  }

  private takeFloor(turn: Turn<C, D>, run: Run): void {
    if (!turn.session.runs.includes(run) || turn.floorFromIngest) return;
    turn.floorFromIngest = true;
    turn.floorRunId = run.id;
  }

  // ── Starting runs: the one start order (design §4.2) ─────────────────

  private startRun(
    turn: Turn<C, D>,
    flow: Flow<C, D>,
    kind: TriggerKind,
    key: string,
    opts: { trigger?: Trigger<C, D>; payload?: unknown; hop?: number; keepData?: boolean },
  ): Run | null {
    const { session } = turn;
    const anchor = this.anchorOf(turn, flow);
    const hop = opts.hop ?? 0;
    const repeat = opts.trigger?.repeat ?? defaultRepeat(kind);
    const nonce = repeat === "always" ? key : "";
    const dedupeKey = `${flow.id}:${anchor}:${nonce}`;
    const run: Run = {
      id: `${flow.id}#${key}`,
      flowId: flow.id,
      anchor,
      dedupeKey,
      stepId: null,
      status: "running",
      trigger: { kind, key, ...(opts.payload !== undefined ? { payload: opts.payload } : {}) },
      ...(opts.payload !== undefined ? { input: opts.payload } : {}),
      hop,
      startedAt: turn.nowIso,
      asked: {},
      visits: {},
      outcomes: [],
    };
    const skip = (detail: string): null => {
      turn.skipped.push({ flowId: flow.id, anchor, triggerKey: key, detail });
      return null;
    };
    if (opts.trigger?.if && !this.holds(opts.trigger.if, turn, run)) return null;
    const heldAt = this.claimAt(turn, dedupeKey);
    if (heldAt !== undefined) {
      if (typeof repeat === "string") return skip("pulado: já executado");
      if (turn.now.getTime() - Date.parse(heldAt) < parseDuration(repeat.cooldown)) return skip("pulado: em cooldown");
    }
    if (hop >= MAX_HOP) return skip("pulado: limite de encadeamento");
    const live = session.runs.find((r) => r.flowId === flow.id && r.anchor === anchor);
    if (live) {
      if (live.status === "waiting" && live.stepId === null) this.endRun(turn, live, "replaced");
      else return skip("pulado: já em andamento");
    } else if (turn.input.claims?.active.includes(`${flow.id}:${anchor}`)) {
      return skip("pulado: já em andamento");
    }
    session.claims[dedupeKey] = { at: turn.nowIso };
    if (nonce) this.pruneAlwaysClaims(session, `${flow.id}:${anchor}:`);
    if (!opts.keepData) {
      const data: Record<string, unknown> = session.data;
      for (const field of flow.clearOnStart ?? []) delete data[field];
    }
    session.runs.push(run);
    turn.started.push({ runId: run.id, flowId: flow.id, anchor, dedupeKey });
    const after = opts.trigger && "event" in opts.trigger ? opts.trigger.after : undefined;
    if (after) {
      const at = this.snap(turn, new Date(turn.now.getTime() + parseDuration(after)), opts.trigger && "event" in opts.trigger ? opts.trigger.businessHours : undefined);
      this.park(turn, run, { kind: "timer", key: `${run.id}:start:${at.getTime()}` }, at);
      this.outcome(turn, run, { kind: "wait", status: "waiting", detail: "aguardando gatilho", until: at.toISOString() });
    }
    return run;
  }

  /** Always-claims keep the last 50 per flow and anchor; once/cooldown keys (empty nonce) are never pruned. */
  private pruneAlwaysClaims(session: Session<D>, prefix: string): void {
    const keys = Object.keys(session.claims).filter((k) => k.startsWith(prefix) && k.length > prefix.length);
    for (const key of keys.slice(0, Math.max(0, keys.length - KEEP))) delete session.claims[key];
  }

  private anchorOf(turn: Turn<C, D>, flow: Flow<C, D>): string {
    if (!flow.anchor || flow.anchor === "session") return turn.session.id;
    return turn.input.anchors?.[flow.anchor]?.key ?? turn.session.id;
  }

  private claimAt(turn: Turn<C, D>, key: string): string | undefined {
    return turn.session.claims[key]?.at ?? turn.input.claims?.held[key];
  }

  private repeatAllows(turn: Turn<C, D>, flow: Flow<C, D>, trigger: Trigger<C, D>, key: string): boolean {
    const repeat = trigger.repeat ?? defaultRepeat(triggerKind(trigger));
    const heldAt = this.claimAt(turn, `${flow.id}:${this.anchorOf(turn, flow)}:${repeat === "always" ? key : ""}`);
    if (heldAt === undefined) return true;
    if (typeof repeat === "string") return false;
    return turn.now.getTime() - Date.parse(heldAt) >= parseDuration(repeat.cooldown);
  }

  /** A run as it would be if started now, for trigger-level predicates. */
  private draftRun(turn: Turn<C, D>, flow: Flow<C, D>, kind: TriggerKind, key: string, payload?: unknown): Run {
    const anchor = this.anchorOf(turn, flow);
    return {
      id: `${flow.id}#${key}`, flowId: flow.id, anchor, dedupeKey: `${flow.id}:${anchor}:`, stepId: null, status: "running",
      trigger: { kind, key }, input: payload, hop: 0, startedAt: turn.nowIso, asked: {}, visits: {}, outcomes: [],
    };
  }

  private holds(pred: Pred<C, D>, turn: Turn<C, D>, run: Run, input: unknown = run.input): boolean {
    return evaluate(
      pred,
      { context: turn.context, data: turn.session.data, input, run, silenced: turn.silenced, now: turn.now },
      this.options.conditions ?? {},
    );
  }

  private leadWroteSince(turn: Turn<C, D>, sinceIso: string, flow: Flow<C, D>): boolean {
    const since = Date.parse(sinceIso);
    const { lastUserAt } = turn.session;
    if (lastUserAt && Date.parse(lastUserAt) > since) return true;
    if (!flow.anchor || flow.anchor === "session") return false;
    const inbound = turn.input.anchors?.[flow.anchor]?.lastInboundAt;
    return inbound !== undefined && Date.parse(inbound) > since;
  }

  private snap(turn: Turn<C, D>, at: Date, businessHours: boolean | undefined): Date {
    return businessHours && this.options.businessHours ? this.options.businessHours(at, { context: turn.context }) : at;
  }

  private stepOf(flow: Flow<C, D>, stepId: string | null): Step<C, D> | undefined {
    return stepId === null ? undefined : flow.steps.find((s) => s.id === stepId);
  }

  private stepKey(run: Run, step: Step<C, D>): string {
    return `${run.id}:${step.id}:${run.visits[step.id] ?? 0}`;
  }

  private scope(turn: Turn<C, D>, run: Run): { data: unknown; context: unknown; input: unknown } {
    return { data: turn.session.data, context: turn.context, input: run.input };
  }

  private asker(turn: Turn<C, D>): Run | undefined {
    return turn.session.runs.find((r) => r.status === "asking");
  }

  private outcome(turn: Turn<C, D>, run: Run | undefined, line: Omit<StepOutcome, "at" | "runId" | "flowId" | "stepId"> & { stepId?: string }): void {
    const full: StepOutcome = {
      ...(run ? { runId: run.id, flowId: run.flowId, stepId: line.stepId ?? run.stepId ?? undefined } : {}),
      ...line,
      at: turn.nowIso,
    };
    if (full.stepId === undefined) delete full.stepId;
    turn.outcomes.push(full);
    if (run) {
      run.outcomes.push(full);
      keepLast(run.outcomes, KEEP);
    }
  }

  // ── Understand: what the one call may judge (design §4.3) ─────────────

  understandRequest(turn: Turn<C, D>): UnderstandRequest<C, D> | null {
    if (turn.ignored || turn.what.kind !== "message") return null;
    if (turn.silenced !== undefined && !turn.understandAllowed) return null;
    const floorRun = this.floorRun(turn);
    const floorFlow = floorRun && this.flows.get(floorRun.flowId);
    const eligible = this.eligibleMessageFlows(turn);
    // Exactly one eligible message flow and no floor: it starts without scoring (S9).
    const messageFlows = !floorRun && eligible.length === 1 ? [] : eligible;
    const mentionFlows = this.mentionFlows()
      .filter(({ flow, trigger }) => trigger.mention.length > 0 && this.repeatAllows(turn, flow, trigger, turn.triggerKey))
      .map(({ flow }) => flow);
    const branches: UnderstandRequest<C, D>["branches"] = [];
    const askingStep = floorRun && floorFlow ? this.stepOf(floorFlow, floorRun.stepId) : undefined;
    if (floorRun && askingStep && isTalk(askingStep)) {
      askingStep.branches?.forEach((branch, index) => {
        if ("when" in branch) branches.push({ runId: floorRun.id, stepId: askingStep.id, index, when: branch.when });
      });
    }
    const fields: UnderstandRequest<C, D>["fields"] = {};
    const data: Record<string, unknown> = turn.session.data;
    for (const flow of [...(floorFlow ? [floorFlow] : []), ...eligible]) {
      for (const step of flow.steps) {
        if (!isTalk(step)) continue;
        for (const field of step.collect ?? []) {
          const def = this.options.fields[field];
          if (def && !isKnown(data[field]) && extractMode(def) === "anywhere") fields[field] = def;
        }
      }
    }
    if (!messageFlows.length && !mentionFlows.length && !branches.length && !Object.keys(fields).length) return null;
    return {
      text: turn.what.text,
      history: turn.input.history ?? turn.session.history ?? [],
      context: turn.context,
      data: turn.session.data,
      ...(floorRun && floorFlow ? { floor: { run: floorRun, flow: floorFlow } } : {}),
      messageFlows,
      mentionFlows,
      branches,
      fields,
    };
  }

  /** The asker, or the run that took the floor in Ingest. */
  private floorRun(turn: Turn<C, D>): Run | undefined {
    const asking = this.asker(turn);
    if (asking) return asking;
    return turn.floorRunId ? turn.session.runs.find((r) => r.id === turn.floorRunId) : undefined;
  }

  /** `message` flows with a non-empty list passing `if` and `repeat`, in flow order. */
  private eligibleMessageFlows(turn: Turn<C, D>): Flow<C, D>[] {
    return this.messageFlows(turn, (list) => list.length > 0);
  }

  private messageFlows(turn: Turn<C, D>, accept: (list: string[]) => boolean): Flow<C, D>[] {
    const out: Flow<C, D>[] = [];
    for (const flow of this.flows.values()) {
      const trigger = (flow.on ?? []).find((t): t is MessageTrigger<C, D> => "message" in t && accept(t.message));
      if (!trigger) continue;
      if (trigger.if && !this.holds(trigger.if, turn, this.draftRun(turn, flow, "message", turn.triggerKey))) continue;
      if (!this.repeatAllows(turn, flow, trigger, turn.triggerKey)) continue;
      out.push(flow);
    }
    return out;
  }

  /** Every `mention` flow with its trigger, in flow order. `if` and `repeat` are judged at start, when `extract` is in hand. */
  private mentionFlows(): Array<{ flow: Flow<C, D>; trigger: MentionTrigger<C, D> }> {
    const out: Array<{ flow: Flow<C, D>; trigger: MentionTrigger<C, D> }> = [];
    for (const flow of this.flows.values()) {
      const trigger = (flow.on ?? []).find((t): t is MentionTrigger<C, D> => "mention" in t);
      if (trigger) out.push({ flow, trigger });
    }
    return out;
  }

  // ── Decide: apply the judgement (design §4.4) ─────────────────────────

  decide(turn: Turn<C, D>, understanding: Understanding | null): void {
    if (turn.ignored || turn.what.kind !== "message") return;
    turn.llmCalls += understanding?.llmCalls ?? 0;
    const key = turn.triggerKey;
    const asker = this.asker(turn);

    // Routing is decided before extraction lands so `clearOnStart` runs first, and applied after mention runs.
    let route: Flow<C, D> | undefined;
    if (!turn.floorFromIngest) {
      const eligible = this.eligibleMessageFlows(turn);
      const scores = understanding?.flows ?? {};
      const best = (flows: Flow<C, D>[]): { flow: Flow<C, D>; score: number } | undefined =>
        flows.map((flow) => ({ flow, score: scores[flow.id] ?? 0 })).reduce<{ flow: Flow<C, D>; score: number } | undefined>(
          (top, cur) => (top && top.score >= cur.score ? top : cur), undefined);
      if (asker) {
        const current = scores[asker.flowId] ?? 0;
        const top = best(eligible.filter((f) => f.id !== asker.flowId));
        if (top && top.score >= current + ROUTE_STICKY && top.score >= ROUTE_MIN) route = top.flow;
      } else if (eligible.length === 1) {
        route = eligible[0];
      } else {
        const top = best(eligible);
        route = top && top.score >= ROUTE_MIN ? top.flow : this.messageFlows(turn, (list) => list.length === 0)[0];
      }
    }

    // A code-only detector (`mention: []`) goes through the full start order here, so a blocked `repeat` is logged as a skip.
    for (const { flow, trigger } of this.mentionFlows()) {
      if (trigger.mention.length === 0) this.startRun(turn, flow, "mention", key, { trigger });
      else if (understanding?.mentions[flow.id]) this.startRun(turn, flow, "mention", key, { trigger, payload: understanding.extract[flow.id] });
    }

    if (route) {
      const suspended = turn.session.runs.find((r) => r.flowId === route.id && r.status === "suspended");
      if (suspended) {
        suspended.status = "running";
        delete suspended.suspendedAt;
        turn.floorRunId = suspended.id;
      } else {
        const trigger = (route.on ?? []).find((t) => "message" in t);
        const run = this.startRun(turn, route, "message", key, { trigger });
        if (run) turn.floorRunId = run.id;
      }
    }

    for (const [field, raw] of Object.entries(understanding?.fields ?? {})) this.writeField(turn, field, raw);

    if (asker && turn.session.runs.includes(asker) && asker.status === "asking") {
      const flow = this.flows.get(asker.flowId);
      const step = flow && this.stepOf(flow, asker.stepId);
      if (flow && step && isTalk(step)) this.fireBranch(turn, asker, flow, step, understanding);
    }
  }

  private fireBranch(turn: Turn<C, D>, run: Run, flow: Flow<C, D>, step: TalkOf<C, D>, understanding: Understanding | null): void {
    const hit = (branch: Branch<C, D>, index: number): boolean =>
      "if" in branch ? this.holds(branch.if, turn, run) : understanding?.branches[`${run.id}/${step.id}/${index}`] === true;
    const index = (step.branches ?? []).findIndex(hit);
    if (index < 0) return;
    const branch = (step.branches ?? [])[index];
    this.outcome(turn, run, { kind: talkKind(step), status: "ok", key: this.stepKey(run, step), detail: "ramificação", next: nextLabel(branch.then) });
    run.status = "running";
    this.follow(turn, run, flow, step, branch.then);
  }

  /** Validate a raw extracted value and write it; unknown or invalid values leave an outcome line instead. */
  private writeField(turn: Turn<C, D>, field: string, raw: unknown): void {
    if (raw === undefined || raw === null) return;
    const def = this.options.fields[field];
    if (!def) {
      this.outcome(turn, undefined, { kind: "collect", status: "skipped", detail: "ignorado: campo desconhecido" });
      return;
    }
    const coerced = coerceField(def, raw);
    if (!coerced.ok) {
      this.outcome(turn, undefined, { kind: "collect", status: "skipped", detail: coerced.detail });
      return;
    }
    const data: Record<string, unknown> = turn.session.data;
    data[field] = coerced.value;
  }

  // ── Run: move everything that can move (design §4.5) ──────────────────

  async advance(turn: Turn<C, D>): Promise<TalkRequest<C, D> | IdleRequest<C, D> | null> {
    if (turn.ignored) return null;
    this.resumeSuspended(turn);
    turn.queue = [...turn.session.runs];
    await this.drain(turn);
    return this.speaker(turn);
  }

  private speaker(turn: Turn<C, D>): TalkRequest<C, D> | IdleRequest<C, D> | null {
    if (turn.silenced !== undefined) return null;
    const { talk } = turn;
    if (talk) {
      // Another run's say (or spoke: true) already answered the lead: the floor's talk waits; the run stays asking.
      if (turn.what.kind === "message" && [...turn.spokeBy].some((id) => id !== talk.run.id)) {
        this.outcome(turn, talk.run, { kind: talkKind(talk.step), status: "skipped", key: this.stepKey(talk.run, talk.step), detail: "pulado: outra resposta já saiu" });
        turn.talk = undefined;
        return null;
      }
      return talk;
    }
    if (turn.what.kind === "message" && !this.asker(turn) && this.options.idle !== "silent" && turn.spokeBy.size === 0) {
      return { idle: this.options.idle ?? { prompt: "" } };
    }
    return null;
  }

  private async drain(turn: Turn<C, D>): Promise<void> {
    for (let run = turn.queue.shift(); run; run = turn.queue.shift()) {
      if (turn.session.runs.includes(run)) await this.move(turn, run);
    }
  }

  private async move(turn: Turn<C, D>, run: Run): Promise<void> {
    if (run.status === "waiting" || run.status === "suspended") return;
    // An asker only re-speaks when the lead writes; wakes and events leave it alone.
    if (run.status === "asking" && turn.what.kind !== "message") return;
    const flow = this.flows.get(run.flowId);
    if (!flow) {
      this.endRun(turn, run, "skipped", "pulado: fluxo desativado ou removido");
      return;
    }
    if (!this.premiseHolds(turn, run, flow)) return;
    const resuming = run.status === "asking";
    run.status = "running";
    if (run.stepId === null) {
      if (!flow.steps.length) {
        this.finishFlow(turn, run, flow);
        return;
      }
      this.enter(run, flow.steps[0].id);
    }
    for (let steps = 0; run.status === "running" && turn.session.runs.includes(run); steps++) {
      if (steps >= MAX_STEPS_PER_TURN) {
        this.endRun(turn, run, "failed", "falhou: laço de passos");
        return;
      }
      const step = this.stepOf(flow, run.stepId);
      if (!step) {
        this.endRun(turn, run, "skipped", "pulado: passo removido");
        return;
      }
      await this.execute(turn, run, flow, step, resuming && steps === 0);
    }
  }

  /** `while` (default: the trigger's `if`) with fresh context; silence runs add "no lead message since the run started". */
  private premiseHolds(turn: Turn<C, D>, run: Run, flow: Flow<C, D>): boolean {
    // A wake-driven move only: on a message turn the lead just wrote, and the flow's `wait ... else` says what to do about it.
    if (run.trigger.kind === "silence" && turn.what.kind === "wake" && this.leadWroteSince(turn, run.startedAt, flow)) {
      this.endRun(turn, run, "skipped", "pulado: lead escreveu nesse meio-tempo");
      return false;
    }
    let ok: boolean;
    if (flow.while) {
      ok = this.holds(flow.while, turn, run);
    } else {
      // ponytail: several triggers of one kind (two event triggers, say) are not told apart; the premise holds when any of them would fire.
      const same = (flow.on ?? []).filter((t) => triggerKind(t) === run.trigger.kind);
      ok = same.length === 0 || same.some((t) => !t.if || this.holds(t.if, turn, run));
    }
    if (!ok) this.endRun(turn, run, "skipped", "pulado: premissa mudou");
    return ok;
  }

  private async execute(turn: Turn<C, D>, run: Run, flow: Flow<C, D>, step: Step<C, D>, resuming: boolean): Promise<void> {
    const data: Record<string, unknown> = turn.session.data;
    const key = this.stepKey(run, step);

    if (isTalk(step)) {
      const kind = talkKind(step);
      let pending: string[] = [];
      if (step.collect?.length) {
        pending = pendingFields(step, data, run.asked);
        if (!pending.length) {
          this.reportMaxAsks(turn, run, step);
          this.outcome(turn, run, resuming
            ? { kind, status: "ok", key, next: nextLabel(step.then) }
            : { kind, status: "skipped", key, detail: "pulado: campos já conhecidos", next: nextLabel(step.then) });
          this.follow(turn, run, flow, step, step.then);
          return;
        }
      }
      if (turn.silenced !== undefined) {
        if (resuming) run.status = "asking"; // the gate is closed; it speaks when the gate opens
        else this.endRun(turn, run, "skipped", `silenciado: ${turn.silenced}`, kind);
        return;
      }
      for (const other of turn.session.runs) {
        if (other !== run && other.status === "asking") {
          other.status = "suspended";
          other.suspendedAt = turn.nowIso;
        }
      }
      run.status = "asking";
      if (!turn.speakDone) turn.talk = { run, flow, step, pending };
      return;
    }

    if (isSay(step)) {
      if (turn.silenced !== undefined) {
        this.endRun(turn, run, "skipped", `silenciado: ${turn.silenced}`, "say");
        return;
      }
      if (step.once) {
        const claim = `${flow.id}:${step.id}:${turn.session.id}`;
        if (this.claimAt(turn, claim) !== undefined) {
          this.outcome(turn, run, { kind: "say", status: "skipped", key, detail: "pulado: já enviado", next: nextLabel(step.then) });
          this.follow(turn, run, flow, step, step.then);
          return;
        }
        turn.session.claims[claim] = { at: turn.nowIso };
      }
      turn.messages.push({
        text: render(step.say, this.scope(turn, run)),
        kind: "verbatim",
        ...(step.media ? { media: step.media } : {}),
        afterMs: turn.afterMs,
        key,
        runId: run.id,
        stepId: step.id,
      });
      turn.afterMs = 0;
      turn.spokeBy.add(run.id);
      turn.spoke = true;
      this.outcome(turn, run, { kind: "say", status: "ok", key, next: nextLabel(step.then) });
      this.follow(turn, run, flow, step, step.then);
      return;
    }

    if (isDo(step)) {
      const action = this.options.actions?.[step.do];
      let result: ActionResult;
      if (!action) {
        result = { failed: "ação desconhecida" };
      } else {
        try {
          result = await action.run(renderDeep(step.with ?? {}, this.scope(turn, run)), {
            context: turn.context, data: turn.session.data, input: run.input, run, key, dedupeKey: run.dedupeKey,
            silenced: turn.silenced, now: turn.now, set: (patch) => void Object.assign(turn.session.data, patch),
          });
        } catch (error) {
          result = { failed: error instanceof Error ? error.message : String(error) };
        }
      }
      if ("ok" in result) {
        if (result.spoke) {
          turn.spokeBy.add(run.id);
          turn.spoke = true;
        }
        this.outcome(turn, run, { kind: "do", status: "ok", key, ...(result.detail ? { detail: result.detail } : {}), next: nextLabel(step.then) });
        this.follow(turn, run, flow, step, step.then);
      } else if ("skipped" in result) {
        this.outcome(turn, run, { kind: "do", status: "skipped", key, detail: `pulado: ${result.skipped}`, next: nextLabel(step.then) });
        this.follow(turn, run, flow, step, step.then);
      } else if ("failed" in result) {
        const target = step.onFail ?? step.then;
        this.outcome(turn, run, { kind: "do", status: "failed", key, detail: `falhou: ${result.failed}`, next: nextLabel(target) });
        this.follow(turn, run, flow, step, target);
      } else {
        const at = new Date(turn.now.getTime() + parseDuration(result.defer));
        this.park(turn, run, { kind: "timer", key: `${run.id}:${step.id}:${at.getTime()}` }, at);
        this.outcome(turn, run, { kind: "do", status: "deferred", key, detail: result.detail, until: at.toISOString() });
      }
      return;
    }

    if (isWait(step)) {
      const ms = parseDuration(step.wait);
      if (ms <= SHORT_WAIT_MS) {
        // ponytail: a short wait rides on the next message only when the very next step is a say or talk step; an `if` in between is not looked through.
        const next = this.peek(flow, step);
        if (next && (isSay(next) || isTalk(next))) {
          turn.afterMs += ms;
          this.outcome(turn, run, { kind: "wait", status: "ok", key, detail: `${ms}ms`, next: nextLabel(step.then) });
          this.follow(turn, run, flow, step, step.then);
          return;
        }
      }
      const at = this.snap(turn, new Date(turn.now.getTime() + ms), step.businessHours);
      this.park(turn, run, { kind: "timer", key: `${run.id}:${step.id}:${at.getTime()}` }, at);
      this.outcome(turn, run, { kind: "wait", status: "waiting", key, until: at.toISOString() });
      return;
    }

    if (isWaitEvent(step)) {
      const at = new Date(turn.now.getTime() + parseDuration(step.wait.upTo ?? DEFAULT_EVENT_WAIT));
      this.park(turn, run, { kind: "event", event: step.wait.event, key: `${run.id}:${step.id}:${at.getTime()}` }, at);
      this.outcome(turn, run, { kind: "wait", status: "waiting", key, detail: `aguardando ${step.wait.event}`, until: at.toISOString() });
      return;
    }

    if (isIf(step)) {
      const target = this.holds(step.if, turn, run) ? step.then : (step.else ?? "end");
      this.outcome(turn, run, { kind: "if", status: "ok", key, next: nextLabel(target) });
      this.follow(turn, run, flow, step, target);
    }
  }

  /** The step `then` leads to, when it is a step of this flow. */
  private peek(flow: Flow<C, D>, step: Step<C, D>): Step<C, D> | undefined {
    const { then } = step;
    if (then === undefined) return flow.steps[flow.steps.indexOf(step) + 1];
    if (typeof then === "string") return then === "end" ? undefined : this.stepOf(flow, then);
    return "step" in then ? this.stepOf(flow, then.step) : undefined;
  }

  private reportMaxAsks(turn: Turn<C, D>, run: Run, step: TalkOf<C, D>): void {
    const data: Record<string, unknown> = turn.session.data;
    const maxAsks = step.maxAsks ?? DEFAULT_MAX_ASKS;
    for (const field of step.collect ?? []) {
      const asked = run.asked[field] ?? 0;
      if (!isKnown(data[field]) && asked >= maxAsks) {
        this.outcome(turn, run, { kind: "collect", status: "skipped", key: this.stepKey(run, step), detail: `campo pulado: perguntado ${asked} vezes` });
      }
    }
  }

  // ── Movement primitives ───────────────────────────────────────────────

  private follow(turn: Turn<C, D>, run: Run, flow: Flow<C, D>, step: Step<C, D>, target: Next<D> | undefined): void {
    if (target === undefined) {
      const next = flow.steps[flow.steps.indexOf(step) + 1];
      if (next) this.enter(run, next.id);
      else this.finishFlow(turn, run, flow);
      return;
    }
    if (typeof target === "string") {
      if (target === "end") this.finishFlow(turn, run, flow);
      else this.jump(turn, run, flow, target);
      return;
    }
    if ("step" in target) {
      const data: Record<string, unknown> = turn.session.data;
      for (const field of target.clear ?? []) delete data[field];
      this.jump(turn, run, flow, target.step);
      return;
    }
    const childId = render(target.flow, this.scope(turn, run));
    const key = this.stepKey(run, step);
    this.endRun(turn, run, "flow");
    this.chain(turn, childId, key, target.input ?? run.input, run.hop + 1);
  }

  /** Start a child flow that holds the floor and moves in this same phase. */
  private chain(turn: Turn<C, D>, flowId: string, key: string, input: unknown, hop: number, keepData = false): void {
    const child = this.flows.get(flowId);
    if (!child) {
      turn.skipped.push({ flowId, anchor: turn.session.id, triggerKey: key, detail: "pulado: fluxo desativado ou removido" });
      return;
    }
    const run = this.startRun(turn, child, "flow", key, { payload: input, hop, keepData });
    if (!run) return;
    turn.floorRunId = run.id;
    if (turn.ingesting) turn.floorFromIngest = true;
    turn.queue.push(run);
  }

  private jump(turn: Turn<C, D>, run: Run, flow: Flow<C, D>, stepId: string): void {
    if (this.stepOf(flow, stepId)) this.enter(run, stepId);
    else this.endRun(turn, run, "skipped", "pulado: passo removido");
  }

  /** Entering a step is what mints a new visit, and with it new action and message keys (I4). */
  private enter(run: Run, stepId: string): void {
    run.stepId = stepId;
    run.visits[stepId] = (run.visits[stepId] ?? 0) + 1;
    run.status = "running";
    delete run.waiting;
  }

  private finishFlow(turn: Turn<C, D>, run: Run, flow: Flow<C, D>): void {
    const onEnd = flow.onEnd ?? "end";
    const last = flow.steps[flow.steps.length - 1];
    if (onEnd === "stay" && last) {
      // "repete o último passo": the run stays live at its last step, re-entered so the repetition mints a new key, and runs it on the next message.
      this.enter(run, last.id);
      run.status = "asking";
      return;
    }
    if (onEnd === "reset" && last) {
      // The run record closes (`reason: 'reset'`) and a fresh run of the same flow starts at step one, data kept.
      // It is a chain into itself, so it costs a hop: a code-only flow that resets forever stops at the hop cap instead of spinning.
      const key = this.stepKey(run, last);
      this.endRun(turn, run, "reset");
      this.chain(turn, flow.id, key, run.input, run.hop + 1, true);
      return;
    }
    this.endRun(turn, run, "end");
  }

  private endRun(turn: Turn<C, D>, run: Run, reason: EndReason, detail?: string, kind?: StepOutcomeKind): void {
    const index = turn.session.runs.indexOf(run);
    if (index >= 0) turn.session.runs.splice(index, 1);
    if (detail) {
      const flow = this.flows.get(run.flowId);
      this.outcome(turn, run, { kind: kind ?? kindOf(flow && this.stepOf(flow, run.stepId)), status: reason === "failed" ? "failed" : "skipped", detail });
    }
    turn.ended.push({ ...run, reason });
    if (turn.talk?.run === run) turn.talk = undefined;
  }

  private park(turn: Turn<C, D>, run: Run, waiting: { kind: "timer" | "event"; key: string; event?: string }, at: Date): void {
    run.status = "waiting";
    run.waiting = { ...waiting, until: at.toISOString(), setAt: turn.nowIso };
    turn.schedule.push({ key: waiting.key, at });
  }

  /** When nobody asks, the most recently suspended run returns to asking. */
  private resumeSuspended(turn: Turn<C, D>): void {
    if (this.asker(turn)) return;
    const suspendedAt = (r: Run): string => r.suspendedAt ?? r.startedAt;
    const next = turn.session.runs
      .filter((r) => r.status === "suspended")
      .reduce<Run | undefined>((top, cur) => (top && suspendedAt(top) > suspendedAt(cur) ? top : cur), undefined);
    if (next) {
      next.status = "asking";
      delete next.suspendedAt;
    }
  }

  // ── Settle: the one applier after Speak (design §4.7) ─────────────────

  async settle(turn: Turn<C, D>, outcome: SpeakOutcome | null): Promise<void> {
    if (turn.ignored) return;
    turn.speakDone = true;
    const { talk } = turn;
    turn.talk = undefined;
    if (outcome && "deferred" in outcome) {
      turn.llmCalls += outcome.llmCalls;
      if (talk) this.deferTalk(turn, talk);
      else this.outcome(turn, undefined, { kind: "idle", status: "deferred", detail: "deferred: IA indisponível", llmCalls: outcome.llmCalls });
    } else if (outcome) {
      const { spoken } = outcome;
      turn.llmCalls += spoken.llmCalls;
      if (talk) {
        this.applySpoken(turn, talk, spoken);
        await this.drain(turn);
      } else {
        if (spoken.message) {
          turn.messages.push({ text: spoken.message, kind: "ai", afterMs: turn.afterMs, key: `idle:${turn.triggerKey}` });
          turn.afterMs = 0;
          turn.spoke = true;
        }
        Object.assign(turn.session.data, spoken.data);
        this.outcome(turn, undefined, { kind: "idle", status: "ok", key: `idle:${turn.triggerKey}`, llmCalls: spoken.llmCalls });
      }
    }
    if (turn.spoke) turn.session.lastAssistantAt = turn.nowIso;
    this.resumeSuspended(turn);
    this.armSilence(turn);
  }

  private applySpoken(turn: Turn<C, D>, talk: TalkRequest<C, D>, spoken: Spoken): void {
    const { run, flow, step } = talk;
    const key = this.stepKey(run, step);
    if (spoken.message) {
      turn.messages.push({ text: spoken.message, kind: "ai", afterMs: turn.afterMs, key, runId: run.id, stepId: step.id });
      turn.afterMs = 0;
      turn.spokeBy.add(run.id);
      turn.spoke = true;
    }
    for (const [field, raw] of Object.entries(spoken.fields)) this.writeField(turn, field, raw);
    Object.assign(turn.session.data, spoken.data);
    this.outcome(turn, run, { kind: talkKind(step), status: "ok", key, llmCalls: spoken.llmCalls, stepId: step.id });
    if (!turn.session.runs.includes(run)) return;
    if (step.collect?.length) {
      const pending = pendingFields(step, turn.session.data, run.asked);
      if (pending.length) {
        for (const field of pending) run.asked[field] = (run.asked[field] ?? 0) + 1;
        run.status = "asking";
        return;
      }
      this.reportMaxAsks(turn, run, step);
    }
    run.status = "running";
    this.follow(turn, run, flow, step, step.then);
    if (turn.session.runs.includes(run) && run.status === "running") turn.queue.push(run);
  }

  /** The provider failed: re-park the talk step under a retry wake, +1m, +5m, then +15m. */
  private deferTalk(turn: Turn<C, D>, talk: TalkRequest<C, D>): void {
    const { run, step } = talk;
    let attempt = 0;
    for (let i = run.outcomes.length - 1; i >= 0 && run.outcomes[i].status === "deferred" && run.outcomes[i].stepId === step.id; i--) attempt++;
    const backoff = RETRY_BACKOFF[Math.min(attempt, RETRY_BACKOFF.length - 1)];
    const at = new Date(turn.now.getTime() + parseDuration(backoff));
    const visit = run.visits[step.id] ?? 0;
    this.park(turn, run, { kind: "timer", key: `${run.id}:${step.id}:${visit}:retry:${at.getTime()}` }, at);
    this.outcome(turn, run, { kind: talkKind(step), status: "deferred", key: this.stepKey(run, step), detail: "deferred: IA indisponível", until: at.toISOString() });
  }

  /** The assistant spoke last: every silence flow passing `if` and `repeat` gets a wake. */
  private armSilence(turn: Turn<C, D>): void {
    const { session } = turn;
    const { lastAssistantAt, lastUserAt } = session;
    if (!lastAssistantAt || lastAssistantAt === turn.original?.lastAssistantAt) return;
    if (lastUserAt && Date.parse(lastUserAt) > Date.parse(lastAssistantAt)) return;
    const ms = Date.parse(lastAssistantAt);
    const previous = turn.original?.lastAssistantAt;
    for (const flow of this.flows.values()) {
      const trigger = (flow.on ?? []).find((t): t is SilenceTrigger<C, D> => "silence" in t);
      if (!trigger) continue;
      const key = String(ms);
      if (trigger.if && !this.holds(trigger.if, turn, this.draftRun(turn, flow, "silence", key))) continue;
      if (!this.repeatAllows(turn, flow, trigger, key)) continue;
      const at = this.snap(turn, new Date(ms + parseDuration(trigger.silence)), trigger.businessHours);
      turn.schedule.push({
        key: `silence:${flow.id}:${session.id}:${ms}`,
        at,
        ...(previous ? { replaces: `silence:${flow.id}:${session.id}:${Date.parse(previous)}` } : {}),
      });
    }
  }

  // ── Return (design §4.8) ──────────────────────────────────────────────

  finish(turn: Turn<C, D>): TurnResult<D> {
    const { session, messages, schedule, outcomes, started, ended, skipped, llmCalls } = turn;
    const changed =
      !turn.ignored &&
      (!turn.original || !deepEqual(session, turn.original) || messages.length > 0 || schedule.length > 0 || outcomes.length > 0 || skipped.length > 0);
    return { session, changed, messages, schedule, outcomes, started, ended, skipped, llmCalls };
  }
}

/** The `next` column of an outcome line: a step id, `end`, or the flow a `then` chains into. */
function nextLabel<D>(target: Next<D> | undefined): string | undefined {
  if (target === undefined) return undefined;
  if (typeof target === "string") return target;
  return "step" in target ? target.step : `flow:${target.flow}`;
}
