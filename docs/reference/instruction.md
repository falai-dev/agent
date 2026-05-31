---
title: "Instruction"
description: "Unified behavioral primitive that shapes how the agent responds, with a kind discriminator (must / never / should) and agent / flow / step scoping."
type: reference
order: 5
---

# Instruction

> **Where this is introduced:** [Instructions](../guides/instructions.md)

An `Instruction` is a single statement of behavior the agent should follow. v2 collapses three v1 types into one — every instruction now carries a `kind` discriminator (`'must'`, `'never'`, or `'should'`) and a `prompt` that is rendered into the system prompt with a scope caption. The same shape works at agent, flow, and step scope; only its position in the configuration changes.

The set of instructions actually rendered into a given turn's prompt is reported back on the response as `appliedInstructions` — observability is deterministic, derived from rendering, not self-reported by the model. For instructions with a textual `when`, this means the condition was presented to the model, not that the model reported a match.

## Signature

```typescript
interface Instruction<TContext = unknown, TData = unknown> {
  id?: string;
  kind?: 'must' | 'never' | 'should';        // default: 'should'
  when?: ConditionWhen;                       // AI-evaluated string(s), OR semantics
  if?: ConditionIf<TContext, TData>;          // code-evaluated function(s), AND semantics
  prompt: Template<TContext, TData>;
  enabled?: boolean;                          // default: true
  tags?: string[];
  metadata?: Record<string, unknown>;
}

interface ScopedInstructions<TContext = unknown, TData = unknown> {
  global: Instruction<TContext, TData>[];
  flow?: { flowTitle: string; items: Instruction<TContext, TData>[] };
  step?: { stepId: string; items: Instruction<TContext, TData>[] };
}

interface AppliedInstruction {
  id: string;
  scope: 'global' | 'flow' | 'step';
  scopeRef?: string;                          // flowTitle for flow, stepId for step
}
```

## Fields

### `Instruction`

| Field | Type | Required | Default | Notes |
|-------|------|----------|---------|-------|
| `prompt` | `Template<TContext, TData>` | yes | — | Behavioral text rendered into the prompt under the `## Instructions` section. |
| `kind` | `'must' \| 'never' \| 'should'` | no | `'should'` | Severity. `'must'` = absolute do, `'never'` = absolute don't, `'should'` = conditional nudge. |
| `when` | `ConditionWhen` | no | — | AI-evaluated activation string (or array, OR semantics). Functions are not allowed here; use `if`. |
| `if` | `ConditionIf<TContext, TData>` | no | — | Code-evaluated activation function (or array). Free to evaluate. When both `when` and `if` are set, `if` runs first; `when` is only evaluated if `if` passes. |
| `id` | `string` | no | auto | Stable identifier used in `AppliedInstruction.id`. Auto-generated when omitted. |
| `enabled` | `boolean` | no | `true` | Set `false` to skip the instruction without removing it from configuration. |
| `tags` | `string[]` | no | — | Free-form tags for filtering and grouping. |
| `metadata` | `Record<string, unknown>` | no | — | Free-form per-instruction metadata. |

### `AppliedInstruction`

| Field | Type | Notes |
|-------|------|-------|
| `id` | `string` | The `Instruction.id` that fired. |
| `scope` | `'global' \| 'flow' \| 'step'` | Where the instruction was declared. |
| `scopeRef` | `string \| undefined` | `flowTitle` for `flow`, `stepId` for `step`, `undefined` for `global`. |

## Scoping

The same `Instruction` shape attaches at three positions:

- **Agent (global):** `AgentOptions.instructions` — always considered, on every turn, for every flow.
- **Flow:** `FlowOptions.instructions` — considered when the active flow matches.
- **Step:** `StepOptions.instructions` — considered when the active step matches.

At prompt-build time the composer renders each eligible instruction as a single bullet:

```
- [<kind>] [<scope-caption>] <prompt> (apply only when: <when-clause> OR <when-clause>)
```

The parenthesized condition is omitted when `when` is not set. Code-evaluated `if` predicates run first; a failing predicate removes the entire bullet before the prompt reaches the model.

Scope captions are fixed by where the instruction was declared:

| Scope | Caption |
|-------|---------|
| Agent | `[Always]` |
| Flow | `[In: <FlowTitle>]` |
| Step | `[Step: <stepId>]` |

Example block in the rendered prompt:

```
## Instructions

- [must] [Always] Always greet by name
- [never] [Always] Promise delivery dates you cannot guarantee
- [should] [In: Booking] Confirm dates before calling book_hotel
- [should] [Step: payment] If the card is declined, never retry without confirmation
```

## Examples

### 1. Agent-level absolutes plus a step-level nudge

```typescript
import { createAgent, GeminiProvider } from '@falai/agent';

const agent = createAgent({
  name: 'BookingBot',
  provider: new GeminiProvider({ apiKey: process.env.GEMINI_API_KEY! }),
  instructions: [
    { kind: 'must', prompt: 'Validate dates are in the future before booking.' },
    { kind: 'never', prompt: 'Promise rates you have not looked up.' },
  ],
  flows: [
    {
      title: 'Booking',
      instructions: [
        { kind: 'should', prompt: 'Offer to compare two options before committing.' },
      ],
      steps: [
        {
          id: 'payment',
          prompt: 'Take payment.',
          instructions: [
            { kind: 'must', prompt: 'If the card is declined, never retry without confirmation.' },
          ],
        },
      ],
    },
  ],
});
```

### 2. Conditional activation with `when` and `if`

```typescript
import type { Instruction } from '@falai/agent';

type Ctx = { tier: 'free' | 'pro' };
type Data = { hasQuoted: boolean };

const concise: Instruction<Ctx, Data> = {
  kind: 'should',
  when: 'User asks a simple yes/no question',
  prompt: 'Answer in one sentence.',
};

const proOnly: Instruction<Ctx, Data> = {
  kind: 'must',
  if: (ctx) => ctx.context.tier === 'pro',
  prompt: 'Offer to export the conversation as PDF.',
};
```

### 3. Reading `appliedInstructions` from a response

```typescript
const response = await agent.respond('Hi, I want to book a room.');

for (const a of response.appliedInstructions ?? []) {
  console.log(`${a.scope}${a.scopeRef ? `:${a.scopeRef}` : ''} → ${a.id}`);
}
// global → ins_validate_dates
// flow:Booking → ins_offer_two_options
```

## Errors

- `FlowConfigurationError` — duplicate `id` across instructions in the same scope, or `kind` set to a value other than `'must' | 'never' | 'should'`.
- `DataValidationError` — a `Template` `prompt` references a `data` field not declared in the agent `schema`.

## Related

- [Instructions](../guides/instructions.md) — recipe for shaping behavior with `must` / `never` / `should`
- [Architecture](../concepts/architecture.md) — where Instruction fits among the six primitives
- [createAgent](./create-agent.md) — `AgentOptions.instructions`
- [Flow](./flow.md) — `FlowOptions.instructions`
- [Step](./step.md) — `StepOptions.instructions`
