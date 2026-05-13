# Changelog

All notable changes to `@falai/agent` will be documented in this file.

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
