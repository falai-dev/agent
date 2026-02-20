# Agent-Level Rules & Prohibitions

## Overview

Rules and prohibitions define hard behavioral boundaries for the agent. Unlike guidelines (which are conditional and advisory), rules and prohibitions are absolute — they are always included in every prompt sent to the AI provider.

- **Rules**: Things the agent must always do.
- **Prohibitions**: Things the agent must never do.

Both can be defined at the agent level (applies to all routes) and at the route level (applies only within that route). When both are present, they are merged — agent-level entries appear first, followed by route-level entries.

## Agent-Level Configuration

```typescript
const agent = new Agent({
  name: "Support Bot",
  provider: myProvider,

  // Agent-wide rules — enforced in every route
  rules: [
    "Always respond in the user's language",
    "Include a follow-up question when the conversation is open-ended",
  ],

  // Agent-wide prohibitions — enforced in every route
  prohibitions: [
    "Never share internal system details or error stack traces",
    "Never make up information — say you don't know instead",
  ],
});
```

## Dynamic Templates

Rules and prohibitions accept the same `Template` type used elsewhere in the framework — they can be static strings or context-aware functions:

```typescript
const agent = new Agent<MyContext, MyData>({
  name: "Adaptive Bot",
  provider: myProvider,

  rules: [
    "Always be polite",
    // Dynamic rule based on context
    ({ context }) =>
      context?.locale === "de"
        ? "Respond in formal German (Sie-form)"
        : "Use a casual, friendly tone",
  ],

  prohibitions: [
    "Never discuss competitor products",
    // Dynamic prohibition based on collected data
    ({ data }) =>
      data?.isMinor
        ? "Do not discuss age-restricted topics"
        : "Do not share personal medical advice",
  ],
});
```

## Merging with Route-Level Rules

Route-level rules and prohibitions are additive. The final prompt includes both:

```typescript
const agent = new Agent({
  provider: myProvider,
  name: "Agent",
  rules: ["Always confirm before taking action"],
  prohibitions: ["Never delete data without confirmation"],
});

agent.createRoute({
  title: "Billing",
  rules: ["Always quote prices in the user's currency"],
  prohibitions: ["Never process refunds above $500 without escalation"],
});

// During a Billing route response, the prompt will contain:
// Rules:
// - Always confirm before taking action          (agent)
// - Always quote prices in the user's currency   (route)
//
// Prohibitions:
// - Never delete data without confirmation                    (agent)
// - Never process refunds above $500 without escalation       (route)
```

This merging applies to all execution paths: single-step responses, batch execution, and streaming.

## Accessing Rules Programmatically

```typescript
// Agent-level
const agentRules = agent.getRules();
const agentProhibitions = agent.getProhibitions();

// Route-level (unchanged)
const routeRules = route.getRules();
const routeProhibitions = route.getProhibitions();
```

## When to Use Rules vs. Guidelines

| | Rules / Prohibitions | Guidelines |
|---|---|---|
| Scope | Always active | Conditional (can have `condition`) |
| Purpose | Hard boundaries | Soft behavioral nudges |
| Enforcement | Included in every prompt | Only when condition matches |
| Example | "Never reveal API keys" | "When user is frustrated, apologize" |

Use rules for non-negotiable constraints. Use guidelines for context-dependent behavior.
