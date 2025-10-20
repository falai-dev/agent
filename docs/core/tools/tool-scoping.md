# Tool Scoping & Access Control

@falai/agent provides a hierarchical tool scoping system that enables fine-grained control over tool availability and access. Tools can be defined at agent, route, or step levels, with intelligent resolution and security controls.

## Overview

The scoping system provides:

- **Hierarchical Access**: Agent → Route → Step level tool definitions
- **Security Boundaries**: Control tool access based on context and permissions
- **Performance Optimization**: Limit tool evaluation to relevant contexts
- **Conflict Resolution**: Predictable tool selection when IDs conflict
- **Dynamic Availability**: Tools can be conditionally available

## Scoping Hierarchy

### Agent-Level Tools

Available to all routes and steps within the agent:

```typescript
const agent = new Agent({
  name: "Multi-Purpose Agent",
  provider: openaiProvider,

  // Available to ALL routes and steps
  tools: [
    searchTool, // General search functionality
    userProfileTool, // User management
    systemStatusTool, // System health checks
  ],

  routes: [route1, route2, route3], // All can use agent tools
});
```

**Use Cases:**

- Cross-cutting functionality (search, user management)
- System utilities (health checks, logging)
- Common operations (data formatting, validation)

### Route-Level Tools

Specific to a single route and its steps:

```typescript
const supportRoute = agent.createRoute({
  title: "Customer Support",

  // Available only within this route
  tools: [ticketCreationTool, knowledgeBaseTool, escalationTool],

  initialStep: {
    prompt: "How can I help you?",
    tools: ["ticketCreationTool"], // Can access route tools
  },
});
```

**Use Cases:**

- Domain-specific operations (support tickets, knowledge search)
- Route-specific workflows (order processing, account management)
- Contextual utilities (customer lookup, history access)

### Step-Level Tools

Limited to a specific conversation step:

```typescript
const dataCollectionStep = {
  prompt: "Please provide your payment information",
  collect: ["paymentDetails"],

  // Available ONLY in this step
  tools: [paymentValidationTool, fraudCheckTool, secureStorageTool],

  requires: ["userConsent", "securityVerified"],
};
```

**Use Cases:**

- Sensitive operations (payment processing, data encryption)
- Step-specific validation (form validation, business rules)
- Conditional actions (approval workflows, security checks)

## Tool Resolution Logic

### Priority Order

When tools have conflicting IDs, resolution follows this hierarchy:

```typescript
// 1. Step-level tools (highest priority)
step.tools.find((tool) => tool.id === toolId || tool.name === toolId) ||
  // 2. Route-level tools
  route.tools.find((tool) => tool.id === toolId || tool.name === toolId) ||
  // 3. Agent-level tools (lowest priority)
  agent.tools.find((tool) => tool.id === toolId || tool.name === toolId);
```

### Example Resolution

```typescript
const agent = new Agent({
  tools: [{ id: "search", description: "General search" }],
  routes: [
    {
      title: "Support",
      tools: [{ id: "search", description: "Knowledge base search" }],
      initialStep: {
        prompt: "Search question?",
        tools: [{ id: "search", description: "Web search" }],
      },
    },
  ],
});

// In the support route's initial step:
// - "search" resolves to: Web search (step-level)
// In other support route steps:
// - "search" resolves to: Knowledge base search (route-level)
// In other routes:
// - "search" resolves to: General search (agent-level)
```

## Dynamic Tool Availability

### Conditional Tool Access

Tools can be conditionally available based on context:

```typescript
const conditionalRoute = agent.createRoute({
  title: "Premium Features",

  initialStep: {
    prompt: "What would you like to do?",
    tools: ({ context, data }) => {
      const tools = [basicTool];

      // Add premium tools based on user status
      if (context.userTier === "premium") {
        tools.push(premiumTool);
      }

      // Add admin tools based on permissions
      if (context.userRole === "admin") {
        tools.push(adminTool);
      }

      return tools;
    },
  },
});
```

### Runtime Tool Filtering

```typescript
const filteredStep = {
  prompt: "Available actions:",
  tools: ({ context, data }) => {
    return allTools.filter((tool) => {
      // Filter based on user permissions
      if (
        tool.requiresPermission &&
        !context.permissions?.includes(tool.requiresPermission)
      ) {
        return false;
      }

      // Filter based on collected data
      if (tool.requiresData && !data[tool.requiresData]) {
        return false;
      }

      // Filter based on step progress
      if (tool.minStep && data.currentStep < tool.minStep) {
        return false;
      }

      return true;
    });
  },
};
```

## Security & Access Control

### Permission-Based Access

```typescript
const secureTool = {
  id: "admin_action",
  description: "Administrative action",
  requiresPermission: "admin", // Tool-level permission requirement

  execute: async ({ action }, { context }) => {
    // Runtime permission check
    if (!context.permissions?.includes("admin")) {
      throw new Error("Insufficient permissions");
    }

    return await performAdminAction(action);
  },
};
```

### Context-Based Security

```typescript
import { Tool } from "@falai/agent";

const contextSecureTool: Tool<SecureContext, UserData, [], any> = {
  id: "user_data_access",
  description: "Access user data with security checks",
  parameters: {
    type: "object",
    properties: {
      userId: { type: "string", description: "User ID to access" },
    },
    required: ["userId"],
  },
  handler: async (toolContext, args) => {
    // Ensure users can only access their own data
    if (
      toolContext.context.userId !== args.userId &&
      !toolContext.context.isAdmin
    ) {
      throw new Error("Access denied: Can only access own data");
    }

    return await getUserData(args.userId);
  },
};
```

### Route Isolation

```typescript
// Sensitive route with isolated tools
const financeRoute = agent.createRoute({
  title: "Financial Operations",

  // Route-specific tools only
  tools: [secureTransactionTool, auditTool],

  // No agent-level tools available
  toolFilter: ({ context }) => {
    // Additional security checks
    if (!context.mfaVerified) {
      throw new Error("MFA required for financial operations");
    }

    return true; // Allow only route tools
  },
});
```

## Performance Optimization

### Tool Limiting

Control the number of tools available to reduce AI evaluation time:

```typescript
const optimizedRoute = agent
  .createRoute({
    title: "Focused Interaction",

    initialStep: {
      prompt: "Basic question?",
      tools: ["basic_search"], // Only essential tools
    },
  })
  .nextStep({
    prompt: "Detailed analysis needed?",
    tools: ["basic_search", "deep_analysis", "expert_consultation"],
    // More tools as conversation progresses
  });
```

### Lazy Loading

Load tools only when needed:

```typescript
const lazyRoute = agent
  .createRoute({
    title: "On-Demand Tools",

    initialStep: {
      prompt: "What type of help?",
      tools: ["categorize_request"],
    },
  })
  .nextStep({
    prompt: "Processing your {{category}} request",
    tools: ({ data }) => {
      // Load category-specific tools
      switch (data.category) {
        case "technical":
          return [technicalSupportTool, codeReviewTool];
        case "billing":
          return [billingTool, paymentProcessingTool];
        default:
          return [generalHelpTool];
      }
    },
    requires: ["category"],
  });
```

## Tool Registration Patterns

### Factory Pattern

Create tool instances dynamically:

```typescript
function createScopedTools(userContext: UserContext) {
  return [
    {
      id: "user_search",
      description: "Search within user's personal data",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
        },
        required: ["query"],
      },
      handler: async ({ context }, { query }) => {
        // Search scoped to user's data
        const results = await searchUserData(query, userContext.userId);
        return {
          data: `Found ${results.length} results for "${query}"`,
          dataUpdate: { searchResults: results },
        };
      },
    },

    {
      id: "user_preferences",
      description: "Manage user-specific preferences",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["get", "set", "delete"] },
          value: { type: "string", description: "Value for set action" },
        },
        required: ["action"],
      },
      handler: async ({ context }, { action, value }) => {
        // Manage user-specific preferences
        const result = await updateUserPreferences(
          userContext.userId,
          action,
          value
        );
        return {
          data: `Preferences ${action} operation completed`,
          contextUpdate: { lastPreferenceUpdate: new Date().toISOString() },
        };
      },
    },
  ];
}

const personalizedAgent = new Agent({
  name: "Personal Assistant",
  tools: ({ context }) => createScopedTools(context),
  routes: [
    /* routes */
  ],
});
```

### Plugin System

Extensible tool registration:

```typescript
class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(scope: "agent" | "route" | "step", tool: Tool) {
    const key = `${scope}:${tool.id}`;
    this.tools.set(key, tool);
  }

  getAvailable(scope: string, context: any): Tool[] {
    const scopedTools = Array.from(this.tools.entries())
      .filter(([key]) => key.startsWith(scope))
      .map(([, tool]) => tool);

    // Apply context-based filtering
    return scopedTools.filter((tool) => this.checkPermissions(tool, context));
  }

  private checkPermissions(tool: Tool, context: any): boolean {
    // Implement permission logic
    return true; // Placeholder
  }
}
```

## Advanced Scoping Patterns

### Multi-Tenant Tools

```typescript
const multiTenantTool: Tool<
  { tenantId: string },
  { query: string },
  [],
  string
> = {
  id: "tenant_search",
  description: "Search within tenant's data scope",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
    },
    required: ["query"],
  },
  handler: async ({ context }, { query }) => {
    // Scope search to tenant's data
    const tenantId = context.tenantId;
    const results = await searchTenantData(query, tenantId);
    return {
      data: `Found ${results.length} results in tenant data`,
      dataUpdate: { searchResults: results },
    };
  },
};

const tenantAgent = new Agent({
  name: "Multi-Tenant Agent",
  tools: [multiTenantTool],
  routes: ({ context }) => {
    // Routes scoped to tenant
    return createTenantRoutes(context.tenantId);
  },
});
```

### Time-Based Availability

```typescript
const timeSensitiveTool = {
  id: "business_hours_support",
  execute: async (args) => {
    const now = new Date();
    const hour = now.getHours();

    if (hour < 9 || hour > 17) {
      throw new Error(
        "Support only available during business hours (9 AM - 5 PM)"
      );
    }

    return await provideSupport(args);
  },
};
```

### Usage-Based Limiting

```typescript
const limitedTool: Tool<{ userId: string }, any, [args: any], string> = {
  id: "premium_feature",
  description: "Execute premium feature with usage limits",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", description: "Premium action to perform" },
    },
    required: ["action"],
  },
  handler: async ({ context }, { action }) => {
    // Check usage limits
    const usage = await getUserUsage(context.userId, "premium_feature");

    if (usage.count >= usage.limit) {
      throw new Error("Premium feature usage limit exceeded");
    }

    // Execute feature
    const result = await executePremiumFeature(action);

    // Update usage
    await incrementUsage(context.userId, "premium_feature");

    return {
      data: `Premium feature executed: ${result}`,
      contextUpdate: {
        lastPremiumUsage: new Date().toISOString(),
        premiumUsageCount: usage.count + 1,
      },
    };
  },
};
```

## Debugging & Monitoring

### Tool Resolution Tracing

```typescript
// Enable debug logging
const agent = new Agent({
  name: "Debug Agent",
  debug: true,
  provider: provider,
});

// Logs show tool resolution:
// [Agent] Resolving tool 'search' in step 'query'
// [Agent] Found step-level tool: web_search
// [Agent] Tool resolution: web_search (step > route > agent)
```

### Access Audit Logging

```typescript
const auditedTool: Tool<{ userId: string }, any, [args: any], string> = {
  id: "sensitive_operation",
  description: "Perform sensitive operation with audit logging",
  parameters: {
    type: "object",
    properties: {
      operation: { type: "string", description: "Operation to perform" },
    },
    required: ["operation"],
  },
  handler: async ({ context }, { operation }) => {
    // Log access attempt
    await auditLog.log({
      userId: context.userId,
      toolId: "sensitive_operation",
      timestamp: new Date(),
      operation: operation, // Log the operation type
    });

    const result = await performSensitiveOperation(operation);

    return {
      data: `Sensitive operation completed: ${result}`,
      contextUpdate: {
        lastSensitiveOperation: new Date().toISOString(),
      },
    };
  },
};
```

### Performance Monitoring

```typescript
const monitoredAgent = new Agent({
  name: "Monitored Agent",
  tools: [
    {
      ...tool,
      execute: async (args, context) => {
        const startTime = Date.now();
        try {
          const result = await originalExecute(args, context);

          // Log performance metrics
          metrics.record("tool_execution", {
            toolId: tool.id,
            duration: Date.now() - startTime,
            success: true,
          });

          return result;
        } catch (error) {
          metrics.record("tool_execution", {
            toolId: tool.id,
            duration: Date.now() - startTime,
            success: false,
            error: error.message,
          });

          throw error;
        }
      },
    },
  ],
});
```

## Best Practices

### Scoping Strategy

1. **Agent Level**: Cross-cutting, general-purpose tools
2. **Route Level**: Domain-specific, route-centric tools
3. **Step Level**: Sensitive, step-specific operations

### Security First

1. **Defense in Depth**: Multiple layers of access control
2. **Principle of Least Privilege**: Minimal required permissions
3. **Audit Everything**: Log all tool access and usage
4. **Fail Secure**: Deny access when in doubt

### Performance

1. **Limit Scope**: Don't expose unnecessary tools
2. **Lazy Loading**: Load tools only when needed
3. **Caching**: Cache permission checks and tool metadata
4. **Monitoring**: Track usage patterns and optimize

### Maintainability

1. **Clear Naming**: Descriptive tool IDs and scopes
2. **Documentation**: Document tool purposes and requirements
3. **Testing**: Test tool resolution and access control
4. **Versioning**: Plan for tool evolution and compatibility

The hierarchical scoping system enables sophisticated tool management while maintaining security, performance, and developer experience.
