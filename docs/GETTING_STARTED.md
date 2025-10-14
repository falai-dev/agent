# Getting Started

Complete guide to building your first AI agent with `@falai/agent`.

---

## Installation

```bash
# Using bun (recommended)
bun add @falai/agent

# Using npm
npm install @falai/agent

# Using yarn
yarn add @falai/agent
```

**Requirements:** Node.js 18+ or Bun 1.0+

---

## Your First Agent (5 minutes)

### 1. Set Up Your Environment

```bash
# Create a new project
mkdir my-agent && cd my-agent
bun init -y

# Install dependencies
bun add @falai/agent

# Set your API key
echo "GEMINI_API_KEY=your_key_here" > .env
```

### 2. Create Your Agent

Create `index.ts`:

```typescript
import {
  Agent,
  GeminiProvider,
  createMessageEvent,
  EventSource,
} from "@falai/agent";

// Define your context type
interface MyContext {
  userId: string;
  userName: string;
}

// Create AI provider
const ai = new GeminiProvider({
  apiKey: process.env.GEMINI_API_KEY!,
  model: "models/gemini-2.5-pro",
});

// Create your agent
const agent = new Agent<MyContext>({
  name: "MyBot",
  description: "A helpful assistant",
  ai,
  context: {
    userId: "user_123",
    userName: "Alice",
  },
});

// Add a guideline
agent.createGuideline({
  condition: "User asks for help",
  action: "Be friendly and offer specific assistance",
});

// Generate a response
const response = await agent.respond({
  history: [
    createMessageEvent(EventSource.CUSTOMER, "Alice", "Hi, I need help!"),
  ],
});

console.log("Agent:", response.message);
```

### 3. Run It!

```bash
bun run index.ts
```

🎉 **That's it!** You've created your first AI agent.

---

## Next Steps

### Add a Domain Glossary

Help your agent understand your business:

```typescript
agent
  .createTerm({
    name: "Premium Plan",
    description: "Our top-tier subscription at $99/month",
    synonyms: ["pro plan", "premium subscription"],
  })
  .createTerm({
    name: "SLA",
    description: "Service Level Agreement - our response time guarantee",
  });
```

### Create Tools

Give your agent superpowers:

```typescript
import { defineTool } from "@falai/agent";

const checkBalance = defineTool<MyContext, [accountId: string], number>(
  "check_balance",
  async ({ context }, accountId) => {
    // Your logic here
    const balance = await fetchBalance(accountId);
    return { data: balance };
  },
  { description: "Checks account balance" }
);

agent.createGuideline({
  condition: "User asks about their balance",
  action: "Use the check_balance tool to retrieve current balance",
  tools: [checkBalance],
});
```

### Build Conversation Routes

Create structured flows:

```typescript
import { END_ROUTE } from "@falai/agent";

const onboardingRoute = agent.createRoute({
  title: "User Onboarding",
  description: "Guide new users through setup",
  conditions: ["User is new and needs onboarding"],
});

// Build the flow - two approaches:

// Approach 1: Step-by-step (great for complex flows with branching)
const step1 = onboardingRoute.initialState.transitionTo({
  chatState: "Ask for user's name",
});

const step2 = step1.transitionTo({
  chatState: "Ask for user's email",
});

const step3 = step2.transitionTo({
  chatState: "Confirm details and welcome user",
});

step3.transitionTo({ state: END_ROUTE });

// Approach 2: Fluent chaining (concise for linear flows)
onboardingRoute.initialState
  .transitionTo({ chatState: "Ask for user's name" })
  .transitionTo({ chatState: "Ask for user's email" })
  .transitionTo({ chatState: "Confirm details and welcome user" })
  .transitionTo({ state: END_ROUTE });
```

### Handle Context Dynamically

Override context per request:

```typescript
const response = await agent.respond({
  history,
  contextOverride: {
    userName: "Bob", // Temporarily change user
  },
});
```

---

## Common Patterns

### Declarative Configuration

Load everything from config:

```typescript
const agent = new Agent({
  name: "ConfiguredBot",
  ai: provider,
  terms: loadTermsFromFile(),
  guidelines: loadGuidelinesFromDB(),
  routes: [
    {
      title: "Support",
      conditions: ["User needs support"],
      guidelines: [
        { condition: "Issue is urgent", action: "Escalate immediately" },
      ],
    },
  ],
});
```

### Conditional Guidelines

Add guidelines based on runtime conditions:

```typescript
if (user.isPremium) {
  agent.createGuideline({
    condition: "User asks about premium features",
    action: "Provide detailed premium feature explanations",
    tags: ["premium"],
  });
}
```

### Multi-Turn Conversations

Build up conversation history:

```typescript
const history: Event[] = [];

// Turn 1
history.push(createMessageEvent(EventSource.CUSTOMER, "User", "Hello"));
const response1 = await agent.respond({ history });
history.push(
  createMessageEvent(EventSource.AI_AGENT, "Bot", response1.message)
);

// Turn 2
history.push(createMessageEvent(EventSource.CUSTOMER, "User", "Tell me more"));
const response2 = await agent.respond({ history });
history.push(
  createMessageEvent(EventSource.AI_AGENT, "Bot", response2.message)
);
```

---

## Best Practices

### ✅ Do's

- **Use TypeScript** - Full type safety and IntelliSense
- **Define custom context** - Strongly typed context for your domain
- **Add glossary terms** - Help the agent understand your terminology
- **Use specific guidelines** - Clear conditions and actions
- **Enable/disable guidelines** - Use the `enabled` flag for A/B testing
- **Tag your guidelines** - Organize with tags for filtering

### ❌ Don'ts

- **Don't use `any` for context** - Define proper types
- **Don't skip error handling** - Wrap agent calls in try/catch
- **Don't forget to set API key** - Use environment variables
- **Don't create overly complex routes** - Keep flows simple and clear
- **Don't ignore linter warnings** - Fix TypeScript errors

---

## Troubleshooting

### "Cannot find module '@falai/agent'"

Make sure you've installed the package:

```bash
bun add @falai/agent
```

### "API Key not found"

Set your environment variable:

```bash
export GEMINI_API_KEY="your_key_here"
```

### TypeScript Errors

Ensure your `tsconfig.json` has:

```json
{
  "compilerOptions": {
    "moduleResolution": "bundler",
    "esModuleInterop": true,
    "strict": true
  }
}
```

### AI Response Timeout

Increase timeout in provider config:

```typescript
new GeminiProvider({
  apiKey: "...",
  model: "models/gemini-2.5-flash",
  retryConfig: {
    timeout: 120000, // 2 minutes
    retries: 5,
  },
});
```

---

## What's Next?

- 📚 Read the [Constructor Options Guide](./CONSTRUCTOR_OPTIONS.md)
- 🔍 Check the [API Reference](./API_REFERENCE.md)
- 🏗️ Understand the [Architecture](./STRUCTURE.md)
- 🎯 Explore [Examples](../examples/)

---

**Made with ❤️ for the community**
