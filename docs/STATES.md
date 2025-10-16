# States Guide

A complete guide to creating and managing states in conversational flows.

---

## Table of Contents

- [What is a State?](#what-is-a-state)
- [Creating States](#creating-states)
- [State Configuration](#state-configuration)
- [Transitions](#transitions)
- [Data Gathering](#data-gathering)
- [State Logic](#state-logic)
- [State Types](#state-types)
- [Advanced Patterns](#advanced-patterns)

---

## What is a State?

A **State** represents a specific step or moment in a conversation. Each state can:

- Display a message to the user (chat state)
- Execute a tool (tool state)
- Gather data from the conversation
- Make decisions about what to do next

```typescript
// Example: A state that asks for user's name
const askName = route.initialState.transitionTo({
  chatState: "What's your name?",
  gather: ["firstName", "lastName"],
});
```

**Key Concepts:**

- States form a **state machine** within a route
- Each state has a unique **ID** (auto-generated or custom)
- States can **gather data** from user responses
- States can be **skipped** based on conditions
- States can have **prerequisites** (required data)

---

## Creating States

### Chat States

Chat states present a message and optionally gather data:

```typescript
// Simple chat state
const welcome = route.initialState.transitionTo({
  chatState: "Welcome! How can I help you today?",
});

// Chat state with data gathering
const askDestination = welcome.transitionTo({
  chatState: "Where would you like to fly?",
  gather: ["destination"],
});

// Chat state with custom ID
const askDates = askDestination.transitionTo({
  id: "ask_travel_dates",
  chatState: "When would you like to depart?",
  gather: ["departureDate"],
});
```

### Tool States

Tool states execute functions and can update context or extracted data:

```typescript
import { defineTool } from "@falai/agent";

const searchFlights = defineTool<Context, [], Results>(
  "search_flights",
  async ({ context, extracted }) => {
    const results = await api.search(extracted.destination);
    return {
      data: results,
      contextUpdate: { availableFlights: results },
    };
  }
);

// Tool state
const searchState = askDates.transitionTo({
  toolState: searchFlights,
  requiredData: ["destination", "departureDate"],
});
```

### Direct State References

Jump to specific states or end the route:

```typescript
import { END_STATE } from "@falai/agent";

// Jump to another state
const confirm = processPayment.transitionTo({
  state: previousState.getRef(), // Jump back
});

// End the route
const complete = confirm.transitionTo({
  state: END_STATE,
});
```

---

## State Configuration

### Configuring Initial State

Every route has an initial state that can be configured:

```typescript
// Option 1: Configure at route creation
const route = agent.createRoute({
  title: "Booking",
  initialState: {
    id: "welcome",
    chatState: "Welcome to our booking system!",
    gather: ["intention"],
  },
});

// Option 2: Configure after creation
route.initialState.configure({
  description: "Welcome! Let's start booking",
  gatherFields: ["destination"],
  skipIf: (extracted) => !!extracted.destination,
  requiredData: [],
});
```

### Configuring Any State

You can configure any state after creation:

```typescript
const askName = route.initialState.transitionTo({
  chatState: "What's your name?",
});

// Later, reconfigure it
askName.configure({
  description: "Ask for user's full name",
  gatherFields: ["firstName", "lastName"],
  skipIf: (extracted) => !!extracted.firstName && !!extracted.lastName,
});

// Chaining is supported
askName
  .configure({ description: "Updated description" })
  .configure({ gatherFields: ["fullName"] });
```

### Configuration Options

```typescript
state.configure({
  // State description
  description?: string;

  // Fields to gather from conversation
  gatherFields?: string[];

  // Skip this state if condition is met
  skipIf?: (extracted: Partial<TExtracted>) => boolean;

  // Prerequisites that must be met before entering
  requiredData?: string[];
});
```

---

## Transitions

### Transition Specification

Every transition from one state to another uses a `TransitionSpec`:

```typescript
interface TransitionSpec<TExtracted = unknown> {
  // Custom state ID (optional)
  id?: string;

  // Chat state description
  chatState?: string;

  // Tool to execute
  toolState?: ToolRef;

  // Direct state reference or END_STATE
  state?: StateRef | symbol;

  // Fields to gather in this state
  gather?: string[];

  // Skip condition (code-based)
  skipIf?: (extracted: Partial<TExtracted>) => boolean;

  // Prerequisites
  requiredData?: string[];

  // AI-evaluated condition (for state selection)
  condition?: string;
}
```

### Transition Chaining

```typescript
// Linear flow
route.initialState
  .transitionTo({
    chatState: "Step 1",
    gather: ["field1"],
  })
  .transitionTo({
    chatState: "Step 2",
    gather: ["field2"],
  })
  .transitionTo({
    chatState: "Step 3",
    gather: ["field3"],
  })
  .transitionTo({ state: END_STATE });
```

### Branching Transitions

```typescript
const askType = route.initialState.transitionTo({
  chatState: "Are you booking a flight or hotel?",
  gather: ["bookingType"],
});

// Branch 1: Flight booking
const flightFlow = askType.transitionTo({
  chatState: "Let's book your flight",
  condition: "User selected flight",
});

// Branch 2: Hotel booking
const hotelFlow = askType.transitionTo({
  chatState: "Let's book your hotel",
  condition: "User selected hotel",
});

// Both branches can converge later
const payment = flightFlow.transitionTo({
  chatState: "Let's process payment",
});

hotelFlow.transitionTo({ state: payment }); // Converge to payment
```

---

## Data Gathering

### Basic Gathering

Specify which fields to extract in each state:

```typescript
interface UserData {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
}

const route = agent.createRoute<UserData>({ ... });

// Gather single field
const askName = route.initialState.transitionTo({
  chatState: "What's your first name?",
  gather: ["firstName"],
});

// Gather multiple fields at once
const askContact = askName.transitionTo({
  chatState: "Please provide your email and phone number",
  gather: ["email", "phone"],
});
```

### Gathering with Schema Validation

The extraction schema validates gathered data:

```typescript
const route = agent.createRoute<UserData>({
  title: "User Registration",

  extractionSchema: {
    type: "object",
    properties: {
      firstName: {
        type: "string",
        minLength: 1,
      },
      email: {
        type: "string",
        format: "email", // Validates email format
      },
      age: {
        type: "number",
        minimum: 18,
        maximum: 120,
      },
    },
    required: ["firstName", "email"],
  },
});

// AI will extract and validate according to schema
const askInfo = route.initialState.transitionTo({
  chatState: "Please provide your name, email, and age",
  gather: ["firstName", "email", "age"],
});
```

### Conditional Gathering

Use `skipIf` to avoid re-asking for data:

```typescript
const askDestination = route.initialState.transitionTo({
  chatState: "Where would you like to go?",
  gather: ["destination"],
  // Skip if we already have the destination
  skipIf: (extracted) => !!extracted.destination,
});

const askDates = askDestination.transitionTo({
  chatState: "When would you like to travel?",
  gather: ["departureDate", "returnDate"],
  // Skip if we have both dates
  skipIf: (extracted) => !!extracted.departureDate && !!extracted.returnDate,
});
```

---

## State Logic

### Skip Conditions

Control when states should be bypassed:

```typescript
// Skip if data already exists
const askEmail = route.initialState.transitionTo({
  chatState: "What's your email?",
  gather: ["email"],
  skipIf: (extracted) => !!extracted.email,
});

// Skip based on business logic
const askShipping = askEmail.transitionTo({
  chatState: "What's your shipping address?",
  gather: ["shippingAddress"],
  // Skip if user selected digital product
  skipIf: (extracted) => extracted.productType === "digital",
});

// Skip based on multiple conditions
const askBilling = askShipping.transitionTo({
  chatState: "What's your billing address?",
  gather: ["billingAddress"],
  // Skip if billing same as shipping, or already provided
  skipIf: (extracted) =>
    extracted.billingSameAsShipping === true || !!extracted.billingAddress,
});
```

### Required Data

Ensure prerequisites are met before entering a state:

```typescript
// Can't search without destination and dates
const searchFlights = askDates.transitionTo({
  toolState: searchFlightsTool,
  requiredData: ["destination", "departureDate"],
});

// Can't checkout without all required fields
const processPayment = selectFlight.transitionTo({
  toolState: processPaymentTool,
  requiredData: [
    "destination",
    "departureDate",
    "selectedFlight",
    "paymentMethod",
  ],
});

// Multiple prerequisites
const generateInvoice = processPayment.transitionTo({
  chatState: "Here's your invoice",
  requiredData: ["paymentConfirmation", "customerEmail", "bookingReference"],
});
```

### State Conditions

AI-evaluated conditions for state selection:

```typescript
const askIssue = route.initialState.transitionTo({
  chatState: "What seems to be the problem?",
  gather: ["issueDescription"],
});

// Technical support path
const technicalHelp = askIssue.transitionTo({
  chatState: "Let me help with your technical issue",
  condition: "Issue is technical in nature",
});

// Billing support path
const billingHelp = askIssue.transitionTo({
  chatState: "Let me help with your billing issue",
  condition: "Issue is related to billing or payments",
});

// General inquiry path
const generalHelp = askIssue.transitionTo({
  chatState: "Let me help with your question",
  condition: "Issue is a general inquiry",
});
```

---

## State Types

### 1. Chat States

Present information and gather data:

```typescript
const chat = route.initialState.transitionTo({
  chatState: "What would you like to know?",
  gather: ["question"],
});
```

**When to use:**

- Ask questions
- Present information
- Gather user input
- Confirm actions

### 2. Tool States

Execute functions:

```typescript
const tool = route.initialState.transitionTo({
  toolState: myTool,
  requiredData: ["param1", "param2"],
});
```

**When to use:**

- Call APIs
- Database operations
- Complex computations
- External integrations
- Data validation/enrichment

### 3. Initial State

Every route's starting point:

```typescript
route.initialState.configure({
  description: "Welcome message",
  gatherFields: ["initialInput"],
});
```

**When to configure:**

- Set up welcome messages
- Gather initial context
- Set expectations
- Pre-populate data

### 4. Terminal State

End of a route:

```typescript
const end = finalStep.transitionTo({
  state: END_STATE,
});
```

**When to use:**

- Route completion
- Success/failure outcomes
- Handoff to another route

---

## Advanced Patterns

### Pattern 1: State Loops

```typescript
const askItems = route.initialState.transitionTo({
  chatState: "What items would you like to add to your cart?",
  gather: ["newItem"],
});

const confirmMore = askItems.transitionTo({
  chatState: "Would you like to add more items?",
  gather: ["addMore"],
});

// Loop back to askItems if user wants more
confirmMore.transitionTo({
  state: askItems,
  condition: "User wants to add more items",
});

// Or continue to checkout
const checkout = confirmMore.transitionTo({
  chatState: "Let's proceed to checkout",
  condition: "User is done adding items",
});
```

### Pattern 2: Error Handling States

```typescript
const processPayment = route.initialState.transitionTo({
  toolState: paymentTool,
  requiredData: ["amount", "paymentMethod"],
});

// Success path
const paymentSuccess = processPayment.transitionTo({
  chatState: "Payment successful! Here's your receipt",
  condition: "Payment was successful",
});

// Failure path
const paymentFailed = processPayment.transitionTo({
  chatState:
    "Payment failed. Would you like to try a different payment method?",
  gather: ["retryPayment"],
  condition: "Payment failed",
});

// Retry logic
paymentFailed.transitionTo({
  state: processPayment,
  condition: "User wants to retry",
});
```

### Pattern 3: Progressive Disclosure

```typescript
// Start with basic info
const askBasic = route.initialState.transitionTo({
  chatState: "Let's start with the basics. What's your name?",
  gather: ["name"],
});

// Reveal more options
const askPreferences = askBasic.transitionTo({
  chatState: "Great! Now, would you like to customize your experience?",
  gather: ["wantsCustomization"],
});

// Only ask detailed questions if user wants customization
const askDetailed = askPreferences.transitionTo({
  chatState: "Tell me about your preferences...",
  gather: ["theme", "notifications", "language"],
  skipIf: (extracted) => extracted.wantsCustomization === false,
});

const finish = askDetailed.transitionTo({
  chatState: "All set! Your account is ready",
});

// Direct path if no customization
askPreferences.transitionTo({
  state: finish,
  condition: "User doesn't want customization",
});
```

### Pattern 4: State Validation

```typescript
const askAge = route.initialState.transitionTo({
  chatState: "How old are you?",
  gather: ["age"],
});

const validateAge = askAge.transitionTo({
  toolState: validateAgeTool,
  requiredData: ["age"],
});

// Valid age
const proceed = validateAge.transitionTo({
  chatState: "Great! Let's continue",
  condition: "Age is valid",
});

// Invalid age - loop back
validateAge.transitionTo({
  state: askAge,
  condition: "Age is invalid",
});
```

### Pattern 5: Context-Aware States

```typescript
const askQuestion = route.initialState.transitionTo({
  chatState: "What would you like to know?",
  gather: ["question"],
});

// Different responses based on user type
const premiumResponse = askQuestion.transitionTo({
  chatState: "As a premium member, here's detailed information...",
  condition: "User has premium account",
});

const basicResponse = askQuestion.transitionTo({
  chatState: "Here's the basic information. Upgrade for more details!",
  condition: "User has basic account",
});
```

---

## State Properties

### Accessing State Properties

```typescript
const state = route.getState("ask_name");

// State identification
console.log(state.id); // "state_ask_name_abc123"
console.log(state.routeId); // "route_onboarding_xyz789"
console.log(state.description); // "Ask for user's name"

// State configuration
console.log(state.gatherFields); // ["firstName", "lastName"]
console.log(state.requiredData); // ["userId"]

// State logic
if (state.skipIf) {
  const shouldSkip = state.skipIf(extractedData);
  console.log("Should skip:", shouldSkip);
}

// State guidelines
state.addGuideline({
  condition: "User provides invalid name",
  action: "Ask for valid name format",
});
console.log(state.getGuidelines());

// Transitions
console.log(state.getTransitions()); // [Transition, Transition, ...]
```

### State Reference

```typescript
const stateRef = state.getRef();
console.log(stateRef);
// { id: "state_ask_name_abc123", routeId: "route_onboarding_xyz789" }

// Use reference in transitions
anotherState.transitionTo({ state: stateRef });
```

---

## Best Practices

### ✅ Do's

- **Use descriptive chatState** - Clear prompts for better UX
- **Define gather fields** - Explicit data extraction
- **Use skipIf for efficiency** - Avoid redundant questions
- **Set requiredData** - Prevent premature execution
- **Configure initial state** - Proper route entry point
- **Use tool states for logic** - Separate concerns
- **Add state-specific guidelines** - Context-aware behavior

### ❌ Don'ts

- **Don't hardcode state IDs** - Let framework generate them
- **Don't skip validation** - Always validate with requiredData
- **Don't create circular loops** - Without exit conditions
- **Don't gather unrelated data** - One concept per state
- **Don't use vague conditions** - Be specific
- **Don't forget skipIf** - For pre-populated data
- **Don't mix chat and tool** - One type per state

---

## Troubleshooting

### State Not Being Entered

```typescript
// ❌ Problem: Required data missing
const state = prev.transitionTo({
  chatState: "Do something",
  requiredData: ["field1", "field2"], // Missing field2
});

// ✅ Solution: Ensure required data is gathered first
const gatherData = prev.transitionTo({
  chatState: "Gather data",
  gather: ["field1", "field2"],
});

const state = gatherData.transitionTo({
  chatState: "Do something",
  requiredData: ["field1", "field2"], // Now available
});
```

### State Always Skipped

```typescript
// ❌ Problem: skipIf always returns true
const state = prev.transitionTo({
  chatState: "Ask something",
  skipIf: (extracted) => true, // Always skips!
});

// ✅ Solution: Use proper condition
const state = prev.transitionTo({
  chatState: "Ask something",
  skipIf: (extracted) => !!extracted.field, // Only skip if field exists
});
```

### Data Not Being Gathered

```typescript
// ❌ Problem: Forgot to specify gather
const state = prev.transitionTo({
  chatState: "What's your name?",
  // Missing gather!
});

// ✅ Solution: Add gather fields
const state = prev.transitionTo({
  chatState: "What's your name?",
  gather: ["firstName", "lastName"],
});
```

---

## See Also

- [Routes Guide](./ROUTES.md) - Understanding routes
- [API Reference - State](./API_REFERENCE.md#state) - Complete API docs
- [Examples](../examples/) - Real-world implementations
- [Architecture Guide](./ARCHITECTURE.md) - System overview

---

**Made with ❤️ for the community**
