# Steps Guide

A complete guide to creating and managing steps in conversational flows.

---

## Table of Contents

- [What is a Step?](#what-is-a-step)
- [Creating Steps](#creating-steps)
- [Step Configuration](#step-configuration)
- [Transitions](#transitions)
- [Data Collecting](#data-collecting)
- [Step Logic](#step-logic)
- [Step Types](#step-types)
- [Advanced Patterns](#advanced-patterns)

---

## What is a Step?

A **Step** represents a specific step or moment in a conversation. Each step can:

- Display a message to the user (chat state)
- Execute a tool (tool state)
- Collect data from the conversation
- Make decisions about what to do next

```typescript
// Example: A step that asks for user's name
const askName = route.initialStep.nextStep({
  prompt: "What's your name?",
  collect: ["firstName", "lastName"],
});
```

**Key Concepts:**

- Steps form a **step machine** within a route
- Each step has a unique **ID** (auto-generated or custom)
- Steps can **collect data** from user responses
- Steps can be **skipped** based on conditions
- Steps can have **prerequisites** (required data)

---

## Creating Steps

### Chat states

Chat states present a message and optionally collect data:

```typescript
// Simple chat state
const welcome = route.initialStep.nextStep({
  prompt: "Welcome! How can I help you today?",
});

// Chat state with data collecting
const askDestination = welcome.nextStep({
  prompt: "Where would you like to fly?",
  collect: ["destination"],
});

// Chat state with custom ID
const askDates = askDestination.nextStep({
  id: "ask_travel_dates",
  prompt: "When would you like to depart?",
  collect: ["departureDate"],
});
```

### Tool states

Tool states execute functions and can update context or collected data:

```typescript
import { defineTool } from "@falai/agent";

const searchFlights = defineTool<Context, [], Results>(
  "search_flights",
  async ({ context, data }) => {
    const results = await api.search(data.destination);
    return {
      data: results,
      contextUpdate: { availableFlights: results },
    };
  }
);

// Tool state
const searchStep = askDates.nextStep({
  tool: searchFlights,
  requires: ["destination", "departureDate"],
});
```

### Direct Step References

Jump to specific steps or end the route:

```typescript
import { END_ROUTE } from "@falai/agent";

// Jump to another step
const confirm = processPayment.nextStep({
  step: previousStep.getRef(), // Jump back
});

// End the route
const complete = confirm.nextStep({
  step: END_ROUTE,
});
```

---

## Step Configuration

### Configuring Initial Step

Every route has an initial step that can be configured:

```typescript
// Option 1: Configure at route creation
const route = agent.createRoute({
  title: "Booking",
  initialStep: {
    id: "welcome",
    prompt: "Welcome to our booking system!",
    collect: ["intention"],
  },
});

// Option 2: Configure after creation
route.initialStep.configure({
  description: "Welcome! Let's start booking",
  collectFields: ["destination"],
  skipIf: (data) => !!data.destination,
  requires: [],
});
```

### Configuring Any Step

You can configure any step after creation:

```typescript
const askName = route.initialStep.nextStep({
  prompt: "What's your name?",
});

// Later, reconfigure it
askName.configure({
  description: "Ask for user's full name",
  collectFields: ["firstName", "lastName"],
  skipIf: (data) => !!data.firstName && !!data.lastName,
});

// Chaining is supported
askName
  .configure({ description: "Updated description" })
  .configure({ collectFields: ["fullName"] });
```

### Configuration Options

```typescript
step.configure({
  // Step description
  description?: string;

  // Fields to collect from conversation
  collectFields?: string[];

  // Skip this step if condition is met
  skipIf?: (data: Partial<TData>) => boolean;

  // Prerequisites that must be met before entering
  requires?: string[];
});
```

---

## Transitions

### Transition Specification

Every transition from one step to another uses a `TransitionSpec`:

```typescript
interface TransitionSpec<TData = unknown> {
  // Custom step ID (optional)
  id?: string;

  // Chat state description
  prompt?: string;

  // Tool to execute
  tool?: ToolRef;

  // Direct step reference or END_ROUTE
  step?: StepRef | symbol;

  // Fields to collect in this step
  collect?: string[];

  // Skip condition (code-based)
  skipIf?: (data: Partial<TData>) => boolean;

  // Prerequisites
  requires?: string[];

  // AI-evaluated condition (for step selection)
  condition?: string;
}
```

### Transition Chaining

```typescript
// Linear flow
route.initialStep
  .nextStep({
    prompt: "Step 1",
    collect: ["field1"],
  })
  .nextStep({
    prompt: "Step 2",
    collect: ["field2"],
  })
  .nextStep({
    prompt: "Step 3",
    collect: ["field3"],
  })
  .nextStep({ step: END_ROUTE });
```

### Branching Transitions

```typescript
const askType = route.initialStep.nextStep({
  prompt: "Are you booking a flight or hotel?",
  collect: ["bookingType"],
});

// Branch 1: Flight booking
const flightFlow = askType.nextStep({
  prompt: "Let's book your flight",
  condition: "User selected flight",
});

// Branch 2: Hotel booking
const hotelFlow = askType.nextStep({
  prompt: "Let's book your hotel",
  condition: "User selected hotel",
});

// Both branches can converge later
const payment = flightFlow.nextStep({
  prompt: "Let's process payment",
});

hotelFlow.nextStep({ step: payment }); // Converge to payment
```

---

## Data Collecting

### Basic Collecting

Specify which fields to extract in each step:

```typescript
interface UserData {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
}

const route = agent.createRoute<UserData>({ ... });

// Collect single field
const askName = route.initialStep.nextStep({
  prompt: "What's your first name?",
  collect: ["firstName"],
});

// Collect multiple fields at once
const askContact = askName.nextStep({
  prompt: "Please provide your email and phone number",
  collect: ["email", "phone"],
});
```

### Collecting with Schema Validation

The extraction schema validates collected data:

```typescript
const route = agent.createRoute<UserData>({
  title: "User Registration",

  schema: {
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
const askInfo = route.initialStep.nextStep({
  prompt: "Please provide your name, email, and age",
  collect: ["firstName", "email", "age"],
});
```

### Conditional Collecting

Use `skipIf` to avoid re-asking for data:

```typescript
const askDestination = route.initialStep.nextStep({
  prompt: "Where would you like to go?",
  collect: ["destination"],
  // Skip if we already have the destination
  skipIf: (data) => !!data.destination,
});

const askDates = askDestination.nextStep({
  prompt: "When would you like to travel?",
  collect: ["departureDate", "returnDate"],
  // Skip if we have both dates
  skipIf: (data) => !!data.departureDate && !!data.returnDate,
});
```

---

## Step Logic

### Skip Conditions

Control when steps should be bypassed:

```typescript
// Skip if data already exists
const askEmail = route.initialStep.nextStep({
  prompt: "What's your email?",
  collect: ["email"],
  skipIf: (data) => !!data.email,
});

// Skip based on business logic
const askShipping = askEmail.nextStep({
  prompt: "What's your shipping address?",
  collect: ["shippingAddress"],
  // Skip if user selected digital product
  skipIf: (data) => data.productType === "digital",
});

// Skip based on multiple conditions
const askBilling = askShipping.nextStep({
  prompt: "What's your billing address?",
  collect: ["billingAddress"],
  // Skip if billing same as shipping, or already provided
  skipIf: (data) =>
    data.billingSameAsShipping === true || !!data.billingAddress,
});
```

### Required Data

Ensure prerequisites are met before entering a step:

```typescript
// Can't search without destination and dates
const searchFlights = askDates.nextStep({
  tool: searchFlightsTool,
  requires: ["destination", "departureDate"],
});

// Can't checkout without all required fields
const processPayment = selectFlight.nextStep({
  tool: processPaymentTool,
  requires: ["destination", "departureDate", "selectedFlight", "paymentMethod"],
});

// Multiple prerequisites
const generateInvoice = processPayment.nextStep({
  prompt: "Here's your invoice",
  requires: ["paymentConfirmation", "customerEmail", "bookingReference"],
});
```

### Step Conditions

AI-evaluated conditions for step selection:

```typescript
const askIssue = route.initialStep.nextStep({
  prompt: "What seems to be the problem?",
  collect: ["issueDescription"],
});

// Technical support path
const technicalHelp = askIssue.nextStep({
  prompt: "Let me help with your technical issue",
  condition: "Issue is technical in nature",
});

// Billing support path
const billingHelp = askIssue.nextStep({
  prompt: "Let me help with your billing issue",
  condition: "Issue is related to billing or payments",
});

// General inquiry path
const generalHelp = askIssue.nextStep({
  prompt: "Let me help with your question",
  condition: "Issue is a general inquiry",
});
```

---

## Step Types

### 1. Chat states

Present information and collect data:

```typescript
const chat = route.initialStep.nextStep({
  prompt: "What would you like to know?",
  collect: ["question"],
});
```

**When to use:**

- Ask questions
- Present information
- Collect user input
- Confirm actions

### 2. Tool states

Execute functions:

```typescript
const tool = route.initialStep.nextStep({
  tool: myTool,
  requires: ["param1", "param2"],
});
```

**When to use:**

- Call APIs
- Database operations
- Complex computations
- External integrations
- Data validation/enrichment

### 3. Initial Step

Every route's starting point:

```typescript
route.initialStep.configure({
  description: "Welcome message",
  collectFields: ["initialInput"],
});
```

**When to configure:**

- Set up welcome messages
- Collect initial context
- Set expectations
- Pre-populate data

### 4. End Step (Terminal Step)

Every route ends when it reaches `END_ROUTE`. You can configure what happens at completion:

#### Option A: Route-Level Configuration (Recommended)

```typescript
import { END_ROUTE } from "@falai/agent";

const bookingRoute = agent.createRoute({
  title: "Book Flight",

  // Configure end step behavior
  endStep: {
    prompt: "Confirm booking and thank the user!",
    tool: sendConfirmationEmail, // Execute final actions
    collect: ["finalConfirmation"], // Collect last data
  },
});

// Later, just transition to END_ROUTE
finalStep.nextStep({
  step: END_ROUTE,
});
```

#### Option B: Per-Transition Override

```typescript
// Override endStep for this specific path
finalStep.nextStep({
  prompt: "Special completion message for VIP users!",
  step: END_ROUTE,
});
```

#### Option C: Default Behavior

If you don't configure `endStep`, a smart default completion message is generated:

```typescript
finalStep.nextStep({
  step: END_ROUTE,
});
// Uses default: "Summarize what was accomplished and confirm completion..."
```

**End Step Capabilities:**

```typescript
endStep: {
  // Completion message instruction
  prompt?: string;

  // Execute final actions (emails, database updates, etc.)
  tool?: ToolRef;

  // Collect final data before completion
  collect?: string[];

  // Require certain data to be present
  requires?: string[];

  // Custom step ID for debugging
  id?: string;
}
```

**When to use END_ROUTE:**

- ✅ Route completion - all required data collected
- ✅ Success outcomes - action completed successfully
- ✅ Failure outcomes - error handling completed
- ✅ Before transition - handoff to another route via `onComplete`

**End Step with Tools:**

Execute final actions when route completes:

```typescript
import { defineTool, END_ROUTE } from "@falai/agent";

const notifyTeam = defineTool("notify_team", async ({ data }) => {
  await slack.send({
    channel: "#bookings",
    message: `New booking: ${data.hotelName} for ${data.guests} guests`,
  });
  return { data: "Team notified" };
});

const bookingRoute = agent.createRoute({
  endStep: {
    tool: notifyTeam, // Runs when route completes
    prompt: "Booking complete! Our team has been notified.",
  },
});
```

**Key Points:**

- ✅ Configure once at route level (DRY principle)
- ✅ Can be overridden per-transition if needed
- ✅ Supports full step capabilities: `prompt`, `tool`, `collect`, `requires`
- ✅ Automatically generates message if not configured
- ✅ Executes before `onComplete` route transitions

---

## Advanced Patterns

### Pattern 1: Step Loops

```typescript
const askItems = route.initialStep.nextStep({
  prompt: "What items would you like to add to your cart?",
  collect: ["newItem"],
});

const confirmMore = askItems.nextStep({
  prompt: "Would you like to add more items?",
  collect: ["addMore"],
});

// Loop back to askItems if user wants more
confirmMore.nextStep({
  step: askItems,
  condition: "User wants to add more items",
});

// Or continue to checkout
const checkout = confirmMore.nextStep({
  prompt: "Let's proceed to checkout",
  condition: "User is done adding items",
});
```

### Pattern 2: Error Handling Steps

```typescript
const processPayment = route.initialStep.nextStep({
  tool: paymentTool,
  requires: ["amount", "paymentMethod"],
});

// Success path
const paymentSuccess = processPayment.nextStep({
  prompt: "Payment successful! Here's your receipt",
  condition: "Payment was successful",
});

// Failure path
const paymentFailed = processPayment.nextStep({
  prompt: "Payment failed. Would you like to try a different payment method?",
  collect: ["retryPayment"],
  condition: "Payment failed",
});

// Retry logic
paymentFailed.nextStep({
  step: processPayment,
  condition: "User wants to retry",
});
```

### Pattern 3: Progressive Disclosure

```typescript
// Start with basic info
const askBasic = route.initialStep.nextStep({
  prompt: "Let's start with the basics. What's your name?",
  collect: ["name"],
});

// Reveal more options
const askPreferences = askBasic.nextStep({
  prompt: "Great! Now, would you like to customize your experience?",
  collect: ["wantsCustomization"],
});

// Only ask detailed questions if user wants customization
const askDetailed = askPreferences.nextStep({
  prompt: "Tell me about your preferences...",
  collect: ["theme", "notifications", "language"],
  skipIf: (data) => data.wantsCustomization === false,
});

const finish = askDetailed.nextStep({
  prompt: "All set! Your account is ready",
});

// Direct path if no customization
askPreferences.nextStep({
  step: finish,
  condition: "User doesn't want customization",
});
```

### Pattern 4: Step Validation

```typescript
const askAge = route.initialStep.nextStep({
  prompt: "How old are you?",
  collect: ["age"],
});

const validateAge = askAge.nextStep({
  tool: validateAgeTool,
  requires: ["age"],
});

// Valid age
const proceed = validateAge.nextStep({
  prompt: "Great! Let's continue",
  condition: "Age is valid",
});

// Invalid age - loop back
validateAge.nextStep({
  step: askAge,
  condition: "Age is invalid",
});
```

### Pattern 5: Context-Aware Steps

```typescript
const askQuestion = route.initialStep.nextStep({
  prompt: "What would you like to know?",
  collect: ["question"],
});

// Different responses based on user type
const premiumResponse = askQuestion.nextStep({
  prompt: "As a premium member, here's detailed information...",
  condition: "User has premium account",
});

const basicResponse = askQuestion.nextStep({
  prompt: "Here's the basic information. Upgrade for more details!",
  condition: "User has basic account",
});
```

---

## Step Properties

### Accessing Step Properties

```typescript
const step = route.getStep("ask_name");

// Step identification
console.log(step.id); // "step_ask_name_abc123"
console.log(step.routeId); // "route_onboarding_xyz789"
console.log(step.description); // "Ask for user's name"

// Step configuration
console.log(step.collectFields); // ["firstName", "lastName"]
console.log(step.requires); // ["userId"]

// Step logic
if (step.skipIf) {
  const shouldSkip = step.skipIf(dataData);
  console.log("Should skip:", shouldSkip);
}

// Step guidelines
step.addGuideline({
  condition: "User provides invalid name",
  action: "Ask for valid name format",
});
console.log(step.getGuidelines());

// Transitions
console.log(step.getTransitions()); // [Transition, Transition, ...]
```

### Step Reference

```typescript
const stepRef = step.getRef();
console.log(stepRef);
// { id: "step_ask_name_abc123", routeId: "route_onboarding_xyz789" }

// Use reference in transitions
anotherStep.nextStep({ step: stepRef });
```

---

## Best Practices

### ✅ Do's

- **Use descriptive prompt** - Clear prompts for better UX
- **Define collect fields** - Explicit data extraction
- **Use skipIf for efficiency** - Avoid redundant questions
- **Set requires** - Prevent premature execution
- **Configure initial step** - Proper route entry point
- **Use tool states for logic** - Separate concerns
- **Add step-specific guidelines** - Context-aware behavior

### ❌ Don'ts

- **Don't hardcode step IDs** - Let framework generate them
- **Don't skip validation** - Always validate with requires
- **Don't create circular loops** - Without exit conditions
- **Don't collect unrelated data** - One concept per step
- **Don't use vague conditions** - Be specific
- **Don't forget skipIf** - For pre-populated data
- **Don't mix chat and tool** - One type per step

---

## Troubleshooting

### Step Not Being Entered

```typescript
// ❌ Problem: Required data missing
const step = prev.nextStep({
  prompt: "Do something",
  requires: ["field1", "field2"], // Missing field2
});

// ✅ Solution: Ensure required data is collected first
const collectData = prev.nextStep({
  prompt: "Collect data",
  collect: ["field1", "field2"],
});

const step = collectData.nextStep({
  prompt: "Do something",
  requires: ["field1", "field2"], // Now available
});
```

### Step Always Skipped

```typescript
// ❌ Problem: skipIf always returns true
const step = prev.nextStep({
  prompt: "Ask something",
  skipIf: (data) => true, // Always skips!
});

// ✅ Solution: Use proper condition
const step = prev.nextStep({
  prompt: "Ask something",
  skipIf: (data) => !!data.field, // Only skip if field exists
});
```

### Data Not Being Collected

```typescript
// ❌ Problem: Forgot to specify collect
const step = prev.nextStep({
  prompt: "What's your name?",
  // Missing collect!
});

// ✅ Solution: Add collect fields
const step = prev.nextStep({
  prompt: "What's your name?",
  collect: ["firstName", "lastName"],
});
```

---

## See Also

- [Routes Guide](./ROUTES.md) - Understanding routes
- [API Reference - Step](./API_REFERENCE.md#step) - Complete API docs
- [Examples](../examples/) - Real-world implementations
- [Architecture Guide](./ARCHITECTURE.md) - System overview

---

**Made with ❤️ for the community**
