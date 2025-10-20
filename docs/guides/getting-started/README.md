# Getting Started with @falai/agent

Complete guide to building your first conversational AI agent in under 30 minutes.

---

## 🎯 What You'll Build

By the end of this guide, you'll have a working AI agent that can:

- ✅ Understand natural language queries
- ✅ Extract structured data from conversations
- ✅ Maintain context across multiple turns
- ✅ Use tools to perform actions
- ✅ Handle complex conversation flows

**Time estimate:** 15-30 minutes

---

## 📋 Prerequisites

### Required

- **Node.js 18+** or **Bun 1.0+**
- **API key** for an AI provider (Gemini, OpenAI, or Anthropic)

### Optional

- **Redis** (for session persistence)
- **Database** (PostgreSQL, MySQL, etc. for advanced persistence)

---

## 🚀 Quick Start (5 minutes)

### 1. Create Your Project

```bash
# Create a new directory
mkdir my-first-agent && cd my-first-agent

# Initialize with your package manager
bun init -y  # or npm init -y

# Install @falai/agent
bun add @falai/agent
```

### 2. Set Up Environment

Create a `.env` file:

```bash
# Choose one AI provider
GEMINI_API_KEY=your_gemini_api_key_here
# OPENAI_API_KEY=your_openai_api_key_here
# ANTHROPIC_API_KEY=your_anthropic_api_key_here
```

### 3. Create Your First Agent

Create `index.ts`:

```typescript
import { Agent, GeminiProvider } from "@falai/agent";

// Create AI provider
const provider = new GeminiProvider({
  apiKey: process.env.GEMINI_API_KEY!,
  model: "models/gemini-2.5-flash",
});

// Create your agent
const agent = new Agent({
  name: "MyFirstAgent",
  description: "A helpful AI assistant",
  provider,
});

// Create a simple route
const generalRoute = agent.createRoute({
  title: "General Help",
  description: "Answers general questions",
  conditions: ["User needs help or asks a question"],
  initialStep: {
    prompt: "How can I help you today?",
  },
});

// Test your agent
async function main() {
  const response = await agent.respond("Hello! Can you tell me about TypeScript?");

  console.log("🤖 Agent:", response.message);
}

main();
```

### 4. Run Your Agent

```bash
# Run with Bun
bun run index.ts

# Or with Node.js + TypeScript
npx tsx index.ts
```

**Congratulations!** 🎉 You now have a working AI agent.

---

## 🏗️ Building a Data-Driven Agent (10 minutes)

Now let's build an agent that intelligently collects structured data:

### Define Your Data Schema

```typescript
// Define the data you want to collect
interface BookingData {
  destination: string;
  travelDate: string;
  travelers: number;
  budget: number;
}
```

### Create an Agent with Centralized Data Schema

```typescript
import { Agent, GeminiProvider, type Tool } from "@falai/agent";

// Booking tool
const checkAvailability: Tool<{}, [], string, BookingData> = {
  id: "check_availability",
  description: "Check availability and pricing",
  parameters: {
    type: "object",
    properties: {},
  },
  handler: async (toolContext) => {
    // Simulate availability check
    const available = Math.random() > 0.2;
    const price = Math.floor(Math.random() * 1000) + 500;

    return {
      data: available
        ? `✅ Available! Estimated cost: $${price}`
        : "❌ Not available for those dates",
    };
  },
};

// Create agent with centralized data schema
const agent = new Agent<{}, BookingData>({
  name: "TravelAgent",
  provider: new GeminiProvider({
    apiKey: process.env.GEMINI_API_KEY!,
  }),
  
  // Agent-level schema defines all possible data fields
  schema: {
    type: "object",
    properties: {
      destination: { type: "string", description: "Travel destination" },
      travelDate: { type: "string", description: "Travel date" },
      travelers: { type: "number", minimum: 1, maximum: 10 },
      budget: { type: "number", description: "Budget in USD" },
    },
    required: ["destination", "travelers"],
  },
  
  // Agent-level tools available to all routes
  tools: [checkAvailability],
  
  // Agent-level data validation and enrichment
  hooks: {
    onDataUpdate: async (data, previousData) => {
      // Auto-set budget range based on travelers
      if (data.travelers && !data.budget) {
        data.budget = data.travelers * 500; // Default $500 per person
      }
      return data;
    }
  }
});

// Routes specify required fields instead of schemas
const bookingRoute = agent.createRoute({
  title: "Travel Booking",
  description: "Help users book travel",
  conditions: ["User wants to book travel"],
  requiredFields: ["destination", "travelDate", "travelers"], // Required for completion
  optionalFields: ["budget"], // Nice to have but not required
  
  initialStep: {
    prompt: "I'd love to help you book a trip! Where would you like to go?",
    collect: ["destination"],
  },
});

// Build conversation flow with agent-level data awareness
const askDate = bookingRoute.initialStep.nextStep({
  prompt: "When would you like to travel?",
  collect: ["travelDate"],
  requires: ["destination"], // Must have destination from agent data
  skipIf: (data) => !!data.travelDate, // Skip if already collected
});

const askTravelers = askDate.nextStep({
  prompt: "How many people are traveling?",
  collect: ["travelers"],
  requires: ["destination"], // Prerequisites from agent data
  skipIf: (data) => data.travelers !== undefined,
});

const askBudget = askTravelers.nextStep({
  prompt: "What's your budget for this trip?",
  collect: ["budget"],
  requires: ["destination", "travelers"],
  skipIf: (data) => data.budget !== undefined,
});

const checkAndBook = askBudget.nextStep({
  prompt: "Let me check availability for your trip.",
  tool: checkAvailability, // Tool accesses complete agent data
  requires: ["destination", "travelers"], // Minimum data needed
});
```

### Test the Agent-Level Data Collection

```typescript
async function testBookingAgent() {
  // Create agent with automatic session management and agent-level schema
  const sessionAgent = new Agent<{}, BookingData>({
    name: "TravelAgent",
    provider: new GeminiProvider({
      apiKey: process.env.GEMINI_API_KEY!,
    }),
    sessionId: "user-alice", // Automatically manages this session
    
    // Same agent-level schema and configuration
    schema: agent.schema,
    tools: agent.tools,
    hooks: agent.hooks
  });

  // Copy the route to the session agent
  sessionAgent.createRoute(bookingRoute.options);

  // User provides partial information - simple message API
  const response1 = await sessionAgent.respond("I want to go to Paris");

  console.log("Bot:", response1.message);
  console.log("Agent data:", sessionAgent.getCollectedData()); // Agent-level data access

  // User provides more details - session automatically maintained
  const response2 = await sessionAgent.respond("Next Friday, 2 people, $2000 budget");

  console.log("Bot:", response2.message);
  console.log("Final agent data:", sessionAgent.getCollectedData());
  
  // Check route completion
  console.log("Route complete:", bookingRoute.isComplete(sessionAgent.getCollectedData()));
  console.log("Progress:", Math.round(bookingRoute.getCompletionProgress(sessionAgent.getCollectedData()) * 100) + "%");
}

testBookingAgent();
```

**Notice how the agent:**

- ✅ Automatically extracted destination from "Paris"
- ✅ Understood "Next Friday, 2 people, $2000 budget" as structured data
- ✅ Skipped asking for already-known information
- ✅ Used the check_availability tool to provide real assistance

---

## 💾 Adding Session Persistence (5 minutes)

Make your agent remember conversations across sessions:

```typescript
import { MemoryAdapter } from "@falai/agent";

const agent = new Agent({
  name: "PersistentAgent",
  provider: new GeminiProvider({
    apiKey: process.env.GEMINI_API_KEY!,
  }),
  // Add persistence
  persistence: {
    adapter: new MemoryAdapter(), // Or RedisAdapter, PrismaAdapter, etc.
  },
});

// Create agent with automatic session management and persistence
const persistentAgent = new Agent({
  name: "PersistentAgent",
  provider: new GeminiProvider({
    apiKey: process.env.GEMINI_API_KEY!,
  }),
  persistence: {
    adapter: new MemoryAdapter(), // Or RedisAdapter, PrismaAdapter, etc.
  },
  sessionId: "user-123", // Automatically loads or creates this session
});

// Sessions are automatically saved and restored
const response1 = await persistentAgent.respond("Hello, my name is Alice");
// Session data automatically persisted

const response2 = await persistentAgent.respond("What's my name?");
console.log(response2.message); // Agent remembers: "Your name is Alice"
```

---

## 🎯 Next Steps

### Level 2: Core Concepts

- **[Schema-Driven Extraction](../core-concepts/schema-driven-extraction.ts)** - Advanced data collection patterns
- **[Session Management](../core-concepts/session-management.ts)** - Multi-turn conversations
- **[Context Providers](../core-concepts/context-providers.ts)** - Dynamic context fetching

### Level 3: Conversation Flows

- **[Simple Routes](../conversation-flows/simple-route.ts)** - Basic route patterns
- **[Data-Driven Flows](../conversation-flows/data-driven-flows.ts)** - Conditional logic and requirements
- **[Branching](../conversation-flows/branching/README.md)** - Non-linear conversations

### Level 4: Advanced Features

- **[Custom Providers](../ai-providers/custom-provider.ts)** - Integrate any AI service
- **[Context Tools](../tools/context-updating-tools.ts)** - Modify agent state
- **[Multi-Turn Conversations](../advanced-patterns/multi-turn-conversations.ts)** - Complex dialogues

### Level 5: Production

- **[Server Deployment](../integrations/server-deployment.ts)** - HTTP API with WebSockets
- **[Database Persistence](../persistence/custom-adapter.ts)** - Custom storage adapters
- **[Streaming Responses](../advanced-patterns/streaming-responses.ts)** - Real-time UX

---

## 🆘 Troubleshooting

### Common Issues

**"API key not found"**

```bash
# Make sure your .env file exists and has the correct variable
echo "GEMINI_API_KEY=your_key_here" > .env
```

**"Module not found"**

```bash
# Reinstall dependencies
rm -rf node_modules package-lock.json
bun install  # or npm install
```

**"Type errors"**

```typescript
// Make sure you're using TypeScript 5.3+
npx tsc --version

// Or use tsx for running TypeScript directly
npx tsx your-file.ts
```

**"Agent not responding"**

```typescript
// Check your API key is valid
curl "https://generativelanguage.googleapis.com/v1beta/models?key=YOUR_KEY"

// Verify your provider configuration
console.log("Provider:", agent.options.provider.name);
```

### Getting Help

- 📖 **[Full Documentation](../../README.md)** - Complete API reference
- 💬 **[Examples Directory](../../examples/)** - Working code samples
- 🐛 **[GitHub Issues](https://github.com/falai-dev/agent/issues)** - Report bugs
- 💡 **[Discussions](https://github.com/falai-dev/agent/discussions)** - Ask questions

---

## 🎉 You're Done!

You now have the foundation to build sophisticated AI agents. The framework is designed to scale with your needs - from simple chatbots to complex, data-driven conversational applications.

**What's next?** Explore the examples directory to see more advanced patterns, or dive into the API documentation for detailed method references.

Happy building! 🚀
