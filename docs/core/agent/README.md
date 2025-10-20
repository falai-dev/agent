# Agent Architecture

## Overview

The `Agent<TContext, TData>` class is the central orchestrator of @falai/agent, providing a strongly-typed, context-aware AI agent framework with intelligent routing and agent-level schema-driven data collection.

## Core Responsibilities

- **AI Provider Management**: Unified interface to multiple AI providers (OpenAI, Gemini, Anthropic, etc.)
- **Intelligent Routing**: AI-powered route and step selection based on conversation context
- **Context Lifecycle**: Dynamic context management with provider functions and lifecycle hooks
- **Session Management**: Conversation state persistence and multi-turn dialogue support
- **Tool Orchestration**: Hierarchical tool execution (agent → route → step level)
- **Agent-Level Data Collection**: Centralized schema-driven information extraction shared across all routes

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

interface CustomerData {
  customerName?: string;
  email?: string;
  phone?: string;
  issueType?: 'booking' | 'billing' | 'technical' | 'other';
  issueDescription?: string;
  priority?: 'low' | 'medium' | 'high';
  rating?: number;
  comments?: string;
}

const agent = new Agent<CustomerContext, CustomerData>({
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

  // Agent-level data schema (NEW)
  schema: {
    type: "object",
    properties: {
      customerName: { type: "string" },
      email: { type: "string", format: "email" },
      phone: { type: "string" },
      issueType: { type: "string", enum: ["booking", "billing", "technical", "other"] },
      issueDescription: { type: "string" },
      priority: { type: "string", enum: ["low", "medium", "high"] },
      rating: { type: "number", minimum: 1, maximum: 5 },
      comments: { type: "string" }
    }
  },

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

    // Validate and enrich collected data (NEW: Agent-level data hooks)
    onDataUpdate: async (data, previousData) => {
      // Data validation against agent schema
      if (data.email && !isValidEmail(data.email)) {
        throw new Error("Invalid email format");
      }

      // Data enrichment using agent-level data
      if (data.customerName && !data.customerId) {
        data.customerId = await lookupCustomerId(data.customerName);
      }

      // Auto-set priority based on issue type
      if (data.issueType === 'billing' && !data.priority) {
        data.priority = 'high';
      }

      return data;
    },
  },

  // Optional sessionId for automatic session loading/creation
  sessionId: "user-123", // Agent will automatically load or create this session

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

### Automatic Session Management

Sessions are automatically managed through the integrated `SessionManager`:

```typescript
// Agent with automatic session management
const agent = new Agent({
  name: "Assistant",
  provider: new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY }),
  persistence: { adapter: new PrismaAdapter({ prisma }) },
  sessionId: "user-123" // Automatically loads or creates this session
});

// Access session manager
const sessionManager = agent.session;

// Get or create session (handles existing, new, or auto-generated IDs)
await sessionManager.getOrCreate("user-456");
await sessionManager.getOrCreate(); // Auto-generates ID

// Session data access
const data = sessionManager.getData<MyDataType>();
await sessionManager.setData({ field: "value" });

// History management
await sessionManager.addMessage("user", "Hello");
const history = sessionManager.getHistory();
sessionManager.clearHistory();
```

### Session Persistence

Sessions are automatically persisted when using persistence adapters:

```typescript
const agent = new Agent({
  persistence: {
    adapter: new RedisAdapter(redisClient),
    autoSave: true, // Auto-save after each response (default)
  },
  sessionId: "user-123" // Automatically loads from persistence
});

// Sessions are automatically saved after each message
const response = await agent.respond("Hello");
// Session state automatically persisted

// Manual session operations (if needed)
await agent.session.save(); // Manual save
await agent.session.delete(); // Delete session
const newSession = await agent.session.reset(true); // Reset with history preserved
```

### Session Access Methods

```typescript
// Access current session data
const data = agent.session.getData<MyDataType>();
await agent.session.setData({ field: "value" });

// Session information
console.log(agent.session.id); // Current session ID
console.log(agent.session.current); // Full session state

// History management
const history = agent.session.getHistory();
await agent.session.addMessage("user", "New message");
agent.session.clearHistory();
```

## Route Management

### Declarative Route Creation

```typescript
const agent = new Agent<CustomerContext, CustomerData>({
  // Agent-level schema defines all possible data fields
  schema: { /* comprehensive schema */ },
  
  routes: [
    {
      title: "Technical Support",
      description: "Help with technical issues",
      conditions: ["user reports technical problem"],
      // NEW: Routes specify required fields instead of schemas
      requiredFields: ["customerName", "email", "issueType", "issueDescription"],
      optionalFields: ["phone", "priority"],
      initialStep: {
        prompt:
          "I understand you're having a technical issue. Can you describe what's happening?",
        collect: ["issueType", "issueDescription"], // Collects into agent-level data
      },
    },
    {
      title: "Billing Inquiry", 
      description: "Handle billing and payment questions",
      conditions: ["user asks about billing or payment"],
      requiredFields: ["customerName", "email", "issueType"],
      initialStep: {
        prompt:
          "I'd be happy to help with your billing question. What can I assist with?",
        collect: ["issueType"], // Maps to agent schema field
      },
    },
  ],
});
```

### Programmatic Route Creation

```typescript
// Create routes dynamically with required fields
const supportRoute = agent
  .createRoute({
    title: "Customer Support",
    requiredFields: ["customerName", "email", "issueType"], // NEW: Required fields
    optionalFields: ["phone"], // NEW: Optional fields
    initialStep: {
      prompt: "How can I help you today?",
      collect: ["customerName", "email"], // Collects into agent-level data
    },
  })
  .nextStep({
    prompt: "I understand you need help, {{customerName}}. What type of issue are you experiencing?",
    collect: ["issueType"],
    requires: ["customerName", "email"], // Prerequisites from agent data
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

## Agent-Level Data Collection

### Centralized Data Schema

The new architecture centralizes data collection at the agent level, allowing all routes to work with the same data structure:

```typescript
interface ComprehensiveData {
  // Customer identification
  customerId?: string;
  customerName?: string;
  email?: string;
  phone?: string;
  
  // Issue tracking
  issueType?: 'booking' | 'billing' | 'technical' | 'other';
  issueDescription?: string;
  priority?: 'low' | 'medium' | 'high';
  
  // Feedback
  rating?: number;
  comments?: string;
  recommendToFriend?: boolean;
}

const agent = new Agent<Context, ComprehensiveData>({
  name: "Customer Service Agent",
  schema: {
    type: "object",
    properties: {
      customerId: { type: "string" },
      customerName: { type: "string" },
      email: { type: "string", format: "email" },
      phone: { type: "string" },
      issueType: { type: "string", enum: ["booking", "billing", "technical", "other"] },
      issueDescription: { type: "string" },
      priority: { type: "string", enum: ["low", "medium", "high"] },
      rating: { type: "number", minimum: 1, maximum: 5 },
      comments: { type: "string" },
      recommendToFriend: { type: "boolean" }
    }
  }
});
```

### Route Completion Based on Required Fields

Routes now specify which fields they need to complete, enabling cross-route data sharing:

```typescript
// Support route needs basic info + issue details
const supportRoute = agent.createRoute({
  title: "Customer Support",
  requiredFields: ["customerName", "email", "issueType", "issueDescription"],
  optionalFields: ["phone", "priority"]
});

// Feedback route needs basic info + rating
const feedbackRoute = agent.createRoute({
  title: "Feedback Collection",
  requiredFields: ["customerName", "email", "rating"],
  optionalFields: ["comments", "recommendToFriend"]
});

// Routes can complete when their required data is available,
// regardless of which route collected it
```

### Cross-Route Data Sharing

Data collected by any route is available to all other routes:

```typescript
// User starts with support, provides name and email
const response1 = await agent.respond("I need help, my name is John Doe, email john@example.com");
// Agent data now contains: { customerName: "John Doe", email: "john@example.com" }

// User switches to feedback - already has 2/3 required fields
const response2 = await agent.respond("Actually, I want to leave feedback. I'd rate you 5 stars.");
// Feedback route completes immediately with: { customerName: "John Doe", email: "john@example.com", rating: 5 }
```

### Agent Data Management Methods

Access and update agent-level data programmatically:

```typescript
// Get current collected data
const currentData = agent.getCollectedData();
console.log(currentData); // { customerName: "John", email: "john@example.com" }

// Update data programmatically
await agent.updateCollectedData({
  customerId: "CUST-12345",
  priority: "high"
});

// Validate data against schema
const validation = agent.validateData({ email: "invalid-email" });
if (!validation.valid) {
  console.log(validation.errors); // Detailed validation errors
}
```

## Response Generation

### Simple Response API

```typescript
// Simple message-based API (recommended)
const response = await agent.respond("How do I reset my password?");
console.log(response.message);
console.log(agent.session.getData<CustomerData>()); // Agent-level collected data
console.log(response.toolCalls); // Any tool calls made
console.log(response.isRouteComplete); // Whether route finished

// Advanced usage with history override
const response = await agent.respond("Hello", {
  history: [
    { role: "user", content: "Previous context" },
    { role: "assistant", content: "I understand" }
  ]
});
```

### Streaming Response

```typescript
const stream = agent.respondStream("Tell me about your services");

for await (const chunk of stream) {
  if (chunk.delta) {
    process.stdout.write(chunk.delta); // Real-time output
  }

  if (chunk.done) {
    console.log("\nSession ID:", agent.session.id);
    console.log("Tool calls:", chunk.toolCalls);
  }
}
```

### Response with Custom Context

```typescript
const response = await agent.respond("Hola", {
  contextOverride: {
    language: "es", // Override context for this response
    debug: true,
  }
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
