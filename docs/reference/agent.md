---
title: "Agent"
description: "How to build an agent with falai(), every AgentOptions field, and what turn() takes and returns."
type: reference
order: 1
---

# Agent

An `Agent` is immutable configuration plus one method, `turn()`. You build it once with `falai<C>().fields(...).agent(...)`; the same instance serves every session. Each call to `turn()` brings its own `sessionId`, `session`, `context` and `history`, and returns the messages to send, the wakes to schedule and the session to save. The framework never sends, never sleeps and never saves. The program that does those three things is the host.

A turn spends at most two model calls: the understand call, which routes the message and pulls values out of it, and the speak call, which phrases the reply.

## Signature

```ts fragment
function falai<C = undefined>(): FalaiRoot<C>;

interface FalaiRoot<C> {
  fields<const F extends FieldDefs>(defs: F): Falai<C, InferData<F>, F>;
  // plus every Falai method below, with loose data (any slug is a string)
}

interface Falai<C, D, F extends FieldDefs> {
  readonly fields: F;
  action<const P extends ParamDefs>(def: {
    description?: string;
    parameters: P;
    run(params: InferParams<P>, ctx: ActionCtx<C, D>): ActionResult | Promise<ActionResult>;
  }): Action<C, D, InferParams<P>>;
  event<P = undefined>(def?: { direction?: "inbound" | "outbound" }): EventDef<P>;
  condition<Arg>(check: (ctx: PredCtx<C, D>, arg: Arg) => boolean): Condition<C, D, Arg>;
  flow(def: Flow<C, D>): Flow<C, D>;
  fromSpec(spec: FlowSpec): Flow<C, D>;
  agent(options: Omit<AgentOptions<C, D>, "fields">): Agent<C, D>;
}

type DataOf<T extends { fields: FieldDefs }> = InferData<T["fields"]>;

class Agent<C, D> {
  constructor(readonly options: AgentOptions<C, D>);
  turn(input: TurnInput<C, D>): Promise<TurnResult<D>>;
  turnStream(input: TurnInput<C, D>): AsyncIterable<TurnStreamChunk<D>>;
}
```

## The toolkit

`falai<C>()` takes one generic: the type of the `context` your host passes on every turn. `falai()` alone means no context. Everything else is inferred from values.

| Method | Returns | What it does |
|---|---|---|
| `fields(defs)` | `Falai<C, D, F>` | Binds the collected-data type `D`. Every `collect`, `ask`, `clearOnStart`, `equals`, `known` and action `ctx.set` downstream is checked against these slugs. |
| `fields` (property) | `F` | The definitions you passed, unchanged. `DataOf<typeof f>` reads the data type from it. |
| `flow(def)` | `Flow<C, D>` | Returns the flow unchanged, typed. See [Flow](flow.md). |
| `fromSpec(spec)` | `Flow<C, D>` | A stored JSON flow as a typed flow. Validated when the agent is built. See [Flow spec](flow-spec.md). |
| `action(def)` | `Action<C, D, P>` | A host action. `params` inside `run` is typed from `parameters`. |
| `event<P>(def?)` | `EventDef<P>` | A host event; `P` is its payload type. `direction` says whether it counts as the customer or the assistant speaking. |
| `condition(check)` | `Condition<C, D, Arg>` | A named code predicate that JSON flows may use by name. |
| `agent(options)` | `Agent<C, D>` | Builds the agent. `fields` comes from the toolkit; you pass everything else. |

`Agent` is also exported directly: `new Agent(options)` takes the same options with `fields` included.

## AgentOptions

| Field | Type | Default | Meaning |
|---|---|---|---|
| `name` | `string` | required | The assistant's name. Both model calls open with "You are `name`". |
| `goal` | `Template` | none | What the agent is for. Rendered into the prompt. |
| `persona` | `Template` | none | Who the agent is and how it talks. |
| `provider` | `AiProvider` | required | The model. See [Providers](providers.md). |
| `fields` | `FieldDefs` | from the toolkit | Every collectable field, authored once. See [Fields](fields.md). |
| `flows` | `Flow<C, D>[]` | `[]` | The flows. Ids must be unique. |
| `actions` | `ActionMap<C, D>` | `{}` | Host actions that `do` steps name. |
| `events` | `EventMap` | `{}` | Host events that `event` triggers and `wait: { event }` steps name. |
| `conditions` | `ConditionMap<C, D>` | `{}` | Host conditions that JSON predicates name. |
| `tools` | `Tool<C, D>[]` | `[]` | Functions the model may call while it speaks. See [Tool](tool.md). |
| `instructions` | `Instruction<C, D>[]` | `[]` | Agent-level rules, rendered into every speak call. See [Instruction](instruction.md). |
| `knowledgeBase` | `Record<string, unknown>` | none | Any JSON the model should know. Rendered as nested bullets. |
| `idle` | `Idle<C, D>` | `{ prompt: "" }` | The one speaker that is not a step. Answers a message when no run holds the floor. `'silent'` mutes it. |
| `clock` | `Clock` | `() => new Date()` | Returns "now". Tests pass `fakeClock(iso)`. |
| `businessHours` | `BusinessHours<C>` | none | `(at, { context }) => Date`. Moves a timer forward to the next working moment when a trigger or wait says `businessHours: true`. |
| `maxToolLoops` | `number` | `5` | Tool rounds per speak call. `0` disables tools. After the last round the model is asked once more without tools, so a message always comes back. |
| `compaction` | `AgentCompactionConfig` | none | Trims the history both calls see, once per turn, when it grows past `maxTokens`. See [Compaction](../guides/compaction.md). |
| `debug` | `boolean` | `false` | Sets the logger to debug level. |

`Idle` is `{ prompt: Template; tools?: string[]; instructions?: Instruction[] } | 'silent'`. Its `tools` list must name tools registered on the agent.

`AgentCompactionConfig` is `{ maxTokens: number; compactionThreshold?: number; preserveRecentCount?: number; maxToolResultChars?: number; enabled?: boolean }`. Defaults: `compactionThreshold` `0.8` — compaction runs when the history passes 80% of `maxTokens` (allowed 0.5 to 0.95); keep the 4 most recent messages (at least 2); cut each tool result at 5000 characters (more than 0); `enabled: true`. Values outside those ranges throw at construction.

## turn()

`turn(input)` runs one turn and resolves to a `TurnResult`. It never throws for a model failure during the speak call; that becomes a retry wake (see [Error handling](../guides/error-handling.md)). A failure during the understand call does throw, and nothing was written: replay the same input.

`turnStream(input)` runs the same turn and yields `{ delta: string }` chunks while the model phrases the reply, then one `{ done: true, result: TurnResult }`. When nobody speaks, only the last chunk comes. See [Streaming](../guides/streaming.md).

## TurnInput

Every input carries the common fields, plus exactly one of the four kinds.

### Common fields

| Field | Type | Meaning |
|---|---|---|
| `sessionId` | `string` | The conversation's id. A first turn creates the session under this id. |
| `session` | `Session<D>` | The stored session, as the store returned it. Absent on a first turn. A `wake` without a session is ignored. |
| `context` | `C` | Your ambient data for this turn. Required unless `C` allows `undefined` (`falai()` with no generic). |
| `history` | `History` | The conversation before this input. Pass it on every input kind, wakes included; both calls read it. Leave out the message this turn carries: both calls quote it on their own, so a history that ends with it is read twice. Store the message after the turn, not before. Without `history` the framework falls back to `session.history`, then to an empty list. |
| `silenced` | `Silenced` | Your reason the assistant cannot speak right now. See below. |
| `anchors` | `Record<string, { key: string; lastInboundAt?: string }>` | The host anchors this session belongs to, by name, e.g. `{ lead: { key: 'lead:456', lastInboundAt } }`. A flow with `anchor: 'lead'` keys its runs and claims by `anchors.lead.key`. |
| `claims` | `{ held: Record<string, string>; active: string[] }` | Claims from the customer's other sessions: `held` maps a dedupe key to the ISO time it was taken; `active` lists live `${flowId}:${anchor}` pairs. A flow already active elsewhere is skipped with `code: 'already-running'`. |

### The four kinds

| Kind | Shape | When to send it |
|---|---|---|
| message | `{ message: string; id?: string; at?: string }` | The customer wrote. `id` is the channel's message id; a repeated `id` is ignored (`code: 'duplicate-input'`, `changed: false`). `at` is the receipt time; it defaults to the clock's now. |
| wake | `{ wake: string }` | A `schedule[]` entry fired. Pass its `key`. A `silence:` key starts that flow's silence run, and only while the silence still holds (`code: 'silence-broken'` otherwise). Any other key moves only the run whose wait holds it exactly; anything else is `code: 'stale-wake'`. |
| event | `{ event: string; payload?: unknown; key: string; hop?: number }` | Something happened in the host. `event` names a registered event; `key` is your idempotency key for it; `payload` becomes the run's `input`. |
| start | `{ start: { flow: string; input?: unknown; key: string; hop?: number } }` | Start a flow by hand. Works for any flow, with or without `on`. |

### Silenced

```ts fragment
type Silenced = string | { reason: string; understand?: boolean };
```

A string closes the gate: `do` steps still run, nothing is phrased, zero model calls. A talk or `say` step reached while the gate is closed ends its run with `code: 'silenced'` (`detail` = your reason); a run that was already asking stays asking and speaks when the gate opens. `{ reason, understand: true }` keeps the understand call on, so routing, mentions and extraction still happen while the assistant stays quiet. Predicates see the reason as `ctx.silenced`.

## TurnResult

| Field | Type | Meaning |
|---|---|---|
| `session` | `Session<D>` | The session after this turn. `version` is unchanged; the host saves it with the version it loaded and the store bumps it. |
| `changed` | `boolean` | `false` means save nothing and send nothing: the input was ignored or nothing moved. |
| `messages` | `OutboundMessage[]` | What to send, in order. |
| `schedule` | `ScheduleEntry[]` | Wakes to enqueue with `jobId = key`. At fire time call `turn({ wake: key })`. |
| `outcomes` | `StepOutcome[]` | One line per step this turn, for your execution log. See [Outcomes](outcomes.md). |
| `started` | `Array<{ runId; flowId; anchor; dedupeKey }>` | Runs that started this turn. |
| `ended` | `Array<Run & { reason: EndReason }>` | Runs that ended, with the run's last state and why: `'end'`, `'flow'`, `'reset'`, `'skipped'`, `'failed'` or `'replaced'`. |
| `skipped` | `Array<{ flowId; anchor; triggerKey; code; message }>` | Triggers that matched but did not start a run, and why (`code: 'already-claimed'`, `code: 'cooldown'`, `code: 'already-running'`, `code: 'hop-limit'`, `code: 'flow-gone'`). |
| `llmCalls` | `number` | Model calls this turn: at most one understand call, plus one speak call and one per tool round, plus one when compaction summarized. |
| `usage` | `TokenUsage` | What those calls cost, added up. Absent when the turn spent no call, and when the provider reported no counts. |

### TokenUsage

```ts
interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  cachedInputTokens: number;
}
```

| Field | Type | Meaning |
|---|---|---|
| `promptTokens` | `number` | Tokens read, the cached ones included. |
| `completionTokens` | `number` | Tokens written. Thinking tokens count here. |
| `cachedInputTokens` | `number` | The part of `promptTokens` the provider served from its cache, billed far cheaper. `0` when the provider caches nothing or the prefix was cold. |

The counts are the providers' own, summed over every call the turn made. `usage` is absent rather than zero when nobody counted, so an unreported turn never looks free:

```ts fragment
const r = await agent.turn({ sessionId: "s1", message: "oi" });
if (r.usage) {
  const fresh = r.usage.promptTokens - r.usage.cachedInputTokens;
  console.log(`${r.llmCalls} call(s): ${fresh} read, ${r.usage.cachedInputTokens} cached, ${r.usage.completionTokens} written`);
}
```

### OutboundMessage

| Field | Type | Meaning |
|---|---|---|
| `text` | `string` | The message. |
| `kind` | `'ai' \| 'verbatim'` | `'ai'` was phrased by the model; `'verbatim'` came from a `say` step. |
| `media` | `{ slug: string }` | From a `say` step's `media`. |
| `afterMs` | `number` | Delay before sending. A `wait` of 10 seconds or less right before a `say` or talk step lands here instead of scheduling a wake. |
| `key` | `string` | `${runId}:${stepId}:${visit}` for a step; `idle:${triggerKey}` for the idle speaker. The same on a replay of the same input, so your sender can dedupe on it. |
| `runId`, `stepId` | `string` | Which run and step spoke. Absent for the idle speaker. |

### ScheduleEntry

| Field | Type | Meaning |
|---|---|---|
| `key` | `string` | The wake key. Use it as the job id and pass it back as `turn({ wake: key })`. |
| `at` | `Date` | When to fire. |
| `replaces` | `string` | An earlier wake this one supersedes. Removing it is best effort; a stale wake is ignored anyway. |

## Behaviour

- **Construction validates everything.** `f.agent()` throws `FlowConfigurationError` when:
  - two flows share an id
  - `idle.tools` names a tool that is not registered
  - a tool's `parameters` is not a JSON Schema object (`{ type: "object", properties, required }`) — the shape a function declaration needs, and easy to confuse with an action's `{ name: { type } }` map
  - `validateFlow` rejects any flow (see [Flow](flow.md#what-validateflow-rejects))

  Warnings — a backward jump without `clear`, a `collect` with no prompt and no `ask` — are logged with the `[Agent]` prefix. Compaction options outside their ranges throw a plain `Error`.
- **The input is never mutated.** `turn()` deep-copies `session` and works on the copy. `result.session` is that copy.
- **Ignored inputs.** A wake with no `session`, a wake whose key no live run holds, a silence wake after the customer wrote, and a message whose `id` is in the session's last 50 input ids all return `changed: false` with one `skipped` outcome line whose `code` says which: `no-session`, `stale-wake`, `silence-broken` or `duplicate-input`.
- **`changed` is computed, not flagged.** It is `true` when the session differs from the one you passed, or when there is anything in `messages`, `schedule`, `outcomes` or `skipped`.
- **Keys are deterministic.** Run id `${flowId}#${triggerKey}`, step key `${runId}:${stepId}:${visit}`. Replaying the same input against the same session version mints the same keys. See [Session](session.md) for the full table.
- **One speaker per turn.** At most one run asks at a time (the floor). A `say` or an action that reports `spoke: true` from another run makes the floor's talk step wait for the next message (`code: 'another-reply'`). The idle speaker answers a message only when no run is asking and nothing else spoke.
- **`context` is passed through as is.** Templates read it as `{{context.x}}`; predicates, actions and tools get it on `ctx.context`.

## Example

```ts
import { falai, GeminiProvider } from "@falai/agent";

const f = falai().fields({
  nome: { type: "string", ask: "Pergunte o nome da pessoa, sem tom de formulário." },
});

const agent = f.agent({
  name: "Ana",
  provider: new GeminiProvider({ apiKey: process.env.GEMINI_API_KEY ?? "", model: "gemini-2.5-flash" }),
  flows: [
    f.flow({
      id: "boas-vindas",
      name: "Boas-vindas",
      on: [{ message: [] }],
      steps: [
        { id: "nome", collect: ["nome"] },
        { id: "ajuda", prompt: "Agradeça pelo nome e pergunte como pode ajudar." },
      ],
    }),
  ],
});

const first = await agent.turn({ sessionId: "s1", message: "oi", id: "m1" });
console.log(first.messages[0]?.text, first.llmCalls); // the question for `nome`, 1

const second = await agent.turn({ sessionId: "s1", session: first.session, message: "sou a Ana", id: "m2" });
console.log(second.session.data.nome, second.messages[0]?.key, second.llmCalls); // 'Ana', 'boas-vindas#m1:ajuda:1', 2
```

## See also

- [Flow](flow.md), [Step](step.md), [Trigger](trigger.md), [Fields](fields.md)
- [Session](session.md) for `Session`, `Run` and the key formats
- [Outcomes](outcomes.md) for every outcome code
- [Architecture](../concepts/architecture.md) and [Pipeline](../concepts/pipeline.md)
- [Go to production](../start/05-go-to-production.md) for the host loop
