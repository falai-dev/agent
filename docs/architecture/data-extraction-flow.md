# Data Extraction Flow Architecture

## Overview

@falai/agent uses an **intelligent pre-extraction system** that captures data from user messages BEFORE entering conversation steps. This eliminates repetitive questions and creates efficient, natural conversations.

## The Problem with Traditional Approaches

Traditional conversational AI follows a rigid step-by-step approach:

```
User: "I want to book the Grand Hotel for 2 people next Friday"

Traditional Flow:
Step 1: "Which hotel?" → User already said this!
Step 2: "How many guests?" → User already said this!
Step 3: "What date?" → User already said this!
```

This wastes user time and creates frustration.

## Our Solution: Pre-Extraction + Smart Step Selection

### Phase 1: Route Selection & Pre-Extraction

When a user message arrives:

1. **Route Evaluation** - AI scores all routes based on user intent
2. **Route Selection** - Best matching route is selected
3. **Pre-Extraction** - If entering a NEW route that collects data:
   - AI extracts ALL relevant data from the message
   - Data is validated against the agent schema
   - Collected data is merged into session

```typescript
// User: "I want to book the Grand Hotel for 2 people next Friday"

// Pre-extraction automatically captures:
{
  hotelName: "Grand Hotel",
  guests: 2,
  date: "next Friday"
}
```

### Phase 2: Route Completion Check

After pre-extraction, the system checks if the route is complete:

```typescript
// Route defines required fields
agent.createRoute({
  title: "Book Hotel",
  requiredFields: ["hotelName", "guests", "date"],
  // ...
});

// After pre-extraction, all required fields are present
// Route is marked as COMPLETE immediately
```

**Key Insight:** Routes complete when `requiredFields` are collected, NOT when reaching END_ROUTE step.

### Phase 3: Smart Step Selection

If route is NOT complete, determine which step to start at:

```typescript
// Steps with skipIf conditions
steps: [
  {
    id: "ask_hotel",
    collect: ["hotelName"],
    skipIf: (data) => !!data.hotelName  // ✅ SKIP - already have it
  },
  {
    id: "ask_guests",
    collect: ["guests"],
    skipIf: (data) => data.guests !== undefined  // ✅ SKIP - already have it
  },
  {
    id: "ask_date",
    collect: ["date"],
    skipIf: (data) => !!data.date  // ✅ SKIP - already have it
  }
]

// Result: All steps skipped → Route complete
```

### Phase 4: Response Generation

**If route is complete:**
- Generate completion message
- Mark step as END_ROUTE
- Exclude route from future selection

**If route is NOT complete:**
- Enter the first non-skipped step
- Generate response asking for missing data
- Continue conversation

## Complete Flow Example

### Scenario: User provides all data at once

```typescript
// Turn 1
User: "I want to book the Grand Hotel for 2 people next Friday"

System:
1. Routes to "Book Hotel" (AI scoring)
2. Pre-extracts: { hotelName: "Grand Hotel", guests: 2, date: "next Friday" }
3. Checks completion: All required fields present ✓
4. Generates completion message
5. Marks route as complete

AI: "Perfect! Booking confirmed for 2 guests at Grand Hotel on Friday!"

// Turn 2
User: "I'm feeling anxious about my visit"

System:
1. Evaluates routes
2. Excludes "Book Hotel" (already complete)
3. Routes to "General Healthcare Questions"
4. Generates response

AI: "I understand you're feeling anxious. How can I help?"
```

### Scenario: User provides partial data

```typescript
// Turn 1
User: "I want to book the Grand Hotel"

System:
1. Routes to "Book Hotel"
2. Pre-extracts: { hotelName: "Grand Hotel" }
3. Checks completion: Missing guests and date ✗
4. Evaluates steps:
   - ask_hotel: SKIP (have hotelName)
   - ask_guests: ENTER (need guests)
5. Enters ask_guests step

AI: "How many guests will be staying?"

// Turn 2
User: "2 people next Friday"

System:
1. Already in "Book Hotel" route
2. Pre-extracts: { guests: 2, date: "next Friday" }
3. Checks completion: All required fields present ✓
4. Generates completion message

AI: "Booking confirmed for 2 guests at Grand Hotel on Friday!"
```

## Key Design Decisions

### 1. Pre-Extraction Triggers

Pre-extraction only happens when:
- Entering a NEW route (not already in it)
- Route has `requiredFields`, `optionalFields`, OR steps with `collect` arrays

This minimizes unnecessary AI calls for purely conversational routes.

### 2. Route Completion Logic

A route is complete when:
- **All `requiredFields` are collected**, OR
- **Reached END_ROUTE marker in step flow**

Whichever comes first.

### 3. Completed Route Exclusion

Once a route is 100% complete:
- It's excluded from future route selection
- Users won't be forced back into finished tasks
- System falls back to other routes or general conversation

### 4. Step Skipping Logic

Steps are skipped when:
- `skipIf` condition evaluates to true
- `requires` fields are not yet collected
- Data for `collect` fields is already present

## Configuration

### Enable Pre-Extraction

Pre-extraction is automatic when you define:

```typescript
// Option 1: Route-level required fields
agent.createRoute({
  title: "Booking",
  requiredFields: ["hotel", "date", "guests"],
  // Pre-extraction enabled automatically
});

// Option 2: Route-level optional fields
agent.createRoute({
  title: "Booking",
  optionalFields: ["specialRequests"],
  // Pre-extraction enabled automatically
});

// Option 3: Steps with collect arrays
agent.createRoute({
  title: "Booking",
  steps: [
    {
      id: "ask_hotel",
      collect: ["hotel"],  // Pre-extraction enabled automatically
    }
  ]
});
```

### Disable Pre-Extraction

For purely conversational routes (no data collection):

```typescript
agent.createRoute({
  title: "General Chat",
  // No requiredFields, optionalFields, or collect arrays
  // Pre-extraction skipped automatically
  steps: [
    {
      id: "chat",
      prompt: "Have a friendly conversation"
      // No collect array
    }
  ]
});
```

## Performance Considerations

### AI Call Optimization

Pre-extraction adds ONE additional AI call when entering a new data-collecting route:

```
Traditional: N calls (one per step)
With Pre-Extraction: 1 + M calls (pre-extract + remaining steps)

Where M ≤ N (often M = 0 if all data extracted)
```

**Net Result:** Usually FEWER total AI calls due to step skipping.

### When to Use Pre-Extraction

✅ **Use for:** Data collection flows (booking, forms, surveys)
✅ **Use for:** Multi-field information gathering
❌ **Skip for:** Pure Q&A or conversational routes
❌ **Skip for:** Single-field collection

## Advanced Patterns

### Optional Fields

```typescript
agent.createRoute({
  title: "Booking",
  requiredFields: ["hotel", "date"],
  optionalFields: ["specialRequests", "dietaryRestrictions"],
  
  // Route completes when required fields are collected
  // Optional fields can be collected if user provides them
  // But won't block completion
});
```

### Conditional Completion

```typescript
agent.createRoute({
  title: "Order",
  requiredFields: ["items", "address"],
  
  steps: [
    // ... collection steps ...
    {
      id: "payment",
      when: "Ready to process payment",
      skipIf: (data) => data.paymentComplete,
      // This step runs AFTER required fields are collected
      // Allows post-completion actions
    }
  ]
});
```

### Progressive Disclosure

```typescript
agent.createRoute({
  title: "Support",
  requiredFields: ["issueType"],
  optionalFields: ["accountNumber", "orderNumber"],
  
  steps: [
    {
      id: "ask_issue",
      collect: ["issueType"],
    },
    {
      id: "ask_account",
      collect: ["accountNumber"],
      when: (data) => data.issueType === "account",
      // Only ask for account if issue is account-related
    }
  ]
});
```

## Debugging

Enable debug logging to see the extraction flow:

```typescript
const agent = new Agent({
  name: "Assistant",
  provider: new GeminiProvider({ apiKey: "..." }),
  debug: true  // Enable detailed logging
});
```

Look for these log messages:

```
[ResponseModal] Pre-extracting data for route: Book Hotel
[ResponseModal] Pre-extracted data: { hotelName: "Grand Hotel", ... }
[ResponseModal] Route Book Hotel completed after pre-extraction
[RoutingEngine] Excluding completed route: Book Hotel (100% complete)
```

## Summary

The pre-extraction system creates efficient conversations by:

1. **Extracting data early** - Before entering steps
2. **Skipping unnecessary steps** - When data is already present
3. **Completing automatically** - When required fields are collected
4. **Protecting completed routes** - Preventing re-entry

This results in natural, efficient conversations that respect user time.

---

**Next Steps:**
- [Route Configuration](../core/conversation-flows/routes.md)
- [Step Configuration](../core/conversation-flows/steps.md)
- [Schema Design](../guides/building-agents/schema-design.md)
