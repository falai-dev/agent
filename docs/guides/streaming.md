---
title: "Streaming"
description: "turnStream: the reply arrives as text deltas, the full turn result arrives last, and everything else works exactly as in turn()."
type: guide
order: 9
---

# Streaming

`agent.turnStream()` is `agent.turn()` that yields the reply while the model writes it.

```ts
import { falai, GeminiProvider } from "@falai/agent";

const f = falai().fields({
  nome: { type: "string", ask: "Pergunte o nome." },
});

const agent = f.agent({
  name: "Ana",
  provider: new GeminiProvider({ apiKey: process.env.GEMINI_API_KEY ?? "", model: "gemini-2.5-flash" }),
  flows: [
    f.flow({
      id: "boas-vindas",
      name: "Boas-vindas",
      on: [{ message: [] }],
      steps: [{ id: "nome", collect: ["nome"] }],
    }),
  ],
});

for await (const chunk of agent.turnStream({ sessionId: "demo", message: "oi, sou o Rui" })) {
  if ("delta" in chunk) {
    process.stdout.write(chunk.delta);
    continue;
  }
  process.stdout.write("\n");
  console.log(chunk.result.llmCalls, chunk.result.session.data); // 1 { nome: 'Rui' }
}
```

The stream prints the reply one piece at a time, then the last chunk hands you the same `TurnResult` that `turn()` would have returned.

## The chunks

```ts fragment
type TurnStreamChunk<D> =
  | { delta: string }                      // a piece of the reply, in order
  | { done: true; result: TurnResult<D> }; // always last, exactly once
```

Every `delta` is plain message text. Joined together they add up to the reply. The `done` chunk carries the whole result: `session`, `changed`, `messages[]`, `schedule[]`, `outcomes[]`, `started`, `ended`, `skipped`, `llmCalls`. Read [the agent reference](../reference/agent.md) for the fields.

## What streams and what does not

Only the speak call streams: the one call that phrases the reply. Everything else in the turn is code or a call that never streams.

| Source | Arrives as |
|---|---|
| the talk step's reply, or the idle speaker's | `delta` chunks, then in `result.messages[]` as one `kind: "ai"` message |
| a `say` step's text | `result.messages[]` only, `kind: "verbatim"` |
| the understand call (routing, mentions, extraction) | nothing visible; it finishes before the first delta |
| actions, waits, `if` steps | `result.outcomes[]`, `result.schedule[]` |

The provider streams a JSON envelope, not bare text: `{"message":"Oi, Rui! Em que posso"…` followed by the collected fields. The framework unwraps it as it arrives (`src/utils/streamingMessage.ts`), so a `delta` never contains a brace, a quote or a field name, and a field the model writes before the message is skipped rather than leaked. A provider that streams plain text passes through as it is.

## Tool calls during a stream

A speak call may run in rounds: the model calls tools, the results go back as history, and the model is asked again. This happens inside the stream, before the `done` chunk. Each round streams. If the model writes something beside a tool call ("deixa eu ver"), that preamble reaches the stream, while `result.messages[0].text` holds only the final round's message. A UI that shows deltas as they come should replace what it showed with `result.messages[0].text` when `done` arrives, so both paths end on the same text.

Rounds are capped by `maxToolLoops` on the agent, default 5; after the cap the model is asked once more with no tools so a message always comes back. Each round is one model call and counts in `result.llmCalls`.

## A provider failure mid-stream

The stream never throws for a speak failure. You get zero or more deltas and then the `done` chunk, whose result carries a `deferred` outcome and a retry wake, exactly as `turn()` would report it.

A failure mid-stream leaves the person looking at half a reply. Nothing of that half reaches `result.messages[]`, so the deltas you showed are its only trace: clear them when `done` carries a `deferred` outcome, and leave a short line saying the reply is coming. The retry wake fires a minute later, speaks that step again from the start, and its reply arrives as an ordinary message carrying the key the first attempt would have used.

A failure in the understand call, before any delta, throws from the `for await` like `turn()` does. See [error handling](./error-handling.md).

## The same settle, the same result

`turnStream` runs the same eight phases as `turn()` and applies the reply the same way. With the same provider output, the two return identical results: the same message keys, the same data written, the same schedule. Stream when you show text to a person as it is written. When the messages leave through a channel you send to yourself, `turn()` is simpler, because it gives you the messages after the save and nothing before it.

Save and send are still yours, and still in that order: the `done` chunk's `result.session` is what you save with the version you loaded, and a `SessionConflictError` means you replay the same input; see [persistence](./persistence.md). With a stream the person has already seen the text by then, which is fine in a chat window and is the reason to prefer `turn()` on a channel.
