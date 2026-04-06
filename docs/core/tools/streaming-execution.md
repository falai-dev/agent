# Streaming Tool Execution

The `StreamingToolExecutor` executes tools as they arrive from the LLM stream rather than waiting for the full response. It provides concurrency control, abort handling, and ordered result yielding.

## Overview

- Tools begin executing immediately as they are parsed from the LLM stream
- Read-only (concurrency-safe) tools run in parallel
- Write (non-concurrency-safe) tools run serially with exclusive access
- Results are always yielded in the original request order
- Progress messages bypass ordering and are delivered immediately

## Concurrency Control

The executor enforces a strict invariant at all times:

> Either **all** executing tools have `isConcurrencySafe === true`, **or** exactly **one** tool is executing with `isConcurrencySafe === false`.

Tools without the `isConcurrencySafe` method default to `false` (serial execution), preserving backward compatibility with plain `Tool` objects.

A configurable `maxParallel` limit (default: 10) caps the number of concurrently executing tools regardless of concurrency safety.

### Example: Mixed Read/Write Tools

```typescript
import { Agent, EnhancedTool } from "@falai/agent";

const readFile: EnhancedTool = {
  id: "read-file",
  name: "read_file",
  description: "Read a file from disk",
  parameters: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  },
  handler: async (ctx, args) => {
    const content = await fs.readFile(args?.path as string, "utf-8");
    return { data: content, success: true };
  },
  isConcurrencySafe: () => true,   // safe to run in parallel
  isReadOnly: () => true,
  maxResultSizeChars: 50_000,
};

const writeFile: EnhancedTool = {
  id: "write-file",
  name: "write_file",
  description: "Write content to a file",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      content: { type: "string" },
    },
    required: ["path", "content"],
  },
  handler: async (ctx, args) => {
    await fs.writeFile(args?.path as string, args?.content as string);
    return { success: true };
  },
  isConcurrencySafe: () => false,  // must run exclusively
  interruptBehavior: () => "block",
};

const agent = new Agent({
  name: "CodeAssistant",
  provider: anthropicProvider,
  tools: [readFile, writeFile],
});
```

When the LLM requests `read_file` three times followed by `write_file`, the three reads execute in parallel. Once all reads complete, the write executes alone.

## Abort Behavior

### Sibling Abort

When a tool in a concurrent batch fails, all sibling tools in the same batch receive an abort signal. Each tool's `interruptBehavior` determines the response:

- `'cancel'` — tool is immediately aborted
- `'block'` (default) — tool is allowed to finish

### Parent AbortSignal

A parent `AbortSignal` can be passed via `StreamingToolExecutorOptions`. When it fires:

1. Tools with `interruptBehavior() === 'cancel'` are aborted immediately
2. Tools with `interruptBehavior() === 'block'` complete normally
3. No new queued tools are started

```typescript
const controller = new AbortController();

// Pass signal through agent options or directly to the executor
for await (const chunk of agent.respondStream({
  history,
  signal: controller.signal,
})) {
  process.stdout.write(chunk.delta);
}

// Cancel from user action
controller.abort();
```

## Progress Reporting

Tools can emit progress messages during execution. These are yielded immediately to the caller without being buffered behind result ordering.

```typescript
for await (const chunk of agent.respondStream({ history })) {
  if (chunk.toolExecution?.progress) {
    console.log(`[progress] ${chunk.toolExecution.toolCallId}: ${chunk.toolExecution.progress}`);
  }
  if (chunk.toolExecution?.result) {
    console.log(`[result] ${chunk.toolExecution.toolCallId}: done`);
  }
  process.stdout.write(chunk.delta);
}
```

## Result Ordering

Results are always yielded in the same order as the original tool call requests, regardless of actual completion order. If tool B finishes before tool A, tool B's result is buffered until tool A's result is yielded first.

## API Reference

### Constructor

```typescript
new StreamingToolExecutor<TContext, TData>(
  toolContext: ToolContext<TContext, TData>,
  options?: {
    maxParallel?: number;   // default: 10
    signal?: AbortSignal;   // parent abort signal
  }
)
```

### Methods

| Method | Description |
|---|---|
| `addTool(toolCall, tool)` | Queue a tool for execution. Concurrency safety is evaluated once at queue time. |
| `getCompletedResults()` | Synchronous generator yielding available results in request order. |
| `getRemainingResults()` | Async generator yielding all results (waits for pending tools). |
| `discard()` | Stop processing new queued tools. Running tools continue per their `interruptBehavior`. |
| `getUpdatedContext()` | Return accumulated context updates from completed tools. |
| `hasUnfinishedTools()` | `true` if any tools are still queued or executing. |

### Default Behaviors for Plain `Tool` Objects

| Property | Default |
|---|---|
| `isConcurrencySafe` | `false` |
| `isReadOnly` | `false` |
| `isDestructive` | `false` |
| `interruptBehavior` | `'block'` |

Plain `Tool` objects work without modification — they execute serially and are allowed to complete on abort.
