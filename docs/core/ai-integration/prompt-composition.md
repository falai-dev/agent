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
- Collected data (with privacy filtering)
- Route progress and completion status

## Dynamic Schema Generation

For data collection steps, the prompt includes JSON schemas:

```typescript
// Route schema
schema: {
  type: "object",
  properties: {
    destination: { type: "string" },
    departureDate: { type: "string", format: "date" },
    passengers: { type: "number", minimum: 1 }
  },
  required: ["destination", "departureDate"]
}
```

Generates:

```
Extract the following information from the user's response:
- destination: string - Where the user wants to fly
- departureDate: string (date format) - When they want to depart
- passengers: number (minimum 1) - How many people are traveling

Return extracted data as valid JSON matching this schema.
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
