# Steps

Steps are the building blocks of conversational routes in @falai/agent with agent-level data collection. This document covers step configuration, data collection into the agent schema, and transition logic based on agent data.

## Overview

Steps represent individual moments in a conversation where the agent can:

- Prompt the user for information
- Collect structured data into the agent-level schema
- Execute tools that work with complete agent data
- Make decisions about conversation flow based on agent data
- Skip execution if required data is already available from other routes

## Step Configuration

```typescript
const nameStep = bookingRoute.initialStep.nextStep({
  prompt: "What's your name?",
  collect: ["customerName"], // Collects into agent-level schema
  requires: [], // No prerequisites
  skipIf: (data) => data.customerName, // Skip if already collected by any route
});
```

## Step Types

### Initial Steps

The entry point for a route, executed when the route is first activated.

### Sequential Steps

Steps that follow each other in a linear progression using `nextStep()`.

### Branching Steps

Steps that can lead to multiple paths using `branch()` with conditional logic.

### Terminal Steps

Steps that end the route using `END_ROUTE`.

## Data Collection

Steps collect data through the `collect` array, which maps to the agent's JSON schema and is validated against it.

```typescript
const contactStep = nameStep.nextStep({
  prompt: "What's your email and phone number?",
  collect: ["email", "phone"], // Maps to agent schema fields
  requires: ["customerName"], // Must have name first (from agent data)
});
```

## Conditional Logic

Steps support various conditional behaviors based on agent-level data:

- `skipIf`: Skip the step if a condition is met (evaluates against complete agent data)
- `requires`: Prerequisites that must be satisfied (checks agent data from any route)
- `when`: AI-evaluated conditions for branching

## Tool Integration

Steps can execute tools that work with complete agent-level data:

```typescript
const weatherStep = planningStep.nextStep({
  prompt: "I'll check the weather for your destination",
  tool: weatherLookupTool, // Tool receives complete agent data
  requires: ["destination", "checkIn"], // Prerequisites from agent data
});

// Tool implementation with agent data access
const weatherLookupTool: Tool<Context, [], WeatherData, HotelData> = {
  id: "weather_lookup",
  description: "Look up weather for destination",
  parameters: { type: "object", properties: {} },
  handler: async (toolContext) => {
    const { data } = toolContext; // Complete agent data
    
    if (!data.destination || !data.checkIn) {
      return { data: undefined };
    }
    
    const weather = await getWeather(data.destination, data.checkIn);
    
    return {
      data: weather,
      dataUpdate: {
        weatherInfo: weather.summary // Update agent data
      }
    };
  }
};
```

## Step Transitions

Steps define what happens next through transitions:

```typescript
// Simple next step
step.nextStep({
  /* next step config */
});

// Branching paths
step.branch([
  {
    name: "optionA",
    step: {
      /* config */
    },
  },
  {
    name: "optionB",
    step: {
      /* config */
    },
  },
]);

// End route
finalStep.nextStep({ step: END_ROUTE });
```

## Lifecycle Hooks

Steps support `prepare` and `finalize` hooks for setup and cleanup:

```typescript
const dataStep = previousStep.nextStep({
  prompt: "Collecting your information...",
  collect: ["userData"],
  prepare: async (context, data) => {
    // Setup before AI response
    console.log("Preparing data collection");
  },
  finalize: async (context, data) => {
    // Cleanup after AI response
    await saveProgress(data);
  },
});
```

## Best Practices

- Keep step prompts clear and focused
- Use appropriate `requires` and `skipIf` conditions
- Leverage schema validation for data integrity
- Implement error handling in lifecycle hooks
- Consider user experience in step sequencing
