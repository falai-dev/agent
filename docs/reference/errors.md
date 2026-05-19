---
title: "Errors"
description: "Typed error classes the framework throws, and the message format contract every thrown error follows."
type: reference
order: 12
---

# Errors

> **Where this is introduced:** [Errors](../guides/error-handling.md)

`@falai/agent` throws typed `Error` subclasses for every failure mode the framework owns. Catch them by class to discriminate construction errors from runtime errors, and by `error.name` when classes that are not exported (e.g. `DataValidationError`, `ResponseGenerationError`) need to be matched.

Every thrown message follows the same format contract:

```text
[<ErrorClass>] <what>: <why>. <how to fix>.
```

The bracketed prefix matches the class name. The "what / why / how to fix" triplet is mandatory — the framework never throws a bare message.

## Signature

```typescript
// Exported from "@falai/agent"
class FlowConfigurationError extends Error { /* name = "FlowConfigurationError" */ }
class ToolCreationError       extends Error { toolId: string; cause?: Error }
class ToolExecutionError      extends Error {
  toolId: string;
  executionContext?: Record<string, unknown>;
  cause?: Error;
}
class NotImplementedError     extends Error { /* name = "NotImplementedError" */ }

// Internal — match by `error.name` (not exported from the package barrel)
class DataValidationError     extends Error { errors: ValidationError[] }
class ResponseGenerationError extends Error {
  details?: {
    originalError?: unknown;
    params?: Record<string, unknown>;
    phase?: string;
    context?: Record<string, unknown>;
  };
}
```

## Fields

| Class | Thrown when | Notable fields | Recover by |
|-------|-------------|----------------|------------|
| `FlowConfigurationError` | Construction- or run-time misconfiguration: duplicate ids, unknown `collect` keys, malformed `Directive`, auto-step cycles, branch targets that do not resolve, function on `when`. | `message` | Fix the offending agent/flow/step/branch/directive at the source. Not a runtime-recoverable error. |
| `ToolCreationError` | A `Tool` fails registration (invalid schema, duplicate id, builder threw). | `toolId`, `cause` | Repair the tool definition. Not user-facing. |
| `ToolExecutionError` | A handler throws, all retries fail, or `validateInput` cannot correct invalid args. | `toolId`, `executionContext`, `cause` | Surface a user-friendly message; optionally `agent.dispatch({ goTo: '<recovery-flow>' })`. |
| `DataValidationError` | `agent.respond(...)` collects values that violate the declared `schema`. | `errors: ValidationError[]` | Re-prompt for the offending fields, then retry. |
| `ResponseGenerationError` | The provider call fails or the response cannot be parsed. | `details.phase`, `details.originalError` | Retry with backoff, fall back to a different provider, or surface a soft failure to the user. |
| `NotImplementedError` | A reserved option is set to a value this version does not support (e.g. `routerMode: 'embedding'` in v2.0). | `message` | Use a supported value. |

## Examples

### 1. Narrowing by class and `name`

```typescript
import {
  FlowConfigurationError,
  ToolExecutionError,
  NotImplementedError,
} from "@falai/agent";

try {
  const response = await agent.respond(message);
  return response.message;
} catch (err) {
  if (err instanceof FlowConfigurationError) throw err;          // bug — bubble up
  if (err instanceof NotImplementedError) throw err;             // config bug
  if (err instanceof ToolExecutionError) {
    log.warn({ toolId: err.toolId, cause: err.cause }, err.message);
    return "Sorry, that action failed. Try again in a moment.";
  }
  // Not exported — match by name.
  if (err instanceof Error && err.name === "DataValidationError") {
    return "I need you to clarify a few details — let's try that again.";
  }
  if (err instanceof Error && err.name === "ResponseGenerationError") {
    return "I'm having trouble reaching the model. Please retry.";
  }
  throw err;
}
```

### 2. The format contract in practice

Every thrown message is parseable. The leading `[<ErrorClass>]` token mirrors the class name, the colon separates `<what>` from `<why>`, and the trailing sentence is `<how to fix>`.

```text
[FlowConfigurationError] Invalid directive: multiple position fields set (goTo, complete). A directive may have at most one position field. Remove the extras.

[ToolExecutionError] Tool "book_hotel" execution failed: all 3 attempts exhausted. Check the tool handler for errors or increase maxRetries. Last error: ECONNRESET.

[DataValidationError] Data validation failed: fields [checkIn must be a date] did not pass schema validation. Fix the offending values to match the declared schema.

[NotImplementedError] routerMode "embedding" is not implemented: only "ai" is supported in v2.0. Set routerMode to "ai" or omit the option.
```

## Errors

The format contract itself has zero runtime enforcement — it is a contract on framework code, not on user code. If you write a custom `Tool` or hook that throws, follow the same shape so downstream `try/catch` blocks parse uniformly:

```typescript
throw new ToolExecutionError(
  `[ToolExecutionError] Tool "${tool.id}" booking failed: provider returned 503. Retry the call or fall back to manual booking.`,
  tool.id,
);
```

Tool input validation, permission denials, and missing-tool warnings are reported as `ToolResult { success: false, error }` rather than thrown — this keeps the AI's reasoning loop intact while preserving the same `[<ErrorClass>] <what>: <why>. <how to fix>.` shape in the `error` string.

## Related

- [Errors](../guides/error-handling.md) — recipe-shaped guide that introduces this surface.
- [createAgent](./create-agent.md) — construction-time errors thrown from `new Agent(...)`.
- [Tool](./tool.md) — handler return shape and the `ToolExecutionError` triggers.
- [Directive](./directive.md) — the validation rules that surface as `FlowConfigurationError`.
