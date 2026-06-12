---
title: "Compaction"
description: "Keep prompts within token limits across long sessions by layering tool-result budgeting, micro-compaction, and LLM summarization in cost order."
type: guide
order: 8
---

# Compaction

> **Where this is introduced:** [Errors](./error-handling.md)

Long-running sessions accumulate history. Tool calls return verbose
JSON, turns pile up, and at some point the next provider call runs
out of token budget. Compaction is the framework's answer: a layered
strategy that trims and summarizes `session.history` before each turn
so the prompt fits without dropping anything load-bearing. Layers run
in cost order — character-level truncation first, an LLM summarization
call only when nothing cheaper closes the gap.

This guide is task-shaped: enable compaction, choose a budget, and
understand which layer fires when.

## Enable compaction

Compaction is opt-in. Set `AgentOptions.compaction` and the agent
validates the config at construction time, then runs the engine
deterministically at end-of-turn finalize on every `respond()` /
`chat()` / `stream()` call — and additionally whenever a message is
appended via `session.addMessage()`. Since v2.4 the finalize run is
guaranteed, so respond-only integrations that never call
`addMessage()` get bounded history too (previously compaction only
ran inside `addMessage()`).

```typescript
import { createAgent, GeminiProvider } from "@falai/agent";

const agent = createAgent({
  name: "Concierge",
  provider: new GeminiProvider({ apiKey: process.env.GEMINI_API_KEY! }),
  schema: { /* ... */ },
  flows: [/* ... */],

  compaction: {
    maxTokens: 32_000,           // total token budget for the prompt
    compactionThreshold: 0.8,    // fire when history hits 80% of maxTokens (default)
    preserveRecentCount: 4,      // never touch the last 4 history items (default)
    maxToolResultChars: 5_000,   // global cap per tool message (default)
    // enabled: true,            // default true when `compaction` is provided
  },
});
```

The four knobs map onto the
[`AgentCompactionConfig`](../reference/create-agent.md) interface.
`maxTokens` is the only required field; the rest fall back to the
defaults shown above. The agent calls `validateOptions` synchronously
at construction, so misvalued thresholds (`compactionThreshold` outside
`[0.5, 0.95]`, `preserveRecentCount < 2`, `maxToolResultChars <= 0`)
throw immediately rather than silently no-oping at runtime.

A second knob lives on every `Tool`: `maxResultSizeChars`. That value
is enforced by the tool executor the moment a tool returns, before the
result enters history at all. It and the agent-level `maxToolResultChars`
work together — per-tool first, global later.

## How a turn checks the budget

At the end of every turn (and on each `session.addMessage()`), the
engine runs
`CompactionEngine.checkAndCompact(session.history, options)`. The
compacted history is what gets persisted and carried into the next
turn's prompt. The engine estimates the current token count using a
character-based heuristic (~4 characters per token), compares against
`maxTokens * compactionThreshold`, and applies the cheapest layer that
brings history below the threshold. If even the most expensive layer
cannot, an aggressive truncation fallback removes the oldest items
until the budget fits.

`preserveRecentCount` is honored by every layer. The trailing N items
of `session.history` are never modified, summarized, or removed —
recent turns are the one piece of context the engine refuses to spend.

## Layer 1 — tool-result budgeting

`tool_result_budget` is the cheapest layer. It walks history, finds
items with `role: "tool"`, and truncates any whose stringified content
exceeds `maxToolResultChars`. Truncated items get a deterministic
notice appended:

```text
[Truncated: 12834 chars total, showing first 5000]
```

Character-level and synchronous — no LLM call, no network. It fires
whenever history crosses the threshold and at least one tool message
is oversized. For agents that orchestrate verbose APIs (search, SQL,
web fetches) this layer alone usually keeps the prompt in budget.

The per-tool counterpart is `Tool.maxResultSizeChars`. Set it on
high-volume tools to truncate at execution time, before the result
ever lands in history. Combine the two: a tight per-tool cap on a
known-chatty tool, plus a global ceiling at the agent level.

## Layer 2 — micro-compaction

If `tool_result_budget` is not enough, `micro_compact` runs over the
already-budgeted history. It compresses verbose tool outputs inline
by collapsing whitespace runs to a single space and trimming the
edges. Tool results are the only target — user, assistant, and system
messages pass through unchanged.

Still LLM-free and deterministic. Most effective on tool results that
contain pretty-printed JSON or multiline text where formatting is
whitespace-heavy. The recent-N tail (`preserveRecentCount`) is
preserved verbatim during this pass; the cutoff is `history.length -
preserveRecentCount`, and only items before that cutoff are
compressed.

## Layer 3 — LLM summarization

When neither character-level layer brings the prompt under threshold,
`auto_compact` dispatches a single `provider.generateMessage` call
asking the agent's own LLM to summarize the older portion. The result
becomes one synthetic system message:

```text
[Conversation Summary]
<summary text from the provider>
```

That synthetic item replaces every history item before the
`preserveRecentCount` tail. The recent tail is appended unchanged. If
the provider call fails — quota, network, any caught exception — the
engine falls back to `aggressiveTruncate`: walk older messages newest
to oldest, keep as many as fit under `maxTokens * compactionThreshold`,
drop the rest. The strategy field on the result still reads
`"auto_compact"` so callers can see that summarization was attempted.

This layer costs a real provider round-trip. It only fires when
character-level layers cannot close the gap — in practice, sessions
with hundreds of long turns or tools that return narrative prose
rather than structured data.

## When each layer fires

The `compactionThreshold` ratio is the gate for all three layers. Below
threshold, `checkAndCompact` returns `strategy: "none"` and history
passes through untouched. At or above threshold, the engine attempts
each layer in order and stops as soon as the result drops below the
threshold:

| Estimated tokens | Strategy that fires |
|------------------|---------------------|
| `< maxTokens * compactionThreshold` | `none` |
| `≥ threshold`, oversized tool messages exist | `tool_result_budget` |
| `≥ threshold` after budgeting | `micro_compact` |
| `≥ threshold` after micro-compaction | `auto_compact` (LLM call) |
| LLM call failed | `auto_compact` (truncation fallback) |

The result's `messagesCompacted` count and optional `summary` field
are logged at `info` level so production logs show which layer fired
on which turn.

A practical defaults sketch: set `maxTokens` to ~80% of the model's
context window, leave `compactionThreshold` at the 0.8 default, and
put a tight per-tool `maxResultSizeChars` on any tool that talks to
a search API or a database. Pick the budget, set the caps, let the
layers absorb the noise.

**Next:** [Architecture](../concepts/architecture.md)
