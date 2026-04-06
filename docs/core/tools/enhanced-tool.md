# EnhancedTool Interface

`EnhancedTool` extends the existing `Tool` interface with optional metadata for concurrency control, permission gating, input validation, and result size management. All additional methods are optional — plain `Tool` objects remain fully compatible.

## Interface

```typescript
interface EnhancedTool<TContext = any, TData = any, TResult = any>
  extends Tool<TContext, TData, TResult> {

  // Concurrency & safety
  isConcurrencySafe?(input?: Record<string, unknown>): boolean;
  isReadOnly?(input?: Record<string, unknown>): boolean;
  isDestructive?(input?: Record<string, unknown>): boolean;

  // Execution control
  interruptBehavior?(): 'cancel' | 'block';
  maxResultSizeChars?: number;

  // Validation & permissions
  validateInput?(
    input: Record<string, unknown>,
    context: ToolContext<TContext, TData>
  ): Promise<ToolValidationResult> | ToolValidationResult;

  checkPermissions?(
    input: Record<string, unknown>,
    context: ToolContext<TContext, TData>
  ): Promise<ToolPermissionResult> | ToolPermissionResult;
}
```

## Methods & Properties

### isConcurrencySafe

Returns `true` if this tool can safely run in parallel with other concurrency-safe tools. The `StreamingToolExecutor` evaluates this once at queue time and caches the result.

Default (when absent): `false` — the tool runs serially.

```typescript
const listFiles: EnhancedTool = {
  id: "list-files",
  name: "list_files",
  description: "List files in a directory",
  handler: async (ctx, args) => { /* ... */ },
  isConcurrencySafe: () => true,
};
```

The method receives the tool's input arguments, so concurrency safety can be input-dependent:

```typescript
isConcurrencySafe: (input) => {
  // Safe for read paths, not safe for write paths
  return input?.mode === "read";
},
```

### isReadOnly / isDestructive

Informational metadata. `isReadOnly` indicates the tool has no side effects; `isDestructive` indicates irreversible operations. Both default to `false` when absent.

```typescript
isReadOnly: () => true,
isDestructive: () => false,
```

### interruptBehavior

Controls how the tool responds to abort signals (sibling failure or parent cancellation):

- `'cancel'` — immediately abort the tool
- `'block'` — allow the tool to finish (default when absent)

```typescript
interruptBehavior: () => "cancel",
```

### maxResultSizeChars

Maximum characters for the tool result. Results exceeding this limit are truncated with a notice like `[Truncated: 12000 chars total, showing first 5000]`.

```typescript
maxResultSizeChars: 50_000,
```

### validateInput

Called before the tool handler. If it returns `{ valid: false }`, the handler is never invoked and a validation error is returned instead.

```typescript
validateInput: async (input, ctx) => {
  if (!input.resourceId || typeof input.resourceId !== "string") {
    return { valid: false, error: "resourceId must be a non-empty string" };
  }
  return { valid: true };
},
```

The return type:

```typescript
interface ToolValidationResult {
  valid: boolean;
  error?: string;
  correctedInput?: Record<string, unknown>;
}
```

### checkPermissions

Called before the tool handler (after validation). If it returns `{ allowed: false }`, the handler is never invoked and a permission error is returned.

```typescript
checkPermissions: async (input, ctx) => {
  const role = (ctx.context as any)?.userRole;
  if (role !== "admin") {
    return { allowed: false, reason: "Only admins can delete resources", canOverride: false };
  }
  return { allowed: true };
},
```

The return type:

```typescript
interface ToolPermissionResult {
  allowed: boolean;
  reason?: string;
  canOverride?: boolean;
}
```

## Full Example

```typescript
const deleteTool: EnhancedTool = {
  id: "delete-resource",
  name: "delete_resource",
  description: "Delete a resource permanently",
  parameters: {
    type: "object",
    properties: { resourceId: { type: "string" } },
    required: ["resourceId"],
  },
  handler: async (ctx, args) => {
    await deleteResource(args?.resourceId as string);
    return { success: true };
  },

  isConcurrencySafe: () => false,
  isReadOnly: () => false,
  isDestructive: () => true,
  interruptBehavior: () => "block",
  maxResultSizeChars: 500,

  validateInput: async (input) => {
    if (!input.resourceId || typeof input.resourceId !== "string") {
      return { valid: false, error: "resourceId must be a non-empty string" };
    }
    return { valid: true };
  },

  checkPermissions: async (input, ctx) => {
    const role = (ctx.context as any)?.userRole;
    if (role !== "admin") {
      return { allowed: false, reason: "Only admins can delete resources" };
    }
    return { allowed: true };
  },
};
```

## Backward Compatibility

Plain `Tool` objects without any `EnhancedTool` methods work exactly as before. The framework applies these defaults:

| Property | Default |
|---|---|
| `isConcurrencySafe` | `false` |
| `isReadOnly` | `false` |
| `isDestructive` | `false` |
| `interruptBehavior` | `'block'` |
| `validateInput` | skipped |
| `checkPermissions` | skipped |
