# Routes Guide

A complete guide to creating and managing conversational routes in `@falai/agent`.

---

## Table of Contents

- [What is a Route?](#what-is-a-route)
- [Creating Routes](#creating-routes)
- [Initial State Configuration](#initial-state-configuration)
- [Data Extraction](#data-extraction)
- [Sequential Steps](#sequential-steps)
- [Route Properties](#route-properties)
- [Route Security](#route-security)
- [Advanced Patterns](#advanced-patterns)

---

## What is a Route?

A **Route** (also called a "Journey") represents a specific conversational flow in your agent. Think of it as a state machine that guides the conversation through a series of steps to accomplish a specific goal.

```typescript
// Example: A route for booking flights
const bookingRoute = agent.createRoute<FlightData>({
  title: "Book Flight",
  description: "Help user book a flight",
  conditions: ["User wants to book a flight"],
});
```

**Key Concepts:**

- Each route has a **goal** (e.g., "book a flight", "answer FAQ", "collect feedback")
- Routes contain **states** that represent conversation steps
- Routes can extract and track **typed data** throughout the conversation
- Routes have their own **rules**, **prohibitions**, and **guidelines**

---

## Creating Routes

### Basic Route

```typescript
interface FlightData {
  destination: string;
  departureDate: string;
  passengers: number;
}

const bookingRoute = agent.createRoute<FlightData>({
  title: "Book Flight",
  description: "Help user book a flight",
  conditions: [
    "User wants to book a flight",
    "User mentions flying or traveling",
  ],
});
```

### Route with Data Extraction Schema

```typescript
const bookingRoute = agent.createRoute<FlightData>({
  title: "Book Flight",
  description: "Help user book a flight",
  conditions: ["User wants to book a flight"],

  // Define what data to extract
  extractionSchema: {
    type: "object",
    properties: {
      destination: {
        type: "string",
        description: "Where the user wants to fly",
      },
      departureDate: {
        type: "string",
        description: "When they want to depart",
      },
      passengers: {
        type: "number",
        minimum: 1,
        maximum: 9,
      },
    },
    required: ["destination", "departureDate", "passengers"],
  },
});
```

### Route with Rules and Prohibitions

```typescript
const paymentRoute = agent.createRoute({
  title: "Process Payment",
  conditions: ["User wants to make a payment"],

  // Absolute rules the agent MUST follow
  rules: [
    "Always confirm the payment amount before processing",
    "Verify payment method is supported",
    "Provide a receipt after successful payment",
  ],

  // Things the agent must NEVER do
  prohibitions: [
    "Never store credit card numbers",
    "Never process payments without explicit confirmation",
    "Never share payment details with third parties",
  ],
});
```

---

## Initial State Configuration

Every route starts with an initial state. You can now configure it in two ways:

### Option 1: Configure at Route Creation

```typescript
const bookingRoute = agent.createRoute<FlightData>({
  title: "Book Flight",

  // Configure the initial state
  initialState: {
    id: "welcome_state",
    chatState:
      "Welcome! I'll help you book a flight. Where would you like to go?",
    gather: ["destination"],
    skipIf: (extracted) => !!extracted.destination,
  },

  extractionSchema: {
    // ... schema definition
  },
});
```

### Option 2: Configure After Route Creation

```typescript
const bookingRoute = agent.createRoute<FlightData>({
  title: "Book Flight",
  // ... other options
});

// Configure initial state later
bookingRoute.initialState.configure({
  description: "Welcome! Let's book your flight",
  gatherFields: ["destination"],
  skipIf: (extracted) => !!extracted.destination,
});
```

### Initial State Options

```typescript
initialState: {
  // Custom ID for the initial state
  id?: string;

  // Description/prompt for the initial state
  chatState?: string;

  // Fields to extract in this state
  gather?: string[];

  // Skip this state if condition is met
  skipIf?: (extracted: Partial<TExtracted>) => boolean;

  // Prerequisites that must be met
  requiredData?: string[];
}
```

---

## Data Extraction

### Defining Extraction Schema

The extraction schema defines what data your route will collect:

```typescript
const onboardingRoute = agent.createRoute<OnboardingData>({
  title: "User Onboarding",

  extractionSchema: {
    type: "object",
    properties: {
      firstName: { type: "string" },
      lastName: { type: "string" },
      email: { type: "string", format: "email" },
      company: { type: "string" },
      role: {
        type: "string",
        enum: ["developer", "designer", "manager", "other"],
      },
    },
    required: ["firstName", "lastName", "email"],
  },
});
```

### Getting Extracted Data

```typescript
// Get extracted data from the route
const extracted = bookingRoute.getExtractedData(session);

console.log(extracted);
// { destination: "Paris", departureDate: "2025-06-15", passengers: 2 }

// Only returns data if session is in this route
const otherRouteData = otherRoute.getExtractedData(session);
// {} - empty if session is in a different route
```

### Pre-populating Data

You can pre-populate data when entering a route:

```typescript
const bookingRoute = agent.createRoute<FlightData>({
  title: "Book Flight",

  // Pre-fill known information
  initialData: {
    destination: "Paris", // User mentioned this earlier
    passengers: 1, // Default value
  },

  extractionSchema: {
    // ... schema
  },
});

// States with skipIf will automatically bypass if data exists
```

---

## Sequential Steps

For simple linear flows, use the `steps` option:

```typescript
const feedbackRoute = agent.createRoute({
  title: "Collect Feedback",

  steps: [
    {
      id: "ask_rating",
      chatState: "How would you rate your experience? (1-5 stars)",
      gather: ["rating"],
    },
    {
      id: "ask_liked",
      chatState: "What did you like most?",
      gather: ["likedMost"],
    },
    {
      id: "ask_improve",
      chatState: "What could we improve?",
      gather: ["improvements"],
    },
    {
      id: "thank_you",
      chatState: "Thank you for your feedback! 🙏",
    },
  ],
});

// Automatically chains: initialState → ask_rating → ask_liked → ask_improve → thank_you → END_STATE
```

**When to use steps vs manual chaining:**

- ✅ Use `steps` for: Linear flows, simple wizards, sequential data collection
- ✅ Use manual chaining for: Branching logic, conditional flows, complex state machines

---

## Route Properties

### Accessing Route Properties

```typescript
const route = agent.createRoute({ ... });

// Route identification
console.log(route.id);          // "route_book_flight_abc123"
console.log(route.title);       // "Book Flight"
console.log(route.description); // "Help user book a flight"

// Activation conditions
console.log(route.conditions);  // ["User wants to book a flight"]

// Rules and guidelines
console.log(route.getRules());        // ["Always confirm...", ...]
console.log(route.getProhibitions()); // ["Never store...", ...]
console.log(route.getGuidelines());   // [{ condition: "...", action: "..." }]

// Domain restrictions
console.log(route.getDomains());      // ["payment", "booking"] or undefined
```

### Route Reference

```typescript
const routeRef = route.getRef();
console.log(routeRef); // { id: "route_book_flight_abc123" }

// Use reference to jump to specific routes
state.transitionTo({ state: routeRef });
```

### Route Structure

```typescript
// Get all states in the route
const states = route.getAllStates();
console.log(states); // [State, State, State, ...]

// Get specific state by ID
const state = route.getState("ask_destination");

// Describe route structure
console.log(route.describe());
// Output:
// Route: Book Flight
// ID: route_book_flight_abc123
// Description: Help user book a flight
// Conditions: User wants to book a flight
//
// States:
//   - initial_state: Initial state
//     -> ask_destination
//   - ask_destination: Ask where they want to fly
//     -> ask_dates
//   ...
```

---

## Route Security

### Domain Scoping

Restrict which tools/domains a route can access:

```typescript
// Define domains
agent.addDomain("payment", {
  processPayment: async (amount: number) => {
    /* ... */
  },
  refund: async (transactionId: string) => {
    /* ... */
  },
});

agent.addDomain("booking", {
  searchFlights: async (dest: string) => {
    /* ... */
  },
  createReservation: async (data: any) => {
    /* ... */
  },
});

agent.addDomain("database", {
  saveUser: async (user: any) => {
    /* ... */
  },
  deleteUser: async (userId: string) => {
    /* ... */
  },
});

// Payment route: only access payment tools
const paymentRoute = agent.createRoute({
  title: "Process Payment",
  domains: ["payment"], // ONLY payment domain
});

// Booking route: access booking AND payment
const bookingRoute = agent.createRoute({
  title: "Book Flight",
  domains: ["booking", "payment"], // Both domains
});

// Admin route: access everything
const adminRoute = agent.createRoute({
  title: "Admin Actions",
  // domains: undefined = all domains allowed
});
```

**Security Benefits:**

- ✅ Prevents accidental tool execution in wrong context
- ✅ Reduces attack surface for each route
- ✅ Makes permissions explicit and auditable

---

## Advanced Patterns

### Pattern 1: Branching Logic

```typescript
const supportRoute = agent.createRoute<SupportData>({
  title: "Customer Support",
});

// Ask issue type
const askIssueType = supportRoute.initialState.transitionTo({
  chatState: "What type of issue are you experiencing?",
  gather: ["issueType"],
});

// Branch 1: Technical issues
const technicalFlow = askIssueType.transitionTo({
  chatState: "Let me help with your technical issue...",
  condition: "Issue type is technical",
});

// Branch 2: Billing issues
const billingFlow = askIssueType.transitionTo({
  chatState: "Let me help with your billing issue...",
  condition: "Issue type is billing",
});

// Branch 3: General inquiries
const generalFlow = askIssueType.transitionTo({
  chatState: "Let me help with your inquiry...",
  condition: "Issue type is general",
});
```

### Pattern 2: Conditional Skip States

```typescript
const checkoutRoute = agent.createRoute<CheckoutData>({
  title: "Checkout",
  extractionSchema: {
    properties: {
      hasAccount: { type: "boolean" },
      email: { type: "string" },
      shippingAddress: { type: "object" },
      billingAddress: { type: "object" },
    },
  },
});

// Skip login if user already has account
const login = checkoutRoute.initialState.transitionTo({
  chatState: "Please log in or continue as guest",
  gather: ["hasAccount", "email"],
  skipIf: (extracted) => extracted.hasAccount === true,
});

// Skip billing address if same as shipping
const shippingAddress = login.transitionTo({
  chatState: "What's your shipping address?",
  gather: ["shippingAddress"],
});

const billingAddress = shippingAddress.transitionTo({
  chatState: "Is your billing address the same as shipping?",
  gather: ["billingAddress"],
  skipIf: (extracted) => extracted.billingAddress !== undefined,
});
```

### Pattern 3: Route-Specific Guidelines

```typescript
const bookingRoute = agent.createRoute({
  title: "Book Flight",
});

// Add guidelines specific to this route
bookingRoute.createGuideline({
  condition: "User asks about cancellation policy",
  action: "Explain that cancellations must be made 24 hours in advance",
  tags: ["policy"],
});

bookingRoute.createGuideline({
  condition: "User provides invalid date",
  action: "Politely ask for a valid future date in YYYY-MM-DD format",
  tags: ["validation"],
});
```

### Pattern 4: Tool Integration in Routes

```typescript
import { defineTool } from "@falai/agent";

const searchFlights = defineTool<MyContext, [], FlightResults>(
  "search_flights",
  async ({ context, extracted }) => {
    const flights = await api.searchFlights({
      destination: extracted.destination,
      date: extracted.departureDate,
    });

    return {
      data: flights,
      contextUpdate: { availableFlights: flights },
    };
  }
);

const bookingRoute = agent.createRoute<FlightData>({
  title: "Book Flight",
  domains: ["booking"], // Ensure tool is in this domain
});

// Gather data
const gatherDetails = bookingRoute.initialState.transitionTo({
  chatState: "Where and when would you like to fly?",
  gather: ["destination", "departureDate", "passengers"],
});

// Execute tool
const searchState = gatherDetails.transitionTo({
  toolState: searchFlights,
  requiredData: ["destination", "departureDate", "passengers"],
});

// Present results
const presentFlights = searchState.transitionTo({
  chatState: "Here are available flights based on your search",
});
```

---

## Route Completion

When a route reaches its final state and transitions to `END_STATE`, the agent returns `isRouteComplete: true` to signal that all required data has been collected.

### Ending a Route

Use the `END_STATE` symbol to mark the end of a route:

```typescript
import { END_STATE } from "@falai/agent";

const onboardingRoute = agent.createRoute<OnboardingData>({
  title: "User Onboarding",
  extractionSchema: ONBOARDING_SCHEMA,
});

const askName = onboardingRoute.initialState.transitionTo({
  chatState: "What's your name?",
  gather: ["name"],
});

const askEmail = askName.transitionTo({
  chatState: "What's your email?",
  gather: ["email"],
});

const thankYou = askEmail.transitionTo({
  chatState: "Thank you! Your profile is complete.",
});

// End the route
thankYou.transitionTo({ state: END_STATE });
```

### Handling Completion

There are **two ways** to check if a route has completed:

#### Method 1: Using `isRouteComplete` (Recommended)

```typescript
const response = await agent.respond({
  history,
  session,
});

if (response.isRouteComplete) {
  // ✅ Route is complete! All data has been collected

  // Get the collected data
  const data = agent.getExtractedData(response.session!);
  console.log("Collected data:", data);

  // Process the data
  await saveToDatabase(data);
  await sendConfirmationEmail(data.email);

  // Show custom completion message
  return "Thank you! Your information has been saved.";
} else {
  // ⏳ Route still in progress
  return response.message;
}
```

#### Method 2: Using `END_STATE_ID` Constant

For users who prefer a symbol-based pattern consistent with building routes:

```typescript
import { END_STATE_ID } from "@falai/agent";

const response = await agent.respond({
  history,
  session,
});

if (response.session?.currentState?.id === END_STATE_ID) {
  // ✅ Route completed - currentState is now END_STATE
  const data = agent.getExtractedData(response.session!);
  await handleCompletion(data);
  return "Complete!";
}

return response.message;
```

**Which method should you use?**

- ✅ **Use `isRouteComplete`** for simplicity and clarity
- ✅ **Use `END_STATE_ID`** if you want consistency with how you build routes (`END_STATE` symbol)

### Immediate Completion

Routes can complete **immediately** if all states are skipped due to `skipIf` conditions. This is useful when:

- Resuming a partially completed route
- Pre-filling data from an existing session
- User provides all information upfront

```typescript
const onboardingRoute = agent.createRoute<OnboardingData>({
  title: "User Onboarding",
  extractionSchema: ONBOARDING_SCHEMA,
  initialData: existingUserData, // Pre-fill with existing data
});

const askName = onboardingRoute.initialState.transitionTo({
  chatState: "What's your name?",
  gather: ["name"],
  skipIf: (data) => !!data.name, // Skip if name exists
});

const askEmail = askName.transitionTo({
  chatState: "What's your email?",
  gather: ["email"],
  skipIf: (data) => !!data.email, // Skip if email exists
});

const complete = askEmail.transitionTo({
  chatState: "All done!",
});

complete.transitionTo({ state: END_STATE });

// In your handler:
const response = await agent.respond({ history, session });

if (response.isRouteComplete) {
  // If existingUserData had all fields, route completes immediately!
  // The routing engine recursively skips all states and reaches END_STATE
  console.log("Profile already complete!");
}
```

### Important Notes

- **`isRouteComplete: true`** indicates the route has reached `END_STATE`
- **`currentState.id`** is set to `END_STATE_ID` when the route completes
- **`response.message`** will be empty (`""`) when route is complete
- **The routing engine** recursively traverses skipped states to detect completion
- **You can check either** `isRouteComplete` or `currentState.id === END_STATE_ID`
- **Session state** still contains all the collected data via `agent.getExtractedData()`
- **The route** (`currentRoute.id`) remains the completed route (e.g., "onboarding"), not END_STATE

### With Streaming

```typescript
for await (const chunk of agent.respondStream({ history, session })) {
  if (chunk.delta) {
    process.stdout.write(chunk.delta);
  }

  if (chunk.done && chunk.isRouteComplete) {
    console.log("\n🎉 Route completed!");
    const data = agent.getExtractedData(chunk.session!);
    await processCompletedData(data);
  }
}
```

---

## Best Practices

### ✅ Do's

- **Use descriptive titles and descriptions** - Makes routing more accurate
- **Define extraction schemas** - Type-safe data collection
- **Configure initial state** - Set up proper entry point
- **Use skipIf for known data** - Avoid redundant questions
- **Scope domains** - Limit tool access per route
- **Add route-specific guidelines** - Context-aware behavior
- **Use steps for linear flows** - Cleaner code for simple paths

### ❌ Don'ts

- **Don't use vague conditions** - Be specific about when to activate
- **Don't skip extraction schemas** - Loses type safety
- **Don't create overly complex routes** - Split into multiple routes
- **Don't forget requiredData** - Prevent states from executing too early
- **Don't mix concerns** - One route = one goal
- **Don't hardcode state IDs** - Let framework generate deterministic IDs

---

## See Also

- [States Guide](./STATES.md) - Deep dive into state management
- [API Reference - Route](./API_REFERENCE.md#route) - Complete API docs
- [Examples](../examples/) - Real-world route implementations
- [Architecture Guide](./ARCHITECTURE.md) - How routes fit in the system

---

**Made with ❤️ for the community**
