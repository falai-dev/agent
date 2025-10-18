# Getting Started

Complete guide to building your first AI agent with `@falai/agent`.

---

## Installation

```bash
# Using bun (recommended)
bun add @falai/agent

# Using npm
npm install @falai/agent

# Using yarn
yarn add @falai/agent
```

**Requirements:** Node.js 18+ or Bun 1.0+

---

## Your First Agent (5 minutes)

### 1. Set Up Your Environment

```bash
# Create a new project
mkdir my-agent && cd my-agent
bun init -y

# Install dependencies
bun add @falai/agent

# Set your API key
echo "GEMINI_API_KEY=your_key_here" > .env
```

### 2. Create Your Agent

Create `index.ts`:

```typescript
import {
  Agent,
  GeminiProvider,
  createMessageEvent,
  EventSource,
  createSession,
} from "@falai/agent";

// Define your data extraction type
interface FlightData {
  destination: string;
  departureDate: string;
  passengers: number;
  cabinClass: "economy" | "business" | "first";
}

// Define your context type
interface MyContext {
  userId: string;
  userName: string;
}

// Create AI provider
const provider = new GeminiProvider({
  apiKey: process.env.GEMINI_API_KEY!,
  model: "models/gemini-2.5-pro",
});

// Create your agent
const agent = new Agent<MyContext>({
  name: "FlightBot",
  description: "A helpful flight booking assistant",
  provider,
  context: {
    userId: "user_123",
    userName: "Alice",
  },
});

// Create a data-driven route
const bookingRoute = agent.createRoute<FlightData>({
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
});

// Initialize session step
let session = createSession<FlightData>();

// Generate a response with session step
const response = await agent.respond({
  history: [
    createMessageEvent(
      EventSource.CUSTOMER,
      "Alice",
      "I want to fly to Paris tomorrow with 2 people"
    ),
  ],
  session,
});

console.log("Agent:", response.message);
console.log("Data:", response.session?.data);
```

### 3. Run It!

```bash
bun run index.ts
```

🎉 **That's it!** You've created your first AI agent.

---

## Next Steps

### Add Session Step Management

Continue the conversation with collected data:

```typescript
// Turn 2 - User provides more details
const response2 = await agent.respond({
  history: [
    createMessageEvent(EventSource.AI_AGENT, "Bot", response.message),
    createMessageEvent(EventSource.CUSTOMER, "Alice", "Make it business class"),
  ],
  session: response.session, // Pass previous session step
});

console.log("Agent:", response2.message);
console.log("Updated data:", response2.session?.data);
// Agent remembers destination and passengers, updates cabin class
```

### Create Tools with Data Access

Tools can access and modify collected data:

```typescript
import { defineTool } from "@falai/agent";

const searchFlights = defineTool<MyContext, [], void, FlightData>(
  "search_flights",
  async ({ context, data }) => {
    // Access collected data directly
    if (!data.destination || !data.departureDate) {
      return { data: undefined };
    }

    // Search for flights and enrich collected data
    const flights = await searchFlightAPI(data.destination, data.departureDate);

    return {
      data: undefined,
      contextUpdate: { availableFlights: flights },
      dataUpdate: {
        destinationCode: await lookupAirportCode(data.destination),
      },
    };
  },
  { description: "Search for available flights based on collected data" }
);

// Add tool to step machine
const searchStep = bookingRoute.initialStep
  .nextStep({
    prompt: "Extract travel details",
    collect: ["destination", "departureDate", "passengers"],
  })
  .nextStep({
    tool: searchFlights,
    requires: ["destination", "departureDate", "passengers"],
  });
```

### Build Smart Step Machines

Create intelligent flows with code-based logic:

```typescript
// Step machine with smart bypassing and data validation
const askDestination = bookingRoute.initialStep.nextStep({
  prompt: "Ask where they want to fly",
  collect: ["destination"],
  skipIf: (data) => !!data.destination, // Skip if already have destination
});

const enrichDestination = askDestination.nextStep({
  tool: searchFlights, // Tool executes automatically
  requires: ["destination"], // Prerequisites
});

const askDates = enrichDestination.nextStep({
  prompt: "Ask about travel dates",
  collect: ["departureDate"],
  skipIf: (data) => !!data.departureDate,
  requires: ["destination"], // Must have destination first
});

const askPassengers = askDates.nextStep({
  prompt: "How many passengers?",
  collect: ["passengers"],
  skipIf: (data) => !!data.passengers,
});

const presentFlights = askPassengers.nextStep({
  prompt: "Present available flights from search results",
});
```

### Handle Context Dynamically

Override context per request:

```typescript
const response = await agent.respond({
  history,
  contextOverride: {
    userName: "Bob", // Temporarily change user
  },
});
```

---

## Common Patterns

### Declarative Configuration

Load everything from config:

```typescript
const agent = new Agent({
  name: "ConfiguredBot",
  provider: provider,
  terms: loadTermsFromFile(),
  guidelines: loadGuidelinesFromDB(),
  routes: [
    {
      title: "Support",
      conditions: ["User needs support"],
      guidelines: [
        { condition: "Issue is urgent", action: "Escalate immediately" },
      ],
    },
  ],
});
```

### Conditional Guidelines

Add guidelines based on runtime conditions:

```typescript
if (user.isPremium) {
  agent.createGuideline({
    condition: "User asks about premium features",
    action: "Provide detailed premium feature explanations",
    tags: ["premium"],
  });
}
```

### Multi-Turn Conversations with Session Step

Track conversation progress and collected data:

```typescript
import { createSession, enterRoute, mergeData } from "@falai/agent";

// Initialize session
let session = createSession<FlightData>();

// Turn 1 - User starts booking
const history1 = [
  createMessageEvent(
    EventSource.CUSTOMER,
    "User",
    "I want to fly to Paris tomorrow with 2 people"
  ),
];

const response1 = await agent.respond({ history: history1, session });
console.log("Turn 1 - Data:", response1.session?.data);
// { destination: "Paris", departureDate: "tomorrow", passengers: 2 }

session = response1.session!; // Update session with collected data

// Turn 2 - User changes their mind
const history2 = [
  ...history1,
  createMessageEvent(EventSource.AI_AGENT, "Bot", response1.message),
  createMessageEvent(
    EventSource.CUSTOMER,
    "User",
    "Actually, make that Tokyo instead"
  ),
];

const response2 = await agent.respond({ history: history2, session });
console.log("Turn 2 - Updated:", response2.session?.data);
// { destination: "Tokyo", departureDate: "tomorrow", passengers: 2 }

session = response2.session!; // Router handled the route change

// Turn 3 - Continue with updated data
const response3 = await agent.respond({
  history: [
    ...history2,
    createMessageEvent(EventSource.AI_AGENT, "Bot", response2.message),
    createMessageEvent(EventSource.CUSTOMER, "User", "Business class please"),
  ],
  session,
});
console.log("Turn 3 - Final:", response3.session?.data);
// { destination: "Tokyo", departureDate: "tomorrow", passengers: 2, cabinClass: "business" }
```

---

## Best Practices

### ✅ Do's

- **Use TypeScript** - Full type safety and IntelliSense throughout
- **Define extraction schemas** - Use JSON Schema for reliable data collection
- **Leverage session step** - Track conversation progress across turns
- **Use code-based logic** - `skipIf` and `requires` for deterministic flow
- **Create type-safe routes** - Generic types for both context and collected data
- **Handle user changes** - Always-on routing respects "I changed my mind"
- **Add lifecycle hooks** - Validate and enrich collected data
- **Mix stepful & stepless** - Use appropriate patterns for each use case

### ❌ Don'ts

- **Don't use `any` types** - Define proper interfaces for context and collected data
- **Don't rely on LLM conditions** - Use code (`skipIf`) for step logic
- **Don't skip session management** - Pass session step between turns
- **Don't forget error handling** - Wrap agent calls in try/catch
- **Don't ignore type errors** - Fix TypeScript issues for reliability
- **Don't create fuzzy logic** - Use explicit schemas over prompt-based parsing
- **Don't forget API keys** - Set environment variables properly

---

## Troubleshooting

### "Cannot find module '@falai/agent'"

Make sure you've installed the package:

```bash
bun add @falai/agent
```

### "API Key not found"

Set your environment variable:

```bash
export GEMINI_API_KEY="your_key_here"
```

### TypeScript Errors

Ensure your `tsconfig.json` has:

```json
{
  "compilerOptions": {
    "moduleResolution": "bundler",
    "esModuleInterop": true,
    "strict": true
  }
}
```

### AI Response Timeout

Increase timeout in provider config:

```typescript
new GeminiProvider({
  apiKey: "...",
  model: "models/gemini-2.5-flash",
  retryConfig: {
    timeout: 120000, // 2 minutes
    retries: 5,
  },
});
```

---

## What's Next?

- 📚 Read the [Agent Guide](./AGENT.md)
- 🔍 Check the [API Reference](./API_REFERENCE.md)
- 🏗️ Understand the [Architecture](./ARCHITECTURE.md)
- 🎯 Explore [Examples](../examples/)

---

**Made with ❤️ for the community**
