---
title: "Tool"
description: "A typed function the model may call while it speaks; it returns a value for the model and data for the session, and never moves the run."
type: reference
order: 9
---

# Tool

A tool is a function the model may call in the middle of phrasing a reply: look up a price, check a calendar, book a room. The model picks the tool and its arguments; your handler runs; the result goes back to the model; the model answers. A tool returns `{ value?, data? }` and nothing else. `value` is what the model reads. `data` is written into the session's collected fields. Movement between steps belongs to the flow, never to a tool.

Source: `src/types/tool.ts`, `src/core/Speak.ts`, `src/core/Runner.ts` (`speakRequest`), `src/types/agent.ts` (`maxToolLoops`).

## Signature

```ts fragment
interface Tool<C = unknown, D = unknown> {
  id: string;
  description?: string;
  parameters?: StructuredSchema;
  handler(args: Record<string, unknown>, ctx: ToolCtx<C, D>): ToolResult<D> | Promise<ToolResult<D>>;

  isConcurrencySafe?(input: Record<string, unknown>): boolean;
  isReadOnly?(input: Record<string, unknown>): boolean;
  isDestructive?(input: Record<string, unknown>): boolean;
  maxResultSizeChars?: number;
  validateInput?(input: Record<string, unknown>, ctx: ToolCtx<C, D>): ToolValidationResult | Promise<ToolValidationResult>;
  checkPermissions?(input: Record<string, unknown>, ctx: ToolCtx<C, D>): ToolPermissionResult | Promise<ToolPermissionResult>;
}

interface ToolCtx<C = unknown, D = unknown> {
  context: C;
  data: Partial<D>;
  history: History;
  run?: Run;
  now: Date;
}

interface ToolResult<D = unknown> {
  value?: unknown;
  data?: Partial<D>;
}

interface ToolValidationResult {
  valid: boolean;
  error?: string;
  correctedInput?: Record<string, unknown>;
}

interface ToolPermissionResult {
  allowed: boolean;
  reason?: string;
}
```

## Tool fields

| Field | Type | Default | Meaning |
|---|---|---|---|
| `id` | `string` | required | The name the model calls, and the name a `tools: [...]` list uses to point at this tool. Ids are not checked for uniqueness: two tools with one id are both sent to the provider, and the first one's handler runs for any call under that id. |
| `description` | `string` | none | What the tool does and when to use it, for the model. |
| `parameters` | `StructuredSchema` | none | A JSON schema for `args`, passed to the provider as given. |
| `handler` | `(args, ctx) => ToolResult \| Promise<ToolResult>` | required | Your code. Returning nothing counts as `{}`. |
| `isReadOnly` | `(input) => boolean` | none | The call only reads. Used as the fallback for `isConcurrencySafe`. |
| `isConcurrencySafe` | `(input) => boolean` | falls back to `isReadOnly`, then `false` | The call may run in parallel with other safe calls of the same round. |
| `isDestructive` | `(input) => boolean` | none | The call cannot be undone. A destructive call never runs in parallel. |
| `maxResultSizeChars` | `number` | none (no cut) | Longest `value` the model gets. Beyond it, the text is cut and ends with `[truncated: N chars total, showing the first M]`. |
| `validateInput` | `(input, ctx) => ToolValidationResult` | none | Runs first. On `valid: false` the handler is skipped and the model reads `{"error":"Validation failed: <error>","correctedInput":…}`. |
| `checkPermissions` | `(input, ctx) => ToolPermissionResult` | none | Runs after validation. On `allowed: false` the handler is skipped and the model reads `{"error":"Permission denied: <reason>"}`. |

## ToolCtx fields

| Field | Type | Meaning |
|---|---|---|
| `context` | `C` | The host context of this turn. |
| `data` | `Partial<D>` | The session's fields at the start of the speak call, plus every `data` patch earlier tool rounds of this same call returned. |
| `history` | `History` | The history the model sees: the host's history for this turn, plus the assistant and tool items of earlier rounds in this call. |
| `run` | `Run \| undefined` | The run whose talk step is speaking. Absent when the idle speaker is the one calling. |
| `now` | `Date` | The agent's clock. |

## ToolResult fields

| Field | Type | What happens |
|---|---|---|
| `value` | `unknown` | Serialized for the model: a string as is, anything else through `JSON.stringify`, `undefined` as `{"ok":true}`. Cut at `maxResultSizeChars` when set. |
| `data` | `Partial<D>` | Merged into the session's fields when the turn settles, as given: no type coercion, no `enum` check. A field a `collect` step is waiting for counts as known once a tool writes it, so the step can end without the customer saying it. |

## Which tools the model sees

The list is an allow-list of tool ids, resolved once per speak call:

| Speaker | List used |
|---|---|
| A talk step | `step.tools`, else `flow.tools`, else every tool on the agent. |
| The idle speaker | `idle.tools`, else every tool on the agent. |

An empty list (`tools: []`) means no tools. Every name in a list must be a registered tool id; `validateFlow` throws `FlowConfigurationError` for a step or flow list, and the agent constructor throws for `idle.tools`.

The agent's `maxToolLoops` (default 5, from `src/types/agent.ts`) caps the rounds. `maxToolLoops: 0` sends no tools at all, whatever the lists say.

## Rounds

One speak call is a loop of provider rounds:

1. Each of the first `maxToolLoops` rounds offers the tools. The model may answer, call tools, or both.
2. When it calls tools, each call goes through the gates below and its result becomes a `tool` history item. The model is asked again with that history.
3. When it calls no tools, the loop ends and its message is the reply.
4. After `maxToolLoops` rounds with calls, one more round runs with no tools and a "wrap up" section, so a message always comes back.

Every round is one model call and counts in `TurnResult.llmCalls`. A text turn therefore costs one understand call plus one call per speak round: up to `maxToolLoops` rounds with tools and one to wrap up, so six speak calls with the default, seven model calls in all. A round that fails at the provider, or a final message that is empty, defers the talk step: see [Outcomes](./outcomes.md), `code: 'provider-unavailable'`.

Within a round, consecutive calls that are safe (not destructive, and `isConcurrencySafe` true; when `isConcurrencySafe` is not defined, `isReadOnly` true) run together with `Promise.all`; any other call runs alone, in order. `data` patches merge in call order, not in the order the calls finished. Field values the model reports in its structured reply are checked and coerced; tool `data` is not.

## Gates, in order

| Situation | What the model reads | Handler runs |
|---|---|---|
| The id is not in this call's list | `{"error":"Tool \"x\" is not available."}` | no |
| `validateInput` returns `valid: false` | `{"error":"Validation failed: <error or 'invalid input'>","correctedInput":…}` | no |
| `checkPermissions` returns `allowed: false` | `{"error":"Permission denied: <reason or 'not allowed'>"}` | no |
| The handler throws | `{"error":"<message>"}` | yes, and failed |
| The handler returns | `value`, serialized | yes |

Nothing a tool does reaches the host as an exception. The speak call never throws for a tool.

## Tool rounds in the history

Inside a call, a round is recorded as one assistant item with `tool_calls` (ids `call-<round>-<index>`, any text the model wrote beside the calls as `content`, else `null`) followed by one `tool` item per call. These items live for the duration of the speak call; the framework returns `messages[]`, not history, so your own history is what you save.

The exported `ToolCall` type belongs to the event-style history the conversion helpers (`eventsToHistory`, `historyToEvents`) read and write:

```ts fragment
interface ToolCall<TArgs = unknown, TResult = unknown> {
  tool_id: string;
  arguments: TArgs;
  result: { data: TResult; meta?: Record<string, unknown> };
}
```

It is a record of a call that already happened, for hosts that store history as events. The framework does not build it during a turn.

## Streaming

`agent.turnStream()` streams every round's text as it arrives. Tools run between rounds exactly as above; the last chunk carries the same `TurnResult`. Text the model writes beside a tool call reaches the stream but not the final message.

## Example

```ts
import { falai, GeminiProvider, type DataOf, type Tool } from "@falai/agent";

const f = falai().fields({
  cidade: { type: "string", ask: "Pergunte em qual cidade a pessoa quer ficar." },
  reserva: { type: "string", description: "Código da reserva" },
});

// The smallest tool that works: one argument in, one value out. `value` is what the model reads back.
const preco: Tool = {
  id: "preco",
  description: "Preço da diária em uma cidade.",
  parameters: { type: "object", properties: { cidade: { type: "string" } }, required: ["cidade"] },
  handler: () => ({ value: { precoNoite: 420 } }),
};

type Data = DataOf<typeof f>;

// A bigger one: it checks its input, never runs in parallel, and writes a field.
const reservar: Tool<undefined, Data> = {
  id: "reservar",
  description: "Confirma a reserva e devolve o código.",
  parameters: { type: "object", properties: { cidade: { type: "string" } }, required: ["cidade"] },
  isDestructive: () => true,
  validateInput: (args) =>
    typeof args.cidade === "string" && args.cidade.length > 0
      ? { valid: true }
      : { valid: false, error: "Informe a cidade." },
  handler: (_args, ctx) => {
    const codigo = `RES-${ctx.now.getTime().toString(36).toUpperCase()}`;
    // `data` lands in the session: the `confirma` step ends once `reserva` is known.
    return { value: { codigo }, data: { reserva: codigo } };
  },
};

const agent = f.agent({
  name: "Concierge",
  provider: new GeminiProvider({ apiKey: process.env.GEMINI_API_KEY ?? "", model: "gemini-2.5-flash" }),
  tools: [preco, reservar],
  flows: [
    f.flow({
      id: "hospedagem",
      name: "Hospedagem",
      on: [{ message: ["quer reservar um quarto"] }],
      steps: [
        { id: "onde", collect: ["cidade"] },
        // Only this step may call `preco`.
        { id: "oferta", prompt: "Apresente o preço da diária. Pergunte se pode reservar.", tools: ["preco"] },
        { id: "confirma", prompt: "Se a pessoa confirmou, reserve e informe o código.", collect: ["reserva"], tools: ["reservar"] },
      ],
    }),
  ],
});

const r = await agent.turn({ sessionId: "demo", message: "Quero um quarto em Curitiba" });
console.log(r.messages[0]?.text, r.llmCalls);
```

## See also

- [Add tools](../start/04-add-tools.md): tools the model calls versus actions the flow runs.
- [Actions, events, conditions](./actions-events-conditions.md): the `do` step's side of the same line.
- [Streaming](../guides/streaming.md): tool rounds inside `turnStream`.
- [Agent](./agent.md): `tools`, `maxToolLoops` and `idle`.
