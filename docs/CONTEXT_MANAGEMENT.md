# Session Step & Data Management

## Overview

The `@falai/agent` framework provides **session step management** for tracking conversation progress, collected data, and user intent across multiple turns. This enables sophisticated data-driven conversations with intelligent step progression.

---

## 🎯 Session Step: The Foundation

Session step tracks three key aspects of a conversation:

1. **Current Route** - Which conversation flow the user is in
2. **Current Step** - Where in the flow they currently are
3. **Collected data** - Structured data collected so far

```typescript
import { createSession, SessionState } from "@falai/agent";

// Define your data extraction type
interface FlightData {
  destination: string;
  departureDate: string;
  passengers: number;
  cabinClass: "economy" | "business" | "first";
}

// Initialize session step
let session = createSession<FlightData>();

// Session starts empty
console.log(session.currentRoute); // undefined
console.log(session.currentStep); // undefined
console.log(session.data); // {}

// Use in conversation
const response = await agent.respond({ history, session });

// Session updated with progress and collected data
console.log(response.session?.currentRoute?.title); // "Book Flight"
console.log(response.session?.currentStep?.id); // "ask_destination"
console.log(response.session?.data); // { destination: "Paris", ... }
```

**Benefits of Session Step:**

- **Always-On Routing** - Users can change their mind mid-conversation
- **Data Persistence** - Collected data survives across turns
- **Context Awareness** - Router sees current progress and collected data
- **Step Recovery** - Resume conversations from any point

---

## 🔄 Session Step Helpers

### Creating and Managing Sessions

```typescript
import {
  createSession,
  enterRoute,
  enterStep,
  mergeData,
  type SessionState,
} from "@falai/agent";

// Create a new session
let session = createSession<FlightData>();

// Enter a route (when routing decides to switch)
session = enterRoute(session, "book_flight", "Book Flight");

// Enter a step (when progressing through the flow)
session = enterStep(session, "ask_destination", "Ask where they want to fly");

// Merge collected data (when AI extracts new information)
session = mergeData(session, {
  destination: "Paris",
  departureDate: "2025-10-15",
  passengers: 2,
});
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

    // NEW: Validate and enrich collected data
    onDataUpdate: async (data, previousData) => {
      // Normalize passenger count
      if (data.passengers < 1) data.passengers = 1;
      if (data.passengers > 9) data.passengers = 9;

      // Enrich with computed fields
      if (data.destination) {
        data.destinationCode = await lookupAirportCode(data.destination);
      }

      // Auto-trigger actions
      if (hasAllRequires(data)) {
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
const searchFlights = defineTool<Context, [], void, FlightData>(
  "search_flights",
  async ({ context, data }) => {
    // Access collected data directly (no LLM extraction needed!)
    if (!data.destination || !data.departureDate) {
      return { data: undefined };
    }

    const flights = await searchFlightAPI(data.destination, data.departureDate);

    return {
      data: undefined,
      contextUpdate: { availableFlights: flights },
      dataUpdate: {
        shouldSearchFlights: false, // Clear the flag
      },
    };
  }
);
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
    createMessageEvent(
      EventSource.CUSTOMER,
      "User",
      "I want to fly to Paris tomorrow with 2 people"
    ),
  ],
  session,
});

// User changes mind mid-conversation
const response2 = await agent.respond({
  history: [
    ...previousHistory,
    createMessageEvent(
      EventSource.CUSTOMER,
      "User",
      "Actually, make that Tokyo instead"
    ),
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
const saveName = defineTool<MyContext, [name: string], boolean>(
  "save_name",
  async (toolContext, name) => {
    return {
      data: true,
      contextUpdate: {
        userName: name,
        updatedAt: new Date(),
      },
    };
  }
);
```

**Pros:**

- Declarative and functional
- Easy to test
- Context update is part of the result

### Option B: Call `updateContext()` directly

```typescript
const saveName = defineTool<MyContext, [name: string], boolean>(
  "save_name",
  async (toolContext, name) => {
    await toolContext.updateContext({
      userName: name,
      updatedAt: new Date(),
    });

    return { data: true };
  }
);
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
import { Agent, defineTool } from "@falai/agent";

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
  const saveBusinessName = defineTool(
    "save_business_name",
    async (ctx, name: string) => {
      return {
        data: true,
        contextUpdate: {
          businessName: name,
          completedSteps: [...ctx.context.completedSteps, "business_name"],
        },
      };
    }
  );

  const saveIndustry = defineTool(
    "save_industry",
    async (ctx, industry: string) => {
      // Alternative: use updateContext directly
      await ctx.updateContext({
        industry,
        completedSteps: [...ctx.context.completedSteps, "industry"],
      });

      return { data: true };
    }
  );

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
    history: [createMessageEvent(EventSource.CUSTOMER, "User", message)],
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
- [API Reference: AgentOptions](./API_REFERENCE.md#agentoptions)
- [API Reference: ContextLifecycleHooks](./API_REFERENCE.md#contextlifecyclehooks)
- [Getting Started](./GETTING_STARTED.md)

---

## 🆘 Need Help?

If you're still having issues:

1. Check the [examples](../examples/) for working implementations
2. Review the [API Reference](./API_REFERENCE.md) for detailed type information
3. Open an issue on GitHub with your use case

**Remember:** The key to persistent conversations is:

1. **Recreate agents** each turn
2. **Load fresh context** via hooks/provider
3. **Persist updates** via `onContextUpdate`
4. **Never cache** agent instances across requests
