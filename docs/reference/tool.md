---
title: "Tool"
description: "The function-call surface the AI can invoke, with optional metadata for safety, concurrency, validation, and permissions."
type: reference
order: 4
---

# Tool

> **Where this is introduced:** [Add tools](../start/04-add-tools.md)

A `Tool` is a function the agent can invoke during a turn. v2 unifies tools into a single interface — every metadata field is optional. The handler receives a `ToolContext` (with `dispatch` for mid-handler redirection) and may return a plain value or a `ToolResult` (with an optional `directive` for declarative redirection on return).

`Tool.id` is the sole identifier.

## Signature

```typescript
interface Tool<TContext = any, TData = any, TResult = any> {
  // Identity
  id: string;
  description?: string;
  parameters?: unknown;

  // Handler
  handler: ToolHandler<TContext, TData, TResult>;

  // Optional metadata
  isReadOnly?(input?: Record<string, unknown>): boolean;
  isConcurrencySafe?(input?: Record<string, unknown>): boolean;
  isDestructive?(input?: Record<string, unknown>): boolean;
  interruptBehavior?(): 'cancel' | 'block';
  maxResultSizeChars?: number;

  validateInput?(
    input: Record<string, unknown>,
    context: ToolContext<TContext, TData>,
  ): Promise<ToolValidationResult> | ToolValidationResult;

  checkPermissions?(
    input: Record<string, unknown>,
    context: ToolContext<TContext, TData>,
  ): Promise<ToolPermissionResult> | ToolPermissionResult;
}

type ToolHandler<TContext, TData, TResult> = (
  ctx: ToolContext<TContext, TData>,
  args?: Record<string, unknown>,
) =>
  | Promise<TResult | ToolResult<TResult, TContext, TData>>
  | TResult
  | ToolResult<TResult, TContext, TData>;

interface ToolContext<TContext, TData> {
  context: TContext;
  data: Partial<TData>;
  history: Event[];
  step?: StepRef;
  metadata?: Record<string, unknown>;

  updateContext(updates: Partial<TContext>): Promise<void>;
  updateData(updates: Partial<TData>): Promise<void>;
  getField<K extends keyof TData>(key: K): TData[K] | undefined;
  setField<K extends keyof TData>(key: K, value: TData[K]): Promise<void>;
  hasField<K extends keyof TData>(key: K): boolean;

  /** Imperative redirection — emit a directive mid-handler. */
  dispatch(directive: Directive<TContext, TData>): void;
}

interface ToolResult<TResultData, TContext, TData> {
  data?: TResultData;
  contextUpdate?: Partial<TContext>;
  dataUpdate?: Partial<TData>;
  success?: boolean;
  error?: string;
  meta?: Record<string, unknown>;
  /** Declarative redirection — emit a directive on return. */
  directive?: Directive<TContext, TData>;
}

interface ToolValidationResult {
  valid: boolean;
  error?: string;
  correctedInput?: Record<string, unknown>;
}

interface ToolPermissionResult {
  allowed: boolean;
  reason?: string;
  canOverride?: boolean;
}
```

## Fields

### `Tool`

| Field | Type | Required | Default | Notes |
|-------|------|----------|---------|-------|
| `id` | `string` | yes | — | Unique identifier. The AI references this name when calling the tool. There is no separate `name` field. |
| `handler` | `ToolHandler` | yes | — | The function the AI invokes. Receives `ctx` and optional `args`. |
| `description` | `string` | no | — | Free-form description for AI tool discovery. |
| `parameters` | `unknown` | no | — | Argument schema (provider-specific shape; pass through to the LLM). |
| `isReadOnly` | `(input?) => boolean` | no | — | Returns `true` when the call has no side effects. Enables result caching and concurrency. |
| `isConcurrencySafe` | `(input?) => boolean` | no | — | Returns `true` when this call may run in parallel with other concurrent-safe calls. |
| `isDestructive` | `(input?) => boolean` | no | — | Returns `true` for irreversible operations. Surfaces to confirmation UIs. |
| `interruptBehavior` | `() => 'cancel' \| 'block'` | no | `'cancel'` | How the tool reacts to abort signals. `'block'` waits for natural completion. |
| `maxResultSizeChars` | `number` | no | — | Truncation cap for the serialized result, before history compaction. |
| `validateInput` | `(input, ctx) => ToolValidationResult` | no | — | Pre-execution input check. May return `correctedInput` to repair the call. |
| `checkPermissions` | `(input, ctx) => ToolPermissionResult` | no | — | Pre-execution gate. When `allowed: false`, the handler is **not** invoked. |

### `ToolContext`

| Field | Type | Notes |
|-------|------|-------|
| `context` | `TContext` | Ambient app data (user, env, services). |
| `data` | `Partial<TData>` | Everything collected so far across the conversation. |
| `history` | `Event[]` | Native multi-turn history (read-only). |
| `step` | `StepRef \| undefined` | Identifies the current flow/step when the tool runs inside a flow. |
| `metadata` | `Record<string, unknown> \| undefined` | Free-form per-call metadata. |
| `updateContext` | `(updates) => Promise<void>` | Shallow-merge into `context`. Triggers context lifecycle hooks. |
| `updateData` | `(updates) => Promise<void>` | Shallow-merge into `data`. Triggers data lifecycle hooks. |
| `getField` / `setField` / `hasField` | `(key) => …` | Typed accessors over `data`. |
| `dispatch` | `(directive) => void` | Imperative directive emit. May be called multiple times; emissions are merged by Algorithm 4 alongside other tool/hook directives this turn. |

### `ToolResult`

| Field | Type | Notes |
|-------|------|-------|
| `data` | `TResultData` | The value the AI sees as the tool result. |
| `contextUpdate` | `Partial<TContext>` | Shallow-merged into `context` after the call. |
| `dataUpdate` | `Partial<TData>` | Shallow-merged into `data` after the call. |
| `success` | `boolean` | When `false`, the executor treats this as a failed call and surfaces `error`. |
| `error` | `string` | Failure message when `success === false`. |
| `meta` | `Record<string, unknown>` | Free-form metadata (stored on the tool event). |
| `directive` | `Directive` | Declarative redirection. Equivalent to calling `ctx.dispatch(directive)` once. |

### `ToolValidationResult`

| Field | Type | Notes |
|-------|------|-------|
| `valid` | `boolean` | `false` blocks execution and surfaces `error` to the AI. |
| `error` | `string` | Why validation failed. |
| `correctedInput` | `Record<string, unknown>` | When present, the executor retries with this input instead of the original. |

### `ToolPermissionResult`

| Field | Type | Notes |
|-------|------|-------|
| `allowed` | `boolean` | `false` blocks execution; the handler is never called. |
| `reason` | `string` | Why permission was denied. |
| `canOverride` | `boolean` | Hint to UIs: the user may grant a one-time override. |

## Examples

### 1. Imperative redirection with `ctx.dispatch`

A tool that runs mid-flow and decides the rest of the turn is moot — for example, an eligibility check that fails and should jump straight to a denial flow.

```typescript
import type { Tool } from "@falai/agent";

type Ctx = { userId: string };
type Data = { country: string };

export const checkEligibility: Tool<Ctx, Data, { ok: boolean }> = {
  id: "check_eligibility",
  description: "Verify the user can proceed with booking.",
  isReadOnly: () => true,
  async handler(ctx) {
    const ok = await isEligible(ctx.context.userId, ctx.data.country);

    if (!ok) {
      // Imperative: stop reasoning, jump to the denial flow.
      ctx.dispatch({
        goTo: "denial",
        reply: "Sorry — you're not eligible for this service.",
      });
      return { ok: false };
    }

    return { ok: true };
  },
};
```

### 2. Declarative redirection with `ToolResult.directive`

The same tool, written as a value-returning handler. The directive rides back on the result and is merged identically.

```typescript
export const checkEligibility: Tool<Ctx, Data, { ok: boolean }> = {
  id: "check_eligibility",
  description: "Verify the user can proceed with booking.",
  isReadOnly: () => true,
  async handler(ctx) {
    const ok = await isEligible(ctx.context.userId, ctx.data.country);

    if (!ok) {
      return {
        data: { ok: false },
        directive: {
          goTo: "denial",
          reply: "Sorry — you're not eligible for this service.",
        },
      };
    }

    return { data: { ok: true } };
  },
};
```

### 3. Validation, permissions, and write semantics

A destructive tool that validates its input, checks permissions, and writes back into `data`.

```typescript
export const bookHotel: Tool<Ctx, Data, { id: string }> = {
  id: "book_hotel",
  description: "Reserve a hotel for the collected dates.",
  isDestructive: () => true,
  isConcurrencySafe: () => false,
  maxResultSizeChars: 2_000,

  validateInput(input) {
    if (typeof input.nights !== "number" || input.nights < 1) {
      return { valid: false, error: "`nights` must be a positive integer." };
    }
    return { valid: true };
  },

  checkPermissions(_input, ctx) {
    if (!ctx.context.userId) {
      return { allowed: false, reason: "Sign in required.", canOverride: false };
    }
    return { allowed: true };
  },

  async handler(ctx, args) {
    const id = await api.book(ctx.context.userId, args);
    return {
      data: { id },
      dataUpdate: { bookingId: id },
      success: true,
    };
  },
};
```

## Errors

Misuse surfaces as typed errors from the executor:

- `ToolExecutionError` — handler threw, returned `success: false`, exceeded `maxResultSizeChars` after compaction, or the tool was invoked with arguments that fail `validateInput` and cannot be corrected.
- `FlowConfigurationError` — a returned `directive` is malformed (e.g., two position fields set, or `goTo` references an unknown flow/step).
- `DataValidationError` — `dataUpdate` violates the agent schema.

Permission denials (`checkPermissions` returning `allowed: false`) are surfaced as a structured tool result with `success: false` and `error: <reason>` rather than a thrown error — this keeps the AI's reasoning loop intact.

## Related

- [Add tools](../start/04-add-tools.md) — tutorial that introduces this type.
- [Architecture](../concepts/architecture.md) — where Tool fits among the six primitives.
- [Directives](../concepts/directives.md) — what `dispatch` and `directive` emit.
- [Directive](./directive.md) — the flat shape used by both forms above.
- [Flow control](../guides/flow-control.md) — recipes for redirecting from tools and hooks.
- [Errors](./errors.md) — `ToolExecutionError` format contract.
