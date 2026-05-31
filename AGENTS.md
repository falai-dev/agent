# AGENTS.md

> Project context for AI coding agents working in this repository.

## Project

**@falai/agent** — A conversational state engine for TypeScript where the AI understands, but the code is in control.

- **Version:** 2.x, check package.json for more details
- **License:** MIT
- **Runtime:** Node 18+ or Bun 1.0+
- **Language:** TypeScript 5.3+ (strict mode)
- **Module system:** Dual ESM/CJS (ESM primary)
- **Package manager:** Bun (`bun.lock` present)

## Quick Commands

| Task | Command |
|------|---------|
| Install | `bun install` |
| Build (full) | `bun run build` |
| Build ESM only | `bun run build:esm` |
| Typecheck | `bun run typecheck` |
| Typecheck examples | `bun run typecheck:examples` |
| Lint | `bun run lint` |
| Lint + fix | `bun run lint:fix` |
| Test | `bun test tests/*.test.ts` |
| Clean | `bun run clean` |
| Publish current version | `bun run release` |

## Architecture

Six primitives compose the entire framework:

1. **Agent** — Top-level object. Binds schema, provider, flows, tools, signals, persistence. One agent serves many conversations.
2. **Flow** — A conversational goal (ordered steps + completion semantics). Declares `requiredFields` from the shared schema.
3. **Step** — One node inside a flow. Three shapes: LLM step (`prompt`), auto step (`auto: true`), reply step (`reply`).
4. **Tool** — A typed function the AI can call. Returns values, state writes, or directives.
5. **Instruction** — Behavioral statement with `kind: 'must' | 'never' | 'should'` and optional activation conditions.
6. **Directive** — Flat object literal returned from tools/hooks to redirect control flow, write state, or speak verbatim.

### Key Design Principles

- **Schema-first:** `TData` is agent-level, not flow-level. One schema describes everything collectable across all flows.
- **AI handles language, code handles decisions.** Routing, extraction, generation → AI. Completion gates, branches, merges → deterministic code.
- **`when`/`if` split:** `when` = AI-evaluated string (costs tokens). `if` = code predicate (free). When both set, `if` short-circuits.
- **Directive bus:** Multiple directives per turn are merged via `flow.merge()` — position by precedence, state shallow-merged, reply last-wins.

## Source Layout

```
src/
├── core/           # Agent, Flow, Step, ResponsePipeline, SessionManager, etc.
├── providers/      # LLM adapters: Gemini, OpenAI, Anthropic, OpenRouter
├── adapters/       # Persistence: Prisma, Redis, Mongo, PostgreSQL, SQLite, OpenSearch, Memory
├── types/          # All type definitions (agent, flow, tool, signals, persistence, etc.)
├── utils/          # Helpers: id generation, history, conditions, templates, logging
├── constants/      # Shared constants
└── index.ts        # Public API surface (all exports)
```

- `tests/` — Bun test files (`*.test.ts`). Some use property-based testing via `fast-check`.
- `examples/` — Runnable TypeScript examples (01-09).
- `docs/` — Markdown documentation: concepts, guides, reference, start, migration.

## Type System

- Two generic parameters thread everywhere: `TContext` (ambient app data) and `TData` (collected schema data).
- Types are inferred from `createAgent()` call — schema flows through every `collect`, `requires`, tool handler, etc.
- `StructuredSchema` is JSON Schema-like definition for `TData`.
- All public types are re-exported from `src/types/index.ts` → `src/index.ts`.

## Providers

All providers implement the `AiProvider` interface:

- `GeminiProvider` — Google Gemini (`@google/genai`)
- `OpenAIProvider` — OpenAI (`openai` SDK)
- `AnthropicProvider` — Anthropic (`@anthropic-ai/sdk`)
- `OpenRouterProvider` — OpenRouter (OpenAI-compatible)

## Persistence Adapters

All implement `PersistenceAdapter` interface. All are optional peer dependencies:

- `MemoryAdapter` (built-in, no deps)
- `PrismaAdapter`, `RedisAdapter`, `MongoAdapter`, `PostgreSQLAdapter`, `SQLiteAdapter`, `OpenSearchAdapter`

## Testing

- **Runner:** Bun's built-in test runner (`bun test`)
- **Pattern:** `tests/*.test.ts` — unit and integration tests
- **Property tests:** Files ending in `.property.test.ts` use `fast-check`
- **Mock provider:** `tests/mock-provider.ts` provides a deterministic `AiProvider` for tests

## Coding Conventions

- **Strict TypeScript** — `strict: true`, no implicit any, no unused locals/params, no implicit returns.
- **No `as any`** — Fix the underlying type mismatch. Tests may use `as unknown as T` with justification.
- **ESLint** — `@typescript-eslint/recommended-type-checked` rules. `no-floating-promises: error`, `no-explicit-any: warn`.
- **Error format:** `[ErrorClass] what: why. how to fix.` — typed error classes (`FlowConfigurationError`, `ToolCreationError`, `ToolExecutionError`, `NotImplementedError`).
- **Naming:** Classes are PascalCase, files match their default export. Utilities are camelCase.
- **Exports:** Everything public goes through `src/index.ts`. No deep imports from consumers.
- **Path aliases:** `@/types`, `@core/*`, `@/providers/*`, `@utils/*`, `@/constants` (tsconfig paths).
- **Logging:** Uses `loglevel` library. Debug logging gated by `debug: true` on agent options.

## Key Patterns

- `createAgent(options)` is the recommended entry point (over `new Agent()`).
- `agent.respond(message)` for synchronous turns; `agent.respondStream(message)` for streaming.
- `agent.dispatch(directive, session)` for out-of-turn redirection (webhooks, cron, UI).
- Directives are plain object literals — no builders, no classes. Validated via `flow.validate()`.
- Steps with `auto: true` execute without an LLM call (pure computation via hooks/branches).
- `flow.merge(a, b)` is the canonical merge algorithm for combining directives.

## What NOT to Do

- Don't add per-flow schemas — the architecture is explicitly schema-at-agent-level.
- Don't introduce implicit messaging — the framework never speaks unless a step or directive says so.
- Don't create a separate "router" primitive — flow selection is an internal pipeline phase.
- Don't use deprecated aliases or compatibility shims — prefer clean breaks.
- Don't add abstractions beyond what the task requires — KISS and modularity first.
