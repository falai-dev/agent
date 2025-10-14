# Context Management & Persistence

## Overview

The `@falai/agent` framework provides flexible patterns for managing context in both **single-turn** and **multi-turn persistent** conversations. This guide explains how to handle stateful conversations that persist across requests.

---

## 🤔 The Context Lifecycle Problem

### Single-Turn Conversations (Simple)

```typescript
// ✅ Works great for single-turn conversations
const agent = new Agent({
  name: "Bot",
  ai: provider,
  context: { userId: "123", preferences: {} },
});

const response = await agent.respond({ history });
```

**Works because:** Agent is used once and discarded.

### Multi-Turn Conversations (Complex)

```typescript
// ❌ PROBLEM: Context updates don't persist
const agent = new Agent({
  name: "Bot",
  ai: provider,
  context: { userId: "123", preferences: {} },
});

// Turn 1
await agent.respond({ history: [message1] });
// Tool modifies context in memory...

// Turn 2 (new request, agent recreated)
const agent2 = new Agent({ context: { userId: "123", preferences: {} } });
await agent2.respond({ history: [message2] });
// ❌ Lost the context changes from Turn 1!
```

**Problem:** When agents are recreated (e.g., across HTTP requests), context updates are lost.

---

## 💡 Solution: Context Lifecycle Hooks

The framework provides **lifecycle hooks** to integrate with your persistence layer (database, cache, etc.).

### Pattern 1: `beforeRespond` + `onContextUpdate` (Recommended)

```typescript
import { Agent, type ContextLifecycleHooks } from "@falai/agent";

// Define hooks
const hooks: ContextLifecycleHooks<MyContext> = {
  // Load fresh context before each response
  beforeRespond: async (currentContext) => {
    return await database.loadContext(sessionId);
  },

  // Persist context after updates
  onContextUpdate: async (newContext, previousContext) => {
    await database.saveContext(sessionId, newContext);
  },
};

// Create agent with hooks
const agent = new Agent({
  name: "Bot",
  ai: provider,
  context: initialContext,
  hooks, // 🔑 Enable persistence
});
```

**How it works:**

1. `beforeRespond` fetches fresh context from your database before `respond()` is called
2. Tools can update context using `toolContext.updateContext()` or returning `{ contextUpdate }`
3. `onContextUpdate` automatically persists changes to your database
4. Next request creates a new agent, `beforeRespond` loads the updated context

---

## 🔧 Tool Context Updates

Tools can update context in **two ways**:

### Option A: Return `contextUpdate`

```typescript
const saveName = defineTool<MyContext, [name: string], boolean>(
  "save_name",
  async (toolContext, name) => {
    return {
      data: true,
      contextUpdate: {
        userName: name,
        updatedAt: new Date(),
      },
    };
  }
);
```

**Pros:**

- Declarative and functional
- Easy to test
- Context update is part of the result

### Option B: Call `updateContext()` directly

```typescript
const saveName = defineTool<MyContext, [name: string], boolean>(
  "save_name",
  async (toolContext, name) => {
    await toolContext.updateContext({
      userName: name,
      updatedAt: new Date(),
    });

    return { data: true };
  }
);
```

**Pros:**

- More imperative and direct
- Can update context at any point in the tool
- Useful for complex logic

**Both approaches trigger the `onContextUpdate` hook automatically.**

---

## 🌐 Context Provider Pattern

For scenarios where context is **always loaded from an external source**, use the `contextProvider` pattern:

```typescript
const agent = new Agent({
  name: "Bot",
  ai: provider,

  // Instead of static context:
  contextProvider: async () => {
    // Fetch context fresh on every respond() call
    return await database.loadContext(sessionId);
  },

  hooks: {
    // Still persist updates
    onContextUpdate: async (newContext) => {
      await database.saveContext(sessionId, newContext);
    },
  },
});
```

**When to use:**

- Context is always loaded from a database/cache
- You never have a static starting context
- You want guaranteed fresh data on every request

**Difference from `beforeRespond`:**

- `contextProvider`: **Replaces** the context entirely
- `beforeRespond`: **Updates** the existing context (can access previous state)

---

## 🎯 Complete Example: Multi-Turn Onboarding

```typescript
import { Agent, defineTool } from "@falai/agent";

interface OnboardingContext {
  sessionId: string;
  userId: string;
  businessName?: string;
  industry?: string;
  completedSteps: string[];
}

// Database simulation
const db = {
  async loadSession(sessionId: string) {
    return await database.findSession(sessionId);
  },
  async saveSession(sessionId: string, data: Partial<OnboardingContext>) {
    await database.updateSession(sessionId, data);
  },
};

// Factory function for creating agents
async function createOnboardingAgent(sessionId: string) {
  const session = await db.loadSession(sessionId);

  const agent = new Agent<OnboardingContext>({
    name: "OnboardingBot",
    ai: provider,
    context: {
      sessionId,
      userId: session.userId,
      businessName: session.businessName,
      industry: session.industry,
      completedSteps: session.completedSteps || [],
    },
    hooks: {
      // Load fresh context before responding
      beforeRespond: async (current) => {
        const fresh = await db.loadSession(sessionId);
        return { ...current, ...fresh };
      },

      // Persist context after updates
      onContextUpdate: async (newContext) => {
        await db.saveSession(sessionId, {
          businessName: newContext.businessName,
          industry: newContext.industry,
          completedSteps: newContext.completedSteps,
        });
      },
    },
  });

  // Define tools with context updates
  const saveBusinessName = defineTool(
    "save_business_name",
    async (ctx, name: string) => {
      return {
        data: true,
        contextUpdate: {
          businessName: name,
          completedSteps: [...ctx.context.completedSteps, "business_name"],
        },
      };
    }
  );

  const saveIndustry = defineTool(
    "save_industry",
    async (ctx, industry: string) => {
      // Alternative: use updateContext directly
      await ctx.updateContext({
        industry,
        completedSteps: [...ctx.context.completedSteps, "industry"],
      });

      return { data: true };
    }
  );

  // Build conversation routes...
  const route = agent.createRoute({ title: "Onboarding" });
  // ...

  return agent;
}

// Usage across multiple turns
async function handleUserMessage(sessionId: string, message: string) {
  // Recreate agent for each turn (context is loaded fresh)
  const agent = await createOnboardingAgent(sessionId);

  const response = await agent.respond({
    history: [createMessageEvent(EventSource.CUSTOMER, "User", message)],
  });

  return response.message;
}
```

---

## 📋 Best Practices

### ✅ DO

- **Recreate agents** for each request in multi-turn conversations
- **Use lifecycle hooks** to integrate with your database
- **Store context** in your database/cache (Redis, PostgreSQL, etc.)
- **Load fresh context** via `beforeRespond` or `contextProvider`
- **Test persistence** by simulating multiple turns
- **Handle errors** in hooks gracefully (fallback to current context)

### ❌ DON'T

- **Cache agent instances** across requests (context gets stale)
- **Mutate context directly** without using `updateContext()` or `contextUpdate`
- **Rely on in-memory state** for multi-turn conversations
- **Forget to handle** `onContextUpdate` failures (could lose data)
- **Mix** `context` and `contextProvider` (will throw an error)

---

## 🔍 Debugging Context Issues

### Problem: Context updates aren't persisting

**Check:**

1. Are you using `onContextUpdate` hook?
2. Is your database save actually working?
3. Are you recreating the agent with fresh context each turn?

```typescript
// Debug your hooks
hooks: {
  beforeRespond: async (current) => {
    console.log("📥 Loading context:", current);
    const fresh = await db.load(sessionId);
    console.log("✅ Loaded fresh:", fresh);
    return fresh;
  },

  onContextUpdate: async (newContext) => {
    console.log("💾 Saving context:", newContext);
    await db.save(sessionId, newContext);
    console.log("✅ Saved successfully");
  },
},
```

### Problem: Context is null/undefined

**Check:**

1. Did you provide either `context` or `contextProvider`?
2. Is your `contextProvider` returning valid data?
3. Is `beforeRespond` returning valid context?

```typescript
// Validate your contextProvider
contextProvider: async () => {
  const ctx = await db.load(sessionId);
  if (!ctx) {
    console.error("❌ Context not found!");
    throw new Error("Session not found");
  }
  return ctx;
},
```

### Problem: Tools not updating context

**Check:**

1. Are you returning `{ contextUpdate }` or calling `toolContext.updateContext()`?
2. Is `onContextUpdate` being called? (Add console.log)
3. Are your tools being executed at all?

---

## 🚀 Advanced Patterns

### Pattern: Context Versioning

```typescript
interface VersionedContext extends MyContext {
  version: number;
}

hooks: {
  onContextUpdate: async (newContext) => {
    await db.save(sessionId, {
      ...newContext,
      version: newContext.version + 1,
    });
  },

  beforeRespond: async (current) => {
    const fresh = await db.load(sessionId);
    if (fresh.version > current.version) {
      console.log("⚠️ Context changed by another request!");
    }
    return fresh;
  },
},
```

### Pattern: Selective Persistence

```typescript
// Only persist specific fields
hooks: {
  onContextUpdate: async (newContext) => {
    // Don't persist temporary/computed fields
    const { tempData, ...persistable } = newContext;
    await db.save(sessionId, persistable);
  },
},
```

### Pattern: Multi-User Context

```typescript
interface MultiUserContext {
  conversationId: string;
  participants: Map<string, UserData>;
}

hooks: {
  beforeRespond: async (current) => {
    // Load all participant data
    const conversation = await db.loadConversation(conversationId);
    return {
      conversationId,
      participants: new Map(conversation.participants),
    };
  },
},
```

---

## 📚 Related Resources

- [Complete Example: Persistent Onboarding](../examples/persistent-onboarding.ts)
- [API Reference: AgentOptions](./API_REFERENCE.md#agentoptions)
- [API Reference: ContextLifecycleHooks](./API_REFERENCE.md#contextlifecyclehooks)
- [Getting Started](./GETTING_STARTED.md)

---

## 🆘 Need Help?

If you're still having issues:

1. Check the [examples](../examples/) for working implementations
2. Review the [API Reference](./API_REFERENCE.md) for detailed type information
3. Open an issue on GitHub with your use case

**Remember:** The key to persistent conversations is:

1. **Recreate agents** each turn
2. **Load fresh context** via hooks/provider
3. **Persist updates** via `onContextUpdate`
4. **Never cache** agent instances across requests
