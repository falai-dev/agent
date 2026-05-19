/**
 * ID generation utilities
 * Provides deterministic ID generation to ensure consistency across server restarts
 */

/**
 * Generate a deterministic ID from a string by creating a simple hash
 * This ensures the same input always produces the same ID
 */
function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash).toString(36);
}

/**
 * Sanitize a string for use in an ID
 */
function sanitize(str: string): string {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, "_");
}

/**
 * Generate a deterministic flow ID
 * Format: flow_{sanitized_title}_{hash}
 */
export function generateFlowId(title: string): string {
  const sanitized = sanitize(title);
  const hash = simpleHash(title);
  return `flow_${sanitized}_${hash}`;
}

/**
 * Generate a deterministic step ID
 * Format: step_{sanitized_description}_{hash} or step_{flowId}_{index}
 */
export function generateStepId(
  flowId: string,
  description?: string,
  index?: number
): string {
  if (description) {
    const sanitized = sanitize(description);
    const hash = simpleHash(`${flowId}_${description}`);
    return `step_${sanitized}_${hash}`;
  }
  // Fallback for steps without descriptions
  const suffix = index !== undefined ? index : simpleHash(flowId);
  return `step_${flowId}_${suffix}`;
}

/**
 * Generate a deterministic tool ID
 * Format: tool_{sanitized_name}_{hash}
 */
export function generateToolId(name: string): string {
  const sanitized = sanitize(name);
  const hash = simpleHash(name);
  return `tool_${sanitized}_${hash}`;
}

/**
 * Generate a deterministic tool ID for inline tool handlers
 * Format: tool_inline_{stepId}_{hash}
 */
export function generateInlineToolId(stepId: string): string {
  const hash = simpleHash(`${stepId}_inline_tool`);
  return `tool_inline_${stepId}_${hash}`;
}

/**
 * Generate a deterministic signal ID.
 * Format: signal_{sanitized}_{hash}
 *
 * Uses a combination of the signal's title/description/index to produce
 * a stable id that is deterministic within a session (same inputs → same id).
 */
export function generateSignalId(
  title?: string,
  description?: string,
  index?: number
): string {
  const seed = title || description || `signal_${index ?? 0}`;
  const sanitized = sanitize(seed);
  const hash = simpleHash(`signal_${seed}_${index ?? 0}`);
  return `signal_${sanitized}_${hash}`;
}
