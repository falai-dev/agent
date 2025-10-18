# Agent Configuration Guide

## Overview

The `@falai/agent` framework supports **two complementary patterns** for configuration:

1. **Declarative** - Pass arrays/objects in constructors (great for static configs)
2. **Fluent/Programmatic** - Chain methods to build dynamically (great for runtime logic)

You can **mix both patterns** - initialize with agent, then add more dynamically!

---

## 📦 Agent Agent

```typescript
interface AgentOptions<TContext = unknown> {
  // Required
  name: string;
  provider: AiProvider;

  // Optional metadata
  description?: string;
  goal?: string;
  context?: TContext;

  // Optional current session for convenience methods
  session?: SessionState;

  // Context provider for always-fresh context
  contextProvider?: () => Promise<TContext> | TContext;

  // Configuration
  compositionMode?: CompositionMode;

  // Enhanced lifecycle hooks
  hooks?: {
    beforeRespond?: (currentContext: TContext) => Promise<TContext> | TContext;
    onContextUpdate?: (
      newContext: TContext,
      previousContext: TContext
    ) => Promise<void> | void;
    onDataUpdate?: (
      data: Record<string, unknown>,
      previousData: Record<string, unknown>
    ) => Promise<Record<string, unknown>> | Record<string, unknown>;
  };

  // Declarative initialization
  terms?: Term[];
  guidelines?: Guideline[];
  capabilities?: Capability[];
  routes?: RouteOptions[];
  /** Knowledge base containing any JSON structure the AI should know */
  knowledgeBase?: Record<string, unknown>;
}
```

### Example: Data-Driven Agent with Session Step

```typescript
// Define your data extraction types
interface FlightData {
  destination: string;
  departureDate: string;
  passengers: number;
  cabinClass: "economy" | "business" | "first";
}

const agent = new Agent<FlightBookingContext>({
  name: "FlightBot",
  description: "Helpful flight booking assistant",
  goal: "Book flights efficiently",
  provider: new GeminiProvider({ apiKey: "...", model: "..." }),

  // Static context
  context: {
    userId: "123",
    availableFlights: [],
  },

  // Optional: Set initial session for convenience methods
  session: createSession<FlightData>({
    data: { destination: "Paris" }, // Pre-populate with known data
  }),

  // Enhanced lifecycle hooks
  hooks: {
    // Refresh context before each response
    beforeRespond: async (ctx) => {
      const freshUser = await db.getUser(ctx.userId);
      return { ...ctx, userCredits: freshUser.credits };
    },

    // Validate and enrich collected data
    onDataUpdate: async (data, previous) => {
      // Normalize passenger count
      if (data.passengers < 1) data.passengers = 1;
      if (data.passengers > 9) data.passengers = 9;

      // Auto-trigger flight search when we have enough data
      if (data.destination && data.departureDate && data.passengers) {
        data.shouldSearchFlights = true;
      }

      return data;
    },
  },

  // Declarative routes with data extraction
  routes: [
    {
      title: "Book Flight",
      description: "Help user book a flight",
      conditions: ["User wants to book a flight"],
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
    },
  ],

  // Domain glossary
  terms: [
    {
      name: "Premium Plan",
      description: "Our top-tier subscription at $99/month",
      synonyms: ["pro plan", "premium subscription"],
    },
  ],

  // Behavioral guidelines
  guidelines: [
    {
      action: "Always be polite and professional",
      enabled: true,
    },
    {
      condition: "User seems frustrated",
      action: "Apologize sincerely and offer to escalate to human support",
      enabled: true,
    },
  ],

  capabilities: [
    { title: "Ticket Management", description: "Create and track tickets" },
  ],
});

// Option 1: Use session passed to respond (traditional)
let session = createSession<FlightData>();
const response = await agent.respond({ history, session });
console.log(response.session?.data); // Data flight data

// Option 2: Use session set in constructor (convenience methods)
// Since we set session in constructor, no need to pass it!
const response2 = await agent.respond({ history });
console.log(agent.getData()); // Uses constructor session

// Option 3: Override session for specific calls
const customSession = createSession<FlightData>({
  data: { destination: "Tokyo" },
});
const response3 = await agent.respond({ history, session: customSession });
console.log(response3.session?.data); // Uses custom session
```

### Example: Agent with Knowledge Base

```typescript
const agent = new Agent({
  name: "TravelBot",
  description: "AI travel assistant with company knowledge",
  provider: new GeminiProvider({ apiKey: "...", model: "..." }),

  // Knowledge base - any JSON structure the AI should know
  knowledgeBase: {
    company: {
      name: "Acme Travel",
      policies: {
        cancellation: "Free cancellation up to 24 hours before departure",
        refund: "Refunds processed within 5-7 business days",
        baggage: "First checked bag free, additional bags $30 each",
      },
      destinations: ["Paris", "Tokyo", "New York", "London"],
      peakSeasons: ["June-August", "December-January"],
    },
    pricing: {
      baseFare: "$299",
      taxes: "Included in displayed price",
      fees: {
        booking: "$15",
        service: "$5 per passenger",
      },
    },
    faq: [
      "How do I cancel my booking?",
      "What's included in the price?",
      "Can I change my flight date?",
    ],
  },

  // Routes can have their own knowledge bases too
  routes: [
    {
      title: "Book Flight",
      conditions: ["User wants to book a flight"],
      knowledgeBase: {
        bookingSteps: [
          "Collect passenger information",
          "Select flight options",
          "Enter payment details",
          "Confirm booking",
        ],
        requirements: {
          passport: "Valid for 6 months beyond return date",
          visa: "Check requirements for destination country",
        },
      },
    },
  ],
});

// The AI will automatically know about Acme Travel's policies, pricing, and FAQs
const response = await agent.respond({ history });
```

**Knowledge Base Features:**

- ✅ **Any JSON structure** - Objects, arrays, nested data, primitives
- ✅ **Agent-level knowledge** - Available to all routes
- ✅ **Route-specific knowledge** - Merged with agent knowledge (route takes precedence)
- ✅ **Auto-formatted to markdown** - Readable for AI consumption
- ✅ **Type-safe** - `Record<string, unknown>` for flexible structure

````

---

## 💾 Session Management

The agent supports flexible session management for conversation step tracking:

### Constructor Session (Optional)

Set an initial session in the constructor for convenience:

```typescript
const agent = new Agent({
  name: 'Bot',
  provider: provider,
  session: createSession<MyData>({
    data: { name: 'John' }, // Pre-populate data
  }),
});

// Use convenience methods without passing session
const response = await agent.respond({ history });
const data = agent.getData(); // Uses constructor session
```

### Runtime Session Management

```typescript
// Set session for convenience methods
agent.setCurrentSession(session);

// Use without passing session parameter
const data = agent.getData();
const routeData = agent.getData('onboarding');

// Override for specific calls
const response = await agent.respond({ history, session: customSession });

// Clear when done
agent.clearCurrentSession();
```

### Session Preservation

When switching routes, collected data is preserved in `dataByRoute`:

```typescript
// User switches from onboarding to booking
const response = await agent.respond({ history }); // Switches routes

// Access data from previous routes
const onboardingData = agent.getData('onboarding');
const bookingData = agent.getData('booking');
```

---

## 🛤️ Route Agent

```typescript
interface RouteOptions<TData = unknown> {
  // Required
  title: string;

  // Optional
  id?: string;              // Custom ID (auto-generated from title if not provided)
  description?: string;
  conditions?: string[];
  guidelines?: Guideline[];
  domains?: string[];       // Restrict which domains are available in this route
  rules?: string[];         // Absolute rules the agent MUST follow
  prohibitions?: string[];  // Absolute prohibitions the agent MUST NEVER do

  // NEW: Schema-first data extraction
  schema?: {
    type: "object";
    properties: Record<string, any>;
    required?: string[];
    additionalProperties?: boolean;
  };

  // NEW: Pre-populate collected data when entering route
  initialData?: Partial<TData>;
}
````

**Domain Scoping:**

- Use `domains` to limit which registered domains (tools/methods) can be accessed during this route
- If `undefined` or omitted, all registered domains are available
- Useful for security (preventing unauthorized tool calls) and performance (reducing AI decision space)

**Rules & Prohibitions:**

- **Rules**: Absolute requirements the agent must follow in this route (style, format, behavior)
- **Prohibitions**: Things the agent must never do in this route
- These override general guidelines if there's any conflict
- Applied automatically when the route is active
- Perfect for controlling message style, tone, length, emoji usage, etc.

### Example: Route with Nested Guidelines

```typescript
const agent = new Agent({
  name: "Bot",
  provider: provider,
  routes: [
    {
      title: "Onboarding",
      description: "Guide new users",
      conditions: ["User is new"],
      guidelines: [
        {
          condition: "User skips a step",
          action: "Gently remind them it's important",
          tags: ["onboarding"],
        },
        {
          condition: "User seems confused",
          action: "Offer a quick tutorial video",
          tags: ["help"],
        },
      ],
    },
  ],
});
```

### Example: Route with Domain Scoping

```typescript
// Register domains
agent.addDomain("scraping", {
  scrapeSite: async (url: string) => {
    /* ... */
  },
  extractData: async (html: string) => {
    /* ... */
  },
});

agent.addDomain("calendar", {
  scheduleEvent: async (date: Date, title: string) => {
    /* ... */
  },
  listEvents: async () => {
    /* ... */
  },
});

agent.addDomain("payment", {
  processPayment: async (amount: number) => {
    /* ... */
  },
});

// Create routes with domain restrictions
agent.createRoute({
  title: "Data Collection",
  description: "Collect and process web data",
  domains: ["scraping"], // ✅ Only scraping tools available
});

agent.createRoute({
  title: "Schedule Meeting",
  description: "Book appointments",
  domains: ["calendar"], // ✅ Only calendar tools available
});

agent.createRoute({
  title: "Checkout",
  description: "Process purchase",
  domains: ["payment", "calendar"], // ✅ Multiple domains allowed
});

agent.createRoute({
  title: "FAQ Support",
  description: "Answer general questions",
  domains: [], // ✅ No tools available (conversation only)
});

agent.createRoute({
  title: "Admin Support",
  description: "Administrative tasks",
  // domains not specified = all domains available (for demo purposes)
});
```

### Example: Route with Rules & Prohibitions

```typescript
// WhatsApp support bot with different styles per route
agent.createRoute({
  title: "Customer Support",
  description: "Help customers with issues",
  domains: [],
  rules: [
    "Keep messages short (maximum 2 lines per message)",
    "Use maximum 1 emoji per message",
    "Always ask if the issue is resolved before ending",
    "Professional but friendly tone",
  ],
  prohibitions: [
    "Never send messages longer than 3 paragraphs",
    "Do not use slang or informal language",
    "Never promise what you cannot deliver",
    "Do not ask for sensitive information via chat",
  ],
});

agent.createRoute({
  title: "Sales Consultation",
  description: "Help customer discover needs and present solutions",
  domains: ["calendar", "analytics"],
  rules: [
    "Ask open-ended questions to discover needs",
    "Use storytelling when presenting solutions",
    "Emoji only to reinforce positive emotions 😊",
    "Always present value before mentioning price",
  ],
  prohibitions: [
    "Never talk about price before showing value",
    "Do not pressure the customer",
    "Avoid complex technical terms",
    "Never send more than 2 messages in a row without customer response",
  ],
});

agent.createRoute({
  title: "Emergency Support",
  description: "Handle urgent customer issues",
  domains: ["notifications", "ticketing"],
  rules: [
    "Respond immediately and acknowledge urgency",
    "Use clear, direct language",
    "Provide concrete next steps",
    "Set clear expectations on resolution time",
  ],
  prohibitions: [
    "Never downplay the customer's concern",
    "Do not use emojis",
    'Never say "calm down" or similar phrases',
    "Do not transfer without explaining why",
  ],
});
```

**How it works:**

- Rules and prohibitions are automatically applied when the route is active
- They override general guidelines if there's any conflict
- Perfect for controlling communication style per context
- Applied in the AI prompt to ensure compliance

---

### Example: With Route References

```typescript
const agent = new Agent({
  name: "HealthBot",
  provider: provider,
  routes: [
    { title: "Schedule Appointment", conditions: [...] },
    { title: "Cancel Appointment", conditions: [...] },
    { title: "Reschedule Appointment", conditions: [...] }
  ],
});
```

---

## 🔄 Fluent API (Still Available!)

All agents also have fluent methods that **return `this`** for chaining:

```typescript
agent
  .createTerm({ name: "API", description: "..." })
  .createGuideline({ condition: "...", action: "..." })
  .createCapability({ title: "...", description: "..." });

const route = agent.createRoute({ title: "..." });
route.createGuideline({ condition: "...", action: "..." });
```

---

## 🎨 Best Practices

### Use Declarative When:

- ✅ Configuration is **static** and known upfront
- ✅ Loading config from **JSON/YAML files**
- ✅ Building **reusable agent templates**
- ✅ You want **clean, readable initialization**

### Use Fluent When:

- ✅ Logic is **dynamic** or **conditional**
- ✅ Building routes with **complex step machines**
- ✅ Adding features **based on runtime conditions**
- ✅ You prefer **step-by-step construction**

### Mix Both!

```typescript
// Start with static config
const agent = new Agent({
  name: "Bot",
  provider: provider,
  terms: loadTermsFromFile(),
  guidelines: loadGuidelinesFromDB(),
});

// Add dynamic features
if (user.isPremium) {
  agent.createGuideline({
    condition: "User asks for priority support",
    action: "Escalate immediately to premium team",
  });
}
```

---

## 📊 Complete Comparison

| Feature              | Declarative (Constructor)       | Fluent (Methods)              |
| -------------------- | ------------------------------- | ----------------------------- |
| **Terms**            | `terms: Term[]`                 | `agent.createTerm(...)`       |
| **Guidelines**       | `guidelines: Guideline[]`       | `agent.createGuideline(...)`  |
| **Capabilities**     | `capabilities: Capability[]`    | `agent.createCapability(...)` |
| **Routes**           | `routes: RouteOptions[]`        | `agent.createRoute(...)`      |
| **Route Guidelines** | `route.guidelines: Guideline[]` | `route.createGuideline(...)`  |

---

## 🚀 Quick Reference

```typescript
// Everything in one place
const agent = new Agent<MyContext>({
  name: string,
  description?: string,
  goal?: string,
  provider: AiProvider,
  context?: MyContext,
  session?: SessionState,        // Optional current session
  maxEngineIterations?: number,
  compositionMode?: CompositionMode,
  terms?: Term[],
  guidelines?: Guideline[],
  capabilities?: Capability[],
  routes?: RouteOptions[],      // Can include nested guidelines
});
```

**Made with ❤️ for the community**
