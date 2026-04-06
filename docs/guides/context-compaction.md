# Context Compaction

The `CompactionEngine` automatically manages conversation history size when approaching token limits. It applies multi-layered strategies in order of cost, from cheap truncation to LLM-powered summarization.

## Compaction Strategies

Strategies are applied in order until the history fits within the token budget:

| Strategy | Cost | Description |
|---|---|---|
| `none` | Free | History is under threshold — no action taken |
| `tool_result_budget` | Free | Truncate oversized tool results with a notice |
| `micro_compact` | Free | Collapse whitespace in verbose tool outputs |
| `auto_compact` | LLM call | Summarize old messages via the configured AI provider |

If the LLM summarization fails, the engine falls back to aggressive truncation (removing oldest messages) and logs a warning. The next compaction attempt will retry summarization.

## Configuration

Compaction is configured at the agent level via the `compaction` option:

```typescript
import { Agent } from "@falai/agent";

const agent = new Agent({
  name: "LongConversationAgent",
  provider: anthropicProvider,
  compaction: {
    maxTokens: 100_000,
    compactionThreshold: 0.8,    // trigger at 80% of budget
    preserveRecentCount: 10,     // always keep last 10 messages
    maxToolResultChars: 5_000,   // truncate tool results over 5k chars
    provider: anthropicProvider, // provider for LLM summarization
  },
});
```

### CompactionOptions

| Option | Type | Constraint | Description |
|---|---|---|---|
| `maxTokens` | `number` | > 0 | Maximum token budget for the conversation |
| `compactionThreshold` | `number` | 0.5 – 0.95 | Ratio at which compaction triggers |
| `preserveRecentCount` | `number` | ≥ 2 | Recent messages that are never modified |
| `maxToolResultChars` | `number` | > 0 | Per-tool-result character limit before truncation |
| `provider` | `AiProvider` | — | Provider used for LLM summarization |

Invalid options throw at construction time.

## How It Works

When the `SessionManager` detects that estimated tokens exceed `maxTokens * compactionThreshold`, the `CompactionEngine` runs:

1. **Token estimation** — character-based heuristic (~4 chars/token), no external tokenizer needed
2. **Tool result budget** — truncate any tool result exceeding `maxToolResultChars`, append a notice like `[Truncated: 12000 chars total, showing first 5000]`
3. **Micro-compact** — collapse whitespace in tool outputs for the compactable portion of history
4. **Auto-compact** — summarize old messages via the AI provider, replacing them with a `[Conversation Summary]` system message

The last `preserveRecentCount` messages are never modified or removed by any strategy.

## Manual Compaction

You can also use the `CompactionEngine` directly:

```typescript
import { CompactionEngine } from "@falai/agent";

const result = await CompactionEngine.checkAndCompact(history, {
  maxTokens: 100_000,
  compactionThreshold: 0.8,
  preserveRecentCount: 10,
  maxToolResultChars: 5_000,
  provider: anthropicProvider,
});

console.log(result.strategy);        // 'none' | 'tool_result_budget' | 'micro_compact' | 'auto_compact'
console.log(result.estimatedTokens); // tokens after compaction
console.log(result.messagesCompacted);
```

### Standalone Utilities

```typescript
// Estimate tokens for a history
const tokens = CompactionEngine.estimateTokens(history);

// Truncate tool results only
const budgeted = CompactionEngine.applyToolResultBudget(history, 5_000);
```

## Key Properties

- **Idempotent** — compacting already-compacted history with the same options produces the same result
- **Deterministic estimation** — `estimateTokens` always returns the same value for the same input
- **Preservation guarantee** — the last `preserveRecentCount` messages are never touched
- **Graceful degradation** — LLM failure falls back to truncation, never crashes
