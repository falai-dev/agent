---
title: "Step"
description: "A node inside a flow — collects data, calls tools, runs computational work, or speaks a verbatim line."
type: reference
order: 3
---

# Step

> **Where this is introduced:** [Architecture](../concepts/architecture.md)

A `Step` is a single node inside a `Flow`. Each step describes what
the agent does at one point in a conversation: ask a question, collect
schema fields, call tools, run a hook, branch to another step, or
speak a verbatim line. Steps are the smallest unit the engine can
suspend on between user turns.

Steps are normally declared as `StepOptions` objects inside a flow's
`steps[]` array. The `Step` class itself is rarely instantiated by
hand — `createAgent` and `Flow.addStep` build instances from the
options shape below. Validation runs eagerly at construction, so
misuse surfaces as `FlowConfigurationError` before any turn runs.

A step is one of three mutually exclusive shapes:

- **LLM step** — the default. Has `prompt`, optionally `collect` / `tools` / `instructions`. The engine calls the LLM.
- **Auto step** — `auto: true`. Pure computation, no LLM call. Only `onEnter`, `prepare`, and `branches` execute. Counts against `maxAutoStepsPerTurn`.
- **Reply step** — `reply` is set. Renders a verbatim assistant message with no LLM call.

Mixing fields between shapes throws at construction time.

## Signature

```typescript
interface StepOptions<TContext = unknown, TData = unknown> {
  id?: string;
  description?: string;

  // Behaviour
  prompt?: Template<TContext, TData>;
  reply?: Template<TContext, TData>;
  auto?: boolean;

  // Data
  collect?: (keyof TData)[];
  requires?: (keyof TData)[];

  // Activation
  when?: ConditionWhen;                       // AI strings — `string | string[]`
  if?: ConditionIf<TContext, TData>;          // code predicates — function or array
  skip?: ConditionIf<TContext, TData>;        // code predicates — OR semantics

  // Surface
  tools?: (string | Tool<TContext, TData>)[];
  instructions?: Instruction<TContext, TData>[];

  // Lifecycle (shorthand — returns PrepareResult)
  prepare?:
    | string                                  // tool id
    | Tool<TContext, TData>
    | ((ctx: TContext, data?: Partial<TData>) =>
        void | PrepareResult | Promise<void | PrepareResult>);
  finalize?:
    | string
    | Tool<TContext, TData>
    | ((ctx: TContext, data?: Partial<TData>) =>
        void | PrepareResult | Promise<void | PrepareResult>);

  // Lifecycle (full — receives HookContext, returns Directive)
  hooks?: StepLifecycleHooks<TContext, TData>;

  // Routing
  branches?: BranchMap<TContext, TData>;
}

interface StepLifecycleHooks<TContext = unknown, TData = unknown> {
  onEnter?: (ctx: HookContext<TContext, TData>) =>
    void | Directive<TContext, TData> | Promise<void | Directive<TContext, TData>>;
  prepare?: (ctx: HookContext<TContext, TData>) =>
    void | Directive<TContext, TData> | Promise<void | Directive<TContext, TData>>;
  finalize?: (ctx: HookContext<TContext, TData>) =>
    void | Directive<TContext, TData> | Promise<void | Directive<TContext, TData>>;
  onExit?: (ctx: HookContext<TContext, TData>, reason: ExitReason) =>
    void | Promise<void>;
}
```

## Fields

| Field | Type | Required | Default | Notes |
|-------|------|----------|---------|-------|
| `id` | `string` | no | derived from `description` | Stable identifier used by `goToStep`, `branches.then`, and event traces. Must be unique within the flow. |
| `description` | `string` | no | — | One-line summary surfaced in routing and event traces. Used to derive `id` when omitted. |
| `prompt` | `Template<TContext, TData>` | no | — | String or function `(params) => string \| Promise<string>`. Becomes the system-prompt instruction for the LLM call this step makes. Mutually exclusive with `auto: true` and `reply`. |
| `reply` | `Template<TContext, TData>` | no | — | Verbatim assistant message. When set, the engine renders this template and emits it without calling the LLM. Cannot coexist with `prompt`, `collect`, `tools`, `finalize`, or `auto: true`. `stoppedReason: 'reply'`. |
| `auto` | `boolean` | no | `false` | When `true`, the step runs without an LLM call — only `onEnter`, `prepare`, and `branches` execute. Cannot coexist with `prompt`, `collect`, `tools`, or `finalize`. Counts against `maxAutoStepsPerTurn`. |
| `collect` | `(keyof TData)[]` | no | `[]` | Schema field keys this step is responsible for extracting from the user message. Every key must exist in the agent's `schema`. The engine skips the step automatically when every listed key is already present in `session.data` (pre-extraction). |
| `requires` | `(keyof TData)[]` | no | `[]` | Prerequisite field keys. The engine refuses to enter the step until every key is present in `session.data`. When fields covered by `requires` are read inside `branches[].if` predicates, they are guaranteed to be defined. |
| `when` | `string \| string[]` | no | — | AI-evaluated activation strings. Non-`!` strings are OR alternatives; `!` strings are OR exclusions where any match inhibits activation. Evaluated by the LLM at routing time. Functions are not allowed here — the constructor throws `FlowConfigurationError` if a function is found. |
| `if` | `(ctx) => boolean \| Promise<boolean>` or array | no | — | Code-evaluated activation predicates (AND semantics). Evaluated locally — no LLM cost. When both `when` and `if` are set, `if` runs first; `when` is only evaluated if every `if` predicate passes. |
| `skip` | `(ctx) => boolean \| Promise<boolean>` or array | no | — | Code-evaluated skip predicates (OR semantics). When any predicate returns `true`, the step is bypassed. Only code predicates — no AI strings. |
| `tools` | `(string \| Tool<TContext, TData>)[]` | no | `[]` | Tools available during this step. Strings are resolved against the agent's tool registry; objects are inline tools. Stacked on top of agent and flow scopes. |
| `instructions` | `Instruction<TContext, TData>[]` | no | `[]` | Step-scoped behavioural statements (`kind: 'must' \| 'never' \| 'should'`). Active only while this step is current. See [Instruction](./instruction.md). |
| `prepare` | function, tool id, or `Tool` object | no | — | Pre-LLM hook. Receives `(context, data?)` and returns `void \| PrepareResult` (a Directive may be returned too). |
| `finalize` | function, tool id, or `Tool` object | no | — | Post-generation hook, runs before persistence. Same shape as `prepare`. A returned `goTo`/`goToStep`/`reset`/`complete` redirects the **next** turn; state writes land immediately. |
| `hooks` | `StepLifecycleHooks<TContext, TData>` | no | — | Alternative spelling of `prepare`/`finalize` (`hooks.prepare`, `hooks.finalize`). Both spellings run when declared together — shorthand first, then the hook, returns merged via Algorithm 4. |
| `branches` | `BranchEntry<TContext, TData>[]` | no | — | Explicit source-local fork. Evaluated after `finalize`, before linear successor selection. The first entry whose `if`/`when` passes wins; its `then` resolves to a step id, a flow id, or a `Directive`. See [Branches](./branches.md). |

### Lifecycle hooks

Two hook positions exist per step: `prepare` (before generation) and
`finalize` (after generation, before persistence). Each is reachable
through a top-level field, a `hooks.*` entry, or both — declaring both
runs them in sequence (shorthand first) with their returns merged by
Algorithm 4 (`flow.merge`).

| Position | When it fires | May return | Use it for |
|----------|---------------|------------|------------|
| `prepare` / `hooks.prepare` | Before routing on the step's turn (non-auto steps). | `void \| PrepareResult` | Write session/context state, redirect the current turn with `goToStep`/`goTo`/`reset` (queued as `pendingDirective` and applied by routing this turn). |
| `finalize` / `hooks.finalize` | After generation completes, BEFORE the session is persisted. | `void \| PrepareResult` | Validate collected data, write state, queue a redirect for the next turn (`pendingDirective`), e.g. `{ complete: { next: { goTo: 'Checkout' } } }`. |

Handler directives merge through the canonical algorithm and are
validated with `flow.validate`. State writes
(`dataUpdate`/`contextUpdate`) apply immediately to the turn session,
so auto-save captures them even if this is the conversation's last
turn.

Note for **auto steps**: their `prepare` runs inside the auto-chain,
where pre-LLM fields (`appendPrompt`, `injectTools`, `halt`, `reply`)
are honored directly.

### Resolution within a step

For one step, the engine walks this sequence per turn:

1. Evaluate `if` (code, AND) and `when` (AI: positive OR, `!` exclusions inhibit) — fails skip the step entirely.
2. Evaluate `skip` (code, OR) — true means bypass and fall through.
3. Check `requires` — refuse entry if any required field is missing.
4. Run `prepare` / `hooks.prepare`. Its merged directive applies state writes immediately; position fields queue as `pendingDirective` for this turn's routing.
5. **LLM step**: call the LLM with the step's prompt, tools, and instructions; tool loop runs until completion. **Auto step**: skip the LLM call. **Reply step**: render `reply` as the verbatim assistant message.
6. Run `finalize` / `hooks.finalize` (before persistence). State writes land now; position fields queue for the next turn.
7. Evaluate `branches`. The first entry whose `if`/`when` passes wins; its `then` resolves to a step id, a flow id, or a full `Directive`. If no entry matches, fall through.
8. Linear successor / AI step selection.
9. Persist the session (auto-save) after finalize has run.

## Examples

### Collecting fields with prerequisites and skip

```typescript
import { createAgent, GeminiProvider } from '@falai/agent';

const agent = createAgent({
  name: 'BookingBot',
  provider: new GeminiProvider({ apiKey: process.env.GEMINI_API_KEY! }),
  schema: {
    type: 'object',
    properties: {
      city: { type: 'string' },
      checkIn: { type: 'string' },
      guests: { type: 'integer' },
    },
  },
  flows: [
    {
      title: 'Book',
      requiredFields: ['city', 'checkIn', 'guests'],
      steps: [
        {
          id: 'ask_destination',
          prompt: 'Find out where and when the user wants to stay.',
          collect: ['city', 'checkIn'],
        },
        {
          id: 'ask_guests',
          prompt: 'Confirm how many people are travelling.',
          collect: ['guests'],
          requires: ['city', 'checkIn'],
          // Skip if the user already mentioned a party size
          skip: ({ data }) => typeof data.guests === 'number',
        },
      ],
    },
  ],
});
```

### Auto step with branches and a reply step

```typescript
import { createAgent, GeminiProvider } from '@falai/agent';

const agent = createAgent({
  name: 'EligibilityRouter',
  provider: new GeminiProvider({ apiKey: process.env.GEMINI_API_KEY! }),
  schema: {
    type: 'object',
    properties: { tier: { type: 'string' } },
  },
  flows: [
    {
      title: 'Quote',
      steps: [
        // Pure computation — no LLM call.
        {
          id: 'check_tier',
          auto: true,
          requires: ['tier'],
          branches: [
            { if: ({ data }) => data.tier === 'enterprise', then: 'concierge' },
            { when: 'the user already used their free trial', then: 'upsell' },
            { then: 'self_serve' }, // unconditional fallback
          ],
        },
        // Verbatim message — no LLM call.
        {
          id: 'concierge',
          reply: 'A concierge specialist will reach out within an hour.',
        },
        { id: 'upsell', prompt: 'Pitch the paid plan in two short sentences.' },
        { id: 'self_serve', prompt: 'Walk them through the self-serve form.' },
      ],
    },
  ],
});
```

### `when` + `if`, scoped tools and instructions, hook-driven redirect

```typescript
import { createAgent, GeminiProvider } from '@falai/agent';

const agent = createAgent({
  name: 'Refunds',
  provider: new GeminiProvider({ apiKey: process.env.GEMINI_API_KEY! }),
  schema: {
    type: 'object',
    properties: {
      orderId: { type: 'string' },
      refundAmount: { type: 'number' },
    },
  },
  flows: [
    {
      title: 'Refund',
      steps: [
        {
          id: 'verify',
          prompt: 'Look up the order and quote a refund amount.',
          collect: ['orderId', 'refundAmount'],
          // Run only when both signals agree the user is requesting a refund.
          when: 'the user is requesting a refund',
          if: ({ context }) =>
            (context as { authenticated: boolean }).authenticated,
          tools: ['lookup_order'],
          instructions: [
            { kind: 'must',  prompt: 'State the refund amount before confirming.' },
            { kind: 'never', prompt: 'Promise refunds without checking eligibility.' },
          ],
          hooks: {
            // Full hook — receives HookContext, returns Directive.
            finalize: ({ data }) => {
              if ((data.refundAmount ?? 0) > 500) {
                return { goToStep: 'manager_review' };
              }
            },
          },
        },
        { id: 'manager_review', prompt: 'Hand off to a manager for approval.' },
      ],
    },
  ],
});
```

### Top-level `prepare` shorthand vs `hooks.prepare`

```typescript
// Shorthand — receives (context, data?), returns PrepareResult.
{
  id: 'enrich',
  auto: true,
  prepare: (context, data) => ({
    dataUpdate: { customerTier: lookupTier(context, data?.email) },
  }),
}

// Full hook — receives HookContext, returns Directive.
{
  id: 'enrich',
  auto: true,
  hooks: {
    prepare: ({ context, data, dispatch }) => {
      const tier = lookupTier(context, data?.email);
      dispatch({ dataUpdate: { customerTier: tier } });
      if (tier === 'blocked') {
        return { halt: true, reply: 'This account is on hold.' };
      }
    },
  },
}
```

## Errors

The `Step` constructor validates the options shape eagerly. The
following are thrown synchronously when the agent is built:

- `FlowConfigurationError` — `when` contains a function (functions
  belong on `if`).
- `FlowConfigurationError` — `auto: true` is combined with `prompt`,
  `collect`, `tools`, or `finalize`.
- `FlowConfigurationError` — `reply` is combined with `prompt`,
  `collect`, `tools`, `finalize`, or `auto: true`.
- `FlowConfigurationError` — `branches` is empty (`[]`).
- `FlowConfigurationError` — a non-last `branches` entry has neither
  `when` nor `if` (later entries would be unreachable).
- `FlowConfigurationError` — a `branches[i].then` Directive sets more
  than one position field (`goTo`, `goToStep`, `complete`, `abort`,
  `reset`).
- `FlowConfigurationError` — a `branches[i].then` Directive contains
  an empty `goTo: {}`.

Runtime errors that surface from a step's hook execution include
`DataValidationError` (invalid collected data), `ToolExecutionError`
(a tool inside the step threw or rejected), and
`ResponseGenerationError` (LLM call failed after retries). See
[Errors](./errors.md) for handling patterns.

## Related

- [Architecture](../concepts/architecture.md) — where Step fits among the six primitives
- [Turn pipeline](../concepts/pipeline.md) — when each step phase fires inside a turn
- [Flow](./flow.md) — the parent type that contains a step's `steps[]` entry
- [Tool](./tool.md) — the shape consumed by `tools[]`
- [Instruction](./instruction.md) — the shape consumed by `instructions[]`
- [Branches](./branches.md) — the full `BranchEntry` / `BranchMap` contract
- [Directive](./directive.md) — the post-LLM return type for `hooks.finalize`
- [When and if](../guides/conditions.md) — picking between AI and code conditions
- [Branching](../guides/branching.md) — adding source-local forks
- [Flow control](../guides/flow-control.md) — redirecting from a hook
