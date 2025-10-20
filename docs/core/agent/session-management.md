# Session Management

## Overview

The `@falai/agent` framework provides **automatic session management** through the `SessionManager` class, eliminating the need for manual session creation, persistence, and state management. Sessions are automatically created, loaded, and saved, allowing developers to focus on building conversation logic rather than managing session lifecycle.

## Core Design Principles

### 1. 🎯 Agent-Level Schema-First Data Extraction

Define what data to collect upfront using JSON Schema at the agent level, then extract it reliably across all routes:

```typescript
// Define your agent-level data contract
interface TravelData {
  destination: string;
  departureDate: string;
  passengers: number;
  cabinClass: "economy" | "business" | "first";
  hotelPreference?: string;
  budgetRange?: string;
  specialRequests?: string;
}

// Agent with centralized schema
const agent = new Agent<{}, TravelData>({
  name: "Travel Agent",
  provider: new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY }),
  
  // Agent-level schema defines all possible data fields
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
      hotelPreference: { type: "string" },
      budgetRange: { type: "string" },
      specialRequests: { type: "string" }
    },
    required: ["destination", "departureDate", "passengers"],
  }
});

// Routes specify required fields instead of schemas
const flightRoute = agent.createRoute({
  title: "Book Flight",
  description: "Help user book a flight",
  requiredFields: ["destination", "departureDate", "passengers", "cabinClass"],
  optionalFields: ["specialRequests"]
});

const hotelRoute = agent.createRoute({
  title: "Book Hotel", 
  description: "Help user book accommodation",
  requiredFields: ["destination", "departureDate", "hotelPreference"],
  optionalFields: ["budgetRange", "specialRequests"]
});
```

**Why?** Agent-level schema-first extraction provides:

- **Type Safety** - Full TypeScript types from definition to extraction across all routes
- **Reliability** - Provider-enforced schemas, not prompt-based parsing
- **Predictability** - Same data structure every time, shared across routes
- **Efficiency** - Extract multiple fields in one LLM call
- **Cross-Route Data Sharing** - Data collected by any route is available to all routes
- **Route Completion** - Routes complete when their required fields are satisfied

### 2. 🤖 Automatic Session Management

Sessions are automatically managed through the `SessionManager` class integrated into every `Agent`:

```typescript
// Server-side: Agent with automatic session management and agent-level data
const agent = new Agent<{}, TravelData>({
  name: "Travel Agent",
  provider: new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY }),
  persistence: { adapter: new PrismaAdapter({ prisma }) },
  sessionId: "user-123", // Automatically loads or creates this session
  
  // Agent-level schema
  schema: { /* comprehensive travel data schema */ }
});

// Simple conversation - no manual session management
const response1 = await agent.respond("I want to book a flight to Paris");
console.log(agent.session.id); // Session ID
console.log(agent.session.getData<TravelData>()); // Agent-level collected data

// Continue conversation - session automatically maintained
const response2 = await agent.respond("Make that Tokyo instead");
// Session automatically updated with new data in agent-level structure

// Switch to hotel booking - data is shared
const response3 = await agent.respond("Also book me a hotel in Tokyo");
// Hotel route can access destination data collected by flight route
```

**SessionManager API:**

The `SessionManager` provides a clean API for session operations:

```typescript
// Access the session manager
const sessionManager = agent.session;

// Get or create session (works for existing, new, or auto-generated IDs)
await sessionManager.getOrCreate("user-123");
await sessionManager.getOrCreate(); // Auto-generates ID

// History management
await sessionManager.addMessage("user", "Hello");
await sessionManager.addMessage("assistant", "Hi there!");
const history = sessionManager.getHistory();
sessionManager.clearHistory();

// Data access
const data = sessionManager.getData<FlightData>();
await sessionManager.setData({ destination: "Paris" });

// Session operations
await sessionManager.save(); // Manual save (auto-saves on addMessage)
await sessionManager.delete();
const newSession = await sessionManager.reset(true); // Preserve history
```

**Why?** Automatic session management provides:

- **Zero Boilerplate** - No manual session creation or persistence code
- **Server-Friendly** - Perfect for stateless server environments
- **Always-on Routing** - Users can change their mind mid-conversation
- **Context Awareness** - Router sees current progress and collected data
- **Data Persistence** - Collected data automatically saved and restored
- **History Management** - Conversation history automatically maintained
- **Session Tracking** - Easy session identification for client/server communication

### 3. 🔧 Code-Based Step Logic + AI-Driven Transitions

Use TypeScript functions for deterministic flow control AND text conditions for AI-driven step selection:

```typescript
// Step with smart bypassing based on collected data
const askDestination = route.initialStep.nextStep({
  id: "ask_destination", // Optional: custom step ID
  prompt: "Ask where they want to fly",
  collect: ["destination"],
  skipIf: (data) => !!data.destination, // Code-based condition!
  condition: "Customer hasn't specified destination yet", // Text condition for AI
});

const askDate = askDestination.nextStep({
  id: "ask_date", // Optional: custom step ID for easier tracking
  prompt: "Ask about travel dates",
  collect: ["departureDate"],
  skipIf: (data) => !!data.departureDate,
  requires: ["destination"], // Prerequisites
  condition: "Destination confirmed, need travel dates now",
});
});
```

**Custom Step IDs:**

You can optionally provide custom IDs for steps to make them easier to track and reference:

```typescript
const confirmBooking = askDate.nextStep({
  id: "confirm_booking", // ✅ Custom ID instead of auto-generated
  prompt: "Confirm all booking details",
  requires: ["destination", "departureDate", "passengers"],
});
```

If you don't provide an ID, one is automatically generated from the route ID and step description.

**Why?** Code-based logic provides:

- **Predictability** - No fuzzy LLM interpretation of conditions
- **Performance** - No extra LLM calls for condition checking
- **Debugging** - Clear logic flow you can trace
- **Type Safety** - Full TypeScript support for data validation
- **Custom IDs** - Easier tracking and debugging with meaningful step identifiers

**How Step Transitions Work:**

1. **Code filters first**: `skipIf` and `requires` filter out invalid steps deterministically
2. **AI selects best step**: From valid candidates, AI evaluates text conditions to choose optimal step
3. **Combined decision**: Single AI call handles both route selection AND step selection (no extra calls!)
4. **Completion detection**: When all steps are skipped and `END_ROUTE` is reached, route is marked complete

```typescript
// The AI sees:
// "Available steps: askDate, confirmBooking
//  - askDate: Destination confirmed, need travel dates now
//  - confirmBooking: All required info collected, ready to book
//  Current data: {destination: 'Paris', departureDate: '2025-01-15'}
//
//  → AI selects 'confirmBooking' based on context"
```

### 4. 🛠️ Tools with Data Access

Tools execute with full context including collected data:

```typescript
import { Tool } from "@falai/agent";

const searchFlights: Tool<Context, [], void, FlightData> = {
  id: "search_flights",
  description: "Search for available flights based on collected data",
  parameters: {
    type: "object",
    properties: {},
  },
  handler: async (toolContext) => {
    const { data, context, history } = toolContext;

    // Access collected data directly
    if (!data.destination || !data.departureDate) {
      return { data: undefined };
    }

    // Enrich collected data
    return {
      data: undefined,
      dataUpdate: {
        destinationCode: await lookupAirportCode(data.destination),
        departureDateParsed: parseDate(data.departureDate),
      },
    };
  },
};
```

**Why?** Tools with data access enable:

- **Data Enrichment** - Tools can validate and enhance collected data
- **Computed Fields** - Calculate derived values from collected data
- **Conditional Execution** - Tools decide what to do based on data step
- **Action Flags** - Tools can set flags for subsequent operations

### 5. 🎭 Always-On Routing

Routing happens every turn, allowing users to change direction:

```typescript
// User starts booking a flight
const response1 = await agent.respond({
  history: [
    {
      role: "user",
      content: "I want to fly to Paris",
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
```

**Why?** Always-on routing provides:

- **User Control** - Users can change their mind naturally
- **Context Awareness** - Router considers current progress
- **Graceful Transitions** - Smooth handling of intent changes
- **No Dead Ends** - Always a valid next step

### 6. 🔄 Three-Phase Pipeline

Clean separation of concerns in every response:

```
1. PREPARATION → 2. ROUTING → 3. RESPONSE
```

**Phase 1: Preparation**

- Execute tools if current step has `tool`
- Update context with tool results
- Enrich collected data if tools return `dataUpdate`

**Phase 2: Routing**

- Build dynamic routing schema (scores for all routes 0-100)
- Include session context in routing prompt
- AI selects best route based on current step
- Update session if route changed

**Phase 3: Response**

- Determine next step using `skipIf` and `requires`
- Build response schema including current step's `collect` fields
- Generate message with schema-enforced data extraction
- Update session with newly collected data

**Why?** This architecture enables:

- **Efficiency** - 1-2 LLM calls per turn vs 3-5 in condition-heavy approaches
- **Reliability** - Tools execute before AI sees the conversation
- **Flexibility** - Always-on routing handles any user direction
- **Type Safety** - Schemas ensure consistent data structures

### 7. 📦 Enhanced Lifecycle Hooks

Hooks for validation, enrichment, and persistence:

```typescript
const agent = new Agent({
  // ... other options
  hooks: {
    // Refresh context before each response
    beforeRespond: async (ctx) => {
      return await loadFreshContext(ctx.userId);
    },

    // Persist context updates
    onContextUpdate: async (newCtx, oldCtx) => {
      await saveContext(newCtx);
    },

    // Validate and enrich collected data
    onDataUpdate: async (data, previous) => {
      // Normalize data
      if (data.passengers < 1) data.passengers = 1;

      // Auto-trigger actions
      if (hasAllRequires(data)) {
        data.shouldSearchFlights = true;
      }

      return data;
    },
  },
});
```

**Why?** Lifecycle hooks provide:

- **Data Validation** - Ensure collected data meets business rules
- **Enrichment** - Add computed fields or normalize values
- **Persistence** - Save/restore conversation step
- **Integration** - Connect with external systems

## Comparison with Other Approaches

### @falai/agent vs Traditional Step Machines

| Aspect              | @falai/agent (Data-Driven) | Traditional Step Machines             |
| ------------------- | -------------------------- | ------------------------------------- |
| **Step Logic**      | Code-based (`skipIf`)      | Manual condition checking             |
| **Data Collection** | Schema-driven extraction   | Manual parsing                        |
| **Type Safety**     | Full TypeScript            | Often runtime validation              |
| **LLM Calls/Turn**  | 1-2 (routing + response)   | 3-5 (conditions + routing + response) |
| **Validation**      | Code + schemas             | Manual implementation                 |
| **Routing**         | Always-on, context-aware   | Route-only, rigid                     |

### @falai/agent vs OpenAI Function Calling

| Aspect             | @falai/agent             | OpenAI Functions              |
| ------------------ | ------------------------ | ----------------------------- |
| **Tool Execution** | Automatic (step-driven)  | AI-decided                    |
| **Flow Control**   | Code-based step logic    | AI inference                  |
| **Determinism**    | High - code-driven flow  | Low - AI may vary             |
| **Data Handling**  | Structured schemas       | Unstructured function results |
| **Type Safety**    | Full TypeScript          | Runtime type checking         |
| **Use Case**       | Structured conversations | Flexible, open-ended tasks    |

## When to Use @falai/agent

✅ **Great for:**

- **Data Collection Flows** - Booking, onboarding, forms, surveys
- **Multi-Step Processes** - Complex workflows with clear progression
- **Type-Safe Applications** - When data structure matters
- **Predictable Conversations** - Structured, goal-oriented interactions
- **Session-Based Apps** - Conversations that span multiple turns

❌ **Not ideal for:**

- **Open-Ended Chat** - General conversation without clear goals
- **Creative Tasks** - Brainstorming, writing, ideation
- **Simple Q&A** - Stepless question-answering (use stepless routes!)
- **Rapid Prototyping** - When you need maximum flexibility

## Architecture Patterns

### Stepful Routes (Data Collection)

For structured data collecting with step management:

```typescript
interface BookingData {
  destination: string;
  dates: string;
  passengers: number;
}

const bookingRoute = agent.createRoute<BookingData>({
  title: "Flight Booking",
  schema: {
    /* schema for all fields */
  },
});

bookingRoute.initialStep
  .nextStep({
    prompt: "Ask destination",
    collect: ["destination"],
    skipIf: (data) => !!data.destination,
  })
  .nextStep({
    tool: enrichDestination, // Validates and enriches
    requires: ["destination"],
  })
  .nextStep({
    prompt: "Ask dates",
    collect: ["dates"],
    skipIf: (data) => !!data.dates,
  });
```

### Stepless Routes (Q&A)

For simple question-answering without step:

```typescript
const qnaRoute = agent.createRoute({
  title: "Company Q&A",
  conditions: ["User asks about company"],
  // NO schema - stepless!
});

// Just use initial step
qnaRoute.initialStep.prompt = "Answer from knowledge base";
```

### Mixed Architecture

Combine both patterns in one agent:

```typescript
// Q&A routes (stepless)
const companyInfoRoute = agent.createRoute({
  /* no schema */
});
const productInfoRoute = agent.createRoute({
  /* no schema */
});

// Booking routes (stepful)
const bookingRoute = agent.createRoute<BookingData>({
  /* with schema */
});
const supportRoute = agent.createRoute<SupportData>({
  /* with schema */
});
```

## Design Influences

This framework draws inspiration from:

1. **Schema-First APIs** - JSON Schema for data contracts
2. **Step Machines** - Explicit step modeling for predictability
3. **TypeScript** - Full type safety throughout
4. **Functional Programming** - Pure functions for step logic
5. **React Hooks** - Lifecycle patterns for extensibility

## Further Reading

- [Getting Started Guide](../guides/getting-started/README.md) - Build your first agent
- [Session Step Guide](./CONTEXT_MANAGEMENT.md) - Session management patterns
- [API Reference](../api/README.md) - Complete API documentation
- [Examples](../examples/) - Real-world implementations

---

**Questions?** Open an issue or discussion on [GitHub](https://github.com/falai-dev/agent).
