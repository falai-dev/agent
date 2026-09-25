---
title: "Errors"
description: "The four error classes the package exports, when each one is thrown, and the message format they follow."
type: reference
order: 14
---

# Errors

The package exports four error classes and one type. Catch them by class with `instanceof`; each also sets `name` to its class name. Three are the package's own. `ProviderError` and `ErrorKind` are re-exported from `@providerkit/core`, the library every built-in provider is built on, so a `ProviderError` thrown deep inside a provider is the same class you import from `@falai/agent`.

## Signature

```ts fragment
class FlowConfigurationError extends Error {
  constructor(message: string);
}

class SessionConflictError extends Error {
  readonly sessionId: string;
  readonly expectedVersion: number;
  /** The version the store found; undefined when the row is gone. */
  readonly actualVersion: number | undefined;
}

class InvalidSessionError extends Error {
  readonly sessionId: string;
}

class ProviderError extends Error {
  readonly provider: string;
  readonly kind: ErrorKind;
  readonly status?: number;
  readonly code?: string;
  /** How long the provider asked you to wait (Retry-After, Gemini's RetryInfo). */
  readonly retryAfterMs?: number;
  /** Absolute reset of the binding limit; can be days beyond retryAfterMs. */
  readonly resetAtMs?: number;
  /** Which subscription window bound: "5h", "weekly" or "monthly", when the provider named one. */
  readonly window?: "5h" | "weekly" | "monthly";
  readonly shouldRetry?: boolean;
  /** The provider's own response body, truncated. */
  readonly body?: string;
  get isTransient(): boolean;
  get isBackupEligible(): boolean;
  /** Wrap anything thrown into a classified ProviderError; an existing one passes through. */
  static from(provider: string, err: unknown): ProviderError;
}

type ErrorKind =
  | "aborted" | "timeout" | "network" | "overload" | "rate" | "quota"
  | "entitlement" | "auth" | "model" | "context" | "content" | "invalid" | "unknown";
```

From `src/types/errors.ts`, `src/core/Migrate.ts` and `@providerkit/core`.

## The four classes

| Class | Thrown by | When | What to do |
|-------|-----------|------|------------|
| `FlowConfigurationError` | `f.agent()` / `new Agent()`, `validateFlow`, `fromSpec` | A flow cannot run as written: a flow id or step id declared twice; a step with no id, or with the reserved id `"end"`; an unknown field in `collect` / `ask` / `clearOnStart`; an unknown action, event, condition or tool; a `then` pointing at a step that does not exist; an action `with` missing a required parameter; a duration that does not parse; a talk step with neither `prompt` nor `collect`. Also thrown at run time when a JSON predicate names a condition the agent does not have. | Fix the flow. It is a bug in the flow or the registries, never something to retry. |
| `SessionConflictError` | every `Store.save` | The stored version is not `expectedVersion`: another turn saved first, a `save(…, 0)` found a row, or the row was deleted or expired after it was loaded (`actualVersion` is `undefined`). | Load the session again and replay the same input. Nothing was sent, so nothing is duplicated. |
| `InvalidSessionError` | every `Store.load`, `assertSession`, `migrateSession` | A stored row is not a v4 session and not a recognisable 3.x one: wrong `v`, an `id` that does not match the row, a missing `data`, a run with a bad `status`, text that is not JSON. | Repair or delete the row. The framework never replaces a bad row with a fresh conversation, because that would re-ask every field and re-fire every once-flow. |
| `ProviderError` | the built-in providers, `FallbackAiProvider` | A model call failed after the provider's own retries, backup models and fallbacks. `kind` says what would fix it. | Match on `kind` (table below). |

## The message format

The three package classes follow one shape:

```text
[ErrorClass] what: why. how to fix.
```

The bracket names the class, the text before the colon says what is wrong and where, and the last sentence says what to change. Examples, copied from what the code emits:

```text
[FlowConfigurationError] flow "triagem", step "grana": unknown field "orcamento" in collect. Add it to the agent's fields or fix the slug.
[FlowConfigurationError] flow "triagem", step "quem": then points at step "fim", which does not exist. Use an existing step id or "end".
[FlowConfigurationError] flow "triagem", step "avisa": unknown action "notify". Register it in actions or fix the name.
[FlowConfigurationError] flow "triagem": has no steps list. Write steps as a list, even an empty one.
[FlowConfigurationError] flow "a" is declared twice: flow ids must be unique. Rename one of them.
[FlowConfigurationError] idle: unknown tool "buscar_preco". Register it in the agent's tools or fix the name.
[SessionConflictError] Session "s1" was modified concurrently: expected version 3, found 4. Reload the session and retry the operation.
[SessionConflictError] Session "s1" is gone from the store: it was at version 3 and has since been deleted or expired. Load it again; a load that finds nothing starts a new conversation.
[InvalidSessionError] stored session "s1" is unreadable: v is 3, expected 4. Repair or delete the row; it is never replaced by a fresh conversation.
[InvalidSessionError] stored session "s1" is unreadable: expected an object, got "garbage". Repair or delete the row; it is never replaced by a fresh conversation.
[InvalidSessionError] stored session "s1" is unreadable: data is missing, expected an object; not a 3.x session either. Repair or delete the row; it is never replaced by a fresh conversation.
```

`ProviderError` does not follow this shape. A wire failure's message is the provider, the status and the vendor's own body, truncated (`openai 429: {"error":{"message":"Rate limit reached…"}}`); an error wrapped from something already thrown keeps that error's own text. Read `kind`, not the message.

## ProviderError kinds

Named by what fixes them, from `@providerkit/core`.

| `kind` | Meaning | Retry? |
|--------|---------|--------|
| `aborted` | Your own `AbortSignal` fired. | Never. |
| `timeout` | The stream stayed silent past `retryConfig.timeout` (default 60 s), or the provider sent 408. | Yes. |
| `network` | The request never reached the provider: socket, DNS, proxy. | Yes. |
| `overload` | Theirs and temporary: a 5xx, Anthropic's 529, "overloaded". | Yes, and worth a different model. |
| `rate` | 429 per-minute throttle. | Wait `retryAfterMs`, or rotate key or model. |
| `quota` | Balance or usage window exhausted. | Waiting minutes will not fix it. |
| `entitlement` | The plan never included this API. | No; neither a new key nor a top-up fixes it. |
| `auth` | 401 or 403: the key is wrong. | No. |
| `model` | The model id does not exist or is not served here. | No; the built-in providers do try the next `backupModels` entry. |
| `context` | The prompt outgrew the context window. | No; send less. Compaction is the framework's answer. |
| `content` | Safety filter or refusal. | No. |
| `invalid` | Any other 4xx: a bug in what was sent. | No. |
| `unknown` | Nothing above matched. | No. |

`isTransient` is true for `timeout`, `network`, `overload` and `rate`. `isBackupEligible` is what the provider uses to decide whether to try the next backup model.

## Where a provider failure lands in a turn

The same `ProviderError` means two different things depending on which of the two calls failed. Both are in `src/core/Understand.ts`, `src/core/Speak.ts` and `src/core/Runner.ts`.

- **Understand call fails**: `turn()` throws. Nothing ran, nothing changed, there is nothing to save. The host catches, waits (`retryAfterMs` when present) and calls `turn()` again with the same input.
- **Speak call fails**: `turn()` does not throw. What happens next depends on what failed — see [Error handling](../guides/error-handling.md#in-the-speak-call-the-turn-returns-and-the-step-is-re-parked). A kind a wait can fix re-parks the talk step under `${runId}:${stepId}:${visit}:retry:${atMs}` with `status: 'deferred'`; a kind it cannot ends the run with `status: 'failed'` and no wake. Either way the session is saved as usual with `changed: true`, the `do` steps that ran before the call are not repeated, and a retry wake re-runs the same visit, so keys and idempotency hold. The idle speaker has no step to re-park: its failure leaves one `kind: 'idle'`, `status: 'deferred'` line and no wake.
- **Tool handler throws** during a speak call: not an error for you. The model sees `{ error }` as the tool result and the turn continues.
- **Action (`do`) handler throws**: not an error for you either. The result becomes `{ failed: error.message }`, the outcome is `code: 'action-failed'` with the message in `detail`, and the run follows `onFail` or `then`.

## Errors outside the contract

A few throws are plain `Error` or `TypeError`. One happens at run time: a reply that parses to a blank message with no tool calls throws `Error: No response from <provider>` out of `generateMessage`, after the provider's retries and backup models have run. A speak call swallows it and defers the step; an understand call hands it to you, so catch `Error`, not only `ProviderError`. The rest are wiring bugs at construction:

- A provider built without a key or model: `[GeminiProvider] apiKey is empty: the provider cannot authenticate. Pass { apiKey: process.env.GEMINI_API_KEY } and check the variable is set.`, `[OpenAIProvider] model is empty: there is no default. Pass one, e.g. { model: "gpt-5.6" }.`
- `createOpenAICompatibleProvider` without `name`, `baseURL`, `apiKey` or `model`.
- `FallbackAiProvider` with an empty `providers` list.
- `PrismaStore` whose client has no delegate for the model: `[TypeError] PrismaStore cannot use model "agentSession": …`.
- `compaction` options out of range (`maxTokens` at or below 0, `compactionThreshold` outside 0.5–0.95, `preserveRecentCount` below 2, `maxToolResultChars` at or below 0): `[CompactionEngine] compactionThreshold is 1.2: it must be between 0.5 and 0.95. Use 0.8 unless you measured otherwise.`

Each follows the same `[Class] what: why. how to fix.` shape as the package classes; only the class is plain `Error`.

## Example

A host loop that catches each class where it can happen. The framework never sends or saves, so every catch site knows nothing has left the process yet.

```ts
import {
  falai,
  FlowConfigurationError,
  InvalidSessionError,
  MemoryStore,
  ProviderError,
  SessionConflictError,
} from "@falai/agent";
import type { AiProvider, DataOf, Session, TurnResult } from "@falai/agent";

declare const provider: AiProvider;
declare function send(text: string, key: string, afterMs: number): Promise<void>;
declare function enqueue(jobId: string, at: Date, payload: { sessionId: string; key: string }): Promise<void>;
declare function sleep(ms: number): Promise<void>;

const f = falai().fields({
  nome: { type: "string", ask: "Pergunte o nome de um jeito leve." },
});
type Data = DataOf<typeof f>;

// A flow that cannot run throws here, before the first turn.
function build() {
  try {
    return f.agent({
      name: "Ana",
      provider,
      flows: [
        f.flow({
          id: "boas-vindas",
          name: "Boas-vindas",
          on: [{ message: [] }],
          steps: [{ id: "quem", collect: ["nome"] }],
        }),
      ],
    });
  } catch (error) {
    if (error instanceof FlowConfigurationError) console.error(error.message);
    throw error;
  }
}

const agent = build();
const store = new MemoryStore<Data>();

async function handle(sessionId: string, text: string, id: string): Promise<TurnResult<Data>> {
  let session: Session<Data> | undefined;
  try {
    session = (await store.load(sessionId)) ?? undefined;
  } catch (error) {
    // A corrupt row. Alert someone; do not start over with a fresh session.
    if (error instanceof InvalidSessionError) console.error(error.sessionId, error.message);
    throw error;
  }

  let result: TurnResult<Data>;
  try {
    result = await agent.turn({ sessionId, session, message: text, id });
  } catch (error) {
    // The understand call failed: nothing ran. Wait and play the same input again.
    // An empty reply throws a plain Error, not a ProviderError, so match both.
    const emptyReply = error instanceof Error && error.message.startsWith("No response from");
    if (emptyReply || (error instanceof ProviderError && error.isTransient)) {
      await sleep(error instanceof ProviderError ? (error.retryAfterMs ?? 5_000) : 5_000);
      return handle(sessionId, text, id);
    }
    throw error;
  }
  if (!result.changed) return result;

  try {
    await store.save(result.session, session?.version ?? 0);
  } catch (error) {
    // Another turn saved first. Nothing was sent: load the new version and replay.
    if (error instanceof SessionConflictError) return handle(sessionId, text, id);
    throw error;
  }

  for (const m of result.messages) await send(m.text, m.key, m.afterMs);
  // The key rides in the payload for turn({ wake: key }); BullMQ refuses a ":" in a custom id, so the job id is encoded.
  for (const s of result.schedule) await enqueue(encodeURIComponent(s.key), s.at, { sessionId, key: s.key });
  return result;
}

const r = await handle("s1", "oi, sou a Bia", "m1");
console.log(r.llmCalls, r.session.data);
```

## See also

- [Error handling](../guides/error-handling.md): the same four classes as a walkthrough, with the replay and the retry wake.
- [Session](./session.md): the version rule that produces `SessionConflictError`.
- [Providers](./providers.md): retries, backup models and fallbacks before a `ProviderError` reaches you.
- [Flow spec](./flow-spec.md): `validateFlow` and what it checks.
