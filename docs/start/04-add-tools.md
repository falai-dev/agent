---
title: "Add tools"
description: "Extend the booking agent with tools that book the room, gate eligibility, and redirect on failure."
type: tutorial
order: 4
---

# Add tools

So far the agent talks. Now it acts. You will add a tool that books a hotel room and a tool that checks whether the user is allowed to book at all. Along the way you will see how `ctx.dispatch` and `ToolResult.directive` both land on the same directive bus, and why most tools only need an `id` and a `handler` to start.

So far the agent only collects fields. This page adds two tools:

- `book_hotel` — runs once the required fields are in, returns a
  booking id, and (optionally) finishes the flow with a directive.
- `check_eligibility` — runs early and redirects to a denial flow
  when the caller is not allowed. You'll see both forms of
  redirection: imperative (`ctx.dispatch`) and declarative
  (`ToolResult.directive`).

You'll also meet the optional metadata fields — `isReadOnly`,
`validateInput`, `checkPermissions` — that let tools opt into safer
defaults when you need them.

> Tool surface used here is the canonical [Tool reference](../reference/tool.md).
> `Tool.id` is the sole identifier — there's no separate `name`.

## Recap: where we left off

`docs/start/03-collect-data.md` left us with a `Book Hotel` flow that
collects `destination`, `checkIn`, and `guests`, and a `confirm` step
that waits until all three are populated. We'll hand the `confirm`
step a tool that actually books the room, plus an eligibility check
to gate it.

```typescript
interface BookingData {
  destination: string;
  checkIn: string;
  guests: number;
  bookingId?: string;
}
```

## 1. Add `book_hotel`

A tool is an object with an `id`, an optional `description` and
`parameters` schema, and a `handler` that returns the result the AI
will see. The handler receives a `ToolContext` (`ctx`) — the read
surface over `data`, `context`, and the session.

```typescript
import type { Tool } from "@falai/agent";

const bookHotel: Tool<unknown, BookingData, { bookingId: string }> = {
  id: "book_hotel",
  description: "Reserve the hotel for the collected destination, dates, and guest count.",
  parameters: {
    type: "object",
    properties: {
      destination: { type: "string" },
      checkIn:     { type: "string" },
      guests:      { type: "number" },
    },
    required: ["destination", "checkIn", "guests"],
  },
  async handler(ctx, args) {
    const bookingId = await reserve(args);
    return {
      data: { bookingId },
      dataUpdate: { bookingId },
    };
  },
};
```

The handler returns a `ToolResult`:

- `data` is what the AI sees as the tool result (used to compose the
  next assistant message).
- `dataUpdate` is shallow-merged into `session.data`, so the booking
  id sticks for the rest of the conversation.

Wire the tool to the `confirm` step:

```typescript
{
  id: "confirm",
  prompt: "Confirm the trip and call book_hotel.",
  requires: ["destination", "checkIn", "guests"],
  tools: [bookHotel],
}
```

The AI now has the tool available on `confirm`. Once the three
fields are set, it can call `book_hotel`, get the id back, and
confirm the booking in the reply.

### Optional: finish the flow declaratively

If you want the tool itself to close the flow — instead of relying
on the next turn to notice `requiredFields` are satisfied — return a
`directive` alongside the data:

```typescript
async handler(ctx, args) {
  const bookingId = await reserve(args);
  return {
    data: { bookingId },
    directive: {
      complete: { reason: "reservation confirmed" },
      dataUpdate: { bookingId },
    },
  };
}
```

`ToolResult.directive` is the **declarative** form of redirection: a
directive returned with the result. Whatever you can say with
`ctx.dispatch` mid-handler, you can say with `directive` on return.
They merge identically. See [Directives](../concepts/directives.md)
for the full shape.

## 2. Add `check_eligibility` — imperative form

Some destinations are off-limits for some users. We want a tool that
runs before the AI starts pitching options, decides whether the
caller can proceed, and — when not — bails out into a denial flow.

The imperative form uses `ctx.dispatch` to emit a directive
mid-handler:

```typescript
const checkEligibilityImperative: Tool<{ userId: string }, BookingData, { ok: boolean }> = {
  id: "check_eligibility",
  description: "Verify the caller is allowed to book this destination.",
  isReadOnly: () => true,
  async handler(ctx) {
    const ok = await isEligible(ctx.context.userId, ctx.data.destination);

    if (!ok) {
      // Stop reasoning down this path — jump to the denial flow.
      ctx.dispatch({
        goTo: "Denial",
        reply: "Sorry — you're not eligible to book that destination.",
      });
      return { ok: false };
    }

    return { ok: true };
  },
};
```

What just happened:

- `ctx.dispatch(directive)` puts the directive on this turn's
  directive bus. Algorithm 4 picks it up alongside any other
  emissions.
- `goTo: "Denial"` redirects to a sibling flow named `"Denial"`.
- `reply` is the verbatim assistant utterance — the LLM call this
  turn is skipped and the literal string is what the user sees.
- The handler still returns `{ ok: false }` so the trace is honest
  about what the tool did.

For the redirect to work, the agent needs a `Denial` flow. It can
be as small as:

```typescript
{
  title: "Denial",
  steps: [{ id: "explain",
            prompt: "Explain why the booking is not possible and offer help." }],
},
```

Wire the eligibility check on the `confirm` step (or earlier — your
call):

```typescript
{
  id: "confirm",
  prompt: "Confirm the trip and call book_hotel.",
  requires: ["destination", "checkIn", "guests"],
  tools: [checkEligibilityImperative, bookHotel],
}
```

## 3. Same tool — declarative form

Many handlers don't need to dispatch mid-flight. They can compute
the answer, build the directive, and return it on the result.
`ToolResult.directive` is identical in effect to `ctx.dispatch` —
same merge, same precedence, same shape.

```typescript
const checkEligibilityDeclarative: Tool<{ userId: string }, BookingData, { ok: boolean }> = {
  id: "check_eligibility",
  description: "Verify the caller is allowed to book this destination.",
  isReadOnly: () => true,
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
  },
};
```

When to reach for which:

- **Imperative** — you need to dispatch before the handler is done
  (e.g. an early branch decides the rest of the work is moot but
  the result payload still has to be computed for the trace).
- **Declarative** — single return point, directive next to the data
  it goes with. Easier to read; preferred when there's no reason to
  split.

Both forms can co-exist. Multiple `dispatch` calls plus a `directive`
on the return value all land on the same bus and merge identically
(see [Directives](../concepts/directives.md)).

## 4. Optional metadata, briefly

Every metadata field on `Tool` is optional. Reach for them only when
you want the safer default they buy you.

```typescript
isReadOnly: () => true;                                                 // safe to cache and parallelize
validateInput: (input) => ({ valid: typeof input.guests === "number" }); // repair or reject bad args
checkPermissions: (_, ctx) => ({ allowed: !!ctx.context.userId });       // gate access; handler skipped on deny
```

Four more live on the same surface — `isConcurrencySafe`,
`isDestructive`, `interruptBehavior`, `maxResultSizeChars`. See the
[Tool reference](../reference/tool.md) for the full list and exact
contracts.

## 5. Run it

A user message like

> "Book me a room in Lisbon for 2 adults, checking in March 14."

now flows through:

1. **Pre-extraction.** The router pulls `destination: "Lisbon"`,
   `checkIn: "March 14"`, `guests: 2` out of the message in one shot.
2. **Step selection.** The `ask` step is satisfied — every `collect`
   field is set — so the engine skips it and enters `confirm`.
3. **Eligibility.** The AI calls `check_eligibility`. If allowed,
   the tool returns `{ ok: true }` and we move on. If not, the
   dispatched directive jumps to the `Denial` flow and the verbatim
   `reply` becomes the assistant message — no LLM call this turn.
4. **Booking.** The AI calls `book_hotel`, gets a `bookingId`, and
   composes the confirmation reply.
5. **Completion.** With every required field present (and a
   `bookingId` in `data`), the flow finishes.

## What's next

You have an agent that collects data, runs tools, gates access, and
redirects on failure. The remaining concern is shipping it: swapping
`MemoryAdapter` for `PrismaAdapter`, streaming responses, and
dropping the agent behind an HTTP endpoint.

**Next:** [Go to production](./05-go-to-production.md)
