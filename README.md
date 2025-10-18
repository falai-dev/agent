<div align="center">

# 🤖 @falai/agent

### Type-Safe AI Conversational Agents That Actually Work in Production

**Schema-driven data extraction • Predictable conversations • Enterprise-ready**

[![TypeScript](https://img.shields.io/badge/TypeScript-5.3+-blue.svg)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)
[![Bun](https://img.shields.io/badge/bun-compatible-orange.svg)](https://bun.sh)
[![Website](https://img.shields.io/badge/🌐-falai.dev-brightgreen.svg)](https://falai.dev)

[🌐 Website](https://falai.dev) • [Features](#-features) • [Installation](#-installation) • [Quick Start](#-quick-start) • [Documentation](#-documentation) • [Examples](#-examples)

</div>

---

## ⚡ The @falai/agent Difference

### Traditional AI Chat:

```typescript
// User: "I want to book the Grand Hotel for 2 people"
// AI: "Sure! Which hotel would you like?" // 😠 Asked already!
// User: "Grand Hotel"
// AI: "How many guests?"                 // 😠 You just told me!
// User: "2 people"
// AI: "What date?"                        // Finally...
```

### With @falai/agent:

```typescript
// User: "I want to book the Grand Hotel for 2 people"
// AI: "Sure! For what date would you like to book?"  // ✅ Skips known info
// User: "Next Friday"
// AI: "Booking confirmed for 2 guests at Grand Hotel on Friday!" // ✅ All data collected
```

**No more repetitive questions. No more guessing what the AI will ask next.**

Schema-first extraction means the AI automatically captures what you've already said, and only asks for what's missing.

---

## 🤔 Why @falai/agent?

After building production AI applications, we found existing solutions either:

- **Too unpredictable** - AI decides everything, including which tools to call (unreliable in production)
- **Too complex** - Heavy Python frameworks with massive dependencies
- **Too basic** - No structured data extraction or step management

@falai/agent gives you **predictable AI** - the creativity of LLMs with the reliability of code.

**The key insight:** Let AI do what it's good at (understanding intent, generating responses, extracting data), and let TypeScript handle the rest (step logic, tool execution, validation).

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
- **Session Step Management** - Track progress across conversation turns
- **Flexible Step Transitions** - Use AI, text, or code (`skipIf`) for flow control
- **Always-On Routing** - Context-aware routing between different flows

</td>
<td width="50%">

### 🔧 **Tools & Data Integration**

- **Data-Aware Tools** - Tools access collected data directly via `data` context
- **Enrichment Hooks** - Tools can modify collected data with `dataUpdate`
- **Action Flags** - Tools set flags for conditional execution

</td>
</tr>
<tr>
<td width="50%">

### 💾 **Optional Persistence**

- **Auto-Save** - Automatically persist conversation data and progress
- **Extensible Adapters** - Use built-in (Prisma, Redis, etc.) or create your own
- **Custom DB Support** - Integrate with your existing database schemas

</td>
<td width="50%">

### 🎯 **Session-Aware Routing**

- **Always-On Routing** - Users can change their mind mid-conversation
- **Context Awareness** - Router sees current progress and collected data
- **Session Step** - Track conversation progress across turns

</td>
</tr>
</table>

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

### Level 1: Your First Agent (30 seconds)

Create a minimal conversational agent:

```typescript
import { Agent, GeminiProvider } from "@falai/agent";

// Create your agent
const agent = new Agent({
  name: "Assistant",
  description: "A helpful assistant",
  provider: new GeminiProvider({
    apiKey: process.env.GEMINI_API_KEY,
    model: "models/gemini-2.5-flash",
  }),
});

// Create a simple route
agent.createRoute({
  title: "General Help",
  description: "Answers user questions",
  conditions: ["User needs help or asks a question"],
  initialStep: {
    prompt: "Answer the user's question helpfully",
  },
});

// Start chatting
const response = await agent.respond({
  history: [{ source: "customer", name: "Alice", content: "What can you do?" }],
});

console.log(response.message);
```

**That's it!** You now have a working conversational AI agent.

---

### Level 2: Data Extraction (The Real Power)

Now let's build an agent that intelligently collects structured data:

```typescript
import {
  Agent,
  OpenAIProvider,
  defineTool,
  createMessageEvent,
  EventSource,
  END_ROUTE,
  type ToolContext,
} from "@falai/agent";

// 1️⃣ Define the data you want to collect
interface HotelBookingData {
  hotelName: string;
  date: string;
  guests: number;
}

// 2️⃣ Create your agent
const agent = new Agent({
  name: "BookingBot",
  description: "A hotel booking assistant that collects information.",
  provider: new OpenAIProvider({
    apiKey: process.env.OPENAI_API_KEY,
    model: "gpt-5", // or your preferred model
  }),
});

// 3️⃣ Define a tool that uses the collected data
const bookHotel = defineTool(
  "book_hotel",
  async ({ data }: ToolContext<{}, HotelBookingData>) => {
    // Logic to book the hotel...
    return {
      data: `Booking confirmed for ${data?.guests} at ${data?.hotelName} on ${data?.date}!`,
    };
  },
  { description: "Books a hotel once all information is collected." }
);

const schema = {
  type: "object",
  properties: {
    hotelName: { type: "string", description: "The name of the hotel." },
    date: { type: "string", description: "The desired booking date." },
    guests: { type: "number", description: "The number of guests." },
  },
  required: ["hotelName", "date", "guests"],
};

// 4️⃣ Create a data-driven route
const bookingRoute = agent.createRoute<HotelBookingData>({
  title: "Book Hotel",
  description: "Guides the user through the hotel booking process.",
  conditions: ["User wants to book a hotel"],
  schema,
  endStep: {
    prompt: "Confirm the booking details warmly and thank the user",
  },
});

// 5️⃣ Build the flow to collect data step-by-step
const askHotel = bookingRoute.initialStep.nextStep({
  prompt: "Ask which hotel they want to book",
  collect: ["hotelName"],
  skipIf: (data) => !!data.hotelName, // Skip if we already have it
});

const askDate = askHotel.nextStep({
  prompt: "Ask for the booking date",
  collect: ["date"],
  skipIf: (data) => !!data.date,
});

const askGuests = askDate.nextStep({
  prompt: "Ask for the number of guests",
  collect: ["guests"],
  skipIf: (data) => !!data.guests,
});

const confirmBooking = askGuests.nextStep({
  tool: bookHotel,
  condition:
    "All required information (hotel, date, guests) has been collected.",
});

confirmBooking.nextStep({
  step: END_ROUTE, // End the conversation flow
});

// 6️⃣ Start conversing
const response = await agent.respond({
  history: [
    createMessageEvent(
      EventSource.CUSTOMER,
      "Alice",
      "I want to book a room at the Grand Hotel for 2 people."
    ),
  ],
});

// The agent sees that `hotelName` and `guests` are provided,
// skips the first and third steps, and only asks for the date.
console.log(response.message);
// Expected: "Sure, for what date would you like to book at the Grand Hotel?"
```

**That's it!** The data-driven agent will:

- ✅ **Understand the Goal** - Route to the `Book Hotel` flow based on user intent.
- ✅ **Extract Known Data** - Automatically pull `hotelName` and `guests` from the first message.
- ✅ **Skip Unneeded Steps** - Use `skipIf` to bypass questions for data it already has.
- ✅ **Collect Missing Data** - Intelligently ask only for the missing `date`.
- ✅ **Execute Deterministically** - Call the `bookHotel` tool only when all required data is present.

This creates a flexible and natural conversation, guided by a clear data structure.

📖 **[See more examples →](./docs/EXAMPLES.md)** | **[Full tutorial →](./docs/GETTING_STARTED.md)**

### ⚡ Advanced Features

**Streaming responses** for real-time UX:

```typescript
for await (const chunk of agent.respondStream({ history })) {
  process.stdout.write(chunk.delta);
}
```

**Session step** for multi-turn conversations:

```typescript
let session = createSession<MyData>();
const response = await agent.respond({ history, session });
session = response.session!; // Tracks progress across turns, you can use it to save the current step in your database
```

**Database persistence** with any adapter:

```typescript
import { PrismaAdapter } from "@falai/agent";
const agent = new Agent({
  persistence: { adapter: new PrismaAdapter({ prisma }) },
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

- 🛤️ **[Routes](./docs/ROUTES.md)** - Creating conversational routes & flows
- 🔄 **[Steps](./docs/STEPS.md)** - Managing steps & transitions
- 💾 **[Persistence](./docs/PERSISTENCE.md)** - Database integration with adapters
- 🔒 **[Domains](./docs/DOMAINS.md)** - Optional tool security & organization
- 🎛️ **[Agent](./docs/AGENT.md)** - Configuration patterns
- 📊 **[Context Management](./docs/CONTEXT_MANAGEMENT.md)** - Session step & lifecycle hooks
- 🤖 **[AI Providers](./docs/PROVIDERS.md)** - Anthropic, OpenAI, Gemini, OpenRouter

---

## 🎯 Examples - Pick Your Use Case

### 🤖 Conversational Flows

Build intelligent data-collecting conversations:

- 🏢 **[Business Onboarding](./examples/business-onboarding.ts)** - Multi-step company setup with conditional branching
- ✈️ **[Travel Agent](./examples/travel-agent.ts)** - Flight & hotel booking with session step
- 🏥 **[Healthcare Assistant](./examples/healthcare-agent.ts)** - Appointment scheduling & lab result delivery

### 🏢 Production Patterns

Enterprise-ready features:

- 💾 **[Prisma Persistence](./examples/prisma-persistence.ts)** - Auto-save sessions with Prisma ORM
- ⚡ **[Redis Persistence](./examples/redis-persistence.ts)** - High-performance in-memory sessions
- 🔐 **[Domain Scoping](./examples/domain-scoping.ts)** - Tool security & access control

### ⚡ Advanced Techniques

Power-user features:

- 📋 **[Declarative Agent](./examples/declarative-agent.ts)** - Full constructor-based configuration
- ⚡ **[Streaming Responses](./examples/streaming-agent.ts)** - Real-time response streaming
- 📜 **[Rules & Prohibitions](./examples/rules-prohibitions.ts)** - Fine-grained behavior control

📖 **[See all examples with detailed explanations →](./docs/EXAMPLES.md)**

---

## 🏗️ How It Works

`@falai/agent` uses a **schema-first, step machine-driven architecture**:

```
User Message
    ↓
┌─────────────────────────────────────────┐
│ 1. PREPARATION (Tools)                  │
│    • Execute tools for current step    │
│    • Update context with results        │
│    • Enrich collected data              │
└─────────────────────────────────────────┘
    ↓
┌─────────────────────────────────────────┐
│ 2. ROUTING (AI-Driven)                  │
│    • Evaluate all routes                │
│    • Consider session context           │
│    • Select best route (0-100 score)    │
└─────────────────────────────────────────┘
    ↓
┌─────────────────────────────────────────┐
│ 3. STEP SELECTION (Code + AI)          │
│    • Filter steps with skipIf (code)   │
│    • AI picks best from valid steps    │
│    • Update session step               │
└─────────────────────────────────────────┘
    ↓
┌─────────────────────────────────────────┐
│ 4. RESPONSE (AI + Schema)               │
│    • Extract data via JSON Schema       │
│    • Generate natural message           │
│    • Update session with new data       │
└─────────────────────────────────────────┘
    ↓
Response with Structured Data
```

### Key Principles:

✅ **AI decides:** Route selection, step selection (from valid options), message generation, data extraction
✅ **Code decides:** Tool execution, step filtering (`skipIf`), data validation, flow control
✅ **Result:** Predictable, testable agents with natural conversations

**This architecture delivers 1-2 LLM calls per turn** (vs 3-5 in traditional approaches) while maintaining complete type safety.

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

## 🚀 Ready to Build?

**Choose your path:**

👶 **New to AI agents?** → [5-minute tutorial](./docs/GETTING_STARTED.md)
🏗️ **Building production app?** → [Architecture guide](./docs/ARCHITECTURE.md)
💡 **Have questions?** → [Open a discussion](https://github.com/falai-dev/agent/discussions)

---

### ⭐ Star us on [GitHub](https://github.com/falai-dev/agent)

**Help us reach more developers building production AI!**

[Report Bug](https://github.com/falai-dev/agent/issues) • [Request Feature](https://github.com/falai-dev/agent/issues) • [Contribute](https://github.com/falai-dev/agent/pulls)

**Made with ❤️ for the community**

</div>
