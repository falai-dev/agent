---
title: Flow
description: A goal-shaped sequence of steps with shared schema, conditions, and completion semantics.
type: reference
order: 2
---

# Flow

> **Where this is introduced:** [Architecture](../concepts/architecture.md)

A `Flow` is one of the six primitives in `@falai/agent`. It models a single conversational goal — booking a hotel, escalating a complaint, onboarding a teammate — as an ordered set of steps that share the agent's typed `TData` schema. Flows declare what data they need (`requiredFields`), what extra data they can use (`optionalFields`), when they should activate (`when` for AI strings, `if` for code), and what happens when they finish (`onComplete` or `hooks.onComplete`). The router selects exactly one flow per turn; once the active flow's required fields are satisfied, the engine fires its completion path.

## Signature

```typescript
interface FlowOptions<TContext = unknown, TData = unknown> {
  id?: string;
  title: string;
  description?: string;

  when?: ConditionWhen;                                // string | string[]
  if?: ConditionIf<TContext, TData>;                   // predicate | predicate[]

  instructions?: Instruction<TContext, TData>[];
  tools?: (string | Tool<TContext, TData>)[];

  routingExtrasSchema?: StructuredSchema;
  responseOutputSchema?: StructuredSchema;

  requiredFields?: (keyof TData)[];
  optionalFields?: (keyof TData)[];
  initialData?: Partial<TData>;

  steps?: StepOptions<TContext, TData>[];

  onComplete?: string;                                 // top-level: string sugar only
  reentrant?: boolean;                                 // default false

  hooks?: FlowLifecycleHooks<TContext, TData>;
}

class Flow<TContext = unknown, TData = unknown> {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly when?: ConditionWhen;
  readonly if?: ConditionIf<TContext, TData>;
  readonly initialStep: Step<TContext, TData>;
  readonly requiredFields?: (keyof TData)[];
  readonly optionalFields?: (keyof TData)[];
  readonly initialData?: Partial<TData>;
  readonly onComplete?: string;
  readonly reentrant: boolean;
  readonly hooks?: FlowLifecycleHooks<TContext, TData>;

  constructor(options: FlowOptions<TContext, TData>, parentAgent?: Agent<TContext, TData>);

  addStep(options: StepOptions<TContext, TData>): Step<TContext, TData>;
  getSteps(): Step<TContext, TData>[];
  getStep(stepId: string): Step<TContext, TData> | undefined;
  getInstructions(): Instruction<TContext, TData>[];
  getTools(): Tool<TContext, TData>[];

  isComplete(data: Partial<TData>): boolean;
  getMissingRequiredFields(data: Partial<TData>): (keyof TData)[];
  getCompletionProgress(data: Partial<TData>): number;
}
```

## Fields

### `FlowOptions`

| Field                 | Type                                              | Required | Default | Notes                                                                                                                                              |
| --------------------- | ------------------------------------------------- | -------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                  | `string`                                          | no       | derived from `title` | Stable identifier. Auto-generated deterministically from the title when omitted.                                                                                 |
| `title`               | `string`                                          | yes      | —       | Human-readable name. Shown to the router and used as the default flow id.                                                                          |
| `description`         | `string`                                          | no       | —       | One-line summary surfaced to the router prompt.                                                                                                    |
| `when`                | `string \| string[]`                              | no       | —       | AI-evaluated activation condition(s). Strings only — functions belong on `if`. Multiple strings combine with AND semantics.                        |
| `if`                  | `(ctx) => boolean \| Promise<boolean>` or array   | no       | —       | Code-evaluated activation condition(s). Free to evaluate. When both are set, `if` runs first; `when` only evaluates if `if` passes.                |
| `instructions`        | `Instruction<TContext, TData>[]`                  | no       | `[]`    | Flow-scoped instructions. Apply only while this flow is active. See [Instruction](./instruction.md).                                               |
| `tools`               | `(string \| Tool)[]`                              | no       | `[]`    | Tool ids (resolved via the agent's tool registry) or inline `Tool` objects. Available only while this flow is active.                              |
| `routingExtrasSchema` | `StructuredSchema`                                | no       | —       | Optional extra fields the router may extract during routing.                                                                                       |
| `responseOutputSchema`| `StructuredSchema`                                | no       | —       | Optional structured response shape for this flow's assistant messages.                                                                             |
| `requiredFields`      | `(keyof TData)[]`                                 | no       | —       | Fields that must be present in `session.data` for the flow to complete. Drives `isComplete` and progress calculation.                              |
| `optionalFields`      | `(keyof TData)[]`                                 | no       | —       | Fields the flow uses but doesn't require. Tracked for re-entry resets and progress visibility only.                                                |
| `initialData`         | `Partial<TData>`                                  | no       | —       | Pre-populated values applied when the flow is entered. Merged into `session.data`.                                                                 |
| `steps`               | `StepOptions<TContext, TData>[]`                  | no       | —       | Sequential steps. The first becomes the initial step; the rest are chained as linear successors. The last step is the implicit terminus.           |
| `onComplete`          | `string`                                          | no       | —       | **String only.** Sugar for `hooks.onComplete = () => ({ goTo: '<id>' })`. For dynamic completion logic, use `hooks.onComplete`.                    |
| `reentrant`           | `boolean`                                         | no       | `false` | If `true`, the router may select this flow again after it has completed in the current session. On re-entry, declared `requiredFields` and `optionalFields` are cleared. |
| `hooks`               | `FlowLifecycleHooks<TContext, TData>`             | no       | —       | Lifecycle hooks: `onEnter`, `onExit`, `onComplete`, `onDataUpdate`, `onContextUpdate`. See below.                                                   |

### `FlowLifecycleHooks`

| Hook              | Returns                                | Phase    | Notes                                                                                                                  |
| ----------------- | -------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------- |
| `onEnter`         | `void \| Directive`                    | pre-LLM  | Fires when the flow is entered. May augment the prompt, inject tools, or `halt`. Pre-LLM fields honored here.|
| `onExit`          | `void`                                 | post     | Informational. Receives an `ExitReason`; cannot influence flow control.                                                |
| `onComplete`      | `void \| Directive`                    | post-LLM | Handler form of completion. Mutually exclusive with top-level `onComplete: string` — setting both throws.              |
| `onDataUpdate`    | `Partial<TData>`                       | post     | Mutate or enrich the data update before it is committed to `session.data`.                                             |
| `onContextUpdate` | `void`                                 | post     | Informational reaction to context updates while this flow is active.                                                   |

### `Flow` instance methods

| Method                                       | Returns                          | Notes                                                                                              |
| -------------------------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------- |
| `addStep(options)`                           | `Step<TContext, TData>`          | Imperatively append a step as the successor of the current last step. Same validations as `steps[]`. |
| `getSteps()`                                 | `Step<TContext, TData>[]`        | All steps reachable from the initial step via BFS traversal.                                       |
| `getStep(stepId)`                            | `Step \| undefined`              | Look up a step by id.                                                                              |
| `getInstructions()`                          | `Instruction[]`                  | Flow-scoped instructions (a copy).                                                                 |
| `getTools()`                                 | `Tool[]`                         | Flow-scoped tools (a copy).                                                                        |
| `isComplete(data)`                           | `boolean`                        | `true` when all `requiredFields` are populated. Optional-only flows complete on terminus, not data. |
| `getMissingRequiredFields(data)`             | `(keyof TData)[]`                | Fields from `requiredFields` not yet present in `data`.                                            |
| `getCompletionProgress(data)`                | `number` (0–1)                   | Fraction of `requiredFields` satisfied. `0` when only `optionalFields` are declared.               |

### Completion semantics

A flow finishes in one of three ways:

1. **All `requiredFields` are satisfied.** The engine marks the flow complete, fires `hooks.onComplete` (or the desugared `onComplete: string` transition), and applies the returned `Directive`.
2. **The last step in `steps[]` runs and `requiredFields` is empty.** The terminus rule applies — the flow is implicitly complete, and the same completion path runs.
3. **A `Directive` with `complete: true` is returned** from a tool, hook, or branch while the flow is active. Completion fires immediately regardless of field state.

`requiredFields` is the contract for "this flow is done." `optionalFields` is descriptive metadata — it never gates completion, but it's tracked for two reasons:

- **Re-entry resets.** When `reentrant: true` and the router re-selects this flow after it has completed, every field listed in `requiredFields` and `optionalFields` is cleared so the flow starts fresh.
- **Progress visibility.** `getCompletionProgress` ignores optional fields by design — progress reflects what the flow is *blocked on*, not what it has *touched*.

### `reentrant` behavior

By default (`reentrant: false`), once a flow completes the router excludes it from candidate selection for the rest of the session. Set `reentrant: true` to support patterns like "book another?", "file another ticket?", or "search again". On re-entry:

- All `requiredFields` and `optionalFields` are cleared from `session.data`.
- Other fields in `session.data` are preserved.
- The flow restarts from its initial step.

`onComplete` always wins over `reentrant`. If `onComplete` (or `hooks.onComplete`) returns a target, the session transitions there. `reentrant` is consulted only when the completion handler is absent or returns `undefined`.

### Top-level `onComplete` vs `hooks.onComplete`

The top-level `onComplete` is **string-only** sugar. Internally, the constructor desugars `onComplete: 'targetFlow'` into `hooks.onComplete = () => ({ goTo: 'targetFlow' })`. Use the handler form when you need conditional transitions, data writes, or any logic beyond a static target id.

| Use this           | When                                                                                |
| ------------------ | ----------------------------------------------------------------------------------- |
| `onComplete: 'id'` | You always want to chain into the same next flow when this one finishes.            |
| `hooks.onComplete` | The next flow depends on collected data, or you want to write state on completion.  |

> Setting **both** the top-level `onComplete` and `hooks.onComplete` on the same flow throws `FlowConfigurationError` at construction time. Pick one.

## Examples

### Basic linear flow

```typescript
import { createAgent, Flow, GeminiProvider } from "@falai/agent";

interface BookingData {
  destination: string;
  checkIn: string;
  guests: number;
}

const bookHotel = new Flow<unknown, BookingData>({
  title: "Book Hotel",
  description: "Collect destination, check-in date, and party size, then book.",
  when: "the user wants to book a hotel",
  requiredFields: ["destination", "checkIn", "guests"],
  steps: [
    { description: "Greet and ask destination", collect: ["destination"] },
    { description: "Ask check-in date",         collect: ["checkIn"] },
    { description: "Ask guest count",           collect: ["guests"] },
  ],
});

const agent = createAgent<unknown, BookingData>({
  schema: { /* ... */ },
  provider: new GeminiProvider({ apiKey: process.env.GEMINI_API_KEY! }),
  flows: [bookHotel],
});
```

### Completion handler with state writes and chained transition

```typescript
import { Flow } from "@falai/agent";

const bookHotel = new Flow<AppContext, BookingData>({
  title: "Book Hotel",
  requiredFields: ["destination", "checkIn", "guests"],
  reentrant: true,                                          // allow "book another?" loops
  steps: [/* ... */],
  hooks: {
    onComplete: ({ data }) => ({
      dataUpdate: { lastBookedAt: new Date().toISOString() },
      goTo: data.guests > 4 ? "Group Coordination" : "Confirmation",
      reason: "booking finalized",
    }),
  },
});
```

### Imperative `addStep` after construction

```typescript
const supportFlow = new Flow({
  title: "Support",
  steps: [{ description: "Capture issue summary", collect: ["issue"] }],
});

// Later — extend the flow programmatically.
supportFlow.addStep({
  description: "Triage severity",
  collect: ["severity"],
});
```

> Calling `addStep` after the agent has handled a turn emits a debug-level warning that the flow graph is being mutated mid-session. The new step is still registered and connected as the successor of the current last step.

## Errors

| Error                       | When it's thrown                                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `FlowConfigurationError`    | Both top-level `onComplete` and `hooks.onComplete` are set on the same flow.                                        |
| `FlowConfigurationError`    | A function appears in `when` (functions belong on `if`).                                                            |
| `FlowConfigurationError`    | A step inside `steps[]` violates auto-step or reply-step shape rules (raised from the underlying `Step` constructor). |

All `FlowConfigurationError` messages follow the format `[FlowConfigurationError] <what>: <why>. <how to fix>.` See [Errors](./errors.md).

## Related

- [Architecture](../concepts/architecture.md) — where Flow fits among the six primitives
- [Turn pipeline](../concepts/pipeline.md) — when flows are selected, entered, and completed
- [Step](./step.md) — the inner DSL primitive flows are composed of
- [Directive](./directive.md) — what `hooks.onComplete` returns
- [Instruction](./instruction.md) — flow-scoped behavioral nudges
- [Branching](../guides/branching.md) — explicit forks inside a flow
- [Flow control](../guides/flow-control.md) — completion, dispatch, and verbatim replies
