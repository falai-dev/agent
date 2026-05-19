---
title: "createAgent"
description: "Factory function that constructs an Agent from a single options object."
type: reference
order: 1
---

# createAgent

> **Where this is introduced:** [Your first agent](../start/02-first-agent.md)

`createAgent` is the level-1 entry point for constructing an `Agent`. It is
syntactic sugar over `new Agent(options)` and accepts the same `AgentOptions`
shape. Generic inference flows from `schema` through every `flows[].steps[].collect`
reference, so the type of `session.data` and tool handler arguments is derived
once and propagates everywhere.

## Signature

```typescript
function createAgent<TContext = unknown, TData = unknown>(
  options: AgentOptions<TContext, TData>
): Agent<TContext, TData>;

interface AgentOptions<TContext = unknown, TData = unknown> {
  name: string;
  goal?: string;
  persona?: Template<TContext>;
  debug?: boolean;
  context?: TContext;
  contextProvider?: ContextProvider<TContext>;
  hooks?: ContextLifecycleHooks<TContext, TData>;
  provider: AiProvider;
  schema?: StructuredSchema;
  initialData?: Partial<TData>;
  terms?: Term<TContext, TData>[];
  instructions?: Instruction<TContext, TData>[];
  tools?: Tool<TContext, TData, unknown>[];
  flows?: FlowOptions<TContext, TData>[];
  signals?: Signal<TContext, TData, unknown>[];
  signalBatchSize?: number;
  persistence?: PersistenceConfig<TData>;
  knowledgeBase?: Record<string, unknown>;
  flowSwitchMargin?: number;
  maxAutoStepsPerTurn?: number;
  maxDirectiveChain?: number;
  compaction?: AgentCompactionConfig;
  promptCache?: PromptCacheConfig;
  routerMode?: 'ai';
  sessionId?: string;
  session?: SessionState;
}
```

## Fields

| Field | Type | Required | Default | Notes |
|-------|------|----------|---------|-------|
| `name` | `string` | yes | — | Display name surfaced in logs and prompt sections. |
| `goal` | `string` | no | — | One-line objective rendered into the system prompt. |
| `persona` | `Template<TContext>` | no | — | Who the agent is and how it communicates — role, tone, and self-concept. Rendered into the system prompt. |
| `provider` | `AiProvider` | yes | — | Strategy instance: `GeminiProvider`, `OpenAIProvider`, `AnthropicProvider`, or `OpenRouterProvider`. |
| `schema` | `StructuredSchema` | no | — | Single source of truth for `TData`. Every `collect` key in every step must reference a property defined here. |
| `initialData` | `Partial<TData>` | no | — | Pre-populates `session.data` when the agent is constructed. |
| `flows` | `FlowOptions<TContext, TData>[]` | no | `[]` | Conversation flows. May also be added later via `agent.createFlow(...)`. |
| `tools` | `Tool<TContext, TData, unknown>[]` | no | `[]` | Agent-scoped tools. Each tool's `Tool.id` must be unique. |
| `instructions` | `Instruction<TContext, TData>[]` | no | `[]` | Behavioral statements discriminated by `kind: 'must' \| 'never' \| 'should'`. Scoped at agent, flow, or step level. |
| `terms` | `Term<TContext, TData>[]` | no | `[]` | Domain glossary entries inlined into the prompt. |
| `signals` | `Signal<TContext, TData, unknown>[]` | no | `[]` | Typed event detectors that run before/after the LLM turn. |
| `signalBatchSize` | `number` | no | `10` | Maximum signals per batched classifier call. Throws `FlowConfigurationError` if not a positive integer. |
| `context` | `TContext` | no | — | Static ambient data (user info, env, etc.) available to every hook and tool. |
| `contextProvider` | `ContextProvider<TContext>` | no | — | Async context loader. Use instead of `context` when ambient data must be fetched per turn. |
| `hooks` | `ContextLifecycleHooks<TContext, TData>` | no | — | `beforeRespond`, `onContextUpdate`, `onDataUpdate` — fire around every turn. |
| `persistence` | `PersistenceConfig<TData>` | no | in-memory | Session storage. Omit for `MemoryAdapter`. |
| `knowledgeBase` | `Record<string, unknown>` | no | — | Arbitrary JSON inlined into the prompt as background knowledge. |
| `flowSwitchMargin` | `number` | no | `15` | Margin (0–100) the best alternative flow must exceed the current flow's score by before switching. Higher values make the agent stickier. |
| `maxAutoStepsPerTurn` | `number` | no | `10` | Cap on consecutive `auto: true` steps per turn. Throws `FlowConfigurationError` when exceeded. |
| `maxDirectiveChain` | `number` | no | `10` | Cap on chained directives per turn (e.g., `goTo` → `onEnter` emits `goTo` → …). Throws `FlowConfigurationError` when exceeded. |
| `compaction` | `AgentCompactionConfig` | no | — | History compaction config: `maxTokens`, `compactionThreshold`, `preserveRecentCount`, `maxToolResultChars`. |
| `promptCache` | `PromptCacheConfig` | no | `{ enabled: true }` | Controls prompt-section memoization across turns. |
| `debug` | `boolean` | no | `false` | Enables `loglevel` debug output. |
| `routerMode` | `'ai'` | no | `'ai'` | Reserved for future router strategies. Any non-`'ai'` value throws `NotImplementedError` at construction. |
| `sessionId` | `string` | no | — | Auto-loads the session with this id from the configured adapter. |
| `session` | `SessionState` | no | — | Pre-built session passed in for convenience methods. |

## Examples

### Minimal agent

```typescript
import { createAgent, GeminiProvider } from '@falai/agent';

const agent = createAgent({
  name: 'Greeter',
  provider: new GeminiProvider({ apiKey: process.env.GEMINI_API_KEY! }),
  schema: {
    type: 'object',
    properties: { name: { type: 'string' } },
  },
  flows: [
    {
      title: 'Greet',
      steps: [
        { id: 'ask_name', prompt: 'Ask for the user\'s name.', collect: ['name'] },
        { id: 'greet', prompt: 'Greet them by name.', requires: ['name'] },
      ],
    },
  ],
});

const response = await agent.respond('Hi, I\'m Ada.');
console.log(response.message);
```

### Tools, instructions, and persistence

```typescript
import { createAgent, GeminiProvider, MemoryAdapter } from '@falai/agent';

const agent = createAgent({
  name: 'BookingBot',
  persona: 'Concise concierge. Always confirms dates before booking.',
  provider: new GeminiProvider({ apiKey: process.env.GEMINI_API_KEY! }),
  schema: {
    type: 'object',
    properties: {
      city: { type: 'string' },
      checkIn: { type: 'string' },
    },
  },
  instructions: [
    { kind: 'must', prompt: 'Validate dates are in the future.' },
    { kind: 'never', prompt: 'Promise rates you have not looked up.' },
  ],
  tools: [
    {
      id: 'book_hotel',
      description: 'Book a hotel for the collected city and date.',
      parameters: {
        type: 'object',
        properties: {
          city: { type: 'string' },
          checkIn: { type: 'string' },
        },
        required: ['city', 'checkIn'],
      },
      handler: async (ctx, args) => {
        const ref = await reserve(args.city, args.checkIn);
        return { content: `Booked ${ref}.` };
      },
    },
  ],
  flows: [
    {
      title: 'Book',
      requiredFields: ['city', 'checkIn'],
      steps: [
        { id: 'ask', prompt: 'Collect city and check-in date.', collect: ['city', 'checkIn'] },
        { id: 'confirm', prompt: 'Confirm and call book_hotel.', requires: ['city', 'checkIn'] },
      ],
    },
  ],
  persistence: { adapter: new MemoryAdapter() },
});
```

## Errors

`createAgent` runs the same construction-time validation as `new Agent(...)`.
The following typed errors may be thrown:

- `FlowConfigurationError` — duplicate flow ids or titles, duplicate signal ids, duplicate tool ids, invalid `signalBatchSize`, invalid signal `extract` schema, a step's `collect` references a key not defined in `schema`, a flow's `requiredFields`/`optionalFields` references an unknown schema key, or an unresolvable branch `then` target.
- `NotImplementedError` — `routerMode` set to anything other than `'ai'`.

Validation errors during a turn (not construction) — `DataValidationError`,
`ToolExecutionError`, `ResponseGenerationError` — surface from
`agent.respond(...)` and are documented on [Errors](./errors.md).

## Related

- [Architecture](../concepts/architecture.md) — the seven primitives and how they fit together
- [Your first agent](../start/02-first-agent.md) — the tutorial that introduces `createAgent`
- [Flow](./flow.md) — the `flows[]` entry shape
- [Tool](./tool.md) — the `tools[]` entry shape
- [Instruction](./instruction.md) — the `instructions[]` entry shape
- [Errors](./errors.md) — typed error classes thrown at construction and at runtime
