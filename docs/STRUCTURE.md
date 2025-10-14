# Package Structure

```
src/
├── types/          # Type definitions (interfaces, types, enums)
│   ├── agent.ts           # Agent types and configuration
│   ├── ai.ts              # AI provider interfaces
│   ├── history.ts         # Event and message history types
│   ├── observation.ts     # Observation and disambiguation types
│   ├── persistence.ts     # Persistence adapter interfaces
│   ├── prompt.ts          # Prompt building types
│   ├── route.ts           # Route and state types
│   ├── tool.ts            # Tool definition types
│   └── index.ts           # Type exports
├── core/           # Core framework classes
│   ├── Agent.ts           # Main agent class
│   ├── Route.ts           # Route/Journey DSL
│   ├── State.ts           # State management
│   ├── Transition.ts      # State transitions
│   ├── Observation.ts     # Disambiguation
│   ├── Tool.ts            # Tool definitions
│   ├── PromptBuilder.ts   # Prompt construction
│   ├── Events.ts          # Event history
│   ├── DomainRegistry.ts  # Domain organization
│   └── PersistenceManager.ts  # Persistence lifecycle management
├── providers/      # AI provider implementations
│   ├── AnthropicProvider.ts   # Claude (Anthropic)
│   ├── GeminiProvider.ts      # Google Gemini
│   ├── OpenAIProvider.ts      # OpenAI GPT
│   ├── OpenRouterProvider.ts  # OpenRouter (200+ models)
│   └── index.ts               # Provider exports
├── adapters/       # Database persistence adapters
│   ├── MemoryAdapter.ts       # In-memory (testing/dev)
│   ├── PrismaAdapter.ts       # Prisma ORM
│   ├── RedisAdapter.ts        # Redis
│   ├── MongoAdapter.ts        # MongoDB
│   ├── PostgreSQLAdapter.ts   # PostgreSQL
│   ├── SQLiteAdapter.ts       # SQLite
│   ├── OpenSearchAdapter.ts   # OpenSearch/Elasticsearch
│   └── index.ts               # Adapter exports
├── utils/          # Utility functions
│   ├── retry.ts           # Retry/timeout logic
│   └── id.ts              # Deterministic ID generation
├── constants/      # Constants and symbols
│   └── index.ts           # END_ROUTE, EventSource, etc.
└── index.ts        # Public API exports
```

## Design Principles

1. **Flat, organized structure** - Clear separation by purpose
2. **Types-first** - All types in dedicated folder
3. **Core logic isolated** - Business logic in \`core/\`
4. **Provider pattern** - Pluggable AI backends and database adapters
5. **Optional persistence** - Multiple database adapters following the same pattern
6. **Extensibility** - Easy to add new providers, adapters, and tools
7. **Path aliases** - Clean imports with \`@/types\`, \`@/core\`, etc.
8. **Fluent API** - Methods return \`this\` for chaining
