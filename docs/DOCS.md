# Documentation Index

Complete index of all `@falai/agent` documentation.

---

## 🚀 Getting Started

Start here if you're new to the framework:

### [Getting Started Guide](./GETTING_STARTED.md)

Build your first AI agent in 5 minutes with step-by-step instructions.

**Topics:** Installation, first agent, basic routes, data extraction, session state

---

## 📖 Core Concepts

Essential guides for understanding how the framework works:

### [Architecture](./ARCHITECTURE.md)

Design principles, philosophy, and how the framework works under the hood.

**Topics:** Schema-first extraction, session state, code-based logic, state machines, deterministic IDs

### [Agent](./AGENT.md)

Comprehensive guide to agent configuration patterns.

**Topics:** Declarative vs fluent API, terms, guidelines, capabilities, routes, initialization patterns

### [Context Management](./CONTEXT_MANAGEMENT.md)

Session state, lifecycle hooks, and persistent conversations.

**Topics:** Session state, lifecycle hooks, context updates, multi-turn conversations, persistence patterns

---

## 🔧 Feature Guides

Deep dives into specific features:

### [Routes Guide](./ROUTES.md)

Complete guide to creating and managing conversational routes.

**Topics:** Route creation, initial state configuration, data extraction, sequential steps, security, branching logic

### [States Guide](./STATES.md)

Complete guide to creating and managing states in conversational flows.

**Topics:** State types, transitions, data gathering, state logic, skip conditions, configuration, advanced patterns

### [API Reference](./API_REFERENCE.md)

Complete API documentation for all classes, methods, and types.

**Topics:** Agent class, Route class, State class, defineTool, providers, all APIs

### [AI Providers](./PROVIDERS.md)

Guide to AI provider configuration and usage.

**Topics:** Anthropic (Claude), OpenAI (GPT), Google (Gemini), OpenRouter, custom providers, backup models, retry logic

### [Domain Organization](./DOMAINS.md)

Optional tool security and organization.

**Topics:** Domain-based security, tool scoping, route isolation, preventing unauthorized access

### [Persistence Guide](./PERSISTENCE.md)

Database integration and session persistence.

**Topics:** Persistence adapters, auto-save, session management, lifecycle integration, custom adapters

### [Database Adapters](./ADAPTERS.md)

Detailed comparison and configuration for all database adapters.

**Topics:** Prisma, Redis, MongoDB, PostgreSQL, SQLite, OpenSearch, Memory adapter, custom adapters

---

## 💡 Examples & Patterns

Real-world code examples:

### [Examples Guide](./EXAMPLES.md)

Comprehensive guide to all 15+ production-ready examples.

**Topics:** Learning path, use case guide, code examples, quick reference

### [Example Files](../examples/)

Browse the `/examples` directory for runnable code:

- [Business Onboarding](../examples/business-onboarding.ts) - Complex multi-step workflows
- [Travel Agent](../examples/travel-agent.ts) - Session state & data extraction
- [Healthcare Agent](../examples/healthcare-agent.ts) - Security & validation
- [Streaming Agent](../examples/streaming-agent.ts) - Real-time responses
- [Prisma Persistence](../examples/prisma-persistence.ts) - Database integration
- [Domain Scoping](../examples/domain-scoping.ts) - Tool security
- [And 10+ more...](./EXAMPLES.md)

---

## 🤝 Contributing

Help improve the framework:

### [Contributing Guide](./CONTRIBUTING.md)

How to contribute code, documentation, and report issues.

**Topics:** Development setup, code style, pull requests, bug reports

### [Publishing Guide](./PUBLISHING.md)

Internal guide for maintainers on publishing releases.

**Topics:** Release process, versioning, npm publishing, changelog

---

## 📚 Quick Reference

### By Use Case

**I want to...**

- **Build my first agent** → [Getting Started](./GETTING_STARTED.md)
- **Understand the design** → [Architecture](./ARCHITECTURE.md)
- **Configure my agent** → [Agent](./AGENT.md)
- **Create conversational flows** → [Routes Guide](./ROUTES.md)
- **Manage states** → [States Guide](./STATES.md)
- **Persist conversations** → [Persistence Guide](./PERSISTENCE.md)
- **Add tool security** → [Domain Organization](./DOMAINS.md)
- **See real examples** → [Examples Guide](./EXAMPLES.md)
- **Look up an API** → [API Reference](./API_REFERENCE.md)
- **Use a different AI provider** → [AI Providers](./PROVIDERS.md)
- **Choose a database** → [Database Adapters](./ADAPTERS.md)
- **Contribute code** → [Contributing Guide](./CONTRIBUTING.md)

### By Topic

**Architecture & Design:**

- [Architecture Guide](./ARCHITECTURE.md)
- [How It Works](../README.md#-how-it-works)

**Agent Configuration:**

- [Agent](./AGENT.md)
- [Context Management](./CONTEXT_MANAGEMENT.md)
- [Getting Started](./GETTING_STARTED.md)

**Routes & State Machines:**

- [Routes Guide](./ROUTES.md) - Complete guide to routes
- [States Guide](./STATES.md) - Complete guide to states
- [API Reference - Routes](./API_REFERENCE.md#route)
- [API Reference - States](./API_REFERENCE.md#state)
- [Architecture - State Machines](./ARCHITECTURE.md#state-machines)
- [Examples - Complex Flows](./EXAMPLES.md#-real-world-applications)

**Tools & Domains:**

- [Domain Organization](./DOMAINS.md)
- [API Reference - defineTool](./API_REFERENCE.md#definetool)
- [Examples - Domain Scoping](./EXAMPLES.md#-domain-scoping)

**Data Extraction:**

- [Architecture - Schema-First](./ARCHITECTURE.md#schema-first-data-extraction)
- [API Reference - extractionSchema](./API_REFERENCE.md#extractionschema)
- [Examples - Travel Agent](./EXAMPLES.md#-travel-agent)

**Session State:**

- [Context Management](./CONTEXT_MANAGEMENT.md)
- [Architecture - Session State](./ARCHITECTURE.md#session-state-management)
- [API Reference - createSession](./API_REFERENCE.md#createsession)

**Persistence:**

- [Persistence Guide](./PERSISTENCE.md)
- [Database Adapters](./ADAPTERS.md)
- [Examples - Prisma](./EXAMPLES.md#-prisma-persistence)

**AI Providers:**

- [AI Providers Guide](./PROVIDERS.md)
- [API Reference - Providers](./API_REFERENCE.md#providers)
- [Examples - Multiple Providers](./EXAMPLES.md#-provider-examples)

**Streaming:**

- [API Reference - respondStream](./API_REFERENCE.md#respondstream)
- [Examples - Streaming](./EXAMPLES.md#-streaming-responses)

---

## 📖 Documentation Format Guide

All documentation follows these conventions:

### Code Examples

All code examples are TypeScript and can be copy-pasted directly.

### Links

- Internal docs use relative links: `[Text](./FILE.md)`
- Examples use relative links: `[Text](../examples/file.ts)`
- External links use full URLs

---

## 🔍 Search Tips

**Looking for something specific?**

1. **Check this index first** for the right doc
2. **Use your browser's find** (Ctrl+F / Cmd+F) within docs
3. **Check the [Examples Guide](./EXAMPLES.md)** for code samples
4. **Search the [API Reference](./API_REFERENCE.md)** for specific APIs

**Common searches:**

- "How do I..." → [Getting Started](./GETTING_STARTED.md)
- "What is..." → [Architecture](./ARCHITECTURE.md)
- "Example of..." → [Examples Guide](./EXAMPLES.md)
- "API for..." → [API Reference](./API_REFERENCE.md)

---

## 📱 External Resources

- **Main Website:** [falai.dev](https://falai.dev)
- **GitHub Repository:** [github.com/gusnips/falai](https://github.com/gusnips/falai)
- **npm Package:** [@falai/agent](https://www.npmjs.com/package/@falai/agent)
- **Issue Tracker:** [GitHub Issues](https://github.com/gusnips/falai/issues)

---

## 🆘 Still Can't Find What You Need?

1. **Check the [main README](../README.md)** for an overview
2. **Browse [all examples](../examples/)** for code patterns
3. **Search [closed issues](https://github.com/gusnips/falai/issues?q=is%3Aissue+is%3Aclosed)** for similar questions
4. **Open a [new issue](https://github.com/gusnips/falai/issues/new)** with your question

---

**Last Updated:** 2025-10-15
