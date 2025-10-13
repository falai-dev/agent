# Package Structure

\`\`\`
src/
├── types/          # Type definitions (interfaces, types, enums)
├── core/           # Core framework classes
│   ├── Agent.ts           # Main agent class
│   ├── Route.ts           # Route/Journey DSL
│   ├── State.ts           # State management
│   ├── Transition.ts      # State transitions
│   ├── Observation.ts     # Disambiguation
│   ├── Tool.ts            # Tool definitions
│   ├── PromptBuilder.ts   # Prompt construction
│   ├── Events.ts          # Event history
│   └── DomainRegistry.ts  # Domain organization
├── providers/      # AI provider implementations
│   └── GeminiProvider.ts  # Google Gemini AI
├── utils/          # Utility functions
│   └── retry.ts           # Retry/timeout logic
├── constants/      # Constants and symbols
│   └── index.ts           # END_ROUTE, etc.
└── index.ts        # Public API exports
\`\`\`

## Design Principles

1. **Flat, organized structure** - Clear separation by purpose
2. **Types-first** - All types in dedicated folder
3. **Core logic isolated** - Business logic in \`core/\`
4. **Provider pattern** - Pluggable AI backends
5. **Path aliases** - Clean imports with \`@/types\`, \`@/core\`, etc.
6. **Fluent API** - Methods return \`this\` for chaining
