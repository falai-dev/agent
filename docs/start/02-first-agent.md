---
title: "Your first agent"
description: "Build a 16-line agent that responds to a user message, and meet the seven primitives that shape every @falai/agent program."
type: tutorial
order: 2
---

# Your first agent

You are about to write an agent that fits on one screen. One schema, one flow, one step, one turn — and from it the full mental model unfolds. The framework's seven primitives all participate in this single call, even though only three appear as syntax. The page names all seven so the rest of the tutorial can reference them without introduction.

This page builds the smallest agent that does real work — sixteen lines of TypeScript, one `respond` call, one greeting back from the model. The point is not the greeting. The point is to put every primitive of the framework on the page at once, in the smallest possible shape, so the rest of the tutorial extends a scaffold you can already read in full.

By the end of this page you will have a runnable file, an expected output, and a working mental map of the [seven primitives](../concepts/architecture.md). The next page extends this same file into a data-collecting agent.

Keep [Install](./01-install.md) finished and your `GEMINI_API_KEY` ready in `.env` before you continue.

## The whole agent

Drop this into `src/index.ts`:

```typescript
import { createAgent, GeminiProvider } from "@falai/agent";

const agent = createAgent({
  provider: new GeminiProvider({ apiKey: process.env.GEMINI_API_KEY! }),
  schema: { type: "object", properties: { name: { type: "string" } } },
  flows: [{
    title: "Greet",
    requiredFields: ["name"],
    steps: [{ id: "ask_name", prompt: "What's your name?", collect: ["name"] }],
  }],
});

const response = await agent.respond("Hi, I'm Alice");
console.log(response.message);
```

That is the whole program. No persistence config, no tools, no branches, no signals. Three primitives appear by name (`Agent`, `Flow`, `Step`) and four more sit one decision away (`Tool`, `Instruction`, `Directive`, `PreDirective`). The next sections walk through every line.

## Walk it line by line

### Imports

```typescript
import { createAgent, GeminiProvider } from "@falai/agent";
```

`createAgent` is the level-1 factory — sugar over `new Agent(options)` — and the recommended construction path for application code. Its signature and full options surface live in the [`createAgent` reference](../reference/create-agent.md).

`GeminiProvider` is one of four built-in [providers](../reference/providers.md). Swap to `OpenAIProvider`, `AnthropicProvider`, or `OpenRouterProvider` by changing this single import — the agent itself stays vendor-agnostic.

### `createAgent({ ... })`

```typescript
const agent = createAgent({ /* ... */ });
```

`createAgent` accepts one options object. Generic inference flows from `schema` through every `flows[].steps[].collect` reference, so the type of `session.data` and tool-handler arguments is derived once and propagates everywhere. Misuse — duplicate flow ids, an unknown key in `collect`, a malformed signal — surfaces as `FlowConfigurationError` synchronously, before any turn runs.

### `provider`

```typescript
provider: new GeminiProvider({ apiKey: process.env.GEMINI_API_KEY! }),
```

The provider is the strategy plug between the agent and the model vendor. Every provider implements the same `AiProvider` interface, so the agent talks to Gemini today and to a different vendor tomorrow with one line changed. See [Providers](../reference/providers.md) for the full options surface — `model`, `backupModels`, `config`, `retryConfig`.

### `schema`

```typescript
schema: { type: "object", properties: { name: { type: "string" } } },
```

The schema is the single source of truth for `TData` — the typed shape of everything the agent collects across the whole conversation. It lives at the agent level, not the flow level. Every `collect` site in every step references keys defined here, and TypeScript verifies the references at compile time.

This shape is why pre-extraction works: when a user message arrives, the engine extracts every collectable field it can in one pass, then skips any step whose `collect` set is already satisfied. The next tutorial page leans on this property hard. For the framing, see [the schema-first principle](../concepts/architecture.md#the-schema-first-principle).

### `flows`

```typescript
flows: [{
  title: "Greet",
  requiredFields: ["name"],
  steps: [/* ... */],
}],
```

A [`Flow`](../reference/flow.md) is one conversational goal — booking a hotel, escalating a complaint, greeting a stranger. The router selects exactly one flow per turn. This agent has only one flow, so the router has nothing to choose between; later tutorials add more.

`title` is the human-readable name (also used in the `Directive.goTo` shorthand). `requiredFields` declares which schema keys must be present in `session.data` before the engine fires the flow's completion path. The greeter's only required field is `name`.

### Step `prompt` and `collect`

```typescript
steps: [{ id: "ask_name", prompt: "What's your name?", collect: ["name"] }],
```

A [`Step`](../reference/step.md) is a single node inside a flow. This step has the simplest LLM-step shape: an `id` for routing and logs, a `prompt` that becomes the engine's instruction to the model, and a `collect` set that names the schema fields this step is responsible for extracting from the user message.

When the user writes `"Hi, I'm Alice"`, the engine routes into `Greet`, lands on `ask_name`, runs pre-extraction against the schema, and lifts `name: "Alice"` into `session.data`. The step's `collect` set is now satisfied — and because `name` is the flow's only `requiredField`, the flow is complete on this very turn.

### `requiredFields`

```typescript
requiredFields: ["name"],
```

`requiredFields` is the completion gate. The flow is **done** the moment every key in this array is present in `session.data`. Completion is a state transition, not a message — the framework never speaks on its own. Anything the user reads at completion comes from the model's response on the same turn or from a `reply` step on the next turn.

For this agent, completion happens on the first turn. For a longer flow, the gate would force more steps before the model wraps up.

### `agent.respond(message)`

```typescript
const response = await agent.respond("Hi, I'm Alice");
console.log(response.message);
```

`respond(message)` runs one turn end to end: load (or create) the session, route to a flow, extract data, walk auto-step chains, call the LLM, deliver the assistant message, persist. It returns an `AgentResponse` with the fields you usually want on hand:

| Field | Type | What it is |
|-------|------|------------|
| `message` | `string` | The assistant's reply for this turn. |
| `session` | `SessionState<TData>` | The updated session — including `session.data` with the extracted fields. |
| `isFlowComplete` | `boolean` | `true` once `requiredFields` are all satisfied. |
| `appliedInstructions` | `AppliedInstruction[]` | Instructions that rendered into this turn's prompt (deterministic, not self-reported). |
| `triggeredSignals` | `SignalFiring[]` | Any signals that fired this turn. |

`response.message` is the only field this minimal program reads. The rest become useful as the agent grows.

## The seven primitives

Three primitives appear by name in the code above: [`Agent`](../concepts/architecture.md#agent), [`Flow`](../concepts/architecture.md#flow), and [`Step`](../concepts/architecture.md#step). Four more shape every program of any size, and you will meet them in the pages ahead:

- [`Agent`](../concepts/architecture.md#agent) — the top-level handle. Owns the schema, provider, flows, tools, signals, and persistence.
- [`Flow`](../concepts/architecture.md#flow) — one conversational goal. Owns its steps, scoped tools, instructions, and completion semantics.
- [`Step`](../concepts/architecture.md#step) — one node inside a flow. Asks a question, collects fields, calls tools, runs hooks, or speaks a verbatim line.
- [`Tool`](../concepts/architecture.md#tool) — a typed function the AI can call. May redirect the conversation by emitting a directive. Added on page [04](./04-add-tools.md).
- [`Instruction`](../concepts/architecture.md#instruction) — a `must` / `never` / `should` behavioral statement at agent, flow, or step scope.
- [`Directive`](../concepts/architecture.md#directive) — a flat object any tool, hook, or branch returns to write state, change position, or speak verbatim.
- [`PreDirective`](../concepts/architecture.md#predirective) — a `Directive` plus per-turn shaping (`appendPrompt`, `injectTools`, `halt`) returned from `onEnter` and `prepare` hooks.

Read [Architecture](../concepts/architecture.md) end to end when you want the full mental model — what each primitive owns, how they reference each other, and why the set is exactly seven.

## Run it

Make sure `.env` has `GEMINI_API_KEY` set, then run the file:

```bash
bun run src/index.ts
```

Or with Node 20+:

```bash
node --env-file=.env --experimental-strip-types src/index.ts
```

You should see a single line of greeting prose, something like:

```
Hi Alice, nice to meet you! How can I help today?
```

The exact words come from the model — they will not match across runs — but the shape is stable: one assistant message, addressed to Alice by name, written in the tone the model defaults to. If the call fails, double-check that `GEMINI_API_KEY` is exported and that your `.env` is being loaded (Bun loads it automatically; Node needs `--env-file`).

## What just happened

In one turn, the engine:

1. Created a fresh session keyed by an auto-generated id (the default `MemoryAdapter` keeps it in process).
2. Ran the flow router. With one flow on the agent, `Greet` wins by default.
3. Pre-extracted `name: "Alice"` from the user message in a single pass against the schema, before any step ran.
4. Skipped `ask_name` because its `collect` set was already satisfied — the engine never re-asks for data it already has.
5. Called the LLM once with the active prompt, the typed `session.data`, and the conversation history.
6. Returned the assistant message with `isFlowComplete: true` because `requiredFields` were already met.

This sequence — pre-extract, then skip-then-execute, then check completion — is the [turn pipeline](../concepts/pipeline.md), and it runs on every `respond` call regardless of flow size.

## When something goes wrong

A few common failure modes and where to look:

- **`Missing API key`** or a 401 from Gemini — `GEMINI_API_KEY` is unset or your `.env` did not load. Bun loads `.env` automatically; Node needs `--env-file=.env`.
- **`FlowConfigurationError: collect references unknown key 'foo'`** — the schema does not declare `foo` as a property. Add it to `schema.properties` or fix the `collect` array.
- **`FlowConfigurationError: duplicate flow id` / `duplicate step id`** — two flows or two steps share the same auto-derived id. Set explicit `id` values to disambiguate.
- **The LLM call hangs** — check the `model` (Gemini's free tier expects `"models/gemini-2.5-pro"` or `"models/gemini-2.5-flash"`) and your network. Provider errors surface as `ResponseGenerationError`.

The full set of typed errors and the `[<ErrorClass>] <what>: <why>. <how to fix>.` format contract live in the [Errors reference](../reference/errors.md).

## Where this leaves you

You have a runnable agent, an expected-shape output, and the names of every primitive that will appear in the rest of the tutorial. The next page swaps the trivial `name` schema for a structured booking schema and three steps that each `collect` one field. The same single message — *"I want a hotel in Lisbon for two people next Friday"* — populates all three fields at once and lands the agent on the confirmation step on the first turn.

**Next:** [Collect data](./03-collect-data.md)
