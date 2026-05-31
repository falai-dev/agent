---
title: "Instructions"
description: "Shape how the agent talks with must / never / should at agent, flow, and step scope, and read back exactly which ones fired."
type: guide
order: 4
---

# Instructions

Use `Instruction` when the agent should always confirm dates, never quote prices it has not looked up, or — only inside the booking flow — try to compare two options before committing. One primitive covers all three. Severity comes from `kind`. Reach comes from where you declare the instruction. The framework reports back which instructions actually rendered on each turn, so the behavior surface is observable, not guessed.

This guide assumes a `createAgent` scaffold. If you need one, start from [Your first agent](../start/02-first-agent.md).

## Instruction shape

An `Instruction` is a plain object with one required field — `prompt` — and a handful of optional ones. The full contract lives in the [Instruction reference](../reference/instruction.md); the working subset for this guide is:

```typescript
import type { Instruction } from "@falai/agent";

const ins: Instruction = {
  kind: "must",                                     // 'must' | 'never' | 'should' (default 'should')
  when: "User asks about pricing",                  // optional AI-evaluated activation
  if: (ctx) => ctx.context.tier === "pro",          // optional code-evaluated activation
  prompt: "Quote only rates fetched from the live API this turn.",
};
```

`prompt` is the behavioral text. `kind` declares severity. `when` and `if` gate the instruction by activation, with `if` running first and `when` only evaluated if `if` passes. Everything else (`id`, `enabled`, `tags`, `metadata`) is bookkeeping you can ignore until you need it.

## The three `kind` values

`kind` answers *how strict is this?* Three values, no inheritance, no ordering:

| `kind` | Use it for | Example |
|--------|------------|---------|
| `must` | Absolute do. The agent is required to follow it whenever rendered. | `"Validate dates are in the future before booking."` |
| `never` | Absolute don't. The agent is forbidden from doing it. | `"Promise rates you have not looked up."` |
| `should` | Conditional nudge. Default kind. The agent should try, but it's not a hard line. | `"Offer to compare two options before committing."` |

Default is `should`. Reach for `must` or `never` only when the behavior is non-negotiable — they are louder in the prompt and less forgiving in tone. If three flows each need the same `must`, declare it once at the agent scope; if it only matters for one flow, declare it there.

## Agent vs flow vs step scope

The same shape attaches at three positions:

```typescript
createAgent({
  instructions: [/* agent scope — every turn, every flow */],
  flows: [
    {
      title: "Booking",
      instructions: [/* flow scope — only when 'Booking' is active */],
      steps: [
        {
          id: "payment",
          instructions: [/* step scope — only when 'payment' is the current step */],
        },
      ],
    },
  ],
});
```

Reach narrows as you nest. Agent-scope instructions render on every turn for every flow. Flow-scope instructions render only while that flow is active. Step-scope instructions render only while that step is current. Conditions apply on top: `if` removes an instruction locally when its predicate fails, while `when` is rendered with the instruction so the model can decide whether the natural-language condition applies.

The composer renders the resolved set under a single `## Instructions` heading and tags each line with a scope caption so the model can read both *what* and *where from* in one pass:

| Scope | Caption | When it appears |
|-------|---------|-----------------|
| Agent | `[Always]` | Every turn. |
| Flow | `[In: <FlowTitle>]` | While the named flow is active. |
| Step | `[Step: <stepId>]` | While the named step is current. |

## Rendering format

Each eligible instruction lands in the prompt as a single bullet:

```
- [<kind>] [<scope>] <prompt> (apply only when: <when-clause> OR <when-clause>)
```

The condition suffix is omitted when `when` is not set. A composed block looks like this:

```
## Instructions

- [must] [Always] Validate dates are in the future before booking.
- [never] [Always] Promise rates you have not looked up.
- [should] [In: Booking] Offer to compare two options before committing. (apply only when: the user is comparing hotel options)
- [must] [Step: payment] If the card is declined, never retry without confirmation.
```

The format is fixed. The kind prefix is always present (defaulting to `[should]`), the scope caption is always present, and the prompt text follows verbatim. When present, `when` clauses are joined with `OR` and appended for the model to evaluate.

## `appliedInstructions` on the response

Every `respond()` call returns an `appliedInstructions` array listing exactly which instructions were rendered into that turn's prompt. The set is deterministic — it comes from the prompt composer, not the model — so you can use it for observability, audits, and tests. For an instruction with `when`, inclusion means the conditional instruction reached the model; it does not claim that the model judged the condition true:

```typescript
const response = await agent.respond("I want to book a room.");

for (const a of response.appliedInstructions ?? []) {
  console.log(`${a.scope}${a.scopeRef ? `:${a.scopeRef}` : ""} → ${a.id}`);
}
// global → ins_validate_dates
// global → ins_no_unquoted_prices
// flow:Booking → ins_offer_two_options
```

Each `AppliedInstruction` carries the firing instruction's `id`, the originating `scope`, and a `scopeRef` that is the `flowTitle` for flow scope, the `stepId` for step scope, and `undefined` for agent scope. If you want stable ids in the report, set `id` on the instructions you care about — otherwise the framework auto-generates them.

The same array lands on the final chunk of `respondStream`:

```typescript
for await (const chunk of agent.respondStream("I want to book a room.")) {
  if (chunk.done) {
    console.log("rendered:", chunk.appliedInstructions);
  }
}
```

`appliedInstructions` is empty on intermediate chunks and populated only when `done: true`.

## Recipe: agent-level absolutes

Two house rules every flow must respect:

```typescript
const agent = createAgent({
  name: "BookingBot",
  provider: new GeminiProvider({ apiKey: process.env.GEMINI_API_KEY! }),
  instructions: [
    { id: "ins_validate_dates", kind: "must",  prompt: "Validate dates are in the future before booking." },
    { id: "ins_no_unquoted",    kind: "never", prompt: "Promise rates you have not looked up." },
  ],
  flows: [/* ... */],
});
```

These render with caption `[Always]` on every turn, regardless of which flow is active.

## Recipe: flow-level conditional

A flow-scope nudge that only fires when the user is comparison shopping:

```typescript
const booking = {
  title: "Booking",
  instructions: [
    {
      id: "ins_offer_two_options",
      kind: "should",
      when: "User is comparing options or asking which is better",
      prompt: "Offer to compare two options side by side before recommending one.",
    },
  ],
  steps: [/* ... */],
};
```

While `Booking` is active, the line renders with caption `[In: Booking]` only on turns where the AI condition resolves true. On other turns the entry stays out of the prompt and out of `appliedInstructions`.

## Recipe: step-level reminder

A `must` that scopes to a specific step, gated by a code condition:

```typescript
const paymentStep = {
  id: "payment",
  prompt: "Take payment.",
  instructions: [
    {
      id: "ins_no_retry_on_decline",
      kind: "must",
      if: (ctx) => ctx.data.lastChargeStatus === "declined",
      prompt: "If the card is declined, never retry without explicit user confirmation.",
    },
  ],
};
```

Renders with caption `[Step: payment]` only while `payment` is the current step *and* the most recent charge was declined. Move off the step or change `lastChargeStatus`, and it drops out cleanly.

## Recipe: reading `appliedInstructions` in a test

Because the set is deterministic, you can assert against it directly:

```typescript
import { test, expect } from "bun:test";

test("payment step renders the no-retry rule when the card was declined", async () => {
  const response = await agent.respond("Try again.", {
    sessionId: "s_1",
    initialContext: {},
    initialData: { lastChargeStatus: "declined" },
  });

  const ids = response.appliedInstructions?.map(a => a.id) ?? [];
  expect(ids).toContain("ins_no_retry_on_decline");
});
```

No fixtures, no LLM mocks — the rendered set is computable from configuration and condition state.

## Where this fits

`Instruction` shapes how the agent *talks*. To shape what it *does* — redirect, complete, abort — return a [Directive](../reference/directive.md) from a tool or hook (covered in [Flow control](./flow-control.md)). The two surfaces compose: an instruction nudges the model to confirm dates, a tool's directive completes the flow once the booking is written.

**Next:** [Persistence](./persistence.md)
