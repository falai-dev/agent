---
title: "Agent architecture"
description: "The seven words the rest of the docs use, and the line between what the model decides and what the code decides."
type: concept
order: 1
---

# Agent architecture

The AI understands. The code is in control.

@falai/agent runs a conversation as a set of small programs called flows. The model has two jobs: read what the customer wrote, and phrase what the assistant says. Every other decision is code: which flow runs, which step comes next, which field is still missing, how long to wait, what to send and when.

## The words

These seven words are the whole design. The rest of the docs use them without explaining them again.

| Word | What it is | Where it lives |
|---|---|---|
| **Agent** | The configuration: fields, flows, provider, registries. One instance serves every session. | `f.agent(options)` returns an `Agent` |
| **Flow** | A trigger plus an ordered list of steps. | `Flow`, built with `f.flow()` |
| **Trigger** | When a run of the flow starts: `message`, `mention`, `silence`, `event`, or none (the host starts it). | `Trigger`, in `flow.on[]` |
| **Step** | One thing the run does: the model talks (`prompt` / `collect`), a fixed text goes out (`say`), the host does something (`do`), the run parks (`wait`), the code forks (`if`). | `Step`, in `flow.steps[]` |
| **Field** | One piece of data to collect, authored once on the agent with its own `ask`. | `FieldDef`, in `falai().fields()` |
| **Run** | One live execution of a flow inside a session. A session holds many runs; at most one is asking. That run holds the floor: the next message is read as its answer. | `Run`, in `session.runs[]` |
| **Turn** | One call to `agent.turn(input)`: something happened, here is what to send and when to wake up. | `TurnInput` in, `TurnResult` out |

Four registries live on the agent. Instructions are written inline, wherever they apply. Flows name registry entries as strings, and the names are checked when the agent is built.

| On the agent | What it holds | Named from |
|---|---|---|
| `actions` | Host code a `do` step runs. Returns `{ ok }`, `{ skipped }`, `{ failed }` or `{ defer }`. | `do: 'notify'` |
| `events` | Host events a trigger or a `wait` may name, each with an optional `direction`. | `on: [{ event: 'stage_entered' }]`, `wait: { event: 'meeting_booked' }` |
| `conditions` | Host predicates a JSON `if` may name, with an argument. | `if: { tagsAny: ['vip'] }` |
| `tools` | Typed functions the model may call while it speaks. They return `{ value?, data? }`, never movement. | `tools: ['checkAvailability']` on a step or a flow |
| `instructions` | Rules the prompt carries while they apply: `must`, `never`, `should`. | Not named: written inline where they apply, on the agent, a flow, a step, or the idle speaker |

The **host** is your program: the one that receives a message from the channel, loads the session, calls `turn()`, saves, sends and schedules. The framework does none of those.

## How they fit

```text
Agent (immutable, one instance for every session)
├── fields        nome, empresa, confirmado, …        authored once, typed
├── flows[]       Flow = on[] (triggers) + steps[]
│                   step: talk | say | do | wait | if
│                   movement: then / else → step id | 'end' | { step, clear } | { flow, input }
├── actions       do: 'notify'              ┐
├── events        event: 'meeting_booked'   │  host registries,
├── conditions    if: { inStage: 'x' }      │  referenced by name
├── tools         the model may call these  ┘
├── instructions  must / never / should
├── idle          speaks when no run holds the floor ('silent' mutes it)
└── provider      talks to the model

Session (one per conversation; the host saves it)
├── data          the collected fields, in any order
├── runs[]        live runs: running | asking | waiting | suspended
├── claims        which flows already ran here, so repeat: 'once' and cooldowns hold
└── inputs        the last 50 input ids, for replays

turn(input) ── message | wake | event | start ──▶ TurnResult
                                                  session, changed, messages[], schedule[], llmCalls, …
```

## The two model calls

The model gets at most two calls per turn, and each has one job.

- **The understand call** reads the customer's message. It scores the candidate flows from 0 to 100, says which things the customer brought up, answers the `when` questions of the asking step, and extracts any field values the message carries. It never moves a run.
- **The speak call** phrases the assistant's reply for one talk step (or for the idle speaker) and extracts the fields that step is still collecting. It may call tools in rounds. It never moves a run either.

Everything else is code, in `src/core/Runner.ts`: which flows are eligible, which run holds the floor, which fields are pending, which step comes next, how long a wait is, what key a message gets, when a claim (a record that this flow already ran) blocks a start, what the result says. Code behaves the same on a replay; the model does not. So nothing the model says is applied before code checks it: unknown fields are dropped, values are coerced to the field's type, `enum` membership is enforced.

Two things follow. A flow with no talk steps costs zero model calls. And every result carries `llmCalls`, so a test asserts the budget instead of trusting it. [The turn pipeline](./pipeline.md) walks the eight phases and what each one spends.

## One agent, every session

An `Agent` is immutable configuration. Build it once and keep it for the life of the process. It holds no session, no context and no history of its own; those arrive on every `turn()`.

```ts
import type { Agent } from "@falai/agent";
declare const agent: Agent;

const r = await agent.turn({ sessionId: "demo", message: "oi" });
console.log(r.llmCalls); // 1: one flow, nothing to judge, one speak call
```

Here is the agent that call ran against:

```ts
import { falai } from "@falai/agent";
import type { AiProvider } from "@falai/agent";

declare const provider: AiProvider;

const f = falai().fields({
  nome: { type: "string", ask: "Pergunte o nome da pessoa, sem tom de formulário." },
});

const agent = f.agent({
  name: "Ana",
  provider,
  flows: [
    f.flow({
      id: "boas-vindas",
      name: "Boas-vindas",
      on: [{ message: [] }],
      steps: [{ id: "nome", collect: ["nome"] }],
    }),
  ],
});

export { agent };
```

The constructor checks the configuration before any turn runs: duplicate flow ids; every field, action, event, condition, tool and step id a flow names; the `with` of each `do` step against the action's parameters; the idle speaker's tool names. A bad name throws `FlowConfigurationError` when the agent is built, not on the turn that first reaches it.

Per turn, the host passes what only it knows:

| Input | What it is |
|---|---|
| `sessionId`, `session?` | The session the host loaded, or nothing on a first turn. A wake never creates a session. |
| `context` | Your own data for this turn: the customer, the tenant, whatever your flows read. Typed by `falai<C>()`. Templates read it as `{{context.x}}`; predicates, actions and tools as `ctx.context`. |
| `history` | The conversation before this input. Pass it on every input kind, wakes included; both calls read it. Leave out the message this turn carries: both calls quote it on their own, so a history that ends with it is read twice. |
| `silenced?` | Why the assistant cannot speak right now. `do` steps still run, nothing is phrased, zero calls — unless you pass `{ reason, understand: true }`, which still spends the understand call. |
| `anchors?`, `claims?` | Host keys and claims from the customer's other sessions, for flows that run once per customer instead of once per session (see [Anchors](./runs-and-waits.md#anchors)). |

Then one of four input kinds: `{ message, id?, at? }`, `{ wake }`, `{ event, payload?, key }` or `{ start: { flow, input?, key } }`. [Agent](../reference/agent.md) lists every field.

## Never sends, never sleeps, never saves

`turn()` does no I/O except the provider, your `do` handlers and the tools the model calls. It does not send a message, set a timer, read a clock you did not give it, or touch a store. It returns a plan:

| Result | What the host does with it |
|---|---|
| `changed: false` | Nothing. Save nothing, send nothing. |
| `session` | Save it with the version you loaded: `store.save(session, loadedVersion)`. A stale version throws `SessionConflictError`; discard everything and replay the same input. |
| `messages[]` | Send each one, honouring `afterMs`, keyed by `key` so a retry never sends twice. |
| `schedule[]` | Enqueue each wake with the key in the payload and `encodeURIComponent(key)` as the job id: BullMQ refuses a `:` in a custom id. When it fires, call `turn({ wake: key })`. |
| `outcomes`, `started`, `ended`, `skipped` | Your execution log. |

The order matters: save first, then send and schedule. A message that leaves before the save is sent twice when the save loses a race; a message that leaves after it is not. The one exception is `do` handlers and tool handlers: they run inside the turn, before the save, so they run at least once and must be idempotent on `ctx.key`. [Runs and waits](./runs-and-waits.md#five-rules-that-always-hold) lists the five rules it rests on.

Time comes from `clock` on the agent (default: the system time), so a test passes `fakeClock()` and moves it by hand. Core code never reads `Date.now()`.

## Where next

- [The turn pipeline](./pipeline.md): the eight phases and what each one costs.
- [Runs and waits](./runs-and-waits.md): the floor, waits, wakes, keys, claims.
- [Field collection](./collection.md): pending fields, `ask`, `extract`, `maxAsks`.
- [Your first agent](../start/02-first-agent.md): the same words, one file at a time.
