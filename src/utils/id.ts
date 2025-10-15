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
 * Generate a deterministic route ID
 * Format: route_{sanitized_title}_{hash}
 */
export function generateRouteId(title: string): string {
  const sanitized = sanitize(title);
  const hash = simpleHash(title);
  return `route_${sanitized}_${hash}`;
}

/**
 * Generate a deterministic state ID
 * Format: state_{sanitized_description}_{hash} or state_{routeId}_{index}
 */
export function generateStateId(
  routeId: string,
  description?: string,
  index?: number
): string {
  if (description) {
    const sanitized = sanitize(description);
    const hash = simpleHash(`${routeId}_${description}`);
    return `state_${sanitized}_${hash}`;
  }
  // Fallback for states without descriptions
  const suffix = index !== undefined ? index : simpleHash(routeId);
  return `state_${routeId}_${suffix}`;
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
