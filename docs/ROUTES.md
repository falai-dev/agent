# Routes Guide

A complete guide to creating and managing conversational routes in `@falai/agent`.

---

## Table of Contents

- [What is a Route?](#what-is-a-route)
- [Creating Routes](#creating-routes)
- [Initial Step Configuration](#initial-step-configuration)
- [End Step Configuration](#end-step-configuration)
- [Data Extraction](#data-extraction)
- [Sequential Steps](#sequential-steps)
- [Route Properties](#route-properties)
- [Route Security](#route-security)
- [Advanced Patterns](#advanced-patterns)

---

## What is a Route?

A **Route** (also called a "Journey") represents a specific conversational flow in your agent. Think of it as a step machine that guides the conversation through a series of steps to accomplish a specific goal.

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
- Routes contain **steps** that represent conversation steps
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
  schema: {
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

### Route with Knowledge Base

Routes can have their own knowledge base containing any JSON structure the AI should know when following that route. Route knowledge bases are merged with agent knowledge bases (route takes precedence for conflicts).

```typescript
const bookingRoute = agent.createRoute<FlightData>({
  title: "Book Flight",
  conditions: ["User wants to book a flight"],

  // Route-specific knowledge base
  knowledgeBase: {
    bookingProcess: {
      steps: [
        "Collect travel details",
        "Check availability",
        "Present options",
        "Collect payment",
        "Send confirmation",
      ],
      cancellationPolicy: "Free cancellation up to 24 hours before departure",
      changeFee: "$50 for date changes",
    },
    airlinePartners: ["Delta", "American", "United"],
    peakSeason: {
      months: ["June", "July", "August", "December"],
      surcharge: "$50 extra for peak season flights",
    },
  },

  schema: {
    // ... schema definition
  },
});
```

**Knowledge Base Merging:**

- ✅ **Agent knowledge base** - Available to all routes
- ✅ **Route knowledge base** - Specific to this route only
- ✅ **Merged automatically** - Route knowledge takes precedence over agent knowledge for conflicts
- ✅ **Auto-formatted to markdown** - Readable for AI consumption

---

## Initial Step Configuration

Every route starts with an initial step. You can now configure it in two ways:

### Option 1: Configure at Route Creation

```typescript
const bookingRoute = agent.createRoute<FlightData>({
  title: "Book Flight",

  // Configure the initial step
  initialStep: {
    id: "welcome_step",
    prompt: "Welcome! I'll help you book a flight. Where would you like to go?",
    collect: ["destination"],
    skipIf: (data) => !!data.destination,
  },

  schema: {
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

// Configure initial step later
bookingRoute.initialStep.configure({
  description: "Welcome! Let's book your flight",
  collect: ["destination"],
  skipIf: (data) => !!data.destination,
});
```

### Initial Step Options

```typescript
initialStep: {
  // Custom ID for the initial step
  id?: string;

  // Description/prompt for the initial step
  prompt?: string;

  // Fields to extract in this step
  collect?: string[];

  // Skip this step if condition is met
  skipIf?: (data: Partial<TData>) => boolean;

  // Prerequisites that must be metw
  requires?: string[];
}
```

---

## End Step Configuration

Every route ends when it reaches `END_ROUTE`. You can configure what happens at route completion:

### Configure End Step at Route Creation

```typescript
import { END_ROUTE } from "@falai/agent";

const bookingRoute = agent.createRoute<FlightData>({
  title: "Book Flight",

  // Configure what happens when route completes
  endStep: {
    // Custom completion message
    prompt: "Confirm the booking details and thank the user warmly!",

    // Optional: Execute final actions (like sending confirmation emails)
    tool: sendConfirmationEmail,

    // Optional: Collect final data before completing
    collect: ["finalConfirmation"],

    // Optional: Require certain data to be present
    requires: ["destination", "departureDate"],

    // Optional: Custom step ID
    id: "booking_complete",
  },

  schema: {
    // ... schema definition
  },
});

// Then just transition to END_ROUTE
lastStep.nextStep({
  step: END_ROUTE,
});
```

### Per-Transition Override

You can also override the endStep configuration for specific transitions:

```typescript
// Use route-level endStep
lastStep.nextStep({
  step: END_ROUTE,
});

// OR override with custom prompt for this specific transition
lastStep.nextStep({
  prompt: "Special completion message for this path!",
  step: END_ROUTE,
});
```

### End Step Options

```typescript
endStep: {
  // Completion message instruction (RECOMMENDED)
  prompt?: string;

  // Execute final tools/actions before completion
  tool?: ToolRef;

  // Collect final data at completion
  collect?: string[];

  // Require specific data to be present
  requires?: string[];

  // Custom step ID for debugging
  id?: string;
}
```

### Default Behavior

If you don't configure `endStep`, a smart default is used:

```typescript
// Default endStep behavior:
{
  prompt: "Summarize what was accomplished and confirm completion based on the conversation history and collected data";
}
```

### End Step with Tools

Execute final actions when route completes:

```typescript
import { defineTool, END_ROUTE } from "@falai/agent";

const sendConfirmation = defineTool("send_confirmation", async ({ data }) => {
  await emailService.send({
    to: data.email,
    subject: "Booking Confirmed",
    body: `Your flight to ${data.destination} is confirmed!`,
  });
  return { data: "Confirmation sent" };
});

const bookingRoute = agent.createRoute({
  title: "Book Flight",

  endStep: {
    tool: sendConfirmation, // Executes when route completes
    prompt: "Your booking is complete! Confirmation email sent.",
  },
});
```

**Key Points:**

- ✅ `endStep` is configured once at the route level (DRY principle)
- ✅ Can be overridden per-transition if needed
- ✅ Supports full step capabilities: `prompt`, `tool`, `collect`, `requires`
- ✅ Falls back to smart default if not configured

---

## Data Extraction

### Defining Extraction Schema

The extraction schema defines what data your route will collect:

```typescript
const onboardingRoute = agent.createRoute<OnboardingData>({
  title: "User Onboarding",

  schema: {
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

### Getting Collected data

```typescript
// Get collected data from the route
const data = bookingRoute.getData(session);

console.log(data);
// { destination: "Paris", departureDate: "2025-06-15", passengers: 2 }

// Only returns data if session is in this route
const otherRouteData = otherRoute.getData(session);
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

  schema: {
    // ... schema
  },
});

// Steps with skipIf will automatically bypass if data exists
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
      prompt: "How would you rate your experience? (1-5 stars)",
      collect: ["rating"],
    },
    {
      id: "ask_liked",
      prompt: "What did you like most?",
      collect: ["likedMost"],
    },
    {
      id: "ask_improve",
      prompt: "What could we improve?",
      collect: ["improvements"],
    },
    {
      id: "thank_you",
      prompt: "Thank you for your feedback! 🙏",
    },
  ],
});

// Automatically chains: initialStep → ask_rating → ask_liked → ask_improve → thank_you → END_ROUTE
```

**When to use steps vs manual chaining:**

- ✅ Use `steps` for: Linear flows, simple wizards, sequential data collection
- ✅ Use manual chaining for: Branching logic, conditional flows, complex step machines

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

// Knowledge base
console.log(route.getKnowledgeBase()); // Route-specific knowledge base
```

### Route Reference

```typescript
const routeRef = route.getRef();
console.log(routeRef); // { id: "route_book_flight_abc123" }

// Use reference to jump to specific routes
step.nextStep({ step: routeRef });
```

### Route Structure

```typescript
// Get all steps in the route
const steps = route.getAllSteps();
console.log(steps); // [Step, Step, Step, ...]

// Get specific step by ID
const step = route.getStep("ask_destination");

// Describe route structure
console.log(route.describe());
// Output:
// Route: Book Flight
// ID: route_book_flight_abc123
// Description: Help user book a flight
// Conditions: User wants to book a flight
//
// Steps:
//   - initial_step: Initial step
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
const askIssueType = supportRoute.initialStep.nextStep({
  prompt: "What type of issue are you experiencing?",
  collect: ["issueType"],
});

// Branch 1: Technical issues
const technicalFlow = askIssueType.nextStep({
  prompt: "Let me help with your technical issue...",
  condition: "Issue type is technical",
});

// Branch 2: Billing issues
const billingFlow = askIssueType.nextStep({
  prompt: "Let me help with your billing issue...",
  condition: "Issue type is billing",
});

// Branch 3: General inquiries
const generalFlow = askIssueType.nextStep({
  prompt: "Let me help with your inquiry...",
  condition: "Issue type is general",
});
```

### Pattern 2: Conditional Skip Steps

```typescript
const checkoutRoute = agent.createRoute<CheckoutData>({
  title: "Checkout",
  schema: {
    properties: {
      hasAccount: { type: "boolean" },
      email: { type: "string" },
      shippingAddress: { type: "object" },
      billingAddress: { type: "object" },
    },
  },
});

// Skip login if user already has account
const login = checkoutRoute.initialStep.nextStep({
  prompt: "Please log in or continue as guest",
  collect: ["hasAccount", "email"],
  skipIf: (data) => data.hasAccount === true,
});

// Skip billing address if same as shipping
const shippingAddress = login.nextStep({
  prompt: "What's your shipping address?",
  collect: ["shippingAddress"],
});

const billingAddress = shippingAddress.nextStep({
  prompt: "Is your billing address the same as shipping?",
  collect: ["billingAddress"],
  skipIf: (data) => data.billingAddress !== undefined,
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
  async ({ context, data }) => {
    const flights = await api.searchFlights({
      destination: data.destination,
      date: data.departureDate,
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

// Collect data
const collectDetails = bookingRoute.initialStep.nextStep({
  prompt: "Where and when would you like to fly?",
  collect: ["destination", "departureDate", "passengers"],
});

// Execute tool
const searchStep = collectDetails.nextStep({
  tool: searchFlights,
  requires: ["destination", "departureDate", "passengers"],
});

// Present results
const presentFlights = searchStep.nextStep({
  prompt: "Here are available flights based on your search",
});
```

---

## Route Completion

When a route reaches its final step and transitions to `END_ROUTE`, the agent returns `isRouteComplete: true` to signal that all required data has been collected.

### Ending a Route

Use the `END_ROUTE` symbol to mark the end of a route:

```typescript
import { END_ROUTE } from "@falai/agent";

const onboardingRoute = agent.createRoute<OnboardingData>({
  title: "User Onboarding",
  schema: ONBOARDING_SCHEMA,
});

const askName = onboardingRoute.initialStep.nextStep({
  prompt: "What's your name?",
  collect: ["name"],
});

const askEmail = askName.nextStep({
  prompt: "What's your email?",
  collect: ["email"],
});

const thankYou = askEmail.nextStep({
  prompt: "Thank you! Your profile is complete.",
});

// End the route
thankYou.nextStep({ step: END_ROUTE });
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
  const data = agent.getData(response.session!);
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

#### Method 2: Using `END_ROUTE_ID` Constant

For users who prefer a symbol-based pattern consistent with building routes:

```typescript
import { END_ROUTE_ID } from "@falai/agent";

const response = await agent.respond({
  history,
  session,
});

if (response.session?.currentStep?.id === END_ROUTE_ID) {
  // ✅ Route completed - currentStep is now END_ROUTE
  const data = agent.getData(response.session!);
  await handleCompletion(data);
  return "Complete!";
}

return response.message;
```

**Which method should you use?**

- ✅ **Use `isRouteComplete`** for simplicity and clarity
- ✅ **Use `END_ROUTE_ID`** if you want consistency with how you build routes (`END_ROUTE` symbol)

---

## Route Transitions with `onComplete`

**NEW:** You can now automatically transition to another route when a route completes using the `onComplete` option. This is perfect for chaining workflows like:

- 📋 Post-booking feedback collection
- 🎁 Upsell offers after purchase
- 📊 Satisfaction surveys after support
- ↩️ Error recovery flows

### Simple String Transition

The simplest form - just specify the target route ID or title:

```typescript
const bookingRoute = agent.createRoute<BookingData>({
  title: "Book Hotel",
  conditions: ["User wants to book a hotel"],
  schema: BOOKING_SCHEMA,
  // Automatically transition to feedback when booking completes
  onComplete: "Collect Feedback",
});

const feedbackRoute = agent.createRoute<FeedbackData>({
  title: "Collect Feedback",
  conditions: ["Collect user feedback"],
  schema: FEEDBACK_SCHEMA,
});
```

### With AI-Evaluated Condition

Add an optional condition that the AI evaluates to determine if transition should happen:

```typescript
const bookingRoute = agent.createRoute<BookingData>({
  title: "Book Hotel",
  schema: BOOKING_SCHEMA,
  onComplete: {
    nextStep: "Collect Feedback",
    condition: "if booking was successful", // AI evaluates this
  },
});
```

### Dynamic Function-Based Transition

Use a function for complex logic based on collected data or context:

```typescript
const bookingRoute = agent.createRoute<BookingData>({
  title: "Book Hotel",
  schema: BOOKING_SCHEMA,
  // Function receives session and context
  onComplete: (session, context) => {
    // Conditional logic based on collected data
    if (session.data?.guests && session.data.guests > 5) {
      return "VIP Feedback"; // Large groups get VIP treatment
    }
    if (session.data?.bookingFailed) {
      return "Error Recovery"; // Handle failures gracefully
    }
    return "Collect Feedback"; // Standard feedback flow
  },
});
```

Function can also return a config object:

```typescript
onComplete: (session) => ({
  nextStep: "Collect Feedback",
  condition: session.data?.vip ? "if user is satisfied" : undefined,
});
```

### How It Works

1. **Route completes** → reaches `END_ROUTE`
2. **Agent evaluates** `onComplete` handler
3. **Sets pending transition** in session step
4. **Next `respond()` call** → automatically transitions to target route
5. **User sees seamless flow** → no interruption in conversation

```typescript
// User books hotel
const response1 = await agent.respond({ history, session });
console.log(response1.isRouteComplete); // true
console.log(response1.session?.pendingTransition); // { targetRouteId: "...", reason: "route_complete" }

// Next message automatically transitions to feedback route
history.push(createMessageEvent(EventSource.CUSTOMER, "User", "Yes!"));
const response2 = await agent.respond({ history, session: response1.session });
console.log(response2.session?.currentRoute?.title); // "Collect Feedback"
```

### Manual Transition Control

For more control, use `agent.nextStepRoute()` to manually set the transition:

```typescript
const response = await agent.respond({ history, session });

if (response.isRouteComplete && shouldCollectFeedback) {
  // Manually trigger transition instead of onComplete
  const updatedSession = await agent.nextStepRoute(
    "Collect Feedback",
    response.session
  );

  // Next respond() will transition automatically
  const nextResponse = await agent.respond({
    history,
    session: updatedSession,
  });
}
```

### Complete Example

```typescript
interface BookingData {
  hotelName: string;
  date: string;
  guests: number;
}

interface FeedbackData {
  rating: number;
  comments?: string;
}

// Booking route with automatic transition to feedback
const bookingRoute = agent.createRoute<BookingData>({
  title: "Book Hotel",
  conditions: ["User wants to book a hotel"],
  schema: {
    type: "object",
    properties: {
      hotelName: { type: "string" },
      date: { type: "string" },
      guests: { type: "number" },
    },
    required: ["hotelName", "date", "guests"],
  },
  onComplete: "Collect Feedback",
});

const askHotel = bookingRoute.initialStep.nextStep({
  prompt: "Ask which hotel",
  collect: ["hotelName"],
  skipIf: (e) => !!e.hotelName,
});

const askDate = askHotel.nextStep({
  prompt: "Ask for date",
  collect: ["date"],
  skipIf: (e) => !!e.date,
});

const askGuests = askDate.nextStep({
  prompt: "Ask for guests",
  collect: ["guests"],
  skipIf: (e) => !!e.guests,
});

askGuests.nextStep({
  prompt: "Confirm booking",
  step: END_ROUTE,
});

// Feedback route
const feedbackRoute = agent.createRoute<FeedbackData>({
  title: "Collect Feedback",
  conditions: ["Collect user feedback"],
  schema: {
    type: "object",
    properties: {
      rating: { type: "number" },
      comments: { type: "string" },
    },
    required: ["rating"],
  },
});

const askRating = feedbackRoute.initialStep.nextStep({
  prompt: "Ask for rating 1-5",
  collect: ["rating"],
});

askRating.nextStep({
  prompt: "Thank user",
  step: END_ROUTE,
});

// Usage - seamless transition from booking to feedback
let session;
const response1 = await agent.respond({ history, session });
// Booking complete, pending transition set

history.push(createMessageEvent(EventSource.CUSTOMER, "User", "Yes!"));
const response2 = await agent.respond({ history, session: response1.session });
// Now in feedback route automatically
```

### Benefits

✅ **Seamless user experience** - No awkward pauses between flows
✅ **Predictable behavior** - Transitions defined at design time
✅ **Flexible** - Simple strings, conditions, or complex functions
✅ **Type-safe** - Full TypeScript inference for collected data
✅ **Non-breaking** - Existing routes without `onComplete` work as before

See [examples/route-transitions.ts](../examples/route-transitions.ts) for a complete working example.

### Immediate Completion

Routes can complete **immediately** if all steps are skipped due to `skipIf` conditions. This is useful when:

- Resuming a partially completed route
- Pre-filling data from an existing session
- User provides all information upfront

```typescript
const onboardingRoute = agent.createRoute<OnboardingData>({
  title: "User Onboarding",
  schema: ONBOARDING_SCHEMA,
  initialData: existingUserData, // Pre-fill with existing data
});

const askName = onboardingRoute.initialStep.nextStep({
  prompt: "What's your name?",
  collect: ["name"],
  skipIf: (data) => !!data.name, // Skip if name exists
});

const askEmail = askName.nextStep({
  prompt: "What's your email?",
  collect: ["email"],
  skipIf: (data) => !!data.email, // Skip if email exists
});

const complete = askEmail.nextStep({
  prompt: "All done!",
});

complete.nextStep({ step: END_ROUTE });

// In your handler:
const response = await agent.respond({ history, session });

if (response.isRouteComplete) {
  // If existingUserData had all fields, route completes immediately!
  // The routing engine recursively skips all steps and reaches END_ROUTE
  console.log("Profile already complete!");
}
```

### Important Notes

- **`isRouteComplete: true`** indicates the route has reached `END_ROUTE`
- **`currentStep.id`** is set to `END_ROUTE_ID` when the route completes
- **`response.message`** will be empty (`""`) when route is complete
- **The routing engine** recursively traverses skipped steps to detect completion
- **You can check either** `isRouteComplete` or `currentStep.id === END_ROUTE_ID`
- **Session step** still contains all the collected data via `agent.getData()`
- **The route** (`currentRoute.id`) remains the completed route (e.g., "onboarding"), not END_ROUTE

### With Streaming

```typescript
for await (const chunk of agent.respondStream({ history, session })) {
  if (chunk.delta) {
    process.stdout.write(chunk.delta);
  }

  if (chunk.done && chunk.isRouteComplete) {
    console.log("\n🎉 Route completed!");
    const data = agent.getData(chunk.session!);
    await processCompletedData(data);
  }
}
```

---

## Best Practices

### ✅ Do's

- **Use descriptive titles and descriptions** - Makes routing more accurate
- **Define extraction schemas** - Type-safe data collection
- **Configure initial step** - Set up proper entry point
- **Use skipIf for known data** - Avoid redundant questions
- **Scope domains** - Limit tool access per route
- **Add route-specific guidelines** - Context-aware behavior
- **Use steps for linear flows** - Cleaner code for simple paths

### ❌ Don'ts

- **Don't use vague conditions** - Be specific about when to activate
- **Don't skip extraction schemas** - Loses type safety
- **Don't create overly complex routes** - Split into multiple routes
- **Don't forget requires** - Prevent steps from executing too early
- **Don't mix concerns** - One route = one goal
- **Don't hardcode step IDs** - Let framework generate deterministic IDs

---

## See Also

- [Steps Guide](./STEPS.md) - Deep dive into step management
- [API Reference - Route](./API_REFERENCE.md#route) - Complete API docs
- [Examples](../examples/) - Real-world route implementations
- [Architecture Guide](./ARCHITECTURE.md) - How routes fit in the system

---

**Made with ❤️ for the community**
