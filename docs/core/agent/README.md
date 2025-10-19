# Agent Architecture

## Overview

The `Agent<TContext>` class is the central orchestrator of @falai/agent, providing a strongly-typed, context-aware AI agent framework with intelligent routing and schema-driven data collection.

## Core Responsibilities

- **AI Provider Management**: Unified interface to multiple AI providers (OpenAI, Gemini, Anthropic, etc.)
- **Intelligent Routing**: AI-powered route and step selection based on conversation context
- **Context Lifecycle**: Dynamic context management with provider functions and lifecycle hooks
- **Session Management**: Conversation state persistence and multi-turn dialogue support
- **Tool Orchestration**: Hierarchical tool execution (agent → route → step level)
- **Data Collection**: Schema-driven information extraction from natural conversations

## Agent Configuration

### Basic Agent Setup

```typescript
import { Agent, OpenAIProvider } from "@falai/agent";

const agent = new Agent({
  name: "Customer Support Bot",
  description: "AI assistant for customer inquiries",
  provider: new OpenAIProvider({
    apiKey: process.env.OPENAI_API_KEY,
    model: "gpt-4",
  }),
});
```

### Advanced Configuration

```typescript
interface CustomerContext {
  userId: string;
  accountTier: "free" | "premium" | "enterprise";
  lastLogin: Date;
  preferences: {
    language: string;
    notifications: boolean;
  };
}

const agent = new Agent<CustomerContext>({
  // Identity
  name: "Premium Support Assistant",
  description: "24/7 AI support for premium customers",
  goal: "Resolve customer issues efficiently while maintaining satisfaction",

  // AI Provider with backup models
  provider: new OpenAIProvider({
    apiKey: process.env.OPENAI_API_KEY,
    model: "gpt-5",
    backupModels: ["gpt-4"],
  }),

  // Static context (can be overridden by contextProvider)
  context: {
    userId: "anonymous",
    accountTier: "free",
    lastLogin: new Date(),
    preferences: {
      language: "en",
      notifications: true,
    },
  },

  // Dynamic context provider (takes precedence over static context)
  contextProvider: async () => {
    const user = await authenticateUser(request);
    return {
      userId: user.id,
      accountTier: user.tier,
      lastLogin: user.lastLogin,
      preferences: user.preferences,
    };
  },

  // Lifecycle hooks for context and data management
  hooks: {
    // Refresh context before each response
    beforeRespond: async (currentContext) => {
      const freshUser = await db.getUser(currentContext.userId);
      return {
        ...currentContext,
        accountTier: freshUser.tier,
        lastLogin: freshUser.lastLogin,
      };
    },

    // Handle context updates from tools or responses
    onContextUpdate: async (newContext, previousContext) => {
      if (newContext.accountTier !== previousContext.accountTier) {
        await auditLog.log({
          type: "tier_change",
          userId: newContext.userId,
          from: previousContext.accountTier,
          to: newContext.accountTier,
        });
      }
    },

    // Validate and enrich collected data
    onDataUpdate: async (data, previousData) => {
      // Data validation
      if (data.email && !isValidEmail(data.email)) {
        throw new Error("Invalid email format");
      }

      // Data enrichment
      if (data.userId && !data.userProfile) {
        data.userProfile = await db.getUserProfile(data.userId);
      }

      return data;
    },
  },

  // Optional initial session
  session: createSession({
    data: { onboardingComplete: false },
  }),

  // Optional persistence configuration
  persistence: {
    adapter: new RedisAdapter(redisClient),
    autoSave: true, // Auto-save after each response
    userId: "global", // Or dynamic based on context
  },

  // Domain knowledge
  terms: [
    {
      name: "Premium Support",
      description: "24/7 priority assistance with 1-hour response guarantee",
      synonyms: ["priority support", "vip assistance"],
    },
  ],

  // Behavioral guidelines
  guidelines: [
    {
      condition: "Customer seems frustrated",
      action: "Apologize sincerely and offer to escalate to human agent",
      enabled: true,
    },
    {
      condition: "Premium customer requests",
      action: "Provide expedited service and additional options",
      enabled: true,
    },
  ],

  // Global tools available to all routes
  tools: [searchTool, userLookupTool],

  // Knowledge base for AI context
  knowledgeBase: {
    company: {
      name: "Acme Corp",
      supportHours: "24/7 for premium, 9-5 for free",
      refundPolicy: "30 days for all purchases",
    },
    products: {
      basic: {
        price: "$9.99/month",
        features: ["Email support", "5GB storage"],
      },
      premium: {
        price: "$29.99/month",
        features: ["24/7 support", "100GB storage", "Priority queue"],
      },
    },
  },
});
```

## Context Management

### Static Context

Fixed context available throughout the conversation:

```typescript
const agent = new Agent({
  context: {
    companyName: "Acme Corp",
    supportEmail: "support@acme.com",
    currentDate: new Date().toISOString(),
  },
});
```

### Dynamic Context Provider

Fresh context fetched before each response:

```typescript
const agent = new Agent({
  contextProvider: async () => {
    // Fetch real-time data
    const weather = await weatherAPI.getCurrentWeather();
    const user = await auth.getCurrentUser();

    return {
      currentWeather: weather,
      userProfile: user,
      serverTime: new Date(),
    };
  },
});
```

### Context Updates

Context can be modified during conversation:

```typescript
// From tool execution
const updateLocationTool: Tool<
  { currentLocation?: string; lastLocationUpdate?: Date },
  [],
  string,
  { location: string }
> = {
  id: "update_location",
  description: "Update user's current location",
  parameters: {
    type: "object",
    properties: {
      location: { type: "string", description: "New location to set" },
    },
    required: ["location"],
  },
  handler: async ({ context }, { location }) => {
    return {
      data: `Location updated to ${location}`,
      contextUpdate: {
        currentLocation: location,
        lastLocationUpdate: new Date(),
      },
    };
  },
};

// Programmatically
await agent.updateContext({
  userStatus: "premium",
  lastActivity: new Date(),
});
```

## Session Management

### Session Creation

```typescript
import { createSession } from "@falai/agent";

// Basic session
const session = createSession();

// Session with initial data
const sessionWithData = createSession({
  data: {
    userName: "John",
    step: 1,
  },
});

// Session with metadata
const sessionWithMeta = createSession({
  data: {},
  metadata: {
    source: "web_chat",
    userAgent: "Chrome/91.0",
  },
});
```

### Session Persistence

```typescript
const agent = new Agent({
  persistence: {
    adapter: new RedisAdapter(redisClient),
    autoSave: true, // Auto-save after each response
    userId: "user_123",
  },
});

// Manual save
await agent.persistence?.adapter.session.save(session.id, session);

// Manual load
const savedSession = await agent.persistence?.adapter.session.findById(
  sessionId
);
```

### Convenience Methods

```typescript
// Set current session for method convenience
agent.setCurrentSession(session);

// Get data without specifying session
const data = agent.getData(); // Uses current session

// Get route-specific data
const onboardingData = agent.getData("user-onboarding");

// Clear session
agent.clearCurrentSession();
```

## Route Management

### Declarative Route Creation

```typescript
const agent = new Agent({
  routes: [
    {
      title: "Technical Support",
      description: "Help with technical issues",
      conditions: ["user reports technical problem"],
      initialStep: {
        prompt:
          "I understand you're having a technical issue. Can you describe what's happening?",
        collect: ["problem", "severity"],
      },
    },
    {
      title: "Billing Inquiry",
      description: "Handle billing and payment questions",
      conditions: ["user asks about billing or payment"],
      initialStep: {
        prompt:
          "I'd be happy to help with your billing question. What can I assist with?",
        collect: ["billingIssue"],
      },
    },
  ],
});
```

### Programmatic Route Creation

```typescript
// Create routes dynamically
const supportRoute = agent
  .createRoute({
    title: "Customer Support",
    initialStep: {
      prompt: "How can I help you today?",
      collect: ["intent"],
    },
  })
  .nextStep({
    prompt: "I understand you need help with {{intent}}",
    requires: ["intent"],
  });

// Access created routes
const routes = agent.getRoutes();
console.log(routes.map((r) => r.title)); // ["Customer Support", ...]
```

## Tool Integration

### Agent-Level Tools

Available to all routes and steps:

```typescript
const agent = new Agent({
  tools: [searchTool, calculatorTool, translationTool],
});
```

### Route-Level Tools

Specific to a route:

```typescript
const route = agent.createRoute({
  title: "Order Management",
  tools: [orderLookupTool, orderUpdateTool, refundTool],
});
```

### Tool Resolution Priority

1. **Step-level tools** (highest priority)
2. **Route-level tools**
3. **Agent-level tools** (lowest priority)

## Response Generation

### Synchronous Response

```typescript
const history = [
  { kind: "message", source: "user", content: "How do I reset my password?" },
];

const response = await agent.respond({ history });
console.log(response.message);
console.log(response.session?.data); // Any collected data
console.log(response.toolCalls); // Any tool calls made
console.log(response.isRouteComplete); // Whether route finished
```

### Streaming Response

```typescript
const stream = agent.respondStream({ history });

for await (const chunk of stream) {
  if (chunk.delta) {
    process.stdout.write(chunk.delta); // Real-time output
  }

  if (chunk.done) {
    console.log("\nFinal session:", chunk.session);
    console.log("Tool calls:", chunk.toolCalls);
  }
}
```

### Response with Custom Context

```typescript
const response = await agent.respond({
  history,
  contextOverride: {
    language: "es", // Override context for this response
    debug: true,
  },
  session: customSession, // Use specific session
});
```

## Advanced Features

### Route Transitions

```typescript
// Manual route transition
await agent.nextStepRoute("premium-support", session);

// Route completion transitions
const supportRoute = agent.createRoute({
  title: "Basic Support",
  onComplete: "feedback-survey", // Auto-transition when complete
});

// Dynamic transitions
const dynamicRoute = agent.createRoute({
  title: "Workflow",
  onComplete: async (session, context) => {
    if (session.data.success) {
      return "success-route";
    }
    return "retry-route";
  },
});
```

### Debugging

```typescript
const debugAgent = new Agent({
  name: "Debug Agent",
  debug: true, // Enables detailed logging
  provider: openaiProvider,
});

// Logs will show:
// [Agent] Selected route: Technical Support
// [Agent] Entered step: initial_step
// [Agent] Tool executed: search_kb (success: true)
// [RoutingEngine] AI selected step: detailed_help
```

## Agent and Route Option Merging

@fai/agent supports hierarchical configuration where route-level options can override or merge with agent-level options. Understanding this behavior is crucial for effective agent design.

### Guidelines and Terms

**Guidelines** are combined from both agent and route levels:

- Agent-level guidelines are applied first
- Route-level guidelines are added after agent guidelines
- All guidelines are evaluated together during response generation

```typescript
const agent = new Agent({
  guidelines: [
    { id: "polite", action: "Always be polite and professional" },
    { id: "accurate", action: "Provide accurate information" },
  ],
});

const route = agent.createRoute({
  guidelines: [
    {
      id: "domain_specific",
      action: "Use technical terminology appropriately",
    },
  ],
});
// Result: All 3 guidelines (polite, accurate, domain_specific) are used
```

**Terms** use route-level precedence:

- Agent-level terms are loaded first
- Route-level terms with the same name override agent-level terms
- This allows routes to provide domain-specific definitions

```typescript
const agent = new Agent({
  terms: [{ name: "API", description: "Application Programming Interface" }],
});

const route = agent.createRoute({
  terms: [
    {
      name: "API",
      description: "In this context, API refers to our REST API endpoints",
    },
  ],
});
// Result: Route's definition of "API" takes precedence
```

### Tools

**Tools** follow a hierarchical priority system:

1. Step-level tools (highest priority)
2. Route-level tools
3. Agent-level tools (lowest priority)

Tools with the same ID at different levels will be resolved by priority, with higher-level tools taking precedence.

### Lifecycle Hooks

**Lifecycle hooks** are called at both agent and route levels:

- Agent-level hooks are called for all routes
- Route-level hooks are called only for that specific route
- Both types of hooks can modify context and data

## Best Practices

### Context Design

- **Keep context focused**: Only include data needed across conversations
- **Use providers for freshness**: Prefer `contextProvider` over static context for dynamic data
- **Handle updates gracefully**: Use lifecycle hooks for validation and side effects

### Session Management

- **Set up persistence early**: Configure persistence for production use
- **Use meaningful session IDs**: Include user/context identifiers
- **Clean up old sessions**: Implement retention policies

### Route Organization

- **Single responsibility**: Each route should serve one clear user intent
- **Progressive disclosure**: Collect information in logical order
- **Clear completion criteria**: Define when routes should end

### Tool Management

- **Hierarchical scoping**: Use appropriate tool levels for security and performance
- **Error handling**: Implement robust error recovery in tools
- **Performance monitoring**: Track tool usage and response times

### Performance Optimization

- **Limit concurrent sessions**: Implement session limits for high-traffic scenarios
- **Cache context data**: Avoid redundant API calls in context providers
- **Batch operations**: Group related tool calls when possible

## Migration from Legacy Agents

### From Domain-Based to Route-Based

```typescript
// Legacy (domain-based)
const legacyAgent = new Agent({
  domains: ["calendar", "email"],
});

// New (route-based)
const newAgent = new Agent({
  routes: [
    {
      title: "Calendar Management",
      tools: [calendarTool], // Route-specific tools
    },
    {
      title: "Email Management",
      tools: [emailTool],
    },
  ],
});
```

### From Static to Dynamic Context

```typescript
// Legacy (static context)
const staticAgent = new Agent({
  context: { userId: "123" },
});

// New (dynamic context)
const dynamicAgent = new Agent({
  contextProvider: async () => {
    return { userId: await auth.getCurrentUserId() };
  },
});
```

The Agent class provides a comprehensive foundation for building intelligent, context-aware AI applications with robust conversation management and data collection capabilities.
