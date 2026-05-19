---
title: "PreDirective"
description: "Directive variant returned by pre-LLM hooks; adds prompt and tool shaping for the current turn."
type: reference
order: 7
---

# PreDirective

> **Where this is introduced:** [Directives](../concepts/directives.md)

`PreDirective<TContext, TData>` is the variant of [`Directive`](./directive.md)
that pre-LLM hooks return. It inherits every Directive field — position writes
(`goTo`, `goToStep`, `complete`, `abort`, `reset`), the verbatim `reply`, and
state writes (`dataUpdate`, `contextUpdate`) — and adds three fields that only
make sense before this turn's LLM call: `appendPrompt`, `injectTools`, and
`halt`.

Lifetime is one turn. PreDirective fields are stripped before
`session.pendingDirective` is written, so they cannot persist across turns and
cannot be assigned to `pendingDirective` directly.

PreDirective is the return type of:

- `flow.hooks.onEnter`
- `step.hooks.onEnter`
- `step.hooks.prepare`
- the merged pre-LLM phase of the directive bus
- a [`Signal`](./signals.md) firing in the pre-phase (via `SignalDirective`,
  which extends PreDirective)

Post-LLM hooks (`step.hooks.finalize`, `flow.hooks.onComplete`) return plain
`Directive` — the three PreDirective-only fields have no effect post-LLM and
are dropped with a debug log if present.

## Signature

```typescript
interface PreDirective<TContext = unknown, TData = unknown>
  extends Directive<TContext, TData> {
  appendPrompt?: string[];
  injectTools?: Array<Tool<TContext, TData>>;
  halt?: boolean;
}
```

## Fields

| Field | Type | Required | Default | Notes |
|-------|------|----------|---------|-------|
| `appendPrompt` | `string[]` | no | — | Sentences appended to the system prompt for THIS turn only via `PromptComposer`'s transient appendage slot. Merged across hooks by array-concat (Algorithm 4). Never cached, never persisted. |
| `injectTools` | `Tool<TContext, TData>[]` | no | — | Tools added to the available tool list for THIS turn only via `ToolManager`'s transient layer. Merged across hooks by concat-then-dedupe by `Tool.id` (last definition wins). Tool references are not serializable, so this field never persists. |
| `halt` | `boolean` | no | `false` | When `true`, skip the LLM call entirely this turn. Merged by logical-OR. Co-validates with `reply`: if both are set the `reply` is emitted and the turn ends with `stoppedReason: 'reply'`; if `halt` is set without `reply` the turn ends with `stoppedReason: 'halt'` and an empty assistant message. |
| *…all `Directive` fields* | — | — | — | See [Directive](./directive.md) for `goTo`, `goToStep`, `complete`, `abort`, `reset`, `reply`, `dataUpdate`, `contextUpdate`. Mutually-exclusive position rules apply identically. |

## Examples

### Append a sentence to the prompt for this turn

```typescript
import type { PreDirective } from '@falai/agent';

const flow = {
  title: 'Booking',
  hooks: {
    onEnter: (ctx): PreDirective => {
      if (ctx.context.user.tier === 'vip') {
        return {
          appendPrompt: ['This caller is a VIP — confirm preferences before suggesting options.'],
        };
      }
    },
  },
  steps: [/* ... */],
};
```

### Inject a one-shot tool, then halt the LLM call

```typescript
import type { PreDirective, Tool } from '@falai/agent';

const lookupAccount: Tool = {
  id: 'lookup_account',
  description: 'Fetch the caller\'s account record.',
  parameters: { type: 'object', properties: {} },
  handler: async (ctx) => ({ content: JSON.stringify(await fetchAccount(ctx.context.user.id)) }),
};

const step = {
  id: 'verify',
  prompt: 'Verify the caller before proceeding.',
  hooks: {
    prepare: async (ctx): Promise<PreDirective> => {
      if (!ctx.data.verified) {
        // Make the tool available for THIS turn only and let the model call it.
        return { injectTools: [lookupAccount] };
      }
      // Already verified — skip the LLM, emit a deterministic reply.
      return { halt: true, reply: 'Verified. How can I help?' };
    },
  },
};
```

## Errors

`PreDirective` shares Directive's construction-time validation. The following
typed errors may be thrown by `flow.validate(...)` or by the directive bus
when an invalid PreDirective is emitted:

- `FlowConfigurationError` — multiple position fields set (`goTo`, `goToStep`, `complete`, `abort`, `reset`); `reply` co-existing with `abort`; `goTo` set as an empty object.

PreDirective-only fields surface no extra construction errors. Two runtime
behaviors are notable rather than thrown:

- Assigning a PreDirective with `appendPrompt`, `injectTools`, or `halt` to
  `session.pendingDirective` causes those fields to be stripped before the
  write (with a debug log). The remaining Directive fields persist normally.
- Returning a PreDirective from a post-LLM hook (`finalize`, `onComplete`)
  causes the three PreDirective-only fields to be dropped with a debug log;
  the Directive fields are honored.

## Related

- [Directives](../concepts/directives.md) — the mental model for the Directive → PreDirective → SignalDirective inheritance chain
- [Directive](./directive.md) — the parent interface and field semantics for position writes, `reply`, and state writes
- [Step](./step.md) — `hooks.onEnter` and `hooks.prepare` return `PreDirective`
- [Flow](./flow.md) — `hooks.onEnter` returns `PreDirective`
- [Signals](./signals.md) — `SignalDirective` extends `PreDirective` for pre-phase signal firings
- [Tool](./tool.md) — the type of values in `injectTools[]`
