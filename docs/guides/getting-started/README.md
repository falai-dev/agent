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

// Create a simple route with basic string condition
const generalRoute = agent.createRoute({
  title: "General Help",
  description: "Answers general questions",
  when: ["User needs help or asks a question"], // Simple string condition
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
import { Agent, GeminiProvider } from "@falai/agent";

// Define data interface first
interface BookingData {
  destination?: string;
  travelDate?: string;
  travelers?: number;
  budget?: number;
  estimatedPrice?: number;
  availabilityChecked?: boolean;
}

// Create agent with centralized data schema first
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

// Create booking tool using unified Tool interface - simple return value
agent.addTool({
  id: "check_availability",
  name: "Availability Checker",
  description: "Check travel availability and pricing",
  parameters: {
    type: "object",
    properties: {},
  },
  handler: async ({ context, data, updateData }) => {
    // Simulate availability check using collected data
    const available = Math.random() > 0.2;
    const price = Math.floor(Math.random() * 1000) + 500;
    
    // Update data with pricing information using helper method
    await updateData({ 
      estimatedPrice: price,
      availabilityChecked: true 
    });

    // Return simple string value - unified interface supports both simple and complex returns
    return available
      ? `✅ Available! Estimated cost: $${price} for ${data.travelers} travelers to ${data.destination}`
      : "❌ Not available for those dates. Please try different dates.";
  },
};

// Routes specify required fields instead of schemas
const bookingRoute = agent.createRoute({
  title: "Travel Booking",
  description: "Help users book travel",
  when: ["User wants to book travel"],
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
  tools: ["check_availability"], // Reference tool by ID
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
    hooks: agent.hooks
  });

  // Add the same tool to the session agent
  sessionAgent.addTool({
    id: "check_availability",
    name: "Availability Checker",
    description: "Check travel availability and pricing",
    handler: async ({ context, data, updateData }) => {
      const available = Math.random() > 0.2;
      const price = Math.floor(Math.random() * 1000) + 500;
      await updateData({ estimatedPrice: price, availabilityChecked: true });
      return {
        data: available
          ? `✅ Available! Estimated cost: $${price} for ${data.travelers} travelers to ${data.destination}`
          : "❌ Not available for those dates. Please try different dates.",
      };
    },
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

// Advanced: Show different tool creation approaches
function demonstrateToolCreationMethods() {
  // Method 1: Direct addition (simplest)
  agent.addTool({
    id: "simple_search",
    description: "Basic search functionality",
    handler: async ({ context, data }, args) => `Found results for: ${args.query}`
  });

  // Method 2: Registry for reuse
  agent.tool.register({
    id: "reusable_validator",
    description: "Reusable validation tool",
    handler: async ({ context, data }, args) => ({
      data: "Validation complete",
      success: true,
      contextUpdate: { lastValidated: new Date() }
    })
  });

  // Method 3: Pattern helpers
  const enrichmentTool = agent.tool.createDataEnrichment({
    id: "enrich_booking",
    fields: ['destination', 'travelers'],
    enricher: async (context, data) => ({
      bookingCode: `${data.destination?.slice(0,3).toUpperCase()}-${data.travelers}`,
      estimatedDuration: data.destination === 'Paris' ? '8 hours' : '12 hours'
    })
  });
  
  agent.tool.register(enrichmentTool);
}

demonstrateToolCreationMethods();

// Advanced: Tools as Step Lifecycle Hooks
function demonstrateLifecycleHooks() {
  // Create tools for step lifecycle
  agent.addTool({
    id: "prepare_booking",
    description: "Prepare booking context",
    handler: async ({ context, data, updateContext }) => {
      // Enrich context before AI response
      await updateContext({ 
        bookingStartTime: new Date().toISOString(),
        userTier: 'premium' 
      });
      return "Booking preparation complete"; // Simple return
    }
  });

  agent.addTool({
    id: "finalize_booking", 
    description: "Finalize booking process",
    handler: async ({ context, data }) => {
      // Process after AI response
      const confirmationId = await bookingService.reserve(data);
      return {
        data: `Booking reserved with ID: ${confirmationId}`,
        success: true,
        contextUpdate: { lastBookingId: confirmationId }
      }; // Complex ToolResult
    }
  });

  // Use tools in step lifecycle
  const bookingStep = agent.createRoute({
    title: "Hotel Booking with Lifecycle",
    steps: [{
      id: "process_booking",
      prompt: "Let me process your booking...",
      prepare: "prepare_booking", // Tool executes before AI response
      finalize: "finalize_booking", // Tool executes after AI response
      collect: ["hotelName", "checkInDate"]
    }]
  });

  console.log("Lifecycle hooks configured with tools");
}

demonstrateLifecycleHooks();
```

**Notice how the agent:**

- ✅ Automatically extracted destination from "Paris"
- ✅ Understood "Next Friday, 2 people, $2000 budget" as structured data
- ✅ Skipped asking for already-known information
- ✅ Used the ToolManager API to create and execute tools with simplified context

---

## 🎯 Flexible Routing Conditions (5 minutes)

Learn how to create sophisticated routing logic with the new `ConditionTemplate` system:

### Simple String Conditions (Beginner)

Perfect for AI-driven routing decisions:

```typescript
// String conditions provide context to AI for routing
const supportRoute = agent.createRoute({
  title: "Customer Support",
  when: "User needs help or has a problem", // AI understands intent
  initialStep: {
    prompt: "I'm here to help! What can I assist you with?",
  },
});

const feedbackRoute = agent.createRoute({
  title: "Feedback Collection", 
  when: "User wants to leave feedback or a review", // AI context
  initialStep: {
    prompt: "I'd love to hear your feedback!",
  },
});
```

### Function Conditions (Advanced)

For programmatic logic and precise control:

```typescript
interface UserContext {
  userType: 'free' | 'premium' | 'enterprise';
  loginCount: number;
  lastActivity: Date;
}

const agent = new Agent<UserContext>({
  name: "SmartAgent",
  provider: new GeminiProvider({ apiKey: process.env.GEMINI_API_KEY! }),
  context: {
    userType: 'free',
    loginCount: 1,
    lastActivity: new Date(),
  },
});

// Function-only conditions for precise control
const premiumRoute = agent.createRoute({
  title: "Premium Features",
  when: (ctx) => ctx.context?.userType === 'premium', // Programmatic check
  initialStep: {
    prompt: "Welcome to premium features! What would you like to explore?",
  },
});

const onboardingRoute = agent.createRoute({
  title: "User Onboarding",
  when: (ctx) => ctx.context?.loginCount <= 3, // New user logic
  initialStep: {
    prompt: "Welcome! Let me show you around.",
  },
});
```

### Mixed Array Conditions (Expert)

Combine AI understanding with programmatic precision:

```typescript
interface SupportContext {
  userTier: 'basic' | 'premium' | 'enterprise';
  supportTickets: number;
  accountAge: number; // days
}

interface SupportData {
  issueType?: 'technical' | 'billing' | 'general';
  priority?: 'low' | 'medium' | 'high';
  previousAttempts?: number;
}

const agent = new Agent<SupportContext, SupportData>({
  name: "SupportAgent",
  provider: new GeminiProvider({ apiKey: process.env.GEMINI_API_KEY! }),
});

// Mixed conditions: AI context + programmatic logic
const escalationRoute = agent.createRoute({
  title: "Escalated Support",
  when: [
    "User is frustrated or needs urgent help", // AI context
    (ctx) => ctx.data?.previousAttempts > 2, // Programmatic check
    (ctx) => ctx.context?.userTier === 'enterprise' // Context check
  ],
  skipIf: [
    "Support system is under maintenance", // AI context
    (ctx) => new Date().getHours() < 9 || new Date().getHours() > 17 // Outside hours
  ],
  initialStep: {
    prompt: "I understand this is urgent. Let me connect you with our senior support team.",
  },
});

// Advanced step conditions
const technicalStep = escalationRoute.initialStep.nextStep({
  when: [
    "User has a technical issue that needs expert help", // AI context
    (ctx) => ctx.data?.issueType === 'technical' // Data check
  ],
  skipIf: (ctx) => ctx.data?.priority === 'low', // Skip low priority technical issues
  prompt: "Let me get our technical expert to help you.",
  collect: ["issueDescription"]
});
```

### Route SkipIf (Dynamic Exclusion)

Exclude routes from consideration based on conditions:

```typescript
const paymentRoute = agent.createRoute({
  title: "Payment Processing",
  when: ["User wants to make a payment or purchase"],
  skipIf: [
    "Payment system is temporarily unavailable", // AI context
    (ctx) => ctx.context?.paymentSystemDown === true, // System check
    (ctx) => ctx.data?.paymentBlocked === true // User-specific block
  ],
  initialStep: {
    prompt: "I'll help you with your payment.",
  },
});

const maintenanceRoute = agent.createRoute({
  title: "Maintenance Notice",
  when: "User asks about system issues or downtime",
  skipIf: (ctx) => ctx.context?.maintenanceMode !== true, // Only show during maintenance
  initialStep: {
    prompt: "We're currently performing scheduled maintenance. Service will resume shortly.",
  },
});
```

### Testing Your Conditions

```typescript
async function testConditions() {
  // Test with different contexts
  const basicUser = { userTier: 'basic', supportTickets: 1, accountAge: 30 };
  const premiumUser = { userTier: 'premium', supportTickets: 5, accountAge: 365 };

  // Basic user - should get standard support
  const response1 = await agent.respond("I need help", {
    contextOverride: basicUser
  });
  console.log("Basic user route:", response1.session?.currentRoute?.title);

  // Premium user with multiple tickets - should get escalated support
  const response2 = await agent.respond("I'm having issues again", {
    contextOverride: premiumUser
  });
  console.log("Premium user route:", response2.session?.currentRoute?.title);
}

testConditions();
```

**Key Benefits:**

- ✅ **Simple strings** for AI-driven routing decisions
- ✅ **Functions** for precise programmatic control  
- ✅ **Arrays** to combine both approaches
- ✅ **Route skipIf** for dynamic exclusion
- ✅ **Context access** in all condition types

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
