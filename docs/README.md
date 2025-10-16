# Documentation

Welcome to the `@falai/agent` documentation!

📋 **[Complete Documentation Index →](DOCS.md)** - Full searchable index of all docs

## 📖 Documentation Structure

### Getting Started

- **[Getting Started Guide](./GETTING_STARTED.md)** - Build your first agent in 5 minutes

### Core Concepts

- **[Architecture](./ARCHITECTURE.md)** - Design principles & philosophy (Data-driven sessions) ⭐ **UPDATED**
- **[Agent](./AGENT.md)** - Comprehensive guide to declarative vs fluent configuration ⭐ **UPDATED**
- **[Context Management](./CONTEXT_MANAGEMENT.md)** - Session state & data extraction patterns ⭐ **UPDATED**

### Conversational Flows

- **[Routes Guide](./ROUTES.md)** - Complete guide to creating and managing conversational routes ⭐ **NEW**
- **[States Guide](./STATES.md)** - Complete guide to creating and managing states ⭐ **NEW**

### Reference

- **[API Reference](./API_REFERENCE.md)** - Complete API documentation for all classes, methods, and types
- **[AI Providers Guide](./PROVIDERS.md)** - Gemini, OpenAI, Anthropic, and custom providers
- **[Domain Organization](./DOMAINS.md)** - Optional tool security & organization
- **[Persistence Guide](./PERSISTENCE.md)** - Auto-save sessions and messages to any database
- **[Database Adapters](./ADAPTERS.md)** - Adapter comparison and configuration examples

### Contributing

- **[Contributing Guide](./CONTRIBUTING.md)** - How to contribute to the project
- **[Publishing Guide](./PUBLISHING.md)** - How to publish updates to npm

## 🎯 Quick Links

### By Use Case

**First time here?**
→ Start with [Getting Started](./GETTING_STARTED.md)

**Understanding the design?**
→ Read [Architecture Guide](./ARCHITECTURE.md)

**Building a complex agent?**
→ Check [Agent](./AGENT.md)

**Creating conversational flows?**
→ See [Routes Guide](./ROUTES.md) and [States Guide](./STATES.md)

**Need tool security?**
→ See [Domain Organization](./DOMAINS.md)

**Need specific API details?**
→ Browse the [API Reference](./API_REFERENCE.md)

**Need persistence?**
→ See [Persistence Guide](./PERSISTENCE.md)

### By Topic

- **Architecture & Design**: [Architecture Guide](./ARCHITECTURE.md)
- **Agent Configuration**: [Agent](./AGENT.md) | [Context Management](./CONTEXT_MANAGEMENT.md)
- **Conversation Flows**: [Routes Guide](./ROUTES.md) | [States Guide](./STATES.md) | [API Reference - Routes](./API_REFERENCE.md#route)
- **Tools & Domains**: [Domain Organization](./DOMAINS.md) | [API Reference - Tools](./API_REFERENCE.md#definetool)
- **AI Providers**: [Providers Guide](./PROVIDERS.md) | [API Reference](./API_REFERENCE.md#geminiprovider)
- **Database Persistence**: [Persistence Guide](./PERSISTENCE.md) | [Adapters](./ADAPTERS.md)
- **Contributing**: [Contributing Guide](./CONTRIBUTING.md) | [Publishing Guide](./PUBLISHING.md)

## 💡 Examples

Check out the [`examples/`](../examples/) directory for complete, runnable examples:

### Core Examples

- **[Declarative Agent](../examples/declarative-agent.ts)** - Full constructor-based configuration
- **[Travel Agent](../examples/travel-agent.ts)** - Complex multi-route travel booking system
- **[Healthcare Agent](../examples/healthcare-agent.ts)** - Full example
- **[Streaming Agent](../examples/streaming-agent.ts)** - Real-time streaming responses
- **[Company Q&A Agent](../examples/company-qna-agent.ts)** - Stateless question-answering with knowledge base

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
- **[Extracted Data Modification](../examples/extracted-data-modification.ts)** - Tools that validate and enrich extracted data

## 🤝 Contributing

Found an error in the docs? Want to add examples? See our [**Contributing Guide**](./CONTRIBUTING.md) for:

- How to set up your development environment
- Code style guidelines
- Pull request process
- Ways you can help

We welcome all contributions - from typo fixes to new features!

---

**Made with ❤️ for the community**
