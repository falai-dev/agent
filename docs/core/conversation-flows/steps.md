# Steps

Steps are the building blocks of conversational routes in @falai/agent. This document covers step configuration, data collection, and transition logic.

## Overview

Steps represent individual moments in a conversation where the agent can:

- Prompt the user for information
- Collect structured data from responses
- Execute tools or perform actions
- Make decisions about conversation flow

## Step Configuration

```typescript
const nameStep = bookingRoute.initialStep.nextStep({
  prompt: "What's your name?",
  collect: ["firstName", "lastName"],
  requires: [], // No prerequisites
  skipIf: (data) => data.firstName && data.lastName, // Skip if already collected
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

Steps collect data through the `collect` array, which maps to the route's JSON schema.

```typescript
const contactStep = nameStep.nextStep({
  prompt: "What's your email and phone number?",
  collect: ["email", "phone"],
  requires: ["firstName"], // Must have name first
});
```

## Conditional Logic

Steps support various conditional behaviors:

- `skipIf`: Skip the step if a condition is met
- `requires`: Prerequisites that must be satisfied
- `when`: AI-evaluated conditions for branching

## Tool Integration

Steps can execute tools before generating AI responses:

```typescript
const weatherStep = planningStep.nextStep({
  prompt: "I'll check the weather for your destination",
  tool: weatherLookupTool,
  requires: ["destination", "travelDate"],
});
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
