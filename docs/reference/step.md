---
title: "Step"
description: "StepBase and the six step kinds as tables, what then and else mean for each, Next in all its forms, and the per-turn caps."
type: reference
order: 3
---

# Step

A step is one thing a run does: the model talks, a fixed text goes out, the host does something, the run waits, or the code forks. Every step has an `id` and may have a `then`. A run enters the first step and moves to the next one in the list unless `then` says otherwise. There are six kinds, told apart by which property is present: `prompt` or `collect` (talk), `say`, `do`, `wait` with a duration, `wait` with an event, and `if`.

## Signature

```ts fragment
interface StepBase<D = unknown> {
  id: string;
  label?: string;
  then?: Next<D>;
  ui?: Record<string, unknown>;
}

type Step<C, D> = StepBase<D> &
  (TalkStep<C, D> | SayStep | DoStep<D> | WaitStep<C, D> | WaitEventStep<D> | IfStep<C, D>);

type Next<D> =
  | string
  | { step: string; clear?: (keyof D & string)[] }
  | { flow: Template; input?: unknown };
```

## StepBase

| Field | Type | Default | Meaning |
|---|---|---|---|
| `id` | `string` | required | Unique inside the flow. Never `'end'`. Part of every message and action key (`${runId}:${id}:${visit}`). |
| `label` | `string` | none | A human label for editors and logs. The framework never reads it. |
| `then` | `Next<D>` | the next step in the list | Where the run goes when the step is done. At the last step, `onEnd` decides. |
| `ui` | `Record<string, unknown>` | none | Editor data the framework carries and never reads. |

## Talk step

The model speaks. A guideline, fields to collect, or both.

```ts fragment
type TalkStep<C, D> = ({ prompt: Template; collect?: (keyof D & string)[] } | { collect: (keyof D & string)[]; prompt?: Template }) & {
  ask?: Partial<Record<keyof D & string, string>>;
  question?: Template;
  maxAsks?: number;
  branches?: Branch<C, D>[];
  tools?: string[];
  instructions?: Instruction<C, D>[];
};
```

| Field | Type | Default | Meaning |
|---|---|---|---|
| `prompt` | `Template` | "Collect what is still missing below, in the flow of the conversation, one or two things per message." | The guideline for the reply. Required when there is no `collect`. |
| `collect` | `(keyof D & string)[]` | none | Fields to ask for now, in this order. The step is done when they are known. The flow's own `collect` lists everything it needs; see [Flow](flow.md). |
| `ask` | `Partial<Record<slug, string>>` | the field's own `ask` | Per-flow wording for a field. |
| `question` | `Template` | none | A fixed first question, sent word for word with no model call. Needs `collect`. |
| `maxAsks` | `number` | `3` | Times a field may be asked before it is skipped (`code: 'max-asks'`, the field in `detail`). |
| `branches` | `Branch<C, D>[]` | none | Exits judged while the step asks. See [Branches](branches.md). |
| `tools` | `string[]` | the flow's `tools`, else all | Tools the model may call from this step. |
| `instructions` | `Instruction<C, D>[]` | none | Rules that apply only while this step speaks. |

- Pending fields are `collect` minus the known ones minus those at `maxAsks`, in `collect` order. A step the run enters whose pending list is empty is skipped with no model call (`code: 'already-known'`) and the run follows `then`. When the asking run resumes and the message filled the last field, the same move is logged `ok` with no detail.
- Reaching a talk step suspends any other run that was asking; this run becomes the asker and holds the floor. It speaks in this turn if the speak call has not happened yet; otherwise it speaks on the next message.
- The speak call returns the message plus one value per pending field. Values are validated and written; each field still pending is counted as asked once more. With pending fields left the run stays asking. With none left, or with no `collect` at all, the run follows `then` in the same turn.
- With `question`, the step's first ask is that text, as a `kind: 'verbatim'` message with no speak call (`code: 'asked-fixed'`). It goes out only when every field in `collect` is still pending and none was asked yet, and never on a run that stays (`onEnd: 'stay'`). Reached after this turn's speak call, it goes out in the same turn, the way a `say` does. It counts as one ask of each field. Every later ask is the model's own wording, so a customer who asks something back gets an answer; `maxAsks` still applies. A `{ step, clear }` that clears the step's fields also clears their ask count, so the question goes out again.
- With `silenced` set, a talk step ends the run with `code: 'silenced'` (`detail` = your reason); a run that was already asking stays asking instead.
- Outcome kind: `collect` when `collect` is non-empty, else `prompt`.

`then`: taken when every collected field is known (or skipped at `maxAsks`), or right after speaking for a step without `collect`. There is no `else`; use `branches`.

## Say step

A fixed message goes out, verbatim. No model call.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `say` | `Template` | required | The text. `{{data.x}}`, `{{context.x}}` and `{{input.x}}` are filled in. |
| `media` | `{ slug: string }` | none | Passed through on the outbound message. |
| `once` | `boolean` | `false` | Send at most once per session. A second visit is `code: 'already-sent'` and the run moves on. The claim key is `${flowId}:${stepId}:${sessionId}`. |

- The message goes out with `kind: 'verbatim'` and `key = ${runId}:${stepId}:${visit}`. A short `wait` right before it becomes its `afterMs`.
- A `say` counts as the assistant speaking: it re-arms silence triggers, and it makes any other run's talk step wait for the next message (`code: 'another-reply'`).
- With `silenced` set, the run ends with `code: 'silenced'` (`detail` = your reason).

`then`: taken right after the message is queued.

## Do step

The host does something. Runs even when `silenced`.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `do` | `string` | required | The action's name in the agent's `actions`. |
| `with` | `Record<string, unknown>` | `{}` | The action's parameters. Checked at construction against `parameters`; strings are rendered as templates at run time. |
| `onFail` | `Next<D>` | `then` | Where to go when the action reports `{ failed }` or throws. |

- The action gets `{ context, data, input, run, key, dedupeKey, silenced, now, set }`. `key` is `${runId}:${stepId}:${visit}`, the same on a replay; make the handler idempotent on it.
- `{ ok }` continues along `then`; `spoke: true` counts as the assistant speaking. `{ skipped: reason }` logs `code: 'action-skipped'` and continues along `then`. `{ failed: reason }` logs `code: 'action-failed'` and follows `onFail`, else `then`. A thrown error is a `failed` with the error's message.
- `{ defer: '5m', detail }` parks the run under the wake key `${runId}:${stepId}:${atMs}`. At the wake the step runs again at the same visit, so with the same `key`.

`then`: after `ok` or `skipped`, and after `failed` when there is no `onFail`.

## Wait step (duration)

The run parks for a while.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `wait` | `Duration` | required | How long: `'30s'`, `'5m'`, `'24h'`, `'3d'`. |
| `businessHours` | `boolean` | `false` | Snap the end of the wait forward with the agent's `businessHours`. |
| `else` | `Next<D>` | none | Where to go when the customer writes before the time passes. Without it the customer's message does not end the wait. |
| `branches` | `Branch<C, D>[]` | none | `if` branches judged when the customer writes, before `else`. See [Branches](branches.md). |

- A wait of 10 seconds or less whose `then` leads straight to a `say` or talk step does not park: it becomes that message's `afterMs` (status `ok`, `code: 'inline-delay'`, `detail: '<ms>ms'`).
- Otherwise the run parks under the wake key `${runId}:${stepId}:${atMs}` and one `schedule[]` entry is returned (outcome `waiting`, with `until`).
- When the customer writes (a message, or an event with `direction: 'inbound'`) and the step has `else`, the run resumes at once: the first `if` branch that holds wins, else `else` (outcome `code: 'replied'`).
- When the wake fires: `then` (`code: 'no-reply'`), or `else` when the step has one and the customer wrote after the wait was set (`code: 'replied'`).

`then`: the time passed. `else`: the customer replied first.

## Wait step (event)

The run parks until a host event arrives.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `wait.event` | `string` | required | The event's name in the agent's `events`. |
| `wait.upTo` | `Duration` | `'30d'` | Give up after this long. |
| `else` | `Next<D>` | `'end'` | Where to go when `upTo` passes without the event. |

- The run parks under the wake key `${runId}:${stepId}:${atMs}` (status `waiting`, `code: 'awaiting-event'`, the event name in `detail`).
- `turn({ event })` with that name resumes every run waiting on it (outcome `code: 'event-arrived'`); the run takes the floor and follows `then` in the same turn. The event's `payload` does not replace the run's `input`.
- When the wake fires first: `else`, or the run ends when there is none (outcome `code: 'no-event'`).

`then`: the event came. `else`: `upTo` passed.

## If step

The code forks. No model call.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `if` | `Pred<C, D>` | required | A function `(ctx) => boolean`, or a `ConditionSpec` such as `{ equals: { confirmado: true } }`, `{ known: ['nome'] }`, `{ silenced: true }` or `{ naEtapa: 'proposta' }`. See [Conditions](../guides/conditions.md). |
| `else` | `Next<D>` | `'end'` | Where to go when `if` is false. |

- An `if` whose `then` jumps backward must have an `else`; construction rejects it otherwise.

`then`: true. `else`: false.

## Next

| Form | Meaning |
|---|---|
| `'passo'` | Jump to that step id. |
| `'end'` | Finish the run here, exactly as running past the last step does — `onEnd` still decides: `'end'` ends it, `'stay'` goes back to the last talk step and answers every message from there, `'reset'` starts a fresh run. `'end'` is reserved: no step may use it as an id. |
| `{ step: 'passo', clear: ['campo'] }` | Delete the listed fields from `session.data` and forget how many times the run asked them, then jump. The way to ask something again. |
| `{ flow: 'outro', input? }` | End this run (reason `'flow'`) and start `outro` in the same turn, one hop deeper. The child gets `input`, or this run's `input` when absent. It holds the floor when this run did, or when no run did: a `mention` flow that chains does not take the message from the run it was routed to. `flow` is a template. |

Entering a step counts a visit; the visit is part of every key minted there, so a step visited twice sends twice. A `{ step }` jump to an id that no longer exists ends the run with `code: 'step-gone'`; a `{ flow }` whose template resolves to an unknown flow is skipped with `code: 'flow-gone'`. A literal flow id the agent does not have is skipped the same way, and the agent build logs a warning for it.

## Caps

| Cap | Value | What happens |
|---|---|---|
| Steps per run per turn | 50 | The run ends with reason `'failed'` and `code: 'step-loop'`. |
| Chain depth (`hop`) | 5 | A `{ flow }` or `onEnd: 'reset'` at hop 5 is skipped with `code: 'hop-limit'`. |
| Short wait | 10 s | At or under it, and followed by a `say` or talk step, a wait rides as `afterMs` instead of a wake. |
| Outcomes kept per run | 50 | Older lines fall off `run.outcomes`; `TurnResult.outcomes` is never trimmed. |

## Example

```ts
import { falai, GeminiProvider } from "@falai/agent";

const f = falai().fields({
  pedido: { type: "string", ask: "Pergunte o número do pedido." },
  resolvido: { type: "boolean", ask: "Pergunte se o problema foi resolvido." },
});

const agent = f.agent({
  name: "Léo",
  provider: new GeminiProvider({ apiKey: process.env.GEMINI_API_KEY ?? "", model: "gemini-2.5-flash" }),
  events: { reembolso_feito: f.event<{ valor: number }>() },
  actions: {
    abrir_chamado: f.action({
      parameters: { pedido: { type: "string" } },
      run: (params) => ({ ok: true, detail: `chamado aberto para ${params.pedido}` }),
    }),
  },
  flows: [
    f.flow({
      id: "suporte",
      name: "Suporte a pedidos",
      on: [{ message: ["problema com um pedido", "pedido atrasado ou errado"] }],
      steps: [
        // talk: done when `pedido` is known
        { id: "dados", collect: ["pedido"] },
        // do: the host acts; `with` is rendered
        { id: "chamado", do: "abrir_chamado", with: { pedido: "{{data.pedido}}" }, onFail: "sem-chamado" },
        // say: verbatim
        { id: "aviso", say: "Abri um chamado para o pedido {{data.pedido}}. Aviso assim que o reembolso sair." },
        // wait for an event, up to 7 days
        { id: "espera", wait: { event: "reembolso_feito", upTo: "7d" }, else: "cobra" },
        // a short wait rides as afterMs on the next message
        { id: "pausa", wait: "5s" },
        { id: "confere", collect: ["resolvido"] },
        // if: code forks; the false branch clears and asks again
        { id: "ok", if: { equals: { resolvido: true } }, then: "end", else: { step: "dados", clear: ["pedido", "resolvido"] } },
        { id: "cobra", do: "abrir_chamado", with: { pedido: "{{data.pedido}}" }, then: "end" },
        // onFail: say what broke, why, and what the lead can do now
        { id: "sem-chamado", say: "Não consegui abrir o chamado: o sistema de chamados não respondeu. Peça um atendente e eu chamo alguém da equipe para abrir na mão.", then: "end" },
      ],
    }),
  ],
});

const r = await agent.turn({ sessionId: "s1", message: "meu pedido veio errado" });
console.log(r.outcomes.map((o) => `${o.stepId}: ${o.status}`), r.llmCalls); // [ 'dados: ok' ], 2: the step asked for the order id
```

## See also

- [Branches](branches.md) for `branches[]` on talk and wait steps
- [Flow](flow.md) for `onEnd` and `while`
- [Outcomes](outcomes.md) for every code a step can emit
- [Flow control](../guides/flow-control.md) and [Actions and events](../guides/actions-and-events.md)
