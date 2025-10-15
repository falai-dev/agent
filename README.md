<div align="center">

# 🤖 @falai/agent

### Build intelligent, conversational AI agents with TypeScript

**Standalone • Strongly-Typed • Production-Ready**

[![TypeScript](https://img.shields.io/badge/TypeScript-5.3+-blue.svg)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)
[![Bun](https://img.shields.io/badge/bun-compatible-orange.svg)](https://bun.sh)
[![Website](https://img.shields.io/badge/🌐-falai.dev-brightgreen.svg)](https://falai.dev)

[🌐 Website](https://falai.dev) • [Features](#-features) • [Installation](#-installation) • [Quick Start](#-quick-start) • [Documentation](#-documentation) • [Examples](#-examples)

</div>

---

## 🌟 Features

<table>
<tr>
<td width="50%">

### 🎯 **Developer Experience**

- **Fully Type-Safe** - Generic `Agent<TContext>` with complete inference
- **Fluent API** - Chainable methods for elegant code
- **Modular Design** - Use what you need, when you need it

</td>
<td width="50%">

### 🚀 **Production Ready**

- **Robust Retry Logic** - Exponential backoff & backup models
- **AI Provider Strategy** - Pluggable backends (Claude, Gemini, OpenAI, OpenRouter)
- **Prompt Composition** - Sophisticated prompt building system

</td>
</tr>
<tr>
<td width="50%">

### 🛤️ **Data-Driven Conversations**

- **Schema-First Extraction** - Define data contracts with JSON Schema
- **Session State Management** - Track conversation progress across turns
- **AI-Driven State Transitions** - Smart state selection based on conversation context
- **Text-Based Conditions** - Human-readable transition conditions for the AI to evaluate
- **Code-Based Logic** - Deterministic state progression with `skipIf` and `requiredData`
- **Always-On Routing** - Context-aware routing respects user intent changes

</td>
<td width="50%">

### 🔧 **Tools & Data Integration**

- **Data-Aware Tools** - Tools access extracted data directly via `extracted` context
- **Enrichment Hooks** - Tools can modify extracted data with `extractedUpdate`
- **Action Flags** - Tools set flags for conditional execution
- **Type-Safe Tools** - Define tools with full type inference

</td>
</tr>
<tr>
<td width="50%">

### 💾 **Optional Persistence**

- **Session State Integration** - Automatic saving of extracted data & conversation progress
- **Provider Pattern** - Simple API like AI providers
- **Multiple Adapters** - Prisma, Redis, MongoDB, PostgreSQL, SQLite, OpenSearch, Memory
- **Custom Database Support** - Manual session state management for existing schemas
- **Auto-save** - Automatic session state & message persistence
- **Type-Safe** - Full TypeScript support with generics
- **Extensible** - Create adapters for any database

</td>
<td width="50%">

### 🎯 **Session-Aware Routing**

- **Always-On Routing** - Users can change their mind mid-conversation
- **Context Awareness** - Router sees current progress and extracted data
- **Session State** - Track conversation progress across turns
- **Deterministic IDs** - Consistent identifiers across restarts

</td>
</tr>
</table>

---

## 🏗️ Architecture

`@falai/agent` uses a **state machine-driven architecture** where:

- 🎯 **Conversations are explicit state machines** - Predictable, testable flows using the Route DSL
- 🔧 **Tools execute automatically** - Based on state transitions and guideline matching, not AI decisions
- 🧠 **AI only generates messages** - The AI never sees or calls tools; it just creates natural responses
- 🔄 **Preparation iterations gather data** - Tools run in loops before message generation to enrich context
- 📦 **Domain-based organization** - Tools grouped logically with route-level access control

**Example:**

```typescript
route.initialState
  .transitionTo({ chatState: "What's your name?" })
  .transitionTo(
    { toolState: saveName }, // ← Tool executes automatically
    "User provided their name"
  )
  .transitionTo({ chatState: "Thanks! What's your email?" });
```

The AI generates conversational messages while the engine handles tool execution and flow control. This creates **deterministic, controllable agents** perfect for structured conversations like customer support, onboarding, and multi-step processes.

📖 **[Read the full architecture guide →](./docs/ARCHITECTURE.md)**

---

## 📦 Installation

```bash
# Using bun (recommended)
bun add @falai/agent

# Using npm
npm install @falai/agent

# Using yarn
yarn add @falai/agent
```

> **Requirements:** Node.js 18+ or Bun 1.0+

---

## 🚀 Quick Start

Build a conversational AI agent in 2 minutes:

```typescript
import {
  Agent,
  GeminiProvider,
  defineTool,
  createMessageEvent,
  EventSource,
} from "@falai/agent";

// 1️⃣ Create your agent
const agent = new Agent({
  name: "BookingBot",
  description: "Hotel booking assistant",
  ai: new GeminiProvider({
    apiKey: process.env.GEMINI_API_KEY!,
    model: "models/gemini-2.5-flash",
  }),
  context: { userId: "user_123" },
});

// 2️⃣ Define a simple tool
const checkAvailability = defineTool(
  "check_availability",
  async (ctx, hotelName: string, date: string) => {
    return { data: `${hotelName} has rooms available on ${date}` };
  },
  { description: "Check hotel availability" }
);

// 3️⃣ Create a route with 2 states
const bookingRoute = agent.createRoute({
  title: "Book Hotel",
  conditions: ["User wants to book a hotel"],
});

bookingRoute.initialState
  .transitionTo(
    { toolState: checkAvailability },
    "User provided hotel name and date"
  )
  .transitionTo({ chatState: "Confirm booking and provide summary" });

// 4️⃣ Start conversing
const response = await agent.respond({
  history: [
    createMessageEvent(
      EventSource.CUSTOMER,
      "Alice",
      "Book me a room at Grand Hotel for tomorrow"
    ),
  ],
});

console.log(response.message); // 🎉 AI handles the rest!
```

**That's it!** The agent will:
- ✅ Route to the correct conversation flow
- ✅ Execute tools automatically when conditions match
- ✅ Generate natural responses based on state

📖 **[See more examples →](./docs/EXAMPLES.md)** | **[Full tutorial →](./docs/GETTING_STARTED.md)**

### ⚡ Advanced Features

**Streaming responses** for real-time UX:
```typescript
for await (const chunk of agent.respondStream({ history })) {
  process.stdout.write(chunk.delta);
}
```

**Session state** for multi-turn conversations:
```typescript
let session = createSession<MyData>();
const response = await agent.respond({ history, session });
session = response.session!; // Tracks progress across turns
```

**Database persistence** with any adapter:
```typescript
import { PrismaAdapter } from "@falai/agent";
const agent = new Agent({
  persistence: { adapter: new PrismaAdapter({ prisma }) }
});
```

📖 **[See full feature docs →](./docs)**

---

## 📚 Documentation

📋 **[Complete Documentation Index →](docs/DOCS.md)** - Searchable index of all docs

**Core Guides:**
- 📘 **[Getting Started](./docs/GETTING_STARTED.md)** - Build your first agent in 5 minutes
- 🏗️ **[Architecture](./docs/ARCHITECTURE.md)** - Design principles & philosophy
- 🔧 **[API Reference](./docs/API_REFERENCE.md)** - Complete API documentation
- 📝 **[Examples](./docs/EXAMPLES.md)** - Production-ready code examples

**Feature Guides:**
- 💾 **[Persistence](./docs/PERSISTENCE.md)** - Database integration with adapters
- 🔒 **[Domains](./docs/DOMAINS.md)** - Optional tool security & organization
- 🎛️ **[Constructor Options](./docs/CONSTRUCTOR_OPTIONS.md)** - Configuration patterns
- 📊 **[Context Management](./docs/CONTEXT_MANAGEMENT.md)** - Session state & lifecycle hooks
- 🤖 **[AI Providers](./docs/PROVIDERS.md)** - Anthropic, OpenAI, Gemini, OpenRouter

---

## 🎯 Examples

**Core Examples:**
- 🏢 **[Business Onboarding](./examples/business-onboarding.ts)** - Complex multi-step flow with branching
- ✈️ **[Travel Agent](./examples/travel-agent.ts)** - Multi-route booking system with session state
- 🏥 **[Healthcare Assistant](./examples/healthcare-agent.ts)** - Appointment scheduling & lab results
- 📋 **[Declarative Agent](./examples/declarative-agent.ts)** - Full constructor-based configuration
- ⚡ **[Streaming Responses](./examples/streaming-agent.ts)** - Real-time response streaming

**Persistence & Advanced:**
- 💾 **[Prisma Persistence](./examples/prisma-persistence.ts)** - Auto-save with Prisma ORM
- ⚡ **[Redis Persistence](./examples/redis-persistence.ts)** - Fast in-memory sessions
- 🔐 **[Domain Scoping](./examples/domain-scoping.ts)** - Tool security per route
- 📜 **[Rules & Prohibitions](./examples/rules-prohibitions.ts)** - Fine-grained behavior control

📖 **[See all examples with descriptions →](./docs/EXAMPLES.md)**

---

## 🏗️ How It Works

`@falai/agent` uses a **state machine-driven architecture** where conversations flow through explicit states:

1. **Router** - AI selects the best route based on conversation context
2. **State Machine** - Routes define explicit states and transitions
3. **Data Extraction** - JSON Schema defines data to extract during conversation
4. **Tool Execution** - Tools run automatically when state conditions match
5. **Message Generation** - AI generates natural responses based on current state

**Behind the scenes:**
- The AI only generates messages and extracts data - it never decides which tools to call
- Tools execute deterministically based on state transitions and code-based conditions
- Session state tracks progress and extracted data across conversation turns
- Always-on routing lets users change direction mid-conversation

This creates **predictable, testable agents** perfect for production use cases.

📖 **[Read the full architecture guide →](./docs/ARCHITECTURE.md)**

---

## 🤝 Contributing

We welcome contributions! See our [Contributing Guide](./docs/CONTRIBUTING.md) for details on:

- 🐛 Reporting bugs
- 💡 Suggesting features
- 📝 Improving documentation
- 🔨 Submitting pull requests

## 🎓 Inspired By

This framework draws inspiration from [**Parlant**](https://github.com/emcie-co/parlant) by Emcie Co., an excellent Python framework for conversational AI agents. We've adapted and enhanced these concepts for the TypeScript ecosystem with additional type safety and modern patterns.

---

## 📄 License

MIT © 2025

---

<div align="center">

**Made with ❤️ for the community**

[Report Bug](https://github.com/gusnips/falai/issues) • [Request Feature](https://github.com/gusnips/falai/issues) • [Contribute](https://github.com/gusnips/falai/pulls)

⭐ Star us on [GitHub](https://github.com/gusnips/falai) if this helped you build amazing agents!

</div>
