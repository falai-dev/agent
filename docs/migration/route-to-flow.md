---
title: "Route → Flow rename"
description: "Rename the Route domain noun to Flow across symbols, config, persistence, and generated IDs, with per-adapter data migration steps."
type: migration
order: 2
sidebar: false
---

# Migration Guide: Route → Flow Rename

**Version:** Minor breaking bump (ships before v2 overhaul)
**CHANGELOG:** See the [breaking-change entry in CHANGELOG.md](../../CHANGELOG.md)

## Summary

The `Route` domain noun has been renamed to `Flow` across the entire `@falai/agent` package. This is a clean break with no compatibility shims, no dual-naming layer, and no runtime fallback for legacy field names. Every public symbol, configuration option, persisted column/field, adapter method, constant, error class, and utility function that referenced "Route" as a noun now uses "Flow". The verb form `route()` and the gerund "routing" (as used in prose and the `routing.ts` module) are preserved — routing-as-an-action remains the correct verb for selecting a flow.

---

## Symbol Rename Table

| Old | New | Layer | Action |
|-----|-----|-------|--------|
| `Route` (class) | `Flow` | Core | Update imports and instantiation |
| `RouteOptions` | `FlowOptions` | Type | Update type annotations |
| `RouteRef` | `FlowRef` | Type | Update type annotations |
| `RouteTransitionConfig` | `FlowTransitionConfig` | Type | Update type annotations |
| `RouteCompletionHandler` | `FlowCompletionHandler` | Type | Update type annotations |
| `RouteLifecycleHooks` | `FlowLifecycleHooks` | Type | Update type annotations |
| `RoutingEngine` | `FlowRouter` | Core | Update imports and references |
| `RoutingEngineOptions` | `FlowRouterOptions` | Type | Update type annotations |
| `RoutingDecisionOutput` | `FlowRoutingDecisionOutput` | Type | Update type annotations |
| `RouteConfigurationError` | `FlowConfigurationError` | Error | Update catch blocks |
| `END_ROUTE` | Removed | Constant | Implicit terminus — remove all references |
| `END_ROUTE_ID` | Removed | Constant | Implicit terminus — remove all references |
| `generateRouteId` | `generateFlowId` | Utility | Update calls |
| `enterRoute` | `enterFlow` | Utility | Update calls |
| `StepRef.routeId` | `StepRef.flowId` | Type | Update field access |

### Preserved (verb-form carve-outs)

These are **not** renamed:

- `route()` method on `FlowRouter` (verb form)
- `RoutingDecision` type (describes the act of routing)
- `RoutingSchemaOptions` type
- `buildRoutingPrompt` method
- `getCandidateStepsWithConditions` method (returns Steps)
- `src/types/routing.ts` file path
- All "routing" prose in documentation

---

## Configuration Rename Table

| Old | New | Location |
|-----|-----|----------|
| `AgentOptions.routes` | `AgentOptions.flows` | Agent constructor |
| `AgentOptions.routeSwitchMargin` | `AgentOptions.flowSwitchMargin` | Agent constructor |
| `agent.routeSwitchMargin` | `agent.flowSwitchMargin` | Getter/setter |
| `agent.createRoute(...)` | `agent.createFlow(...)` | Method call |
| `agent.getRoutes()` | `agent.getFlows()` | Method call |
| `agent.nextStepRoute(...)` | `agent.nextStepFlow(...)` | Method call |
| `agent.getRoutingEngine()` | `agent.getFlowRouter()` | Method call |
| `agent.routes` | `agent.flows` | Getter |
| `Guideline.scope: 'route'` | `Guideline.scope: 'flow'` | Guideline config |
| `Guideline.route` | `Guideline.flow` | Guideline config |
| `RoutingDecision.routes` | `RoutingDecision.flows` | Field access |

---

## Session State Rename Table

| Old | New | Notes |
|-----|-----|-------|
| `SessionState.currentRoute` | `SessionState.currentFlow` | Runtime shape |
| `SessionState.routeHistory` | `SessionState.flowHistory` | Runtime shape |
| `flowHistory[].routeId` | `flowHistory[].flowId` | History item shape |
| `PendingTransition.targetRouteId` | `PendingTransition.targetFlowId` | Transition config |
| `PendingTransition.reason: "route_complete"` | `PendingTransition.reason: "flow_complete"` | String literal |
| `SessionData.currentRoute` | `SessionData.currentFlow` | Persistence shape |
| `CollectedStateData.routeHistory` | `CollectedStateData.flowHistory` | Persistence shape |
| `CollectedStateData.currentRouteTitle` | `CollectedStateData.currentFlowTitle` | Persistence shape |
| `MessageData.route` | `MessageData.flow` | Persistence shape |
| `SaveMessageOptions.route` | `SaveMessageOptions.flow` | Persistence shape |

### StoppedReason Literals

| Old | New |
|-----|-----|
| `'end_route'` | Removed — use `'last_step'` or `'completed'` |
| `'route_complete'` | `'last_step'` (no successor) or `'completed'` (explicit directive) |

---

## Adapter Method Rename Table

| Adapter | Old Method | New Method |
|---------|-----------|------------|
| `MemoryAdapter` | `updateRouteStep()` | `updateFlowStep()` |
| `PrismaAdapter` | `updateRouteStep()` | `updateFlowStep()` |
| `RedisAdapter` | `updateRouteStep()` | `updateFlowStep()` |
| `MongoAdapter` | `updateRouteStep()` | `updateFlowStep()` |
| `PostgreSQLAdapter` | `updateRouteStep()` | `updateFlowStep()` |
| `SQLiteAdapter` | `updateRouteStep()` | `updateFlowStep()` |
| `OpenSearchAdapter` | `updateRouteStep()` | `updateFlowStep()` |
| `PersistenceManager` | `updateRouteStep()` | `updateFlowStep()` |
| `SessionRepository` (interface) | `updateRouteStep()` | `updateFlowStep()` |

If you implement a custom adapter, rename your `updateRouteStep` method to `updateFlowStep`.

---

## Per-Adapter Data Migration

The framework no longer reads or writes the legacy field/column names. You must migrate your persisted data before deploying the new version.

### PostgreSQL

```sql
-- Sessions table
ALTER TABLE sessions RENAME COLUMN current_route TO current_flow;

-- Messages table
ALTER TABLE messages RENAME COLUMN route TO flow;
```

### SQLite

SQLite 3.25+ supports `ALTER TABLE ... RENAME COLUMN`:

```sql
-- Sessions table
ALTER TABLE sessions RENAME COLUMN current_route TO current_flow;

-- Messages table
ALTER TABLE messages RENAME COLUMN route TO flow;
```

For SQLite versions older than 3.25, use the copy-and-rename pattern:

```sql
-- 1. Create new table with correct column names
CREATE TABLE sessions_new (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  agent_name TEXT,
  status TEXT DEFAULT 'active',
  current_flow TEXT,
  current_step TEXT,
  collected_data TEXT,
  message_count INTEGER DEFAULT 0,
  last_message_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 2. Copy data
INSERT INTO sessions_new SELECT
  id, user_id, agent_name, status,
  current_route AS current_flow,
  current_step, collected_data, message_count,
  last_message_at, completed_at, created_at, updated_at
FROM sessions;

-- 3. Drop old table and rename
DROP TABLE sessions;
ALTER TABLE sessions_new RENAME TO sessions;

-- Repeat for messages table (route → flow column)
```

### Prisma

Update your Prisma schema model fields:

```diff
model Session {
  id            String   @id
  userId        String?
  agentName     String?
  status        String   @default("active")
- currentRoute  String?  @map("current_route")
+ currentFlow   String?  @map("current_flow")
  currentStep   String?  @map("current_step")
  collectedData Json?    @map("collected_data")
  // ...
}

model Message {
  id        String   @id
  sessionId String   @map("session_id")
  // ...
- route     String?
+ flow      String?
  step      String?
  // ...
}
```

Then generate and apply the migration:

```bash
npx prisma migrate dev --name route-to-flow-rename
```

If you use a custom `fieldMappings` config in `PrismaAdapter`, update the key from `currentRoute` to `currentFlow`:

```typescript
// Before
fieldMappings: { currentRoute: 'currentRoute', ... }

// After
fieldMappings: { currentFlow: 'currentFlow', ... }
```

### MongoDB

```javascript
// Rename session fields
db.sessions.updateMany({}, {
  $rename: {
    "currentRoute": "currentFlow"
  }
});

// Rename collected state fields (if stored at top level)
db.sessions.updateMany({}, {
  $rename: {
    "collectedData.routeHistory": "collectedData.flowHistory",
    "collectedData.currentRouteTitle": "collectedData.currentFlowTitle"
  }
});

// Rename message fields
db.messages.updateMany({}, {
  $rename: {
    "route": "flow"
  }
});
```

### Redis

Redis stores sessions as serialized JSON. Use a Lua script to rewrite the payload in-place:

```lua
-- redis-migrate-route-to-flow.lua
-- Run with: redis-cli --eval redis-migrate-route-to-flow.lua

local cursor = "0"
repeat
  local result = redis.call("SCAN", cursor, "MATCH", "session:*", "COUNT", 100)
  cursor = result[1]
  local keys = result[2]
  for _, key in ipairs(keys) do
    local val = redis.call("GET", key)
    if val then
      -- Replace field names in JSON payload
      val = val:gsub('"currentRoute"', '"currentFlow"')
      val = val:gsub('"routeHistory"', '"flowHistory"')
      val = val:gsub('"currentRouteTitle"', '"currentFlowTitle"')
      redis.call("SET", key, val)
    end
  end
until cursor == "0"

-- If using hash layout instead of JSON:
-- Rename hash fields per session key
local cursor2 = "0"
repeat
  local result = redis.call("SCAN", cursor2, "MATCH", "session:*", "COUNT", 100)
  cursor2 = result[1]
  local keys = result[2]
  for _, key in ipairs(keys) do
    local typ = redis.call("TYPE", key)["ok"]
    if typ == "hash" then
      local oldVal = redis.call("HGET", key, "currentRoute")
      if oldVal then
        redis.call("HSET", key, "currentFlow", oldVal)
        redis.call("HDEL", key, "currentRoute")
      end
    end
  end
until cursor2 == "0"
```

For message keys, apply the same pattern replacing `"route"` with `"flow"` in the JSON payload or hash field.

### OpenSearch

Use the `_reindex` API with a painless script to rename fields:

```json
POST _reindex
{
  "source": {
    "index": "sessions"
  },
  "dest": {
    "index": "sessions_v2"
  },
  "script": {
    "source": """
      // Rename currentRoute → currentFlow
      if (ctx._source.containsKey('currentRoute')) {
        ctx._source.currentFlow = ctx._source.remove('currentRoute');
      }
      // Rename routeHistory → flowHistory in collectedData
      if (ctx._source.containsKey('collectedData') && ctx._source.collectedData.containsKey('routeHistory')) {
        ctx._source.collectedData.flowHistory = ctx._source.collectedData.remove('routeHistory');
      }
      if (ctx._source.containsKey('collectedData') && ctx._source.collectedData.containsKey('currentRouteTitle')) {
        ctx._source.collectedData.currentFlowTitle = ctx._source.collectedData.remove('currentRouteTitle');
      }
    """,
    "lang": "painless"
  }
}
```

Then swap the alias:

```json
POST _aliases
{
  "actions": [
    { "remove": { "index": "sessions", "alias": "sessions_active" } },
    { "add": { "index": "sessions_v2", "alias": "sessions_active" } }
  ]
}
```

For the messages index, apply the same reindex pattern renaming the `route` field to `flow`:

```json
POST _reindex
{
  "source": {
    "index": "messages"
  },
  "dest": {
    "index": "messages_v2"
  },
  "script": {
    "source": """
      if (ctx._source.containsKey('route')) {
        ctx._source.flow = ctx._source.remove('route');
      }
    """,
    "lang": "painless"
  }
}
```

---

## ID Prefix Migration

The `generateFlowId()` function now produces IDs with the prefix `flow_` instead of `route_`. Existing sessions stored under the legacy `route_*` prefix will not be recognized by the framework's flow-matching logic unless migrated.

**Run this migration during a maintenance window.** In-flight sessions will lose their step pointer if the rename is not atomic with the adapter restart.

### PostgreSQL / SQLite

```sql
UPDATE sessions
SET current_flow = REPLACE(current_flow, 'route_', 'flow_')
WHERE current_flow LIKE 'route\_%' ESCAPE '\';
```

If your `collected_data` JSON contains `flowHistory` entries with old IDs (stored as `routeId` before the field rename), update those as well:

```sql
-- PostgreSQL (JSONB)
UPDATE sessions
SET collected_data = REPLACE(collected_data::text, '"route_', '"flow_')::jsonb
WHERE collected_data::text LIKE '%"route_%';
```

### MongoDB

```javascript
db.sessions.updateMany(
  { currentFlow: { $regex: "^route_" } },
  [{
    $set: {
      currentFlow: {
        $replaceOne: {
          input: "$currentFlow",
          find: "route_",
          replacement: "flow_"
        }
      }
    }
  }]
);

// Also update flowHistory entries
db.sessions.updateMany(
  { "collectedData.flowHistory.flowId": { $regex: "^route_" } },
  [{
    $set: {
      "collectedData.flowHistory": {
        $map: {
          input: "$collectedData.flowHistory",
          as: "entry",
          in: {
            $mergeObjects: [
              "$$entry",
              {
                flowId: {
                  $replaceOne: {
                    input: "$$entry.flowId",
                    find: "route_",
                    replacement: "flow_"
                  }
                }
              }
            ]
          }
        }
      }
    }
  }]
);
```

### Redis

Extend the Lua script above to also replace ID prefixes in the JSON payload:

```lua
-- Add to the existing migration script
val = val:gsub('"route_', '"flow_')
```

### OpenSearch

Include the prefix replacement in the reindex painless script:

```json
POST _reindex
{
  "source": { "index": "sessions_v2" },
  "dest": { "index": "sessions_v3" },
  "script": {
    "source": """
      if (ctx._source.containsKey('currentFlow') && ctx._source.currentFlow != null && ctx._source.currentFlow.startsWith('route_')) {
        ctx._source.currentFlow = 'flow_' + ctx._source.currentFlow.substring(6);
      }
    """,
    "lang": "painless"
  }
}
```

---

## Code-Side Migration Recipe

For downstream TypeScript consumers, here's a sed/codemod summary covering the most common public-API touchpoints:

```bash
# Symbol renames (imports and references)
sed -i '' 's/\bRoute\b/Flow/g; s/\bRouteOptions\b/FlowOptions/g; s/\bRouteRef\b/FlowRef/g' src/**/*.ts
sed -i '' 's/\bRouteTransitionConfig\b/FlowTransitionConfig/g' src/**/*.ts
sed -i '' 's/\bRouteCompletionHandler\b/FlowCompletionHandler/g' src/**/*.ts
sed -i '' 's/\bRouteLifecycleHooks\b/FlowLifecycleHooks/g' src/**/*.ts
sed -i '' 's/\bRouteConfigurationError\b/FlowConfigurationError/g' src/**/*.ts
sed -i '' 's/\bRoutingEngine\b/FlowRouter/g' src/**/*.ts

# Constants (END_ROUTE removed — delete all references)
# END_ROUTE/END_FLOW are no longer needed. Remove imports and usages.
# The last step in a flow is the implicit terminus.
sed -i '' '/END_ROUTE/d; /END_FLOW/d' src/**/*.ts

# Methods and fields
sed -i '' 's/\.createRoute(/\.createFlow(/g' src/**/*.ts
sed -i '' 's/\.getRoutes(/\.getFlows(/g' src/**/*.ts
sed -i '' 's/\.nextStepRoute(/\.nextStepFlow(/g' src/**/*.ts
sed -i '' 's/\.getRoutingEngine(/\.getFlowRouter(/g' src/**/*.ts
sed -i '' 's/\brouteSwitchMargin\b/flowSwitchMargin/g' src/**/*.ts
sed -i '' 's/\bgenerateRouteId\b/generateFlowId/g' src/**/*.ts
sed -i '' 's/\benterRoute\b/enterFlow/g' src/**/*.ts

# Session state fields
sed -i '' 's/\.currentRoute/\.currentFlow/g' src/**/*.ts
sed -i '' 's/\.routeHistory/\.flowHistory/g' src/**/*.ts
sed -i '' 's/\btargetRouteId\b/targetFlowId/g' src/**/*.ts

# String literals
sed -i '' "s/'end_route'/'last_step'/g" src/**/*.ts
sed -i '' "s/'route_complete'/'completed'/g" src/**/*.ts

# Configuration
sed -i '' 's/routes:/flows:/g' src/**/*.ts  # Be careful — review matches manually

# Import paths (if importing from @falai/agent internals)
sed -i '' 's/core\/Route/core\/Flow/g' src/**/*.ts
sed -i '' 's/core\/RoutingEngine/core\/FlowRouter/g' src/**/*.ts
sed -i '' 's/types\/route/types\/flow/g' src/**/*.ts
```

**Important:** These sed commands are aggressive. Run them, then use `tsc --noEmit` to catch any false positives (e.g., `routes` in an HTTP router context). Review the diff before committing.

For a safer approach, use a TypeScript-aware codemod tool like [jscodeshift](https://github.com/facebook/jscodeshift) or rely on your IDE's "Find and Replace with Regex" with word-boundary matching.

---

## Verification

After migrating your code, run this ripgrep command to confirm no legacy references remain:

```bash
rg -n '\b(Route|RouteOptions|RouteRef|RouteConfigurationError|RoutingEngine|END_ROUTE|currentRoute|routeHistory|createRoute|generateRouteId|enterRoute|nextStepRoute|getRoutes|routeSwitchMargin)\b' \
  --glob '**/*.ts' \
  --glob '**/*.tsx' \
  --glob '!node_modules/**' \
  --glob '!dist/**'
```

Expected output: **zero matches**.

If you have historical migration notes or changelog entries that reference the old names, exclude them:

```bash
rg -n '\b(Route|RouteOptions|RouteRef|RouteConfigurationError|RoutingEngine|END_ROUTE|currentRoute|routeHistory|createRoute|generateRouteId|enterRoute|nextStepRoute|getRoutes|routeSwitchMargin)\b' \
  --glob '**/*.ts' \
  --glob '**/*.tsx' \
  --glob '!node_modules/**' \
  --glob '!dist/**' \
  --glob '!**/CHANGELOG*' \
  --glob '!**/migration/**'
```

Then run your type checker to confirm everything compiles:

```bash
npx tsc --noEmit
```

---

## FAQ

**Q: Is there a compatibility shim or deprecation period?**
No. This is a clean break. The old names are removed entirely.

**Q: Do I need to migrate my database before deploying?**
Yes. The framework no longer reads or writes the legacy column/field names. Deploy the data migration first, then deploy the new code.

**Q: What about the `route()` method I see on `FlowRouter`?**
That's the verb form — it means "to route a message to a flow." It is intentionally preserved.

**Q: My tests assert on `'end_route'` or `'route_complete'` — what do I do?**
`'end_route'` has been removed entirely (implicit terminus replaces it). Update to `'last_step'`. `'route_complete'` becomes `'last_step'` (no successor) or `'completed'` (explicit directive). TypeScript will flag these as type errors if you miss any.

**Q: I have custom IDs that don't use the `route_` prefix — do I need to migrate them?**
Only IDs generated by `generateRouteId()` (now `generateFlowId()`) use the prefix. If you set custom IDs on your flows, they are unaffected by the prefix change.
