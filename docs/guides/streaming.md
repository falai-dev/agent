---
title: "Streaming"
description: "Stream the assistant's reply token by token, surface tool calls in flight, and cancel mid-turn with an `AbortSignal`."
type: guide
order: 6
---

# Streaming

`agent.respond` returns a single `AgentResponse` after the LLM and any tool calls have finished. That works for batch work, but a chat UI feels dead until the first character lands. `agent.respondStream` returns an `AsyncGenerator<AgentResponseStreamChunk>`, yielding the assistant's reply incrementally and finishing with one terminal chunk that carries all the metadata.

This guide is a recipe: take a non-streaming call site, swap to `respondStream`, render tokens as they arrive, expose a "thinking" indicator while tools run, read instruction and signal telemetry off the final chunk, and wire an `AbortSignal` so the user can stop mid-turn.

## The shape

`respondStream` takes the same `RespondParams` as `respond` — `history`, optional `session`, optional `contextOverride`, optional `signal` — and returns an async iterable of chunks.

```typescript
const stream = agent.respondStream({
  history: [{ role: "user", content: "Book me a hotel in Lisbon." }],
});

for await (const chunk of stream) {
  process.stdout.write(chunk.delta);
}
```

Every chunk has the same shape:

```typescript
interface AgentResponseStreamChunk<TData> {
  delta: string;        // Text added since the previous chunk
  accumulated: string;  // Full text so far
  done: boolean;        // True only on the terminal chunk
  // ...metadata fields, populated on the final chunk
}
```

`delta` is the new token(s); concatenating every `delta` reproduces the final reply unless a post-phase signal replaces the message on the terminal chunk. `accumulated` is the authoritative running total — useful when your renderer needs the full string each tick (e.g., a Markdown view that re-parses on every update). `done` flips to `true` exactly once, on the terminal chunk.

## Render incrementally

The simplest renderer prints every `delta` as it arrives and clears the line on `done`:

```typescript
for await (const chunk of agent.respondStream({ history })) {
  if (chunk.delta) {
    process.stdout.write(chunk.delta);
  }
  if (chunk.done) {
    process.stdout.write("\n");
  }
}
```

For a UI, push the latest `accumulated` into your component state. React, Solid, Svelte — they all re-render off whichever value you give them, and `accumulated` is the cheapest to consume because it never requires the renderer to track partial state.

A common rendering rule of thumb:

- Plain text view → append `delta`.
- Markdown view that re-parses each frame → bind to `accumulated`.
- Server-Sent Events transport → forward `{ delta, done }` per chunk; let the client reassemble.

## Surface tool calls in flight

Streaming works through tool calls transparently. When the LLM emits a tool call mid-reply, `respondStream` runs the tool, then resumes streaming the post-tool tokens — the consumer never sees the call boundary in the text. What you do get is a quiet gap while the tool executes, which is the right moment to show a "thinking" indicator.

Detect the gap by watching for empty `delta` chunks after some text has already arrived, or — more robustly — toggle the indicator off as soon as the first non-empty `delta` lands:

```typescript
let thinking = true;
let firstToken = true;

for await (const chunk of agent.respondStream({ history })) {
  if (chunk.delta) {
    if (firstToken) {
      thinking = false;
      firstToken = false;
      ui.hideSpinner();
    }
    ui.appendText(chunk.delta);
  }
}
```

If you need finer-grained tool telemetry — which tool fired, with what arguments — read `chunk.toolCalls` on the terminal chunk. It mirrors the same field on the non-streaming `AgentResponse`. For per-tool progress UI, attach observability to the [tool's `handler`](../reference/tool.md) directly; the streaming chunk shape stays clean.

When a step uses [verbatim `reply`](../reference/step.md) or a `halt` directive, the engine skips the LLM entirely and yields a single chunk with `done: true` and the full text in `accumulated`. The renderer above handles that case without a special branch — there is just no spinner gap.

## The terminal chunk

The chunk where `done: true` carries every observability field that lives on `AgentResponse`. Three matter for most call sites:

```typescript
for await (const chunk of agent.respondStream({ history })) {
  // ...render delta...
  if (chunk.done) {
    console.log("flow complete:", chunk.isFlowComplete);
    console.log("instructions rendered:", chunk.appliedInstructions);
    console.log("signals fired:", chunk.triggeredSignals);
  }
}
```

- **`appliedInstructions`** — the [instructions](../reference/instruction.md) whose conditions passed and were rendered into this turn's prompt. Deterministic; derived from rendering, not from LLM self-report. Empty on intermediate chunks; populated only when `done: true`.
- **`triggeredSignals`** — the [signals](../reference/signals.md) that fired during this turn (pre- and post-phase), in fire order. Same population rule.
- **`isFlowComplete`** — `true` when this turn finished the flow. Use it to decide whether to clear the conversation, show a summary card, or transition the UI.

The terminal chunk also carries `executedSteps`, `stoppedReason`, `metadata` (model, token usage), and the updated `session`. These are the same fields you would read off `AgentResponse` — swapping between APIs does not change observability.

## Cancel mid-stream

Pass an `AbortSignal` through `respondStream` and abort the controller to cancel. The generator stops yielding, the in-flight LLM call is cancelled at the provider boundary, and any tool execution unwinds cleanly.

```typescript
const controller = new AbortController();

// User clicks Stop, or a 5s ceiling fires.
const timer = setTimeout(() => controller.abort(), 5000);

try {
  for await (const chunk of agent.respondStream({
    history,
    signal: controller.signal,
  })) {
    process.stdout.write(chunk.delta);
  }
} finally {
  clearTimeout(timer);
}
```

When the signal aborts, the loop exits cleanly — no exception is thrown by the generator itself. If the LLM provider surfaces the cancellation as an error, it lands as a [`ResponseGenerationError`](../reference/errors.md) and you handle it the way you would any other turn-level error.

For a Stop button, store the `controller` reference for the active stream on the UI side and call `controller.abort()` from the click handler. For server-side hard ceilings, wrap `respondStream` with an `AbortController` whose `setTimeout` fires at your SLO budget.

**Next:** [Errors](./error-handling.md)
