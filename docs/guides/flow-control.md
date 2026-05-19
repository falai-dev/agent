---
title: "Flow control"
description: "Redirect, complete, abort, or speak verbatim from a tool, hook, or webhook by emitting a directive."
type: guide
order: 3
---

# Flow control

> **Where this is introduced:** [Directives](../concepts/directives.md)

Most steps run, ask the model, write fields, and move on. Some don't.
A permission tool finds the caller is not eligible. A booking tool
finishes its work and wants the flow to end without the LLM phrasing a
confirmation. A webhook decides the next turn should start in a
different flow than where the user left off. Every one of these is the
same primitive: emit a [`Directive`](../reference/directive.md).

This guide is a tour of the recipes. Each section is a task and a
code-block that does it. The shape stays the same across all of them;
what changes is which fields you set and where the directive comes
from. The [Directive reference](../reference/directive.md) is the
canonical contract for every shorthand, object form, and validation
rule.

## The shape

```typescript
import type { Directive } from "@falai/agent";

const d: Directive = {
  goTo: "Booking",                     // position (one max)
  reply: "Routing you to booking.",    // verbatim utterance
  dataUpdate: { source: "tool" },      // state write
};
```

Every field is optional. State writes (`dataUpdate`,
`contextUpdate`) and `reply` ride alongside any position field.

## Position fields and precedence

Position answers "where does the conversation go after this turn?"

| Field      | Effect                                                                |
|------------|-----------------------------------------------------------------------|
| `goTo`     | Jump to another flow.                                                 |
| `goToStep` | Jump to a step (within this flow, or — in object form — another flow).|
| `complete` | Mark the current flow done. Run the flow's completion path.           |
| `abort`    | End the conversation. Optionally clear the session.                   |
| `reset`    | Restart the current flow. Optionally clear its declared fields.       |

The fields are **mutually exclusive** — at most one per directive.
Setting two throws `FlowConfigurationError`. When more than one
emitter writes a position field on the same turn, the per-turn merge
picks one winner by precedence:

```
abort > complete > goTo / goToStep > reset
```

`abort` always wins — there's no "somewhere else" after the
conversation has ended. `complete` beats `goTo` — if a follow-up
jump belongs after completion, put it in `complete.next`. `goTo` and
`goToStep` share a tier (last emission wins). `reset` is lowest.

State writes and `reply` ride alongside whichever position wins.

## Recipe 1 — Redirect from a tool

Tools have two ways to emit a directive: imperative (`ctx.dispatch`)
mid-handler, or declarative (`ToolResult.directive`) on return. Both
land on the same per-turn bus and merge identically.

### Imperative — `ctx.dispatch`

```typescript
import type { Tool } from "@falai/agent";

const checkEligibility: Tool<{ userId: string }, BookingData, { ok: boolean }> = {
  id: "check_eligibility",
  description: "Verify the caller is allowed to book this destination.",
  isReadOnly: () => true,
  async handler(ctx) {
    const ok = await isEligible(ctx.context.userId, ctx.data.destination);
    if (!ok) {
      ctx.dispatch({
        goTo: "Denial",
        reply: "Sorry — you're not eligible to book that destination.",
        dataUpdate: { denialReason: "ineligible" },
      });
      return { ok: false };
    }
    return { ok: true };
  },
};
```

Multiple `dispatch` calls in one handler are allowed — they
concatenate alongside emissions from other tools and hooks before the
merge runs.

### Declarative — `ToolResult.directive`

```typescript
async handler(ctx) {
  const ok = await isEligible(ctx.context.userId, ctx.data.destination);
  if (!ok) {
    return {
      data: { ok: false },
      directive: {
        goTo: "Denial",
        reply: "Sorry — you're not eligible to book that destination.",
      },
    };
  }
  return { data: { ok: true } };
}
```

Reach for **imperative** when the handler still has work after the
decision. Reach for **declarative** when there's a single return
point.

## Recipe 2 — Complete with a chained next

A booking tool reserved the room. The flow is done, and the next
thing the agent should do is open a feedback flow. `complete` accepts
an object form whose `next` field is **another directive** applied
immediately after the flow's completion path runs:

```typescript
import type { Tool, Directive } from "@falai/agent";

const bookHotel: Tool<unknown, BookingData, { id: string }> = {
  id: "book_hotel",
  description: "Reserve the hotel for the collected fields.",
  async handler(ctx, args) {
    const id = await reserve(args);
    const directive: Directive = {
      complete: {
        reason: "reservation confirmed",
        next: { goTo: "Feedback", reply: "Booked. Mind a quick survey?" },
      },
      dataUpdate: { bookingId: id },
    };
    return { data: { id }, directive };
  },
};
```

What runs, in order: the tool's directive lands on the bus, the merge
picks `complete`, the flow's `hooks.onComplete` runs, then
`complete.next` is applied — `goTo: "Feedback"` redirects with the
verbatim reply as that turn's assistant message.

`complete.next` is one level deep on purpose — chains do not nest.
For the simple case, the shorthand `complete: true` is the right
call:

```typescript
return { data, directive: { complete: true, dataUpdate: { bookingId: id } } };
```

## Recipe 3 — Abort on a permission failure

`abort` ends the conversation. Use it when there's no flow to
redirect *to*:

```typescript
import type { Tool, Directive } from "@falai/agent";

const verifyAccess: Tool = {
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

Two things to know:

- **`abort` cannot co-exist with `reply`.** Aborted conversations
  don't deliver replies. To say something on the way out, use
  `complete` plus `reply` instead.
- **`clearSession: true`** purges the session at the next persistence
  write. Without it, the aborted session sticks around for traces.

## Recipe 4 — Reply verbatim from a finalize hook

Some utterances should be exact: confirmations, bridges, refusals,
boilerplate at flow boundaries. `reply: string` skips the LLM and
emits the literal text — no templating, no model rephrasing.

```typescript
import type { Directive } from "@falai/agent";

const step = {
  id: "confirm_handoff",
  prompt: "Confirm the handoff if the queue is clear.",
  hooks: {
    finalize: ({ data }): Directive | void => {
      if (data.handoffReady) {
        return { reply: "Connecting you with a specialist now." };
      }
    },
  },
};
```

The turn ends with `stoppedReason: "reply"` and the literal string as
`response.message`. State writes and a position field can ride
alongside:

```typescript
finalize: ({ data }) => {
  if (data.bookingId) {
    return {
      reply: `Booked. Confirmation: ${data.bookingId}.`,
      dataUpdate: { confirmedAt: new Date().toISOString() },
      complete: true,
    };
  }
}
```

That single directive does three things at once. They're orthogonal
payloads — `reply`, `dataUpdate`, and the position field don't
compete for the same slot.

To skip the LLM **before** it runs (rather than from a finalize hook
*after*), use a [`PreDirective`](../reference/pre-directive.md) from
a prepare hook with `halt: true` — see below.

## PreDirective extras (pre-LLM only)

Pre-LLM hooks (`flow.hooks.onEnter`, `step.hooks.onEnter`,
`step.hooks.prepare`) return a [`PreDirective`](../reference/pre-directive.md) —
the `Directive` variant with three extra fields that only make sense
before this turn's LLM call.

```typescript
interface PreDirective extends Directive {
  appendPrompt?: string[];
  injectTools?: Tool[];
  halt?: boolean;
}
```

Lifetime is one turn. None of the three fields persist on
`session.pendingDirective` — they're stripped before the write.
Returning a PreDirective from a post-LLM hook drops these fields with
a debug log.

### `appendPrompt` — nudge the system prompt

```typescript
const flow = {
  title: "Booking",
  hooks: {
    onEnter: (ctx) => {
      if (ctx.context.user.tier === "vip") {
        return { appendPrompt: ["Caller is a VIP — confirm preferences first."] };
      }
    },
  },
};
```

Each string is appended to the system prompt for this turn only.
Multiple emitters' arrays concatenate in emission order; duplicates
are preserved.

### `injectTools` — one-shot tool surface

```typescript
const step = {
  id: "verify",
  prompt: "Verify the caller before proceeding.",
  hooks: {
    prepare: async (ctx) => {
      if (!ctx.data.verified) return { injectTools: [lookupAccount] };
    },
  },
};
```

Tools listed here are added for this turn only. Multiple emitters'
arrays concatenate, then dedupe by `Tool.id` (last definition wins).

### `halt` — skip the LLM call

```typescript
prepare: async (ctx) => {
  if (ctx.data.alreadyVerified) {
    return { halt: true, reply: "Already verified. How can I help?" };
  }
}
```

When any pre-phase emitter sets `halt: true`, the LLM call is
skipped. With `reply`, the turn ends `stoppedReason: "reply"`. Without
`reply`, the turn ends `stoppedReason: "halt"` and an empty body.
Multiple emitters merge by logical-OR.

## Recipe 5 — Dispatch from outside a turn

Tools and hooks emit directives onto the **per-turn** bus. Sometimes
the redirect comes from outside any turn — a webhook fires, a
scheduled job notices an idle session, an external system marks a
caller upgraded. There's no turn running, so there's no bus.

`Agent.dispatch(target, session)` writes a `pendingDirective` onto
the session without invoking a turn. The directive is consumed at the
**start of the next** `respond` call — before routing, before
pre-extraction, before any phase runs.

```typescript
// Webhook handler: redirect a session from outside a turn.
import type { Directive } from "@falai/agent";

app.post("/webhook/account-upgraded", async (req, res) => {
  const session = await agent.session.getOrCreate(req.body.sessionId);
  await agent.dispatch(
    { goTo: "VipFlow", reply: "You've been upgraded. Let's start fresh." },
    session
  );
  res.sendStatus(204);
});
```

Two forms:

```typescript
// String shorthand — desugars to { goTo: "Feedback" }
await agent.dispatch("Feedback", session);

// Full directive
await agent.dispatch({ goTo: "Billing", reply: "Transferring you now." }, session);
```

The call validates the directive (`flow.validate`), confirms any
`goTo`-named flow exists (throws `FlowConfigurationError` if not),
strips PreDirective-only fields, writes `pendingDirective` onto the
session, and persists if an adapter is configured.

`pendingDirective` is **single-shot** — consumed exactly once and
cleared. Calling `dispatch` again before the next turn overwrites the
previous one (last-wins). To merge with a pending directive instead
of overwriting, use `flow.merge`:

```typescript
import { flow } from "@falai/agent";

const merged = flow.merge(
  session.pendingDirective ?? {},
  { dataUpdate: { tier: "vip" } }
);
await agent.dispatch(merged, session);
```

## Picking the right tool

Where to emit:

| You're in a... | Type | Use |
|----------------|------|-----|
| Tool handler, mid-flight | `Directive` | `ctx.dispatch(d)` |
| Tool handler, on return | `Directive` | `return { data, directive: d }` |
| `prepare` / `onEnter` hook | `PreDirective` | `return d` |
| `finalize` / `onComplete` hook | `Directive` | `return d` |
| Branch `then` target | `Directive` | `then: d` (see [Branching](./branching.md)) |
| Outside a turn (webhook, job) | `Directive` | `await agent.dispatch(d, session)` |

Which position field:

- Inside the same flow → `goToStep`.
- Another flow → `goTo` (or `goToStep` with `flow:` set).
- Work is done → `complete` (with `complete.next` for follow-ups).
- No path forward → `abort` (`clearSession: true` if reuse is unsafe).
- Start the flow over → `reset`.

Code or model speaking:

- Verbatim → set `reply`.
- From the model → leave `reply` unset; let the LLM call run.

## See also

- [Directive reference](../reference/directive.md) — every field,
  every shorthand, every validation rule.
- [PreDirective reference](../reference/pre-directive.md) —
  pre-LLM-only fields and merge rules.
- [Directives concept](../concepts/directives.md) — the mental model
  and the inheritance chain.
- [Branching](./branching.md) — when the redirect is source-local
  rather than dynamic.
- [Turn pipeline](../concepts/pipeline.md) — when and where directives
  apply within a turn.

**Next:** [Instructions](./instructions.md)
