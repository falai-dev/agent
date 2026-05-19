---
title: "v1 → v2 migration"
description: "Every breaking change in v2 with rename tables and before/after."
type: migration
order: 1
---

# v1 → v2 Migration

**Version:** 2.0.0 — Clean break (no shims, no aliases)

## Summary

v2 is a clean break — no shims, no aliases. The surface is smaller and the primitives are fewer: `Route` becomes `Flow`, three behavioral types collapse into `Instruction`, `EnhancedTool` folds into `Tool`, and all flow control converges on a single `Directive` shape. This guide covers every breaking change with rename tables and before/after code samples.

Other notable changes covered below: the `pendingTransition` session field becomes `pendingDirective`, `Tool.name` collapses into `Tool.id`, the `ConditionTemplate` union is replaced by separate `when` (AI) and `if` (code) fields, `FlowOptions.onComplete` is string-only at the top level, `createAgent` becomes the headline API, agent identity collapses from three fields (`description`, `identity`, `personality`) into one (`persona`), multi-step batching is replaced by `auto: true` steps, and `step.branches` is added as an explicit (non-breaking) alternative to implicit fork.

---

## Table of Contents

1. [Persistence: `pendingTransition` → `pendingDirective`](#1-persistence-pendingtransition--pendingdirective)
2. [Removed in v2 — Full Surface List](#2-removed-in-v2--full-surface-list)
3. [Route → Flow Rename](#3-route--flow-rename)
4. [Guideline / Rule / Prohibition → Instruction](#4-guideline--rule--prohibition--instruction)
5. [`condition` / `action` → `when` / `prompt`](#5-condition--action--when--prompt)
6. [`onComplete` Cleanup](#6-oncomplete-cleanup)
7. [Flow Completion: Farewell Removal + Idle-State Release](#7-flow-completion-farewell-removal--idle-state-release)
8. [`createAgent` — The New Headline API](#8-createagent--the-new-headline-api)
9. [Tool / EnhancedTool Merge](#9-tool--enhancedtool-merge)
10. [ConditionTemplate → `when` / `if` Split](#10-conditiontemplate--when--if-split)
11. [Dispatch Replaces `transitionTo` / `nextStepFlow`](#11-dispatch-replaces-transitionto--nextstepflow)
12. [Agent Identity → `persona`](#12-agent-identity--persona)
13. [Multi-Step Batching → Auto-Steps](#13-multi-step-batching--auto-steps)
14. [Implicit Fork → Explicit Branches (Non-Breaking)](#14-implicit-fork--explicit-branches-non-breaking)

---

## 1. Persistence: `pendingTransition` → `pendingDirective`

The `SessionState.pendingTransition` field is removed. Its replacement is `SessionState.pendingDirective`, a full `Directive` object (not just a flow id + reason).

v2 also adds a `signals` column for forward-compat with the v2.x Signals feature. It's unused at runtime but must be present in your schema.

**There is no auto-migration.** If a v1 record carries `pendingTransition` but no `pendingDirective`, v2 ignores it — the pending transition is lost. Run the backfill before deploying v2.

### PostgreSQL / SQLite

```sql
-- Step 1: Backfill pendingDirective from pendingTransition
UPDATE sessions
SET pending_directive = jsonb_build_object(
  'goTo', jsonb_build_object('flow', pending_transition->'targetFlowId')
)
WHERE pending_transition IS NOT NULL
  AND pending_directive IS NULL;

-- Step 2: Schema migration
ALTER TABLE sessions DROP COLUMN pending_transition;
ALTER TABLE sessions ADD COLUMN pending_directive JSONB;
ALTER TABLE sessions ADD COLUMN signals JSONB;
```

For SQLite (no JSONB), use TEXT columns and `json_object()`:

```sql
UPDATE sessions
SET pending_directive = json_object(
  'goTo', json_object('flow', json_extract(pending_transition, '$.targetFlowId'))
)
WHERE pending_transition IS NOT NULL
  AND pending_directive IS NULL;

ALTER TABLE sessions DROP COLUMN pending_transition;
ALTER TABLE sessions ADD COLUMN pending_directive TEXT;
ALTER TABLE sessions ADD COLUMN signals TEXT;
```

### MongoDB

```javascript
db.sessions.updateMany(
  { pendingTransition: { $ne: null }, pendingDirective: { $exists: false } },
  [{
    $set: {
      pendingDirective: {
        goTo: { flow: "$pendingTransition.targetFlowId" }
      }
    }
  }]
);

// Drop legacy field
db.sessions.updateMany({}, { $unset: { pendingTransition: "" } });
```

### Redis

Extend your migration Lua script (see the [route-to-flow migration](./route-to-flow.md) for the pattern):

```lua
local cursor = "0"
repeat
  local result = redis.call("SCAN", cursor, "MATCH", "session:*", "COUNT", 100)
  cursor = result[1]
  for _, key in ipairs(result[2]) do
    local val = redis.call("GET", key)
    if val then
      -- Replace pendingTransition with pendingDirective in JSON
      val = val:gsub('"pendingTransition"', '"pendingDirective"')
      redis.call("SET", key, val)
    end
  end
until cursor == "0"
```

> **Note:** Redis stores serialized JSON. The field-name swap is sufficient if your `pendingTransition` shape was `{ targetFlowId: string }`. The v2 runtime expects `{ goTo: { flow: string } }` — adjust the transform if your v1 shape was different.

### OpenSearch

Use the `_reindex` API with a painless script:

```json
POST _reindex
{
  "source": { "index": "sessions" },
  "dest": { "index": "sessions_v2" },
  "script": {
    "source": """
      if (ctx._source.containsKey('pendingTransition') && ctx._source.pendingTransition != null) {
        def pt = ctx._source.remove('pendingTransition');
        ctx._source.pendingDirective = ['goTo': ['flow': pt.targetFlowId]];
      }
    """,
    "lang": "painless"
  }
}
```

Then swap the alias to `sessions_v2`.

### Prisma Schema

```diff
model Session {
  // ...
- pendingTransition Json?  @map("pending_transition")
+ pendingDirective  Json?  @map("pending_directive")
+ signals           Json?
}
```

Run `npx prisma migrate dev --name v2-directive-migration`.

---

## 2. Removed in v2 — Full Surface List

v2 is a clean break. These symbols are gone with no aliases:

| v1 Element | Replacement | Migration |
|---|---|---|
| `END_FLOW` / `END_FLOW_ID` | Implicit terminus + `{ complete: true }` | Remove sentinel references. Last step in `steps[]` auto-terminates. |
| `ConditionTemplate` | `when` (AI) + `if` (code) | See [§10](#10-conditiontemplate--when--if-split). |
| `EnhancedTool` | `Tool` (merged) | See [§9](#9-tool--enhancedtool-merge). |
| `FlowTransitionConfig` | `Directive` | `{ nextStep: 'X', condition: 'Y' }` → `{ goTo: 'X', reason: 'Y' }` |
| `FlowCompletionHandler` | `hooks.onComplete: (ctx) => Directive \| void` | Inline the signature change. |
| `FlowOptions.endStep` | Last step's `prompt` | Move closing text to the last step. |
| `Flow.endStepSpec` | Removed | Internal — gone with `endStep`. |
| `Step.endFlow()` | Implicit terminus | `.endFlow(opts)` → just make it the last step. |
| `Agent.nextStepFlow()` | `Agent.dispatch()` | See [§11](#11-dispatch-replaces-transitionto--nextstepflow). |
| `Agent.transitionTo()` | `Agent.dispatch()` | See [§11](#11-dispatch-replaces-transitionto--nextstepflow). |
| `PendingTransition` interface | `Directive` | Replace with `pendingDirective: Directive`. |
| `SessionState.pendingTransition` | `SessionState.pendingDirective` | See [§1](#1-persistence-pendingtransition--pendingdirective). |
| `StepResult` (export) | Internal only | Chain methods stay; the return type is no longer public. |
| `BranchResult` / `BranchSpec` | `BranchEntry` / `BranchMap` | Use `step.branches: [{ if?, when?, then, label? }]`. |
| `ResponseModal` (export) | Internal | Remove any direct imports. |
| `ResponsePipeline` (export) | Internal | Remove any direct imports. |
| `BatchExecutor` / `BatchPromptBuilder` | Auto-steps | See [§13](#13-multi-step-batching--auto-steps). |
| `PromptComposer` (export) | Internal | Remove any direct imports. |
| `PromptSectionCache` (export) | Internal | Remove any direct imports. |
| `CompactionEngine` (export) | Internal | Remove any direct imports. |
| `FlowRouter` (export) | Internal | Remove any direct imports. |
| `AutoChainExecutor` (export) | Internal | Remove any direct imports. |
| `Guideline` / `Rule` / `Prohibition` | `Instruction` | See [§4](#4-guideline--rule--prohibition--instruction). |
| `Tool.name` | `Tool.id` | The LLM sees `tool.id` as the tool name. See [§9](#9-tool--enhancedtool-merge). |
| `AgentOptions.description` | `AgentOptions.persona` | See [§12](#12-agent-identity--persona). |
| `AgentOptions.identity` | `AgentOptions.persona` | See [§12](#12-agent-identity--persona). |
| `AgentOptions.personality` | `AgentOptions.persona` | See [§12](#12-agent-identity--persona). |
| `AgentOptions.compositionMode` | Removed | Had no runtime effect. Delete any references. |
| `AgentOptions.maxStepsPerBatch` | `AgentOptions.maxAutoStepsPerTurn` | See [§13](#13-multi-step-batching--auto-steps). |
| `StepOptions.skipIf` | `StepOptions.skip` | Function-only field. See [§10](#10-conditiontemplate--when--if-split). |
| `StepOptions.step` | Removed | Dead code since the `END_FLOW` symbol removal. |
| `FlowOptions.terms` / `FlowOptions.knowledgeBase` | Agent-level only | Move to `AgentOptions`. |
| `FlowOptions.identity` / `FlowOptions.personality` | `AgentOptions.persona` or flow-level instruction | See [§12](#12-agent-identity--persona). |
| `appliedGuidelines` (response) | `appliedInstructions` | Rename in response handling code. |
| `StoppedReason: 'end_flow'` | `'last_step'` | Update assertions. |
| `StoppedReason: 'flow_complete'` | `'last_step'` or `'completed'` | Update assertions. |
| `StoppedReason: 'max_steps_reached'` | `'max_auto_steps'` | Update assertions. |

### New `StoppedReason` values

```typescript
type StoppedReason =
  | 'needs_input'       // unchanged
  | 'last_step'         // last step ran — no successor
  | 'completed'         // explicit { complete: true } directive
  | 'aborted'           // { abort: '...' } directive
  | 'goto'              // goTo/goToStep directive short-circuited
  | 'reset'             // { reset: true } directive
  | 'halt'              // PreDirective halt: true
  | 'reply'             // Step.reply or directive reply (LLM skipped)
  | 'max_auto_steps'    // auto-step chain cap hit
  | 'prepare_error'     // unchanged
  | 'llm_error'         // unchanged
  | 'validation_error'  // unchanged
  | 'finalize_error';   // unchanged
```

---

## 3. Route → Flow Rename

The `Route` domain noun was renamed to `Flow` in a minor breaking bump that ships before v2. v2 assumes `Flow` naming everywhere — `Route` / `createRoute` / `session.currentRoute` and the corresponding persistence columns no longer exist.

If you haven't run that migration yet, start there: see **[Route → Flow rename](./route-to-flow.md)** for the full rename table, schema changes per adapter, and Redis/OpenSearch backfill scripts. Once that lands, return here for the rest of the v2 changes.


---

## 4. Guideline / Rule / Prohibition → Instruction

The three behavioral primitives collapse into a single `Instruction` type with a `kind` discriminator:

### Rename Table

| v1 | v2 `Instruction.kind` | Notes |
|---|---|---|
| `Rule` (always do) | `kind: 'must'` | Rendered as `[must]` prefix |
| `Prohibition` (never do) | `kind: 'never'` | Rendered as `[never]` prefix |
| `Guideline` (should do) | `kind: 'should'` | Default when `kind` omitted |

### Before / After

```typescript
// ─── v1 ───
agent.addRule("Always greet the user by name");
agent.addProhibition("Never discuss competitors");
agent.addGuideline({
  when: "User is a returning customer",
  action: "Skip the introduction and get to the point",
});

// ─── v2 ───
agent.addInstruction({ kind: 'must', prompt: "Always greet the user by name" });
agent.addInstruction({ kind: 'never', prompt: "Never discuss competitors" });
agent.addInstruction({
  kind: 'should',
  when: "User is a returning customer",
  prompt: "Skip the introduction and get to the point",
});
```

### Top-level options

```typescript
// Before
const agent = createAgent({
  rules: ['Always verify email format'],
  prohibitions: ['Never promise delivery dates'],
  guidelines: [{ when: 'User is upset', prompt: 'Use empathetic tone' }],
});

// After
const agent = createAgent({
  instructions: [
    { kind: 'must', prompt: 'Always verify email format' },
    { kind: 'never', prompt: 'Never promise delivery dates' },
    { kind: 'should', when: 'User is upset', prompt: 'Use empathetic tone' },
  ],
});
```

The same applies at flow and step scope. `FlowOptions.rules`, `FlowOptions.prohibitions`, `FlowOptions.guidelines`, and `StepOptions.guidelines` are all removed — use `instructions` at each level.

### Prompt Rendering Change

The heading `## Behavioral Guidelines` becomes `## Instructions`. Line format:

```
[must] [Always] Always greet the user by name
[never] [Always] Never discuss competitors
[should] [When: User is a returning customer] Skip the introduction and get to the point
```

### Response Field

`response.appliedGuidelines` → `response.appliedInstructions`

```typescript
// v1
console.log(response.appliedGuidelines);

// v2
console.log(response.appliedInstructions);
```

### Deprecated method removal (Instructions)

| Old | New |
|-----|-----|
| `agent.createGuideline(g)` | `agent.createInstruction(g)` |
| `agent.getRules()` | `agent.instructions.filter(i => i.kind === 'must')` |
| `agent.getProhibitions()` | `agent.instructions.filter(i => i.kind === 'never')` |
| `flow.createGuideline(g)` | `flow.createInstruction(g)` |
| `flow.getGuidelines()` | `flow.getInstructions()` |
| `flow.getRules()` | Removed — use flow instructions |
| `flow.getProhibitions()` | Removed — use flow instructions |
| `step.addGuideline(g)` | `step.addInstruction(g)` |
| `step.getGuidelines()` | `step.getInstructions()` |

### Type alias removal

| Old type | Use instead |
|----------|-------------|
| `Guideline<C, D>` | `Instruction<C, D>` |
| `ScopedGuidelines<C, D>` | `ScopedInstructions<C, D>` |
| `AppliedGuideline` | `AppliedInstruction` |

---

## 5. `condition` / `action` → `when` / `prompt`

The guideline shape fields were renamed in v2:

| v1 Field | v2 Field | Purpose |
|---|---|---|
| `condition` | `when` | AI-evaluated activation condition |
| `action` | `prompt` | The behavioral instruction text |

### Before / After

```typescript
// ─── v1 ───
agent.addGuideline({
  condition: "User is frustrated",
  action: "Be extra empathetic and offer to escalate",
});

// ─── v2 ───
agent.addInstruction({
  when: "User is frustrated",
  prompt: "Be extra empathetic and offer to escalate",
});
```

This also applies to flow-scoped and step-scoped guidelines:

```typescript
// ─── v1 ───
flow.addGuideline({
  condition: "Discussing pricing",
  action: "Always mention the free tier first",
});

// ─── v2 ───
flow.addInstruction({
  when: "Discussing pricing",
  prompt: "Always mention the free tier first",
});
```

---

## 6. `onComplete` Cleanup

### What changed

- **Top-level** `FlowOptions.onComplete` accepts **only a string** (flow id sugar).
- **Function** and **Directive** forms move to `hooks.onComplete`.
- Setting both throws `FlowConfigurationError` at construction.

### Before / After

```typescript
// ─── v1: function at top level ───
agent.createFlow({
  title: "Booking",
  onComplete: (session, context) => {
    return { nextRoute: "Confirmation" };
  },
  steps: [/* ... */],
});

// ─── v2: string at top level (sugar) ───
agent.createFlow({
  title: "Booking",
  onComplete: "Confirmation",  // sugar for hooks.onComplete = () => ({ goTo: 'Confirmation' })
  steps: [/* ... */],
});

// ─── v2: function in hooks ───
agent.createFlow({
  title: "Booking",
  hooks: {
    onComplete: (ctx) => {
      if (ctx.data.isPremium) return { goTo: "PremiumConfirmation" };
      return { goTo: "Confirmation" };
    },
  },
  steps: [/* ... */],
});
```

### ⚠️ Do NOT set both

```typescript
// THROWS FlowConfigurationError at construction
agent.createFlow({
  title: "Booking",
  onComplete: "Confirmation",          // ← string sugar
  hooks: { onComplete: () => {...} },   // ← function form — conflict!
});
```

---

## 7. Flow Completion: Farewell Removal + Idle-State Release

### Hardcoded farewell removed

v1 injected a synthetic `__COMPLETED__` step with a hardcoded prompt (`"Send a brief, natural farewell message…"`) when a flow completed. This is **gone**. No framework-generated farewell message is emitted. Every word the user sees comes from your step prompts.

### Idle-state release

When a flow completes and `onComplete` does not produce a transition:

- `session.currentFlow` → `undefined`
- `session.currentStep` → `undefined`
- The flow is marked `completed: true` in `flowHistory`
- The router excludes completed flows from future scoring
- Next turn: routing runs fresh (or the no-flow fallback triggers)

### Migration: Add an explicit closing step

```typescript
// ─── v1: relied on framework-generated farewell ───
agent.createFlow({
  title: "Onboarding",
  steps: [
    { id: "name",  collect: ["name"]  },
    { id: "email", collect: ["email"] },
  ],
});
// Framework would auto-generate "Thank you! I've recorded all..."

// ─── v2: author your own closing turn ───
agent.createFlow({
  title: "Onboarding",
  steps: [
    { id: "name",  collect: ["name"]  },
    { id: "email", collect: ["email"] },
    { id: "thanks", prompt: "Thank the user warmly. Wish them a great day." },
  ],
});
```

### `flow.reentrant` opt-in

If your v1 code relied on the router re-entering a completed flow, that loop is gone. To restore it deliberately:

```typescript
agent.createFlow({
  title: "Search",
  reentrant: true,  // allows re-selection after completion
  requiredFields: ["query"],
  steps: [/* ... */],
});
```

When `reentrant: true`, the router can re-select this flow after it completes. On re-entry, fields declared in `requiredFields` / `optionalFields` are cleared so the flow starts fresh.

`onComplete` always wins over `reentrant` — if `onComplete` returns a target, the session goes there instead.

---

## 8. `createAgent` — The New Headline API

`createAgent` is the recommended entry point in v2. It's equivalent to `new Agent(options)` but reads better in examples and enables stronger generic inference.

```typescript
import { createAgent, GeminiProvider } from "@falai/agent";

const agent = createAgent({
  name: "BookingBot",
  provider: new GeminiProvider({
    apiKey: process.env.GEMINI_API_KEY!,
    model: "gemini-3.1-flash-lite",
  }),
  schema: {
    type: "object",
    properties: {
      destination: { type: "string" },
      date: { type: "string" },
      guests: { type: "number" },
    },
    required: ["destination", "date", "guests"],
  },
  flows: [
    {
      title: "Book Trip",
      when: ["User wants to book travel"],
      requiredFields: ["destination", "date", "guests"],
      steps: [
        { id: "ask_dest", prompt: "Where to?", collect: ["destination"] },
        { id: "ask_date", prompt: "When?", collect: ["date"] },
        { id: "ask_guests", prompt: "How many?", collect: ["guests"] },
      ],
    },
  ],
});

const response = await agent.respond("Book a trip to Paris for 2 next Friday");
```

`new Agent(options)` still works — `createAgent` is sugar, not a replacement.


---

## 9. Tool / EnhancedTool Merge

`EnhancedTool` is removed. Its optional metadata fields are now part of the base `Tool` interface. `Tool.name` is also removed — `Tool.id` is the sole identifier and is what the LLM sees as the tool name.

```typescript
// ─── v1 ───
import { EnhancedTool } from "@falai/agent";

const tool: EnhancedTool = {
  id: "search",
  name: "Search Database",
  description: "Search the database",
  parameters: { type: "object", properties: {} },
  handler: async (ctx, args) => { /* ... */ },
  isConcurrencySafe: true,
  isReadOnly: true,
  checkPermissions: async (ctx) => ({ allowed: true }),
};

// ─── v2 ───
import { Tool } from "@falai/agent"; // EnhancedTool is gone

const tool: Tool = {
  id: "search_database",            // Tool.id is the sole identifier
  description: "Search the database",
  parameters: { type: "object", properties: {} },
  handler: async (ctx, args) => { /* ... */ },
  // Optional metadata (formerly EnhancedTool-only):
  isConcurrencySafe: true,
  isReadOnly: true,
  checkPermissions: async (ctx) => ({ allowed: true }),
};
```

Choose descriptive IDs — the LLM sees them. The optional fields that moved to `Tool`: `isConcurrencySafe`, `isReadOnly`, `isDestructive`, `interruptBehavior`, `maxResultSizeChars`, `validateInput`, `checkPermissions`.

### New: `ToolContext.dispatch` and `ToolResult.directive`

Tools can now control flow directly:

```typescript
const refundTool: Tool = {
  id: "check_refund",
  description: "Check refund eligibility",
  parameters: { /* ... */ },
  handler: async (ctx, args) => {
    const order = await lookupOrder(args.orderId);

    if (order.age > 90) {
      // Imperative: redirect mid-handler
      ctx.dispatch({ goTo: "IneligibleRefund" });
      return { data: "Order too old for refund" };
    }

    // Declarative: return directive alongside result
    return {
      data: "Eligible for refund",
      directive: { goTo: "ProcessRefund" },
    };
  },
};
```

### Deprecated method removal (Tools)

| Old | New |
|-----|-----|
| `agent.createTool(t)` | `agent.addTool(t)` |

### Type alias removal (Tools)

| Old type | Use instead |
|----------|-------------|
| `EnhancedTool<C, D, R>` | `Tool<C, D, R>` |

---

## 10. ConditionTemplate → `when` / `if` Split

The v1 `ConditionTemplate` type (a union of `string | function | Array<string | function>`) is removed. Conditions are now split into two distinct fields:

| Field | Evaluator | Cost | Accepts |
|---|---|---|---|
| `when` | AI (LLM call) | Tokens | `string \| string[]` |
| `if` | Code (function) | Free | `(ctx) => boolean \| Array<(ctx) => boolean>` |

### Rules

- `when` accepts **only strings** — passing a function throws `FlowConfigurationError` at construction.
- `if` accepts **only functions**.
- When both are set: `if` runs first (free); `when` runs only if `if` passes (saves tokens).
- Arrays are AND-conjunctions.

### Before / After

```typescript
// ─── v1: mixed ConditionTemplate ───
agent.createFlow({
  title: "Premium Support",
  when: [
    "User needs urgent help",                    // AI condition
    (ctx) => ctx.context.userTier === "premium", // code condition
  ],
  steps: [/* ... */],
});

// ─── v2: split into when + if ───
agent.createFlow({
  title: "Premium Support",
  when: ["User needs urgent help"],              // AI only
  if: [(ctx) => ctx.context.userTier === "premium"], // code only
  steps: [/* ... */],
});
```

### `skipIf` → `skip`

On steps, `skipIf` is renamed to `skip` and accepts only `if`-style functions:

```typescript
// ─── v1 ───
{ id: "ask_name", skipIf: (data) => !!data.name, /* ... */ }

// ─── v2 ───
{ id: "ask_name", skip: (data) => !!data.name, /* ... */ }
```

---

## 11. Dispatch Replaces `transitionTo` / `nextStepFlow`

Both `Agent.transitionTo()` and `Agent.nextStepFlow()` are removed. Use `Agent.dispatch()`:

```typescript
// ─── v1 ───
await agent.nextStepFlow("Feedback", session, "user requested feedback");
await agent.transitionTo("Billing");

// ─── v2 ───
await agent.dispatch({ goTo: "Feedback", reason: "user requested feedback" }, session);
await agent.dispatch("Billing"); // string sugar for { goTo: "Billing" }
```

`dispatch` sets `session.pendingDirective` — the directive is applied at the start of the next turn (not immediately). For synchronous in-place application without a `respond()` call, use `agent.applyDirective(directive, session)`.

### Deprecated method removal (Dispatch & session access)

| Old | New |
|-----|-----|
| `agent.transitionTo(...)` | `agent.dispatch({ goTo: ... }, session)` |
| `agent.nextStepFlow(...)` | `agent.dispatch({ goTo: ... }, session)` |
| `agent.getCurrentSession()` | `agent.currentSession` |
| `agent.setCurrentSession(s)` | `agent.currentSession = s` |
| `agent.clearCurrentSession()` | `agent.currentSession = undefined` |
| `agent.getSchema()` | `agent.schema` |
| `agent.getKnowledgeBase()` | `agent.knowledgeBase` |

### Type alias removal (Dispatch)

| Old type | Use instead |
|----------|-------------|
| `FlowTransitionConfig` | `Directive` |
| `FlowCompletionHandler` | `hooks.onComplete` function |
| `PendingTransition` | `Directive` (assigned to `session.pendingDirective`) |

---

## 12. Agent Identity → `persona`

Three v1 agent fields — `description`, `identity`, `personality` — collapse into a single `persona` field. `persona` is a `Template<TContext>` covering role, tone, and self-concept. Merge your old copy into one coherent prompt.

### Before / After

```typescript
// ─── v1 ───
const agent = createAgent({
  name: 'Support Bot',
  description: 'A helpful customer support agent',
  identity: 'You are a senior support specialist at Acme Corp.',
  personality: 'Friendly, concise, solution-oriented',
  // ...
});

// ─── v2 ───
const agent = createAgent({
  name: 'Support Bot',
  goal: 'Help customers resolve issues quickly',
  persona: 'You are a senior support specialist at Acme Corp. Communicate in a friendly, concise, solution-oriented style.',
  // ...
});
```

### Flow-level identity / personality removed

`FlowOptions.identity` and `FlowOptions.personality` are removed. Use the agent-level `persona` for global voice, or a flow-level instruction for flow-specific voice:

```typescript
// Before
const flow: FlowOptions = {
  title: 'Billing',
  identity: 'You are a billing specialist',
  personality: 'Formal and precise',
};

// After — use a flow-level instruction
const flow: FlowOptions = {
  title: 'Billing',
  instructions: [
    { kind: 'should', prompt: 'Act as a billing specialist. Use formal, precise language.' },
  ],
};
```

### Flow-level terms / knowledgeBase removed

Terms and knowledge base are now agent-level only. Move them up:

```typescript
// Before
const flow: FlowOptions = {
  title: 'Booking',
  terms: [{ name: 'PNR', description: 'Passenger Name Record' }],
  knowledgeBase: { policies: { /* ... */ } },
};

// After — move to agent level
const agent = createAgent({
  terms: [{ name: 'PNR', description: 'Passenger Name Record' }],
  knowledgeBase: { policies: { /* ... */ } },
  flows: [{ title: 'Booking', /* ... */ }],
});
```


---

## 13. Multi-Step Batching → Auto-Steps

Multi-step batching (`maxStepsPerBatch`, `BatchExecutor`, `BatchPromptBuilder`) conflated two different concerns: skipping the LLM for non-interactive nodes, and compressing N user-facing steps into one response. v2 splits them: the first becomes `auto: true`, the second becomes a single step with multi-field `collect`.

| Old | New |
|-----|-----|
| `AgentOptions.maxStepsPerBatch` | `AgentOptions.maxAutoStepsPerTurn` (default `10`) |
| `BatchExecutor`, `BatchPromptBuilder`, `needsInput` | Removed |
| Batch events (`batch_start`, `step_included`, `batch_complete`, …) | Step events (`step_entered`, `step_skipped`, `step_completed`) — `auto: boolean` in payload |
| `StoppedReason: 'max_steps_reached'` | `'max_auto_steps'` |

**Restructure pattern:** N tiny ask-steps batched into one call → one step with `collect: [field1, field2, field3]` and a prompt that asks for whatever is still missing. Pre-extraction handles the "user dumped everything in one message" case.

**Auto-step pattern:** Computation between asks → mark the compute step `auto: true`. It runs `onEnter` / `prepare` / `branches` / `onExit` with no LLM call. The pipeline walks consecutive auto-steps until it hits an interactive step or terminating directive.

```typescript
// v2: enrichment between two asks
{ id: 'ask_email', collect: ['email'], prompt: 'What email?' },
{ id: 'enrich', auto: true, prepare: async ({ data }) => {
    const customer = await crm.findByEmail(data.email);
    return { contextUpdate: { isReturning: !!customer } };
  } },
{ id: 'confirm', prompt: ({ context }) =>
    context.isReturning ? 'Welcome back. Confirm?' : 'Confirm your order?' },
```

**Validation:** an `auto: true` step throws `FlowConfigurationError` if it sets `prompt`, `collect`, `tools`, or `finalize`. `onEnter`, `prepare`, `onExit`, `branches`, `requires`, `skip` are all allowed. No schema change — auto-steps does not touch `SessionState`, existing persistence adapters need no migration.

---

## 14. Implicit Fork → Explicit Branches (Non-Breaking)

This is **optional**. The implicit-fork pattern (multiple successor steps each with their own `step.when`) still works in v2. `step.branches` is a new declarative form for the same routing behavior, recommended when the fork is the point of the step rather than incidental to it.

### When to convert

- The source step exists solely to route — it's a decision point, not a conversation node.
- Three or more successors with `when` conditions where the decision tree is hard to follow.
- You want code-only routing (`if`) to skip LLM evaluation entirely.
- You need mixed targets: some branches go to local steps, others jump to other flows or emit full Directives.

### Stay implicit when

- The flow reads as a linear chain A → B → C where B is occasionally skipped.
- Only two successors, with self-explanatory `when` conditions.

### Before / After

```typescript
// Before — routing scattered across 4 target steps
{
  steps: [
    { id: 'triage', prompt: 'How can I help?' },
    { id: 'billing',      when: 'asking about billing',       prompt: '…' },
    { id: 'tech_support', when: 'asking a technical question', prompt: '…' },
    { id: 'cancellation', when: 'wants to cancel',             prompt: '…' },
    { id: 'general',      prompt: '…' },
  ],
}

// After — routing declared once at the source
{
  steps: [
    {
      id: 'triage',
      prompt: 'How can I help?',
      branches: [
        { when: 'asking about billing',        then: 'billing' },
        { when: 'asking a technical question', then: 'tech_support' },
        { when: 'wants to cancel',             then: 'cancellation' },
        { then: 'general' }, // unconditional fallback (must be last)
      ],
    },
    { id: 'billing',      prompt: '…' },
    { id: 'tech_support', prompt: '…' },
    { id: 'cancellation', prompt: '…' },
    { id: 'general',      prompt: '…' },
  ],
}
```

Runtime behavior is identical: AI evaluates entries in declaration order; first match wins; an entry without `when`/`if` is the fallback. The only difference is where the routing logic lives.

### Mixed targets

Branches can route to local step ids, flow ids (sugar for `goTo`), or full Directives — implicit forks can only target steps in the same flow:

```typescript
branches: [
  { if: ({ data }) => data.plan === 'enterprise', then: 'enterprise_path' },           // local step
  { when: 'wants to cancel', then: 'CancellationFlow' },                                // flow id
  { when: 'needs a refund', then: { goTo: { flow: 'Refund', data: { source: 'triage' } } } }, // Directive
  { then: 'general' },
]
```

Upgrade an AI condition to a code condition by swapping `when` for `if` — the LLM call goes away:

```typescript
// Before: AI evaluates this — costs tokens
{ when: 'user is on the enterprise plan', then: 'enterprise_path' }

// After: code evaluates this — free
{ if: ({ data }) => data.plan === 'enterprise', then: 'enterprise_path' }
```

---

## Verification

After migrating, confirm no legacy references remain. Run from your repo root:

```bash
rg -n '\b(Route|RouteOptions|RoutingEngine|END_FLOW|END_ROUTE|ConditionTemplate|EnhancedTool|FlowTransitionConfig|FlowCompletionHandler|pendingTransition|nextStepFlow|transitionTo|endStep|BranchResult|BranchSpec|StepResult|appliedGuidelines|Guideline|Prohibition|skipIf|maxStepsPerBatch|BatchExecutor)\b' \
  --glob '**/*.ts' \
  --glob '!node_modules/**' \
  --glob '!dist/**'
```

Confirm v1 agent identity fields are gone:

```bash
rg -n '\b(description|identity|personality)\s*:' \
  --glob '**/*.ts' \
  --glob '!node_modules/**' \
  --glob '!dist/**' \
  | rg 'createAgent|new Agent\('
```

Then run the type checker:

```bash
npx tsc --noEmit
# or
bun run typecheck
```

If both commands return clean (no matches; exit code 0), your migration is complete.

## Cross-References

- [Route → Flow rename](./route-to-flow.md) — the rename pass that ships before v2
- [CHANGELOG](../../CHANGELOG.md) — full v2.0 release notes
