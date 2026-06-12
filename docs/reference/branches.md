---
title: "Branches"
description: "Explicit source-local forks declared on a step, evaluated in order with code-first short-circuit."
type: reference
order: 8
---

# Branches

> **Where this is introduced:** [Branching](../guides/branching.md)

A **branch** is an explicit, source-local fork: from this step, here are the possible next steps and how each one is chosen. `step.branches` is an array of `BranchEntry` evaluated in declaration order — the first entry whose conditions pass wins, and its `then` resolves to a step id, a flow id, or a full `Directive`.

Branches sit between code and AI. Use `if` (a function predicate) to skip LLM evaluation when the choice is purely a function of `data` and `context`. Use `when` (an AI-evaluated string) for choices that need intent classification. Combine both when both must agree — `if` runs first, free; `when` is only evaluated if `if` passes, saving tokens.

Branches resolve **after** the step's post-LLM phase (tool execution, `finalize`) and **before** linear successor selection. They coexist with the implicit-fork pattern (multiple successor steps each carrying their own `step.when`); when `branches` is absent or no entry matches, resolution falls through to that path unchanged.

## Signature

```typescript
interface BranchEntry<TContext = unknown, TData = unknown> {
  /** AI condition: positives OR, ! exclusions inhibit. */
  when?: string | string[];

  /** Code predicate. Function or array of functions (AND semantics). */
  if?:
    | BranchPredicate<TContext, TData>
    | BranchPredicate<TContext, TData>[];

  /**
   * Where to go when this entry matches.
   * - String matching a step id in the current flow → enter that step.
   * - String matching a flow id/title → treated as { goTo: <string> }.
   * - Directive object → applied directly.
   */
  then: string | Directive<TContext, TData>;

  /** Optional label for event traces and flow visualization. */
  label?: string;
}

type BranchMap<TContext = unknown, TData = unknown> =
  Array<BranchEntry<TContext, TData>>;

type BranchPredicate<TContext = unknown, TData = unknown> = (
  ctx: BranchPredicateContext<TContext, TData>,
) => boolean | Promise<boolean>;

interface BranchPredicateContext<TContext = unknown, TData = unknown> {
  /** Collected data (partial — null-check fields not in `requires`). */
  data: Partial<TData>;
  /** Agent-level context. */
  context: TContext;
  /** Full session state. */
  session: SessionState<TData>;
  /** Conversation history as events. */
  history: Event[];
}
```

## Fields

### `BranchEntry`

| Field | Type | Required | Default | Notes |
|-------|------|----------|---------|-------|
| `when` | `string \| string[]` | no | — | AI-evaluated condition. Non-`!` strings are OR alternatives; `!` strings are OR exclusions where any match inhibits the branch. Reuses the same machinery as `step.when`. Only evaluated if `if` passes (or is absent). Costs LLM tokens. |
| `if` | `BranchPredicate \| BranchPredicate[]` | no | — | Code predicate. Free to evaluate. When both `when` and `if` are set, `if` runs first; `when` is only evaluated if all `if` predicates pass. |
| `then` | `string \| Directive` | yes | — | Target. See [Resolution of `then`](#resolution-of-then) below. |
| `label` | `string` | no | — | Optional label surfaced in event traces and flow visualization. |

An entry with neither `when` nor `if` is an unconditional fallback and is only legal as the **last** entry in the array.

### `BranchMap`

A `BranchMap` is just `Array<BranchEntry>`. Entries are evaluated top-to-bottom; the first match wins. There is no separate object-syntax form — keeping the shape an array means declaration order and source position are the same thing.

### `BranchPredicateContext`

| Field | Type | Notes |
|-------|------|-------|
| `data` | `Partial<TData>` | Collected data so far. Predicates must null-check any field not declared in the source step's `requires`. Fields covered by `requires` are guaranteed present when the predicate runs. |
| `context` | `TContext` | Agent-level context (user, env, services). |
| `session` | `SessionState<TData>` | Full session state — current flow, current step, history. |
| `history` | `Event[]` | Conversation history as events (read-only). |

## Resolution

### Order

For each entry in declaration order:

1. If the entry has neither `when` nor `if`, it matches unconditionally (only legal as the last entry).
2. If `if` is set, evaluate every predicate. If any returns falsy, skip the entry — `when` is **not** evaluated.
3. If `when` is set, evaluate the AI condition. If it returns falsy, skip the entry.
4. Otherwise the entry matches; return its `then`.

If no entry matches, branches return `undefined` and resolution falls through to linear `nextStep` / AI step selection. This is the same fall-through used when `branches` is omitted entirely.

The code-first ordering is deliberate: `if` is free, `when` costs tokens. Running `if` first short-circuits the AI call when the predicate already disqualifies the entry.

### Resolution of `then`

`then` accepts three forms, resolved in this order:

1. **String matching a step id in the current flow** → enter that step directly.
2. **String matching a flow id or title** → treated as `applyDirective({ goTo: then })`.
3. **`Directive` object** → applied via `applyDirective(then)`.

When a string matches both a local step id and a flow id (rare), the local step wins — step ids are scoped to the current flow.

A bare string **never** resolves to a step in another flow, even if that step id is globally unique. To target a step in a different flow, use the `Directive` form: `then: { goToStep: { step: 'foo', flow: 'OtherFlow' } }`. This keeps the string lookup unambiguous and makes cross-flow intent explicit at the call site.

## Examples

### 1. Code-only fork (zero LLM cost)

A routing step that picks a path based purely on collected data. Combined with `auto: true`, the entire decision happens without an LLM call.

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

### 2. Mixed targets (step id, flow id, full Directive)

One branch step covering local navigation, cross-flow handoff, cross-flow step targeting, and completion in a single source-local list.

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

        // Cross-flow step reference (Directive required for cross-flow steps).
        {
          if: ({ data }) => data.escalate === true,
          then: { goToStep: { step: "priority_intake", flow: "Escalation" } },
        },

        // Directive with a non-position field (state write + completion).
        { if: ({ data }) => data.shouldComplete === true, then: { complete: true } },

        // Unconditional fallback.
        { then: "default_path" },
      ],
    },
    { id: "enterprise_path", prompt: "..." },
    { id: "default_path",    prompt: "..." },
  ],
});
```

### 3. Combined `if` + `when` (token-saving short-circuit)

When both fields are set on the same entry, `if` runs first. `when` is only evaluated if `if` passes — so the LLM call only happens when the predicate hasn't already disqualified the branch.

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

## Errors

Misuse of `branches` surfaces as `FlowConfigurationError` at flow construction or at first evaluation:

- **Empty array.** `branches: []` is rejected — it signals a missing target.
- **Unreachable fallback.** A non-last entry with neither `when` nor `if` is rejected (later entries would never run).
- **Unknown step id.** A `then` string that matches neither a step in the current flow nor any flow id throws when first evaluated.
- **Malformed Directive.** A `then` Directive with multiple position fields set, or an empty `goTo: {}`, fails the same `flow.validate(directive)` rules that apply to all directives.

A `BranchPredicate` that throws or rejects is caught by the resolver, logged at `ERROR`, and treated as a falsy result for that entry — resolution proceeds to the next entry. Branch predicate errors never corrupt the session; the worst case degrades to fall-through (linear / AI step selection).

## Coexistence with implicit forks

The implicit-fork pattern (multiple successor steps each carrying their own `step.when`) is unchanged in v2. Both forms are first-class:

- **Implicit** — fork by listing multiple steps with their own `when`. Reads as a linear flow that occasionally skips. Use when the fork is incidental.
- **Explicit (`branches`)** — fork declared at the source step, all paths visible in one list. Reads as "this step is a routing point with N options." Use when the fork is the point.

When both are present on the same step, branches take precedence: if a branch entry matches, the linear chain is bypassed. If branches return `undefined`, the linear chain runs.

## Related

- [Branching](../guides/branching.md) — the guide that introduces this primitive end-to-end.
- [Step](./step.md) — where the `branches` field lives.
- [Directive](./directive.md) — the flat shape `then` accepts as its third form.
- [Conditions](../guides/conditions.md) — the `when` (AI) vs `if` (code) split shared with `Step` and `Flow`.
- [Turn pipeline](../concepts/pipeline.md) — where branch resolution sits in the per-turn sequence.
