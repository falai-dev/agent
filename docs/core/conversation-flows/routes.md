# Routes

Routes define conversational journeys in @falai/agent. This document covers route definition, lifecycle management, and completion handling.

## Overview

Routes represent complete conversational workflows that guide users through specific tasks or processes. Each route consists of steps, data collection schemas, and lifecycle hooks.

## Route Definition

```typescript
const bookingRoute = agent.createRoute<BookingData>({
  title: "Hotel Booking",
  description: "Help users book hotel accommodations",
  conditions: ["User wants to book a hotel"],
  schema: {
    type: "object",
    properties: {
      destination: { type: "string" },
      checkIn: { type: "string", format: "date" },
      checkOut: { type: "string", format: "date" },
      guests: { type: "number", minimum: 1 },
    },
    required: ["destination", "checkIn", "checkOut"],
  },
});
```

## Route Lifecycle

Routes have a complete lifecycle from creation through execution to completion.

### Route Creation

Routes are created using the agent's `createRoute()` method with type-safe data schemas.

### Route Execution

Routes are selected by the AI routing system based on user intent and conversation context.

### Route Completion

Routes complete when they reach the `END_ROUTE` step, triggering completion handlers and potential transitions.

## Route Transitions

Routes can automatically transition to other routes upon completion using the `onComplete` configuration.

```typescript
const bookingRoute = agent.createRoute({
  title: "Hotel Booking",
  onComplete: "Feedback Collection", // Transition to feedback route
});
```

## Best Practices

- Use descriptive titles and conditions for better AI routing
- Define comprehensive schemas for type safety
- Implement appropriate completion handlers
- Consider route transitions for multi-step workflows
