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

The bracketed prefix mirrors the class name. The colon separates `<what>` from `<why>`. The trailing sentence is `<how to fix>`. The contract is uniform across the five classes the framework throws — `FlowConfigurationError`, `DataValidationError`, `ToolExecutionError`, `ResponseGenerationError`, and `NotImplementedError` — so log lines and `try/catch` blocks parse the same way regardless of which class fired.

The format applies to framework-thrown errors. If you write a custom tool or hook that throws, follow the same shape so downstream handlers stay uniform.

## The five classes

| Class | Thrown when | Recover by |
|-------|-------------|------------|
| `FlowConfigurationError` | Misconfigured agent: duplicate ids, unknown `collect` keys, malformed `Directive`, branch targets that don't resolve, auto-step cycles, function on `when`. | Don't. Surface in CI. |
| `DataValidationError` | A user message produces a value that violates the declared `schema`. | Re-prompt the user for the offending fields. |
| `ToolExecutionError` | A tool handler throws, all retries fail, or `validateInput` cannot correct invalid args. | User-friendly message, optional retry, optional `agent.dispatch` to a recovery flow. |
| `ResponseGenerationError` | The provider call fails or the response cannot be parsed. | Backoff retry, fall back to a different provider, or surface a soft failure. |
| `NotImplementedError` | A reserved option is set to a value this version does not support (e.g. `routerMode: 'embedding'` in v2.0). | Use a supported value. Same posture as `FlowConfigurationError`. |

`FlowConfigurationError`, `ToolExecutionError`, and `NotImplementedError` are exported from `@falai/agent` and matchable with `instanceof`. `DataValidationError` and `ResponseGenerationError` are internal — match them by `error.name`.

## Pattern 1: try/catch + instanceof narrowing

Wrap every `agent.respond` and `agent.respondStream` call site. Narrow by class, return the right user-facing string per branch, rethrow what cannot be recovered.

```typescript
import {
  FlowConfigurationError,
  ToolExecutionError,
  NotImplementedError,
} from "@falai/agent";

try {
  const response = await agent.respond({ history, session });
  return response.message;
} catch (err) {
  if (err instanceof FlowConfigurationError) throw err;     // bug — bubble up
  if (err instanceof NotImplementedError) throw err;        // config bug — bubble up
  if (err instanceof ToolExecutionError) {
    log.warn({ toolId: err.toolId, cause: err.cause }, err.message);
    return "Sorry — that action failed. Try again in a moment.";
  }
  if (err instanceof Error && err.name === "DataValidationError") {
    return "I need a couple of details cleared up — let's try that again.";
  }
  if (err instanceof Error && err.name === "ResponseGenerationError") {
    return "I'm having trouble reaching the model. Please retry.";
  }
  throw err;
}
```

The two unrecoverable classes — `FlowConfigurationError` and `NotImplementedError` — get rethrown so the process crashes loudly. The other three return a graceful message. Anything unexpected falls through to the outer rethrow.

## Pattern 2: DataValidationError → re-prompt

A `DataValidationError` carries an `errors: ValidationError[]` array naming the offending fields. Use it to ask the user a targeted clarifying question instead of a generic one.

```typescript
} catch (err) {
  if (err instanceof Error && err.name === "DataValidationError") {
    const fields = (err as { errors: { path: string; message: string }[] }).errors
      .map((e) => `${e.path} (${e.message})`)
      .join(", ");
    return `I couldn't read these from your message: ${fields}. Mind clarifying?`;
  }
  // ...
}
```

The framework does not retry by itself — the next user turn is the retry. Keep `session` alive between turns so the partial collection survives.

## Pattern 3: ToolExecutionError → message, retry, or dispatch

Tool failures have three shapes. Pick by what the failing tool was doing.

**Soft failure — speak and continue.** A read-only tool that timed out: tell the user, let the conversation move on.

```typescript
if (err instanceof ToolExecutionError) {
  log.warn({ toolId: err.toolId }, err.message);
  return "I couldn't fetch that just now. Want to try again?";
}
```

**Optional retry.** Wrap the `respond` call in a small retry loop for transient errors.

```typescript
for (let attempt = 0; attempt < 2; attempt++) {
  try {
    return (await agent.respond({ history, session })).message;
  } catch (err) {
    if (err instanceof ToolExecutionError && attempt === 0) {
      await new Promise((r) => setTimeout(r, 250));
      continue;
    }
    throw err;
  }
}
```

**Recovery flow.** Hard failures — a payment tool that hit a permanent denial — should redirect into a recovery flow rather than echo the error. Dispatch a directive against the session so the *next* turn enters the recovery flow.

```typescript
if (err instanceof ToolExecutionError && err.toolId === "charge_card") {
  await agent.dispatch(session, { goTo: "PaymentRecovery" });
  return "I hit a snag with that payment. Let me walk you through it.";
}
```

The dispatched [`Directive`](../reference/directive.md) lands in `session.pendingDirective` and is consumed at the start of the next turn.

## Pattern 4: ResponseGenerationError → backoff or fallback provider

Provider errors are usually transient. Retry with backoff first; fall back to a second provider only if the primary keeps failing.

```typescript
async function respondWithFallback(history: HistoryItem[], session: Session) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await primaryAgent.respond({ history, session });
    } catch (err) {
      if (err instanceof Error && err.name === "ResponseGenerationError") {
        await new Promise((r) => setTimeout(r, 200 * 2 ** attempt));
        continue;
      }
      throw err;
    }
  }
  return fallbackAgent.respond({ history, session });
}
```

Both agents share the same `flows`, `tools`, and `schema` — only the `provider` differs. The session is provider-agnostic, so the fallback picks up exactly where the primary left off.

## Pattern 5: FlowConfigurationError → don't catch in production

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
