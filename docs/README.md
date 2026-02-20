# @falai/agent Documentation

Welcome to the `@falai/agent` documentation! This comprehensive framework enables you to build sophisticated, type-safe conversational AI agents with **AI-powered routing**, **schema-driven data extraction**, and **declarative conversation flows**.

## ✨ What Makes @falai/agent Unique

- 🤖 **AI-Powered Routing**: Intelligent route and step selection based on conversation context and user intent
- 🎯 **Schema-First Data Collection**: Type-safe, structured data extraction from natural conversations
- 🔀 **Route DSL**: Fluent, composable API for building complex multi-step conversation flows
- 🏗️ **Type-Safe Context**: Generic context management with lifecycle hooks and dynamic providers
- 🔄 **Streaming & Tools**: Real-time streaming responses with dynamic tool execution using unified Tool interface
- 💾 **Comprehensive Persistence**: Database-agnostic session and message storage across multiple adapters
- 🛠️ **Unified Tool System**: Simplified tool creation with flexible return types and powerful pattern helpers

## 📖 Documentation Structure

### 🚀 Getting Started

- **[Quick Start Guide](./guides/getting-started/README.md)** - Build your first agent in 15 minutes

### 🏗️ Core Framework

#### Agent Architecture

- **[Agent Overview](./core/agent/README.md)** - Agent lifecycle, configuration & hooks
- **[Context Management](./core/agent/context-management.md)** - Dynamic context providers & updates
- **[Session Management](./core/agent/session-management.md)** - Session persistence & state
- **[Rules & Prohibitions](./core/agent/rules-and-prohibitions.md)** - Agent-wide behavioral boundaries

#### AI Routing System

- **[Intelligent Routing](./core/routing/intelligent-routing.md)** - AI-powered route and step selection
- **[Route DSL](./core/conversation-flows/route-dsl.md)** - Declarative conversation flow design
- **[Step Transitions](./core/conversation-flows/step-transitions.md)** - Conditional logic and branching

#### Conversation Flows

- **[Routes](./core/conversation-flows/routes.md)** - Route definition, lifecycle & completion
- **[Steps](./core/conversation-flows/steps.md)** - Step configuration, data collection & validation
- **[Data Collection](./core/conversation-flows/data-collection.md)** - Agent-level schema-driven data extraction

#### AI Integration

- **[AI Providers](./core/ai-integration/providers.md)** - Gemini, OpenAI, Anthropic, OpenRouter
- **[Prompt Composition](./core/ai-integration/prompt-composition.md)** - How prompts are built with context
- **[Response Processing](./core/ai-integration/response-processing.md)** - Schema extraction & tool calls

#### Tools & Execution

- **[Tool Definition](./core/tools/tool-definition.md)** - Creating and configuring tools
- **[Tool Scoping](./core/tools/tool-scoping.md)** - Agent, route, and step-level tool management

#### Persistence

- **[Session Storage](./core/persistence/session-storage.md)** - Session persistence patterns
- **[Database Adapters](./core/persistence/adapters.md)** - Built-in adapter configurations

#### Error Handling

- **[Error Handling](./core/error-handling.md)** - Comprehensive error handling patterns and recovery strategies
- **[Error Handling Patterns](./guides/error-handling-patterns.md)** - Practical patterns for streaming, routing, and data sync errors

### 🚀 Advanced Guides

- **[Advanced Patterns](./guides/advanced-patterns/)** - Complex use cases & integrations
- **[Migration Guides](./guides/migration/)** - Upgrade guides for major changes
- **[API Reference](./api/README.md)** - Complete API documentation

## 🎯 Quick Links

### By Learning Path

**🚀 First time here?**
→ Start with [Quick Start Guide](./guides/getting-started/README.md)

**🏗️ Understanding the design?**
→ Read [Agent Overview](./core/agent/README.md) then [Intelligent Routing](./core/routing/intelligent-routing.md)

**🤖 Building AI-powered conversations?**
→ See [Route DSL](./core/conversation-flows/route-dsl.md), [Intelligent Routing](./core/routing/intelligent-routing.md), and [Step Transitions](./core/conversation-flows/step-transitions.md)

**🎯 Collecting structured data?**
→ Learn [Agent-Level Data Collection](./core/conversation-flows/data-collection.md) and [Schema-Driven Extraction](../examples/core-concepts/schema-driven-extraction.ts)

**🔧 Working with tools?**
→ See [Tool Definition](./core/tools/tool-definition.md) and [Tool Scoping](./core/tools/tool-scoping.md)

**💾 Need persistence?**
→ See [Session Storage](./core/persistence/session-storage.md) and [Database Adapters](./core/persistence/adapters.md)

**🚀 Going to production?**
→ Check [Advanced Patterns](./guides/advanced-patterns/) and [Server Session Management](../examples/integrations/server-session-management.ts)

### By Topic

- **Agent Architecture**: [Agent](./core/agent/README.md) | [Context](./core/agent/context-management.md) | [Sessions](./core/agent/session-management.md)
- **AI Routing System**: [Intelligent Routing](./core/routing/intelligent-routing.md) | [Route DSL](./core/conversation-flows/route-dsl.md) | [Step Transitions](./core/conversation-flows/step-transitions.md)
- **Conversation Flows**: [Routes](./core/conversation-flows/routes.md) | [Steps](./core/conversation-flows/steps.md) | [Agent-Level Data Collection](./core/conversation-flows/data-collection.md)
- **AI Integration**: [Providers](./core/ai-integration/providers.md) | [Prompts](./core/ai-integration/prompt-composition.md) | [Responses](./core/ai-integration/response-processing.md)
- **Tools & Execution**: [Tool Definition](./core/tools/tool-definition.md) | [Tool Scoping](./core/tools/tool-scoping.md)
- **Persistence**: [Session Storage](./core/persistence/session-storage.md) | [Adapters](./core/persistence/adapters.md)
- **Error Handling**: [Core Error Handling](./core/error-handling.md) | [Error Patterns](./guides/error-handling-patterns.md)
- **Advanced**: [Patterns](./guides/advanced-patterns/) | [Migration](./guides/migration/) | [API Reference](./api/)

## 💡 Examples by Domain

Check out the [`examples/`](../examples/) directory for complete, runnable examples organized by architectural domain:

### 🏗️ Core Concepts

- **[Basic Agent](../examples/core-concepts/basic-agent.ts)** - Minimal agent setup and configuration
- **[Schema-Driven Extraction](../examples/core-concepts/schema-driven-extraction.ts)** - Type-safe data collection with JSON Schema
- **[Session Management](../examples/core-concepts/session-management.ts)** - Multi-turn conversations with persistence
- **[Modern Streaming API](../examples/core-concepts/modern-streaming-api.ts)** - Streaming responses with the modern API

### 🤖 AI Routing System

- **[Completion Transitions](../examples/conversation-flows/completion-transitions.ts)** - Automatic route transitions when flows complete

### 💬 Conversation Flows

- **[Knowledge-Based Agent](../examples/advanced-patterns/knowledge-based-agent.ts)** - Agents with domain-specific knowledge bases
- **[Persistent Onboarding](../examples/advanced-patterns/persistent-onboarding.ts)** - Multi-step onboarding with data persistence

### 🤖 AI Providers

- **[OpenAI Integration](../examples/ai-providers/openai-integration.ts)** - GPT-4 and GPT-3.5 Turbo with backup models
- **[Anthropic Integration](../examples/ai-providers/anthropic-integration.ts)** - Claude with streaming and tool calling

### 🔧 Tools & Execution

- **[Basic Tools](../examples/tools/basic-tools.ts)** - Unified Tool interface with simple return values
- **[Data Enrichment Tools](../examples/tools/data-enrichment-tools.ts)** - Pattern helpers for data modification

### 💾 Persistence

- **[Memory Sessions](../examples/persistence/memory-sessions.ts)** - In-memory session management
- **[Redis Persistence](../examples/persistence/redis-persistence.ts)** - High-performance Redis storage
- **[Database Persistence](../examples/persistence/database-persistence.ts)** - SQL/NoSQL database integration
- **[Custom Adapter](../examples/persistence/custom-adapter.ts)** - Build custom persistence adapters

### 🚀 Advanced Patterns

- **[Streaming Responses](../examples/advanced-patterns/streaming-responses.ts)** - Real-time response streaming
- **[Route Lifecycle Hooks](../examples/advanced-patterns/route-lifecycle-hooks.ts)** - Custom route behavior and data transformation

### 🔗 Integrations

- **[Database Integration](../examples/integrations/database-integration.ts)** - Direct database access patterns
- **[Healthcare Integration](../examples/integrations/healthcare-integration.ts)** - Domain-specific healthcare workflows
- **[Search Integration](../examples/integrations/search-integration.ts)** - Integration with search engines
- **[Server Session Management](../examples/integrations/server-session-management.ts)** - Server-side session handling

## 🤝 Contributing

We welcome contributions to improve the documentation and examples! Here's how you can help:

### Ways to Contribute

- **📝 Improve Documentation** - Fix typos, clarify explanations, add examples
- **🎯 Create Examples** - Add examples for new use cases or domains
- **🔧 Update Code Samples** - Ensure examples work with latest framework versions
- **📚 Write Guides** - Create tutorials for specific patterns or integrations
- **🐛 Report Issues** - Found a bug in docs or examples? Let us know!

### Getting Started

1. **Fork** the repository
2. **Clone** your fork: `git clone https://github.com/your-username/agent.git`
3. **Install** dependencies: `bun install`
4. **Make changes** in the appropriate domain directory
5. **Test examples** by running them: `bun run examples/your-example.ts`
6. **Submit** a pull request

### Documentation Structure

When adding new content, follow the domain-focused organization:

```
docs/
├── core/                    # Core framework docs
│   ├── agent/              # Agent architecture & lifecycle
│   ├── routing/            # AI routing system & intelligent selection
│   ├── conversation-flows/ # Route DSL, steps, data collection
│   ├── ai-integration/     # Providers, prompts, response processing
│   ├── tools/              # Tool definition, execution, scoping
│   └── persistence/        # Session storage & database adapters
└── guides/                 # End-to-end guides
    └── [guide-name]/       # getting-started, building-agents, etc.

examples/
├── core-concepts/          # Basic agent setup & fundamental concepts
├── ai-providers/           # AI provider integrations
├── conversation-flows/     # AI routing & conversation patterns
├── persistence/            # Session storage implementations
├── tools/                  # Tool creation & execution patterns
├── advanced-patterns/      # Complex use cases & integrations
└── integrations/           # External service integrations
```

### Example Contribution Workflow

1. **Identify the domain** your example belongs to (e.g., `tools`, `persistence`)
2. **Create the example** in the appropriate domain directory
3. **Add comprehensive comments** explaining the concepts
4. **Include error handling** and best practices
5. **Update documentation** links if needed
6. **Test thoroughly** before submitting

### Need Help?

- 📖 **[Contributing Guide](./CONTRIBUTING.md)** - Detailed contribution guidelines
- 💬 **[Discussions](https://github.com/falai-dev/agent/discussions)** - Ask questions and get help
- 🐛 **[Issues](https://github.com/falai-dev/agent/issues)** - Report bugs or request features

---

**Made with ❤️ for the community**
