# Examples

This directory contains production-ready examples demonstrating all features of `@falai/agent`.

## 🚀 Getting Started Examples

### 🔄 [Route Transitions](../examples/route-transitions.ts) **NEW!**

**Perfect for:** Learning automatic workflow chaining

Complete example demonstrating the new `onComplete` feature for seamless route transitions:

- ✅ Hotel booking flow transitioning to feedback collection
- ✅ Three ways to define transitions (string, config, function)
- ✅ Automatic transition after route completion
- ✅ Manual transition control with `agent.transitionToRoute()`
- ✅ Dynamic logic based on extracted data
- ✅ Pending transition tracking in session state

**Key concepts:** Route transitions, workflow chaining, feedback collection, onComplete handlers

```typescript
// Automatic transition after booking completes
const bookingRoute = agent.createRoute<BookingData>({
  title: "Book Hotel",
  onComplete: "Collect Feedback", // Simple string

  // Or with AI condition:
  // onComplete: {
  //   transitionTo: "Collect Feedback",
  //   condition: "if booking was successful"
  // },

  // Or with function logic:
  // onComplete: (session) => {
  //   if (session.extracted?.guests > 5) {
  //     return "VIP Feedback";
  //   }
  //   return "Collect Feedback";
  // },
});

// Feedback route automatically triggered after booking
const feedbackRoute = agent.createRoute<FeedbackData>({
  title: "Collect Feedback",
  // ... states for collecting rating and comments
});
```

**Use cases:** Post-booking feedback, upsell flows, satisfaction surveys, error recovery

---

### 📋 [Declarative Agent](../examples/declarative-agent.ts)

**Perfect for:** Learning the full configuration API

Comprehensive example showing declarative agent configuration:

- ✅ Full constructor-based setup
- ✅ Terms, guidelines, capabilities, routes defined upfront
- ✅ Session state management with data extraction
- ✅ Custom IDs for routes, states, and tools
- ✅ Dynamic additions after construction

**Key concepts:** Declarative configuration, session state, data extraction schemas

```typescript
const agent = new Agent({
  name: "HealthBot",
  ai: provider,
  terms: [...],
  guidelines: [...],
  routes: [{
    extractionSchema: { /* JSON Schema */ }
  }]
});
```

---

## 🏢 Real-World Applications

### 🏢 [Business Onboarding](../examples/business-onboarding.ts)

**Perfect for:** Building complex multi-step workflows

Production-ready business onboarding with advanced patterns:

- ✅ Multi-step data collection flow
- ✅ Branching logic (physical vs online business)
- ✅ Tools with `contextUpdate` for automatic state management
- ✅ Both step-by-step and fluent chaining approaches
- ✅ Lifecycle hooks for persistence
- ✅ Dynamic route creation based on collected data

**Key concepts:** Complex flows, branching logic, context updates, lifecycle hooks

```typescript
// Branching based on business type
const askPhysicalLocation = askLocation.transitionTo({
  chatState: "Get physical store address",
  condition: "User has a physical store",
});

const askOnlineLocation = askLocation.transitionTo({
  chatState: "Get website and online support hours",
  condition: "User does not have a physical store",
});
```

### ✈️ [Travel Agent](../examples/travel-agent.ts)

**Perfect for:** Multi-route systems with session state

Complete travel booking system featuring:

- ✅ Multi-step flight booking flow
- ✅ Data extraction with JSON Schema
- ✅ Session state tracking across turns
- ✅ Tools with data access via `extracted` context
- ✅ Alternative flow handling (booking vs status check)
- ✅ Route-specific guidelines
- ✅ **NEW:** Automatic feedback collection after booking with `onComplete`

**Key concepts:** Session state, data extraction, multiple routes, tool data access, route transitions

```typescript
const searchFlights = defineTool(
  "search_flights",
  async ({ context, extracted }) => {
    // Tool has access to extracted booking data
    if (!extracted?.destination || !extracted?.departureDate) {
      return { data: [] };
    }
    // Use extracted data to search
    const flights = await searchAPI(extracted);
    return { data: flights };
  }
);
```

### 🏥 [Healthcare Assistant](../examples/healthcare-agent.ts)

**Perfect for:** Sensitive data handling and compliance

Healthcare-focused agent demonstrating:

- ✅ Appointment scheduling with validation
- ✅ Lab results retrieval
- ✅ Route-based disambiguation with conditions
- ✅ Sensitive data handling best practices
- ✅ Urgent case prioritization
- ✅ HIPAA-style security patterns
- ✅ **NEW:** Satisfaction survey after appointment with `onComplete`

**Key concepts:** Data security, route disambiguation, validation, compliance, route transitions

---

## ⚡ Advanced Features

### ⚡ [Streaming Responses](../examples/streaming-agent.ts)

**Perfect for:** Real-time UX and better perceived performance

Real-time streaming responses:

- ✅ Stream responses from all providers (Anthropic, OpenAI, Gemini, OpenRouter)
- ✅ Real-time text generation with `respondStream`
- ✅ Cancellable streams with AbortSignal
- ✅ Access route, state, and tool information in final chunk
- ✅ 5 comprehensive examples covering different use cases

**Key concepts:** Streaming, real-time UX, cancellation

```typescript
for await (const chunk of agent.respondStream({ history })) {
  process.stdout.write(chunk.delta);

  if (chunk.done) {
    console.log("Route:", chunk.route?.title);
    console.log("Extracted:", chunk.extracted);
  }
}
```

### 🔐 [Domain Scoping](../examples/domain-scoping.ts)

**Perfect for:** Security-conscious applications

Control tool access per route for security:

- ✅ Organize tools into security domains
- ✅ Restrict which tools each route can use
- ✅ Prevent unauthorized tool calls
- ✅ Improve AI performance by reducing decision space
- ✅ Clear documentation of route capabilities

**Key concepts:** Security, tool isolation, domain organization

```typescript
agent.addDomain("payment", { processPayment, refund });
agent.addDomain("user", { updateProfile, sendEmail });

// Checkout route can ONLY use payment tools
agent.createRoute({
  title: "Checkout",
  domains: ["payment"], // ← Security boundary
});
```

### 📜 [Rules & Prohibitions](../examples/rules-prohibitions.ts)

**Perfect for:** Multi-channel bots with different styles

Control agent behavior and communication style per route:

- ✅ Define absolute rules the agent must follow
- ✅ Set prohibitions for what agent must never do
- ✅ Different communication styles per route
- ✅ Perfect for multi-channel bots (WhatsApp, email, chat)
- ✅ Automatic enforcement without manual checking

**Key concepts:** Behavior control, tone management, channel-specific styling

```typescript
agent.createRoute({
  title: "WhatsApp Support",
  rules: ["Keep messages under 2 lines", "Use max 1 emoji"],
  prohibitions: ["Never send long paragraphs", "Don't over-explain"],
});

agent.createRoute({
  title: "Email Support",
  rules: ["Use professional tone", "Include clear next steps"],
  prohibitions: ["No emojis", "Avoid slang"],
});
```

---

## 💾 Persistence Examples

### 💾 [Prisma Persistence](../examples/prisma-persistence.ts)

**Perfect for:** Production apps with relational databases

Auto-save sessions and messages with Prisma ORM:

- ✅ Provider pattern - simple as `new PrismaAdapter({ prisma })`
- ✅ Automatic session and message persistence
- ✅ Seamless lifecycle hook integration
- ✅ Type-safe database operations
- ✅ 3-step setup guide

**Key concepts:** Database persistence, Prisma ORM, auto-save

```typescript
const agent = new Agent({
  persistence: {
    adapter: new PrismaAdapter({ prisma }),
    autoSave: true,
    userId: "user_123",
  },
});
```

### ⚡ [Redis Persistence](../examples/redis-persistence.ts)

**Perfect for:** High-throughput real-time applications

Fast, in-memory persistence:

- ✅ Lightning-fast session storage
- ✅ Configurable TTLs for auto-cleanup
- ✅ Custom key prefixes
- ✅ Perfect for real-time chat applications
- ✅ Simple setup with ioredis

**Key concepts:** In-memory persistence, Redis, TTL management

### 🔍 [OpenSearch Persistence](../examples/opensearch-persistence.ts)

**Perfect for:** Analytics and full-text search requirements

Full-text search and analytics-powered persistence:

- ✅ Built-in full-text search across all messages
- ✅ Powerful aggregations and analytics
- ✅ Compatible with Elasticsearch 7.x
- ✅ AWS OpenSearch Service ready
- ✅ Index management and optimization

**Key concepts:** Search, analytics, OpenSearch, Elasticsearch

### 🗄️ [Custom Database Integration](../examples/custom-database-persistence.ts)

**Perfect for:** Integrating with existing database schemas

Manual session state management for existing schemas:

- ✅ Full control over database operations
- ✅ Works with any database (no adapter needed)
- ✅ Manual session state save/restore
- ✅ Perfect for integrating with existing schemas
- ✅ Complete example with validation hooks

**Key concepts:** Custom persistence, existing schemas, manual control

---

## 🔧 Context & State Management

### 💾 [Persistent Onboarding Agent](../examples/persistent-onboarding.ts)

**Perfect for:** Multi-turn conversations with persistence

Multi-turn conversation with state persistence:

- ✅ Context lifecycle hooks for database integration
- ✅ Automatic persistence on context updates
- ✅ Factory pattern for agent creation
- ✅ Two approaches: lifecycle hooks vs context provider
- ✅ Complete onboarding flow across multiple turns

**Key concepts:** Context lifecycle, multi-turn conversations, factory pattern

```typescript
const agent = new Agent({
  hooks: {
    beforeRespond: async (context) => {
      return await database.loadContext(sessionId);
    },
    onContextUpdate: async (newContext) => {
      await database.saveContext(sessionId, newContext);
    },
  },
});
```

### 🔄 [Extracted Data Modification](../examples/extracted-data-modification.ts)

**Perfect for:** Data validation and enrichment

Tools that validate and enrich extracted data:

- ✅ Tools can modify extracted data with `extractedUpdate`
- ✅ Data validation and enrichment patterns
- ✅ Flag-based conditional execution
- ✅ Error handling and data correction
- ✅ Multi-step data refinement

**Key concepts:** Data validation, enrichment, extractedUpdate, flags

```typescript
const validateEmail = defineTool("validate_email", async ({ extracted }) => {
  const isValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(extracted.email);
  return {
    data: isValid,
    extractedUpdate: {
      emailValid: isValid, // Enrich extracted data
    },
  };
});
```

---

## 🤖 Provider Examples

### 🌐 [OpenAI Agent](../examples/openai-agent.ts)

**Perfect for:** Using GPT models

GPT-5 integration with backup models:

- ✅ OpenAI provider configuration
- ✅ Backup model fallback
- ✅ Retry configuration
- ✅ Weather checking example

**Key concepts:** OpenAI integration, model fallback

### 🌐 Multiple Providers

See how different AI providers work:

- **[OpenAI Agent](../examples/openai-agent.ts)** - GPT-5 integration
- **[Healthcare Agent](../examples/healthcare-agent.ts)** - Claude 3.5 Sonnet (Anthropic)
- **[Travel Agent](../examples/travel-agent.ts)** - OpenRouter with backup models
- All examples include backup model configuration and retry settings

---

## 📚 Additional Examples

### 📊 [Company Q&A Agent](../examples/company-qna-agent.ts)

**Perfect for:** Stateless question-answering systems

Simple Q&A agent with knowledge base:

- ✅ Stateless routes (no data extraction)
- ✅ Knowledge base integration
- ✅ Simple request-response pattern
- ✅ Perfect for FAQ bots

**Key concepts:** Stateless routing, Q&A patterns

---

## 🎯 How to Use These Examples

### Running Examples

```bash
# Install dependencies
bun install

# Set up environment variables
echo "GEMINI_API_KEY=your_key" > .env

# Run an example
bun examples/travel-agent.ts
```

### Learning Path

1. **Start here:** [Declarative Agent](../examples/declarative-agent.ts) - Learn the basics
2. **Simple flow:** [Travel Agent](../examples/travel-agent.ts) - Session state & extraction
3. **Complex flow:** [Business Onboarding](../examples/business-onboarding.ts) - Branching & lifecycle
4. **Add persistence:** [Prisma Persistence](../examples/prisma-persistence.ts) - Database integration
5. **Add security:** [Domain Scoping](../examples/domain-scoping.ts) - Tool isolation

### Quick Reference

| Example             | Best For        | Key Features                |
| ------------------- | --------------- | --------------------------- |
| Declarative Agent   | Learning basics | Full API coverage           |
| Travel Agent        | Session state   | Multi-turn conversations    |
| Business Onboarding | Complex flows   | Branching, lifecycle hooks  |
| Healthcare Agent    | Security        | Data validation, compliance |
| Streaming Agent     | Real-time UX    | Streaming responses         |
| Domain Scoping      | Security        | Tool isolation              |
| Prisma Persistence  | Production      | Database integration        |

---

## 💡 Tips

**For Production:**

- Use [Prisma Persistence](../examples/prisma-persistence.ts) for relational data
- Use [Redis Persistence](../examples/redis-persistence.ts) for high-throughput
- Implement [Domain Scoping](../examples/domain-scoping.ts) for security
- Add [Rules & Prohibitions](../examples/rules-prohibitions.ts) for brand consistency

**For Development:**

- Start with [Declarative Agent](../examples/declarative-agent.ts)
- Use [Streaming Agent](../examples/streaming-agent.ts) for better UX
- Check [Custom Database Integration](../examples/custom-database-persistence.ts) for existing schemas

---

**Need help?** Check the [full documentation](./README.md) or [open an issue](https://github.com/falai-dev/agent/issues).
