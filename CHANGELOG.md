# Changelog

All notable changes to `@falai/agent` will be documented in this file.

## [2.6.0]

### Changed (BREAKING)

- **Streaming now emits clean message text, not the raw structured-JSON wrapper.** Under a JSON schema (every flow turn), providers stream the wrapper `{"message":"…"}` token by token; `respondStream()`/`stream()` previously forwarded those raw fragments as `delta`/`accumulated`, so every consumer had to re-implement partial-JSON unwrapping — and `stream()` even persisted the raw JSON as the assistant message, while `generate()`/`chat()` stored the clean text. The framework now extracts the top-level `message` field incrementally (a new internal `StreamingMessageDecoder` that tracks object depth and string/escape context, so a nested or decoy `"message"` is never mistaken for it and a half-decoded escape is never emitted): `delta` carries the message's token-delta, `accumulated` is the clean message-so-far, and the parsed object is still surfaced on the final chunk via `structured`. Plain-text (non-JSON) streams pass through unchanged. **Migration:** remove any app-side unwrapping (`unwrapLlmContent`/`parseMessageContent`-style) of streamed `delta`/`accumulated` — they now receive clean text and would double-process; read collected fields from the done chunk's `structured` as before.

### Fixed

- **Streaming data collection now matches the non-streaming path.** Two divergences are fixed: (1) collection was gated on the step declaring `collect`, so a flow's `requiredFields`/`optionalFields` were never harvested on the streaming path — it now collects for any flow step, like `generate()`; (2) a tool-driven streamed turn collected from the model's *first-pass* output instead of its *post-tool follow-up*, dropping fields the model produced only after seeing tool results — it now prefers the follow-up structured, matching `generate()`.
- **The post-signal phase now runs on non-streaming auto-chain completion.** When an auto-step chain completed a flow (`last_step`/`completed`/`goto`), the non-streaming path returned early and skipped the post-signal phase — so `post`/`both` signals never fired and a post-phase `pendingDirective` was never wired (the streaming path already ran it). Both paths now run it. Auto-chain *halt* (a deliberate verbatim short-circuit) still skips the post-phase in both paths, but the non-streaming path now surfaces any pre-phase `triggeredSignals` too.

### Internal

- **The streaming and non-streaming response paths now share one decision spine.** `generateUnifiedResponse` and `generateUnifiedStreamingResponse` were parallel implementations ("unified" in name only) whose drift caused the 2.4.x retry/empty bugs and the divergences above. Signal-halt detection, the auto-chain walk, flow/step selection, and the post-signal phase are now a single `planTurn` + `applyTurnPostPhase`, used by both; each path only *renders* the shared `TurnOutcome` in its own idiom (await a value vs. yield chunks) and keeps its own leaf primitive (sequential `generateMessage` + `runLoop` vs. concurrent stream + `runStreamingBatch`). The two genuinely-different behaviors a full "drain the stream" collapse would have regressed — non-streaming's sequential tool execution and OpenAI's native `responses.parse` structured output — are deliberately kept distinct.

## [2.5.0]

### Added

- **Streaming now has a first-chunk (time-to-first-token) timeout.** `respondStream()`/`stream()` previously had no bound on how long a provider could take to produce its first token — a provider that opened a stream and then stalled would hang the turn indefinitely, with no equivalent of the non-streaming per-attempt timeout. The shared streaming retry helper (`withStreamRetry`) now races the first chunk against a deadline (`firstChunkTimeoutMs`, wired to each provider's existing `retryConfig.timeout`, default 60s): a stall is treated as a failed attempt and retried on the same model, then falls through to backup models — exactly like an empty completion. Only the *first* chunk is bounded, so a long but healthy stream is never cut off, and the deadline reuses the existing config (no new public option). If every attempt is exhausted it surfaces as a `"Stream timed out"` error (classified as `timeout`).
- **An abandoned attempt now actually cancels its upstream provider call, instead of leaving it running while a retry stacks a second.** Abandoning an attempt — a first-chunk timeout, a pre-yield error before a retry, or a consumer that breaks mid-stream — only dropped the JS generator; the underlying SDK request kept running, because the abort never reached it (a generator stalled inside `await sdkStream.next()` won't even honor `return()` until that call settles). Against a flaky provider, retries could stack concurrent calls. Both retry helpers now thread an `AbortSignal` into the work they run — `withStreamRetry` aborts a fresh per-attempt signal on abandon; `withTimeoutAndRetry` hands the operation its existing timeout signal — and every provider combines that signal with the caller's `input.signal` (via a new `combineAbortSignals` helper) and passes it to the SDK on **both** the streaming and non-streaming paths. Anthropic and the OpenAI-compatible providers previously passed no signal to their SDK at all (so even caller-initiated cancellation never reached the wire); Gemini passed only the caller's. `combineAbortSignals` prefers the platform `AbortSignal.any` (which cleans up its listeners via weak refs) and falls back to a manual controller on runtimes without it (< Node 20.3), so the library keeps working on older runtimes.
- **`createOpenAICompatibleProvider({ name, baseURL, apiKey, model, … })`** — build a provider for any OpenAI-compatible endpoint (Azure OpenAI, Groq, Together, Fireworks, vLLM, LM Studio, Ollama, a self-hosted gateway…) from config alone, no subclass. Structured output defaults to chat-completions `json_schema` (the broadest-compatible enforced mode), selectable via `structuredOutput: "json_schema" | "json_object" | "responses_parse"`; `defaultHeaders` covers per-endpoint auth (e.g. Azure's `api-key`), and `capabilities` overrides merge over sensible defaults. It shares the same `OpenAICompatibleProvider` base as the dedicated `OpenAIProvider`/`OpenRouterProvider`/`DeepSeekProvider` classes — this is the no-subclass path for everything else.
- **Streaming tool turns now loop across multiple rounds, matching the non-streaming path.** Previously `respondStream()`/`stream()` ran one concurrent batch of tool calls and then forced a closing message — a streamed turn could not *chain* tools (call a tool, see its result, decide to call another). The streaming and non-streaming tool engines now share one multi-round follow-up loop (`runFollowUpLoop`): the streaming path keeps its concurrent initial batch and tool-progress chunks, then re-prompts with the results so the model can request further tools, up to `maxToolLoops` (default 5) — exactly like the non-streaming `runLoop`. Single-round turns are unaffected.

### Internal

- **Structured-output strategy lifted into the OpenAI-compatible base as config.** The choice between `responses.parse` and chat-completions `json_schema`/`json_object` is now a single `structuredOutput` field on `OpenAICompatibleProvider` instead of per-subclass `executeStructuredGenerate`/`structuredResponseFormat` overrides. `DeepSeekProvider` and the new generic provider set the field and drop the overrides, so "how this endpoint does structured output" has one definition; `OpenAIProvider`/`OpenRouterProvider` keep the default `responses.parse`.

- **Provider retry/response plumbing consolidated** (no public API change). The `||`/`??` retry-config defaulting (the `retries: 0` honoring fix from 2.4.3) now lives in a single shared `resolveRetryConfig`, removing the byte-identical block and three local `DEFAULT_RETRY_CONFIG` copies from the providers; the capped-exponential backoff is a single `defaultBackoff`; the empty-completion "blank message" check is one shared `effectiveMessageText` used by both the streaming and non-streaming guards; and `forceFinalTextFromTools` reuses the existing `assistantMessage`/`toolMessage` history factories. Net ~60 fewer lines across the three providers. One behavior refinement falls out of unifying the guard: a whitespace-only completion with no tool calls is now treated as empty (throw + retry) on the non-streaming path too, matching the streaming path (previously such a response was passed through).

### Fixed

- **Gemini reasoning ("thought") parts can no longer leak into the message.** `safeExtractText` concatenated every part with `text != null`, but with `includeThoughts` enabled a reasoning part also carries `text` (alongside `thought: true`) — so the model's chain-of-thought would be prepended to the user-facing message. It now excludes parts flagged `thought`, keeping only the answer text.
- **Removed an unreachable branch in single-flow step selection.** `FlowRouter.decideSingleFlowStep` had a second `if (candidates.length === 0)` guard after the `length === 1` block, which the earlier `length === 0` early-return already made dead. No behavior change.

## [2.4.3]

### Security

- **Tool authorization/validation gates are now enforced on the streaming path.** `validateInput` and `checkPermissions` (documented as "when denied, handler is NOT invoked") were applied only in `ToolManager.executeTool`, which backs `generate()`/`respond()`. The streaming executor (`StreamingToolExecutor`, used by `stream()`) invoked tool handlers directly, so a tool gated for access control ran with unvalidated/unauthorized arguments on the streaming transport while the same call was correctly blocked on the non-streaming one. Both paths now run the gates through a single shared module (`toolGates`), so a denied tool's handler is never invoked regardless of transport. If you relied on this bypass, a previously-running `stream()` tool call may now be denied — the same as it already was under `generate()`.
- **Session/user ids are validated as scalars before reaching a persistence query.** Methods that look up by id (`getSession`, `loadSessionState`, `getSessionMessages`, `deleteSession`, `findActiveSession`, `getUserSessions`, `getUserMessages`) and `SessionManager.getOrCreate` forwarded their argument straight into the adapter. With a NoSQL adapter (e.g. MongoDB), a non-string value such as `{ $ne: null }` — trivially produced by an unvalidated HTTP body or an Express `?sessionId[$ne]=` query — is interpreted as query operators, enabling cross-tenant session/message reads and `deleteMany`-based mass deletion. These ids are now rejected at the framework boundary (extending the guard that already existed on the save path) with a clear `"... must be a non-empty string"` error; `undefined` still auto-generates and empty strings keep their fall-back semantics.

### Fixed

- **Empty streaming completions now retry like the non-streaming path instead of emitting a blank message.** When a provider returned no text and no tool calls, `respondStream()`/`stream()` silently yielded an empty final chunk, while `respond()`/`generate()` threw `"No response from <provider>"` inside `withTimeoutAndRetry` and recovered on the same model. The streaming model call (`generateStreamWithModel` in the Gemini, Anthropic, and OpenAI-compatible providers) now applies the same empty-completion guard and is wrapped in a new `withStreamRetry` helper — the streaming analog of `withTimeoutAndRetry` that re-runs the stream only while it fails *before yielding its first chunk* (an empty completion yields nothing, so a retry can never double-emit deltas already sent to the consumer). A valid-JSON-but-blank structured message (`{"message":""}`) is now treated as empty on **both** paths. If every attempt still comes back empty, the error surfaces (on `respondStream` via the done-chunk `error` field) instead of reaching the user as a blank message.
- **The streaming path now produces a result-aware message after tools run but the model returns no text.** Non-streaming `runLoop` already made a follow-up LLM call to turn tool results into a user-facing message; the streaming concurrent batch (`runStreamingBatch`) skipped this and could surface the bare tool-invocation preamble — or nothing — as the response. Both paths now share the same forced-final-text logic (`forceFinalTextFromTools`), so a streamed turn that executes tools ends with a message generated from their results.
- **An explicit `retryConfig.retries: 0` is now honored instead of being silently coerced to the default.** All three providers built their retry config with `retries || DEFAULT_RETRY_CONFIG.retries`, so passing `0` to disable retries fell through to the default of `3`. This is now `?? `, which respects an intentional zero; the same falsy-zero coercion is fixed for `maxToolLoops`. (`timeout` keeps `||` deliberately — a 0ms timeout aborts every call immediately, so falling back to the default is the safe behavior.)
- **A persisted session's owner (`userId`) is no longer derived from collected-data metadata.** On first save, a new session row took its `userId` from `collectedData.metadata.userId` (model/user-influenced state) when present, `JSON.stringify`-wrapped — a latent tenant mis-attribution footgun, and a correctness bug (the wrapped value never matched `findByUserId`/`findActiveByUserId`, orphaning the session). The owner is now always the authenticated principal from `PersistenceConfig.userId`, matching `createSession`.

## [2.4.2]

### Fixed

- **Extraction-mode signals gated only by `if` (no `when`) now run their extraction.** A signal with `extract` plus an `if` predicate but no `when` — the shape of the documented `leadStage` example — matched through the code path but never issued an extraction call, so its handler always received `ctx.extracted: undefined`. Extraction now runs for every code-matched signal (unconditional or `if`-gated) that declares `extract`, alongside the existing `when`-conditioned path. LLM-conditioned signals are unaffected: their extraction is still merged into the single classifier batch.
- **A matched extraction-mode signal that returns no payload is no longer silent.** When the classifier reports `matched: true` but returns no `extracted` value — commonly because the `extract` schema used a provider-ignored keyword such as `nullable: true` instead of `type: ['string', 'null']`, so the model omits the field — the firing now carries an `extractionError` and a WARN is logged, instead of passing `extracted: undefined` to the handler with no trace. The handler still runs.

### Added

- **`SignalFiring.extractionError`** — set when an extraction-mode signal matched but no `extracted` payload was returned (see above). Optional and additive.

## [2.4.1]

### Fixed

- **Sessions now finalize exactly once per turn.** Non-streaming halt paths (signal halt, auto-chain halt/complete) previously finalized twice — running the step `finalize` hook and the persistence auto-save a second time. Streaming previously persisted the session *before* the post-signal phase, so a post-signal `pendingDirective` was never persisted for `respondStream()`-only callers, and the branch flow-transition chunk never finalized at all. Both paths now run post-signal phase → finalize, once.

### Internal

- **Response layer decomposition** (no behavior change; the public API surface is untouched). `ResponseModal` (~2,900 lines owning roughly eleven concerns) is now a thin coordinator over focused collaborators:
  - `ResponsePipeline` is the single owner of routing, step selection, and branch evaluation — `routeAndSelectStep()` is the turn's routing entry point (routing-skip optimization, pre-signal phase in parallel with routing, pre-extraction, next-step determination) and `resolveRenderStep()` replaces the render-step logic previously duplicated in the streaming and non-streaming paths. ~600 lines of dead duplicated tool/data-collection logic were removed from it.
  - `ToolLoopExecutor` owns the tool follow-up loop (run tools → ask the LLM again → reconstruct tool-result history → force a final text response) and the streaming concurrent batch via `ToolManager.executeWithConcurrency`, which falls back to the same loop. `ToolManager` remains the registry/resolver and single-tool executor.
  - `SessionFinalizer` is the single implementation of end-of-turn finalization: deterministic compaction, persistence auto-save, the step `finalize` hook, and live-session sync.
  - `SignalCoordinator` owns signal pre/post phase orchestration, including position-directive application and the post-phase result application previously duplicated at four sites.
  - `StepLifecycle` executes step `prepare`/`finalize` handlers (function, tool id, or inline tool).
  - `ResponseGenerationError` moved to `src/core/ResponseGenerationError.ts`.
  - `ResponseModal` consumes a narrow `ResponseModalDeps` interface (implemented by `Agent`), so the response layer is testable without constructing a full `Agent`.

## [2.4.0]

Architecture hardening release: concurrency safety for sessions, a consolidated provider layer, and a stricter type surface. See `docs/migration/v2-3-to-v2-4.md` for the upgrade guide.

### Added

- **Optimistic session locking.** `SessionState`/`SessionData` carry a `version` incremented on every save. A save with a stale version throws the new `SessionConflictError` (exported) instead of silently overwriting state written by a concurrent turn — the failure mode for parallel webhooks or double-sends. Rows written by pre-2.4 versions have no stored version and are accepted without conflict. SQLite and PostgreSQL adapters auto-add the `version` column on `initialize()`; Prisma users should add `version Int?` to their session model (the adapter detects a missing column and degrades gracefully, leaving locking inactive). Same-process concurrent saves of one session are serialized through a per-session queue and never conflict with each other.
- **Session schema versioning.** `PersistenceConfig.schemaVersion` stamps persisted state; `PersistenceConfig.migrateSession(collectedData, fromVersion)` upgrades state written by older deployments at load time. Without a migrator, a version mismatch logs a warning and loads as-is.
- **Failed-turn rollback.** If `respond()`/`stream()` throws mid-turn, the in-memory session is restored to its pre-turn snapshot, so in-memory and persisted state stay consistent (a failed turn has no effect; the user message added before the turn is retained).
- **Deterministic history compaction.** When `compaction` is configured, it now runs at end-of-turn finalize on every `respond()`/`chat()`/`stream()` — previously it only ran inside `session.addMessage()`, so respond-only integrations grew history unboundedly.
- **`ProviderError` with normalized codes.** Terminal provider failures (after retries and backup models) now throw `ProviderError` with a `code` of `rate_limited | overloaded | auth | invalid_request | schema_rejected | timeout | network | unknown` and the original SDK error as `cause`.
- **`AiProvider.capabilities`.** Every provider declares `ProviderCapabilities` (`supportsTools`, `supportsNativeJsonSchema`, `supportsStreaming`, `supportsStreamingToolCalls`, `supportsPromptCaching`). Notably, Anthropic reports `supportsNativeJsonSchema: false` — its structured output is prompt-instructed, not schema-enforced.
- **`OpenAICompatibleProvider` base class** (exported). OpenAI, DeepSeek, and OpenRouter are now thin subclasses (~80–150 lines each, down from ~650); building a new OpenAI-compatible provider (Groq, Together, …) is a small subclass instead of a 600-line copy.
- **New exports:** `SessionConflictError`, `ProviderError`, `ProviderErrorCode`, `ProviderCapabilities`, `SessionUpdateOptions`, `OpenAICompatibleProvider`, `ResolvedSignalDirective`.

### Changed

- **`session.data` is the single source of truth for collected data.** The bidirectional sync between `Agent`'s internal copy and the session (a divergence footgun under load) is gone. `getCollectedData()`/`getData()` read from the live session; `updateCollectedData()` writes into it. Data set before any session exists (including `initialData`) is staged and seeds the first created session; loading an existing session keeps the stored data. `agent.currentSession` now delegates to `agent.session` instead of holding a second copy.
- **Passing an explicit `session` to `respond()` no longer merges the managed session's data into it** — that was cross-session state leakage.
- **`ResponsePipeline` no longer holds mutable turn state.** Context and session are passed explicitly; `determineNextStep` takes a required `context` parameter.

### Breaking

- **Custom `AiProvider` implementations must declare `capabilities`.**
- **Custom `SessionRepository` implementations:** `update()` gained an optional `options?: { expectedVersion?: number }` parameter. Implement the compare-and-swap (see `MemoryAdapter`) or ignore it to opt out of locking.
- **Generic defaults are now `unknown` instead of `any`** on `Agent`, `Tool`, `ToolContext`, `ToolResult`, `ToolHandler`. Untyped tool code that relied on implicit `any` may need explicit type parameters or type guards. `ToolHistoryItem.content` is now `unknown`.
- **`SignalFiring.directive` is typed `ResolvedSignalDirective`** — `replyWith` is resolved onto `reply` before firings reach the response surface (this was already the runtime behavior).
- **Removed from the public barrel:** `DirectiveChainTracker`, `DirectiveChainEntry`, `StreamingToolExecutor` (internals that locked the architecture into semver).
- **Removed:** `ResponsePipeline.setContext/setCurrentSession/getStoredContext/getCurrentSession` and `ResponsePipeline.updateDataFlow` (stored-state API replaced by explicit parameters).
- **Provider terminal errors are now `ProviderError`** — code that matched on raw SDK error shapes after retry exhaustion should match on `error.code`, with the original error available on `error.cause`.

### Internal

- `ToolManager` no longer value-imports `Agent` (runtime circular dependency broken).
- Shared `evaluateIfPredicates` utility — branch, signal, and auto-chain `if` evaluation now use one implementation; `AutoChainExecutor` uses the canonical `BranchEntry`/`BranchMap` types instead of a divergent local copy.
- The `beforeRespond` hook's context result is returned explicitly from `prepareResponseContext` instead of being read back from pipeline state; the agent context is no longer redundantly self-updated every turn.
- New test suite `tests/session-concurrency.test.ts` covering locking conflicts, save serialization, version round-trip, schema migration, failed-turn rollback, and pre-session data staging.

## [2.3.0]

### Added

- **`!` exclusions are now supported across all AI-evaluated `when` fields.** Flows, steps, branches, instructions, and signals now share one `ConditionWhen` syntax: non-`!` entries are OR alternatives, while `!`-prefixed entries are stripped and treated as OR exclusions where any match inhibits the condition. Negative-only `when` values mean "active unless this exclusion matches."

## [2.2.4]

### Fixed

- **Signal `when` arrays now use OR semantics for positive entries.** Non-`!` entries are treated as alternative natural-language matches, consistent with flows, steps, instructions, and branches. `!` exclusions still inhibit when any exclusion matches.
- **Post-phase signal `reply` / `replyWith` now replaces the final message.** Non-streaming responses return the post-signal replacement, and streaming responses expose it on the terminal chunk's authoritative `accumulated` value.
- **Failed signal handlers no longer burn `once` or cooldown state.** `SignalsState.triggers` is recorded only after the handler completes successfully; handler failures still appear on `SignalFiring.handlerError`.

## [2.2.3]

### Added

- **`createPersistedState` re-exported from package root** — The session persistence helper was previously only available via `@falai/agent/utils`. Now exported from the main entry point for convenience.

## [2.2.2]

### Added

- **`DeepSeekProvider`** — New provider for the DeepSeek API (OpenAI-compatible). Supports `deepseek-chat` and `deepseek-reasoner` models with backup model failover, retry logic, streaming, and reasoning content extraction. Uses the `openai` SDK with a custom base URL — no new dependencies required.

## [2.2.1]

### Fixed

- **Conditional instruction `when` clauses now reach the response model.** `PromptComposer.addInstructions()` previously collected textual `when` clauses but rendered only the instruction prompt, so the model could not apply the condition. Conditional instructions now render their `when` clauses inline after deterministic `if` predicates pass.
- **`when: string[]` now consistently means OR across flows, steps, instructions, and branches.** Arrays represent alternative natural-language matches, such as `"client asked about the address"` or `"client asked where we are located"`. Code-evaluated `if: predicate[]` retains AND semantics. Signal conditions keep their documented specialized include/exclude behavior.

### Internal

- Migrated package scripts from npm invocations to Bun (`bun run`, `bun pm version`, and `bun publish`) and removed an empty `preinstall` hook.

## [2.2.0]

### Changed

- **`@google/genai` upgraded** from `^0.3.0` to `^2.7.0`. The `GeminiProvider` already targeted the modern unified SDK surface (`new GoogleGenAI()`, `models.generateContent`, `Type` enum), so no provider code changes were required. Typecheck, lint, and the full test suite pass against the new SDK.

### Removed

These were all dead or `@deprecated` symbols carrying no runtime behavior. If you imported any of them, the fix is a straight deletion or the noted replacement.

- **`CompositionMode` enum** — had a single member (`FLUID`) and was referenced nowhere. Already documented as removed in the v1→v2 migration guide; the dead export is now actually gone.
- **`RoutingDecision` / `RoutingSchemaOptions` types** — listed as removed in the v1→v2 migration guide but still present as zombie exports. Now removed. The live routing type is `FlowRoutingDecisionOutput` (internal).
- **`normalizeHistory` utility** — `@deprecated` alias for `historyToEvents`. Use `historyToEvents` instead.
- **`renderTemplate` / `renderTemplateObject`** — `@deprecated` synchronous helpers, removed from the public surface. Use the async `render` function instead. (Both remain internal implementation details of `render`.)
- **`NamedSchema` type** — unused, never exported on the stable surface.
- **`MessageRoleType` / `EventKindType` type aliases** — unused aliases of the `MessageRole` / `EventKind` enums. Use the enums directly.
- **`Flow.getTerms()`** — `@deprecated`, always returned `[]` (flow-level terms were removed in v2). Terms are agent-level via `agent.getTerms()`.
- **`ToolManager.execute()` / `ToolManager.executeTools()`** — an unused fallback-tools + retry subsystem with no callers. The live execution paths are `ToolManager.executeTool()` (single) and `ToolManager.executeWithConcurrency()` (batched). Tool error handling, validation gates, and permission gates are unchanged — they live in `executeTool()`.

### Fixed

- **`SqliteStatement` typo** — the exported SQLite statement interface was misspelled `SqliteStepment` (a find/replace artifact from the v2 Route→Flow/Step rename). Renamed to `SqliteStatement`. Update any type imports.

### Internal

- Removed unreachable "ToolManager not available" fallback branches in `ResponseModal` — `agent.tool` is always initialized in the `Agent` constructor, so `getToolManager()` now returns a non-optional `ToolManager`.
- Fixed a layering inversion: prompt-cache config types (`PromptSectionType`, `PromptCacheConfig`, `SectionCompute`) moved from `core/PromptSectionCache` to `types/prompt-cache`. Core now imports them from `types/` instead of `types/` reaching into `core/`.
- De-duplicated re-exports in `types/index.ts` (removed redundant `export *` over explicit named exports).

### Dependencies

- Moved `@types/pg` to `devDependencies` (type-only, for an optional peer).
- Removed `@types/redis` (unused — the `RedisAdapter` defines its own `RedisClient` interface).
- Removed `vitest` from `devDependencies` (tests run on `bun:test`; `vitest` was never imported).
- Removed `mysql2` from peer dependencies (no MySQL adapter exists).
- Removed the `redis` (node-redis) peer-meta entry — the `RedisAdapter` targets `ioredis`.
- Pinned previously empty peer-dependency version ranges: `ioredis ^5.0.0`, `mongodb ^6.0.0`, `pg ^8.0.0`.

## [2.1.1]

### Fixed

- Fixed `ToolManager not available on agent` warning during initialization. `ResponseModal` was constructed before `ToolManager`, so `agent.tool` was `undefined` when `ResponsePipeline` captured it. Moved `ToolManager` initialization before `ResponseModal` in the `Agent` constructor.

## [2.1.0]

### ⚠️ BREAKING CHANGES

#### `PreDirective` removed — merged into `Directive`

- **What changed:** The `PreDirective` interface and its export have been removed entirely. The three pre-LLM-only fields (`appendPrompt`, `injectTools`, `halt`) now live directly on `Directive`. `SignalDirective` extends `Directive` directly.
- **Migration:** Replace any `import { PreDirective }` with `import { Directive }`. All hook return types (`onEnter`, `prepare`) now return `Directive` instead of `PreDirective`. The shape is identical — no code changes needed beyond the type annotation.
- **Runtime behavior:** Pre-LLM fields emitted from post-LLM hooks (`finalize`, `onComplete`) or persisted to `session.pendingDirective` are now ignored with a `WARN`-level log (previously `DEBUG`). This makes misuse visible in logs without crashing.

### Improved

- **Type variance fix:** `Directive` is now covariant in both `TContext` and `TData`, eliminating 15+ pre-existing type errors in internal pipeline code. The fix: `complete.next` uses `Directive<unknown, unknown>` (the chained directive doesn't need precise generics), and `injectTools` uses `Tool[]` (default params).
- **Cleaner `flow.merge`:** The merge function no longer casts through `Record<string, unknown>` for the pre-LLM fields — they're accessed directly on the typed `Directive`.
- **Docs:** Architecture page updated from "seven primitives" to "six primitives." All references to the PreDirective/Directive inheritance chain removed. The concepts page now explains pre-LLM fields as a lifetime rule enforced at runtime, not a type-system boundary.

### Docs

- Fixed dead links in docs landing page (`./guides/` and `./reference/` pointed to directories with no index file).
- Consolidated `docs/migration/README.md` — Route → Flow rename is now presented as part of the v1 → v2 guide, not a separate section.
- Removed standalone `docs/migration/route-to-flow.md` — content merged into v1-to-v2.md §3.

## [2.0.1]

### Fixed

- Updated all model references to current 2026 models: Gemini `gemini-3.1-flash-lite` / `gemini-3.1-pro-preview`, OpenAI `gpt-5.5` / `gpt-5.4`, Anthropic `claude-sonnet-4-6` / `claude-opus-4-7`.
- Fixed `docs/README.md` not rendering as the site homepage (added frontmatter with `type: overview`, `order: 0`).

## [2.0.0]

### ⚠️ BREAKING CHANGES

#### `Route` domain noun renamed to `Flow`

The `Route` domain noun has been renamed to `Flow` across the entire `@falai/agent` package. This is a clean break with no compatibility shims or dual-naming layer.

The verb form `route()` and the gerund "routing" are preserved — routing-as-an-action remains the correct verb for selecting a flow.

**Key renames:**

| Old | New |
|-----|-----|
| `Route` (class) | `Flow` |
| `RoutingEngine` (class) | `FlowRouter` |
| `RouteOptions` | `FlowOptions` |
| `RouteRef` | `FlowRef` |
| `RouteTransitionConfig` | `FlowTransitionConfig` |
| `RouteCompletionHandler` | `FlowCompletionHandler` |
| `RouteLifecycleHooks` | `FlowLifecycleHooks` |
| `RouteConfigurationError` | `FlowConfigurationError` |
| `agent.createRoute()` | `agent.createFlow()` |
| `agent.getRoutes()` / `agent.routes` | `agent.getFlows()` / `agent.flows` |
| `agent.nextStepRoute()` | `agent.nextStepFlow()` |
| `agent.getRoutingEngine()` | `agent.getFlowRouter()` |
| `AgentOptions.routes` | `AgentOptions.flows` |
| `AgentOptions.routeSwitchMargin` | `AgentOptions.flowSwitchMargin` |
| `session.currentRoute` | `session.currentFlow` |
| `session.routeHistory` | `session.flowHistory` |
| `END_ROUTE` / `END_ROUTE_ID` | Removed (implicit terminus) |
| `generateRouteId()` | `generateFlowId()` |
| `enterRoute()` | `enterFlow()` |
| `updateRouteStep()` (adapters) | `updateFlowStep()` |
| `'end_route'` / `'route_complete'` | `'flow_complete'` |

**Persistence changes:** All adapters rename `current_route` → `current_flow`, `route_history` → `flow_history`, and the `route` column/field → `flow`. Generated IDs now use the `flow_` prefix instead of `route_`.

See [Migration Guide](docs/migration/v1-to-v2.md#3-route--flow-rename) for upgrade instructions, per-adapter SQL/Mongo/Redis/OpenSearch migration snippets, and ID prefix migration guidance.

#### Flow completion releases the session to idle — no hardcoded farewell message

The completion path is now a pure state transition. The framework emits **no message of its own** when a flow completes. Every word delivered to the user comes from a developer-defined step prompt.

**What changed:**

- The internal `__COMPLETED__` synthetic step (with hardcoded `"Send a brief, natural farewell message…"` prompt) is **removed**.
- The hardcoded prompt directives shipped on every completion turn (`"Generate a natural, friendly farewell message"`, `"Do NOT mention task names…"`, `"Do NOT use words like 'tarefa', 'dados coletados'…"`, etc.) are **removed**.
- The hardcoded English fallback `"Thank you! I've recorded all the information for your <flow title>."` is **removed**.
- The completion-time LLM call (`handleFlowCompletion`'s `provider.generateMessage(...)` and `streamFlowCompletion`'s `provider.generateMessageStream(...)`) is **removed**. Completion no longer costs tokens.

**New idle-state semantics:**

When a flow completes (last step reached, `requiredFields` satisfied, or a `complete` directive fires) and `onComplete` does not produce a transition:

- `session.currentFlow` is set to `undefined`.
- `session.currentStep` is set to `undefined`.
- The corresponding `session.flowHistory` entry is updated with `completed: true` and `exitedAt: <now>`.
- The router excludes any flow whose most recent `flowHistory` entry is `completed: true` from candidate scoring on subsequent turns.
- If all flows are filtered out, the engine falls back to the no-flow response path (uses agent identity/personality only).

This eliminates the v1 bug where a session pinned `currentFlow` and `currentStep = '__COMPLETED__'` after completion and the router got stuck re-entering the last step on every subsequent turn.

#### `flow.reentrant: boolean` opt-in for re-routable flows

Added `FlowOptions.reentrant` (default `false`). When `true`, a flow can be re-selected by the router after it has completed in the current session — useful for "do another?" patterns (re-book, re-search, repeat-task). On re-entry, the engine clears every field declared in the flow's `requiredFields` and `optionalFields` so the flow starts fresh from its initial step. Fields not owned by this flow are preserved in `session.data`.

`onComplete` always wins over `reentrant`. If `onComplete` returns a target flow, the session transitions there immediately on completion; `reentrant` is consulted only when `onComplete` is absent or returns `undefined`.

```ts
const agent = new Agent({
  // ...
  flows: [
    {
      title: 'Search',
      reentrant: true,  // user can search again after completing
      requiredFields: ['query'],
      // ...
    },
  ],
});
```

#### New session utilities

- **`completeCurrentFlow(session, { clearOwnedFields? })`** — releases the session to idle state. Marks the active `flowHistory` entry as `completed: true`, clears `currentFlow` and `currentStep`, and (when `clearOwnedFields` is provided) removes those fields from `session.data` for `reentrant` re-entry.
- **`isFlowCompletedThisSession(session, flowId)`** — returns `true` when the flow's most recent `flowHistory` entry is `completed: true`. Used by the router to exclude completed flows.

Both are exported from `@falai/agent`.

**Migration:**

If your v1 code expected the framework to send a farewell message on completion, **add an explicit final step** with your own copy:

```ts
// Before (v1 — relied on framework-generated farewell)
flow({
  title: 'Onboarding',
  steps: [
    { id: 'name',  collect: ['name'] },
    { id: 'email', collect: ['email'] },
  ],
});

// After (v2 — author your own closing turn)
flow({
  title: 'Onboarding',
  steps: [
    { id: 'name',   collect: ['name']  },
    { id: 'email',  collect: ['email'] },
    { id: 'thanks', prompt: 'Thank the user warmly. Wish them a great day.' },
  ],
});
```

If your v1 code relied on the router re-entering the last step after completion, that loop is gone — the session is idle and the next turn either applies `onComplete`, re-enters a `reentrant` flow, or runs the no-flow fallback. To restore the v1 loop deliberately, set `reentrant: true` on the flow.

If your tests asserted on the framework's hardcoded farewell language (`"Thank you!"`, `"recorded all the information"`, etc.), update them to assert on your own step prompts instead.

See [`/.kiro/specs/v2-overhaul/flow-completion.md`](.kiro/specs/v2-overhaul/flow-completion.md) for the full design rationale and [docs/migration/v1-to-v2.md](docs/migration/v1-to-v2.md) for the consolidated v2 migration guide covering idle-state semantics, `onComplete` vs `reentrant` precedence, and the final-step idiom.

#### `END_ROUTE` / `endRoute()` removed — implicit terminus

The `END_ROUTE` symbol, `END_ROUTE_ID` constant, `Step.endRoute()` method, and `RouteOptions.endStep` configuration have been completely removed. Route/flow completion is now implicit: **the last step in a flow terminates the route automatically**.

**What changed:**

| Removed | Replacement |
|---------|-------------|
| `END_ROUTE` symbol | Just stop chaining — the last step is the terminus |
| `END_ROUTE_ID` constant | Removed entirely |
| `Step.endRoute()` method | Not needed — last `.nextStep(...)` is the final step |
| `StepResult.endRoute` property | Removed from the interface |
| `RouteOptions.endStep` / `Route.endStepSpec` | Move closing prompt into the last step's `prompt` |
| `StoppedReason: 'end_flow'` | `'flow_complete'` (covers both "all steps processed" and "last step reached") |
| `END_ROUTE` in `steps[]` array | Just end the array — last element is the terminus |

**Migration:**

```typescript
// Before (1.x)
route.initialStep
  .nextStep({ prompt: "Collect name", collect: ["name"] })
  .nextStep({ prompt: "Collect email", collect: ["email"] })
  .endRoute({ prompt: "Thanks for signing up!" });

// After (2.0)
route.initialStep
  .nextStep({ prompt: "Collect name", collect: ["name"] })
  .nextStep({ prompt: "Collect email", collect: ["email"] })
  .nextStep({ prompt: "Thanks for signing up!" });
// ↑ last step is the implicit terminus — no endRoute() needed

// Before: steps array with END_ROUTE
{ steps: [{ id: "step1", prompt: "..." }, END_ROUTE] }

// After: just end the array
{ steps: [{ id: "step1", prompt: "..." }] }
```

**Rationale:** The `END_ROUTE` sentinel was a special-case escape hatch. With implicit terminus, the developer just stops chaining and the flow ends — no sentinel needed. This simplifies the mental model and removes an entire category of "forgot to add END_ROUTE" bugs.

#### Guideline / Rule / Prohibition collapsed into `Instruction`

The three v1 behavioral primitives — `Guideline`, `Rule`, and `Prohibition` — are unified into a single `Instruction<TContext, TData>` type with a `kind: 'must' | 'never' | 'should'` discriminator. Field names align with the rest of the DSL (`route.when`, `step.prompt`):

```typescript
// 1.x
{ condition: "user is hesitant", action: "Offer to compare options." }
// or rules[]: { content: "..." }
// or prohibitions[]: { content: "..." }

// 2.0
{ kind: 'should', when: "user is hesitant", prompt: "Offer to compare options." }
{ kind: 'must',   prompt: "Always confirm the booking before charging." }
{ kind: 'never',  prompt: "Reveal payment internals." }
```

#### Migration table — Instruction unification

| 1.x type / field | 2.0 replacement |
|------------------|-----------------|
| `Guideline` type | `Instruction` |
| `ScopedGuidelines` type | `ScopedInstructions` |
| `AppliedGuideline` type | `AppliedInstruction` |
| `GuidelineMatch` type | (removed; drop) |
| `condition: ...` (on Guideline) | `when: ...` (on Instruction) |
| `action: ...` (on Guideline) | `prompt: ...` (on Instruction) |
| `Rule` type / `rules: Rule[]` | `instructions: Instruction[]` with `kind: 'must'` |
| `Prohibition` type / `prohibitions: Prohibition[]` | `instructions: Instruction[]` with `kind: 'never'` |
| `AgentOptions.guidelines` | `AgentOptions.instructions` |
| `AgentOptions.rules` | `AgentOptions.instructions` (`kind: 'must'`) |
| `AgentOptions.prohibitions` | `AgentOptions.instructions` (`kind: 'never'`) |
| `FlowOptions.guidelines` | `FlowOptions.instructions` |
| `FlowOptions.rules` | `FlowOptions.instructions` (`kind: 'must'`) |
| `FlowOptions.prohibitions` | `FlowOptions.instructions` (`kind: 'never'`) |
| `AgentResponse.appliedGuidelines` | `AgentResponse.appliedInstructions` |
| `AgentResponseStreamChunk.appliedGuidelines` | `AgentResponseStreamChunk.appliedInstructions` |
| `agent.evaluateGuidelines(...)` | (removed; evaluation is internal to prompt composition) |
| `route.evaluateGuidelines(...)` | (removed) |
| `step.evaluateGuidelines(...)` | (removed) |
| `agent.createGuideline(...)` | `agent.createInstruction(...)` |
| `agent.getGuidelines()` / `getRules()` / `getProhibitions()` | `agent.getInstructions()` |
| `agent.guidelines` / `rules` / `prohibitions` getters/setters | `agent.instructions` |
| `flow.createGuideline(...)` | `flow.createInstruction(...)` |
| `flow.getGuidelines()` / `getRules()` / `getProhibitions()` | `flow.getInstructions()` |
| `flow.guidelines` getter | `flow.instructions` |
| `step.addGuideline(...)` | `step.addInstruction(...)` |
| `step.getGuidelines()` | `step.getInstructions()` |
| `AgentOptions.compositionMode` / `CompositionMode` enum | Removed entirely (had no runtime effect; only `FLUID` was ever observed) |

#### Add `step.branches`: explicit, source-local fork primitive

Add `step.branches`: explicit, source-local fork primitive with `if` (code) and `when` (AI) conditions; coexists with the implicit-fork pattern. Branches are evaluated after the step's post-LLM phase and before linear successor selection. The first matching entry wins (declaration order). Code predicates run first to save tokens — AI conditions are only evaluated when `if` passes or is absent.

See [Branches documentation](docs/reference/branches.md) for full details.

#### Multi-step batching replaced with explicit `auto: true` steps

Replaced multi-step batching with explicit `auto: true` steps. `maxStepsPerBatch` removed, `BatchExecutor` and `BatchPromptBuilder` deleted, `auto` and `maxAutoStepsPerTurn` added. See [docs/migration/v1-to-v2.md](docs/migration/v1-to-v2.md).

#### Prompt shape: `## Instructions` (breaking runtime effect)

The rendered prompt section has changed shape. If you have tests or integrations that assert on prompt output, update them:

- **Section header** changed from `## Guidelines` to `## Instructions`.
- **Inline scope captions** are now prepended to each line: `[Always]`, `[In: <FlowTitle>]`, `[Step: <stepId>]`.
- **No numbering** — instructions are rendered as unordered list items (`- [Caption] text`).
- **No `Additional Context` trailer** — AI context strings from `when` conditions are no longer appended as a separate block.

Example rendered output:

```
## Instructions

- [Always] Be concise unless the user asks for detail.
- [In: Booking] Offer to compare two options before pushing for a decision.
- [Step: payment] If the card is declined, never retry without confirmation.
```

#### Agent identity consolidated into `persona`

`AgentOptions.description`, `AgentOptions.identity`, and `AgentOptions.personality` are removed. Use the new `AgentOptions.persona?: Template<TContext>` field — a single prompt covering role, tone, and self-concept. The `description` / `identity` / `personality` getters and setters on `Agent` are deleted with no shims.

`FlowOptions.identity` and `FlowOptions.personality` are removed too — agent identity is agent-level only. Flows shape behavior through `instructions`, not their own persona overrides.

#### Tool / EnhancedTool merged into `Tool`

`EnhancedTool` is removed. All metadata fields (`isReadOnly`, `isConcurrencySafe`, `isDestructive`, `interruptBehavior`, `maxResultSizeChars`, `validateInput`, `checkPermissions`) live directly on `Tool`. Existing `Tool` definitions continue to work; references to `EnhancedTool` must be replaced with `Tool`.

The optional `Tool.name` field is removed. **`Tool.id` is the sole identifier**, used for both registry lookup and LLM-facing display.

`Agent.createTool()` is removed; declare tools via `AgentOptions.tools` or pass them through `StepOptions.tools`.

#### Directive replaces `FlowTransitionConfig` / `FlowCompletionHandler`

The legacy transition shapes are removed. `FlowTransitionConfig` collapses into `Directive`. `FlowCompletionHandler` becomes `hooks.onComplete` returning a `Directive`. Top-level `FlowOptions.onComplete` is now a string-only target (flow id or title); handler form moves to `hooks.onComplete`.

#### `Flow.skipIf` removed

`Flow.skipIf` (which was already hardcoded to `undefined` after the v2 condition split) and `Flow.evaluateSkipIf()` are deleted. Use `Flow.if` for code-evaluated activation guards and `Flow.when` for AI-evaluated guards.

#### `FlowOptions` scope cleanup — agent-level only fields

The following `FlowOptions` fields are removed; they exist agent-level only:

| Removed from FlowOptions | Replacement |
|--------------------------|-------------|
| `identity` | Agent-level `persona` |
| `personality` | Agent-level `persona` |
| `guidelines` | `instructions` (per Instruction unification above) |
| `rules` | `instructions` with `kind: 'must'` |
| `prohibitions` | `instructions` with `kind: 'never'` |
| `terms` | Agent-level `terms` only |
| `knowledgeBase` | Agent-level `knowledgeBase` only |

Corresponding `Flow` methods are also removed: `Flow.createTerm()`, `Flow.getTerms()`, `Flow.getKnowledgeBase()`.

#### `StepOptions.step` field removed

The `step?: StepRef | symbol` field on `StepOptions` is removed (it was dead since `END_FLOW` removal — implicit terminus replaces all sentinel-based wiring).

#### Deprecated `Agent` accessor cleanup

The following deprecated methods and accessors are removed from `Agent` with no shims:

`getCurrentSession()`, `setCurrentSession()`, `clearCurrentSession()` (session lifecycle moved into `SessionManager`); `getSchema()`, `getKnowledgeBase()` (read via `agent.schema` / `agent.knowledgeBase` instead); `description` / `identity` / `personality` getters and setters (folded into `persona`); `compositionMode` getter and setter (composition mode had no runtime effect).

### Added

- **Flow completion handling** — idle-state semantics, the absence of hardcoded farewell, `onComplete` vs `reentrant` precedence, and the "add a final step for closing copy" idiom (see [docs/migration/v1-to-v2.md](docs/migration/v1-to-v2.md)).
- **`Instruction<TContext, TData>`** — new exported type unifying `Guideline`, `Rule`, and `Prohibition` behind a `kind: 'must' | 'never' | 'should'` discriminator with `when` (AI-evaluated) and `prompt` fields.
- **`ScopedInstructions<TContext, TData>`** — new exported type that carries the three scope buckets (`global`, `flow?`, `step?`) through the prompt pipeline.
- **`AppliedInstruction`** — new exported type (`{ id: string; scope: 'global' | 'flow' | 'step'; scopeRef?: string }`) for deterministic observability of which instructions were active during a turn.
- **`AgentResponse.appliedInstructions`** — new optional field populated with the set of instructions that passed `enabled` and `when` evaluation and were rendered into the prompt for that turn. Deterministic (derived from rendering, not from LLM self-report).
- **`AgentResponseStreamChunk.appliedInstructions`** — same field, populated on the final (`done: true`) chunk.

## [1.3.0]

### ⚠️ BREAKING CHANGES

#### `Route` domain noun renamed to `Flow`

The `Route` domain noun has been renamed to `Flow` across the entire `@falai/agent` package. This is a clean break with no compatibility shims or dual-naming layer.

**What changed:**

- All `Route`-prefixed symbols, types, methods, fields, and constants have been renamed to their `Flow`-prefixed equivalents (e.g. `Route` → `Flow`, `RouteOptions` → `FlowOptions`, `RoutingEngine` → `FlowRouter`, `RouteConfigurationError` → `FlowConfigurationError`).
- Agent API: `agent.createRoute()` → `agent.createFlow()`, `agent.getRoutes()` → `agent.getFlows()`, `agent.routes` → `agent.flows`, `AgentOptions.routes` → `flows`, `AgentOptions.routeSwitchMargin` → `flowSwitchMargin`.
- Session shape: `session.currentRoute` → `session.currentFlow`, `session.routeHistory` → `session.flowHistory`.
- Constants: `END_ROUTE` → `END_FLOW`, `END_ROUTE_ID` → `END_FLOW_ID`.
- Utilities: `generateRouteId()` → `generateFlowId()`, `enterRoute()` → `enterFlow()`.
- Adapter method: `updateRouteStep()` → `updateFlowStep()` on all seven persistence adapters.

**Preserved (verb form and gerund):** The method name `route()` on `FlowRouter` and the gerund "routing" are preserved — routing-as-an-action remains the correct verb for selecting a flow.

**Persistence changes (operators must run migration):** All adapters rename persisted columns/fields: `current_route` → `current_flow`, `route_history` → `flow_history`, and the `route` column/field → `flow`. Operators must run the appropriate migration for their backend before upgrading.

**ID prefix changed:** Generated IDs now use the `flow_` prefix instead of `route_`. Existing stored IDs with the `route_` prefix must be migrated.

See the [Migration Guide](docs/migration/v1-to-v2.md#3-route--flow-rename) for the full rename table, per-adapter SQL/Mongo/Redis/OpenSearch migration snippets, and ID prefix migration guidance.

## [1.2.8]

### Fixed

- **Duplicate step-entry corrupts session when `requires` fields are missing**: `ResponsePipeline.determineNextStep()` unconditionally called `enterStep()` on the candidate step, mutating `session.currentStep` before `ResponseModal.processRouteResponse()` could evaluate its `requires` guard. When the guard fired, it read the already-advanced step from the session and stayed on it — effectively entering the step it was supposed to block. The pipeline now checks `requires` fields against `session.data` before calling `enterStep()`; if any are missing, it returns the session unchanged and falls back to the current step.

- **Gemini SDK logs "non-text parts thoughtSignature" warning on every response**: The `safeExtractText` method used the SDK's `.text` getter as the primary path, which internally logs a warning when the response contains non-text parts like `thoughtSignature` (thinking/reasoning tokens). Inverted the extraction logic to always read text parts directly from `candidates[0].content.parts`, bypassing the getter entirely. The `.text` getter is now only a last-resort fallback when no candidates structure exists.

## [1.2.7]

### Fixed

- **Tool loop retry used stale `toolCalls` reference for history**: The fallback LLM call added in 1.2.6 iterated `toolCalls` to build tool-result history, but `toolCalls` had already been reassigned to the empty follow-up array when the while loop broke. The retry call received no tool context, so the LLM couldn't reason about what the tools returned. Now uses `toolResultsMap` directly — which accumulates all tool executions throughout the loop — to build the history for the retry call.

## [1.2.6]

### Fixed

- **Tool loop returns placeholder message when follow-up LLM call is empty**: After `executeUnifiedToolLoop` executed tools successfully, the follow-up LLM call could return an empty or undefined message. Because `processRouteResponse` only overwrites the original message when `toolResult.finalMessage` is truthy, the initial tool-invocation placeholder (e.g. "Deixe-me verificar...") was sent to the user as the final response — making it look like the agent hung. The tool loop now detects this case and makes one additional LLM call with no tools available, forcing a proper text response from the tool results.

## [1.2.5]

### Fixed

- **Session state not synced after `stream()`/`generate()` completion**: The modern APIs (`chat()`, `stream()`, `generate()`) completed without writing the finalized session (route, step, data) back to `agent.session.current`, causing route progress to be lost between turns. Added `syncSession()` to `SessionManager` and explicit sync calls in `stream()` and `generate()` after completion.

- **AbortSignal not propagated to sub-calls**: `generateUnifiedResponse()` passed `signal: undefined` to both `processRouteResponse()` and `handleRouteCompletion()`, preventing cancellation from reaching the AI provider. The caller's signal is now forwarded correctly.

- **Tool follow-up structured data discarded**: `executeUnifiedToolLoop()` did not return `followUpResult.structured`, and `processRouteResponse()` passed the original (pre-tool) response to `collectDataFromResponse()` instead of the follow-up. The tool loop now returns structured data, and `processRouteResponse()` uses it when available.

- **Optional-only routes incorrectly marked as complete**: Routes with only `optionalFields` (no `requiredFields`) had `isComplete()` returning `true` and `getCompletionProgress()` returning `1.0`, making them unselectable by the routing engine. They now correctly return `false`/`0` and can only complete via `END_ROUTE`.

## [1.2.4]

### Fixed

- **Tool result data discarded in tool loop**: The tool execution loop in both `ResponseModal` and `ResponsePipeline` was replacing actual tool result data with a static `"Tool executed successfully"` string when building conversation history for follow-up AI calls. The AI could never see what a tool actually returned, making it unable to reason about tool outputs or incorporate them into its responses. Tool results are now serialized from the `ToolExecutionResult.data` field and passed through as the tool message content in conversation history.

## [1.2.3]

### Fixed

- **Aggressive route switching (Scheduling Route)**: Fixed an issue where the AI would aggressively switch to specific routes (like scheduling) even when not explicitly requested by the user. 
  - **Route IDs in Prompt**: Route IDs and `skipIf` conditions are now explicitly shown in the prompt's `Available Routes` section alongside the route titles, removing ambiguity during the AI's route scoring phase.
  - **Removed Global Condition Leak**: Fixed a prompt construction flaw where all `when` conditions from all eligible routes were combined into a single global list at the end of the routing prompt. Conditions are now properly scoped only to their respective routes, preventing the AI from misinterpreting a specific route's trigger condition as a global conversation objective.


## [1.2.2]

### Added

- **Session resume: honor pre-set route and step on first message** — When a session has a `currentRoute` (and optionally `currentStep`) already set and the conversation history contains no user messages (system-only or empty), the routing engine now skips AI route/step selection and honors the pre-set position. This supports two key scenarios:
  - **Persistence-based resume**: A session loaded from storage already has route/step state; the first system message should pick up where it left off rather than re-routing.
  - **Programmatic placement**: A developer creates a session with `createSession({ currentRoute: { id, title }, currentStep: { id } })` to start the user at a specific point in the flow.

  If the first message is a user message, normal AI routing still applies — the user's intent takes priority over any pre-set state.

## [1.2.1]

### Fixed

- **Critical: Agent stuck on initial step** — The 1.2.0 "native history format" change removed history from the prompt but providers weren't updated to use `input.history` for building conversation messages. The LLM received zero conversation context, causing it to regenerate the initial greeting on every turn.

### Changed

- **Providers now use native multi-turn messages** — All four providers (Anthropic, OpenAI, Gemini, OpenRouter) now build proper multi-turn conversation messages from `input.history` instead of relying on history being embedded in the prompt string. This means the LLM sees real user/assistant turns rather than JSON-serialized events, improving response quality and reducing token usage.

- **`GenerateMessageInput.history` type changed from `Event[]` to `HistoryItem[]`** — The history field now accepts the native `HistoryItem[]` format (with `user`/`assistant`/`tool`/`system` roles) that maps directly to each provider's API. Callers updated accordingly.

- **History removed from system prompt** — `addInteractionHistory()` and `addLastMessage()` are no longer called in `buildResponsePrompt()` and `buildFallbackPrompt()`. The `lastMessage` param is removed from `BuildResponsePromptParams`. History flows exclusively through the provider's native message format.

- **`addInteractionHistory()` deprecated for response generation** — The method remains on `PromptComposer` because it's still used by `RoutingEngine` and `BatchPromptBuilder` for route/step selection prompts (single-shot classification calls where history belongs in the prompt). It is no longer used for main response generation.

## [1.2.0]

### Added

- **StreamingToolExecutor**: New concurrency-controlled tool executor that begins executing tools as they arrive from the LLM stream. Read-only tools (`isConcurrencySafe`) run in parallel; write tools run serially. Includes sibling abort propagation, configurable max parallel executions (default: 10), progress message yielding, and per-tool result size budgeting.

- **CompactionEngine**: New context management component that automatically reduces conversation history size when approaching token limits. Applies strategies in order of cost: tool result budgeting → micro-compaction → LLM summarization. Configurable via `compaction` option on `AgentOptions`.

- **EnhancedTool interface**: Extends the existing `Tool` interface with optional metadata methods: `isConcurrencySafe`, `isReadOnly`, `isDestructive`, `interruptBehavior`, `validateInput`, `checkPermissions`, and `maxResultSizeChars`. Existing `Tool` definitions continue to work without modification.

- **Validation and permission gates in ToolManager**: `validateInput` and `checkPermissions` on `EnhancedTool` are checked before calling the handler. If validation fails or permission is denied, the handler is never invoked.

- **`executeWithConcurrency` method on ToolManager**: Async generator that creates a `StreamingToolExecutor`, resolves tools, queues them, and yields `ToolExecutionUpdate` results in request order.

- **PromptSectionCache**: New prompt generation optimization component that memoizes static prompt sections (agent identity, glossary, knowledge base, route descriptions) across turns and recomputes dynamic sections per-turn. Configurable via `promptCache` option on `AgentOptions` with `enabled` and `volatileKeys` settings. Supports targeted invalidation via `invalidate(key)` and full reset via `invalidateAll()`.

- **Native history format**: Conversation history is now sent as native provider messages via `GenerateMessageInput.history` instead of being JSON-serialized into the system prompt. This saves tokens and lets providers optimize for their native message format. The `addInteractionHistory()` and `addLastMessage()` methods on `PromptComposer` are deprecated but remain functional for backward compatibility.

- **Automatic cache invalidation**: `agent.updateContext()` invalidates context-dependent cached sections, session changes invalidate all cached sections, and route switches invalidate route-dependent sections — no manual cache management required.

- **Documentation**: Guides for streaming tool execution, context compaction, EnhancedTool interface, and prompt optimization in `docs/`. Updated API overview and README.

- **Examples**: Working examples for streaming tool execution, context compaction, and enhanced tool metadata in `examples/`.

### Fixed

- **Provider tool call handling across all providers**: Tool-only responses (no text content) no longer throw `"No response from ..."`. All four providers (Anthropic, OpenAI, OpenRouter, Gemini) now correctly handle responses that contain only function calls.

- **Streaming tool calls dropped without JSON schema**: In OpenAI and Gemini streaming, tool calls were silently lost when no JSON schema was configured because `structured` was only set for JSON schema responses. Tool calls now always produce a `structured` response.

- **Structured response spread order**: All providers had `{ message, toolCalls, ...structured }` which allowed a parsed JSON schema response to overwrite actual `toolCalls`. Fixed to `{ ...structured, message, toolCalls }` so real tool calls always take precedence.

- **Gemini tool parameter schema conversion**: Tool parameters were passed as raw JSON Schema to Gemini's `FunctionDeclaration.parameters`, which expects Gemini's own `Schema` type. Parameters now go through `adaptSchemaForGemini()` with proper type enum conversion and empty-object handling.

- **Gemini `response.text` / `chunk.text` safety**: The `.text` getter can throw when the response contains only function calls. Added `safeExtractText()` that falls back to manually extracting text parts from candidates.

- **Gemini abort signal passthrough**: `AbortSignal` from `input.signal` is now forwarded to both `generateContent` and `generateContentStream` via `config.abortSignal`.

## [1.1.3]

### Changed

- **Agent identity prompt rewrite**: `addAgentMeta` now produces an imperative identity block instead of passive key-value metadata. The agent name is framed as a self-referencing instruction, identity and personality are rendered as directives, and goal/description provide supporting context. This makes the LLM far more likely to internalize and consistently use the agent's configured persona.

- **Agent-level rules and prohibitions in identity block**: `addAgentMeta` now renders agent-level `rules` and `prohibitions` directly inside the identity section, reinforcing them as core behavioral constraints rather than detached instructions. This ensures they are present in every prompt path (response, routing, step selection, batch, fallback) without requiring each caller to merge them separately.

### Fixed

- **Duplicate agent rules/prohibitions in prompts**: Agent-level rules and prohibitions were being injected twice in response prompts — once via `addAgentMeta` and again when `ResponseModal` merged `agent.getRules()` with `route.getRules()` before passing them to `buildResponsePrompt`. The same duplication existed in `BatchPromptBuilder`. All call sites now pass only route-level rules/prohibitions, since agent-level ones are handled by `addAgentMeta`.

## [1.1.2]

### Fixed

- **Internal data leaking into user-facing messages**: Route completion messages were including raw collected data (e.g., `"Dados coletados: prospectName: Aco Alimentos, prospectSector: ..."`) and internal task names (e.g., `"Tarefa concluída: Prospecção Inicial"`). The completion directives now explicitly instruct the AI to generate natural, conversational farewell messages without echoing field names, JSON keys, or internal information.

- **Structured data fields echoed as message content**: The AI would sometimes return data collection field values (e.g., `"Cidade: IBITINGA"`, `"Estado: SP"`) inside the `message` property instead of keeping them as separate structured JSON fields. Strengthened the response format instructions, JSON schema descriptions, and batch prompt builder across all response paths (single-step, batch, and streaming) to explicitly separate user-facing message content from extracted data.

- **Premature route completion**: Routes were ending prematurely (skipping steps) if all required fields were collected, tracking `isComplete()` instead of following the step flow to `END_ROUTE`. Required fields now act only as validation gates, not completion triggers, allowing conversational step chains to complete properly.

- **Pre-extraction extracting from context**: The data pre-extraction flow (which checks if the user provided required data before running steps) was inappropriately being given the full context (which can include pre-existing system database records, lead info, etc.). This caused the AI to extract data from the system's own context rather than from what the user actually said. The pre-extraction call now only sees the user's message history and an isolated empty object as context.

### Changed

- **Completion prompt defaults**: The default `endStep` prompt changed from `"Summarize what was accomplished and confirm completion based on the conversation history and collected data"` to a natural farewell instruction that prevents data dumping.

- **Response schema `message` descriptions**: All JSON schema definitions for the `message` field now explicitly state it must be a natural, conversational response and must NOT contain field names, raw data, or internal information. This applies to `ResponseEngine`, `BatchPromptBuilder`, and `ResponseModal` batch/completion schemas.

## [1.1.1]

### Added

- **`createSession` function overloading**: `createSession` now accepts either the classic `(sessionId?, metadata?)` signature or a `Partial<SessionState<TData>>` object that is merged with sensible defaults. This allows pre-populating any session fields (data, history, currentRoute, etc.) in a single call.

```typescript
// Classic (unchanged)
const session = createSession<MyData>("session_123", { userId: "u1" });

// New: partial state overload
const session = createSession<MyData>({
  id: "session_123",
  data: { name: "Alice" },
  history: restoredHistory,
});
```

- **`createSessionId` public export**: The `createSessionId()` utility is now exported from the package, allowing consumers to generate unique session IDs without creating a full session object.

### Changed

- **Standardized session ID generation**: All adapters (`MongoAdapter`, `PostgreSQLAdapter`, `PrismaAdapter`, `MemoryAdapter`, `OpenSearchAdapter`) and core classes (`SessionManager`, `BatchExecutor`) now use `createSessionId()` or `createSession()` instead of inline `session_${Date.now()}_${Math.random()...}` patterns. This ensures consistent ID formatting across the codebase.

## [1.1.0]

### Breaking Changes

- **`maxStepsPerBatch` defaults to `1`**: Steps now execute one at a time by default, restoring the classic single-step behavior. Previously, all eligible steps would batch together in a single LLM call, which was confusing when steps had no `collect`/`requires` fields and the entire route would complete in one shot. Set `maxStepsPerBatch` to a higher value or `Infinity` to re-enable batching.

### Added

- **`maxStepsPerBatch` option**: New `AgentOptions` property to control how many steps execute in a single batch. Accepts any positive integer or `Infinity` (default: `1`).
- **`max_steps_reached` stopped reason**: New `StoppedReason` value emitted when a batch stops because it hit the `maxStepsPerBatch` limit.

### Migration from 1.0.x

If you relied on multi-step batching, add `maxStepsPerBatch: Infinity` to your agent options to restore the previous behavior:

```typescript
const agent = new Agent({
  name: "Assistant",
  provider: provider,
  maxStepsPerBatch: Infinity, // Restore v1.0.x batching behavior
});
```

## [1.0.2]

### Fixed

- **Sticky route switching**: Route switching now uses a score margin strategy instead of a loose absolute threshold. The agent stays on the current route unless an alternative scores higher by a configurable margin (`routeSwitchMargin`, default: 15). This prevents unnecessary route flip-flopping on marginal score differences.

- **Dead routing code removal**: Removed `decideRouteFromScores`, `switchThreshold`, `maxCandidates`, `allowRouteSwitch`, and `RoutingDecisionWithRoute` — all were configured but never wired into the actual routing flow.

- **Documentation dead links**: Fixed all broken internal links across docs (wrong relative paths to `examples/`, references to non-existent files like `AGENT.md`, `TOOLS.md`, `PROVIDERS.md`, `PERSISTENCE.md`, `ADAPTERS.md`, `tool-execution.md`, and missing example files).

### Added

- **`routeSwitchMargin` option**: New `AgentOptions` property to configure how much higher an alternative route must score before the agent switches away from the current route. Accepts values 0-100 (default: 15).

## [1.0.1]

### Fixed

- **Step `requires` enforcement**: Steps with `requires` fields that reference uncollected data now correctly block advancement. The agent stays at the current step instead of skipping ahead, and emits a console warning identifying the missing fields and the step that cannot proceed. This applies to both streaming and non-streaming response paths.

- **Dynamic schema generation from `collect` fields**: When no agent-level `schema` is provided, the response schema and data collection prompts are now dynamically generated from the step's `collect` fields (defaulting to `type: "string"` per field). Previously, collect fields were silently ignored if no schema was defined, resulting in no structured extraction.

### Added

- **Agent-level `rules` and `prohibitions`**: `AgentOptions` now accepts `rules` and `prohibitions` arrays (same `Template` type used by routes). These are merged with route-level rules/prohibitions and included in all prompt compositions — single-step, batch, and streaming. See [Agent Rules & Prohibitions](docs/core/agent/rules-and-prohibitions.md) for details.
