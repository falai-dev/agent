# Prompt Optimization

The `PromptSectionCache` optimizes prompt generation by memoizing static sections across turns and recomputing only dynamic sections per-turn. Combined with the native history format change, this reduces redundant computation and token usage.

## Section Types

Prompt sections are classified as either static or dynamic:

| Type | Behavior | Examples |
|---|---|---|
| `static` | Cached after first computation, reused across turns | Agent identity, glossary, knowledge base, route descriptions, scoring rules |
| `dynamic` | Recomputed on every `resolveAll()` call | Instructions, directives, available tools, guidelines |

Static sections only change when the underlying state changes (context update, session switch, route change). Dynamic sections depend on per-turn state and are always fresh.

## Configuration

Prompt caching is enabled by default. Configure it via the `promptCache` option on the agent:

```typescript
import { Agent } from "@falai/agent";

const agent = new Agent({
  name: "MyAgent",
  provider: anthropicProvider,
  promptCache: {
    enabled: true,        // default: true
    volatileKeys: [],     // keys that always recompute, even if registered as static
  },
});
```

### PromptCacheConfig

| Option | Type | Default | Description |
|---|---|---|---|
| `enabled` | `boolean` | `true` | Enable/disable section memoization |
| `volatileKeys` | `string[]` | `[]` | Section keys forced to recompute every turn |

Set `enabled: false` to disable caching entirely (useful for debugging):

```typescript
const agent = new Agent({
  name: "DebugAgent",
  provider: anthropicProvider,
  promptCache: { enabled: false },
});
```

## PromptSectionCache API

### `register(key, type, compute)`

Register a section with a unique key, type (`'static'` or `'dynamic'`), and a compute function.

```typescript
cache.register("agentMeta", "static", async () => {
  return "## Agent Identity\nYou are MyAgent.";
});

cache.register("directives", "dynamic", () => {
  return "## Directives\n- Address the user's question";
});
```

### `get(key)`

Retrieve a section's value. Static sections return the cached value when available; dynamic sections always recompute.

### `resolveAll()`

Resolve all registered sections in registration order. Returns `(string | null)[]`.

### `invalidate(key)`

Force a specific section to recompute on the next `resolveAll()` call.

```typescript
cache.invalidate("knowledgeBase");
```

### `invalidateAll()`

Force all sections to recompute. Called automatically on session change or `/clear`.

```typescript
cache.invalidateAll();
```

## Automatic Cache Invalidation

The framework invalidates relevant caches automatically when state changes:

| Event | Sections Invalidated |
|---|---|
| `agent.updateContext()` | `agentMeta`, `knowledgeBase` |
| Session change / clear | All sections (`invalidateAll()`) |
| Route switch | Route-dependent sections (active routes, route rules, route knowledge base) |

No manual cache management is needed for typical usage.

## Native History Format

History is now sent as native provider messages via `GenerateMessageInput.history` instead of being JSON-serialized into the system prompt. This saves tokens (no JSON overhead) and lets providers optimize for their native message format.

### Migration from `addInteractionHistory()`

The `PromptComposer.addInteractionHistory()` method is deprecated. If you were calling it directly:

**Before:**
```typescript
const pc = new PromptComposer(context);
await pc.addAgentMeta(agentOptions);
await pc.addInteractionHistory(history);  // embedded in prompt string
await pc.addLastMessage(lastMessage);
const prompt = await pc.build();

const response = await provider.generateMessage({ prompt, history: [] });
```

**After:**
```typescript
const pc = new PromptComposer(context, cache);
await pc.addAgentMeta(agentOptions);
// No addInteractionHistory() — history flows natively
const prompt = await pc.build();

const response = await provider.generateMessage({ prompt, history });
```

The `addInteractionHistory()` method still works for backward compatibility but is marked `@deprecated` and will be removed in a future version.

## Manual Cache Usage

You can use `PromptSectionCache` directly for custom prompt pipelines:

```typescript
import { PromptSectionCache } from "@falai/agent";

const cache = new PromptSectionCache({ enabled: true });

cache.register("identity", "static", () => "You are a helpful assistant.");
cache.register("tools", "dynamic", () => "Available: search, calculate");

// First call: both sections computed
const sections1 = await cache.resolveAll(); // ["You are a helpful assistant.", "Available: search, calculate"]

// Second call: identity served from cache, tools recomputed
const sections2 = await cache.resolveAll();

// Invalidate a specific section
cache.invalidate("identity");

// Next call: identity recomputed, tools recomputed (always)
const sections3 = await cache.resolveAll();
```

## Key Properties

- **Static sections cache** — computed once per session, reused across turns until invalidated
- **Dynamic sections recompute** — always fresh on every `resolveAll()` call
- **Automatic invalidation** — context updates, session changes, and route switches trigger targeted invalidation
- **Configurable** — disable caching or mark specific keys as volatile
- **Backward compatible** — `addInteractionHistory()` still works, just deprecated
