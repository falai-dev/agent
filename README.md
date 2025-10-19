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

- **Advanced Tool System** - Context-aware tools with data access and lifecycle integration
- **Dynamic Tool Calling** - AI can call tools during streaming responses
- **Tool Result Processing** - Tools update context and collected data automatically

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

</td>
</tr>
<tr>
<td width="50%">

### 🚀 **Advanced Features**

- **Streaming Responses** - Real-time response generation with tool execution
- **Lifecycle Hooks** - `prepare`/`finalize` functions or tools on steps, context/data update hooks
- **Sequential Steps** - Define linear conversation flows with `steps` array
- **Route Transitions** - Automatic flow transitions when routes complete
- **Smart Step Control** - `skipIf` and `requires` for data-driven flow control

</td>
<td width="50%">

### 🎨 **Behavioral Control**

- **Guidelines & Rules** - Define agent behavior patterns and restrictions
- **Route-Specific Logic** - Different rules for different conversation contexts
- **Knowledge Base** - Structured information available to AI during responses
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
import {
  Agent,
  GeminiProvider,
  createMessageEvent,
  EventSource,
} from "@falai/agent";

// Create your agent
const agent = new Agent({
  name: "Assistant",
  description: "A helpful assistant",
  provider: new GeminiProvider({
    apiKey: process.env.GEMINI_API_KEY,
    model: "models/gemini-2.5-flash",
  }),
});

// Create a simple route with sequential steps
agent.createRoute({
  title: "General Help",
  description: "Answers user questions",
  conditions: ["User needs help or asks a question"],
  steps: [
    {
      id: "answer_question",
      description: "Answer the user's question helpfully",
      prompt: "Answer the user's question helpfully",
    },
  ],
});

// Start chatting
const response = await agent.respond({
  history: [
    createMessageEvent(EventSource.CUSTOMER, "Alice", "What can you do?"),
  ],
});

console.log(response.message);
```

**That's it!** You now have a working conversational AI agent.

---

## 🔧 Advanced Step Configuration

### Using Tools as Prepare/Finalize Hooks

Steps can use tools for `prepare` and `finalize` lifecycle hooks, enabling powerful data processing and side effects:

```typescript
// Define a preparation tool
const validateUser = {
  id: "validate_user",
  description: "Validate user data before processing",
  parameters: { type: "object", properties: {} },
  handler: ({ context, data }) => {
    // Validation logic
    if (!data.email?.includes("@")) {
      throw new Error("Invalid email address");
    }
    return { data: "User validated" };
  },
};

// Use tools in step lifecycle
agent.createRoute({
  title: "User Registration",
  schema: {
    /* ... */
  },
  steps: [
    {
      id: "collect_info",
      description: "Collect user information",
      collect: ["name", "email"],
      prompt: "Please provide your name and email.",
      finalize: validateUser, // Tool validates data after collection
    },
    {
      id: "send_welcome",
      description: "Send welcome email",
      prompt: "Welcome! Check your email for confirmation.",
      prepare: "send_welcome_email", // Tool ID string - sends email before AI responds
    },
  ],
});
```

**Benefits:**

- ✅ **Reusable Logic** - Tools can be shared across steps and routes
- ✅ **Error Handling** - Tool execution includes automatic error handling
- ✅ **Context Access** - Tools receive full context and collected data
- ✅ **Data Updates** - Tools can modify collected data or agent context

---

### Level 2: Data Extraction (The Real Power)

Now let's build an agent that intelligently collects structured data:

```typescript
import {
  Agent,
  OpenAIProvider,
  createMessageEvent,
  EventSource,
  type Tool,
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
    model: "gpt-4", // or your preferred model
  }),
});

// 3️⃣ Define a tool that uses the collected data
const bookHotel: Tool<unknown, [], string, HotelBookingData> = {
  id: "book_hotel",
  description: "Books a hotel once all information is collected.",
  parameters: { type: "object", properties: {} },
  handler: ({ data }) => {
    const bookingData = data as Partial<HotelBookingData>;
    // Logic to book the hotel...
    return {
      data: `Booking confirmed for ${bookingData.guests} guests at ${bookingData.hotelName} on ${bookingData.date}!`,
    };
  },
};

const schema = {
  type: "object",
  properties: {
    hotelName: { type: "string", description: "The name of the hotel." },
    date: { type: "string", description: "The desired booking date." },
    guests: { type: "number", description: "The number of guests." },
  },
  required: ["hotelName", "date", "guests"],
};

// 4️⃣ Create a data-driven route with sequential steps
agent.createRoute<HotelBookingData>({
  title: "Book Hotel",
  description: "Guides the user through the hotel booking process.",
  conditions: ["User wants to book a hotel"],
  schema,
  // 5️⃣ Define the flow to collect data step-by-step
  steps: [
    {
      id: "ask_hotel",
      description: "Ask which hotel they want to book",
      prompt: "Which hotel would you like to book?",
      collect: ["hotelName"],
      skipIf: (data: Partial<HotelBookingData>) => !!data.hotelName,
    },
    {
      id: "ask_date",
      description: "Ask for the booking date",
      prompt: "What date would you like to book for?",
      collect: ["date"],
      requires: ["hotelName"],
      skipIf: (data: Partial<HotelBookingData>) => !!data.date,
    },
    {
      id: "ask_guests",
      description: "Ask for the number of guests",
      prompt: "How many guests will be staying?",
      collect: ["guests"],
      requires: ["hotelName", "date"],
      skipIf: (data: Partial<HotelBookingData>) => data.guests !== undefined,
    },
    {
      id: "confirm_booking",
      description: "Confirm and book the hotel",
      prompt: "Let me confirm your booking details.",
      tools: [bookHotel],
      requires: ["hotelName", "date", "guests"],
    },
  ],
});

// 5️⃣ Start conversing
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
// Expected: "What date would you like to book for?"
```

**That's it!** The data-driven agent will:

- ✅ **Understand the Goal** - Route to the `Book Hotel` flow based on user intent.
- ✅ **Extract Known Data** - Automatically pull `hotelName` and `guests` from the first message.
- ✅ **Skip Unneeded Steps** - Use `skipIf` to bypass questions for data it already has.
- ✅ **Collect Missing Data** - Intelligently ask only for the missing `date`.
- ✅ **Execute Deterministically** - Call the `bookHotel` tool only when all required data is present.

This creates a flexible and natural conversation, guided by a clear data structure.

📖 **[See more examples →](./examples/)** | **[Full tutorial →](./docs/guides/getting-started/README.md)**

### ⚡ Advanced Features

**Streaming responses** for real-time UX:

```typescript
for await (const chunk of agent.respondStream({
  history: [createMessageEvent(EventSource.CUSTOMER, "Alice", "Hello")],
})) {
  process.stdout.write(chunk.delta);
  if (chunk.done) {
    console.log("\nTool calls:", chunk.toolCalls);
  }
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

📋 **[Complete Documentation Index →](docs/README.md)** - Searchable index of all docs

### 🚀 Getting Started

- **[Quick Start Guide](./docs/guides/getting-started/README.md)** - Build your first agent in 15 minutes

### 🏗️ Core Framework

- **[Agent Orchestration](./docs/core/agent/README.md)** - Agent lifecycle, configuration & hooks
- **[Context Management](./docs/core/agent/context-management.md)** - Dynamic context providers & updates
- **[Session Management](./docs/core/agent/session-management.md)** - Session persistence & state

### 💬 Conversation Flows

- **[Routes](./docs/core/conversation-flows/routes.md)** - Route definition & lifecycle
- **[Steps](./docs/core/conversation-flows/steps.md)** - Step transitions & logic

### 🤖 AI Integration

- **[AI Providers](./docs/core/ai-integration/providers.md)** - Gemini, OpenAI, Anthropic, OpenRouter
- **[Prompt Composition](./docs/core/ai-integration/prompt-composition/)** - How prompts are built
- **[Response Processing](./docs/core/ai-integration/response-processing/)** - Schema extraction & tool calls

### 🔧 Tools & Data

- **[Tool Definition](./docs/core/tools/tool-definition.md)** - Creating and configuring tools
- **[Tool Execution](./docs/core/tools/tool-execution.md)** - Dynamic tool calling and context updates
- **[Tool Scoping](./docs/core/tools/tool-scoping.md)** - Agent, route, and step-level tool management

### 💾 Persistence

- **[Session Storage](./docs/core/persistence/session-storage.md)** - Session persistence patterns
- **[Database Adapters](./docs/core/persistence/adapters.md)** - Built-in adapter configurations

### 🚀 Advanced Guides

- **[Building Agents](./docs/guides/building-agents/)** - Complete agent construction patterns
- **[Advanced Patterns](./docs/guides/advanced-patterns/)** - Complex use cases & integrations
- **[API Reference](./docs/api/overview.md)** - Complete API documentation

---

## 🎯 Examples - By Domain

### 🏗️ Core Concepts

Fundamental patterns every agent needs:

- **[Basic Agent](./examples/core-concepts/basic-agent.ts)** - Minimal agent setup and configuration
- **[Schema-Driven Extraction](./examples/core-concepts/schema-driven-extraction.ts)** - Type-safe data collection with JSON Schema
- **[Session Management](./examples/core-concepts/session-management.ts)** - Multi-turn conversations with persistence
- **[Context Providers](./examples/core-concepts/context-providers.ts)** - Dynamic context fetching and updates

### 💬 Conversation Flows

Building intelligent dialogue systems:

- **[Simple Route](./examples/conversation-flows/simple-route.ts)** - Basic route with linear step progression
- **[Data-Driven Flows](./examples/conversation-flows/data-driven-flows.ts)** - Conditional logic with skipIf and requires
- **[Conditional Branching](./examples/conversation-flows/conditional-branching.ts)** - AI-powered branching decisions
- **[Completion Transitions](./examples/conversation-flows/completion-transitions.ts)** - Route transitions when flows complete

### 🤖 AI Providers

Integrating different AI services:

- **[Gemini Integration](./examples/ai-providers/gemini-integration.ts)** - Google Gemini with advanced features
- **[OpenAI Integration](./examples/ai-providers/openai-integration.ts)** - GPT-4 and GPT-3.5 Turbo
- **[Anthropic Integration](./examples/ai-providers/anthropic-integration.ts)** - Claude with streaming and tool calling
- **[Custom Provider](./examples/ai-providers/custom-provider.ts)** - Build your own AI provider integration

### 💾 Persistence

Session storage and data persistence:

- **[Memory Sessions](./examples/persistence/memory-sessions.ts)** - In-memory session management
- **[Redis Persistence](./examples/persistence/redis-persistence.ts)** - High-performance Redis storage
- **[Database Persistence](./examples/persistence/database-persistence.ts)** - SQL/NoSQL database integration
- **[Custom Adapter](./examples/persistence/custom-adapter.ts)** - Build custom persistence adapters

### 🔧 Tools

Tool creation and data manipulation:

- **[Basic Tools](./examples/tools/basic-tools.ts)** - Simple tool creation and execution
- **[Data Enrichment Tools](./examples/tools/data-enrichment-tools.ts)** - Tools that modify collected data
- **[Context Updating Tools](./examples/tools/context-updating-tools.ts)** - Tools that modify agent context
- **[Domain Scoped Tools](./examples/tools/domain-scoped-tools.ts)** - Tool security and access control

### 🚀 Advanced Patterns

Complex use cases and integrations:

- **[Multi-Turn Conversations](./examples/advanced-patterns/multi-turn-conversations.ts)** - Complex dialogue flows with backtracking
- **[Streaming Responses](./examples/advanced-patterns/streaming-responses.ts)** - Real-time response streaming
- **[Route Lifecycle Hooks](./examples/advanced-patterns/route-lifecycle-hooks.ts)** - Custom route behavior
- **[Custom Response Schemas](./examples/advanced-patterns/custom-response-schemas.ts)** - Advanced schema patterns

### 🔗 Integrations

External service integrations:

- **[Server Deployment](./examples/integrations/server-deployment.ts)** - HTTP API with WebSocket streaming
- **[Database Integration](./examples/integrations/database-integration.ts)** - Direct database access patterns
- **[Webhook Integration](./examples/integrations/webhook-integration.ts)** - HTTP webhook handling
- **[API Integration](./examples/integrations/api-integration.ts)** - External API calls and responses

📖 **[See all examples with detailed explanations →](./examples/)**

---

## 🏗️ How It Works

`@falai/agent` uses a **schema-first, pipeline-driven architecture** with sophisticated data extraction and lifecycle management:

```
User Message + Session State
    ↓
┌─────────────────────────────────────────┐
│ 1. RESPONSE PIPELINE                    │
│    • Prepare context & session          │
│    • Handle pending transitions         │
│    • Execute step prepare() functions   │
└─────────────────────────────────────────┘
    ↓
┌─────────────────────────────────────────┐
│ 2. ROUTING + STEP SELECTION            │
│    • Evaluate routes (AI scoring)       │
│    • Filter steps (skipIf, requires)    │
│    • Select best route & step           │
└─────────────────────────────────────────┘
    ↓
┌─────────────────────────────────────────┐
│ 3. RESPONSE GENERATION                 │
│    • Build prompt with context/schema   │
│    • Stream or generate AI response     │
│    • Extract data via JSON Schema       │
│    • Execute dynamic tools (streaming)  │
└─────────────────────────────────────────┘
    ↓
┌─────────────────────────────────────────┐
│ 4. POST-PROCESSING                     │
│    • Run finalize() functions           │
│    • Update context/data (lifecycle)    │
│    • Auto-save session                  │
│    • Handle route completion/transitions│
└─────────────────────────────────────────┘
    ↓
Response + Updated Session State
```

### Key Principles:

✅ **AI decides:** Route selection, message generation, data extraction, tool calling
✅ **Code decides:** Step flow control (`skipIf`/`requires`), tool execution, lifecycle hooks, data validation
✅ **Result:** Predictable, testable agents with natural conversations

### New Features:

🚀 **Streaming Support**: Real-time response generation with tool execution
🔄 **Lifecycle Hooks**: `prepare`/`finalize` functions or tools, context/data update hooks
📊 **Data-Driven Flows**: Smart step skipping, prerequisite checking, schema validation
🛠️ **Advanced Tools**: Context-aware tools with data access and lifecycle integration
💾 **Session Management**: Automatic persistence, state restoration, route transitions

📖 **[Read the architecture docs →](./docs/core/agent/README.md)**

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

👶 **New to AI agents?** → [Quick Start Guide](./docs/guides/getting-started/README.md)
🏗️ **Building production app?** → [Agent Architecture](./docs/core/agent/README.md)
💡 **Have questions?** → [Open a discussion](https://github.com/falai-dev/agent/discussions)

---

### ⭐ Star us on [GitHub](https://github.com/falai-dev/agent)

**Help us reach more developers building production AI!**

[Report Bug](https://github.com/falai-dev/agent/issues) • [Request Feature](https://github.com/falai-dev/agent/issues) • [Contribute](https://github.com/falai-dev/agent/pulls)

**Made with ❤️ for the community**

</div>
