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

## Multi-Step Batch Execution

Steps can execute together in a single LLM call when their data requirements are already satisfied. This reduces unnecessary back-and-forth and minimizes LLM costs.

### How Steps Are Batched

The execution engine walks through Steps sequentially and includes them in a batch until encountering a Step that needs user input:

```typescript
// Route with 3 steps
const route = agent.createRoute({
  title: "Booking",
  requiredFields: ["hotel", "date", "guests"],
  initialStep: {
    prompt: "Which hotel?",
    collect: ["hotel"],
    skipIf: (data) => !!data.hotel,
  },
});

const askDate = route.initialStep.nextStep({
  prompt: "What date?",
  collect: ["date"],
  skipIf: (data) => !!data.date,
});

const askGuests = askDate.nextStep({
  prompt: "How many guests?",
  collect: ["guests"],
  skipIf: (data) => data.guests !== undefined,
});
```

When a user says "Book Grand Hotel for 2 people on Friday":
1. Pre-extraction captures: `{ hotel: "Grand Hotel", date: "Friday", guests: 2 }`
2. All steps have their data satisfied (skipIf evaluates to true)
3. Route completes in a single LLM call

### The `requires` Field in Batch Context

The `requires` field specifies data prerequisites that must be present before a Step can execute:

```typescript
const confirmStep = askGuests.nextStep({
  prompt: "Confirm booking for {{guests}} guests at {{hotel}} on {{date}}?",
  requires: ["hotel", "date", "guests"], // All must be present
  collect: ["confirmed"],
});
```

**Batch behavior:**
- If any `requires` field is missing from session data (after pre-extraction), the Step **needs input**
- The batch stops at this Step, and the LLM generates a response to collect the missing data

### The `collect` Field in Batch Context

The `collect` field specifies which data fields the Step should extract from the conversation:

```typescript
const contactStep = {
  prompt: "What's your email and phone?",
  collect: ["email", "phone"], // Extract both from response
};
```

**Batch behavior:**
- If a Step has `collect` fields and **none** of those fields have data in the session, the Step **needs input**
- If **any** collect field already has data, the Step doesn't need input and can be included in the batch

### SkipIf Evaluation During Batch Determination

The `skipIf` condition is evaluated for each Step during batch determination:

```typescript
const premiumStep = {
  prompt: "Would you like premium features?",
  collect: ["wantsPremium"],
  skipIf: (data) => data.userTier === "free", // Skip for free users
};
```

**Evaluation rules:**
1. If `skipIf` evaluates to `true` → Step is skipped, continue to next Step
2. If `skipIf` evaluates to `false` → Step is evaluated for needs-input
3. If `skipIf` throws an error → Step is treated as non-skippable (safer to execute than skip)

### Batch Execution Example

```typescript
// User provides partial info
const response1 = await agent.respond("I want to book the Grand Hotel");

// Response shows which steps executed
console.log(response1.executedSteps);
// [{ id: "ask-hotel", routeId: "booking" }]

console.log(response1.stoppedReason);
// "needs_input" - stopped at ask-date step

// User provides remaining info
const response2 = await agent.respond("2 people on Friday");

console.log(response2.executedSteps);
// [{ id: "ask-date", routeId: "booking" }, { id: "ask-guests", routeId: "booking" }]

console.log(response2.stoppedReason);
// "route_complete"
```

## Best Practices

- Keep step prompts clear and focused
- Use appropriate `requires` and `skipIf` conditions
- Leverage schema validation for data integrity
- Implement error handling in lifecycle hooks
- Consider user experience in step sequencing
- Design steps to maximize batching by using `skipIf` conditions
- Use `requires` to enforce data dependencies between steps
- Keep `collect` fields focused on what each step actually needs
