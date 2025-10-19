# Step Transitions & Conditional Logic

The step transition system provides intelligent conversation flow control, enabling dynamic, context-aware progression through conversation routes. Unlike linear chatbots, this system can skip irrelevant steps, enforce dependencies, and adapt to user context.

## Overview

Step transitions handle:

- **Conditional Skipping**: Skip steps based on collected data or context
- **Dependency Enforcement**: Ensure prerequisite data exists before proceeding
- **Branch Resolution**: Handle multiple possible next steps
- **Route Completion**: Detect when routes reach their end
- **Loop Prevention**: Avoid infinite traversal in complex flows

## Conditional Skipping

### SkipIf Logic

The `skipIf` function determines whether a step should be bypassed:

```typescript
const smartRoute = agent
  .createRoute({
    title: "Smart Onboarding",

    initialStep: {
      prompt: "What's your name?",
      collect: ["name"],
      skipIf: (data) => data.name !== undefined, // Skip if name already known
    },
  })
  .nextStep({
    prompt: "What's your email, {{name}}?",
    collect: ["email"],
    requires: ["name"], // Must have name to proceed
    skipIf: (data) => data.email !== undefined, // Skip if email already known
  });
```

### Common SkipIf Patterns

```typescript
// Skip based on user preferences
skipIf: (data) => data.skipNewsletterSignup === true;

// Skip if data already exists
skipIf: (data) => data.userProfile?.completed === true;

// Skip based on external conditions
skipIf: (data) => {
  const now = new Date();
  const lastContact = data.lastContactDate;
  return lastContact && now - lastContact < 24 * 60 * 60 * 1000; // Within 24 hours
};

// Skip based on user type
skipIf: (data) => data.userType === "premium" && data.onboardingComplete;
```

## Dependency Enforcement

### Requires Validation

The `requires` array ensures prerequisite data exists:

```typescript
const dependentRoute = agent
  .createRoute({
    title: "Dependent Collection",

    initialStep: {
      prompt: "What's your name?",
      collect: ["name"],
    },
  })
  .nextStep({
    prompt: "What's your email address?",
    collect: ["email"],
    requires: ["name"], // Cannot proceed without name
  })
  .nextStep({
    prompt: "Should I send updates to {{email}}?",
    collect: ["emailConsent"],
    requires: ["name", "email"], // Needs both name and email
  });
```

### Complex Requirements

```typescript
const complexRequirements = {
  prompt: "Let's schedule your appointment.",
  collect: ["appointmentDate", "appointmentTime"],
  requires: [
    "name", // Basic info
    "email", // Contact info
    "serviceType", // What service they want
    "availability", // When they're available
  ],
  skipIf: (data) => {
    // Skip if appointment already scheduled
    return data.appointmentId !== undefined;
  },
};
```

## Step Traversal Logic

### Candidate Step Algorithm

The system uses a sophisticated algorithm to find valid next steps:

```typescript
// 1. Start with current step's direct transitions
const transitions = currentStep.getTransitions();

// 2. For each transition, evaluate:
for (const transition of transitions) {
  // Check for END_ROUTE marker
  if (transition.id === END_ROUTE_ID) {
    return { isRouteComplete: true };
  }

  // Skip steps that should be skipped
  if (transition.shouldSkip(data)) {
    // Recursively traverse to find next valid step
    continue;
  }

  // Check if step has required data
  if (!transition.hasRequires(data)) {
    // Step cannot be entered yet
    continue;
  }

  // Found valid step
  return { step: transition };
}
```

### Recursive Traversal

For complex flows with skipIf conditions:

```typescript
// Example flow: A -> B -> C -> END
// If user has already completed B, skip to C
// If B and C are complete, route is done

const flow = agent
  .createRoute({
    title: "Complex Flow",

    initialStep: {
      /* Step A */
    },
  })
  .nextStep({
    prompt: "Step B content",
    skipIf: (data) => data.stepBComplete,
  })
  .nextStep({
    prompt: "Step C content",
    skipIf: (data) => data.stepCComplete,
    requires: ["stepBComplete"],
  })
  .endRoute();
```

## Branching Logic

### Branch Evaluation

When multiple branches exist, the system evaluates each:

```typescript
const branchingRoute = agent
  .createRoute({
    title: "Multi-Path Flow",

    initialStep: {
      prompt: "What type of help do you need?",
      collect: ["helpType"],
    },
  })
  .branch([
    {
      name: "technical",
      step: {
        prompt: "Technical support question?",
        collect: ["techIssue"],
        requires: ["helpType"],
        when: "if helpType indicates technical issue",
      },
    },
    {
      name: "billing",
      step: {
        prompt: "Billing question?",
        collect: ["billingIssue"],
        requires: ["helpType"],
        when: "if helpType indicates billing issue",
      },
    },
    {
      name: "general",
      step: {
        prompt: "General question?",
        collect: ["generalQuestion"],
        requires: ["helpType"],
        // No 'when' condition - fallback branch
      },
    },
  ]);
```

### Branch Resolution

```typescript
// The routing engine evaluates branches and selects the best path
// 1. Check explicit 'when' conditions (AI-evaluated)
// 2. Fall back to branches without conditions
// 3. Allow multiple branches if no clear winner

// Access specific branches for chaining
const techBranch = branchingRoute.branches.technical.nextStep({
  prompt: "Let me help with that technical issue...",
  requires: ["techIssue"],
});
```

## Route Completion

### End Route Detection

Routes complete when reaching END_ROUTE:

```typescript
const completeRoute = agent
  .createRoute({
    title: "Task Completion",

    initialStep: { prompt: "What task?", collect: ["task"] },
  })
  .nextStep({
    prompt: "I'll help with {{task}}",
    requires: ["task"],
  })
  .nextStep({
    prompt: "Task details?",
    collect: ["details"],
    requires: ["task"],
  })
  .endRoute({
    prompt: "Task completed! Anything else?",
    collect: ["satisfaction"], // Optional final collection
  });
```

### Completion Handlers

```typescript
const routeWithCompletion = agent.createRoute({
  title: "Workflow",

  // Simple string transition
  onComplete: "feedback-route",

  // Or conditional transition
  // onComplete: {
  //   nextStep: "success-route",
  //   condition: "if workflow succeeded"
  // }

  // Or dynamic transition
  // onComplete: async (session, context) => {
  //   if (session.data?.success) return "success-route";
  //   return "retry-route";
  // }
});
```

## Advanced Transition Patterns

### Circular Flows

Handle repeating patterns with proper termination:

```typescript
const iterativeRoute = agent
  .createRoute({
    title: "Iterative Collection",

    initialStep: {
      prompt: "Add an item (or 'done' to finish)",
      collect: ["currentItem"],
    },
  })
  .nextStep({
    prompt: "Item added: {{currentItem}}. Add another?",
    collect: ["continue"],
    requires: ["currentItem"],
    skipIf: (data) => data.continue === false || data.currentItem === "done",
  })
  .nextStep({
    prompt: "Add another item?",
    collect: ["currentItem"],
    requires: ["continue"],
    // Loops back to previous step
  });
```

### State-Based Transitions

```typescript
const statefulRoute = agent
  .createRoute({
    title: "State Machine",

    initialStep: {
      prompt: "What's your current status?",
      collect: ["status"],
    },
  })
  .branch([
    {
      name: "new",
      step: {
        prompt: "Welcome! Let's get you started.",
        collect: ["onboardingData"],
        when: "if status is 'new'",
        skipIf: (data) => data.status !== "new",
      },
    },
    {
      name: "returning",
      step: {
        prompt: "Welcome back! What can I help with?",
        collect: ["request"],
        when: "if status is 'returning'",
        skipIf: (data) => data.status !== "returning",
      },
    },
  ]);
```

## Lifecycle Integration

### Prepare and Finalize Hooks

```typescript
const hookedRoute = agent
  .createRoute({
    title: "Lifecycle Demo",

    initialStep: {
      prompt: "Starting process...",
      prepare: async (context, data) => {
        // Setup before AI responds
        console.log("Preparing step with context:", context);
        console.log("Current data:", data);
      },
      finalize: async (context, data) => {
        // Cleanup after AI responds
        console.log("Step completed with data:", data);
        await saveProgress(data);
      },
    },
  })
  .nextStep({
    prompt: "Process step...",
    prepare: (context, data) => {
      // Validate state before proceeding
      if (!data.requiredField) {
        throw new Error("Missing required field");
      }
    },
  });
```

### Route-Level Hooks

```typescript
const routeWithHooks = agent.createRoute({
  title: "Route Lifecycle",

  hooks: {
    onDataUpdate: (newData, previousData) => {
      // Validate data changes across the route
      if (newData.criticalField && !isValid(newData.criticalField)) {
        throw new Error("Invalid critical field");
      }
      return newData;
    },

    onContextUpdate: (newContext, previousContext) => {
      // React to context changes
      console.log("Route context updated");
    },
  },
});
```

## Error Handling & Recovery

### Transition Validation

```typescript
const robustRoute = agent
  .createRoute({
    title: "Error Handling",

    initialStep: {
      prompt: "What would you like to do?",
      collect: ["action"],
      finalize: async (context, data) => {
        try {
          await validateAction(data.action);
        } catch (error) {
          // Set error state for recovery
          data.actionError = error.message;
          data.needsRecovery = true;
        }
      },
    },
  })
  .nextStep({
    prompt:
      "There was an issue with your request: {{actionError}}. Please try again.",
    collect: ["action"],
    skipIf: (data) => !data.needsRecovery,
    finalize: (context, data) => {
      // Clear error state on successful retry
      delete data.actionError;
      delete data.needsRecovery;
    },
  });
```

### Recovery Patterns

```typescript
const recoveryRoute = agent
  .createRoute({
    title: "Recovery Flow",

    // Normal flow
    initialStep: {
      /* normal steps */
    },

    // Recovery branch
  })
  .branch([
    {
      name: "normal",
      step: {
        /* normal processing */
      },
    },
    {
      name: "recovery",
      step: {
        prompt: "I encountered an error. Let's start over.",
        collect: ["resetConfirmation"],
        when: "if error state is detected",
        finalize: (context, data) => {
          // Reset problematic data
          resetSessionData(data);
        },
      },
    },
  ]);
```

## Performance Considerations

### Efficient Traversal

```typescript
// The system optimizes by:
// 1. Using visited sets to prevent infinite loops
// 2. Early termination on END_ROUTE detection
// 3. Lazy evaluation of skipIf conditions
// 4. Caching of validation results

// Example of efficient validation
skipIf: (data) => {
  // Cache expensive operations
  if (data._skipCache === undefined) {
    data._skipCache = expensiveCheck(data);
  }
  return data._skipCache;
};
```

### Memory Management

```typescript
// Clean up temporary data
finalize: (context, data) => {
  // Remove temporary fields
  delete data._tempField;
  delete data._skipCache;

  // Compress large data structures if needed
  if (data.largeArray?.length > 100) {
    data.largeArray = data.largeArray.slice(-50); // Keep recent items
  }
};
```

## Debugging Transitions

### Step Inspection

```typescript
// Inspect route structure
console.log(route.describe());

// Check step validity
const step = route.getStep("step-id");
console.log("Should skip:", step.shouldSkip(session.data));
console.log("Has requirements:", step.hasRequires(session.data));

// Get all transitions
const transitions = step.getTransitions();
console.log(
  "Available transitions:",
  transitions.map((s) => s.id)
);
```

### Transition Tracing

```typescript
// Enable debug logging
const agent = new Agent({
  name: "Debug Agent",
  debug: true, // Enables transition logging
  provider: provider,
});

// Logs will show:
// [RoutingEngine] Found valid step after skipping: step-3
// [RoutingEngine] Route complete: all data collected, END_ROUTE reached
// [Agent] Entered step: step-3
```

### Testing Transitions

```typescript
// Test step conditions
const testData = { name: "John", email: "john@test.com" };

const shouldSkip = step.shouldSkip(testData);
const hasRequirements = step.hasRequires(testData);

console.log(`Step ${step.id}:`);
console.log(`- Should skip: ${shouldSkip}`);
console.log(`- Has requirements: ${hasRequirements}`);
console.log(`- Can proceed: ${!shouldSkip && hasRequirements}`);
```

## Best Practices

### Transition Design

1. **Clear Dependencies**: Make `requires` relationships obvious
2. **Smart Skipping**: Use `skipIf` to avoid redundant interactions
3. **Fail Fast**: Validate early to prevent invalid states
4. **Recovery Paths**: Plan for error conditions and recovery flows

### Performance

1. **Efficient Conditions**: Cache expensive `skipIf` evaluations
2. **Minimal Dependencies**: Avoid overly complex requirement chains
3. **Early Termination**: Use END_ROUTE appropriately
4. **Memory Cleanup**: Remove temporary data in finalize hooks

### Maintainability

1. **Descriptive IDs**: Use meaningful step and route identifiers
2. **Documentation**: Comment complex transition logic
3. **Testing**: Cover edge cases in transition logic
4. **Monitoring**: Track transition success rates

### User Experience

1. **Natural Flow**: Make transitions feel conversational
2. **Context Preservation**: Maintain conversation context across steps
3. **Error Recovery**: Handle failures gracefully with clear recovery paths
4. **Progress Indication**: Show users where they are in multi-step processes

The step transition system enables sophisticated conversation flows that can adapt to user context, handle complex branching logic, and maintain data integrity throughout multi-turn interactions.
