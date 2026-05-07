/**
 * Serialization utilities for tool results and other data
 */

/**
 * Serialize a tool execution result into a string suitable for conversation history.
 *
 * Priority:
 *   1. Failed result → error message
 *   2. String data   → returned as-is
 *   3. Object data   → JSON.stringify (with circular-reference safety)
 *   4. Primitive data → String()
 *   5. No data       → "Tool executed successfully"
 */
export function serializeToolResult(result: {
  success: boolean;
  data?: unknown;
  error?: string;
}): string {
  if (!result.success) {
    return `Tool execution failed: ${result.error || "Unknown error"}`;
  }

  if (result.data === undefined || result.data === null) {
    return "Tool executed successfully";
  }

  if (typeof result.data === "string") {
    return result.data;
  }

  // Primitives (number, boolean) are safe to stringify directly
  if (typeof result.data !== "object") {
    return JSON.stringify(result.data);
  }

  // Objects / arrays — guard against circular references
  try {
    return JSON.stringify(result.data);
  } catch {
    // Circular or otherwise un-serializable object: extract what we can
    const keys = Object.keys(result.data as Record<string, unknown>);
    if (keys.length > 0) {
      return `Tool returned object with keys: ${keys.join(", ")}`;
    }
    return "Tool executed successfully (result could not be serialized)";
  }
}
