---
title: "Your first agent"
description: "Build Ana from one field and one flow, run one turn and learn the six words the rest of the docs use."
type: tutorial
order: 2
---

# Your first agent

This is `examples/01-quickstart.ts`, the file you ran on the last page. Save it as `ana.ts`:

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

const r = await agent.turn({ sessionId: "demo", message: "oi" });
console.log(r.messages[0]?.text);
```

```bash
GEMINI_API_KEY=your-key bun run ana.ts
```

Ana says hello and asks your name. The file has four parts: fields, a flow, an agent, a turn.

## Fields

```ts fragment
const f = falai().fields({
  nome: { type: "string", ask: "Pergunte o nome da pessoa, sem tom de formulário." },
});
```

A field is one piece of data Ana can collect. You declare every field once, on the agent, with a `type` and an `ask`. The `ask` is not the question itself; it tells the model how to ask, and the model phrases it to fit the conversation.

`f` is your toolkit. Everything you build from it (`f.flow`, `f.agent`, later `f.action`) knows the field names, so `collect: ["nmoe"]` is a compile error, not a bug found in production.

## The flow

```ts fragment
f.flow({
  id: "boas-vindas",
  name: "Boas-vindas",
  on: [{ message: [] }],
  steps: [
    { id: "nome", collect: ["nome"] },
    { id: "ajuda", prompt: "Agradeça pelo nome e pergunte como pode ajudar." },
  ],
})
```

A flow is a trigger plus an ordered list of steps.

- `on` holds the triggers: when a run of this flow starts. `{ message: [] }` means "when the customer writes". The empty list is a catch-all; put phrases in it once you have a second flow, and the model routes between them — see [Triggers](../guides/triggers.md).
- `steps` run in order. Both steps here are talk steps: the model speaks. `collect` lists the fields the step needs; `prompt` is a guideline for what to say. A step may have one or both.
- `id` is required on the flow and on every step. No step may be called `end`: that word, used as a `then` or `else` target, ends the run. Ids are stable names the framework uses in keys and logs.

## The agent

```ts fragment
const agent = f.agent({
  name: "Ana",
  provider: new GeminiProvider({ apiKey: process.env.GEMINI_API_KEY ?? "", model: "gemini-2.5-flash" }),
  flows: [/* the flow above */],
});
```

One agent serves every conversation. Nothing about one customer lives inside it: the conversation's state arrives on each turn and comes back changed. `name` is how Ana calls herself in the prompt; `provider` is the class from the install page.

## The turn

```ts fragment
const r = await agent.turn({ sessionId: "demo", message: "oi" });
```

`turn()` is the one entry point. You hand it what just happened (here: a message) and it hands back what to do. The result `r` has:

| Field | What it is |
|---|---|
| `r.messages` | What to send. Each has `text`, `kind` (`"ai"` phrased by the model, `"verbatim"` from a `say` step), `afterMs` and a `key`. |
| `r.schedule` | Timers to put in your queue. Empty here; page 5 uses it. |
| `r.llmCalls` | Model calls this turn spent. Here: 1. A text turn costs at most 2, plus one per tool round. |
| `r.session` | The conversation's state: collected `data`, live `runs`. You keep it and pass it back next time. |
| `r.changed` | `false` means nothing happened: save nothing, send nothing. |
| `r.outcomes` | One line per step, your execution log. |
| `r.started`, `r.ended` | Runs that began or finished this turn, with the flow id and, for `ended`, a `reason`. |
| `r.skipped` | Triggers that matched but did not start a run, with the reason (`code: 'already-claimed'`, …). |

The framework never sends and never saves. Both are your job, and [Go to production](./05-go-to-production.md) shows the loop.

## The second turn

Pass `r.session` back as `session` and Ana continues where she stopped. Add to the end of `ana.ts`:

```ts fragment
const second = await agent.turn({ sessionId: "demo", session: r.session, message: "sou a Bia" });
console.log(second.session.data); // { nome: "Bia" }
console.log(second.messages[0]?.text); // Ana thanks Bia and asks how she can help
console.log(second.llmCalls); // 2
```

What happened inside, in order:

1. The model read "sou a Bia" and found `nome`. That is the understand call.
2. Code saw that the `nome` step has nothing left to collect and moved the run to `ajuda`.
3. The model phrased the `ajuda` prompt. That is the speak call.
4. `ajuda` was the last step, so the run ended. `second.session.runs` is empty.

Two calls, and the code decided every movement. The model never chooses which step comes next.

The first turn spent one call. There was one flow and no phrases to route by, and no step was asking yet, so the understand call had no work and was skipped. On the second turn the `nome` step was asking, so the understand call ran to read the reply. Rule of thumb: the understand call runs only when there is routing or a field to read; the speak call runs whenever Ana says something. [The turn](../concepts/pipeline.md) has the exact rules.

## The six words

| Word | Meaning | In this file |
|---|---|---|
| flow | a trigger plus an ordered list of steps | `boas-vindas` |
| trigger | when a run of the flow starts | `{ message: [] }` |
| step | one thing a run does: talk, `say`, `do`, `wait` or `if` | `nome`, `ajuda` |
| field | one piece of data, declared once on the agent | `nome` |
| run | one live execution of a flow inside a session | started on turn 1, ended on turn 2 |
| turn | one call to `agent.turn()`: one input in, messages and timers out | two of them |

Two more things you will meet soon.

A message flow starts once per session by default, so a third "oi" does not start `boas-vindas` again. `repeat: "always"` on the trigger changes that.

When no run is asking anything, Ana still answers. This is the idle speaker. It replies as Ana with no flow or step behind it: the agent's `name`, `persona`, `goal`, `knowledgeBase` and agent-level instructions, and nothing from a flow. `idle: { prompt: "..." }` on the agent gives it a guideline; `idle: "silent"` mutes it.

Next: [Collect data](./03-collect-data.md) gives Ana four fields and a confirmation.
