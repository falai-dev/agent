---
title: "Directive"
description: "Flat shape returned by tools and hooks to write state, redirect the conversation, or speak verbatim."
type: reference
order: 6
---

# Directive

> **Where this is introduced:** [Directives](../concepts/directives.md)

A `Directive<TContext, TData>` is the single shape any tool, hook, or branch returns when it wants to write state, change position, or speak verbatim. It is a **flat object literal** — not a discriminated union, not a class, not a builder. Every field is optional. Every directive is plain JSON-serializable data (PreDirective adds non-serializable extensions; see [PreDirective](./pre-directive.md)).

A directive carries up to four orthogonal payloads:

- **One position field** — `goTo`, `goToStep`, `complete`, `abort`, or `reset`. Where to send the conversation. Mutually exclusive: at most one per directive.
- **State writes** — `dataUpdate` and/or `contextUpdate`. Shallow-merged into `session.data` and `session.context` before the next phase runs.
- **A verbatim reply** — `reply`. The literal assistant utterance, bypassing the LLM.
- **Per-position observability** — `reason` strings inside the object forms of position fields, surfaced in event traces and the directive chain log.

Multiple directives emitted during the same turn are collected onto the per-turn bus and merged by Algorithm 4 (see [Merge rules](#merge-rules) below).

## Signature

```typescript
interface Directive<TContext = unknown, TData = unknown> {
  // ── Position fields (mutually exclusive: at most one) ────────────
  goTo?:
    | string
    | {
        flow?: string;
        step?: string;
        data?: Partial<TData>;
        reason?: string;
        carry?: "preserve" | "reset";
      };

  goToStep?:
    | string
    | { step: string; flow?: string; data?: Partial<TData>; reason?: string };

  complete?:
    | true
    | { next?: Directive<TContext, TData>; reason?: string };

  abort?:
    | string
    | { reason: string; clearSession?: boolean };

  reset?:
    | true
    | { step?: string; clearData?: boolean; reason?: string };

  // ── Verbatim utterance ───────────────────────────────────────────
  reply?: string;

  // ── State writes (shallow-merged, both phases) ───────────────────
  contextUpdate?: Partial<TContext>;
  dataUpdate?: Partial<TData>;
}
```

## Fields

### Position fields

Exactly **zero or one** position field may be set per directive. Setting two or more is a runtime configuration error (see [Errors](#errors)). When zero are set, the directive is purely a state write or a verbatim reply.

| Field | Shorthand | Object form | Notes |
|-------|-----------|-------------|-------|
| `goTo` | `string` (flow id / title) | `{ flow?, step?, data?, reason?, carry? }` | Jump to another flow. The string form is sugar for `{ flow: <string> }`. `carry: 'reset'` clears the destination flow's `requiredFields`/`optionalFields` on entry; `carry: 'preserve'` (default) preserves them. `data` is shallow-merged into `session.data` before entry. |
| `goToStep` | `string` (step id in the current flow) | `{ step, flow?, data?, reason? }` | Jump to a step. The bare string form targets the current flow only — for cross-flow steps, use the object form with `flow`. |
| `complete` | `true` | `{ next?, reason? }` | Mark the current flow complete. `next` is a chained `Directive` applied immediately after completion (e.g. transition to a follow-up flow). Equivalent to satisfying all `requiredFields`. |
| `abort` | `string` (reason) | `{ reason, clearSession? }` | End the conversation. The string form is sugar for `{ reason: <string> }`. When `clearSession: true`, the session is cleared at the next persistence write. `reply` cannot co-exist with `abort` — an aborted conversation cannot deliver a reply. |
| `reset` | `true` | `{ step?, clearData?, reason? }` | Restart the current flow. `step` re-enters at a specific step (default: initial). `clearData: true` clears every field declared in the flow's `requiredFields` and `optionalFields`. |

Each object form carries an optional `reason: string`. The reason is **observability-only** — it appears in the per-turn directive chain log and `AgentResponse.directiveChain` so traces are self-explaining, and it is stored on the corresponding event so post-mortems can read it. It does not influence routing, merging, or any pipeline decision.

### State writes

| Field | Type | Phase | Notes |
|-------|------|-------|-------|
| `dataUpdate` | `Partial<TData>` | both | Shallow-merged into `session.data`. Triggers `flow.hooks.onDataUpdate` and `Agent` data hooks. Across multiple emitters this turn, key collisions resolve last-write-wins. |
| `contextUpdate` | `Partial<TContext>` | both | Shallow-merged into `session.context`. Triggers `flow.hooks.onContextUpdate` and `Agent` context hooks. Last-write-wins on key collision. |

Shallow-merge means each top-level key is replaced wholesale. To update a nested object, read it from `data`/`context`, merge in code, and write back the full sub-object. Deep merge is intentionally not provided — it would silently disagree with TypeScript's `Partial<>` shape.

### `reply`

`reply: string` is the verbatim assistant utterance. When set, the LLM call is skipped this turn and the string is emitted as the assistant message exactly as written. Templating is not applied — `reply` is the rendered output.

`reply` co-validates with two fields:

- **`abort`** — co-existence is rejected at validation. Aborted conversations cannot deliver a reply.
- **`halt`** (PreDirective only) — when both are set, `reply` becomes the assistant output and the turn ends with `stoppedReason: 'reply'`. When `halt` is set without `reply`, the turn ends with `stoppedReason: 'halt'` and an empty assistant message.

Across multiple emitters this turn, `reply` is **last-wins** — the most recent emission overrides earlier ones, with a `DEBUG` log when more than one emitter set it.

## Merge rules

Directives emitted during one turn — by tools (return value or `ctx.dispatch`), prepare/finalize hooks, onEnter/onComplete hooks, and signal handlers — are collected onto a per-phase bus and merged into a single applied directive. The bus runs in two phases (pre-LLM and post-LLM); merge rules are identical for both.

| Field group | Merge rule |
|-------------|-----------|
| Position fields (`goTo`, `goToStep`, `complete`, `abort`, `reset`) | **Winner-takes-all by precedence:** `abort > complete > goTo / goToStep > reset`. Among entries of the same precedence, last emission wins. A `DEBUG` log records all losers. |
| `reply` | **Last-wins.** Most recent non-empty `reply` overrides earlier ones. `DEBUG` log when more than one was set. |
| `dataUpdate`, `contextUpdate` | **Shallow-merged across all emitters.** Last-write-wins on key collision. Always applied — never overridden by position fields. |
| `appendPrompt` (PreDirective) | **Concatenated** in emission order. |
| `injectTools` (PreDirective) | **Concatenated, then deduped by `Tool.id`** (last definition wins). |
| `halt` (PreDirective) | **Logical-OR.** Any emitter setting `halt: true` halts the turn. |

The full algorithm is implemented by `flow.merge(a, b)`. See [`flow` namespace](#flow-namespace) below.

> Branches **do not** participate in this bus. When a branch's `then` resolves to a `Directive`, it is applied via `applyDirective` directly, bypassing merge. The bus winner (if any) wins over branch evaluation: if the post-LLM bus produced a position field, branches don't run on that turn. See [Branches](./branches.md).

## `flow` namespace

The `flow` namespace exports three runtime helpers for working with directives. There are no constructor builders — directives are plain object literals.

```typescript
import { flow } from "@falai/agent";

flow.isDirective(x);     // type guard
flow.merge(a, b);        // Algorithm 4 merge of two directives
flow.validate(d);        // throws FlowConfigurationError on invalid shape
```

| Helper | Signature | Notes |
|--------|-----------|-------|
| `flow.isDirective` | `(x: unknown) => x is Directive` | Structural type guard. Returns `true` for any non-null, non-array object. Filters out primitives, null/undefined, arrays, and functions. |
| `flow.merge` | `<T extends Directive>(a: T, b: T) => T` | Merges by Algorithm 4. Position field uses precedence (b wins on tie). `reply` is last-wins. State writes shallow-merge. PreDirective fields concatenate / dedupe / OR per the table above. |
| `flow.validate` | `(d: Directive) => void` | Throws `FlowConfigurationError` for: multiple position fields set; `goTo` set as an empty object `{}`; `reply` co-existing with `abort`. |

## Examples

### 1. Simple `goTo`

A finalize hook redirects to a follow-up flow when a flag flips on the response.

```typescript
import type { Directive } from "@falai/agent";

const step = {
  id: "summary",
  prompt: "Summarize the request.",
  hooks: {
    finalize: ({ data }): Directive | void => {
      if (data.escalate) {
        return { goTo: "Escalation", reason: "summary marked escalate=true" };
      }
    },
  },
};
```

### 2. `complete` with `dataUpdate`

A booking tool finalizes its work and writes back the booking id while marking the flow done in one declarative result.

```typescript
import type { Tool, Directive } from "@falai/agent";

export const bookHotel: Tool = {
  id: "book_hotel",
  description: "Reserve the collected dates.",
  async handler(ctx) {
    const id = await api.book(ctx.data);
    const directive: Directive = {
      complete: { reason: "reservation confirmed" },
      dataUpdate: { bookingId: id, bookedAt: new Date().toISOString() },
    };
    return { data: { id }, directive };
  },
};
```

### 3. `abort`

A permission tool halts the conversation when the caller cannot proceed. Note that `reply` cannot accompany `abort`; the abort reason itself is what's recorded.

```typescript
import type { Tool, Directive } from "@falai/agent";

export const verifyAccess: Tool = {
  id: "verify_access",
  isReadOnly: () => true,
  async handler(ctx) {
    const allowed = await acl.check(ctx.context.userId);
    if (!allowed) {
      const directive: Directive = {
        abort: { reason: "caller is not on the allow-list", clearSession: true },
      };
      return { data: { allowed: false }, directive };
    }
    return { data: { allowed: true } };
  },
};
```

### 4. `reply` only — speak verbatim, write nothing

A finalize hook emits a confirmation utterance without changing position or writing state. The LLM call this turn is skipped; the literal string is the assistant message.

```typescript
import type { Directive } from "@falai/agent";

const step = {
  id: "confirm_handoff",
  hooks: {
    finalize: ({ data }): Directive | void => {
      if (data.handoffReady) {
        return { reply: "Connecting you with a specialist now." };
      }
    },
  },
};
```

## Errors

`flow.validate(directive)` and the per-turn merge stage throw `FlowConfigurationError` for the following invariants. See [Errors](./errors.md) for the format contract.

| Cause | Message shape |
|-------|---------------|
| Multiple position fields set on one directive | `[FlowConfigurationError] Invalid directive: multiple position fields set (...). A directive may have at most one position field. Remove the extras.` |
| `goTo` set as an empty object `{}` | `[FlowConfigurationError] Invalid directive: goTo is set as an empty object. goTo requires a flow id or title. Provide { flow: "<id>" } or use the string shorthand.` |
| `reply` co-existing with `abort` | `[FlowConfigurationError] Invalid directive: reply cannot co-exist with abort. An aborted conversation cannot deliver a reply. Remove one of the fields.` |

Two related runtime behaviors are notable but **not** thrown errors:

- Returning a `PreDirective` (with `appendPrompt` / `injectTools` / `halt`) from a post-LLM hook (`finalize`, `onComplete`) drops those three fields with a `DEBUG` log; the remaining `Directive` portion is honored.
- A `goTo` / `goToStep` referencing an unknown flow or step throws `FlowConfigurationError` at apply time, not at validation time — the validator does not have the agent's flow registry.

## Related

- [Directives](../concepts/directives.md) — the mental model and inheritance chain `Directive → PreDirective → SignalDirective`.
- [Turn pipeline](../concepts/pipeline.md) — when the bus runs, and where merge sits in the per-turn sequence.
- [Flow control](../guides/flow-control.md) — recipes for redirecting, completing, aborting, or replying from tools and hooks.
- [PreDirective](./pre-directive.md) — pre-LLM extension adding `appendPrompt`, `injectTools`, `halt`.
- [Signals](./signals.md) — `SignalDirective` extends `PreDirective` for signal handlers.
- [Tool](./tool.md) — `ctx.dispatch(directive)` and `ToolResult.directive`.
- [Branches](./branches.md) — `then: Directive` as a branch target (note: branches bypass the bus).
- [Errors](./errors.md) — `FlowConfigurationError` format contract.
