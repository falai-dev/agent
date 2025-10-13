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

  // Configuration
  maxEngineIterations?: number;
  compositionMode?: CompositionMode;

  // Declarative initialization (NEW!)
  terms?: Term[];
  guidelines?: Guideline[];
  capabilities?: Capability[];
  routes?: RouteOptions[];
  observations?: ObservationOptions[];
}
```

### Example: Full Declarative Agent

```typescript
const agent = new Agent({
  name: "SupportBot",
  description: "Helpful customer support",
  goal: "Resolve issues efficiently",
  ai: new GeminiProvider({ apiKey: "...", model: "..." }),
  context: { userId: "123" },

  terms: [
    {
      name: "SLA",
      description: "Service Level Agreement",
      synonyms: ["response time"],
    },
  ],

  guidelines: [
    {
      condition: "User is frustrated",
      action: "Show empathy and offer escalation",
      tags: ["support"],
      enabled: true,
    },
  ],

  capabilities: [
    { title: "Ticket Management", description: "Create and track tickets" },
  ],

  routes: [
    {
      title: "Create Ticket",
      description: "Help user create a support ticket",
      conditions: ["User wants to report an issue"],
      guidelines: [
        { condition: "Issue is urgent", action: "Prioritize immediately" },
      ],
    },
  ],

  observations: [
    {
      description: "User mentions problem but unclear what kind",
      routeRefs: ["Create Ticket", "Check Ticket Status"], // By title!
    },
  ],
});
```

---

## 🛤️ Route Constructor Options

```typescript
interface RouteOptions {
  // Required
  title: string;

  // Optional
  description?: string;
  conditions?: string[];
  guidelines?: Guideline[]; // NEW!
}
```

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

---

## 🔍 Observation Options

```typescript
interface ObservationOptions {
  description: string;
  routeRefs?: string[]; // NEW! Reference routes by ID or title
}
```

### Example: Observations with Route References

```typescript
const agent = new Agent({
  name: "HealthBot",
  ai: provider,
  routes: [
    { title: "Schedule Appointment", conditions: [...] },
    { title: "Cancel Appointment", conditions: [...] },
    { title: "Reschedule Appointment", conditions: [...] }
  ],
  observations: [
    {
      description: "User mentions appointment but intent unclear",
      routeRefs: ["Schedule Appointment", "Reschedule Appointment"]
    },
    {
      description: "User wants to change something about their visit",
      routeRefs: ["Cancel Appointment", "Reschedule Appointment"]
    }
  ]
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

const obs = agent.createObservation("User intent unclear");
obs.disambiguate([route1, route2]);
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

| Feature              | Declarative (Constructor)            | Fluent (Methods)               |
| -------------------- | ------------------------------------ | ------------------------------ |
| **Terms**            | `terms: Term[]`                      | `agent.createTerm(...)`        |
| **Guidelines**       | `guidelines: Guideline[]`            | `agent.createGuideline(...)`   |
| **Capabilities**     | `capabilities: Capability[]`         | `agent.createCapability(...)`  |
| **Routes**           | `routes: RouteOptions[]`             | `agent.createRoute(...)`       |
| **Route Guidelines** | `route.guidelines: Guideline[]`      | `route.createGuideline(...)`   |
| **Observations**     | `observations: ObservationOptions[]` | `agent.createObservation(...)` |
| **Disambiguation**   | `routeRefs: string[]`                | `obs.disambiguate([...])`      |

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
  observations?: ObservationOptions[]  // Can reference routes by title
});
```

**Made with ❤️ for the community**
