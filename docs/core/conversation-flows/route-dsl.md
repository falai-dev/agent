# Route DSL (Domain Specific Language)

The Route DSL provides a fluent, declarative API for designing complex conversation flows. Unlike traditional chatbot frameworks that use rigid state machines, the Route DSL enables natural, branching conversation patterns with intelligent routing.

## Overview

Routes are the building blocks of conversational AI in @falai/agent. Each route represents a journey with:

- **Structured Steps**: Sequential or branching conversation states
- **Data Collection**: Schema-driven information gathering
- **Conditional Logic**: Smart skipping and branching based on context
- **Lifecycle Hooks**: Custom behavior at route and step levels

## Basic Route Creation

### Simple Linear Route

```typescript
const greetingRoute = agent
  .createRoute({
    title: "Greeting Flow",
    description: "Simple greeting and introduction",
    initialStep: {
      prompt: "Hello! What's your name?",
      collect: ["name"],
    },
  })
  .nextStep({
    prompt: "Nice to meet you, {{name}}! How can I help you today?",
    requires: ["name"], // Must have name before proceeding
  });
```

### Route with Agent-Level Schema

```typescript
interface UserInfo {
  name: string;
  email: string;
  interests: string[];
  preferences?: object;
  profileComplete?: boolean;
}

// Agent defines comprehensive schema
const agent = new Agent<{}, UserInfo>({
  name: "Profile Assistant",
  provider: openaiProvider,
  schema: {
    type: "object",
    properties: {
      name: { type: "string" },
      email: { type: "string", format: "email" },
      interests: {
        type: "array",
        items: { type: "string" },
      },
      preferences: { type: "object" },
      profileComplete: { type: "boolean" }
    },
    required: ["name", "email"],
  }
});

// Route specifies required fields instead of schema
const userProfileRoute = agent
  .createRoute({
    title: "User Profile Collection",
    description: "Collect basic user information",
    requiredFields: ["name", "email", "interests"], // Required for completion
    optionalFields: ["preferences"], // Nice to have
    initialStep: {
      prompt: "Let's create your profile. What's your name?",
      collect: ["name"],
    },
  })
  .nextStep({
    prompt: "Great, {{name}}! What's your email address?",
    collect: ["email"],
    requires: ["name"], // Prerequisites from agent data
  })
  .nextStep({
    prompt: "What are your interests? (comma-separated)",
    collect: ["interests"],
    requires: ["name", "email"], // Prerequisites from agent data
  });
```

## Step Configuration

### Step Options

Each step supports comprehensive configuration:

```typescript
interface StepOptions<TContext, TData> {
  id?: string; // Optional custom ID
  description?: string; // Human-readable description
  prompt?: Template<TContext, TData>; // AI prompt template
  collect?: string[]; // Fields to extract from AI response
  skipIf?: (data: Partial<TData>) => boolean; // Skip condition
  requires?: string[]; // Required data fields
  when?: Template<TContext, TData>; // Conditional execution
  prepare?: (context: TContext, data?: Partial<TData>) => void | Promise<void>;
  finalize?: (context: TContext, data?: Partial<TData>) => void | Promise<void>;
  tools?: (string | Tool<TContext, unknown[], unknown, TData>)[];
}
```

### Data Collection Steps

```typescript
const dataCollectionStep = {
  prompt: "What's your preferred contact method?",
  collect: ["contactMethod"], // Maps to agent schema field
  requires: ["name", "email"], // Must have these fields from agent data
  skipIf: (data) => data.contactMethod !== undefined, // Skip if already collected by any route
};
```

### Conditional Steps

```typescript
const conditionalStep = {
  prompt: "Would you like to receive our newsletter?",
  collect: ["newsletterOptIn"],
  when: "if user has provided email address", // AI-evaluated condition
  skipIf: (data) => data.email === undefined, // Skip if no email
};
```

### Lifecycle Hooks

```typescript
const stepWithHooks = {
  prompt: "Processing your request...",
  prepare: async (context, data) => {
    // Run before AI responds
    console.log("Preparing step with data:", data);
    // Could fetch external data, validate state, etc.
  },
  finalize: async (context, data) => {
    // Run after AI responds and data is collected
    console.log("Step completed with data:", data);
    // Could save to database, trigger notifications, etc.
  },
};
```

## Branching and Non-Linear Flows

### Basic Branching

```typescript
const branchingRoute = agent
  .createRoute({
    title: "Support Flow",
    initialStep: {
      prompt: "How can I help you today?",
      collect: ["intent"],
    },
  })
  .branch([
    {
      name: "technical",
      step: {
        prompt:
          "I understand you're having a technical issue. Can you describe the problem?",
        collect: ["problem"],
        requires: ["intent"],
        when: "if intent indicates technical support",
      },
    },
    {
      name: "billing",
      step: {
        prompt: "For billing questions, I'll need your account information...",
        collect: ["accountInfo"],
        requires: ["intent"],
        when: "if intent indicates billing or payment",
      },
    },
    {
      name: "general",
      step: {
        prompt: "I'd be happy to help with general questions...",
        collect: ["question"],
        requires: ["intent"],
      },
    },
  ]);
```

### Accessing Branch Results

```typescript
const routeWithBranches = agent
  .createRoute({
    title: "Complex Flow",
  })
  .branch([
    {
      name: "optionA",
      step: { prompt: "Choose option A", collect: ["choiceA"] },
    },
    {
      name: "optionB",
      step: { prompt: "Choose option B", collect: ["choiceB"] },
    },
  ]);

// Access specific branches for further chaining
const optionA = routeWithBranches.branches.optionA.nextStep({
  prompt: "You chose A. What's next?",
  requires: ["choiceA"],
});

const optionB = routeWithBranches.branches.optionB.nextStep({
  prompt: "You chose B. What's next?",
  requires: ["choiceB"],
});
```

## Route Completion and Transitions

### Basic Route Completion

```typescript
const simpleRoute = agent
  .createRoute({
    title: "Simple Task",
    initialStep: { prompt: "What task should I help with?", collect: ["task"] },
  })
  .nextStep({
    prompt: "I'll help you with: {{task}}",
    requires: ["task"],
  })
  .endRoute({
    prompt: "Task completed! Is there anything else I can help with?",
  });
```

### Automatic Transitions

```typescript
const onboardingRoute = agent
  .createRoute({
    title: "User Onboarding",
    initialStep: { prompt: "Welcome! What's your name?", collect: ["name"] },
  })
  .nextStep({
    prompt: "Thanks {{name}}! Let's set up your profile.",
    collect: ["profileComplete"],
    requires: ["name"],
  })
  .endRoute({
    prompt: "Onboarding complete! Ready to explore?",
  });

// Automatically transition to another route when complete
onboardingRoute.onComplete = "main-menu"; // Route ID or title
```

### Conditional Transitions

```typescript
const purchaseRoute = agent
  .createRoute({
    title: "Purchase Flow",
    initialStep: {
      prompt: "What would you like to purchase?",
      collect: ["item"],
    },
  })
  .nextStep({
    prompt: "Great choice! Processing {{item}}...",
    collect: ["purchaseComplete"],
    requires: ["item"],
  })
  .endRoute();

purchaseRoute.onComplete = {
  nextStep: "feedback-collection", // Transition target
  condition: "if purchase was successful", // AI-evaluated condition
};
```

### Dynamic Transitions

```typescript
purchaseRoute.onComplete = async (session, context) => {
  // Custom logic for determining next route
  if (session.data?.purchaseComplete) {
    return "feedback-collection";
  } else if (session.data?.error) {
    return "error-recovery";
  } else {
    return "support";
  }
};
```

## Advanced Route Features

### Route-Level Configuration

```typescript
const advancedRoute = agent.createRoute({
  title: "Advanced Interaction",
  description: "Complex multi-step conversation",

  // Route completion requirements
  requiredFields: ["customerName", "email", "issueType"],
  optionalFields: ["phone", "priority"],

  // Route-level identity overrides agent identity
  identity: "You are an expert consultant specializing in {{domain}}",

  // Behavioral guidelines for this route
  guidelines: [
    {
      condition: "if user is frustrated",
      action: "Be extra patient and offer specific solutions",
    },
  ],

  // Domain-specific terms
  terms: [
    {
      name: "ROI",
      description: "Return on Investment - the financial benefit gained",
      synonyms: ["return on investment", "profitability"],
    },
  ],

  // Initial data to pre-populate (maps to agent schema)
  initialData: {
    sessionId: generateId(),
    startTime: new Date().toISOString(),
  },

  // Route-level lifecycle hooks (work with agent data)
  hooks: {
    onDataUpdate: (newData, previousData) => {
      // Validate or enrich agent-level collected data
      if (newData.email && !isValidEmail(newData.email)) {
        throw new Error("Invalid email format");
      }
      
      // Auto-set priority based on issue type
      if (newData.issueType === 'billing' && !newData.priority) {
        newData.priority = 'high';
      }
      
      return newData;
    },
    onContextUpdate: (newContext, previousContext) => {
      // React to context changes
      console.log("Context updated:", { previousContext, newContext });
    },
  },
});
```

### Sequential Step Building

```typescript
const sequentialRoute = agent.createRoute({
  title: "Sequential Process",
  steps: [
    {
      description: "Step 1: Initial assessment",
      prompt: "Let's start with some basic information...",
      collect: ["basicInfo"],
    },
    {
      description: "Step 2: Detailed requirements",
      prompt: "Now I need more specific details...",
      collect: ["detailedInfo"],
      requires: ["basicInfo"],
      skipIf: (data) => data.skipDetailed, // Allow skipping if condition met
    },
    {
      description: "Step 3: Confirmation",
      prompt: "Please confirm the following details...",
      collect: ["confirmed"],
      requires: ["basicInfo"], // Note: detailedInfo not required due to skipIf
    },
  ],
});
```

## Route Management

### Route Registration

```typescript
const agent = new Agent({
  name: "Multi-Purpose Assistant",
  provider: openaiProvider,
  routes: [greetingRoute, supportRoute, purchaseRoute],
});

// Or add routes dynamically
agent.createRoute(salesRoute);
agent.createRoute(feedbackRoute);
```

### Route Access and Inspection

```typescript
// Get all routes
const allRoutes = agent.getRoutes();

// Find specific route
const supportRoute = agent.getRoutes().find((r) => r.id === "support");

// Inspect route structure
console.log(supportRoute.describe());
```

## Best Practices

### Route Design

1. **Single Responsibility**: Each route should serve one clear user intent
2. **Progressive Disclosure**: Collect information in logical order
3. **Fail Fast**: Use `requires` to prevent invalid state transitions
4. **Smart Skipping**: Use `skipIf` to avoid redundant questions

### Step Design

1. **Clear Prompts**: Make step purposes obvious to both AI and users
2. **Minimal Collection**: Only collect what's needed for the current step
3. **Validation**: Use lifecycle hooks for data validation
4. **Error Handling**: Plan for edge cases and invalid inputs

### Performance

1. **Limit Branching**: Too many branches increase AI evaluation complexity
2. **Optimize Conditions**: Use efficient `skipIf` and `requires` logic
3. **Cache Data**: Avoid redundant data fetching in lifecycle hooks
4. **Monitor Usage**: Track route completion rates and drop-off points

### Maintainability

1. **Descriptive Names**: Use clear route and step IDs
2. **Documentation**: Add descriptions to routes and complex steps
3. **Modular Design**: Break complex routes into smaller, focused routes
4. **Version Control**: Plan for route evolution and backward compatibility

## Debugging and Testing

### Route Inspection

```typescript
// Get detailed route structure
console.log(route.describe());

// Inspect all steps
const steps = route.getAllSteps();
steps.forEach((step) => {
  console.log(`Step: ${step.id} - ${step.description}`);
  console.log(
    `Transitions:`,
    step.getTransitions().map((s) => s.id)
  );
});
```

### Step Validation

```typescript
// Test skipIf conditions
const shouldSkip = step.shouldSkip(collectedData);

// Test requirements
const hasRequirements = step.hasRequires(collectedData);
```

### Route Testing

```typescript
// Simulate route execution
const mockSession = createSession();
const mockHistory = [
  {
    role: "user",
    content: "Hello",
  },
];

const response = await agent.respond({
  history: mockHistory,
  session: mockSession,
});

console.log("Route selected:", response.session.currentRoute?.title);
console.log("Data collected:", response.session.data);
```

The Route DSL transforms conversation design from rigid, hardcoded flows into flexible, intelligent systems that can adapt to user needs while maintaining structure and reliability.
