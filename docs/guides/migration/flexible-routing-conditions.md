# Migration Guide: Flexible Routing Conditions

This guide helps you migrate from the previous routing condition system to the new `ConditionTemplate` system introduced in version X.X.X.

## Overview of Changes

The routing system has been enhanced with a new `ConditionTemplate` type that supports:

- **String conditions**: AI context for routing decisions
- **Function conditions**: Programmatic boolean evaluation  
- **Array conditions**: Mix of strings and functions with logical operators
- **Route skipIf**: New functionality to exclude routes dynamically
- **Enhanced Step conditions**: More flexible step control

## Breaking Changes

### 1. Route Conditions → Route When

**Before:**
```typescript
agent.createRoute({
  title: "Customer Support",
  conditions: ["User needs help", "User asks questions"],
  // ...
});
```

**After:**
```typescript
agent.createRoute({
  title: "Customer Support", 
  when: ["User needs help", "User asks questions"], // Renamed from 'conditions'
  // ...
});
```

**Migration:** Simply rename `conditions` to `when` in all route definitions.

### 2. Step When Conditions

**Before:**
```typescript
// String-based when condition
step.nextStep({
  when: "User wants to continue",
  prompt: "Let's continue..."
});

// Function-based when condition (returned string)
step.nextStep({
  when: (ctx) => ctx.data?.readyToContinue ? "Ready to proceed" : null,
  prompt: "Let's continue..."
});
```

**After:**
```typescript
// String-based when condition (unchanged)
step.nextStep({
  when: "User wants to continue",
  prompt: "Let's continue..."
});

// Function-based when condition (now returns boolean)
step.nextStep({
  when: (ctx) => ctx.data?.readyToContinue === true, // Returns boolean
  prompt: "Let's continue..."
});

// Mixed array condition (new capability)
step.nextStep({
  when: [
    "User is ready to proceed", // AI context
    (ctx) => ctx.data?.readyToContinue === true // Programmatic check
  ],
  prompt: "Let's continue..."
});
```

**Migration:** Update function-based `when` conditions to return boolean instead of string.

### 3. Step SkipIf Conditions

**Before:**
```typescript
step.nextStep({
  skipIf: (data) => data.alreadyCompleted === true, // Function only
  prompt: "Complete this step"
});
```

**After:**
```typescript
// Function-only skipIf (unchanged signature, but now uses full context)
step.nextStep({
  skipIf: (ctx) => ctx.data?.alreadyCompleted === true, // Full context access
  prompt: "Complete this step"
});

// String-only skipIf (new capability)
step.nextStep({
  skipIf: "Step already completed",
  prompt: "Complete this step"
});

// Mixed array skipIf (new capability)
step.nextStep({
  skipIf: [
    "Step already completed", // AI context
    (ctx) => ctx.data?.alreadyCompleted === true // Programmatic check
  ],
  prompt: "Complete this step"
});
```

**Migration:** Update `skipIf` functions to use full `TemplateContext` instead of just data.

### 4. Guideline Conditions

**Before:**
```typescript
agent.addGuideline({
  condition: "User seems frustrated", // Template type
  action: "Be extra helpful"
});

agent.addGuideline({
  condition: (ctx) => `User type is ${ctx.userType}`, // Function returning string
  action: "Adjust tone accordingly"
});
```

**After:**
```typescript
// String condition (unchanged)
agent.addGuideline({
  condition: "User seems frustrated",
  action: "Be extra helpful"
});

// Function condition (now returns boolean)
agent.addGuideline({
  condition: (ctx) => ctx.data?.userType === 'premium', // Returns boolean
  action: "Provide premium support"
});

// Mixed array condition (new capability)
agent.addGuideline({
  condition: [
    "User needs special assistance", // AI context
    (ctx) => ctx.data?.userType === 'premium' // Programmatic check
  ],
  action: "Provide premium support with priority handling"
});
```

**Migration:** Update function-based guideline conditions to return boolean instead of string.

## New Features

### Route SkipIf

Routes can now be excluded from consideration:

```typescript
agent.createRoute({
  title: "Premium Features",
  when: ["User wants premium features"],
  skipIf: [
    "Premium features are under maintenance", // AI context
    (ctx) => ctx.context?.maintenanceMode === true // Programmatic check
  ],
  // ...
});
```

### Enhanced Context Access

All condition functions now receive full `TemplateContext`:

```typescript
interface TemplateContext<TContext, TData> {
  context?: TContext;     // Agent context
  session?: SessionState<TData>; // Session state
  history?: Event[];      // Conversation history
  data?: Partial<TData>;  // Convenience alias for session.data
}

// Use in conditions
const condition = (ctx) => {
  return ctx.context?.userTier === 'premium' && 
         ctx.data?.issueType === 'billing' &&
         ctx.session?.currentRoute?.id !== 'billing_route';
};
```

## Migration Steps

### Step 1: Update Route Definitions

```typescript
// Before
const routes = [
  {
    title: "Support",
    conditions: ["User needs help"],
    // ...
  }
];

// After  
const routes = [
  {
    title: "Support", 
    when: ["User needs help"], // Renamed
    // ...
  }
];
```

### Step 2: Update Function-Based Conditions

```typescript
// Before - functions returned strings
when: (ctx) => ctx.data?.ready ? "User is ready" : null,
skipIf: (data) => data.completed === true,

// After - functions return booleans
when: (ctx) => ctx.data?.ready === true,
skipIf: (ctx) => ctx.data?.completed === true,
```

### Step 3: Update Guideline Conditions

```typescript
// Before
guidelines: [
  {
    condition: (ctx) => `User is ${ctx.userType}`,
    action: "Adjust tone"
  }
]

// After
guidelines: [
  {
    condition: (ctx) => ctx.data?.userType === 'premium',
    action: "Provide premium tone and service"
  }
]
```

### Step 4: Leverage New Capabilities

```typescript
// Add Route skipIf where appropriate
agent.createRoute({
  title: "Payment Processing",
  when: ["User wants to make payment"],
  skipIf: [
    "Payment system is down", // AI context
    (ctx) => ctx.context?.paymentSystemDown === true // Programmatic
  ]
});

// Use mixed array conditions for complex logic
step.nextStep({
  when: [
    "User is ready for advanced features", // AI context
    (ctx) => ctx.data?.experienceLevel === 'advanced', // Programmatic
    (ctx) => ctx.context?.featuresEnabled === true // Context check
  ],
  prompt: "Let's explore advanced features"
});
```

## Testing Your Migration

### 1. Verify Route Selection

Test that routes are selected correctly with new `when` conditions:

```typescript
// Test route selection
const response = await agent.respond("I need help with billing");
expect(response.session?.currentRoute?.title).toBe("Billing Support");
```

### 2. Test SkipIf Logic

Verify that routes and steps are properly skipped:

```typescript
// Test route skipIf
const contextWithMaintenance = { maintenanceMode: true };
const response = await agent.respond("I want premium features", {
  contextOverride: contextWithMaintenance
});
// Should not select premium route due to skipIf
```

### 3. Validate Guideline Activation

Test that guidelines activate correctly with new conditions:

```typescript
// Test guideline conditions
const premiumContext = { userType: 'premium' };
const response = await agent.respond("I need help", {
  contextOverride: premiumContext  
});
// Should apply premium guidelines
```

## Common Issues

### Issue 1: Function Conditions Not Working

**Problem:** Function conditions that previously returned strings now need to return booleans.

**Solution:**
```typescript
// Wrong
when: (ctx) => ctx.data?.ready ? "User is ready" : null,

// Correct  
when: (ctx) => ctx.data?.ready === true,
```

### Issue 2: SkipIf Context Access

**Problem:** `skipIf` functions now receive full context instead of just data.

**Solution:**
```typescript
// Wrong
skipIf: (data) => data.completed,

// Correct
skipIf: (ctx) => ctx.data?.completed === true,
```

### Issue 3: Guideline Condition Types

**Problem:** Guideline conditions that returned strings need to return booleans.

**Solution:**
```typescript
// Wrong
condition: (ctx) => `User is ${ctx.userType}`,

// Correct
condition: (ctx) => ctx.data?.userType === 'premium',
```

## Benefits of Migration

After migration, you'll have access to:

- **Hybrid Logic**: Combine AI understanding with programmatic precision
- **Better Performance**: Functions execute first, strings only used when needed  
- **Route Exclusion**: Use `skipIf` to dynamically exclude routes
- **Enhanced Context**: Access full context in all condition functions
- **Flexible Arrays**: Mix strings and functions for optimal control

## Support

If you encounter issues during migration:

1. Check the [API Reference](../../api/README.md) for updated interfaces
2. Review [examples](../../../examples/) for migration patterns
3. Test incrementally - migrate one route at a time
4. Use TypeScript for compile-time validation of new signatures

The new `ConditionTemplate` system provides much more flexibility while maintaining backward compatibility where possible.