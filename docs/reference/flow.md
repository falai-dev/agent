---
title: "Flow"
description: "Every Flow field with its type and default, what the runtime does with each one, and what validateFlow rejects."
type: reference
order: 2
---

# Flow

A flow is a trigger plus an ordered list of steps. Its `on` list says when a run starts; its `steps` say what the run does; `onEnd` says what happens after the last step. A run is one live execution of a flow inside a session. Flows are plain objects, so the same shape round-trips through JSON as a [FlowSpec](flow-spec.md).

## Signature

```ts fragment
interface Flow<C = unknown, D = unknown> {
  id: string;
  name: string;
  description?: string;
  on?: Trigger<C, D>[];
  anchor?: string;
  while?: Pred<C, D>;
  clearOnStart?: (keyof D & string)[];
  steps: Step<C, D>[];
  onEnd?: "end" | "stay" | "reset";
  instructions?: Instruction<C, D>[];
  tools?: string[];
}
```

## Fields

| Field | Type | Default | Meaning |
|---|---|---|---|
| `id` | `string` | required | Unique across the agent. Part of every run id (`${id}#${triggerKey}`) and every claim key. Keep it stable once sessions exist: a run whose flow id is gone ends with `code: 'flow-gone'`. |
| `name` | `string` | required | The human name. The model reads it when routing and when speaking. |
| `description` | `string` | none | When this flow should be used. The model reads it when scoring flows and while speaking. |
| `on` | `Trigger<C, D>[]` | none | What starts a run. Absent or empty: only `turn({ start })` or another flow's `then: { flow }` starts it. See [Trigger](trigger.md). |
| `anchor` | `string` | `'session'` | What a run is keyed to. `'session'` uses the session id. Any other name reads `input.anchors[name].key`, and falls back to the session id when the host did not pass that anchor. |
| `while` | `Pred<C, D>` | the trigger's `if` | Re-checked before the run moves. When it stops holding, the run ends with `code: 'premise-changed'`. |
| `clearOnStart` | `(keyof D & string)[]` | none | Fields forgotten when a run of this flow starts, so a second run asks for them again. |
| `steps` | `Step<C, D>[]` | required | In order. A run enters `steps[0]` and moves to the next step unless `then` says otherwise. See [Step](step.md). |
| `onEnd` | `'end' \| 'stay' \| 'reset'` | `'end'` | What the run does after its last step. |
| `instructions` | `Instruction<C, D>[]` | none | Rules that apply while a step of this flow speaks. See [Instruction](instruction.md). |
| `tools` | `string[]` | every agent tool | Tools the model may call while a step of this flow speaks. A step's own `tools` list wins over this one. |

## Behaviour

**Starting a run.** Whatever the trigger, a run starts in one order.

1. The trigger's `if` is judged.
2. The claim is checked against `repeat` (`code: 'already-claimed'`, `code: 'cooldown'`).
3. The chain depth is checked (`code: 'hop-limit'` at 5 hops).
4. One live run per flow and anchor is enforced (`code: 'already-running'`). The one exception: a run still parked on an event trigger's `after` ends with reason `'replaced'` and the new run takes its place.
5. The claim is written, `clearOnStart` fields are deleted, and the run is added with `stepId: null`.

It enters `steps[0]` in the same turn unless the trigger has `after`. Keys and skip reasons are in [Trigger](trigger.md).

**`anchor`.** The anchor is part of the run's `dedupeKey` (`${flowId}:${anchor}:${nonce}`) and of the one-live-run rule. With `anchor: 'lead'` and `anchors: { lead: { key: 'lead:456' } }` on every turn, a flow runs once per customer even when the customer has several sessions, as long as the host also passes `claims` from the other sessions. `anchors.lead.lastInboundAt` also counts as "the customer wrote" when a silence wake fires and when a wait's wake decides whether the customer replied.

**`while`.** Checked every time the run is about to move: at the start of each turn's run phase for a running run, and when an asking run resumes on a message. A parked run (`waiting`) or a suspended one is not checked until it moves again. Without `while`, the check is the trigger's `if`: the run holds while any trigger of the same kind as the one that started it would still fire. A run started by `start` or by another flow has no such trigger, so without `while` it always holds. A silence run also ends, with `code: 'customer-replied'`, when a wake finds that the customer wrote after the run started.

**`clearOnStart`.** Applied at start for every trigger kind, `start` and `{ flow }` chains included. Not applied when `onEnd: 'reset'` restarts the flow: reset keeps the data.

**`onEnd`.**
- `'end'`: the run ends with reason `'end'`.
- `'stay'`: the run goes back to the last talk step it took and stays there, asking. On a branched flow that is the step on its own path; when its log names none, the flow's last talk step. From then on that step answers every message, even when it has nothing left to collect, and each answer is a new visit, so a new key. The steps after it ran once, on the way to the end, and do not run again. If the run finishes on a message nothing has answered yet (no `say`, no `spoke: true`), the step answers it in that same turn. If another run is asking, the staying run waits `suspended` behind it and takes over when that run is done, answering the message that run moved on from without a word. When the customer's message belongs to this run (it was routed to this flow, or it resolved this run's `wait`), the run takes the conversation instead: the other asker is suspended, and this run answers unless its own `say` already did. Its `when` branches are judged on every message and still move the run. Its `if` branches are judged too, except one that leads to `'end'` or to a step the run has already been through: that path already ran and the fact is still true, so it would run again on every message. A flow with no talk step ends, as with `'end'`.
- `'reset'`: the run ends with reason `'reset'` and a fresh run of the same flow starts at `steps[0]`, data kept, one hop deeper. A flow that resets forever without asking anything stops at hop 5, with `code: 'hop-limit'`.

**Instructions and tools while speaking.** The speak call sees the agent's instructions, then this flow's, then the step's, each already filtered by its `if`. Tools are the step's `tools`; without one, the flow's `tools`; without that, every agent tool.

**Editing flows under live sessions.** A stored run names its flow and step by id. If the flow is gone, the run ends with `code: 'flow-gone'`; if its step is gone, with `code: 'step-gone'`. Renaming ids is a breaking change for sessions in flight.

## What validateFlow rejects

`f.agent()` runs `validateFlow(flow, registries)` on every flow. It throws `FlowConfigurationError` on the first of these:

- no `id`, or `steps` is not a list
- a step with no `id`, the id `'end'`, or an id used twice
- triggers with zero steps
- an unknown field slug in `clearOnStart`, `collect`, `ask`, `equals`, `known` or a `clear` list
- an unknown action in `do`; a `with` that misses a required parameter, names one the action does not have, or gives a value of the wrong type (`with` values are not coerced; a `{{template}}` string is accepted for any enum)
- an unknown event in a trigger or in `wait: { event }`
- an unknown condition name, or a malformed built-in (`equals` not an object, `known` not a list, `silenced` not a boolean); an `equals` value whose type does not match the field
- an unknown tool in the flow's or a step's `tools`
- a `silence`, `after`, `cooldown`, `wait` or `upTo` that is not a duration (`"30s"`, `"5m"`, `"24h"`, `"3d"`)
- a `then`, `else`, `onFail` or branch `then` that points at a step that does not exist
- a branch with neither `when` nor `if`
- an `if` step whose `then` jumps backward with no `else`

It returns warnings, logged by the agent, for two things that run but probably not as intended: a jump backward without `clear` (the fields collected since stay known, so those steps skip), and a `collect` step with no `prompt` and no `ask` on any of its fields.

`toSpec(flow)` throws `FlowConfigurationError` when a predicate is a function, because a function cannot be stored as JSON.

## Example

```ts
import { falai, GeminiProvider } from "@falai/agent";

interface Ctx {
  lead: { etapa: string };
}

const f = falai<Ctx>().fields({
  confirmado: { type: "boolean", ask: "Pergunte se a proposta chegou bem e se está tudo claro." },
});

const proposta = f.flow({
  id: "proposta",
  name: "Acompanhar proposta",
  description: "Uma hora depois que a proposta foi enviada, enquanto o lead continua nessa etapa.",
  on: [{ event: "entrou_na_etapa", after: "1h", if: { naEtapa: "proposta" } }],
  anchor: "lead",
  while: { naEtapa: "proposta" },
  clearOnStart: ["confirmado"],
  steps: [
    { id: "chegou", collect: ["confirmado"] },
    { id: "ok", if: { equals: { confirmado: true } }, else: "avisa" },
    { id: "tchau", say: "Ótimo. Qualquer dúvida, é só chamar.", then: "end" },
    { id: "avisa", do: "avisar", with: { texto: "Proposta não chegou bem para o lead em {{context.lead.etapa}}." } },
  ],
  onEnd: "end",
});

const agent = f.agent({
  name: "Ana",
  provider: new GeminiProvider({ apiKey: process.env.GEMINI_API_KEY ?? "", model: "gemini-2.5-flash" }),
  events: { entrou_na_etapa: f.event<{ etapa: string }>() },
  conditions: { naEtapa: f.condition((ctx, etapa: string) => ctx.context.lead.etapa === etapa) },
  actions: { avisar: f.action({ parameters: { texto: { type: "string" } }, run: () => ({ ok: true }) }) },
  flows: [proposta],
});

const context: Ctx = { lead: { etapa: "proposta" } };
const r = await agent.turn({
  sessionId: "s1",
  context,
  anchors: { lead: { key: "lead:456" } },
  event: "entrou_na_etapa",
  payload: { etapa: "proposta" },
  key: "stage:456:proposta",
});
console.log(r.started[0]?.dedupeKey, r.schedule[0]?.key); // 'proposta:lead:456:stage:456:proposta', 'proposta#stage:456:proposta:start:<ms>'
```

## See also

- [Trigger](trigger.md) for `on`, `repeat`, keys and skip reasons
- [Step](step.md) for the six step kinds and `Next`
- [Flow spec](flow-spec.md) for the JSON form and `validateFlow`
- [Flow control](../guides/flow-control.md) and [Runs and waits](../concepts/runs-and-waits.md)
