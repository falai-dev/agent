---
title: "Errors"
description: "Catch the typed error classes by class, narrow them with instanceof, and recover with the right pattern for each failure mode."
type: guide
order: 7
---

# Errors

`@falai/agent` throws typed `Error` subclasses for every failure mode the framework owns. Catching `Error` is fine for telemetry, but recovering well needs class-level narrowing — a `DataValidationError` wants a re-prompt, a `ToolExecutionError` wants a soft message and maybe a redirect, a `FlowConfigurationError` wants to crash the build. This page is the recipe for each. The full surface lives in the [errors reference](../reference/errors.md).

## The format contract

Every thrown message follows the same shape:

```text
[<ErrorClass>] <what>: <why>. <how to fix>.
```

The bracketed prefix mirrors the class name. The colon separates `<what>` from `<why>`. The trailing sentence is `<how to fix>`. The contract is uniform across the classes the framework throws — `FlowConfigurationError`, `DataValidationError`, `ToolExecutionError`, `ResponseGenerationError`, `SessionConflictError`, and `NotImplementedError` — so log lines and `try/catch` blocks parse the same way regardless of which class fired. The one exception is `ProviderError`, which carries the vendor's own message verbatim; its structure lives in the normalized `code` field instead.

The format applies to framework-thrown errors. If you write a custom tool or hook that throws, follow the same shape so downstream handlers stay uniform.

## The error classes

| Class | Thrown when | Recover by |
|-------|-------------|------------|
| `FlowConfigurationError` | Misconfigured agent: duplicate ids, unknown `collect` keys, malformed `Directive`, branch targets that don't resolve, auto-step cycles, function on `when`. | Don't. Surface in CI. |
| `DataValidationError` | A user message produces a value that violates the declared `schema`. | Re-prompt the user for the offending fields. |
| `ToolExecutionError` | The framework's config-driven tools (data enrichment / API call / computation configs) fail after internal retries. A plain handler that throws does **not** throw this — it soft-fails a failure result back to the model instead (see Pattern 3). | User-friendly message, optional retry, optional `agent.dispatch` to a recovery flow. |
| `ResponseGenerationError` | Anything inside the turn fails — provider call, parsing, persistence. Wraps the underlying error in `details.originalError`, also reachable as the native `err.cause`. | Inspect `.cause` first; backoff retry, fall back, or surface a soft failure. |
| `ProviderError` | A provider call fails terminally — retries and `backupModels` exhausted. Normalized `code` across all vendors; original SDK error on `cause`. | Match on `code`: backoff for `rate_limited` / `overloaded`, fix credentials for `auth`. |
| `SessionConflictError` | A session save carries a stale `version` — another writer persisted the session after this one loaded it. | Reload the session and retry the turn. |
| `NotImplementedError` | A reserved option is set to a value this version does not support (e.g. `routerMode: 'embedding'` in v2.0). | Use a supported value. Same posture as `FlowConfigurationError`. |

`FlowConfigurationError`, `ToolExecutionError`, `ProviderError`, `SessionConflictError`, `ResponseGenerationError`, and `NotImplementedError` are exported from `@falai/agent` and matchable with `instanceof`. Only `DataValidationError` is internal — match it by `error.name`.

How errors reach your `catch` depends on the class. `ProviderError` and `SessionConflictError` propagate **bare** out of `respond()` — no wrapping — so you can branch on them directly. Everything else thrown inside a turn arrives wrapped in a `ResponseGenerationError` whose native `.cause` (and `details.originalError`) holds the original. On the streaming path, errors are not thrown at all: they land on the terminal chunk's `error` field, wrapped the same way.

The provider stack classifies every failure as retriable or deterministic before spending budget: rate limits, overload, timeouts, and network faults retry with backoff; auth failures, invalid requests, and caller aborts fail fast because retrying would only repeat the outcome. By the time an error reaches your code, that machinery is exhausted.

One framing that makes recovery simpler: **a failed turn has no effect**. If `respond()` or `stream()` throws mid-turn, the in-memory session is rolled back to its pre-turn snapshot (the user message added by `chat()`/`stream()` before the turn is retained), and persisted state is whatever the previous turn saved. There is no partially mutated session to repair — retrying the turn is always safe.

## Pattern 1: try/catch + instanceof narrowing

Wrap every `agent.respond` and `agent.respondStream` call site. Narrow by class, return the right user-facing string per branch, rethrow what cannot be recovered.

```typescript
import {
  ProviderError,
  SessionConflictError,
  ToolExecutionError,
  ResponseGenerationError,
} from "@falai/agent";

try {
  const response = await agent.respond({ history, session });
  return response.message;
} catch (err) {
  // Typed operational errors propagate bare from respond() — narrow directly.
  if (err instanceof SessionConflictError) throw err;      // see Pattern 5
  if (err instanceof ProviderError) throw err;             // see Pattern 4

  // Everything else thrown inside the turn arrives wrapped in a
  // ResponseGenerationError; unwrap via `.cause` and narrow the original.
  const cause = err instanceof ResponseGenerationError ? err.cause : err;
  if (cause instanceof ToolExecutionError) {
    log.warn({ toolId: cause.toolId }, cause.message);
    return "Sorry — that action failed. Try again in a moment.";
  }
  if (cause instanceof Error && cause.name === "DataValidationError") {
    return "I need a couple of details cleared up — let's try that again.";
  }
  throw err;
}
```

The two bare classes rethrow to dedicated recovery paths. Wrapped errors narrow through `.cause` — a `ToolExecutionError` gets a soft message, a `DataValidationError` a clarifying question (Pattern 2). Anything unexpected falls through to the outer rethrow. Configuration bugs (`FlowConfigurationError`, `NotImplementedError`) belong in CI, not the request path — see Pattern 6.

## Pattern 2: DataValidationError → re-prompt

A `DataValidationError` carries an `errors: ValidationError[]` array naming the offending fields. Use it to ask the user a targeted clarifying question instead of a generic one.

```typescript
} catch (err) {
  const cause = err instanceof ResponseGenerationError ? err.cause : err;
  if (cause instanceof Error && cause.name === "DataValidationError") {
    const fields = (cause as { errors: { path: string; message: string }[] }).errors
      .map((e) => `${e.path} (${e.message})`)
      .join(", ");
    return `I couldn't read these from your message: ${fields}. Mind clarifying?`;
  }
  // ...
}
```

The framework does not retry by itself — the next user turn is the retry. Keep `session` alive between turns so the partial collection survives.

## Pattern 3: tool failures — soft-fail, then message, retry, or dispatch

First, what does *not* happen: a crashed handler does not crash the turn. When a tool handler throws — or a gate like `checkPermissions` denies the call — the executor catches it and feeds the model a failure result (`{"success": false, "error": "..."}`) as the tool's output. The model sees the failure honestly and can apologize, retry, or route around it; the turn continues. A thrown `ToolExecutionError` reaching your `catch` comes from the framework's config-driven tools (data enrichment, API call, computation configs), not from an ordinary handler.

When you do catch one, three shapes exist. Pick by what the failing tool was doing. In each, unwrap through `.cause` first — config-tool failures surface wrapped, like everything else from inside the turn.

**Soft failure — speak and continue.** A read-only tool that timed out: tell the user, let the conversation move on.

```typescript
const cause = err instanceof ResponseGenerationError ? err.cause : err;
if (cause instanceof ToolExecutionError) {
  log.warn({ toolId: cause.toolId }, cause.message);
  return "I couldn't fetch that just now. Want to try again?";
}
```

**Optional retry.** Wrap the `respond` call in a small retry loop for transient errors.

```typescript
for (let attempt = 0; attempt < 2; attempt++) {
  try {
    return (await agent.respond({ history, session })).message;
  } catch (err) {
    const cause = err instanceof ResponseGenerationError ? err.cause : err;
    if (cause instanceof ToolExecutionError && attempt === 0) {
      await new Promise((r) => setTimeout(r, 250));
      continue;
    }
    throw err;
  }
}
```

**Recovery flow.** Hard failures — a payment tool that hit a permanent denial — should redirect into a recovery flow rather than echo the error. Dispatch a directive against the session so the *next* turn enters the recovery flow.

```typescript
const cause = err instanceof ResponseGenerationError ? err.cause : err;
if (cause instanceof ToolExecutionError && cause.toolId === "charge_card") {
  await agent.dispatch({ goTo: "PaymentRecovery" }, session);
  return "I hit a snag with that payment. Let me walk you through it.";
}
```

The dispatched [`Directive`](../reference/directive.md) lands in `session.pendingDirective` and is consumed at the start of the next turn.

## Pattern 4: ProviderError → match the code, backoff or fallback provider

Terminal provider failures throw `ProviderError` with a normalized `code` (`rate_limited`, `overloaded`, `auth`, `invalid_request`, `schema_rejected`, `timeout`, `network`, `unknown`) — the same shape whether you run Gemini, OpenAI, Anthropic, OpenRouter, or DeepSeek. From `respond()` it propagates **bare** — narrow with `instanceof` directly, no unwrapping. On the streaming path it arrives on the terminal chunk's `error`, wrapped in a `ResponseGenerationError` whose `.cause` holds the original.

Before an error ever reaches you, the provider stack has classified it: transient failures (`rate_limited`, `overloaded`, `timeout`, `network`) consumed the retry budget and any `backupModels`; deterministic ones (`auth`, `invalid_request`, caller aborts) failed fast without burning retries. So by catch time, retrying the same call is usually pointless — fall back to a second provider or surface the failure.

```typescript
import { ProviderError } from "@falai/agent";

async function respondWithFallback(history: HistoryItem[], session: Session) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await primaryAgent.respond({ history, session });
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err;
      if (err.code === "auth" || err.code === "invalid_request") {
        throw err; // config bug — retrying won't help
      }
      await new Promise((r) => setTimeout(r, 200 * 2 ** attempt));
    }
  }
  return fallbackAgent.respond({ history, session });
}
```

Both agents share the same `flows`, `tools`, and `schema` — only the `provider` differs. The session is provider-agnostic, so the fallback picks up exactly where the primary left off. The original SDK error stays available on `providerError.cause` for vendor-specific logging.

## Pattern 5: SessionConflictError → reload and retry

With a durable adapter, every save is a compare-and-swap on the session's `version`. When two writers race — concurrent `respond()` calls from parallel webhooks, two browser tabs on one `sessionId` — the loser's save throws `SessionConflictError` instead of silently overwriting the winner's state. (Same-process concurrent saves of one session are serialized automatically and never conflict.)

The error names `sessionId`, `expectedVersion`, and `actualVersion`. The recovery is mechanical: reload the session, retry the turn. The failed turn rolled back, so there is nothing to clean up.

```typescript
import { ResponseGenerationError, SessionConflictError } from "@falai/agent";

function isSessionConflict(err: unknown): boolean {
  if (err instanceof SessionConflictError) return true; // bare from respond()
  if (err instanceof ResponseGenerationError) {
    return err.cause instanceof SessionConflictError; // wrapped on the stream path
  }
  return false;
}

try {
  return await agent.respond({ history, session });
} catch (err) {
  if (isSessionConflict(err)) {
    const fresh = await agent.session.getOrCreate(sessionId); // reload winning state
    return agent.respond({ history, session: fresh });
  }
  throw err;
}
```

Cap the retries — a hot session under sustained contention should surface the conflict rather than spin. See [Persistence](./persistence.md) for how the `version` column works per adapter.

## Pattern 6: FlowConfigurationError → don't catch in production

`FlowConfigurationError` is a *bug*, not a runtime condition. It fires when the agent definition is malformed: a step references a flow id that doesn't exist, two steps share a `collect` key, a branch target points nowhere, an auto-step chain loops. The right place to catch it is the test runner and CI — never the request path.

Smoke-test agent construction in CI so misconfiguration crashes the build rather than the first user request:

```typescript
import { describe, expect, it } from "bun:test";
import { FlowConfigurationError } from "@falai/agent";
import { buildAgent } from "../src/agent";

describe("agent construction", () => {
  it("builds without configuration errors", () => {
    expect(() => buildAgent()).not.toThrow(FlowConfigurationError);
  });
});
```

In the request handler, let it bubble all the way up. A 500 plus a loud log is the correct outcome — the next deploy is the fix.

```typescript
if (err instanceof FlowConfigurationError) throw err;
```

`NotImplementedError` follows the same posture: it means a reserved option was set to a value this version doesn't support. Read the message, fix the config, ship the fix. Don't catch it.

**Next:** [Compaction](./compaction.md)
