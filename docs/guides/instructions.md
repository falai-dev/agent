---
title: "Instructions"
description: "Rules the model follows while it speaks: must, never and should, at agent, flow or step scope, switched on by the model or by code."
type: guide
order: 6
---

# Instructions

An instruction is one sentence the model reads before it writes a reply. You put it on the agent, on a flow or on a step, and it applies while that scope is speaking.

```ts
import { falai, GeminiProvider } from "@falai/agent";

const f = falai().fields({});

const agent = f.agent({
  name: "Bia",
  provider: new GeminiProvider({ apiKey: process.env.GEMINI_API_KEY ?? "", model: "gemini-2.5-flash" }),
  instructions: [{ kind: "never", prompt: "Nunca invente preços ou prazos." }],
  idle: { prompt: "Responda pela Loja Azul." },
});

const r = await agent.turn({ sessionId: "demo", message: "quanto custa o plano pro?" });
console.log(r.messages[0]?.text);
```

The rule reaches every reply the agent phrases. Here no flow is running, so the reply comes from `idle` — the speaker that answers when nothing holds the floor. It costs no extra model call: it is text inside the speak call the turn already makes.

## The shape

`Instruction` is defined in `src/types/flow.ts`:

```ts fragment
interface Instruction<C, D> {
  id?: string;
  kind?: "must" | "never" | "should";   // default "should"
  when?: string | string[];             // judged by the model, inside the speak call
  if?: Pred<C, D>;                      // judged by code, before the call
  prompt: Template;                     // the rule; {{data.x}}, {{context.x}} and {{input.x}} are filled in
}
```

| Field | What it does |
|---|---|
| `kind` | `must` is always done, `never` is a prohibition, `should` is a nudge. Default `should`. |
| `when` | A condition in words. The model decides whether it holds, from the conversation. One string or a list; any one of the list is enough. |
| `if` | A code predicate: a function of `PredCtx`, or its JSON form (`{ equals }`, `{ known }`, `{ silenced }`, or a named condition). Free. |
| `prompt` | The rule itself. Templates render against the collected data, the host context and the run's input. |
| `id` | Yours. The framework carries it and never reads it. |

An instruction with neither `when` nor `if` always applies.

## Three scopes and the idle speaker

| Where | Applies while |
|---|---|
| `agent.instructions` | any talk step speaks, and the idle speaker answers |
| `flow.instructions` | a talk step of that flow speaks |
| `step.instructions` | that talk step speaks |
| `idle.instructions` | the idle speaker answers (no run holds the floor) |

The speak call gets them in this order: agent, then flow, then step. For the idle speaker: agent, then idle. Only talk steps (`prompt` / `collect`) and the idle speaker phrase text, so only they carry instructions; a `say` step goes out verbatim and a `do` step never speaks.

```ts
import { falai, GeminiProvider } from "@falai/agent";

interface Ctx {
  plano: "gratis" | "pro";
  horaLocal: number;
}

const f = falai<Ctx>().fields({
  duvida: { type: "string", ask: "Pergunte qual é a dúvida, em uma frase." },
});

const agent = f.agent({
  name: "Bia",
  provider: new GeminiProvider({ apiKey: process.env.GEMINI_API_KEY ?? "", model: "gemini-2.5-flash" }),
  instructions: [
    { kind: "never", prompt: "Nunca invente preços ou prazos." },
    { kind: "must", when: "a pessoa está irritada", prompt: "Reconheça o problema antes de explicar qualquer coisa." },
    { kind: "should", if: ({ context }) => context.horaLocal >= 18 || context.horaLocal < 9, prompt: "Avise que o suporte humano volta às 9h." },
  ],
  flows: [
    f.flow({
      id: "duvidas",
      name: "Dúvidas",
      on: [{ message: [] }],
      instructions: [{ kind: "should", prompt: "Responda em até três frases." }],
      steps: [
        { id: "qual", collect: ["duvida"] },
        {
          id: "resposta",
          prompt: "Responda a dúvida.",
          instructions: [{ kind: "must", prompt: "Termine perguntando se ficou claro." }],
        },
      ],
    }),
  ],
});

const r = await agent.turn({ sessionId: "demo", context: { plano: "gratis", horaLocal: 21 }, message: "quanto custa?" });
console.log(r.messages[0]?.text);
```

On this turn the step `qual` speaks. Its prompt carries all three agent rules: the `never`, the `must` with its `when` appended for the model to judge, and the `should`, because it is 21h. The flow's three-sentence rule goes in beside them. The `resposta` step's rule waits for its own step.

## `if` runs first, in code

Before the speak call, the framework drops every instruction whose `if` is false. This happens in code, with no model call. The predicate sees a `PredCtx`:

```ts fragment
interface PredCtx<C, D, P> {
  context: C;          // the host context passed to turn()
  data: Partial<D>;    // the collected data so far
  input: P;            // the speaking run's input; undefined for the idle speaker
  run?: Run;           // the speaking run; absent for the idle speaker
  silenced?: string;   // the host's reason the assistant cannot speak, when it cannot
  now: Date;
}
```

The JSON form works too, and it is the only form a flow stored as JSON can carry (see [flows from JSON](./flows-from-json.md)):

```ts
import { falai, GeminiProvider } from "@falai/agent";

interface Ctx {
  lead: { tags: string[] };
}

const f = falai<Ctx>().fields({
  nome: { type: "string", ask: "Pergunte o nome." },
});

const agent = f.agent({
  name: "Ana",
  provider: new GeminiProvider({ apiKey: process.env.GEMINI_API_KEY ?? "", model: "gemini-2.5-flash" }),
  conditions: {
    tagsAny: f.condition((ctx, tags: string[]) => tags.some((t) => ctx.context.lead.tags.includes(t))),
  },
  instructions: [
    { kind: "should", if: { tagsAny: ["vip"] }, prompt: "Ofereça falar com o gerente." },
    { kind: "should", if: { known: ["nome"] }, prompt: "Chame a pessoa pelo nome." },
  ],
  idle: { prompt: "Responda pela empresa." },
});

const r = await agent.turn({ sessionId: "demo", context: { lead: { tags: ["vip"] } }, message: "oi" });
console.log(r.llmCalls); // 1
```

A named condition the agent does not register fails with a `FlowConfigurationError`. On a flow or a step it fails when you build the agent. On the agent itself it fails on the first turn that phrases a reply.

Use `if` for anything the code already knows: the plan, the hour, a tag, a field being known. Use `when` only for what needs the conversation to judge: tone, intent, a topic. One form never fires here: `{ silenced: true }` is always false on an instruction, because a silenced turn phrases nothing and reads no instruction at all. Put it on a trigger, an `if` step or a branch instead — those still run while the gate is closed.

## `when` goes to the model as text

An instruction that survives `if` is rendered into one section of the speak prompt:

```text
## Instructions
- [never] [Always] Nunca invente preços ou prazos.
- [must] [Always] Reconheça o problema antes de explicar qualquer coisa. (apply only when: a pessoa está irritada)
- [should] [Always] Avise que o suporte humano volta às 9h.
- [should] [Always] Responda em até três frases.
```

One line per instruction: the kind in brackets, the rule, and `when` appended as `(apply only when: …)`. A list of `when` strings is joined with ` OR `. Templates are filled in before rendering; an instruction whose prompt renders to nothing is left out.

Two consequences:

- Instructions reach the speak call only. The understand call (routing, mentions, extraction) never sees them. A turn that phrases nothing, because it is silenced or because a `say` step already answered, renders none of them and spends nothing on them.
- The framework does not report which `when` clauses the model judged true. If you need to see what reached the prompt, drive the agent with a scripted provider and read the prompt it received (see [testing](./testing.md)).

## Where instructions are not the tool

- A fixed sentence that must go out word for word is a `say` step, not a `must`.
- A decision the code can make is an `if` step or a branch, not a `should`. Movement belongs to the flow; see [flow control](./flow-control.md).
- Who the agent is and what it wants live in `persona` and `goal` on the agent; facts it should know live in `knowledgeBase`. Instructions are for how it behaves in a situation.

See [the instruction reference](../reference/instruction.md) for the type as exported, and [conditions](./conditions.md) for `when` versus `if` across triggers, branches and steps.
