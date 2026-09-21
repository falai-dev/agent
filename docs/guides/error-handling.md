---
title: "Error handling"
description: "The four error classes, who throws each one and when, and what the host does about it."
type: guide
order: 7
---

# Error handling

The package exports four error classes. Catch them by class.

```ts
import { falai, GeminiProvider, ProviderError } from "@falai/agent";

const f = falai().fields({});
const agent = f.agent({
  name: "Ana",
  provider: new GeminiProvider({ apiKey: process.env.GEMINI_API_KEY ?? "", model: "gemini-2.5-flash" }),
  idle: { prompt: "Responda pela empresa." },
});

try {
  await agent.turn({ sessionId: "demo", message: "oi" });
} catch (error) {
  if (error instanceof ProviderError) console.log(error.kind); // "auth" when the key is wrong
  else throw error;
}
```

Every message follows one format: `[ErrorClass] what: why. how to fix.` The class name comes first so a log line is greppable, and the last sentence says what to do.

| Class | Thrown by | When | What to do |
|---|---|---|---|
| `FlowConfigurationError` | `f.agent()`, `validateFlow`, `toSpec`, `parseDuration` | a flow cannot run as written | fix the flow; never catch it in production |
| `ProviderError` | the provider, inside the understand call | the model could not be reached | nothing ran and nothing was saved: retry the same input |
| `SessionConflictError` | `store.save()` | another turn saved the session first | reload and replay the same input |
| `InvalidSessionError` | `store.load()`, `assertSession`, `migrateSession` | a stored row is not a session | repair or delete the row; it is never treated as a new conversation |

`ProviderError` and its `ErrorKind` come from `@providerkit/core` and are re-exported here, so you never import that package yourself.

## FlowConfigurationError

Raised when a name in a flow does not resolve or a jump has no way out. `f.agent()` runs `validateFlow` on every flow it is built with, so a broken flow fails at construction, not on the turn that first reaches it.

What it catches, with the message each case gives:

- a flow id declared twice: `flow "x" is declared twice: flow ids must be unique`
- an unknown field in `collect`, `ask`, `clearOnStart`, `clear` or `equals`: `unknown field "x" in collect`
- an unknown action, event, condition or tool: `unknown action "enviar_email"`
- a `with` that misses a required parameter or gives the wrong type: `action "notify" needs parameter "message"`
- a `then`, `else`, `onFail` or branch pointing at a step that does not exist, or a step id `"end"`, or a duplicate step id
- an `if` step that jumps backward with no `else`
- a duration that does not parse, in a trigger or a `wait`: `silence has duration "tomorrow", which does not parse`
- `toSpec` on a flow that carries a function predicate, which cannot be stored as JSON

`validateFlow` also returns warnings for what runs but probably not as intended; the agent logs them with `logger.warn` at construction. See [flows from JSON](./flows-from-json.md) for the list.

Do not catch this class in a request handler. It means the code or the stored flow is wrong, and the fix is an edit, not a retry.

## ProviderError: two paths through a turn

A turn makes at most one understand call and one speak call. A tool round inside the speak call is one more, up to `maxToolLoops`; a compaction summary is one more again. The framework treats a provider failure differently in the two phases.

### In the understand call: the turn throws

The understand call judges the customer's message: which flow it fits, what it mentions, which fields it gives. If the provider fails here, `agent.turn()` throws the `ProviderError`. Nothing has run yet: no action was called, no message was produced, and the host has not saved anything. Retry the same input later; the same message id mints the same keys, so the retry is a replay, not a duplicate.

### In the speak call: the turn returns, and the step waits or ends

The speak call phrases the reply. If the provider fails here, or answers with an empty message, the turn does not throw. What happens next depends on whether waiting could help.

| The failure | Code | What the run does |
|---|---|---|
| The provider was down, slow, overloaded or rate-limited; the reply was empty | `provider-unavailable` | Waits, then tries again |
| A usage window that says when it reopens | `provider-quota` | Waits until then |
| A spent balance with no stated reset | `provider-quota` | Ends `failed` |
| The key was rejected or has no access to the model | `provider-auth` | Ends `failed` |
| The prompt is past the model's context window | `provider-context` | Ends `failed` |
| The provider refused the request, or the model does not exist | `provider-invalid` | Ends `failed` |

A failure that waits returns with an outcome `{ kind: "prompt" | "collect", status: "deferred", code, until }`, a `schedule[]` entry keyed `${runId}:${stepId}:${visit}:retry:${atMs}`, and `llmCalls` counting the call that failed. The backoff is 1 minute, then 5, 15, an hour, six hours (`RETRY_BACKOFF` in `src/core/Runner.ts`); the attempt number is the count of trailing `deferred` outcomes for that step on that run. A provider that stated a reset later than the next rung is woken at the reset instead. When the wake fires, the step runs again at the same visit, so its message carries the same key it would have carried the first time.

**The ladder ends.** After the sixth failure on the same step there is no seventh wake: the outcome is `status: "failed"` and the run ends. The same happens at once for a failure no wait can fix — retrying a rejected key or an oversized prompt only spends two model calls to reach the same wall. Both land in `ended` with `reason: "failed"`, so your execution log shows a conversation that stopped and why.

Actions that ran earlier in the same turn are not undone; they ran at-least-once and are idempotent on `ctx.key`. `say` steps that went out before the failure are in `messages[]` as usual.

The idle speaker has no step to re-park. Its failure leaves one outcome, `{ kind: "idle", status: "deferred", code }`, and no wake: the customer's next message asks it again.

### What is in the error

```ts fragment
class ProviderError extends Error {
  provider: string;        // which provider failed
  kind: ErrorKind;         // what fixes it; see below
  body?: string;           // the provider's own response text, truncated — the real reason
  status?: number;         // HTTP status when there was one
  retryAfterMs?: number;   // honoured when the provider said how long to wait
  isTransient: boolean;    // rate, overload, network, timeout
}
```

Log `body` first. A bare `400 status code (no body)` says nothing, and the provider's own text usually names what it rejected. `code`, `resetAtMs` and `shouldRetry` ride along too, whenever the provider sends them.

`ErrorKind` is named by what fixes the failure: `"aborted"`, `"timeout"`, `"network"`, `"overload"`, `"rate"`, `"quota"`, `"entitlement"`, `"auth"`, `"model"`, `"context"`, `"content"`, `"invalid"`, `"unknown"`. Waiting helps with `timeout`, `network`, `overload` and `rate`. It does not help with `quota` (the balance is gone), `auth` (the key is wrong), `model` (the id does not exist), `context` (the prompt is too long: send less history, see [compaction](./compaction.md)) or `invalid`.

The built-in providers retry transient failures before throwing: 3 retries and a 60-second silence timeout by default (`RetryConfig`). A `ProviderError` that reaches your code has already been retried. To keep serving through an outage, wrap several providers in a `FallbackAiProvider`; see [providers](../reference/providers.md).

## SessionConflictError

Every store's `save(session, expectedVersion)` compares before it writes. A first save passes `0` and inserts; a later save passes the version it loaded and updates only a row still at that version. When the row moved on, the store throws:

```ts fragment
class SessionConflictError extends Error {
  sessionId: string;
  expectedVersion: number;          // what you loaded
  actualVersion: number | undefined; // what is stored now; undefined when the row is gone
}
```

This is the normal outcome of a race, not a bug: a wake and a customer message landing on one session at the same moment, or two webhooks for one conversation. Nothing was sent, because the host sends only after a successful save. Load again and run the same input on the new version. The replay usually ends differently, and correctly: in the race above, the customer's reply now finds the nudge run waiting and takes the wait's `else` instead of nudging again. See [persistence](./persistence.md) for the loop.

## InvalidSessionError

Every store runs `assertSession` on load, and `migrateSession` runs it on any blob that already carries `v: 4`. A row that is not a v4 session for that id, or a 3.x blob that cannot be read, throws:

```ts fragment
class InvalidSessionError extends Error {
  sessionId: string;
  // message: [InvalidSessionError] stored session "s1" is unreadable: data is "nope", expected an object. Repair or delete the row; it is never replaced by a fresh conversation.
}
```

The design choice behind it: a corrupt row must fail loudly. If the framework started a fresh session instead, it would ask every field again and fire every once-flow again, and nobody would notice until a customer did. Alert on it, then repair or delete the row by hand.

## What never throws

Most things that go wrong inside a turn become outcome lines, not exceptions:

| Situation | What you see |
|---|---|
| a tool handler throws, or its input fails validation or permission | the model reads `{ "error": "…" }` and answers anyway |
| an action throws | `{ status: "failed", code: "action-failed", detail: "<message>" }`; the run takes `onFail`, or `then` when there is none |
| a wake fires for a session that does not exist | one outcome `code: 'no-session'`, `changed: false` |
| a wake nobody waits for any more | `code: 'stale-wake'`, `changed: false` |
| a message id already seen | `code: 'duplicate-input'`, `changed: false` |
| a `start` or a chain names a flow the agent no longer has | one `skipped[]` entry, `code: 'flow-gone'` |
| compaction's summary call fails | the oldest messages are dropped instead; the turn goes on |

The full detail vocabulary is in [outcomes](../reference/outcomes.md).

Two errors outside the four classes: a `compaction` option out of range throws a plain `Error` at construction (`compactionThreshold must be between 0.5 and 0.95, got 2`), and `PrismaStore` throws a `TypeError` when the client has no model by the given name.

## Catching by class

The host loop, with each class handled where it belongs:

```ts
import {
  falai,
  GeminiProvider,
  InvalidSessionError,
  MemoryStore,
  ProviderError,
  SessionConflictError,
  type DataOf,
  type Session,
  type TurnResult,
} from "@falai/agent";

const f = falai().fields({
  nome: { type: "string", ask: "Pergunte o nome." },
});
type Data = DataOf<typeof f>;

const agent = f.agent({
  name: "Ana",
  provider: new GeminiProvider({ apiKey: process.env.GEMINI_API_KEY ?? "", model: "gemini-2.5-flash" }),
  flows: [f.flow({ id: "boas-vindas", name: "Boas-vindas", on: [{ message: [] }], steps: [{ id: "nome", collect: ["nome"] }] })],
});
const store = new MemoryStore<Data>();

declare function requeue(input: { sessionId: string; text: string; id: string }, afterMs: number): Promise<void>; // your queue

async function onMessage(sessionId: string, text: string, id: string): Promise<TurnResult<Data> | undefined> {
  for (let attempt = 0; attempt < 3; attempt++) {
    let session: Session<Data> | null;
    try {
      session = await store.load(sessionId);
    } catch (error) {
      if (error instanceof InvalidSessionError) {
        console.error(error.message); // alert a human; do not start a new conversation
        return undefined;
      }
      throw error;
    }

    let r: TurnResult<Data>;
    try {
      r = await agent.turn({ sessionId, session: session ?? undefined, message: text, id });
    } catch (error) {
      if (error instanceof ProviderError) {
        // The understand call failed. Nothing ran, nothing was saved.
        // Put the same input back on your queue; the replay mints the same keys.
        await requeue({ sessionId, text, id }, error.retryAfterMs ?? 60_000);
        return undefined;
      }
      throw error;
    }
    if (!r.changed) return r;

    try {
      await store.save(r.session, session?.version ?? 0);
    } catch (error) {
      if (error instanceof SessionConflictError) continue; // someone saved first: replay on the new version
      throw error;
    }
    // Only now: send r.messages and enqueue r.schedule.
    return r;
  }
  throw new Error(`three conflicts in a row on session "${sessionId}": check for a stuck queue worker`);
}

const r = await onMessage("demo", "oi, sou a Bia", "m1");
console.log(r?.messages.map((m) => m.text));
```

Three attempts is enough: a fourth conflict means two workers are firing on the same session, which is a queue problem, not a race.

A speak-call failure needs no branch here: it arrives as a `deferred` outcome and a `schedule[]` entry, and the loop already enqueues those. The only thing to add is a log line when `r.outcomes` contains a `deferred` status, so an outage shows up in your dashboards before the retry wake hides it.

See [the errors reference](../reference/errors.md) for the exported shapes.
