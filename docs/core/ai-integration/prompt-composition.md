# Prompt Composition

@fali/agent automatically builds comprehensive prompts for AI providers by combining agent configuration, route context, conversation history, and current session state.

## Overview

The `PromptComposer` class is responsible for constructing detailed prompts that provide AI models with all necessary context to make intelligent routing and response decisions.

## Prompt Structure

Prompts are built with multiple sections in a specific order:

1. **Agent Identity** - Core agent persona and personality
2. **Routing Overview** - Available routes and current context
3. **Knowledge Base** - Agent and route-specific knowledge
4. **Guidelines & Rules** - Behavioral constraints and preferences
5. **Conversation History** - Previous messages and context
6. **Current Session** - Active route, collected data, and step state
7. **Task-Specific Instructions** - Route-specific prompts and schemas

## Agent Identity Section

```typescript
// Agent configuration contributes to identity
const agent = new Agent({
  name: "TravelBot",
  description: "AI assistant for travel planning and booking",
  goal: "Help users plan perfect trips efficiently",
  personality: "Friendly, knowledgeable, and efficient",
});
```

This generates:

```
You are TravelBot, an AI assistant for travel planning and booking.
Your goal is to help users plan perfect trips efficiently.
You are friendly, knowledgeable, and efficient.
```

## Routing Overview Section

Provides the AI with information about available conversation routes:

```
Available Routes:
1. Flight Booking - Help users book flights
2. Hotel Reservation - Find and book accommodations
3. Travel Itinerary - Create detailed trip plans
4. Customer Support - Handle travel-related questions

Current Route: Flight Booking
Route Description: Help users book flights with the best options
```

## Knowledge Base Integration

Agent and route knowledge bases are formatted and included:

```typescript
const agent = new Agent({
  knowledgeBase: {
    company: "Acme Travel - Premium travel services since 1995",
    policies: {
      cancellation: "Free cancellation up to 24 hours before departure",
      refund: "Refunds processed within 3-5 business days",
    },
  },
});
```

## Guidelines & Rules Section

Combines agent-level and route-level behavioral constraints:

```
Guidelines:
- Always be polite and helpful
- Ask clarifying questions when needed
- Provide options rather than single recommendations

Rules for this route:
- Always confirm flight details before booking
- Never share personal information
- Use specific date formats (YYYY-MM-DD)
```

## Conversation History

Recent conversation history with context updates:

```
Previous Messages:
User: I want to book a flight to Paris
Assistant: I'd be happy to help you book a flight to Paris. When would you like to travel?

User: Next week, for 3 nights
Assistant: Great! Let me check flights for next week. Could you tell me which airport you'd like to depart from?
```

## Session State

Current session information including:

- Active route and step
- Agent-level collected data (with privacy filtering)
- Route progress and completion status
- Cross-route data availability

```
Current Session:
- Route: Flight Booking (2/3 required fields collected)
- Step: ask_passengers
- Agent Data: { destination: "Paris", departureDate: "2025-01-15" }
- Missing Required: passengers
- Available from other routes: { hotelPreference: "luxury" }
```

## Dynamic Schema Generation

For data collection steps, the prompt includes agent-level JSON schemas:

```typescript
// Agent-level schema
const agent = new Agent<{}, TravelData>({
  schema: {
    type: "object",
    properties: {
      destination: { type: "string" },
      departureDate: { type: "string", format: "date" },
      passengers: { type: "number", minimum: 1 },
      hotelPreference: { type: "string" },
      budgetRange: { type: "string" }
    },
    required: ["destination", "departureDate"]
  }
});

// Route specifies which fields to collect
const flightRoute = agent.createRoute({
  title: "Flight Booking",
  requiredFields: ["destination", "departureDate", "passengers"],
  optionalFields: ["budgetRange"]
});
```

Generates:

```
Extract the following information from the user's response based on the agent schema:
- destination: string - Where the user wants to fly
- departureDate: string (date format) - When they want to depart
- passengers: number (minimum 1) - How many people are traveling
- budgetRange: string (optional) - Budget preference for the trip

Return extracted data as valid JSON matching the agent schema.
Current route requires: destination, departureDate, passengers
Route completion: 2/3 required fields collected
```

## Tool Integration

When tools are available, they're described in the prompt:

```
Available Tools:
1. searchFlights - Search for available flights
   Parameters:
   - origin: string - Departure airport code
   - destination: string - Arrival airport code
   - date: string - Travel date (YYYY-MM-DD)

2. checkWeather - Get weather forecast
   Parameters:
   - location: string - City or airport code
   - date: string - Date for forecast
```

## Context Updates

Real-time context changes are included:

```
Current Context:
- User tier: premium
- Preferred language: English
- Last login: 2024-01-15
- Current location: New York
```

## Route-Specific Customization

Routes can override agent-level settings:

```typescript
const supportRoute = agent.createRoute({
  title: "Customer Support",
  personality: "Extra patient and detailed when explaining issues",
  knowledgeBase: {
    supportHours: "24/7 for premium members, 9-5 EST for others",
  },
});
```

## Performance Optimization

Prompts are optimized for token efficiency:

- Knowledge bases are formatted as clean markdown
- Redundant information is deduplicated
- Context is truncated when approaching token limits
- Only relevant route information is included

## Best Practices

- Keep knowledge bases structured and concise
- Use clear, specific guidelines rather than vague instructions
- Leverage route-specific overrides for specialized behavior
- Monitor token usage and optimize prompt length
- Test prompts with different AI providers for consistency

## BatchPromptBuilder for Multi-Step Execution

When multiple steps execute in a single batch, the `BatchPromptBuilder` combines their prompts into a single coherent prompt.

### Combined Prompt Structure

```
[Agent Identity & Personality]
[Route Context]

## Current Conversation Flow

You are handling multiple aspects of this conversation in a single response.

### Step 1: [Step Description]
[Step Prompt]

### Step 2: [Step Description]  
[Step Prompt]

[... additional steps ...]

## Data Collection

Extract the following information from your response:
- field1 (type): description
- field2 (type): description

## Response Format

Return JSON with:
- message: Your response to the user
- [collected fields as top-level properties]
```

### How Prompts Are Merged

The `BatchPromptBuilder` preserves each step's intent while creating a unified prompt:

```typescript
// Individual step prompts
const step1 = { prompt: "What's your name?", collect: ["name"] };
const step2 = { prompt: "What's your email?", collect: ["email"] };
const step3 = { prompt: "How can I help?", collect: ["request"] };

// Combined prompt includes all three
const result = await batchPromptBuilder.buildBatchPrompt({
  steps: [step1, step2, step3],
  route,
  history,
  context,
  session,
  agentOptions,
});

// result.prompt contains unified prompt
// result.collectFields = ["name", "email", "request"]
// result.stepCount = 3
```

### Collect Fields Aggregation

All `collect` fields from all steps are combined and deduplicated:

```typescript
// Steps with overlapping collect fields
const steps = [
  { collect: ["name", "email"] },
  { collect: ["email", "phone"] },  // email appears twice
  { collect: ["preferences"] }
];

// Combined collect fields (deduplicated)
// ["name", "email", "phone", "preferences"]
```

### Schema-Aware Field Descriptions

When the agent has a schema, field descriptions are included in the prompt:

```typescript
// Agent schema
const schema = {
  properties: {
    email: { type: "string", format: "email", description: "User's email address" },
    guests: { type: "number", minimum: 1, description: "Number of guests" }
  }
};

// Generated data collection section:
// ## Data Collection
// Extract the following information from your response:
// - email (string): User's email address
// - guests (number): Number of guests
```

### Single vs Multi-Step Prompts

The prompt structure adapts based on batch size:

```typescript
// Single step batch
// ## Current Step
// [Step prompt]

// Multi-step batch
// ## Current Conversation Flow
// You are handling multiple aspects of this conversation in a single response.
// ### Step 1: ...
// ### Step 2: ...
```

### Using BatchPromptBuilder

```typescript
import { BatchPromptBuilder } from "@falai/agent";

const builder = new BatchPromptBuilder<MyContext, MyData>();

const result = await builder.buildBatchPrompt({
  steps: batchResult.steps,
  route: currentRoute,
  history: conversationHistory,
  context: agentContext,
  session: currentSession,
  agentOptions: agent.getAgentOptions(),
});

// Use result.prompt for LLM call
const llmResponse = await provider.generateMessage({
  prompt: result.prompt,
  // ...
});
```
