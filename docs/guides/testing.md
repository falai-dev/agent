---
title: "Testing"
description: "A clock you hold still, a scheduler you fire by hand, a store in memory and a provider you script: everything a turn needs, with no network."
type: guide
order: 12
---

# Testing

The core does no I/O beyond the provider and your actions, so a test drives a real `Agent` with four fakes. Start with the clock.

```ts
import { fakeClock } from "@falai/agent";

const clock = fakeClock("2026-09-20T10:00:00.000Z");
clock.advance("24h");
console.log(clock.now().toISOString()); // 2026-09-21T10:00:00.000Z
```

Pass `clock` to the agent and every `now`, every wake time and every key that carries a timestamp comes from it. The core never reads `Date.now()`.

## The four fakes

| Fake | From | What it replaces |
|---|---|---|
| `fakeClock(iso)` | `@falai/agent` | time: `now()`, `advance("2d" \| ms)`, `set(iso)` |
| `MemoryScheduler` | `@falai/agent` | your queue: `add(entry)`, `remove(key)`, `size`, `due(now)` returns and removes what is due, earliest first; a new entry with the same key replaces the old one, and `replaces` removes that key |
| `MemoryStore` | `@falai/agent` | your database, with the same version check |
| a scripted `AiProvider` | you write it, about 25 lines | the model |

The snippets below use `node:assert/strict` so they run under `bun run` or `node` with no framework. The repo's own tests use `bun test` the same way.

## A scripted provider

The framework names each call through `parameters.schemaName`: `"understand"` for the call that judges the customer's message, `"speak"` for the call that phrases the reply. A scripted provider keeps one queue per name, shifts the next reply off it, and throws when a queue runs dry, so a turn that spends a call you did not expect fails loudly.

```ts
import type { AiProvider, GenerateMessageInput, GenerateMessageOutput, GenerateMessageStreamChunk } from "@falai/agent";

type Reply = Record<string, unknown>;

export interface Scripted extends AiProvider {
  /** Every call's schema name, in order. */
  calls: string[];
}

export function scripted(script: { understand?: Reply[]; speak?: Reply[] }): Scripted {
  const queues: Record<string, Reply[]> = { understand: [...(script.understand ?? [])], speak: [...(script.speak ?? [])] };
  const calls: string[] = [];

  function next<T>(input: GenerateMessageInput): GenerateMessageOutput<T> {
    const name = input.parameters?.schemaName ?? "(unnamed)";
    calls.push(name);
    const reply = queues[name]?.shift();
    if (!reply) throw new Error(`no scripted "${name}" reply left for call #${calls.length}`);
    const message = typeof reply.message === "string" ? reply.message : JSON.stringify(reply);
    return { message, structured: reply as T };
  }

  return {
    name: "scripted",
    calls,
    capabilities: { supportsTools: true, supportsNativeJsonSchema: true, supportsStreaming: true, supportsStreamingToolCalls: true, supportsPromptCaching: false },
    generateMessage: <_C, T>(input: GenerateMessageInput) => Promise.resolve().then(() => next<T>(input)),
    // eslint-disable-next-line @typescript-eslint/require-await -- one chunk, nothing to await
    async *generateMessageStream<_C, T>(input: GenerateMessageInput): AsyncGenerator<GenerateMessageStreamChunk<T>> {
      const out = next<T>(input);
      yield { delta: out.message, accumulated: out.message, done: true, structured: out.structured };
    },
  };
}
```

The two envelopes you script, as the framework reads them:

```ts fragment
// understand: every section present, empty when there is nothing to say
{
  flows: { triagem: 90 },                 // flowId → 0–100 fit of the message to the flow
  mentions: { concorrente: true },        // flowId → the customer brought it up
  extract: { concorrente: { trecho: "a Acme cobra metade" } },  // flowId → values for the mention's `extract`
  branches: {},                           // "runId/stepId/index" → the `when` holds
  fields: { nome: "Ana" },                // field → the raw value the customer gave
}

// speak: the message, then one property per pending field, null when the customer did not give it
{ message: "Oi Ana! De qual empresa você fala?", empresa: null }

// speak, calling a tool first: the next scripted speak reply answers after the tool ran
{ toolCalls: [{ toolName: "orcamento", arguments: { pessoas: 30 } }] }
```

A `fields` value goes through the same coercion as production: `"sim"` becomes `true` for a boolean, `"1,5"` becomes `1.5` for a number, `"mil"` is dropped with the outcome `code: 'bad-value'`, and an enum value outside the list is dropped with `code: 'not-in-enum'`.

## One test, end to end

A triage flow that collects two fields and a silence flow that nudges after 24 hours. The test asserts the call count, the message keys, the wake key, then fires the wake through the scheduler.

```ts
import assert from "node:assert/strict";
import { falai, fakeClock, MemoryScheduler, MemoryStore, type AiProvider, type DataOf, type GenerateMessageInput, type GenerateMessageOutput, type GenerateMessageStreamChunk, type TurnKind } from "@falai/agent";

// The scripted provider from above, inlined so this file stands alone.
type Reply = Record<string, unknown>;
function scripted(script: { understand?: Reply[]; speak?: Reply[] }): AiProvider & { calls: string[] } {
  const queues: Record<string, Reply[]> = { understand: [...(script.understand ?? [])], speak: [...(script.speak ?? [])] };
  const calls: string[] = [];
  function next<T>(input: GenerateMessageInput): GenerateMessageOutput<T> {
    const name = input.parameters?.schemaName ?? "(unnamed)";
    calls.push(name);
    const reply = queues[name]?.shift();
    if (!reply) throw new Error(`no scripted "${name}" reply left for call #${calls.length}`);
    return { message: typeof reply.message === "string" ? reply.message : JSON.stringify(reply), structured: reply as T };
  }
  return {
    name: "scripted",
    calls,
    capabilities: { supportsTools: true, supportsNativeJsonSchema: true, supportsStreaming: true, supportsStreamingToolCalls: true, supportsPromptCaching: false },
    generateMessage: <_C, T>(input: GenerateMessageInput) => Promise.resolve().then(() => next<T>(input)),
    // eslint-disable-next-line @typescript-eslint/require-await -- one chunk, nothing to await
    async *generateMessageStream<_C, T>(input: GenerateMessageInput): AsyncGenerator<GenerateMessageStreamChunk<T>> {
      const out = next<T>(input);
      yield { delta: out.message, accumulated: out.message, done: true, structured: out.structured };
    },
  };
}

const T0 = "2026-09-20T10:00:00.000Z";
const f = falai().fields({
  nome: { type: "string", ask: "Pergunte o nome de um jeito leve." },
  empresa: { type: "string", ask: "Pergunte de qual empresa a pessoa fala." },
});
type Data = DataOf<typeof f>;

const triagem = f.flow({
  id: "triagem",
  name: "Triagem",
  on: [{ message: ["quer saber como funciona", "pede um orçamento"] }],
  steps: [
    { id: "quem", prompt: "Descubra quem é e de onde fala.", collect: ["nome", "empresa"] },
    { id: "tchau", prompt: "Agradeça e diga que um vendedor continua daqui." },
  ],
});

const retomar = f.flow({
  id: "retomar",
  name: "Retomar quem sumiu",
  on: [{ silence: "24h" }],
  steps: [
    { id: "p1", prompt: "Retome a conversa de forma leve e pergunte se ainda faz sentido." },
    { id: "w1", wait: "2d", else: "end" },
    { id: "p2", prompt: "Última tentativa, curta e sem pressão." },
  ],
});

const clock = fakeClock(T0);
const provider = scripted({
  understand: [{ flows: {}, mentions: {}, extract: {}, branches: {}, fields: { nome: "Ana" } }],
  speak: [{ message: "Oi Ana! De qual empresa você fala?", empresa: null }, { message: "Oi Ana, ainda faz sentido conversarmos?" }],
});
const agent = f.agent({ name: "Ana", provider, clock, flows: [triagem, retomar] });
const store = new MemoryStore<Data>();
const scheduler = new MemoryScheduler();

async function runTurn(input: TurnKind & { sessionId: string }) {
  const session = await store.load(input.sessionId);
  const r = await agent.turn({ ...input, session: session ?? undefined, history: [] });
  if (r.changed) {
    await store.save(r.session, session?.version ?? 0);
    for (const entry of r.schedule) scheduler.add(entry);
  }
  return r;
}

// Turn 1: the customer writes. Understand extracts the name (1 call), speak asks for the company (1 call).
const t1 = await runTurn({ sessionId: "s1", message: "oi, sou a Ana, quero saber como funciona", id: "m1" });
assert.equal(t1.llmCalls, 2);
assert.deepEqual(provider.calls, ["understand", "speak"]);
assert.equal(t1.session.data.nome, "Ana");
assert.equal(t1.messages[0]?.key, "triagem#m1:quem:1"); // ${runId}:${stepId}:${visit}
assert.equal(t1.outcomes.find((o) => o.kind === "collect")?.status, "ok");
// The assistant spoke last: the silence flow armed a wake for 24h from now.
const silenceKey = `silence:retomar:s1:${Date.parse(T0)}`;
assert.deepEqual(t1.schedule.map((s) => s.key), [silenceKey]);
assert.equal(scheduler.size, 1);

// 23h later nothing is due; at 24h the wake fires.
clock.advance("23h");
assert.equal(scheduler.due(clock.now()).length, 0);
clock.advance("1h");
const due = scheduler.due(clock.now());
assert.deepEqual(due.map((d) => d.key), [silenceKey]);

// Turn 2: the wake starts `retomar`, which speaks first (1 call) and parks on w1.
const t2 = await runTurn({ sessionId: "s1", wake: due[0].key });
assert.equal(t2.llmCalls, 1);
assert.deepEqual(t2.started.map((s) => s.flowId), ["retomar"]);
assert.equal(t2.messages[0]?.key, `retomar#${Date.parse(T0)}:p1:1`);
assert.deepEqual(t2.outcomes.find((o) => o.stepId === "w1"), {
  runId: `retomar#${Date.parse(T0)}`,
  flowId: "retomar",
  stepId: "w1",
  key: `retomar#${Date.parse(T0)}:w1:1`,
  kind: "wait",
  status: "waiting",
  until: new Date(clock.now().getTime() + 2 * 86_400_000).toISOString(),
  at: clock.now().toISOString(),
});
assert.deepEqual(t2.schedule.map((s) => s.key), [`retomar#${Date.parse(T0)}:w1:${clock.now().getTime() + 2 * 86_400_000}`]);
// Triagem still holds its question: the nudge did not take the floor for good.
assert.equal(t2.session.runs.find((r) => r.flowId === "triagem")?.status, "asking");
assert.equal((await store.load("s1"))?.version, 2);

console.log("ok");
```

What each assertion pins down:

- `llmCalls` is the budget. A turn that spends more than you scripted throws inside the provider, so an unexpected third call cannot pass silently. `usage` is absent in tests unless your scripted provider reports token counts — real providers do, and the turn adds them up.
- `messages[].key` is `${runId}:${stepId}:${visit}`, and `runId` is `${flowId}#${triggerKey}`. The trigger key of a message turn is the message `id` you passed; of a silence wake, the `lastAssistantAt` timestamp in milliseconds.
- `schedule[].key` is what your queue job carries (its id is the key encoded, since BullMQ refuses a `:` in one) and what you pass back as `wake`. The silence key is `silence:${flowId}:${sessionId}:${ms}`; a timer wait's key is `${runId}:${stepId}:${atMs}`.
- `outcomes[]` is the execution log, one line per step. Assert on `code`, which is stable across versions, not on `message`, the English sentence beside it; see [outcomes](../reference/outcomes.md).

## Replaying the same input

The keys are deterministic: the same input on the same session version mints the same run id, the same message keys and the same wake keys. That is what makes a `SessionConflictError` safe to replay and a duplicate webhook harmless. Prove it with two agents that share a clock:

```ts
import assert from "node:assert/strict";
import { falai, fakeClock, type AiProvider, type GenerateMessageInput, type GenerateMessageOutput, type GenerateMessageStreamChunk } from "@falai/agent";

type Reply = Record<string, unknown>;
function scripted(speak: Reply[]): AiProvider {
  const queue = [...speak];
  function next<T>(input: GenerateMessageInput): GenerateMessageOutput<T> {
    if (input.parameters?.schemaName !== "speak") throw new Error(`unexpected ${input.parameters?.schemaName ?? "unnamed"} call`);
    const reply = queue.shift();
    if (!reply) throw new Error("no scripted speak reply left");
    return { message: String(reply.message), structured: reply as T };
  }
  return {
    name: "scripted",
    capabilities: { supportsTools: true, supportsNativeJsonSchema: true, supportsStreaming: true, supportsStreamingToolCalls: true, supportsPromptCaching: false },
    generateMessage: <_C, T>(input: GenerateMessageInput) => Promise.resolve().then(() => next<T>(input)),
    // eslint-disable-next-line @typescript-eslint/require-await -- one chunk, nothing to await
    async *generateMessageStream<_C, T>(input: GenerateMessageInput): AsyncGenerator<GenerateMessageStreamChunk<T>> {
      const out = next<T>(input);
      yield { delta: out.message, accumulated: out.message, done: true, structured: out.structured };
    },
  };
}

const f = falai().fields({
  nome: { type: "string", ask: "Pergunte o nome." },
});
const flows = [
  f.flow({ id: "boas-vindas", name: "Boas-vindas", on: [{ message: [] }], steps: [{ id: "nome", collect: ["nome"] }] }),
  f.flow({ id: "retomar", name: "Retomar", on: [{ silence: "24h" }], steps: [{ id: "p1", prompt: "Retome a conversa." }] }),
];
const clock = fakeClock("2026-09-20T10:00:00.000Z");
const reply = { message: "Oi! Como você se chama?", nome: null };

const first = await f.agent({ name: "Ana", provider: scripted([reply]), clock, flows }).turn({ sessionId: "s1", message: "oi", id: "m1" });
const replay = await f.agent({ name: "Ana", provider: scripted([reply]), clock, flows }).turn({ sessionId: "s1", message: "oi", id: "m1" });

assert.deepEqual(replay.messages, first.messages); // same key: boas-vindas#m1:nome:1
assert.deepEqual(replay.schedule, first.schedule); // same wake: silence:retomar:s1:<ms>
assert.deepEqual(replay.session.runs, first.session.runs);
assert.equal(first.llmCalls, 1); // a catch-all alone, and nothing to extract before the ask: no understand call
console.log("ok");
```

The same holds inside one session: feed the same `{ message, id }` to the session version it was computed on and the result is the same. Feed it again to a version that already recorded that id and the turn is ignored with `changed: false` and the outcome `code: 'duplicate-input'`.

## Other things worth a test

- A `silenced` turn: `agent.turn({ …, silenced: "humano no comando" })` spends zero calls, phrases nothing, and still runs `do` steps. Assert `llmCalls === 0` and `messages.length === 0`.
- A speak failure: leave the `speak` queue empty so the scripted provider throws inside the turn. `agent.turn()` still returns — no try/catch needed. Assert the outcome `{ status: "deferred", code: "provider-unavailable" }` and a `schedule[]` key ending in `:retry:<ms>`. See [error handling](./error-handling.md).
- A stale wake: fire a key the session no longer waits for and assert `changed === false` and the outcome `code: 'stale-wake'`.
- Actions: register `f.action` handlers that push `ctx.key` and `ctx.dedupeKey` to an array, and assert the list. The keys are the same on a replay.
- The prompt: keep every `GenerateMessageInput` your provider receives and assert on `input.prompt` (which instructions reached it) and `input.tools` (which tools were offered). The repo's own scripted provider, `tests/mock-provider.ts`, records them as `calls[].prompt` and `calls[].input`.
- Streaming: `turnStream` with the same scripted provider yields one `delta` per provider chunk and a final `{ done, result }` equal to what `turn()` returns.

See [the pipeline](../concepts/pipeline.md) for what each phase costs, and [runs and waits](../concepts/runs-and-waits.md) for the full key table.
