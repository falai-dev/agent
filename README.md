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

### 🛤️ **Conversation Flows**

- **Route DSL** - Declarative state machines for conversations
- **Smart Transitions** - Conditional flows with `transitionTo`
- **Disambiguation** - Observations for handling ambiguous intent

</td>
<td width="50%">

### 🔧 **Tools & Domains**

- **Type-Safe Tools** - Define tools with full type inference
- **Domain Registry** - Optional security & organization by domain
- **Context Awareness** - Tools receive typed context automatically
- **Automatic Execution** - Tools run based on state machine, not AI

</td>
</tr>
<tr>
<td width="50%">

### 💾 **Optional Persistence**

- **Provider Pattern** - Simple API like AI providers
- **Prisma Ready** - Built-in ORM adapter
- **Auto-save** - Automatic session & message persistence
- **Extensible** - Create adapters for any database

</td>
<td width="50%">

### 🎯 **Smart Routing**

- **Deterministic IDs** - Consistent identifiers across restarts
- **Route Scoping** - Control tool access per route
- **Rules & Prohibitions** - Fine-grained behavior control

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

Get up and running in 60 seconds:

```typescript
import {
  Agent,
  AnthropicProvider,
  GeminiProvider,
  OpenAIProvider,
  OpenRouterProvider,
  createMessageEvent,
  EventSource,
} from "@falai/agent";

// 1️⃣ Define your custom context
interface SupportContext {
  userId: string;
  userName: string;
  tier: "free" | "premium";
}

// 2️⃣ Create AI provider (choose one)
const ai = new AnthropicProvider({
  apiKey: process.env.ANTHROPIC_API_KEY!,
  model: "claude-sonnet-4-5",
});

// Or use other providers:
// const ai = new GeminiProvider({
//   apiKey: process.env.GEMINI_API_KEY!,
//   model: "models/gemini-2.5-flash",
// });

// const ai = new OpenAIProvider({
//   apiKey: process.env.OPENAI_API_KEY!,
//   model: "gpt-5",
// });

// const ai = new OpenRouterProvider({
//   apiKey: process.env.OPENROUTER_API_KEY!,
//   model: "anthropic/claude-sonnet-4-5", // Access to 200+ models
// });

// 3️⃣ Initialize your agent - two ways!

// Option A: Declarative initialization (recommended for complex setups)
const agent = new Agent<SupportContext>({
  name: "SupportBot",
  description: "A helpful and empathetic customer support assistant",
  goal: "Resolve customer issues efficiently while maintaining a positive experience",
  ai,
  context: {
    userId: "usr_123",
    userName: "Alex",
    tier: "premium",
  },
  // Initialize with arrays
  terms: [
    {
      name: "Premium Support",
      description: "24/7 priority support with dedicated account manager",
    },
  ],
  guidelines: [
    {
      condition: "Customer asks about account issues",
      action: "Prioritize account security and verify identity first",
      tags: ["security", "account"],
    },
  ],
  routes: [
    {
      title: "Account Recovery",
      description: "Help users regain access to their accounts",
      conditions: ["User cannot access their account"],
    },
  ],
});

// Option B: Fluent chaining (great for dynamic additions)
agent
  .createGuideline({
    condition: "Customer is frustrated",
    action: "Show extra empathy and offer immediate escalation",
    tags: ["support", "escalation"],
  })
  .createTerm({
    name: "SLA",
    description: "Service Level Agreement - our response time commitment",
  });

// 4️⃣ Generate intelligent responses
const response = await agent.respond({
  history: [
    createMessageEvent(
      EventSource.CUSTOMER,
      "Alex",
      "I can't access my dashboard"
    ),
  ],
});

console.log(response.message); // 🎉 AI-powered response ready!
```

### ⚡ Streaming Responses (NEW!)

Stream AI responses in real-time for better user experience:

```typescript
// Use respondStream for real-time streaming
for await (const chunk of agent.respondStream({ history })) {
  // chunk.delta contains the new text
  process.stdout.write(chunk.delta);

  if (chunk.done) {
    // Stream complete - access final metadata
    console.log("\n✅ Complete!");
    console.log("Route:", chunk.route?.title);
    console.log("Tool calls:", chunk.toolCalls?.length);
  }
}
```

**Benefits:**

- ✨ Real-time response generation
- 🎯 Better perceived performance
- 🛑 Cancellable with AbortSignal
- 📊 Access to route/state/tool information in final chunk

**Supported Providers:** All providers support streaming (Anthropic, OpenAI, Gemini, OpenRouter)

See [streaming-agent.ts](./examples/streaming-agent.ts) for complete examples.

---

## 🔒 Domain-Based Security (Optional)

Domains let you **optionally** organize and restrict tools for security. **If you never use domains, your agent works perfectly** - all tools are available everywhere.

### Without Domains (Simple & Default)

```typescript
const agent = new Agent({ name: "My Agent", ai: provider });

// Define tools normally
const saveName = defineTool(/* ... */);
const processPayment = defineTool(/* ... */);

// All tools work everywhere
const route = agent.createRoute({ title: "Onboarding" });
route.initialState
  .transitionTo({ toolState: saveName }) // ✅ Works
  .transitionTo({ toolState: processPayment }); // ✅ Works
```

### With Domains (Security & Organization)

```typescript
// Organize tools into security domains
agent.addDomain("user", {
  saveName: async (name) => {
    /* ... */
  },
});

agent.addDomain("payment", {
  processPayment: async (amount) => {
    /* ... */
  },
});

// Restrict which tools each route can use
const onboardingRoute = agent.createRoute({
  title: "Onboarding",
  domains: ["user"], // ONLY user tools can execute
});

const checkoutRoute = agent.createRoute({
  title: "Checkout",
  domains: ["payment"], // ONLY payment tools can execute
});

// Security: payment tools can't execute in onboarding route
onboardingRoute.initialState
  .transitionTo({ toolState: agent.domain.user.saveName }) // ✅ Allowed
  .transitionTo({ toolState: agent.domain.payment.processPayment }); // ❌ Blocked!
```

**When to use domains:**

- ✅ Production systems with sensitive operations
- ✅ Preventing prompt injection attacks
- ✅ Route isolation (checkout can't trigger account deletion)
- ❌ Skip for prototypes and simple agents

📖 **[Full Domain Guide →](./docs/DOMAINS.md)** | [Example →](./examples/domain-scoping.ts)

---

## 📚 Documentation

### 📖 Guides

- **[Architecture](./docs/ARCHITECTURE.md)** - Design principles & philosophy ⭐
- **[Getting Started](./docs/GETTING_STARTED.md)** - Your first agent in 5 minutes
- **[Constructor Options](./docs/CONSTRUCTOR_OPTIONS.md)** - Declarative vs Fluent API patterns
- **[Context Management](./docs/CONTEXT_MANAGEMENT.md)** - Persistent conversations & state management
- **[Persistence](./docs/PERSISTENCE.md)** - Optional database persistence with Prisma **(NEW!)**
- **[API Reference](./docs/API_REFERENCE.md)** - Complete API documentation
- **[Package Structure](./docs/STRUCTURE.md)** - Package structure and design principles

### 💡 Key Concepts

### 💬 Working with Conversation History

Build rich conversation contexts:

```typescript
import { EventSource, createMessageEvent, createToolEvent } from "@falai/agent";

const history = [
  createMessageEvent(
    EventSource.CUSTOMER,
    "Alice",
    "Book me a flight to Paris"
  ),
  createMessageEvent(
    EventSource.AI_AGENT,
    "TravelBot",
    "I'd love to help! When would you like to travel?"
  ),
  createMessageEvent(EventSource.CUSTOMER, "Alice", "Next Friday"),
  // Tool calls are tracked too
  createToolEvent("search_flights", {
    destination: "Paris",
    date: "2025-10-20",
  }),
];

const response = await agent.respond({ history });
```

### 🔧 Defining Type-Safe Tools

Tools are first-class citizens:

```typescript
import { defineTool } from "@falai/agent";

const fetchUserProfile = defineTool<
  SupportContext,
  [userId: string],
  { name: string; email: string; tier: string }
>(
  "fetch_user_profile",
  async ({ context }, userId) => {
    // Full access to typed context
    console.log(`Fetching for ${context.userName}`);

    const profile = await db.users.findById(userId);
    return { data: profile };
  },
  {
    id: "tool_fetch_user_profile", // Optional: custom ID for persistence
    description: "Retrieves user profile information from the database",
  }
);

// Use in guidelines
agent.createGuideline({
  condition: "Customer asks about their account details",
  action: "Fetch and present their profile information",
  tools: [fetchUserProfile],
});
```

### 🛤️ Creating Conversation Routes

Build sophisticated conversation flows - declaratively or programmatically:

```typescript
import { END_ROUTE } from "@falai/agent";

// Option A: Declarative (in constructor)
const agent = new Agent({
  name: "OnboardingBot",
  ai: provider,
  routes: [
    {
      id: "route_user_onboarding", // Optional: custom ID for consistency
      title: "User Onboarding",
      description: "Guide new users through account setup",
      conditions: ["User is new and needs onboarding"],
      guidelines: [
        {
          condition: "User provides invalid email",
          action: "Politely ask for a valid email format",
          tags: ["validation"],
        },
      ],
    },
  ],
});

// Option B: Programmatic (build flows dynamically)
const onboardingRoute = agent.createRoute({
  id: "route_user_onboarding", // Optional: custom ID
  title: "User Onboarding",
  description: "Guide new users through account setup",
  conditions: ["User is new and needs onboarding"],
});

// Option 1: Step-by-step (clear and explicit)
const askName = onboardingRoute.initialState.transitionTo({
  chatState: "Ask for user's full name",
});

const askEmail = askName.transitionTo({
  chatState: "Request email address",
});

const confirmDetails = askEmail.transitionTo({
  chatState: "Confirm all details before proceeding",
});

confirmDetails.transitionTo({ state: END_ROUTE });

// Option 2: Fluent chaining (concise and elegant)
onboardingRoute.initialState
  .transitionTo({ chatState: "Ask for user's full name" })
  .transitionTo({ chatState: "Request email address" })
  .transitionTo({ chatState: "Confirm all details before proceeding" })
  .transitionTo({ state: END_ROUTE });

// Both approaches work identically - choose what fits your style!

// Add guidelines dynamically (can also be in route options)
onboardingRoute.createGuideline({
  condition: "User provides invalid email",
  action: "Politely ask for a valid email format",
  enabled: true,
  tags: ["validation"],
});
```

### 📜 Rules & Prohibitions Per Route

Control agent behavior and communication style for each route:

```typescript
// WhatsApp support bot with different styles per route
agent.createRoute({
  title: "Quick Support",
  description: "Fast answers for common questions",
  conditions: ["User has a simple question"],
  rules: [
    "Keep messages extremely short (1-2 lines maximum)",
    "Use bullet points for lists",
    "Maximum 1 emoji per message 👍",
    "Be direct and to the point",
  ],
  prohibitions: [
    "Never send long paragraphs",
    "Do not over-explain",
    "Never use more than 2 emojis",
  ],
});

agent.createRoute({
  title: "Sales Consultation",
  description: "Help customer discover needs",
  conditions: ["User is interested in buying"],
  rules: [
    "Ask open-ended questions to discover needs",
    "Use storytelling when presenting solutions",
    "Present value before mentioning price",
  ],
  prohibitions: [
    "Never talk about price before showing value",
    "Do not pressure or push",
    "Avoid technical jargon",
  ],
});

agent.createRoute({
  title: "Emergency Support",
  description: "Handle urgent issues",
  conditions: ["Customer is frustrated", "Urgent issue"],
  rules: [
    "Acknowledge the urgency immediately",
    "Express empathy and understanding",
    "Set clear expectations on resolution time",
  ],
  prohibitions: [
    "Never downplay the customer's concern",
    "Do not use emojis (keep it professional)",
    'Never say "calm down"',
  ],
});
```

**Use Cases:**

- 📱 Different message styles per channel (WhatsApp, email, chat)
- 🎭 Context-specific tone and behavior
- 🎨 Brand consistency across routes
- ⚡ Automatic enforcement without manual checking

### 🔐 Domain Scoping for Security

Restrict which tools are available in each route:

```typescript
// Register different tool domains
agent.addDomain("payment", {
  processPayment: async (amount: number) => {
    /* ... */
  },
  refund: async (txId: string) => {
    /* ... */
  },
});

agent.addDomain("calendar", {
  scheduleEvent: async (date: Date, title: string) => {
    /* ... */
  },
});

agent.addDomain("analytics", {
  trackEvent: async (name: string) => {
    /* ... */
  },
});

// Route 1: Customer Support - NO access to payment tools
agent.createRoute({
  title: "Customer Support",
  description: "Answer general questions",
  domains: [], // 🔒 No tools (conversation only)
});

// Route 2: Checkout - ONLY payment and analytics
agent.createRoute({
  title: "Checkout Process",
  description: "Process purchases",
  domains: ["payment", "analytics"], // 🔒 Limited access
});

// Route 3: Admin - ALL tools available
agent.createRoute({
  title: "Admin Support",
  description: "Full system access",
  // domains not specified = all domains available
});
```

**Benefits:**

- 🔒 Prevent unauthorized tool calls
- ⚡ Improve AI performance (reduced decision space)
- 📋 Clear documentation of route capabilities
- 🛡️ Security by design

### 🔀 Disambiguation with Observations

Handle ambiguous user intent gracefully - declaratively or programmatically:

```typescript
// Option A: Declarative (reference routes by title)
const agent = new Agent({
  name: "HealthBot",
  ai: provider,
  routes: [
    {
      id: "route_schedule", // Custom ID
      title: "Schedule Appointment",
      conditions: ["User wants to schedule"],
    },
    {
      id: "route_reschedule", // Custom ID
      title: "Reschedule Appointment",
      conditions: ["User wants to reschedule"],
    },
  ],
  observations: [
    {
      id: "obs_appointment_intent", // Custom ID for tracking
      description: "User mentions appointment but intent is unclear",
      routeRefs: ["Schedule Appointment", "Reschedule Appointment"], // By title
    },
  ],
});

// Option B: Programmatic
const scheduleRoute = agent.createRoute({
  id: "route_schedule", // Custom ID
  title: "Schedule Appointment",
  conditions: ["User wants to schedule"],
});

const rescheduleRoute = agent.createRoute({
  id: "route_reschedule", // Custom ID
  title: "Reschedule Appointment",
  conditions: ["User wants to reschedule"],
});

const appointmentInquiry = agent.createObservation(
  "User mentions appointment but intent is unclear"
);

// Agent will ask user to clarify between these routes
appointmentInquiry.disambiguate([scheduleRoute, rescheduleRoute]);
```

### 🎨 Context Override

Dynamically update context per request:

```typescript
const response = await agent.respond({
  history,
  contextOverride: {
    tier: "premium", // Temporarily upgrade user for this request
  },
});
```

### 🔄 Persistent Context Management

For **multi-turn conversations** that persist across requests, use lifecycle hooks:

```typescript
import { Agent, type ContextLifecycleHooks } from "@falai/agent";

// Define persistence hooks
const hooks: ContextLifecycleHooks<MyContext> = {
  // Load fresh context before each response
  beforeRespond: async (currentContext) => {
    return await database.loadContext(sessionId);
  },

  // Persist context after updates
  onContextUpdate: async (newContext, previousContext) => {
    await database.saveContext(sessionId, newContext);
  },
};

const agent = new Agent({
  name: "PersistentBot",
  ai: provider,
  context: initialContext,
  hooks, // Enable automatic persistence
});

// Tools can update context
const saveTool = defineTool("save_data", async (ctx, data) => {
  // Option 1: Return context update
  return {
    data: true,
    contextUpdate: { savedData: data },
  };

  // Option 2: Call updateContext directly
  // await ctx.updateContext({ savedData: data });
  // return { data: true };
});
```

**Key patterns:**

- ✅ **Recreate agents** for each request (context loaded fresh via hooks)
- ✅ **Use `onContextUpdate`** to persist to database/cache
- ✅ **Use `beforeRespond`** to load fresh context before responding
- ❌ **Don't cache agent instances** across requests (context gets stale)

See [Context Management Guide](./docs/CONTEXT_MANAGEMENT.md) for complete patterns and best practices.

### 💾 Optional Database Persistence (NEW!)

For **production applications** that need to persist sessions and messages:

```typescript
import { Agent, PrismaAdapter } from "@falai/agent";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const agent = new Agent({
  name: "My Agent",
  ai: provider,
  // ✨ Just add this!
  persistence: {
    adapter: new PrismaAdapter({ prisma }),
    autoSave: true,
    userId: "user_123",
  },
});

// Access persistence manager
const persistence = agent.getPersistenceManager();

// Create a session
const session = await persistence.createSession({
  userId: "user_123",
  agentName: "My Agent",
});

// Load history
const history = await persistence.loadSessionHistory(session.id);

// Generate response
const response = await agent.respond({ history });

// Optionally Save message (automatically saves if autoSave: true)
await persistence.saveMessage({
  sessionId: session.id,
  role: "agent",
  content: response.message,
});
```

**Features:**

- ✅ **Provider Pattern** - Simple API like AI providers
- ✅ **Prisma Built-in** - Ready-to-use ORM adapter
- ✅ **Auto-save** - Automatic message tracking
- ✅ **Custom Adapters** - Create for any database (MongoDB, Redis, etc.)
- ✅ **Lifecycle Integration** - Works seamlessly with context hooks

**Setup (3 steps):**

1. Install: `npm install @prisma/client prisma`
2. Copy schema from `examples/prisma-schema.example.prisma`
3. Run: `npx prisma generate && npx prisma migrate dev`

See [Persistence Guide](./docs/PERSISTENCE.md) for complete documentation and custom adapter examples.

### 📖 Domain Glossary

Teach your agent business-specific language:

```typescript
agent
  .createTerm({
    name: "SLA",
    description: "Service Level Agreement - our commitment to response times",
    synonyms: ["service agreement", "support guarantee"],
  })
  .createTerm({
    name: "Priority Support",
    description: "Premium tier feature with <1hr response time",
    synonyms: ["premium support", "fast track"],
  });
```

### 🆔 Deterministic IDs & Persistence

All entities (routes, states, observations, tools) have **deterministic IDs** by default, ensuring consistency across server restarts:

```typescript
import {
  generateRouteId,
  generateToolId,
  generateObservationId,
} from "@falai/agent";

// Auto-generated deterministic IDs (recommended)
const route = agent.createRoute({
  title: "User Onboarding",
  // ID will be: route_user_onboarding_{hash}
});

// Or provide custom IDs when you need specific control
const route = agent.createRoute({
  id: "my_custom_route_id", // Custom ID for database persistence
  title: "User Onboarding",
});

// Generate IDs manually if needed
const routeId = generateRouteId("User Onboarding");
const toolId = generateToolId("fetch_user_data");

// Custom timestamps for events (useful for historical data)
const event = createMessageEvent(
  EventSource.CUSTOMER,
  "Alice",
  "Hello!",
  "2025-10-13T10:30:00Z" // Optional: custom timestamp
);
```

**Why this matters:**

- ✅ **Database Safe** - Store IDs in your database without worrying about changes
- ✅ **Analytics Ready** - Track metrics and user journeys reliably
- ✅ **Multi-Instance** - Deploy multiple server instances with consistent IDs
- ✅ **Migration Friendly** - IDs remain stable during deployments

### ⚙️ Advanced Configuration

Fine-tune AI provider behavior - works with all providers:

```typescript
// Anthropic (Claude) configuration
const anthropicProvider = new AnthropicProvider({
  apiKey: process.env.ANTHROPIC_API_KEY!,
  model: "claude-sonnet-4-5", // Primary model
  backupModels: [
    "claude-opus-4-1", // Backup if primary fails
    "claude-sonnet-4-0", // Stable fallback
  ],
  config: {
    temperature: 0.7,
    top_p: 0.9,
  },
  retryConfig: {
    timeout: 60000, // 60s timeout
    retries: 3, // 3 attempts with exponential backoff
  },
});

// Gemini configuration
const geminiProvider = new GeminiProvider({
  apiKey: process.env.GEMINI_API_KEY!,
  model: "models/gemini-2.5-flash", // Primary model
  backupModels: [
    "models/gemini-2.5-pro", // Backup if primary fails
    "models/gemini-2.0-flash",
  ],
  retryConfig: {
    timeout: 60000,
    retries: 3,
  },
});

// OpenAI configuration
const openaiProvider = new OpenAIProvider({
  apiKey: process.env.OPENAI_API_KEY!,
  model: "gpt-5",
  backupModels: ["gpt-5-mini", "gpt-5-nano"],
  retryConfig: {
    timeout: 60000,
    retries: 3,
  },
});

// OpenRouter configuration (access to 200+ models)
const openrouterProvider = new OpenRouterProvider({
  apiKey: process.env.OPENROUTER_API_KEY!,
  model: "anthropic/claude-sonnet-4-5",
  backupModels: ["openai/gpt-5", "google/gemini-2.5-flash"],
  siteUrl: "https://yourapp.com",
  siteName: "Your App Name",
  retryConfig: {
    timeout: 60000,
    retries: 3,
  },
});
```

---

## 🎯 Examples

### 📋 [Declarative Agent](./examples/declarative-agent.ts)

**Comprehensive declarative configuration example:**

- 📦 Everything configured in constructor
- 📚 Terms, guidelines, capabilities, routes, observations
- 🔗 Route references by title in observations
- ➕ Dynamic additions after construction

### ⚡ [Streaming Responses](./examples/streaming-agent.ts) **(NEW!)**

**Real-time streaming responses for better UX:**

- 🌊 Stream responses from all providers (Anthropic, OpenAI, Gemini, OpenRouter)
- 📡 Real-time text generation with `respondStream`
- 🛑 Cancellable streams with AbortSignal
- 📊 Access route, state, and tool information
- 🎯 5 comprehensive examples covering different use cases

### 💾 [Persistent Onboarding Agent](./examples/persistent-onboarding.ts)

**Multi-turn conversation with state persistence:**

- 🔄 Context lifecycle hooks for database integration
- 💾 Automatic persistence on context updates
- 🏭 Factory pattern for agent creation
- 🔧 Two approaches: lifecycle hooks vs context provider
- 📝 Complete onboarding flow across multiple turns

### 💾 [Prisma Persistence](./examples/prisma-persistence.ts) **(NEW!)**

**Production-ready database persistence:**

- ✨ Provider pattern - simple as `new PrismaAdapter({ prisma })`
- 🗄️ Automatic session and message persistence
- 🔄 Seamless lifecycle hook integration
- 📊 Complete examples: basic, advanced, and minimal
- 🎯 3-step setup with Prisma ORM

### 🏢 [Business Onboarding](./examples/business-onboarding.ts)

**Production-ready business onboarding with advanced patterns:**

- 🎯 Real-world multi-step business setup flow
- 🔀 Complex branching logic (physical vs online business)
- 🔄 Tools with `contextUpdate` for automatic state management
- 🔗 Both step-by-step and fluent chaining approaches
- 🎨 Lifecycle hooks for agent caching and persistence
- 📊 Dynamic route creation based on collected data

### 🌍 [Travel Booking Agent](./examples/travel-agent.ts)

A complete travel agent implementation featuring:

- ✈️ Multi-step flight booking flow
- 🔄 Alternative options handling
- 🛠️ Real-world tool integration
- 📋 Status checking route
- 🎭 Edge case guidelines

### 🏥 [Healthcare Assistant](./examples/healthcare-agent.ts)

Healthcare-focused agent demonstrating:

- 🩺 Appointment scheduling with alternatives
- 🔬 Lab results retrieval
- 🤔 Observation-based disambiguation
- 🔐 Sensitive data handling
- ⚠️ Urgent case prioritization

### 🌐 Multiple Provider Examples

See how different AI providers work:

- **[OpenAI Agent](./examples/openai-agent.ts)** - GPT-5 integration
- **[Healthcare Agent](./examples/healthcare-agent.ts)** - Claude 3.5 Sonnet
- **[Travel Agent](./examples/travel-agent.ts)** - OpenRouter with backup models
- 🔄 All with backup model configuration and retry settings
- 🌤️ Weather checking example

### 🔐 [Domain Scoping](./examples/domain-scoping.ts)

Control tool access per route for security and clarity:

- 🔒 Restrict which tools are available in each route
- 🎯 Prevent unauthorized tool calls
- ⚡ Improve AI performance by reducing decision space
- 📋 Clear documentation of route capabilities

### 📜 [Rules & Prohibitions](./examples/rules-prohibitions.ts)

Control agent behavior and communication style per route:

- ✅ Define absolute rules the agent must follow
- ❌ Set prohibitions for what agent must never do
- 💬 Different communication styles per route
- 🎨 Perfect for multi-channel bots (WhatsApp, email, chat)

### 💾 [Prisma Persistence](./examples/prisma-persistence.ts)

Complete example of auto-saving sessions and messages with Prisma ORM:

- 💾 Auto-save sessions and messages to database
- 🔄 Load conversation history on agent initialization
- 📊 Track conversation state across restarts
- 🎯 Full example with lifecycle hooks
- 📝 Includes schema example

### ⚡ [Redis Persistence](./examples/redis-persistence.ts)

Fast, in-memory persistence for high-throughput applications:

- 🚀 Lightning-fast session storage
- ⏰ Configurable TTLs for auto-cleanup
- 🔑 Custom key prefixes
- 💨 Perfect for real-time chat applications

### 🔍 [OpenSearch Persistence](./examples/opensearch-persistence.ts)

Full-text search and analytics-powered persistence:

- 🔍 Built-in full-text search across all messages
- 📊 Powerful aggregations and analytics
- 🌐 Compatible with Elasticsearch 7.x
- ☁️ AWS OpenSearch Service ready

---

## 💾 Database Adapters

**Optional persistence** - Choose the database that fits your needs. All adapters follow the same simple provider pattern:

### 🎯 Available Adapters

| Adapter               | Use Case                           | Install                                      |
| --------------------- | ---------------------------------- | -------------------------------------------- |
| **PrismaAdapter**     | Type-safe ORM with migrations      | `npm install @prisma/client`                 |
| **RedisAdapter**      | Fast in-memory for real-time apps  | `npm install ioredis`                        |
| **MongoAdapter**      | Flexible document storage          | `npm install mongodb`                        |
| **PostgreSQLAdapter** | Raw SQL with auto table creation   | `npm install pg`                             |
| **SQLiteAdapter**     | Lightweight local database         | `npm install better-sqlite3`                 |
| **OpenSearchAdapter** | Full-text search & analytics       | `npm install @opensearch-project/opensearch` |
| **MemoryAdapter**     | Testing & development (no install) | Built-in (no dependencies) ✨                |

### ⚡ Quick Setup

```typescript
import { Agent, PrismaAdapter } from "@falai/agent";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const agent = new Agent({
  name: "My Agent",
  ai: provider,
  persistence: {
    adapter: new PrismaAdapter({ prisma }),
    userId: "user_123",
    autoSave: true, // Automatically save all messages
  },
});
```

That's it! Sessions and messages are now automatically persisted.

### 📚 Full Documentation

See [**docs/PERSISTENCE.md**](./docs/PERSISTENCE.md) for:

- Complete adapter API reference
- Custom table names & field mappings
- Lifecycle hooks for persistence
- Creating custom adapters
- Migration guides

See [**docs/ADAPTERS.md**](./docs/ADAPTERS.md) for:

- Detailed adapter comparison
- Configuration examples for each database
- Performance characteristics
- Type safety guarantees

---

## 🏗️ Architecture

```
src/
├── types/          # Type definitions (strongly typed contracts)
├── core/           # Core framework (Agent, Route, State, Tools, etc.)
├── providers/      # AI providers (Anthropic, Gemini, OpenAI, OpenRouter)
├── utils/          # Utilities (retry, timeout, helpers)
├── constants/      # Constants (END_ROUTE, symbols)
└── index.ts        # Public API exports
```

**Design Principles:**

- **Modularity** - Clean separation of concerns
- **Type Safety** - TypeScript generics throughout
- **Extensibility** - Pluggable providers & tools
- **Developer Experience** - Fluent APIs & clear patterns

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
