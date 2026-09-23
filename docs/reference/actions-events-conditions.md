---
title: "Actions, events, conditions"
description: "The three host registries a flow names by string: actions a do step runs, events the host reports, conditions a JSON predicate can call."
type: reference
order: 7
---

# Actions, events, conditions

You write these three in your code, and a flow names them with a string. An **action** does something when a `do` step reaches it: send an email, add a tag. An **event** is something that happened in your system. You report it with `turn({ event })`, and triggers and `wait` steps react. A **condition** is a yes/no check your code answers, so a flow stored as JSON can ask something the built-in tests cannot. Register all three on the agent, under `actions`, `events` and `conditions`. Every name a flow uses is checked when the agent is built.

Source: `src/types/flow.ts`, `src/core/Runner.ts`, `src/core/predicate.ts`, `src/core/falai.ts`.

## Action

An action is a host function with typed parameters. A `do` step names it and passes `with`. It runs at least once per step visit, so make it idempotent: safe to run twice. Check `ctx.key` and skip work you already did for that key.

### Signature

```ts fragment
interface Action<C = unknown, D = unknown, P = Record<string, unknown>> {
  description?: string;
  parameters: ParamDefs;
  run(params: P, ctx: ActionCtx<C, D>): ActionResult | Promise<ActionResult>;
}

type ActionMap<C = unknown, D = unknown> = Record<string, Action<C, D>>;

type ParamDefs = Record<string, ParamDef>;

type ParamDef =
  | (ScalarDef & { optional?: true })
  | { type: "array"; items: ScalarDef; description?: string; optional?: true };

interface ScalarDef<T extends ScalarType = ScalarType> {
  type: T;                                   // "string" | "number" | "integer" | "boolean"
  description?: string;
  enum?: readonly (string | number)[];
}

/** The `with` shape of an action, from its parameter definitions. */
type InferParams<P extends ParamDefs> = { /* required keys */ } & { /* optional keys? */ };

interface ActionCtx<C = unknown, D = unknown> {
  context: C;
  data: Partial<D>;
  input: unknown;
  run: Run;
  key: string;
  dedupeKey: string;
  silenced?: string;
  now: Date;
  set(patch: Partial<D>): void;
}

type ActionResult =
  | { ok: true; detail?: string; spoke?: true }
  | { skipped: string }
  | { failed: string }
  | { defer: Duration; detail: string };
```

`f.action(def)` returns the same object, with `params` typed from `parameters`:

```ts fragment
f.action<const P extends ParamDefs>(def: {
  description?: string;
  parameters: P;
  run: (params: InferParams<P>, ctx: ActionCtx<C, D>) => ActionResult | Promise<ActionResult>;
}): Action<C, D, InferParams<P>>
```

### Action fields

| Field | Type | Default | Meaning |
|---|---|---|---|
| `description` | `string` | none | For people and editors. The framework never reads it. |
| `parameters` | `ParamDefs` | required | What `with` must carry. Every parameter is required unless `optional: true`. `{}` means the action takes nothing. |
| `run` | `(params, ctx) => ActionResult \| Promise<ActionResult>` | required | Your code. Return one of the four results; a thrown error counts as `{ failed: error.message }`. |

### ParamDef fields

| Field | Type | Default | Meaning |
|---|---|---|---|
| `type` | `"string" \| "number" \| "integer" \| "boolean" \| "array"` | required | The value's type. `array` needs `items`. |
| `items` | `ScalarDef` | required for `array` | The type of each element. |
| `enum` | `readonly (string \| number)[]` | none | Allowed values. Becomes a literal union in `InferParams`. |
| `description` | `string` | none | Shown to a model that writes flows (`flowSpecSchema`). |
| `optional` | `true` | absent | The parameter may be left out of `with`. |

### ActionCtx fields

| Field | Type | Meaning |
|---|---|---|
| `context` | `C` | The host context passed to this `turn()`. |
| `data` | `Partial<D>` | The session's collected fields, live. |
| `input` | `unknown` | The run's input: a mention trigger's `extract` values, an event's `payload`, a `start` input, or, for a `{ flow }` jump, its `input` when given, else the parent run's input. |
| `run` | `Run` | The run this step belongs to: id, flow, anchor, status, visits, asked counts, outcomes. |
| `key` | `string` | `${runId}:${stepId}:${visit}`. The same input replayed mints the same key, and a deferred action re-runs under the same key. Use it as your idempotency key. |
| `dedupeKey` | `string` | `${flowId}:${anchor}:${nonce}`. `nonce` is the trigger key when `repeat` is `'always'`, empty for `'once'` and cooldown. The host may share it across a customer's sessions through `turn({ claims })`. |
| `silenced` | `string \| undefined` | The host's reason the assistant may not speak. `do` steps still run while silenced; check this before sending anything the customer would read. |
| `now` | `Date` | The agent's clock at this turn. Never read `Date.now()` inside an action. |
| `set(patch)` | `(patch: Partial<D>) => void` | Writes fields into `data` at once, as given. Values are not coerced or checked against the field's type or `enum`. |

### ActionResult and what the runner does

| Result | Outcome line | Movement |
|---|---|---|
| `{ ok: true, detail?, spoke? }` | `do` / `ok`, no `code`, `detail` only when you gave one | `then`, or the next step. |
| `{ skipped: reason }` | `do` / `skipped`, `code: 'action-skipped'`, `detail` = your reason, unprefixed | `then`, or the next step. |
| `{ failed: reason }` | `do` / `failed`, `code: 'action-failed'`, `detail` = your reason, unprefixed | `onFail` if the step has one, else `then` or the next step. |
| `{ defer: '24h', detail }` | `do` / `deferred`, `code: 'action-deferred'`, `detail` as you gave it, `until` set | The run parks. A wake with key `${runId}:${stepId}:${atMs}` goes into `schedule[]`. At fire time the same step runs again at the same visit, so `ctx.key` is unchanged. |
| thrown error | as `{ failed: error.message }` | as `failed`. |

`spoke: true` tells the runner your action itself answered the customer (it sent a template, say). Three things follow: the assistant counts as having spoken, so `lastAssistantAt` moves and silence triggers re-arm; the idle speaker stays quiet this turn; and on a message turn, a talk step in another run that was about to speak is held back with `code: 'another-reply'` and its run stays `asking`.

### Behaviour

- `with` is rendered before `run` sees it. `{{data.x}}`, `{{context.x}}` and `{{input.x}}` are replaced inside every string, at any depth. An unknown path keeps its placeholder, so a typo stays visible. A blank one drops out instead and the gap it left in the sentence closes — an empty string, or a path through a `null` (`{{context.lead.name}}` with no lead). A `null` at the end of a path is unknown, not blank.
- `with` is checked when the agent is built, not on the turn that reaches the step. A missing required parameter, an unknown parameter, or a value outside `enum` throws `FlowConfigurationError`. So does a wrong type: `"3"` is not a number, because values are never coerced. A string that contains `{{` skips the `enum` check, because its value is only known at run time.
- Actions run in the Run phase, by code, with zero model calls. They run while `silenced` too.
- A `do` step whose action name is not registered throws at build. If the registry changed under a running agent, the step reports `code: 'action-failed'` with `detail: 'unknown action "notify"'`.
- The runner awaits `run`. Keep it short; nothing else in the turn moves until it returns.

### Example

```ts
import { falai, GeminiProvider } from "@falai/agent";

const f = falai().fields({
  nome: { type: "string", ask: "Pergunte o nome." },
  empresa: { type: "string", ask: "Pergunte a empresa." },
});

// `params` is typed from `parameters`: { recipient: string; message: string; urgent?: boolean }.
const notify = f.action({
  description: "Avisa alguém da equipe.",
  parameters: {
    recipient: { type: "string" },
    message: { type: "string" },
    urgent: { type: "boolean", optional: true },
  },
  run: (params, ctx) => {
    console.log(`[${ctx.key}] ${params.recipient}: ${params.message}`);
    return { ok: true, detail: "aviso enviado" };
  },
});

const agent = f.agent({
  name: "Ana",
  provider: new GeminiProvider({ apiKey: process.env.GEMINI_API_KEY ?? "", model: "gemini-2.5-flash" }),
  actions: { notify },
  flows: [
    f.flow({
      id: "triagem",
      name: "Triagem",
      on: [{ message: ["quer um orçamento"] }],
      steps: [
        { id: "quem", collect: ["nome", "empresa"] },
        {
          id: "avisa",
          do: "notify",
          with: { recipient: "owner", message: "Lead: {{data.nome}} ({{data.empresa}})" },
          onFail: "falhou",
        },
        { id: "tchau", say: "Um vendedor continua daqui.", then: "end" },
        // The action failed: say so, and say what happens next.
        { id: "falhou", say: "Não consegui avisar o time agora. Seus dados estão salvos e um vendedor fala com você ainda hoje." },
      ],
    }),
  ],
});

const r = await agent.turn({ sessionId: "demo", message: "quero um orçamento" });
console.log(r.outcomes.map((o) => [o.stepId, o.status, o.code, o.detail]));
```

## Event

An event is a fact the host reports: a deal moved stage, a meeting was booked, a human replied. Register it by name so triggers (`on: [{ event }]`) and steps (`wait: { event }`) can use it. The definition carries a direction and a `payload` type that exists only for TypeScript; nothing is ever stored in it.

### Signature

```ts fragment
interface EventDef<P = unknown> {
  direction?: "inbound" | "outbound";
  readonly payload?: P;   // phantom: the payload type, never set at run time
}

type EventMap = Record<string, EventDef>;

f.event<P = undefined>(def?: { direction?: "inbound" | "outbound" }): EventDef<P>
```

### EventDef fields

| Field | Type | Default | Meaning |
|---|---|---|---|
| `direction` | `"inbound" \| "outbound"` | none | `'inbound'`: the customer spoke through this event. `'outbound'`: the assistant spoke. Absent: neither side spoke. |
| `payload` | `P` | never set | Only types the payload. Never set it. |

### Reporting an event

The host calls `turn()` with the event variant of `TurnInput`:

```ts fragment
{ event: string; payload?: unknown; key: string; hop?: number }
```

| Field | Meaning |
|---|---|
| `event` | The registered name. |
| `payload` | Becomes the run's `input`; `{{input.x}}` reads it in prompts, `say` texts and `with`. |
| `key` | The trigger key. Runs it starts get id `${flowId}#${key}`, and with the default `repeat: 'always'` the claim `${flowId}:${anchor}:${key}` is written. Reporting the same event again with the same key starts nothing: the start is skipped with `code: 'already-claimed'`. |
| `hop` | Chaining depth, default 0. A start that would be at hop 5 is skipped with `code: 'hop-limit'`. |

An event turn never spends an understand call. It costs one speak call (plus tool rounds) only when a run it moved reaches a talk step.

### What an event turn does, in order

1. **Direction.** `'inbound'` sets `lastUserAt` to now and resolves reply waits: every run parked on a timer `wait` that has an `else` resumes with `code: 'replied'` and follows a matching `if` branch's `then`, else `else`. `'outbound'` sets `lastAssistantAt` to now, which re-arms `silence` triggers at the end of the turn.
2. **Waiting runs.** Every run parked on `wait: { event: name }` for this name resumes with `code: 'event-arrived'` and follows `then`. The first one to resume takes the floor for this turn.
3. **Triggers.** Every flow with `on: [{ event: name }]` goes through the start order: trigger `if`, `repeat` (default `'always'` for events), the hop cap, one live run per flow and anchor. With `after`, the run parks first (`code: 'awaiting-trigger'`, wake key `${runId}:start:${atMs}`) and enters its first step when the wake fires; `businessHours: true` snaps that time forward through the agent's `businessHours` function. With `businessHours: true` and no `after`, an event that arrives outside working hours parks the run the same way until the next working moment.

`wait: { event, upTo }` in a step parks the run for at most `upTo` (default `'30d'`, from `src/core/Runner.ts`). If the event never comes, the line carries `code: 'no-event'` and the run follows `else`, or ends when there is none.

### Example

```ts
import { falai, GeminiProvider } from "@falai/agent";

interface Ctx {
  lead: { id: string };
}

const f = falai<Ctx>().fields({
  nome: { type: "string", ask: "Pergunte o nome." },
});

const events = {
  stage_entered: f.event<{ stageId: string }>(),
  reaction: f.event<{ emoji: string }>({ direction: "inbound" }),
};

const agent = f.agent({
  name: "Ana",
  provider: new GeminiProvider({ apiKey: process.env.GEMINI_API_KEY ?? "", model: "gemini-2.5-flash" }),
  events,
  flows: [
    f.flow({
      id: "proposta",
      name: "Proposta enviada",
      // Starts on every `stage_entered`, ten minutes after it is reported.
      on: [{ event: "stage_entered", after: "10m" }],
      steps: [{ id: "avisa", say: "Você entrou na etapa {{input.stageId}}. Quer que eu explique os próximos passos?" }],
    }),
  ],
});

const r = await agent.turn({
  sessionId: "demo",
  context: { lead: { id: "l1" } },
  event: "stage_entered",
  payload: { stageId: "proposta" },
  key: "stage:proposta:1",
});
console.log(r.schedule); // one wake, ten minutes from now
```

## Condition

A condition is a named yes/no check in code. Flows written in TypeScript can pass a function anywhere a predicate (`Pred`, below) is accepted; flows stored as JSON cannot, so they name a condition and give it an argument: `{ tagsAny: ["vip"] }`.

### Signature

```ts fragment
interface Condition<C = unknown, D = unknown, Arg = unknown> {
  check(ctx: PredCtx<C, D>, arg: Arg): boolean;
}

type ConditionMap<C = unknown, D = unknown> = Record<string, Condition<C, D>>;

/** The JSON form of a predicate. Every listed entry must hold. */
interface ConditionSpec<D = unknown> {
  equals?: Partial<D>;
  known?: (keyof D & string)[];
  silenced?: boolean;
  [condition: string]: unknown;   // a registered condition and its argument
}

/** A code predicate (free) or its JSON form. */
type Pred<C = unknown, D = unknown, P = unknown> =
  | ((ctx: PredCtx<C, D, P>) => boolean)
  | ConditionSpec<D>;

interface PredCtx<C = unknown, D = unknown, P = unknown> {
  context: C;
  data: Partial<D>;
  input: P;
  run?: Run;
  silenced?: string;
  now: Date;
}

f.condition<Arg>(check: (ctx: PredCtx<C, D>, arg: Arg) => boolean): Condition<C, D, Arg>
```

### PredCtx fields

| Field | Type | Meaning |
|---|---|---|
| `context` | `C` | The host context of this turn. |
| `data` | `Partial<D>` | Collected fields, live. |
| `input` | `P` | The run's input (see `ActionCtx.input`). `undefined` when there is no run. |
| `run` | `Run \| undefined` | The run being judged. Present for a trigger `if`, `while`, an `if` step, a branch `if`, and a flow or step instruction `if`. Absent whenever the idle speaker answers, because no run holds the floor — for agent-level and `idle`-level instructions alike. |
| `silenced` | `string \| undefined` | The host's reason the assistant may not speak, when given. |
| `now` | `Date` | The agent's clock. |

For a trigger `if`, `run` is the run as it would be if it started now: id `${flowId}#${triggerKey}`, `stepId: null`, `status: 'running'`, empty `asked`, `visits` and `outcomes`. Nothing has been written to the session yet.

### ConditionSpec built-ins

A `ConditionSpec` holds when every key holds (AND). A key whose value is `undefined` is skipped.

| Key | Argument | Holds when |
|---|---|---|
| `equals` | `{ field: value, … }` | Every `data[field]` deep-equals the value as written. Values are compared, not rendered: `"{{context.x}}"` is a literal string here. |
| `known` | `["field", …]` | Every field is known: not `undefined`, not `null`, not `''`. |
| `silenced` | `true \| false` | `true`: the host passed `silenced`. `false`: it did not. |
| any other key | anything | `conditions[key].check(ctx, arg)` returns true. The argument arrives from JSON unvalidated; test its shape inside `check`. |

Naming a condition the agent does not have throws `FlowConfigurationError` when the agent is built (`validateFlow`), and again at evaluation if it ever gets that far.

### Where a predicate may appear

| Place | Field | Judged |
|---|---|---|
| Trigger | `on[].if` | Before a run starts. For `message` and `silence` triggers also earlier, when the turn works out which flows may start; `run` is then the run as it would be (see above). |
| Flow | `while` | Every time the run is about to move. Default: the trigger's `if`. When it stops holding the run ends with `code: 'premise-changed'`. |
| Step | `if` step | When the run reaches it. `then` on true, `else` (default `'end'`) on false. |
| Branch | `branches[].if` | On the asking talk step when the customer writes, and on a timer `wait` when the customer replies first. |
| Instruction | `if` | When the speak prompt is built. A false `if` drops the instruction from this call. |

A function predicate is free and runs on every check. A `when` string is different: the model judges it, and it costs part of a call. See [Conditions](../guides/conditions.md).

### Example

```ts
import { falai, GeminiProvider } from "@falai/agent";

interface Ctx {
  lead: { tags: string[]; owner: "ai" | "human" };
}

const f = falai<Ctx>().fields({
  nome: { type: "string", ask: "Pergunte o nome." },
});

const conditions = {
  // JSON flows write { tagsAny: ["vip"] }; `arg` arrives unvalidated, so check its shape.
  tagsAny: f.condition((ctx, tags: string[]) => Array.isArray(tags) && tags.some((t) => ctx.context.lead.tags.includes(t))),
};

const agent = f.agent({
  name: "Ana",
  provider: new GeminiProvider({ apiKey: process.env.GEMINI_API_KEY ?? "", model: "gemini-2.5-flash" }),
  conditions,
  flows: [
    f.flow({
      id: "vip",
      name: "Atendimento VIP",
      on: [{ message: ["quer falar com alguém"], if: { tagsAny: ["vip"] } }],
      steps: [
        // A function predicate, free, judged by code.
        { id: "dono", if: ({ context }) => context.lead.owner === "ai", then: "quem", else: "end" },
        { id: "quem", collect: ["nome"] },
      ],
    }),
  ],
});

const r = await agent.turn({
  sessionId: "demo",
  context: { lead: { tags: ["vip"], owner: "ai" } },
  message: "quero falar com alguém",
});
console.log(r.started.map((s) => s.flowId)); // ["vip"]
```

## See also

- [Actions and events](../guides/actions-and-events.md): idempotency, publishing events, waiting on them.
- [Conditions](../guides/conditions.md): `when` versus `if`, and where each is allowed.
- [Flow spec](./flow-spec.md): how names in a JSON flow resolve against these registries.
- [Outcomes](./outcomes.md): every line a `do` step or a skipped start can produce.
- [Step](./step.md): the `do`, `if` and `wait` steps.
