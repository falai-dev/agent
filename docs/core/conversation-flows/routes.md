# Routes

Routes define conversational journeys in @falai/agent with agent-level data collection. This document covers route definition with required fields, lifecycle management, and completion handling based on data availability.

## Overview

Routes represent complete conversational workflows that guide users through specific tasks or processes. Each route specifies required fields for completion, consists of steps that collect data into the agent-level schema, and can complete when their data requirements are satisfied regardless of which route collected the data.

## Route Definition with Required Fields

```typescript
// Agent defines comprehensive schema
interface HotelData {
  destination: string;
  checkIn: string;
  checkOut: string;
  guests: number;
  roomType?: string;
  customerName?: string;
  email?: string;
  phone?: string;
  specialRequests?: string;
}

const agent = new Agent<{}, HotelData>({
  name: "Hotel Booking Agent",
  schema: {
    type: "object",
    properties: {
      destination: { type: "string" },
      checkIn: { type: "string", format: "date" },
      checkOut: { type: "string", format: "date" },
      guests: { type: "number", minimum: 1 },
      roomType: { type: "string" },
      customerName: { type: "string" },
      email: { type: "string", format: "email" },
      phone: { type: "string" },
      specialRequests: { type: "string" }
    }
  }
});

// Routes specify required fields instead of schemas
const bookingRoute = agent.createRoute({
  title: "Hotel Booking",
  description: "Help users book hotel accommodations",
  conditions: ["User wants to book a hotel"],
  requiredFields: ["destination", "checkIn", "checkOut", "guests", "customerName", "email"],
  optionalFields: ["roomType", "phone", "specialRequests"]
});

const customerServiceRoute = agent.createRoute({
  title: "Customer Service",
  description: "Help with booking issues",
  conditions: ["User needs help with existing booking"],
  requiredFields: ["customerName", "email"], // Minimal requirements
  optionalFields: ["phone", "destination"]
});
```

## Route Lifecycle

Routes have a complete lifecycle from creation through execution to completion based on data availability.

### Route Creation

Routes are created using the agent's `createRoute()` method with required fields specifications that reference the agent-level schema.

### Route Execution

Routes are selected by the AI routing system based on user intent and conversation context, with access to all agent-level data.

### Route Completion

Routes complete when all their required fields are present in the agent's collected data, regardless of which route collected the data. This enables flexible cross-route completion scenarios.

```typescript
// Route completion evaluation
const isComplete = bookingRoute.isComplete(agent.getCollectedData());
const missingFields = bookingRoute.getMissingRequiredFields(agent.getCollectedData());
const progress = bookingRoute.getCompletionProgress(agent.getCollectedData()); // 0-1

console.log(`Booking route is ${Math.round(progress * 100)}% complete`);
if (missingFields.length > 0) {
  console.log(`Still need: ${missingFields.join(', ')}`);
}
```

## Route Transitions

Routes can automatically transition to other routes upon completion using the `onComplete` configuration. With agent-level data, the target route may already have some of its required data.

```typescript
const bookingRoute = agent.createRoute({
  title: "Hotel Booking",
  requiredFields: ["destination", "checkIn", "checkOut", "guests", "customerName", "email"],
  onComplete: "Feedback Collection", // Transition to feedback route
});

const feedbackRoute = agent.createRoute({
  title: "Feedback Collection",
  requiredFields: ["customerName", "email", "rating"], // Already has name and email from booking
  optionalFields: ["comments"]
});

// When booking completes, feedback route is already 2/3 complete
```

## Best Practices

- Use descriptive titles and conditions for better AI routing
- Define comprehensive agent-level schemas for type safety across all routes
- Specify minimal required fields for faster route completion
- Use optional fields to enhance user experience without blocking completion
- Implement appropriate completion handlers that leverage shared data
- Consider route transitions for multi-step workflows with data continuity
- Design routes that can benefit from cross-route data sharing
