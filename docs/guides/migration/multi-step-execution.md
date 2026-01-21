# Multi-Step Execution Migration Guide

This guide covers the behavioral changes from single-step to multi-step execution and provides migration guidance for existing routes.

## Breaking Changes in v1.0.0

### History API Simplified

The `createMessageEvent` and `EventSource` exports have been replaced with simpler helper functions:

**Before (v0.x):**
```typescript
import { createMessageEvent, EventSource } from "@falai/agent";

const history = [
  createMessageEvent(EventSource.CUSTOMER, "Hello"),
  createMessageEvent(EventSource.AI_AGENT, "Hi there!"),
];
```

**After (v1.0.0):**
```typescript
import { userMessage, assistantMessage } from "@falai/agent";

const history = [
  userMessage("Hello"),
  assistantMessage("Hi there!"),
];
```

The history is now a simple array of objects with `role` and `content` properties:

```typescript
// Available helper functions
import { 
  userMessage,      // (content, name?) => { role: "user", content, name? }
  assistantMessage, // (content, toolCalls?) => { role: "assistant", content, tool_calls? }
  toolMessage,      // (toolCallId, name, content) => { role: "tool", ... }
  systemMessage,    // (content) => { role: "system", content }
} from "@falai/agent";

// Or create history items directly
const history = [
  { role: "user", content: "Hello" },
  { role: "assistant", content: "Hi there!" },
];
```

### StepOptions: `instructions` → `prompt`

The `instructions` property in `StepOptions` has been renamed to `prompt`:

**Before:**
```typescript
steps: [
  {
    id: "greeting",
    instructions: "Greet the user warmly",
  }
]
```

**After:**
```typescript
steps: [
  {
    id: "greeting",
    prompt: "Greet the user warmly",
  }
]
```

---

## Overview

Multi-step execution is a **major behavioral change** that allows multiple consecutive steps to execute in a single LLM call. While the public API shape remains compatible, the execution semantics differ from the previous single-step model.

## Key Behavioral Changes

### Before: Single-Step Execution

Previously, each `.respond()` call executed exactly one step:

```typescript
// Turn 1
const response1 = await agent.respond("Book Grand Hotel for 2 on Friday");
// Executes: ask-hotel step
// Response: "What date would you like to book?"

// Turn 2
const response2 = await agent.respond("Friday");
// Executes: ask-date step
// Response: "How many guests?"

// Turn 3
const response3 = await agent.respond("2 people");
// Executes: ask-guests step
// Response: "Booking confirmed!"

// Total: 3 LLM calls
```

### After: Multi-Step Execution

Now, multiple steps can execute in a single call when data requirements are satisfied:

```typescript
// Turn 1
const response = await agent.respond("Book Grand Hotel for 2 on Friday");
// Pre-extraction captures: { hotel: "Grand Hotel", date: "Friday", guests: 2 }
// Executes: ask-hotel, ask-date, ask-guests steps (all in one batch)
// Response: "Booking confirmed for 2 guests at Grand Hotel on Friday!"

// Total: 1 LLM call
```

## What Changed

| Aspect | Before | After |
|--------|--------|-------|
| Steps per call | Always 1 | 1 or more (batched) |
| LLM calls | One per step | One per batch |
| Pre-extraction | Per-step | Before batch determination |
| Response fields | Basic | Includes `executedSteps`, `stoppedReason` |
| Hook execution | Per-step | All prepare hooks, then LLM, then all finalize hooks |

## Migration Checklist

### 1. Review Hook Dependencies

If your hooks depend on being called between steps, they may need adjustment:

```typescript
// Before: Hooks called between each step
const step1 = {
  finalize: async (ctx, data) => {
    // This ran before step2's prepare
    await saveProgress(data);
  }
};

const step2 = {
  prepare: async (ctx, data) => {
    // This expected step1's finalize to have run
    const progress = await loadProgress();
  }
};

// After: All prepare hooks run first, then all finalize hooks
// If step1 and step2 are batched together:
// 1. step1.prepare runs
// 2. step2.prepare runs
// 3. LLM call
// 4. step1.finalize runs
// 5. step2.finalize runs

// Migration: Use session data instead of external state
const step1 = {
  finalize: async (ctx, data) => {
    // Store in session data, not external state
    data.step1Complete = true;
  }
};

const step2 = {
  prepare: async (ctx, data) => {
    // Check session data
    if (!data.step1Complete) {
      // Handle case where step1 hasn't finalized yet
    }
  }
};
```

### 2. Update Response Handling

Check for new response fields:

```typescript
// Before
const response = await agent.respond(message);
console.log(response.message);
console.log(response.isRouteComplete);

// After - additional fields available
const response = await agent.respond(message);
console.log(response.message);
console.log(response.isRouteComplete);
console.log(response.executedSteps);    // NEW: Array of executed steps
console.log(response.stoppedReason);    // NEW: Why execution stopped
console.log(response.error);            // NEW: Error details if any
```

### 3. Review SkipIf Conditions

SkipIf conditions now affect batch determination:

```typescript
// Before: skipIf evaluated when entering step
const step = {
  skipIf: (data) => {
    // Called when transitioning to this step
    return data.alreadyHaveInfo;
  }
};

// After: skipIf evaluated during batch determination
// If skipIf returns true, step is skipped and next step is evaluated
// If skipIf throws, step is treated as non-skippable (included in batch)

// Migration: Ensure skipIf is pure and doesn't have side effects
const step = {
  skipIf: (data) => {
    // GOOD: Pure function
    return data.alreadyHaveInfo;
  }
};

// AVOID: Side effects in skipIf
const badStep = {
  skipIf: (data) => {
    // BAD: Side effect
    logSkipCheck(data);
    return data.alreadyHaveInfo;
  }
};
```

### 4. Handle Partial Execution

Errors may leave partial progress:

```typescript
// Before: Single step, all or nothing

// After: Batch may partially complete
const response = await agent.respond(message);

if (response.stoppedReason === 'prepare_error') {
  // Some steps may have executed before the error
  console.log("Executed before error:", response.executedSteps);
  console.log("Error details:", response.error);
}
```

### 5. Update Tests

Tests expecting single-step behavior need updates:

```typescript
// Before
test("collects hotel name", async () => {
  const response = await agent.respond("Book Grand Hotel");
  expect(response.session.data.hotel).toBe("Grand Hotel");
  // Assumed only hotel step executed
});

// After
test("collects hotel name", async () => {
  const response = await agent.respond("Book Grand Hotel");
  expect(response.session.data.hotel).toBe("Grand Hotel");
  
  // Check which steps actually executed
  expect(response.executedSteps).toContainEqual(
    expect.objectContaining({ id: "ask-hotel" })
  );
  
  // May have executed more steps if data was available
  expect(response.stoppedReason).toBe("needs_input");
});
```

## Before/After Examples

### Example 1: Simple Booking Flow

**Before (3 turns):**
```
User: "I want to book a hotel"
Bot: "Which hotel would you like?"
User: "Grand Hotel"
Bot: "What date?"
User: "Friday"
Bot: "Booking confirmed!"
```

**After (potentially 1-2 turns):**
```
User: "I want to book Grand Hotel for Friday"
Bot: "Booking confirmed for Grand Hotel on Friday!"
```

### Example 2: Partial Information

**Before:**
```
User: "Book Grand Hotel"
Bot: "What date?" (only hotel step executed)
```

**After:**
```
User: "Book Grand Hotel"
Bot: "What date?" (hotel step executed, stopped at date step)
// response.executedSteps = [{ id: "ask-hotel" }]
// response.stoppedReason = "needs_input"
```

### Example 3: With SkipIf Conditions

**Before:**
```typescript
// Each step evaluated individually
const step1 = { skipIf: (d) => !!d.name };  // Skipped if name exists
const step2 = { skipIf: (d) => !!d.email }; // Skipped if email exists
```

**After:**
```typescript
// All skipIf conditions evaluated during batch determination
// If user provides "I'm John, john@example.com":
// - Pre-extraction: { name: "John", email: "john@example.com" }
// - step1 skipIf: true (skipped)
// - step2 skipIf: true (skipped)
// - Both steps skipped, route may complete immediately
```

## Opting Out of Batching

If you need single-step behavior for specific steps, use `requires` to create dependencies:

```typescript
// Force step2 to wait for step1's data
const step1 = {
  collect: ["name"],
};

const step2 = {
  collect: ["email"],
  requires: ["name"], // Won't batch with step1
};

// Now step2 will only execute after step1 completes
// (in a separate batch/LLM call)
```

## Debugging Migration Issues

Enable debug mode to see batch behavior:

```typescript
const agent = new Agent({
  debug: true,
  // ...
});

// Logs will show:
// [BatchExecutor] Starting batch determination...
// [BatchExecutor] Including step ask-hotel in batch
// [BatchExecutor] Step ask-date needs input, stopping batch
```

## Summary

1. **Multiple steps can now execute together** - reducing LLM calls
2. **Pre-extraction happens before batch determination** - maximizing batching
3. **New response fields** - `executedSteps`, `stoppedReason`, `error`
4. **Hook execution order changed** - all prepare, then LLM, then all finalize
5. **SkipIf affects batching** - evaluated during batch determination
6. **Partial progress preserved** - on errors, completed steps are retained

The changes improve efficiency and UX while maintaining API compatibility. Most existing code will work without changes, but reviewing hook dependencies and test expectations is recommended.
