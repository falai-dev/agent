# Architecture & Design Principles

## Overview

`@falai/agent` is built on a **state machine-driven architecture** inspired by [Parlant/Emcie](https://github.com/emcie-co/parlant), where tools execute automatically based on conversation flow rather than AI decision-making. This creates deterministic, controllable, and predictable agent behavior.

## Core Design Principles

### 1. 🎯 State Machine First

Conversations are modeled as **explicit state machines** using the Route DSL:

```typescript
const route = agent.createRoute({
  title: "Onboarding Flow",
  description: "Collect user information step by step",
  conditions: ["User wants to sign up"],
});

// Define states and transitions explicitly
route.initialState
  .transitionTo({ chatState: "Ask for name" })
  .transitionTo({ toolState: saveName }, "User provided name")
  .transitionTo({ chatState: "Ask for email" })
  .transitionTo({ toolState: saveEmail }, "User provided email")
  .transitionTo({ state: END_ROUTE });
```

**Why?** Explicit state machines make conversation flows:

- **Predictable** - You know exactly what happens when
- **Testable** - Each state transition can be unit tested
- **Debuggable** - Clear state progression makes issues obvious
- **Maintainable** - Easy to modify flow without breaking things

### 2. 🔧 Automatic Tool Execution

Tools **execute automatically** when triggered by the state machine or guideline matching - the AI never decides when to call tools.

```typescript
// ✅ CORRECT: Tool executes automatically when state is reached
askName.transitionTo({ toolState: saveName }, "User provided their name");

// ✅ CORRECT: Tool executes when guideline matches
agent.createGuideline({
  condition: "User asks about pricing",
  action: "Explain our pricing structure",
  tools: [fetchCurrentPricing], // Auto-executes when guideline matches
});

// ❌ WRONG: Don't expect AI to call tools
agent.createCapability({
  title: "Save Data",
  tools: [saveName], // AI sees this but can't call it
});
```

**Why?** Automatic execution ensures:

- **Reliability** - Tools always execute when they should
- **Security** - You control tool execution, not the AI
- **Determinism** - Same conversation always triggers same tools
- **Separation of Concerns** - AI generates messages, engine executes tools

### 3. 🧠 AI as Message Generator Only

The AI's **only job** is to generate natural, conversational messages to users. It never:

- Decides which tools to call
- Controls conversation flow
- Makes routing decisions
- Manages state transitions

```typescript
// The AI only sees:
// 1. Agent identity & description
// 2. Conversation history
// 3. Context variables (updated by tools)
// 4. Guidelines to follow
// 5. Available routes
// 6. Glossary terms

// The AI NEVER sees:
// ❌ Available tools
// ❌ Tool signatures
// ❌ Domain definitions
// ❌ Tool execution results (sees context updates instead)
```

**Why?** This creates:

- **Predictable behavior** - AI can't go "off script"
- **Cost efficiency** - Smaller prompts = lower API costs
- **Faster responses** - Less for AI to process
- **Better quality** - AI focuses on one thing: good messages

### 4. 🔄 Preparation Iteration Loop

Before generating a message, the agent runs **preparation iterations** to gather all needed data:

```
┌─────────────────────────────────────────────────┐
│ 1. New message arrives                          │
└─────────────────┬───────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────┐
│ 2. Match guidelines against context             │
│    - Which guidelines apply now?                │
│    - Do they have tools attached?               │
└─────────────────┬───────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────┐
│ 3. Execute tools for matched guidelines         │
│    - Run tools automatically                    │
│    - Collect results & context updates          │
└─────────────────┬───────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────┐
│ 4. Execute state machine transitions            │
│    - If state has toolState → execute it        │
│    - Update context with results                │
└─────────────────┬───────────────────────────────┘
                  │
                  ▼
        ┌─────────┴─────────┐
        │ Tools executed?   │
        └─────────┬─────────┘
                  │
        ┌─────────┴─────────┐
        │ Yes         │ No  │
        ▼             ▼
   ┌─────────┐  ┌────────────┐
   │ Loop    │  │ Generate   │
   │ again   │  │ message    │
   └─────────┘  └────────────┘
```

**Why?** This enables:

- **Multi-step data gathering** - Tools can trigger more tools
- **Context enrichment** - Each iteration adds more context
- **Dynamic flows** - Tool results can change which guidelines match
- **Efficiency** - One message generation with complete context

### 5. 📦 Domain-Based Tool Organization

Tools are organized into **domains** for better structure and access control:

```typescript
// Register tools by domain
agent.addDomain("user", {
  saveProfile: async (data) => {
    /* ... */
  },
  updatePreferences: async (prefs) => {
    /* ... */
  },
});

agent.addDomain("payment", {
  processPayment: async (amount) => {
    /* ... */
  },
  refund: async (id) => {
    /* ... */
  },
});

// Route-level access control
const checkoutRoute = agent.createRoute({
  title: "Checkout",
  domains: ["payment"], // SECURITY: Only payment tools can execute in this route
});

const profileRoute = agent.createRoute({
  title: "Profile Setup",
  domains: ["user"], // SECURITY: Only user tools can execute
});

const generalRoute = agent.createRoute({
  title: "General Chat",
  // No domains = ALL tools available (default behavior)
});
```

**Important**: Domains are for **internal tool filtering**, not AI prompts:

- ✅ Engine uses domains to filter which tools can execute
- ✅ Prevents accidental/malicious tool calls outside intended routes
- ❌ AI never sees domains (they're not in prompts)
- ❌ Domains don't affect what AI says, only what tools can run

**Why?** Domains provide:

- **Security** - Prevent prompt injection attacks from calling sensitive tools
- **Route Isolation** - Checkout route can't accidentally trigger user profile tools
- **Organization** - Logical grouping of related tools
- **Optional** - Routes without domains have access to all tools (simple default)
- **Scalability** - Add new domains without affecting existing ones

**Example Security Scenario**:

```typescript
// Without domains: Malicious user in chat could trigger payment processing
// With domains: Payment tools only available in checkout route
const chatRoute = agent.createRoute({
  title: "General Chat",
  domains: ["chat", "user"], // Can't execute payment tools
});

const checkoutRoute = agent.createRoute({
  title: "Checkout",
  domains: ["payment"], // Can execute payment, but not unrelated tools
});
```

### 6. 🎭 Context-Driven Behavior

Agent behavior adapts based on **context** - not hardcoded logic:

```typescript
interface MyContext {
  userId: string;
  plan: "free" | "pro" | "enterprise";
  remainingCredits: number;
}

const agent = new Agent<MyContext>({
  name: "Assistant",
  ai: provider,
  context: {
    userId: "user123",
    plan: "pro",
    remainingCredits: 100,
  },
  hooks: {
    // Refresh context before each response
    beforeRespond: async (ctx) => {
      const freshData = await db.getUser(ctx.userId);
      return { ...ctx, remainingCredits: freshData.credits };
    },

    // Persist context updates
    onContextUpdate: async (newCtx, oldCtx) => {
      await db.updateUser(newCtx.userId, {
        credits: newCtx.remainingCredits,
      });
    },
  },
});

// Guidelines can reference context
agent.createGuideline({
  condition: "User requests a feature",
  action:
    "If context.plan is 'free', explain upgrade benefits. Otherwise provide the feature.",
});

// Tools receive and update context
const useFeature = defineTool<MyContext, [feature: string], boolean>(
  "use_feature",
  async (toolContext, feature) => {
    return {
      data: true,
      contextUpdate: {
        remainingCredits: toolContext.context.remainingCredits - 1,
      },
    };
  }
);
```

**Why?** Context-driven design enables:

- **Personalization** - Behavior adapts to each user
- **State persistence** - Context survives across conversations
- **Dynamic guidelines** - Rules that depend on user state
- **Tool integration** - Tools update context for next iteration

### 7. 📝 Declarative Over Imperative

Configuration is **declarative** - you describe what you want, not how to do it:

```typescript
// ✅ DECLARATIVE: Describe the desired behavior
const agent = new Agent({
  name: "Support Agent",
  description: "Helpful and empathetic customer support",
  goal: "Resolve customer issues efficiently",
  ai: provider,
  terms: [
    {
      name: "SLA",
      description: "Service Level Agreement - 24hr response time",
    },
  ],
  guidelines: [
    {
      condition: "Customer is frustrated",
      action: "Apologize sincerely and escalate to human if needed",
    },
  ],
  routes: [
    {
      title: "Refund Request",
      conditions: ["Customer wants a refund"],
      rules: ["Always check order date before processing"],
      prohibitions: ["Never process refunds over $1000 without approval"],
    },
  ],
});

// ❌ IMPERATIVE: Manual control flow
if (userMessage.includes("refund")) {
  if (orderDate < thirtyDaysAgo) {
    if (amount <= 1000) {
      processRefund();
    } else {
      requestApproval();
    }
  }
}
```

**Why?** Declarative configuration:

- **Reads like documentation** - Easy to understand intent
- **Less boilerplate** - Framework handles the "how"
- **Easier to maintain** - Change behavior by changing config
- **Better for non-coders** - Business logic in plain terms

## Comparison with Other Approaches

### @falai/agent vs OpenAI Function Calling

| Aspect             | @falai/agent                  | OpenAI Functions                   |
| ------------------ | ----------------------------- | ---------------------------------- |
| **Tool Execution** | Automatic (state machine)     | AI-decided                         |
| **Flow Control**   | Explicit routes & states      | AI inference                       |
| **Determinism**    | High - same input = same flow | Low - AI may vary                  |
| **Debugging**      | Clear state progression       | Black box AI decisions             |
| **Cost**           | Lower - tools not in prompts  | Higher - full tool specs in prompt |
| **Use Case**       | Structured conversations      | Flexible, open-ended tasks         |

### When to Use @falai/agent

✅ **Great for:**

- Customer support workflows
- Onboarding flows
- Multi-step processes
- Compliance-sensitive applications
- Predictable conversation paths
- Tool-heavy applications

❌ **Not ideal for:**

- Open-ended creative tasks
- Scenarios where AI judgment is critical
- Rapid prototyping without clear flows
- Simple Q&A without state

## Design Influences

This framework draws inspiration from:

1. **[Parlant/Emcie](https://github.com/emcie-co/parlant)** - Preparation iteration loop, guideline-driven execution
2. **State Machines** - Explicit state modeling for predictability
3. **Railway-Oriented Programming** - Fluent APIs with chaining
4. **Domain-Driven Design** - Organizing capabilities by domain
5. **React Hooks** - Lifecycle hooks pattern for extensibility

## Further Reading

- [Getting Started Guide](./GETTING_STARTED.md) - Build your first agent
- [API Reference](./API_REFERENCE.md) - Complete API documentation
- [Route DSL Guide](./STRUCTURE.md) - State machine patterns
- [Provider Docs](./PROVIDERS.md) - AI provider configuration
- [Examples](/examples) - Real-world agent implementations

---

**Questions?** Open an issue or discussion on [GitHub](https://github.com/gusnips/falai).
