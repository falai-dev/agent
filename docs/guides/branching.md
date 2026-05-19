---
title: "Branching"
description: "Add an explicit, source-local fork to a step with `branches`, mixing code predicates and AI conditions and pointing at step ids, flow ids, or full directives."
type: guide
order: 2
---

# Branching

Most flows are linear: ask, collect, confirm, complete. A few aren't. Sometimes the conversation arrives at a step that has to choose between three or four next moves — and the choice is the point of the step, not an aside. This guide shows how to express that fork with `step.branches`.

You already know the [`when` / `if` split](./conditions.md): `when` is an AI-evaluated string, `if` is a code predicate, and the two compose so that code runs first for free and the AI only fires when the predicate already passed. `branches` reuses that vocabulary in a list-shaped form. Each entry says "here is a possible next step, and here is how to choose it." Entries evaluate top-to-bottom; the first one whose conditions pass wins.

By the end of this page you will have written four branch points: a pure-code fork that costs zero tokens, an AI-only fork that classifies intent, a combined fork that short-circuits the LLM call, and a cross-flow fork that hands control to a different flow with state carry.

## The shape

`step.branches` is an array of `BranchEntry` objects. Each entry has up to four fields:

```typescript
interface BranchEntry<TContext, TData> {
  /** AI-evaluated condition. String or array of strings (AND). */
  when?: string | string[];

  /** Code predicate. Function or array of functions (AND). */
  if?: BranchPredicate<TContext, TData> | BranchPredicate<TContext, TData>[];

  /**
   * Where to go when this entry matches. One of:
   *  - A string matching a step id in the current flow.
   *  - A string matching a flow id (sugar for `{ goTo: <flowId> }`).
   *  - A full Directive (cross-flow step targets, state writes, completion).
   */
  then: string | Directive<TContext, TData>;

  /** Optional label surfaced in event traces and flow visualization. */
  label?: string;
}
```

Three rules govern how a `branches` array is read:

1. **Declaration order is evaluation order.** The first entry whose conditions pass wins. Later entries don't run.
2. **Code-first short-circuit.** When an entry has both `if` and `when`, `if` runs first. `when` is only evaluated when `if` passes — saving the LLM call when the predicate already disqualifies the entry.
3. **An entry with neither `when` nor `if` is an unconditional fallback.** It's only legal as the last entry in the array. Putting it earlier is a `FlowConfigurationError` because every later entry would be unreachable.

If no entry matches, branches return `undefined` and resolution falls through to the linear `nextStep` chain or AI step selection — exactly as if `branches` were absent. That is the same fall-through that backs the implicit-fork pattern, so the two forms compose cleanly.

## A code-only fork

The cheapest fork is one that doesn't call the LLM at all. When the choice is purely a function of `data` and `context`, every entry uses `if` and the whole decision runs in pure TypeScript.

```typescript
flow({
  id: "plan_routing",
  steps: [
    {
      id: "route_by_plan",
      auto: true,
      branches: [
        { if: ({ data }) => data.plan === "enterprise", then: "enterprise_path", label: "enterprise" },
        { if: ({ data }) => data.plan === "pro",        then: "pro_path",        label: "pro" },
        { then: "free_path" }, // unconditional fallback (last entry)
      ],
    },
    { id: "enterprise_path", prompt: "A specialist will reach out." },
    { id: "pro_path",        prompt: "Set up your pro account." },
    { id: "free_path",       prompt: "Welcome to the free tier." },
  ],
});
```

Two things matter here. First, `auto: true` on the source step removes the LLM call that would otherwise run for `route_by_plan` itself — the step asks no question, only routes. Combined with code-only branches, the entire decision is a pure compute node in the graph. Second, the unconditional fallback at the end is what guarantees a target. Without it, a `data.plan` value the engine doesn't know about would fall through to linear succession instead of landing on `free_path`.

The `BranchPredicate` receives `{ data, context, session, history }`. `data` is `Partial<TData>` — predicates have to null-check any field not declared in the source step's `requires`. Fields covered by `requires` are guaranteed present.

## An AI-only fork

Some forks need intent classification. The user said something; the agent has to decide whether they want to cancel, ask about billing, or get technical help. None of that lives in `data` yet, and writing a regex would lose the point of the framework.

```typescript
flow({
  id: "support",
  steps: [
    {
      id: "classify_request",
      prompt: "How can I help?",
      branches: [
        { when: "user wants to cancel their account", then: "cancel_flow" },
        { when: "user is asking about billing",        then: "billing_flow" },
        { when: "user is asking a technical question", then: "tech_support" },
        { then: "general_help" }, // fallback
      ],
    },
    { id: "tech_support", prompt: "What are you running into?" },
    { id: "general_help", prompt: "I can help with that." },
    // cancel_flow and billing_flow are top-level flows resolved via goTo.
  ],
});
```

`when` strings reuse the same machinery as `step.when`. One LLM call evaluates each entry's condition in declaration order; the first match wins. Conditions are written from the agent's perspective — `"user wants to cancel"` reads naturally and matches the prompts the model already speaks. Don't try to compress them into keywords; the AI is doing classification, not pattern matching.

The fallback at the end is doing real work too. When the model can't classify the message into any of the three buckets — say the user typed "hi" — `general_help` catches it instead of dropping the user into AI step selection.

## Combining `if` and `when`

When an entry has both fields set, code runs first and the AI call only fires when the predicate already passed. This is the same short-circuit you saw in the [conditions guide](./conditions.md), now scoped to a single branch entry.

```typescript
flow({
  id: "pricing",
  steps: [
    {
      id: "pricing_routing",
      branches: [
        {
          // Free predicate runs first; AI condition only fires when it passes.
          if: ({ data, context }) =>
            data.country === "US" && context.featureFlags.enableUsPricing,
          when: "user is asking about pricing",
          then: "us_pricing",
        },
        {
          when: "user is asking about pricing",
          then: "global_pricing",
        },
        { then: "general_help" }, // fallback
      ],
    },
    { id: "us_pricing",     prompt: "Here is US pricing." },
    { id: "global_pricing", prompt: "Here is global pricing." },
    { id: "general_help",   prompt: "I can help with that." },
  ],
});
```

For users outside the US — or with the feature flag off — `if` returns `false` immediately and the entry is skipped without ever evaluating `when`. The second entry then evaluates `when` once and routes to `global_pricing`. A US user with the flag on passes `if`, and only then does the AI call evaluate "user is asking about pricing." When both pass, the entry wins.

The cost difference is real. Without the short-circuit, every turn would pay one LLM call to evaluate `when` for every entry that names it. With it, the framework spends tokens on the entries it can't dispose of for free.

## Resolving `then`

`then` accepts three forms, resolved in this order:

1. **A step id in the current flow** — the engine enters that step directly. Same effect as `nextStep: <id>` would have on a linear chain.
2. **A flow id** — sugar for `applyDirective({ goTo: <flowId> })`. The string is desugared into a flow transition with no data carry.
3. **A `Directive` object** — applied via `applyDirective` directly. This is the form to use whenever you need anything more than a bare jump: cross-flow steps, data writes, completion, or verbatim replies.

When a string matches both a local step id and a flow id (rare; you'd have to name them the same thing), the local step wins. Step ids are scoped to the current flow, so the lookup is unambiguous.

A bare string **never** resolves to a step in a different flow, even when that step id is globally unique. Cross-flow step targets require the `Directive` form:

```typescript
{
  if: ({ data }) => data.escalate === true,
  then: { goToStep: { step: "priority_intake", flow: "Escalation" } },
}
```

This is intentional. Keeping the string-form lookup confined to "current flow's steps or any flow id" means a glance at the source tells you what the string means without needing to know whether some unrelated flow happens to define a step by the same name. When you mean to cross flows, the `Directive` form makes that explicit at the call site.

## A mixed-target router

Most real branch points combine forms. One entry tests data, another classifies intent, a third writes state and completes. The `branches` array reads top-to-bottom as a list of cases:

```typescript
flow({
  id: "router",
  steps: [
    {
      id: "classify",
      prompt: "How can I help?",
      branches: [
        // Step id in the current flow.
        { if: ({ data }) => data.tier === "enterprise", then: "enterprise_path" },

        // Flow id — sugar for { goTo: "CancellationFlow" }.
        { when: "user wants to cancel", then: "CancellationFlow" },

        // Full Directive — cross-flow with data carry.
        {
          when: "user is asking about a refund",
          then: { goTo: { flow: "Refund", data: { source: "classify" } } },
        },

        // Cross-flow step reference (Directive required).
        {
          if: ({ data }) => data.escalate === true,
          then: { goToStep: { step: "priority_intake", flow: "Escalation" } },
        },

        // Directive with completion + state write.
        {
          if: ({ data }) => data.shouldComplete === true,
          then: { complete: true, dataUpdate: { closedAt: new Date().toISOString() } },
        },

        // Unconditional fallback.
        { then: "default_path" },
      ],
    },
    { id: "enterprise_path", prompt: "..." },
    { id: "default_path",    prompt: "..." },
  ],
});
```

The mix is the point. Code-only entries pay nothing, AI entries pay one classification, the Directive entries reach across flows or write completion state. Everything declarative is in one list at the source step. There is no separate router file, no decision tree spread across `step.when` clauses on five different successors.

## Coexisting with the implicit fork

Branches don't replace the implicit-fork pattern (multiple successor steps each carrying their own `step.when`). Both forms stay first-class. Choose by intent:

- **Implicit fork** when the flow reads as a linear chain that occasionally skips. The fork is incidental — the bulk of the flow is "do A, then B, then maybe C, then D."
- **Explicit fork (`branches`)** when the source step is a routing point. The fork is the point — the step exists to choose between N targets and the targets are owned by the source.

When both are present on the same step, branches take precedence. If a branch entry matches, the linear chain is bypassed entirely. If `branches` returns `undefined` — no entry matched — the linear chain runs as if `branches` were absent.

```typescript
flow({
  id: "support",
  steps: [
    {
      id: "intake",
      prompt: "How can I help?",
      // Branches handle the obvious cases up-front.
      branches: [
        { if: ({ data }) => data.priority === "P0", then: "fast_path" },
        { when: "user is asking a billing question", then: "billing" },
      ],
    },
    // Linear successors with their own `when` — the implicit-fork pattern.
    // These only run if no branch entry matched on `intake`.
    { id: "tech",      when: "user is asking a technical question", prompt: "..." },
    { id: "general",   prompt: "I can help with that." },
    // ...
    { id: "fast_path", prompt: "..." },
    { id: "billing",   prompt: "..." },
  ],
});
```

The combination here is deliberate. Branches catch the cases that have an explicit short-circuit (P0 priority is in `data`, billing is unambiguous to classify). Everything else falls through to the implicit fork, which the AI step selector picks among. Neither pattern is forced into doing what the other does better.

## What you get back

When a branch entry's `then` is applied, the response surfaces it the same way it would surface any other position decision. The active step changes, `currentStep.id` reflects the new step, and `appliedInstructions` is recomputed for the new scope. If the entry's `then` was a `Directive` that included `dataUpdate` or `contextUpdate`, those writes are visible on the response too — branches participate in state writes through the same `applyDirective` machinery as tools and hooks.

The optional `label` field on each entry doesn't affect resolution; it's surfaced in event traces and in flow visualization tools so you can see which branch fired without having to read the predicate. Use it on entries whose `if`/`when` conditions are long enough to be hard to skim at a glance.

## Recap

Four moves cover almost every fork you'll write:

- **Code-only** when the choice is in `data` or `context`. Free, deterministic, and combinable with `auto: true` for zero-LLM routing nodes.
- **AI-only** when the choice is intent classification. One LLM call, declared at the source step instead of scattered across target-step `when` clauses.
- **Combined `if + when`** when both must agree. Code runs first, AI runs only when code passed.
- **Directive in `then`** when the target is in another flow, when state needs to be written, or when the branch should complete or abort the flow.

`branches` doesn't add a new control-flow primitive. It reuses `when`, `if`, and `Directive` in a list shape that makes the fork visible at the source step. Pair it with the implicit-fork pattern when the linear chain is the natural read; pair it with `auto: true` when the routing decision shouldn't speak.

**Next:** [Flow control](./flow-control.md)
