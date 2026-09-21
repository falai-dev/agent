---
title: "Instruction"
description: "One rule the model follows while it speaks, gated by an AI-judged `when` or a code-judged `if`, at agent, flow, step or idle scope."
type: reference
order: 8
---

# Instruction

An instruction is one sentence the model obeys while it speaks: "never invent prices", "answer in three sentences". It has a `kind` (`must`, `never`, `should`), a `prompt`, and two optional tests: `when`, a string the model judges, and `if`, a predicate your code judges, which costs no model call. The same shape goes on the agent, a flow, a talk step or the idle speaker; only its place in the configuration changes.

Source: `src/types/flow.ts`, `src/core/Runner.ts` (`speakRequest`), `src/core/Prompt.ts` (`instructionsSection`).

## Signature

```ts fragment
interface Instruction<C = unknown, D = unknown> {
  id?: string;
  kind?: "must" | "never" | "should";
  when?: string | string[];
  if?: Pred<C, D>;
  prompt: Template;
}
```

## Fields

| Field | Type | Default | Meaning |
|---|---|---|---|
| `id` | `string` | none | Yours. The framework carries it and never reads it. |
| `kind` | `"must" \| "never" \| "should"` | `"should"` | How hard the rule is. `must` is a hard rule, `never` a hard ban, `should` a preference. The word is written into the prompt as is. |
| `when` | `string \| string[]` | none | When the rule applies, judged by the model from the conversation. Several strings are alternatives (OR). Rendered into the prompt as text; it never costs a call of its own. |
| `if` | `Pred<C, D>` | none | When the rule applies, judged by code. A function or a JSON `ConditionSpec`. False: the instruction is left out of this call. |
| `prompt` | `Template` | required | The rule. `{{data.x}}`, `{{context.x}}` and `{{input.x}}` are filled in first. |

## Scopes

| Scope | Where | Applies |
|---|---|---|
| Agent | `AgentOptions.instructions` | On every speak call, talk steps and the idle speaker alike. |
| Flow | `Flow.instructions` | While a talk step of that flow speaks. |
| Step | `TalkStep.instructions` | While that step speaks. |
| Idle | `Idle.instructions` (`idle: { prompt, instructions }`) | While the idle speaker answers. |

The list the model sees is built in this order: agent, then flow, then step. For the idle speaker: agent, then idle. Duplicates are kept: the same sentence in two scopes appears twice.

## Behaviour

- Instructions reach the **speak call only**. The understand call (routing, mentions, branches, extraction) never sees them.
- `if` is judged by code when the speak request is built, with a `PredCtx` of `{ context, data, input, run, silenced, now }`. `run` is the speaking run; while the idle speaker answers, `run` is absent and `input` is `undefined` for every instruction it judges — agent-level and `idle`-level alike. Write `if` predicates on the agent and on `idle` so they work without a run.
- `when` is not judged by code. It is appended to the line as `(apply only when: a OR b)` and the model decides.
- Each surviving instruction becomes one line under a `## Instructions` heading, in this exact form:

  ```text
  - [should] [Always] Responda em até três frases.
  - [must] [Always] Reconheça o problema antes de explicar qualquer coisa. (apply only when: a pessoa está irritada)
  ```

  The first bracket is `kind` (or `should` when absent). The second is the group caption. Every scope goes into one group captioned `[Always]`, so the caption does not say which scope a line came from.
- `prompt` is rendered with the turn's `data`, `context` and the run's `input`, then trimmed. A line that renders to nothing is dropped. When no line survives, the whole section is left out.
- Instructions have no effect on movement, extraction or which flow starts. They shape wording only.
- In a stored flow (`FlowSpec`) an instruction is an `InstructionSpec`: the same fields with `if` in JSON form. `flowSpecSchema` lets a model write flow-level instructions and leaves step-level ones out.

## Example

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
    // The model judges `when` from the conversation.
    { kind: "must", when: "a pessoa está irritada", prompt: "Reconheça o problema antes de explicar qualquer coisa." },
    // Code judges `if`; it costs nothing. No `run` here, so read only `context` and `data`.
    {
      kind: "should",
      if: ({ context }) => context.horaLocal >= 18 || context.horaLocal < 9,
      prompt: "Avise que o suporte humano volta às 9h.",
    },
  ],
  flows: [
    f.flow({
      id: "duvidas",
      name: "Dúvidas",
      on: [{ message: [] }], // no examples: the catch-all, starts when no other message flow wins
      // Applies to every talk step of this flow.
      instructions: [{ kind: "should", prompt: "Responda em até três frases." }],
      steps: [
        { id: "qual", collect: ["duvida"] },
        {
          id: "resposta",
          prompt: "Responda a dúvida.",
          // Applies to this step only.
          instructions: [{ kind: "must", prompt: "Termine perguntando se ficou claro." }],
        },
      ],
    }),
  ],
});

const r = await agent.turn({
  sessionId: "demo",
  context: { plano: "gratis", horaLocal: 21 },
  message: "quanto custa o plano pro?",
});
console.log(r.messages[0]?.text);
```

## See also

- [Instructions](../guides/instructions.md): choosing a scope and a kind.
- [Conditions](../guides/conditions.md): `when` versus `if`.
- [Actions, events, conditions](./actions-events-conditions.md): `Pred`, `PredCtx` and `ConditionSpec`.
- [Agent](./agent.md): `AgentOptions.instructions`, `idle`, `persona` and `goal`.
