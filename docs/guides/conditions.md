---
title: "When and if"
description: "Pick between AI-evaluated `when` strings and code-evaluated `if` predicates, and combine them to save tokens."
type: guide
order: 1
---

# When and if

Conditions decide whether a flow activates, a step runs, an instruction applies, or a branch fires. v2 splits them into two distinct fields with different evaluators:

- `when` — strings the LLM evaluates against intent and the conversation. Costs tokens.
- `if` — TypeScript predicates the engine evaluates locally. Free.

The split is the same everywhere: `Flow`, `Step`, `Instruction`, and `BranchEntry` all expose `when?` and `if?` with identical semantics. This guide shows how to pick between them, how arrays combine, and what happens when both are set. If you are migrating from v1, the [v1 → v2 migration guide](../migration/v1-to-v2.md) covers the renamed condition fields.

## Pick the right field

Reach for `if` first. It's free, deterministic, and reads clearly in code review.

| Question to answer                                              | Use      |
| --------------------------------------------------------------- | -------- |
| Is this user authenticated? Is `data.tier === 'pro'`?           | `if`     |
| Is the feature flag on? Is the order older than 90 days?        | `if`     |
| Did the user ask about pricing? Are they expressing frustration? | `when`   |
| Is the user describing a refund scenario in their own words?    | `when`   |

If the answer lives in `data`, `context`, or `session`, it's `if`. If the answer requires reading the user's intent from natural language, it's `when`.

## `when` — AI strings

`when` accepts a string or an array of strings. Functions are rejected at construction time with `FlowConfigurationError`.

```typescript
{
  title: "Refund",
  when: "the user is requesting a refund",
}
```

Multiple non-`!` strings combine with **OR** semantics — any clause may pass for the condition to match. Use the array form for alternative natural-language expressions of the same intent:

```typescript
{
  title: "Address",
  when: [
    "the user asked about the address",
    "the user asked where we are located",
  ],
}
```

Prefix a string with `!` to make it an exclusion. Exclusions also combine with OR semantics: if any exclusion matches, the condition is inhibited. A negative-only `when` means "active unless this exclusion matches."

```typescript
{
  title: "Checkout",
  when: [
    "the user is ready to buy",
    "!the user is asking for support",
  ],
}
```

The strings are sent to the LLM as part of the routing or activation prompt. For instructions, the string is appended to the instruction bullet so the response model can apply the instruction conditionally. Keep conditions short, intent-shaped, and free of code-style boolean expressions — `"the user wants to cancel"` lands; `"data.cancelRequested === true"` does not.

## `if` — code predicates

`if` accepts a function or an array of functions. Each predicate receives a `TemplateContext`-shaped argument (`{ context, data, session, history, helpers }`) and returns `boolean | Promise<boolean>`.

```typescript
{
  title: "Enterprise",
  if: ({ context }) => context.tier === "enterprise",
}
```

Arrays combine with **AND** semantics — every predicate must return truthy.

```typescript
{
  if: [
    ({ context }) => context.authenticated,
    ({ data }) => (data.cartTotal ?? 0) > 100,
  ],
}
```

Predicates that throw or reject are caught, logged, and treated as `false` for that evaluation. They never corrupt the session — the worst case is the condition fails to match.

### What's in the predicate context

Predicates receive a context object with the same shape used everywhere templates and conditions evaluate. The fields you'll reach for most:

| Field      | Type                     | Notes                                                            |
| ---------- | ------------------------ | ---------------------------------------------------------------- |
| `data`     | `Partial<TData>`         | Collected schema fields. Null-check anything not in `requires`.  |
| `context`  | `TContext`               | Agent-level ambient context (user, env, services).               |
| `session`  | `SessionState<TData>`    | Current flow id, current step id, full history.                  |
| `history`  | `Event[]`                | Read-only conversation history.                                  |

Predicates can be `async`. Awaiting a database lookup or feature-flag service is supported, but remember: every predicate runs every time its host primitive is evaluated. Keep them cheap, or memoize the work in a hook upstream.

```typescript
{
  if: async ({ context, data }) =>
    await context.flags.isEnabled("v2_pricing", data.userId),
}
```

## When both are set

Setting both `when` and `if` on the same primitive runs `if` **first**, free. `when` is only sent to the LLM when every `if` predicate passes. The order is deliberate: predicates short-circuit the LLM call when the answer is already disqualified.

```typescript
{
  title: "US Pricing",
  if: ({ context }) => context.country === "US" && context.flags.usPricing,
  when: "the user is asking about pricing",
}
```

In the snippet above, non-US users skip the AI evaluation entirely. The `when` string costs tokens only when the predicate already says "this user is in scope, ask the AI whether they're asking about pricing."

This pattern is the recommended shape any time a condition has both a cheap precondition and an intent classification. Lead with `if` to gate. Use `when` to interpret.

## Where the split lives

The same `when` / `if` shape attaches to four primitives. Semantics are identical in each location:

| Primitive       | Field path              | What it gates                                      |
| --------------- | ----------------------- | -------------------------------------------------- |
| Flow            | `FlowOptions.when/if`   | Whether the router selects this flow this turn     |
| Step            | `StepOptions.when/if`   | Whether the step is reachable in the current flow  |
| Instruction     | `Instruction.when/if`   | Whether the instruction applies to the response    |
| BranchEntry     | `BranchEntry.when/if`   | Whether this branch entry matches inside `step.branches` |

```typescript
// Flow scope — gate flow selection
{ title: "Refund", when: "user wants a refund", if: ({ context }) => context.authenticated }

// Step scope — gate step reachability
{ id: "verify_payment", when: "user is confirming the order", if: ({ data }) => !!data.cardToken }

// Instruction scope — render only when relevant
{ kind: "should", when: "user mentions a discount code", prompt: "Validate the code before applying it." }

// Branch scope — pick a successor
branches: [
  { if: ({ data }) => data.tier === "enterprise", when: "user wants pricing", then: "enterprise_pricing" },
  { then: "default_pricing" },
]
```

## `step.skip` is the OR companion

One adjacent field rounds out the picture. `step.skip` is **function-only** with **OR** semantics — when any predicate returns truthy, the step is bypassed. Use it for "skip when this field already exists" cases:

```typescript
{
  id: "ask_email",
  collect: ["email"],
  skip: ({ data }) => !!data.email,
}
```

`skip` does not accept strings. There is no AI counterpart — skipping is a code decision by design.

## Quick reference

A short checklist before shipping a condition:

- Does it read a field, flag, or context value? Use `if`.
- Does it interpret natural language? Use `when`.
- Multiple natural-language alternatives where any may match? Put them in `when` — non-`!` entries use OR.
- Need an AI-evaluated exclusion? Prefix that `when` entry with `!`.
- Multiple code predicates that must all pass? Put them in `if` — arrays use AND.
- Need to skip when a value is already collected? `step.skip` (OR semantics).
- Both fields set? `if` runs first, free; `when` only fires if `if` passes.

**Next:** [Branching](./branching.md)
