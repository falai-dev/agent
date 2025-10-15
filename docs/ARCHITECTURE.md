# Architecture & Design Principles

## Overview

`@falai/agent` is built on a **schema-first, data-driven architecture** that prioritizes type safety, structured data extraction, and code-based state management over fuzzy LLM conditions. This creates predictable, maintainable, and efficient conversational AI agents.

## Core Design Principles

### 1. 🎯 Schema-First Data Extraction

Define what data to collect upfront using JSON Schema, then extract it reliably:

```typescript
// Define your data contract
interface FlightData {
  destination: string;
  departureDate: string;
  passengers: number;
  cabinClass: "economy" | "business" | "first";
}

const route = agent.createRoute<FlightData>({
  title: "Book Flight",
  description: "Help user book a flight",
  gatherSchema: {
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
});
```

**Why?** Schema-first extraction provides:

- **Type Safety** - Full TypeScript types from definition to extraction
- **Reliability** - Provider-enforced schemas, not prompt-based parsing
- **Predictability** - Same data structure every time
- **Efficiency** - Extract multiple fields in one LLM call

### 2. 📊 Session State Management

Track conversation progress and extracted data across turns:

```typescript
import {
  createSession,
  enterRoute,
  enterState,
  mergeExtracted,
} from "@falai/agent";

let session = createSession<FlightData>();

// Turn 1 - Extract data
const response1 = await agent.respond({ history, session });
session = response1.session!; // Updated with extracted data

// Turn 2 - User changes mind (always-on routing)
const response2 = await agent.respond({ history, session: response1.session });
session = response2.session!; // Route/state updated if user changed direction
```

**Why?** Session state enables:

- **Always-on Routing** - Users can change their mind mid-conversation
- **Context Awareness** - Router sees current progress and extracted data
- **Data Persistence** - Extracted data survives across turns
- **State Recovery** - Resume conversations from any point

### 3. 🔧 Code-Based State Logic

Use TypeScript functions instead of LLM conditions for deterministic flow:

```typescript
// State with smart bypassing based on extracted data
const askDestination = route.initialState.transitionTo({
  chatState: "Ask where they want to fly",
  gather: ["destination"],
  skipIf: (extracted) => !!extracted.destination, // Code-based condition!
});

const askDate = askDestination.transitionTo({
  chatState: "Ask about travel dates",
  gather: ["departureDate"],
  skipIf: (extracted) => !!extracted.departureDate,
  requiredData: ["destination"], // Prerequisites
});
```

**Why?** Code-based logic provides:

- **Predictability** - No fuzzy LLM interpretation of conditions
- **Performance** - No extra LLM calls for condition checking
- **Debugging** - Clear logic flow you can trace
- **Type Safety** - Full TypeScript support for data validation

### 4. 🛠️ Tools with Data Access

Tools execute with full context including extracted data:

```typescript
const searchFlights = defineTool<Context, [], void, FlightData>(
  "search_flights",
  async (toolContext) => {
    const { extracted, context, history } = toolContext;

    // Access extracted data directly
    if (!extracted.destination || !extracted.departureDate) {
      return { data: undefined };
    }

    // Enrich extracted data
    return {
      data: undefined,
      extractedUpdate: {
        destinationCode: await lookupAirportCode(extracted.destination),
        departureDateParsed: parseDate(extracted.departureDate),
      },
    };
  }
);
```

**Why?** Tools with data access enable:

- **Data Enrichment** - Tools can validate and enhance extracted data
- **Computed Fields** - Calculate derived values from extracted data
- **Conditional Execution** - Tools decide what to do based on data state
- **Action Flags** - Tools can set flags for subsequent operations

### 5. 🎭 Always-On Routing

Routing happens every turn, allowing users to change direction:

```typescript
// User starts booking a flight
const response1 = await agent.respond({
  history: [
    createMessageEvent(EventSource.CUSTOMER, "User", "I want to fly to Paris"),
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

- Execute tools if current state has `toolState`
- Update context with tool results
- Enrich extracted data if tools return `extractedUpdate`

**Phase 2: Routing**

- Build dynamic routing schema (scores for all routes 0-100)
- Include session context in routing prompt
- AI selects best route based on current state
- Update session if route changed

**Phase 3: Response**

- Determine next state using `skipIf` and `requiredData`
- Build response schema including current state's `gather` fields
- Generate message with schema-enforced data extraction
- Update session with newly extracted data

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

    // Validate and enrich extracted data
    onExtractedUpdate: async (extracted, previous) => {
      // Normalize data
      if (extracted.passengers < 1) extracted.passengers = 1;

      // Auto-trigger actions
      if (hasAllRequiredData(extracted)) {
        extracted.shouldSearchFlights = true;
      }

      return extracted;
    },
  },
});
```

**Why?** Lifecycle hooks provide:

- **Data Validation** - Ensure extracted data meets business rules
- **Enrichment** - Add computed fields or normalize values
- **Persistence** - Save/restore conversation state
- **Integration** - Connect with external systems

## Comparison with Other Approaches

### @falai/agent vs Traditional State Machines

| Aspect              | @falai/agent (Data-Driven) | Traditional State Machines            |
| ------------------- | -------------------------- | ------------------------------------- |
| **State Logic**     | Code-based (`skipIf`)      | Manual condition checking             |
| **Data Collection** | Schema-driven extraction   | Manual parsing                        |
| **Type Safety**     | Full TypeScript            | Often runtime validation              |
| **LLM Calls/Turn**  | 1-2 (routing + response)   | 3-5 (conditions + routing + response) |
| **Validation**      | Code + schemas             | Manual implementation                 |
| **Routing**         | Always-on, context-aware   | Route-only, rigid                     |

### @falai/agent vs OpenAI Function Calling

| Aspect             | @falai/agent             | OpenAI Functions              |
| ------------------ | ------------------------ | ----------------------------- |
| **Tool Execution** | Automatic (state-driven) | AI-decided                    |
| **Flow Control**   | Code-based state logic   | AI inference                  |
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
- **Simple Q&A** - Stateless question-answering (use stateless routes!)
- **Rapid Prototyping** - When you need maximum flexibility

## Architecture Patterns

### Stateful Routes (Data Collection)

For structured data gathering with state management:

```typescript
interface BookingData {
  destination: string;
  dates: string;
  passengers: number;
}

const bookingRoute = agent.createRoute<BookingData>({
  title: "Flight Booking",
  gatherSchema: {
    /* schema for all fields */
  },
});

bookingRoute.initialState
  .transitionTo({
    chatState: "Ask destination",
    gather: ["destination"],
    skipIf: (data) => !!data.destination,
  })
  .transitionTo({
    toolState: enrichDestination, // Validates and enriches
    requiredData: ["destination"],
  })
  .transitionTo({
    chatState: "Ask dates",
    gather: ["dates"],
    skipIf: (data) => !!data.dates,
  });
```

### Stateless Routes (Q&A)

For simple question-answering without state:

```typescript
const qnaRoute = agent.createRoute({
  title: "Company Q&A",
  conditions: ["User asks about company"],
  // NO gatherSchema - stateless!
});

// Just use initial state
qnaRoute.initialState.chatState = "Answer from knowledge base";
```

### Mixed Architecture

Combine both patterns in one agent:

```typescript
// Q&A routes (stateless)
const companyInfoRoute = agent.createRoute({
  /* no schema */
});
const productInfoRoute = agent.createRoute({
  /* no schema */
});

// Booking routes (stateful)
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
2. **State Machines** - Explicit state modeling for predictability
3. **TypeScript** - Full type safety throughout
4. **Functional Programming** - Pure functions for state logic
5. **React Hooks** - Lifecycle patterns for extensibility

## Further Reading

- [Getting Started Guide](./GETTING_STARTED.md) - Build your first agent
- [Session State Guide](./CONTEXT_MANAGEMENT.md) - Session management patterns
- [API Reference](./API_REFERENCE.md) - Complete API documentation
- [Examples](../examples/) - Real-world implementations

---

**Questions?** Open an issue or discussion on [GitHub](https://github.com/gusnips/falai).
