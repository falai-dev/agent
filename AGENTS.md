# AGENTS.md

> Project context for AI coding agents working in this repository.

## Project

**@falai/agent** — A conversational state engine for TypeScript where the AI understands, but the code is in control.

- **Version:** 4.x (`4.0.0-alpha.N` until the eval gate passes); check package.json
- **License:** MIT
- **Runtime:** Node 22.12+ or Bun 1.0+. The floor is 22.12, not 22: the CJS build `require()`s
  `@providerkit/core`, which is ESM-only, and `require(esm)` landed in 22.12.
- **Language:** TypeScript 5.3+ (strict mode)
- **Module system:** Dual ESM/CJS (ESM primary). **Every relative import carries an explicit
  `.js` extension**, in `src/`, `tests/` and `examples/` alike — Node's ESM resolver does not guess one, so
  an extensionless specifier compiles fine, emits verbatim and then dies at runtime with
  `ERR_MODULE_NOT_FOUND`. It is invisible to the tests, which bun runs off source. Two things
  hold the line: `tsconfig.json` is on `node16` resolution, so tsc rejects the omission, and
  `bun run build` ends by loading both built entries under real Node.
- **Package manager:** Bun (`bun.lock` present)
- **Published name:** `@falai/agent`, and only that. **The unscoped `falai` cannot be published** —
  npm's typo-squatting guard rejects it with `403 Package name too similar to existing package
  flat`, and that check is on the registry, so no amount of package content changes the answer.
  Don't spend another round trip trying; the scope is the only name.

## Quick Commands

| Task | Command |
|------|---------|
| Install | `bun install` |
| Build (full) | `bun run build` |
| Build ESM only | `bun run build:esm` |
| Load both built entries under Node | `bun run check:dist` |
| Typecheck | `bun run typecheck` |
| Typecheck examples | `bun run typecheck:examples` |
| Lint | `bun run lint` |
| Lint + fix | `bun run lint:fix` |
| Test | `bun test tests/*.test.ts tests/scenarios/*.test.ts` |
| Clean | `bun run clean` |
| Publish current version | `bun run release` |

## Architecture

One model: a **Flow** is a trigger plus an ordered list of steps, and `agent.turn()` is the one entry point. Flows, automations and signals are the same thing here; there is no separate rule or automation primitive.

1. **Agent** — Immutable config: fields, provider, flows, host actions/events/conditions, tools, instructions. One instance serves every session; `context`, `history` and `session` arrive on each `turn()`.
2. **Flow** — `on[]` triggers + `steps[]`. Triggers: `message` (the AI routes here; takes the conversation), `mention` (the AI detects it; reacts beside the conversation, may `extract`), `silence`, `event` (with `after`), or none (the host calls `start`). `repeat`, `anchor`, `while`, `clearOnStart`, `onEnd: 'end' | 'stay' | 'reset'`.
3. **Step** — Five kinds: talk (`prompt` / `collect`), `say` (verbatim, `media`, `once`), `do` (a host action with `with`), `wait` (a duration with `else` = the customer replied, or `{ event, upTo }`), `if` (code fork). Movement is only `then` / `else`: a step id, `'end'`, `{ step, clear }` or `{ flow, input }`.
4. **Field** — Authored once on the agent: `{ type, enum?, description?, ask?, extract?: 'anywhere' | 'asked' }`. A talk step's pending set is `collect − known − at maxAsks`; a step whose fields are known is skipped with no call.
5. **Action / Event / Condition** — Host registries referenced by name from flows and from JSON `FlowSpec` rows. Actions run at-least-once and must be idempotent on `ctx.key`; they return `{ ok } | { skipped } | { failed } | { defer }`.
6. **Tool** — A typed function the AI may call while speaking. Returns `{ value?, data? }`, never movement.
7. **Instruction** — `{ kind: 'must' | 'never' | 'should', when? (AI), if? (code), prompt }` at agent, flow or step level.

### The turn

Eight phases, one order for every input kind (`message`, `wake`, `event`, `start`): Load → Ingest → **Understand** (≤1 call: routing, mentions, branches, extraction in one envelope) → Decide → Run (`advance()`, code) → **Speak** (≤1 call + tool rounds) → Settle (the one applier) → Return. A text turn costs at most two model calls; `TurnResult.llmCalls` says how many it spent. The framework never sends, sleeps or saves: the host saves the session with the version it loaded, then sends `messages[]` and enqueues `schedule[]`.

### Key Design Principles

- **AI handles language, code handles decisions.** Routing, extraction, phrasing → the model. Eligibility, pending fields, movement, waits, claims → code.
- **Schema-first:** fields live on the agent, not on flows. `falai<C>().fields(defs)` binds the data type for every `collect`, `ask`, `clearOnStart` and `ctx.set`.
- **`when`/`if` split:** `when` is an AI-judged string (costs tokens, only where fresh customer text exists), `if` is a code predicate or its JSON form (`{ equals, known, silenced, <condition>: arg }`), free.
- **Deterministic keys:** `runId = ${flowId}#${triggerKey}`, message/action `key = ${runId}:${stepId}:${visit}`, wake `key = ${runId}:${stepId}:${atMs}`. A replay of the same input mints the same keys.
- **Pure core:** no I/O beyond the provider and the host's `do` handlers. Tests inject `clock` and a scripted provider.
- **The stored flow is the framework's JSON:** `FlowSpec` (flat steps with `kind`) ↔ `Flow` via `fromSpec` / `toSpec`; `validateFlow` at agent build; `flowSpecSchema` for a model that writes flows.

## Source Layout

```
src/
├── core/
│   ├── Agent.ts         # the shell: validation, registries, turn() / turnStream()
│   ├── falai.ts         # falai<C>().fields(...) toolkit: fields, flow, fromSpec, action, event, condition, agent
│   ├── Runner.ts        # phases in code: ingest, decide, advance(), settle; runs, floor, claims, waits
│   ├── Understand.ts    # the one judging call (schemaName 'understand')
│   ├── Speak.ts         # the one phrasing call + tool rounds (schemaName 'speak'), streaming
│   ├── Prompt.ts        # prompt sections shared by both calls
│   ├── contracts.ts     # the seams: UnderstandRequest/Understanding, SpeakRequest/SpeakOutcome
│   ├── FlowSpec.ts      # JSON form, fromSpec/toSpec, validateFlow, flowSpecSchema
│   ├── Migrate.ts       # assertSession (v4 shape check), migrateSession (3.x blob → v4), InvalidSessionError
│   └── CompactionEngine.ts, PromptSectionCache.ts
├── persistence/         # Store implementations: Memory, Postgres, Prisma, Redis, Mongo, SQLite, OpenSearch
├── providers/           # LLM adapters over @providerkit/core: Gemini, OpenAI, Anthropic, OpenRouter, DeepSeek, Z.ai
├── types/               # flow, session, agent, tool, ai, history, schema, errors
├── utils/               # schema (pending/coerce/wire), template, duration, clock, history, json, logger
└── index.ts             # Public API surface (all exports)
```

- `tests/` — Bun test files (`*.test.ts`); `tests/mock-provider.ts` scripts replies per `schemaName`; `tests/fixtures/blobs/` holds anonymised 3.x sessions.
- `examples/` — Runnable TypeScript examples (01-09), typechecked by `bun run typecheck:examples`.
- `docs/` — concepts, guides, reference, start, migration; `docs/rfc/v4-one-flow.md` is the design record.

## Type System

- Two generics thread everywhere: `C` (ambient host context, passed on every turn) and `D` (the data collected across all flows).
- `falai<C>()` is the only explicit generic an app writes. `.fields(defs)` binds `D`; `type Data = DataOf<typeof f>`. Action, event and condition names inside flows are strings, checked at agent construction (the same path a JSON `FlowSpec` takes).
- `Condition.check` and `Action.run` are method signatures on purpose: method bivariance lets a heterogeneous registry type without `any`.
- `StructuredSchema` is the JSON-schema-like wire type; `toWireSchema(defs, { nullable })` is the only way field or parameter definitions reach a provider (it strips `ask`, `extract`, `optional`).
- All public types are re-exported from `src/types/index.ts` → `src/index.ts`.

## Providers

All providers implement the `AiProvider` interface:

- `GeminiProvider` — Google Gemini (`@google/genai`)
- `OpenAIProvider` — OpenAI (`openai` SDK)
- `AnthropicProvider` — Anthropic (`@anthropic-ai/sdk`)
- `OpenRouterProvider` — OpenRouter (OpenAI-compatible)
- `ZaiProvider` — Z.ai Coding Plan (Anthropic-compatible; the flat-rate plan hosting GLM — bare model ids, explicit no-thinking marker)

## Persistence

`Store<D> { load(id); save(session, expectedVersion) }`: `0` inserts if absent, a stale version throws `SessionConflictError`, and the saved session comes back with its bumped version. Seven implementations in `src/persistence/`, all optional peer dependencies except `MemoryStore`. They persist the v4 blob and a version, nothing else. The framework never calls a store.

## Testing

- **Runner:** Bun's built-in test runner (`bun test tests/*.test.ts`).
- **Mock provider:** `tests/mock-provider.ts` — `mockProvider({ understand: [...], speak: [...] })` shifts scripted replies per `parameters.schemaName` and records `.calls`; it throws when a script runs dry, so a test that spends an extra model call fails loudly.
- **Clock:** pass `clock` to the agent; never read `Date.now()` in core code.
- **Property tests:** files ending in `.property.test.ts` use `fast-check`.
- **Scenarios:** `tests/scenarios/s01…s13` play the design's walkthroughs end to end and assert `llmCalls`, message keys and outcome `detail` strings.
- **Strict schemas:** `tests/helpers.ts` has `isStrictSchema`; every envelope the framework sends must pass it.

## Coding Conventions

- **Strict TypeScript** — `strict: true`, no implicit any, no unused locals/params, no implicit returns.
- **No `as any`** — Fix the underlying type mismatch. Tests may use `as unknown as T` with justification.
- **ESLint** — `@typescript-eslint/recommended-type-checked` rules. `no-floating-promises: error`, `no-explicit-any: warn`.
- **Error format:** `[ErrorClass] what: why. how to fix.` — typed error classes (`FlowConfigurationError`, `ToolCreationError`, `ToolExecutionError`, `SessionConflictError`, `InvalidSessionError`).
- **Naming:** Classes are PascalCase, files match their default export. Utilities are camelCase.
- **Exports:** Everything public goes through `src/index.ts`. No deep imports from consumers.
- **No path aliases.** `tsconfig.json` used to declare six (`@core/*`, `@utils/*`, one of them
  `@types/*`, which shadowed the real scope); nothing in `src`, `tests` or `examples` imported a
  single one, and under `node16` resolution they pointed at extensionless targets. Removed —
  relative imports only, each with its `.js` extension.
- **Logging:** Uses `loglevel` library. Debug logging gated by `debug: true` on agent options.

## Key Patterns

- `falai<C>().fields(defs).agent(options)` builds the agent; `f.flow`, `f.fromSpec`, `f.action`, `f.event`, `f.condition` give typed values.
- `agent.turn(input)` for every input kind; `agent.turnStream(input)` yields `{ delta }` chunks then `{ done, result }`.
- The host loop: `load` → `turn` → if `changed`, `save(session, loadedVersion)` → send `messages[]` (honouring `afterMs`, keyed) → enqueue `schedule[]` with `jobId = key` → at fire time `turn({ wake: key })`.
- `silenced: 'reason'` is the one gate: `do` steps still run, nothing is phrased, zero calls.
- Outcome `detail` strings are pt-BR (`campo pulado: perguntado 3 vezes`, `IA indisponível`); prompt scaffolding is English.
- `migrateSession(blob, { sessionId, flowIdOf })` at the host's deserialisation choke point; it throws on garbage.

## What NOT to Do

- Don't add per-flow schemas — fields live on the agent.
- Don't introduce implicit messaging — the framework never speaks unless a talk step, a `say` or the `idle` speaker does.
- Don't bring back a Directive, `dispatch`, signals or a router primitive — movement is `then` / `else`, signals are `mention` flows, routing is the understand phase.
- Don't rebuild the Agent per turn — one instance, per-turn inputs.
- Don't do I/O in core code beyond the provider and `do` handlers — no timers, no persistence, no `Date.now()`.
- Don't use deprecated aliases or compatibility shims — prefer clean breaks.
- Don't add abstractions beyond what the task requires — KISS and modularity first.
