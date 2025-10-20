# Context & Session Management

## Overview

The `@falai/agent` framework provides **automatic session management** through the integrated `SessionManager` class, tracking conversation progress, collected data, and user intent across multiple turns. This enables sophisticated data-driven conversations with zero boilerplate code.

---

## 🎯 Automatic Session Management

The `SessionManager` automatically tracks four key aspects of a conversation:

1. **Current Route** - Which conversation flow the user is in
2. **Current Step** - Where in the flow they currently are
3. **Agent-Level Data** - Centralized structured data collected across all routes
4. **Conversation History** - Complete message history within the session

```typescript
// Define your agent-level data extraction type
interface TravelData {
  destination: string;
  departureDate: string;
  passengers: number;
  cabinClass: "economy" | "business" | "first";
  hotelPreference?: string;
  budgetRange?: string;
  specialRequests?: string;
}

// Agent with automatic session management and agent-level schema
const agent = new Agent<{}, TravelData>({
  name: "Travel Agent",
  provider: new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY }),
  persistence: { adapter: new PrismaAdapter({ prisma }) },
  sessionId: "user-123", // Automatically loads or creates session
  
  // Agent-level schema for all data collection
  schema: {
    type: "object",
    properties: {
      destination: { type: "string" },
      departureDate: { type: "string", format: "date" },
      passengers: { type: "number", minimum: 1, maximum: 9 },
      cabinClass: { type: "string", enum: ["economy", "business", "first"] },
      hotelPreference: { type: "string" },
      budgetRange: { type: "string" },
      specialRequests: { type: "string" }
    }
  }
});

// Simple conversation - session managed automatically
const response = await agent.respond("I want to book a flight to Paris");

// Access session information
console.log(agent.session.id); // "user-123"
console.log(agent.session.getData<TravelData>()); // { destination: "Paris", ... }
console.log(agent.session.getHistory()); // Conversation history
```

**Benefits of Automatic Session Management:**

- **Zero Boilerplate** - No manual session creation or persistence code
- **Always-On Routing** - Users can change their mind mid-conversation
- **Data Persistence** - Collected data automatically saved and restored
- **Context Awareness** - Router sees current progress and collected data
- **History Management** - Conversation history automatically maintained
- **Server-Friendly** - Perfect for stateless server environments

---

## 🔄 SessionManager API

### Session Operations

```typescript
// Access the session manager
const sessionManager = agent.session;

// Get or create session (works for existing, new, or auto-generated IDs)
await sessionManager.getOrCreate("user-123");
await sessionManager.getOrCreate(); // Auto-generates ID

// Agent-level data management
const data = sessionManager.getData<TravelData>();
await sessionManager.setData({
  destination: "Paris",
  departureDate: "2025-10-15",
  passengers: 2,
  cabinClass: "economy"
});

// History management
await sessionManager.addMessage("user", "I want to book a flight");
await sessionManager.addMessage("assistant", "Where would you like to go?");
const history = sessionManager.getHistory();
sessionManager.clearHistory();

// Session operations
await sessionManager.save(); // Manual save (auto-saves on addMessage)
await sessionManager.delete();
const newSession = await sessionManager.reset(true); // Preserve history
```

### Session Step Structure

```typescript
interface SessionState<TData = unknown> {
  currentRoute?: {
    id: string;
    title: string;
    enteredAt: Date;
  };
  currentStep?: {
    id: string;
    description?: string;
    enteredAt: Date;
  };
  data: Partial<TData>; // Data collected so far
  routeHistory: Array<{
    routeId: string;
    routeTitle: string;
    enteredAt: Date;
    exitedAt?: Date;
  }>;
  metadata?: Record<string, unknown>;
}
```

## 🔄 Enhanced Lifecycle Hooks

### Context Hooks (Traditional Context Management)

```typescript
const agent = new Agent({
  // ... other options
  hooks: {
    // Refresh context before each response
    beforeRespond: async (currentContext) => {
      const freshData = await loadUserData(currentContext.userId);
      return { ...currentContext, ...freshData };
    },

    // Persist context updates
    onContextUpdate: async (newContext, previousContext) => {
      await saveUserData(newContext.userId, newContext);
    },

    // Agent-level data validation and enrichment
    onDataUpdate: async (data, previousData) => {
      // Normalize passenger count
      if (data.passengers < 1) data.passengers = 1;
      if (data.passengers > 9) data.passengers = 9;

      // Enrich with computed fields using agent-level data
      if (data.destination && !data.destinationCode) {
        data.destinationCode = await lookupAirportCode(data.destination);
      }

      // Auto-set budget range based on cabin class
      if (data.cabinClass && !data.budgetRange) {
        data.budgetRange = data.cabinClass === 'first' ? 'premium' : 
                          data.cabinClass === 'business' ? 'high' : 'standard';
      }

      // Auto-trigger actions when we have complete booking data
      if (data.destination && data.departureDate && data.passengers) {
        data.shouldSearchFlights = true;
      }

      return data;
    },
  },
});
```

### Context Provider Pattern

For always-fresh context from external sources:

```typescript
const agent = new Agent({
  // ... other options
  contextProvider: async () => {
    // Load fresh context for each response
    return await loadFullContextFromDatabase();
  },
});
```

## 📊 Data Extraction Pipeline

Schema-first data extraction with intelligent step progression:

### 1. Define Your Data Schema

```typescript
interface FlightData {
  destination: string;
  destinationCode?: string; // Enriched by tools
  departureDate: string;
  departureDateParsed?: string; // Enriched by tools
  passengers: number;
  cabinClass: "economy" | "business" | "first";
  shouldSearchFlights?: boolean; // Action flag
}

const route = agent.createRoute<FlightData>({
  title: "Book Flight",
  schema: {
    type: "object",
    properties: {
      destination: { type: "string" },
      departureDate: { type: "string" },
      passengers: { type: "number", minimum: 1, maximum: 9 },
      cabinClass: {
        type: "string",
        enum: ["economy", "business", "first"],
        default: "economy",
      },
    },
    required: ["destination", "departureDate", "passengers"],
  },
  initialData: {
    cabinClass: "economy", // Pre-populate defaults
  },
});
```

### 2. Create Smart Step Machines

```typescript
// Step with code-based logic (no fuzzy LLM conditions!)
const askDestination = route.initialStep.nextStep({
  prompt: "Ask where they want to fly",
  collect: ["destination"],
  skipIf: (data) => !!data.destination, // Skip if already have destination
});

const enrichDestination = askDestination.nextStep({
  tool: lookupAirportCode, // Tool executes automatically
  requires: ["destination"], // Prerequisites
});

const askDates = enrichDestination.nextStep({
  prompt: "Ask about travel dates",
  collect: ["departureDate"],
  skipIf: (data) => !!data.departureDate,
  requires: ["destination"], // Must have destination first
});

const validateDate = askDates.nextStep({
  tool: parseAndValidateDate,
  requires: ["departureDate"],
});

const askPassengers = validateDate.nextStep({
  prompt: "How many passengers?",
  collect: ["passengers"],
  skipIf: (data) => !!data.passengers,
});

const searchFlights = askPassengers.nextStep({
  tool: searchFlightAPI,
  // Triggered when shouldSearchFlights flag is set by hook
});
```

### 3. Tools Access Collected data

```typescript
const searchFlights: Tool<Context, [], void, FlightData> = {
  id: "search_flights",
  description: "Search for available flights based on collected data",
  parameters: {
    type: "object",
    properties: {},
  },
  handler: async (toolContext) => {
    // Access collected data directly (no LLM extraction needed!)
    if (!toolContext.data.destination || !toolContext.data.departureDate) {
      return { data: undefined };
    }

    const flights = await searchFlightAPI(
      toolContext.data.destination,
      toolContext.data.departureDate
    );

    return {
      data: undefined,
      contextUpdate: { availableFlights: flights },
      dataUpdate: {
        shouldSearchFlights: false, // Clear the flag
      },
    };
  },
};
```

### 4. Lifecycle Hooks for Validation & Enrichment

```typescript
const agent = new Agent({
  // ... other options
  hooks: {
    onDataUpdate: async (data, previous) => {
      // Normalize data
      if (data.passengers < 1) data.passengers = 1;
      if (data.passengers > 9) data.passengers = 9;

      // Enrich data
      if (data.destination && !data.destinationCode) {
        data.destinationCode = await lookupAirportCode(data.destination);
      }

      // Auto-trigger actions
      if (hasAllRequires(data) && !data.shouldSearchFlights) {
        data.shouldSearchFlights = true;
      }

      return data;
    },
  },
});
```

## 🎯 Always-On Routing with Context

Routing happens every turn with full session context:

```typescript
// User starts booking a flight
const response1 = await agent.respond({
  history: [
    {
      role: "user",
      content: "I want to fly to Paris tomorrow with 2 people",
    },
  ],
  session,
});

// User changes mind mid-conversation
const response2 = await agent.respond({
  history: [
    ...previousHistory,
    {
      role: "user",
      content: "Actually, make that Tokyo instead",
    },
  ],
  session: response1.session, // Router sees context and switches appropriately
});

// Router understands:
// - Current route: "Book Flight"
// - Current step: "ask_passengers"
// - Collected data: { destination: "Paris", departureDate: "tomorrow", passengers: 2 }
// - User intent: "Tokyo instead" → switches to new destination
```

## 📋 Multi-Turn Conversation Patterns

```typescript
import { Agent, type ContextLifecycleHooks } from "@falai/agent";

// Define hooks
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

// Create agent with hooks
const agent = new Agent({
  name: "Bot",
  provider: provider,
  context: initialContext,
  hooks, // 🔑 Enable persistence
});
```

**How it works:**

1. `beforeRespond` fetches fresh context from your database before `respond()` is called
2. Tools can update context using `toolContext.updateContext()` or returning `{ contextUpdate }`
3. `onContextUpdate` automatically persists changes to your database
4. Next request creates a new agent, `beforeRespond` loads the updated context

---

## 🔧 Tool Context Updates

Tools can update context in **two ways**:

### Option A: Return `contextUpdate`

```typescript
const saveName: Tool<MyContext, [name: string], boolean> = {
  id: "save_name",
  description: "Save the user's name to context",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "The user's name" },
    },
    required: ["name"],
  },
  handler: async (toolContext, args) => {
    return {
      data: true,
      contextUpdate: {
        userName: args.name,
        updatedAt: new Date(),
      },
    };
  },
};
```

**Pros:**

- Declarative and functional
- Easy to test
- Context update is part of the result

### Option B: Call `updateContext()` directly

```typescript
const saveName: Tool<MyContext, [name: string], boolean> = {
  id: "save_name",
  description: "Save the user's name to context using direct update",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "The user's name" },
    },
    required: ["name"],
  },
  handler: async (toolContext, args) => {
    await toolContext.updateContext({
      userName: args.name,
      updatedAt: new Date(),
    });

    return { data: true };
  },
};
```

**Pros:**

- More imperative and direct
- Can update context at any point in the tool
- Useful for complex logic

**Both approaches trigger the `onContextUpdate` hook automatically.**

---

## 🌐 Context Provider Pattern

For scenarios where context is **always loaded from an external source**, use the `contextProvider` pattern:

```typescript
const agent = new Agent({
  name: "Bot",
  provider: provider,

  // Instead of static context:
  contextProvider: async () => {
    // Fetch context fresh on every respond() call
    return await database.loadContext(sessionId);
  },

  hooks: {
    // Still persist updates
    onContextUpdate: async (newContext) => {
      await database.saveContext(sessionId, newContext);
    },
  },
});
```

**When to use:**

- Context is always loaded from a database/cache
- You never have a static starting context
- You want guaranteed fresh data on every request

**Difference from `beforeRespond`:**

- `contextProvider`: **Replaces** the context entirely
- `beforeRespond`: **Updates** the existing context (can access previous step)

---

## 🎯 Complete Example: Multi-Turn Onboarding

```typescript
import { Agent, type Tool } from "@falai/agent";

interface OnboardingContext {
  sessionId: string;
  userId: string;
  businessName?: string;
  industry?: string;
  completedSteps: string[];
}

// Database simulation
const db = {
  async loadSession(sessionId: string) {
    return await database.findSession(sessionId);
  },
  async saveSession(sessionId: string, data: Partial<OnboardingContext>) {
    await database.updateSession(sessionId, data);
  },
};

// Factory function for creating agents
async function createOnboardingAgent(sessionId: string) {
  const session = await db.loadSession(sessionId);

  const agent = new Agent<OnboardingContext>({
    name: "OnboardingBot",
    provider: provider,
    context: {
      sessionId,
      userId: session.userId,
      businessName: session.businessName,
      industry: session.industry,
      completedSteps: session.completedSteps || [],
    },
    hooks: {
      // Load fresh context before responding
      beforeRespond: async (current) => {
        const fresh = await db.loadSession(sessionId);
        return { ...current, ...fresh };
      },

      // Persist context after updates
      onContextUpdate: async (newContext) => {
        await db.saveSession(sessionId, {
          businessName: newContext.businessName,
          industry: newContext.industry,
          completedSteps: newContext.completedSteps,
        });
      },
    },
  });

  // Define tools with context updates
  const saveBusinessName: Tool<OnboardingContext, [name: string], boolean> = {
    id: "save_business_name",
    description: "Save the business name and mark step as completed",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "The business name" },
      },
      required: ["name"],
    },
    handler: async (toolContext, args) => {
      return {
        data: true,
        contextUpdate: {
          businessName: args.name,
          completedSteps: [
            ...toolContext.context.completedSteps,
            "business_name",
          ],
        },
      };
    },
  };

  const saveIndustry: Tool<OnboardingContext, [industry: string], boolean> = {
    id: "save_industry",
    description: "Save the industry and mark step as completed",
    parameters: {
      type: "object",
      properties: {
        industry: { type: "string", description: "The business industry" },
      },
      required: ["industry"],
    },
    handler: async (toolContext, args) => {
      // Alternative: use updateContext directly
      await toolContext.updateContext({
        industry: args.industry,
        completedSteps: [...toolContext.context.completedSteps, "industry"],
      });

      return { data: true };
    },
  };

  // Build conversation routes...
  const route = agent.createRoute({ title: "Onboarding" });
  // ...

  return agent;
}

// Usage across multiple turns
async function handleUserMessage(sessionId: string, message: string) {
  // Recreate agent for each turn (context is loaded fresh)
  const agent = await createOnboardingAgent(sessionId);

  const response = await agent.respond({
    history: [
      {
        role: "user",
        content: message,
      },
    ],
  });

  return response.message;
}
```

---

## 📋 Best Practices

### ✅ DO

- **Recreate agents** for each request in multi-turn conversations
- **Use lifecycle hooks** to integrate with your database
- **Store context** in your database/cache (Redis, PostgreSQL, etc.)
- **Load fresh context** via `beforeRespond` or `contextProvider`
- **Test persistence** by simulating multiple turns
- **Handle errors** in hooks gracefully (fallback to current context)

### ❌ DON'T

- **Cache agent instances** across requests (context gets stale)
- **Mutate context directly** without using `updateContext()` or `contextUpdate`
- **Rely on in-memory step** for multi-turn conversations
- **Forget to handle** `onContextUpdate` failures (could lose data)
- **Mix** `context` and `contextProvider` (will throw an error)

---

## 🔍 Debugging Context Issues

### Problem: Context updates aren't persisting

**Check:**

1. Are you using `onContextUpdate` hook?
2. Is your database save actually working?
3. Are you recreating the agent with fresh context each turn?

```typescript
// Debug your hooks
hooks: {
  beforeRespond: async (current) => {
    console.log("📥 Loading context:", current);
    const fresh = await db.load(sessionId);
    console.log("✅ Loaded fresh:", fresh);
    return fresh;
  },

  onContextUpdate: async (newContext) => {
    console.log("💾 Saving context:", newContext);
    await db.save(sessionId, newContext);
    console.log("✅ Saved successfully");
  },
},
```

### Problem: Context is null/undefined

**Check:**

1. Did you provide either `context` or `contextProvider`?
2. Is your `contextProvider` returning valid data?
3. Is `beforeRespond` returning valid context?

```typescript
// Validate your contextProvider
contextProvider: async () => {
  const ctx = await db.load(sessionId);
  if (!ctx) {
    console.error("❌ Context not found!");
    throw new Error("Session not found");
  }
  return ctx;
},
```

### Problem: Tools not updating context

**Check:**

1. Are you returning `{ contextUpdate }` or calling `toolContext.updateContext()`?
2. Is `onContextUpdate` being called? (Add console.log)
3. Are your tools being executed at all?

---

## 🚀 Advanced Patterns

### Pattern: Context Versioning

```typescript
interface VersionedContext extends MyContext {
  version: number;
}

hooks: {
  onContextUpdate: async (newContext) => {
    await db.save(sessionId, {
      ...newContext,
      version: newContext.version + 1,
    });
  },

  beforeRespond: async (current) => {
    const fresh = await db.load(sessionId);
    if (fresh.version > current.version) {
      console.log("⚠️ Context changed by another request!");
    }
    return fresh;
  },
},
```

### Pattern: Selective Persistence

```typescript
// Only persist specific fields
hooks: {
  onContextUpdate: async (newContext) => {
    // Don't persist temporary/computed fields
    const { tempData, ...persistable } = newContext;
    await db.save(sessionId, persistable);
  },
},
```

### Pattern: Multi-User Context

```typescript
interface MultiUserContext {
  conversationId: string;
  participants: Map<string, UserData>;
}

hooks: {
  beforeRespond: async (current) => {
    // Load all participant data
    const conversation = await db.loadConversation(conversationId);
    return {
      conversationId,
      participants: new Map(conversation.participants),
    };
  },
},
```

---

## 📚 Related Resources

- [Complete Example: Persistent Onboarding](../examples/persistent-onboarding.ts)
- [API Reference: AgentOptions](../api/overview.md#agentoptions)
- [API Reference: ContextLifecycleHooks](../api/overview.md#contextlifecyclehooks)
- [Getting Started](../guides/getting-started/README.md)

---

## 🆘 Need Help?

If you're still having issues:

1. Check the [examples](../examples/) for working implementations
2. Review the [API Reference](../api/README.md) for detailed type information
3. Open an issue on GitHub with your use case

**Remember:** The key to persistent conversations is:

1. **Recreate agents** each turn
2. **Load fresh context** via hooks/provider
3. **Persist updates** via `onContextUpdate`
4. **Never cache** agent instances across requests
