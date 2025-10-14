# Documentation

Welcome to the `@falai/agent` documentation!

## 📖 Documentation Structure

### Getting Started

- **[Getting Started Guide](./GETTING_STARTED.md)** - Build your first agent in 5 minutes

### Core Concepts

- **[Constructor Options](./CONSTRUCTOR_OPTIONS.md)** - Comprehensive guide to declarative vs fluent configuration
- **[Package Structure](./STRUCTURE.md)** - Architecture and design principles

### Reference

- **[API Reference](./API_REFERENCE.md)** - Complete API documentation for all classes, methods, and types
- **[AI Providers Guide](./PROVIDERS.md)** - Gemini, OpenAI, Anthropic, and custom providers
- **[Persistence Guide](./PERSISTENCE.md)** - Auto-save sessions and messages to any database
- **[Database Adapters](./ADAPTERS.md)** - Adapter comparison and configuration examples
- **[Contributing Guide](./CONTRIBUTING.md)** - How to contribute to the project
- **[Publishing Guide](./PUBLISHING.md)** - How to publish updates to npm

## 🎯 Quick Links

### By Use Case

**First time here?**
→ Start with [Getting Started](./GETTING_STARTED.md)

**Building a complex agent?**
→ Check [Constructor Options](./CONSTRUCTOR_OPTIONS.md)

**Need specific API details?**
→ Browse the [API Reference](./API_REFERENCE.md)

**Understanding the codebase?**
→ Read [Package Structure](./STRUCTURE.md)

**Need persistence?**
→ See [Persistence Guide](./PERSISTENCE.md)

### By Topic

- **Agent Configuration**: [Constructor Options](./CONSTRUCTOR_OPTIONS.md)
- **Conversation Flows**: [API Reference - Routes](./API_REFERENCE.md#route)
- **Tools & Functions**: [API Reference - Tools](./API_REFERENCE.md#definetool)
- **Disambiguation**: [API Reference - Observations](./API_REFERENCE.md#observation)
- **AI Providers**: [Providers Guide](./PROVIDERS.md) | [API Reference](./API_REFERENCE.md#geminiprovider)
- **Database Persistence**: [Persistence Guide](./PERSISTENCE.md) | [Adapters](./ADAPTERS.md)

## 💡 Examples

Check out the [`examples/`](../examples/) directory for complete, runnable examples:

### Core Examples

- **[Declarative Agent](../examples/declarative-agent.ts)** - Full constructor-based configuration
- **[Travel Agent](../examples/travel-agent.ts)** - Complex multi-route travel booking system
- **[Healthcare Agent](../examples/healthcare-agent.ts)** - Disambiguation with observations
- **[Streaming Agent](../examples/streaming-agent.ts)** - Real-time streaming responses

### Persistence Examples

- **[Prisma Persistence](../examples/prisma-persistence.ts)** - Auto-save with Prisma ORM
- **[Redis Persistence](../examples/redis-persistence.ts)** - Fast in-memory persistence

### Provider Examples

- **[OpenAI Agent](../examples/openai-agent.ts)** - GPT-5 integration
- **[Gemini Agent](../examples/gemini-agent.ts)** - Google Gemini integration
- **[Anthropic Agent](../examples/healthcare-agent.ts)** - Claude 3.5 Sonnet

### Advanced Examples

- **[Domain Scoping](../examples/domain-scoping.ts)** - Control tool access per route
- **[Rules & Prohibitions](../examples/rules-prohibitions.ts)** - Fine-grained behavior control

## 🤝 Contributing

Found an error in the docs? Want to add examples? See our [**Contributing Guide**](./CONTRIBUTING.md) for:

- How to set up your development environment
- Code style guidelines
- Pull request process
- Ways you can help

We welcome all contributions - from typo fixes to new features!

---

**Made with ❤️ for the community**
