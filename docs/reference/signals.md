---
title: "Signals"
description: "Typed event detectors that run before and after each LLM turn, with optional structured extraction and rate-limited firing."
type: reference
order: 9
---

# Signals

> **Where this is introduced:** [Turn pipeline](../concepts/pipeline.md)

A `Signal` is a typed event detector that runs around an LLM turn. Each signal pairs a *condition* (`when` / `if`) with a *handler* that returns a `SignalDirective`. Signals optionally carry an `extract` schema for structured data extraction beyond boolean detection, run at two pipeline phases (PRE-SIGNAL parallel with routing, POST-SIGNAL after the LLM), are rate-limited (`once` / `always` / `cooldown`), and surface their firings on `AgentResponse.triggeredSignals`.

Signals operate in two modes:

- **Detection mode** — no `extract`. Boolean match/no-match via a batched classifier call. Multiple signals share one LLM call.
- **Extraction mode** — `extract` set. Structured data extraction merged into the same batched call. The handler receives `ctx.extracted` typed by the `TExtract` generic.

When `agent.signals` is empty or undefined, both phases short-circuit to zero cost — no extra provider calls.

## Signature

```typescript
interface Signal<TContext = unknown, TData = unknown, TExtract = void> {
  // Identity
  id?: string;
  title?: string;
  description?: string;

  // Conditions (v2 when/if split)
  when?: string | string[];
  if?: SignalPredicate<TContext, TData> | SignalPredicate<TContext, TData>[];

  // Optional structured extraction
  extract?: SignalSchema<TExtract>;

  // Phase + handler
  phase: 'pre' | 'post' | 'both';
  handler: (ctx: SignalContext<TContext, TData, TExtract>) =>
    | void
    | SignalDirective<TContext, TData>
    | Promise<void | SignalDirective<TContext, TData>>;

  // Rate limiting
  behavior?: 'once' | 'always' | 'cooldown';
  cooldownMs?: number;

  // Misc
  enabled?: boolean;
  priority?: number;
}

type SignalSchema<_T = unknown> = Record<string, unknown>;

type SignalPredicate<TContext = unknown, TData = unknown> = (
  ctx: SignalPredicateContext<TContext, TData>,
) => boolean | Promise<boolean>;

interface SignalPredicateContext<TContext = unknown, TData = unknown> {
  data: Partial<TData>;
  context: TContext;
  session: SessionState<TData>;
  history: Event[];
}

interface SignalContext<TContext = unknown, TData = unknown, TExtract = void> {
  signal: Signal<TContext, TData, TExtract>;
  phase: 'pre' | 'post';
  matched: true;
  reason: string;
  extracted: TExtract extends void ? undefined : TExtract;

  session: SessionState<TData>;
  context: TContext;
  data: Partial<TData>;
  history: Event[];
  lastUserMessage?: string;
  triggeredAt: Date;

  updateContext(updates: Partial<TContext>): Promise<void>;
  updateData(updates: Partial<TData>): Promise<void>;
  dispatch(directive: SignalDirective<TContext, TData>): void;
}

interface SignalDirective<TContext = unknown, TData = unknown>
  extends PreDirective<TContext, TData> {
  stopOtherSignals?: boolean;
  replyWith?: string | ((ctx: SignalContext<TContext, TData>) => string);
}

interface SignalFiring<TContext = unknown, TData = unknown> {
  id: string;
  phase: 'pre' | 'post';
  reason?: string;
  extracted?: unknown;
  directive?: SignalDirective<TContext, TData>;
  handlerError?: string;
  durationMs?: number;
}

interface SignalsState {
  triggers: Record<string, SignalTriggerState>;
}

interface SignalTriggerState {
  firstTriggeredAt: Date;
  lastTriggeredAt: Date;
  count: number;
  lastReason?: string;
  lastPhase?: 'pre' | 'post';
}
```

Signals are wired into the agent through two `AgentOptions` fields:

```typescript
interface AgentOptions<TContext, TData> {
  // ... other fields ...
  signals?: Signal<TContext, TData, unknown>[];
  signalBatchSize?: number; // default 10
}
```

## Fields

### `Signal`

| Field | Type | Required | Default | Notes |
|-------|------|----------|---------|-------|
| `id` | `string` | no | auto-generated | Stable identifier within a session. Used for `SignalsState.triggers` keying and on `SignalFiring`. Must be unique across the agent's signals. |
| `title` | `string` | no | — | Display title shown in logs and traces. |
| `description` | `string` | no | — | Free-text description; rendered into the classifier prompt. |
| `when` | `string \| string[]` | no | — | AI-evaluated condition(s). Entries prefixed with `!` are exclusion conditions rendered under "DO NOT TRIGGER WHEN" (OR semantics — any match inhibits firing). Non-prefixed entries render under "TRIGGER WHEN" (AND semantics — all must match). |
| `if` | `SignalPredicate \| SignalPredicate[]` | no | — | Code predicate(s). AND semantics. Free to evaluate. Runs before `when`; if any returns `false`, `when` is skipped (no token cost). |
| `extract` | `SignalSchema<TExtract>` | no | — | When set, the signal operates in extraction mode. JSON Schema object describing the per-signal `extracted` field merged into the classifier response. The `TExtract` generic carries the resulting type onto `ctx.extracted`. |
| `phase` | `'pre' \| 'post' \| 'both'` | yes | — | When the signal evaluates. `'pre'` runs in parallel with routing. `'post'` runs after the LLM call, before persistence. `'both'` evaluates in both phases. |
| `handler` | `(ctx) => void \| SignalDirective \| Promise<…>` | yes | — | Invoked when the signal fires. May return a directive, dispatch one via `ctx.dispatch`, or return void for side-effect-only behavior. |
| `behavior` | `'once' \| 'always' \| 'cooldown'` | no | `'always'` | Rate-limit / dedup mode. `'once'` fires once per session. `'cooldown'` requires `cooldownMs`. |
| `cooldownMs` | `number` | conditional | — | Required when `behavior === 'cooldown'`. Suppresses re-firing for this duration after the last trigger. Misconfiguration logs a debug warning and falls back to `'always'`. |
| `enabled` | `boolean` | no | `true` | When `false`, the signal is filtered out at the start of the phase. |
| `priority` | `number` | no | `0` | Higher priority handlers run first within a phase. Ties break by declaration order in `agent.signals`. |

### `SignalPredicateContext`

Passed to every `if` predicate. Symmetric with `BranchPredicateContext`.

| Field | Type | Notes |
|-------|------|-------|
| `data` | `Partial<TData>` | Collected data so far. Fields not yet collected are `undefined`. |
| `context` | `TContext` | Ambient agent context. |
| `session` | `SessionState<TData>` | Full session state, including `session.signals` for inspecting prior triggers. |
| `history` | `Event[]` | Conversation history as native events. |

A predicate that throws is treated as a non-match — other signals continue evaluating.

### `SignalContext`

Passed to handlers when a signal fires. Symmetric with `ToolContext`.

| Field | Type | Notes |
|-------|------|-------|
| `signal` | `Signal<TContext, TData, TExtract>` | The signal definition that fired. |
| `phase` | `'pre' \| 'post'` | Which phase this firing belongs to. Useful when `signal.phase === 'both'`. |
| `matched` | `true` | Always `true` when the handler runs. Typed for narrowing. |
| `reason` | `string` | AI rationale when `when` matched, or `'code-only'` / `'unconditional'`. |
| `extracted` | `TExtract extends void ? undefined : TExtract` | Extracted data when `signal.extract` is set; `undefined` for detection-only signals. |
| `session` | `SessionState<TData>` | Session state. Use writers below for mutations. |
| `context` | `TContext` | Ambient agent context. |
| `data` | `Partial<TData>` | Collected data (partial). |
| `history` | `Event[]` | Conversation history. |
| `lastUserMessage` | `string \| undefined` | Convenience accessor for the most recent user message. |
| `triggeredAt` | `Date` | Wall-clock timestamp when the handler started. |
| `updateContext` | `(updates) => Promise<void>` | Shallow-merge into `context`. Same contract as `ToolContext.updateContext`. |
| `updateData` | `(updates) => Promise<void>` | Shallow-merge into `data`. Same contract as `ToolContext.updateData`. |
| `dispatch` | `(directive) => void` | Emit a `SignalDirective` onto the per-turn bus. May be called multiple times; emissions merge by Algorithm 4 alongside hook and tool directives. |

### `SignalDirective`

Extends [`PreDirective`](./pre-directive.md), which extends [`Directive`](./directive.md). All position fields (`goTo`, `goToStep`, `complete`, `abort`, `reset`), state writes (`dataUpdate`, `contextUpdate`), `reply`, and PreDirective extras (`appendPrompt`, `injectTools`, `halt`) are inherited unchanged.

| Added field | Type | Notes |
|-------------|------|-------|
| `stopOtherSignals` | `boolean` | When `true`, skip remaining signals in the current phase after this handler. Does not affect the other phase. Consumed inside the signal pipeline — does not enter the directive bus. |
| `replyWith` | `string \| ((ctx) => string)` | Late-binding `reply`. String form is identical to `Directive.reply`. Function form is evaluated at emit time and projected onto `reply` before bus merging. |

**Post-phase drop rules.** When a signal runs in the post-phase, `appendPrompt`, `injectTools`, and `halt` are dropped with a debug warning — they have no meaning after the LLM call has already completed. Position directives in the post-phase set `session.pendingDirective` for the *next* turn (no mid-turn re-entry).

### `SignalFiring`

One entry per signal that fired this turn. Populated in fire order across both phases on `AgentResponse.triggeredSignals` (and on the final chunk of `AgentResponseStreamChunk`). Mirrors the observability framing of `executedSteps` and `appliedInstructions`.

| Field | Type | Notes |
|-------|------|-------|
| `id` | `string` | The signal's identifier. |
| `phase` | `'pre' \| 'post'` | Phase the signal fired in. |
| `reason` | `string \| undefined` | AI rationale, `'code-only'`, or `'unconditional'`. |
| `extracted` | `unknown` | Extracted payload when in extraction mode. |
| `directive` | `SignalDirective \| undefined` | The directive returned (or dispatched) by the handler. |
| `handlerError` | `string \| undefined` | Error message if the handler threw. The turn continues — handler errors never break a turn. |
| `durationMs` | `number \| undefined` | Wall-clock duration of the handler invocation. |

### `SignalsState` and `SignalTriggerState`

Persisted on `session.signals`. Adapters preserve this shape bit-identical.

`SignalsState` has a single field, `triggers: Record<string, SignalTriggerState>`, keyed by `signal.id`.

| `SignalTriggerState` field | Type | Notes |
|----------------------------|------|-------|
| `firstTriggeredAt` | `Date` | When this signal first fired in the session. Never updated on subsequent fires. |
| `lastTriggeredAt` | `Date` | When this signal last fired. Drives `cooldown` arithmetic. |
| `count` | `number` | Total fires for this signal in this session. Monotonically increasing. |
| `lastReason` | `string \| undefined` | The `reason` from the most recent firing. |
| `lastPhase` | `'pre' \| 'post' \| undefined` | The phase of the most recent firing. |

### `signalBatchSize`

Maximum signals per batched classifier call. Default `10`. When more LLM-conditioned signals are eligible after gating, they split into parallel batches of this size — each batch is one provider call, all batches run via `Promise.all`. Setting this to `0` or a non-integer throws `FlowConfigurationError` at agent construction.

## Phase semantics

| Capability | Pre-phase | Post-phase |
|---|---|---|
| `halt` | Skips the LLM call | Dropped with debug warning |
| `reply` / `replyWith` | Replaces the message that would have been generated | Replaces the message that was just generated |
| `goTo` / `goToStep` | Overrides routing for this turn | Sets `pendingDirective` for next turn |
| `complete` | This turn closes the flow | Same |
| `appendPrompt` | Injected into this turn's response prompt | Dropped with debug warning |
| `injectTools` | Available to this turn's LLM | Dropped with debug warning |
| `dataUpdate` / `contextUpdate` | Applied before LLM, visible in prompt | Applied, persisted |
| `extract` results | Available to handler pre-LLM | Available to handler post-LLM |
| `stopOtherSignals` | Stops further pre-signals | Stops further post-signals |

### Resolution precedence within a turn

Per turn, position decisions are resolved in this fixed order:

1. **`session.pendingDirective`** (set last turn or via `agent.dispatch()`) — consumed first.
2. **PRE-SIGNAL phase directives** (parallel with routing). Position fields override routing; `halt` discards routing entirely.
3. **AI routing** — used only if (1) and (2) produced no position field.
4. **Auto-step chain.**
5. **Step branches.**
6. **Linear successor / AI step selection** — final fallback.
7. **POST-SIGNAL phase directives** — set `pendingDirective` for the *next* turn.

## Examples

### 1. Pre-phase halt with verbatim reply (escalation)

A handoff signal that intercepts the turn before the LLM runs, notifies a side channel, and replies with a fixed message. Cooldown prevents re-notification within the hour.

```typescript
import type { Signal } from "@falai/agent";

type Ctx = { conversationId: string };
type Data = { topic?: string };

export const humanHandoff: Signal<Ctx, Data> = {
  id: "human_handoff",
  title: "Human handoff requested",
  description: "Lead asks to talk to a real person.",
  when: [
    "the user explicitly asks to talk to a human, agent, or representative",
    "the user explicitly says they do not want to talk to a bot",
    "!casual mentions of people (e.g., 'my colleague said')",
    "!general frustration without an explicit handoff request",
  ],
  phase: "pre",
  behavior: "cooldown",
  cooldownMs: 60 * 60_000, // 1 hour
  priority: 100,
  async handler({ session, lastUserMessage }) {
    await notifyTeam(session.id, lastUserMessage);
    return {
      halt: true,
      replyWith: "I'm connecting you with someone from our team. They'll reach out shortly.",
      stopOtherSignals: true,
    };
  },
};
```

### 2. Post-phase extraction (entity capture)

A signal that runs after every LLM turn, extracts a structured payload, and writes it back into collected data. No `when` — it's gated by `if` on session state, then unconditionally extracts when eligible.

```typescript
import type { Signal } from "@falai/agent";

type Data = { leadStage?: "cold" | "warm" | "hot" | "closing" };

export const leadStage: Signal<unknown, Data, { stage: Data["leadStage"]; confidence: number }> = {
  id: "lead_stage",
  title: "Lead stage classification",
  if: ({ session }) => (session.history?.length ?? 0) > 5,
  extract: {
    type: "object",
    properties: {
      stage: { type: "string", enum: ["cold", "warm", "hot", "closing"] },
      confidence: { type: "number", minimum: 0, maximum: 1 },
    },
    required: ["stage", "confidence"],
  },
  phase: "post",
  behavior: "always",
  async handler({ extracted, updateData }) {
    if (extracted.confidence >= 0.6) {
      await updateData({ leadStage: extracted.stage });
    }
  },
};
```

### 3. Cooldown behavior

A pre-phase signal that nudges the next prompt with a tone hint, suppressed for two minutes after each fire so a frustrated user isn't re-flagged on every turn.

```typescript
import type { Signal } from "@falai/agent";

export const frustrationDetected: Signal = {
  id: "frustration_detected",
  when: "the user is visibly frustrated, impatient, or upset",
  phase: "pre",
  behavior: "cooldown",
  cooldownMs: 2 * 60_000, // 2 minutes
  async handler({ dispatch }) {
    dispatch({
      appendPrompt: ["The user is frustrated. Lead with empathy and acknowledge the issue."],
    });
  },
};
```

## Errors

Misuse surfaces as typed errors:

- `FlowConfigurationError` — duplicate `id` across `agent.signals`, invalid `extract` schema (not a JSON Schema object), `signalBatchSize` not a positive integer, or a position directive (`goTo` / `goToStep`) that resolves to an unknown flow or step.
- `DataValidationError` — `dataUpdate` (or `extracted` written via `updateData`) violates the agent schema.

Soft failures handled in-band (no thrown error, turn continues):

- **Handler throws** — recorded as `firings[i].handlerError`; iteration continues with the next signal.
- **Classifier call fails** — all LLM-conditioned signals in that batch are treated as non-match; code-only and unconditional signals continue normally.
- **Post-phase emits pre-LLM-only fields** (`halt` / `appendPrompt` / `injectTools`) — dropped with debug warning.
- **`behavior: 'cooldown'` with no `cooldownMs`** — debug warning at construction; runtime treats as `'always'`.

## Related

- [Turn pipeline](../concepts/pipeline.md) — where signal phases sit in the turn lifecycle.
- [Directives](../concepts/directives.md) — the inheritance chain Directive → PreDirective → SignalDirective.
- [Directive](./directive.md) — base shape for all position and state fields.
- [PreDirective](./pre-directive.md) — pre-LLM extras inherited by `SignalDirective`.
- [createAgent](./create-agent.md) — `signals` and `signalBatchSize` options.
- [Errors](./errors.md) — `FlowConfigurationError` format contract.
