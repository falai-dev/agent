# Constructor Configuration Guide

## Overview

The `@falai/agent` framework supports **two complementary patterns** for configuration:

1. **Declarative** - Pass arrays/objects in constructors (great for static configs)
2. **Fluent/Programmatic** - Chain methods to build dynamically (great for runtime logic)

You can **mix both patterns** - initialize with constructor options, then add more dynamically!

---

## 📦 Agent Constructor Options

```typescript
interface AgentOptions<TContext = unknown> {
  // Required
  name: string;
  ai: AiProvider;

  // Optional metadata
  description?: string;
  goal?: string;
  context?: TContext;

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
    onExtractedUpdate?: (
      extracted: Record<string, unknown>,
      previousExtracted: Record<string, unknown>
    ) => Promise<Record<string, unknown>> | Record<string, unknown>;
  };

  // Declarative initialization
  terms?: Term[];
  guidelines?: Guideline[];
  capabilities?: Capability[];
  routes?: RouteOptions[];
}
```

### Example: Data-Driven Agent with Session State

```typescript
// Define your data extraction types
interface FlightData {
  destination: string;
  departureDate: string;
  passengers: number;
  cabinClass: "economy" | "business" | "first";
}

const agent = new Agent<FlightBookingContext>({
  name: 'FlightBot',
  description: 'Helpful flight booking assistant',
  goal: 'Book flights efficiently',
  ai: new GeminiProvider({ apiKey: '...', model: '...' }),

  // Static context
  context: {
    userId: '123',
    availableFlights: [],
  },

  // Enhanced lifecycle hooks
  hooks: {
    // Refresh context before each response
    beforeRespond: async (ctx) => {
      const freshUser = await db.getUser(ctx.userId);
      return { ...ctx, userCredits: freshUser.credits };
    },

    // Validate and enrich extracted data
    onExtractedUpdate: async (extracted, previous) => {
      // Normalize passenger count
      if (extracted.passengers < 1) extracted.passengers = 1;
      if (extracted.passengers > 9) extracted.passengers = 9;

      // Auto-trigger flight search when we have enough data
      if (extracted.destination && extracted.departureDate && extracted.passengers) {
        extracted.shouldSearchFlights = true;
      }

      return extracted;
    },
  },

  // Declarative routes with data extraction
  routes: [
    {
      title: 'Book Flight',
      description: 'Help user book a flight',
      conditions: ['User wants to book a flight'],
      gatherSchema: {
        type: 'object',
        properties: {
          destination: { type: 'string' },
          departureDate: { type: 'string' },
          passengers: { type: 'number', minimum: 1, maximum: 9 },
          cabinClass: {
            type: 'string',
            enum: ['economy', 'business', 'first'],
            default: 'economy',
          },
        },
        required: ['destination', 'departureDate', 'passengers'],
      },
    },
  ],

  // Domain glossary
  terms: [
    {
      name: 'Premium Plan',
      description: 'Our top-tier subscription at $99/month',
      synonyms: ['pro plan', 'premium subscription'],
    },
  ],

  // Behavioral guidelines
  guidelines: [
    {
      action: 'Always be polite and professional',
      enabled: true,
    },
    {
      condition: 'User seems frustrated',
      action: 'Apologize sincerely and offer to escalate to human support',
      enabled: true,
    },
  ],
  ],

  capabilities: [
    { title: 'Ticket Management', description: 'Create and track tickets' },
  ],
});

// Use with session state
let session = createSession<FlightData>();
const response = await agent.respond({ history, session });
console.log(response.session?.extracted); // Extracted flight data
```

````

---

## 🛤️ Route Constructor Options

```typescript
interface RouteOptions<TExtracted = unknown> {
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
  gatherSchema?: {
    type: "object";
    properties: Record<string, any>;
    required?: string[];
    additionalProperties?: boolean;
  };

  // NEW: Pre-populate extracted data when entering route
  initialData?: Partial<TExtracted>;
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
  ai: provider,
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
  ai: provider,
  routes: [
    { title: "Schedule Appointment", conditions: [...] },
    { title: "Cancel Appointment", conditions: [...] },
    { title: "Reschedule Appointment", conditions: [...] }
  ],
});
```

---

## 🔄 Fluent API (Still Available!)

All constructor options also have fluent methods that **return `this`** for chaining:

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
- ✅ Building routes with **complex state machines**
- ✅ Adding features **based on runtime conditions**
- ✅ You prefer **step-by-step construction**

### Mix Both!

```typescript
// Start with static config
const agent = new Agent({
  name: "Bot",
  ai: provider,
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
  ai: AiProvider,
  context?: MyContext,
  maxEngineIterations?: number,
  compositionMode?: CompositionMode,
  terms?: Term[],
  guidelines?: Guideline[],
  capabilities?: Capability[],
  routes?: RouteOptions[],      // Can include nested guidelines
});
```

**Made with ❤️ for the community**
