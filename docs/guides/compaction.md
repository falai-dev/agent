---
title: "Compaction"
description: "Keep a long history inside the model's window: three layers in cost order, applied once per turn to what both calls see."
type: guide
order: 10
---

# Compaction

A long conversation grows a long history. `compaction` trims the copy the model reads once the history passes a token budget you set.

```ts
import { falai, GeminiProvider } from "@falai/agent";

const f = falai().fields({});

const agent = f.agent({
  name: "Ana",
  provider: new GeminiProvider({ apiKey: process.env.GEMINI_API_KEY ?? "", model: "gemini-2.5-flash" }),
  idle: { prompt: "Responda pela empresa." },
  compaction: { maxTokens: 2000 },
});

const history = Array.from({ length: 400 }, (_, i) => ({ role: "user" as const, content: `mensagem antiga número ${i}` }));
const r = await agent.turn({ sessionId: "demo", history, message: "oi" });
console.log(r.llmCalls); // 2: one call to summarize the old messages, one to reply
```

With `maxTokens: 2000` the turn compacts when the history is estimated at 1600 tokens or more (80% of 2000). These 400 short messages estimate at close to 3000, so the oldest ones are summarized before the reply is phrased, and that summary is one model call. Below the threshold nothing happens and nothing is spent.

## The option

`AgentCompactionConfig`, from `src/types/agent.ts`; the defaults are applied in `src/core/Agent.ts`:

| Field | Meaning | Default |
|---|---|---|
| `maxTokens` | the token budget for the history | required |
| `compactionThreshold` | compact when the estimate reaches this share of `maxTokens`; between 0.5 and 0.95 | `0.8` |
| `preserveRecentCount` | the newest messages are never changed or removed; at least 2 | `4` |
| `maxToolResultChars` | characters kept of a tool result before it is cut; more than 0 | `5000` |
| `enabled` | `false` turns compaction off without removing the config | `true` when the config is present |

A value out of range throws at construction, as a plain `Error`: `compactionThreshold must be between 0.5 and 0.95, got 2`, `preserveRecentCount must be >= 2, got 1`, `maxToolResultChars must be > 0, got 0`.

## When it runs

Once per turn, before the understand call and before the speak call, so both read the same trimmed history. The framework reads `input.history`, or `session.history` when the host passes none, and only acts when there is one. The trimmed copy lives for that turn: your stored history is never rewritten by the framework. The next turn compacts again from whatever you pass.

Tokens are estimated, not counted: the characters of every message's content, plus its `name` when it has one (a tool result always does), plus 4 per message for its role, divided by 4 and rounded up. The estimate is deterministic, so the same history compacts the same way every time.

## The three layers, cheapest first

The engine tries each layer in order and stops at the first one that brings the estimate under the threshold. Under the threshold it runs none of them and reports `none`. The newest `preserveRecentCount` messages stay untouched through all three.

| Strategy | What it does | Model calls |
|---|---|---|
| `tool_result_budget` | cuts every tool result longer than `maxToolResultChars`, appending `[Truncated: N chars total, showing first M]` | 0 |
| `micro_compact` | collapses runs of whitespace inside older tool results | 0 |
| `auto_compact` | asks the model to summarize every message older than the preserved window, and replaces them with one `system` item that starts with `[Conversation Summary]` | 1 |

The first two layers touch tool results only, because that is where a history gets long without saying much. A conversation of plain user and assistant text goes straight to `auto_compact` when it passes the threshold.

`auto_compact` is one model call and adds one to `result.llmCalls`. It is the only call in a turn that is neither understand nor speak; the summary prompt is sent with no `schemaName`. When that call fails, the engine drops the oldest messages instead until the rest fit, without another call; the turn goes on and the failed call still counts.

The preserved window is a target, not a hard cut: its left edge moves left when it would otherwise open on a tool result whose calling assistant message was cut away, because providers reject such a history at the next request.

## Turning it off

Leave `compaction` out, or set `enabled: false`. Either way the model sees the full history you pass, and the `context` kind of `ProviderError` is what tells you the window overflowed; see [error handling](./error-handling.md).

## What compaction is not

It is not memory. The collected fields live in `session.data` and are never compacted; the model is told what is already known on every call a talk step makes (the idle speaker's prompt does not restate them). It is not persistence: what you store is up to you, and the summary the engine writes is not kept anywhere unless you keep the trimmed history yourself.

See [the pipeline](../concepts/pipeline.md) for where the compaction step sits among the eight phases.
