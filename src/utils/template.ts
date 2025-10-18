/**
 * Template rendering utilities for agent prompts
 * Supports {{variable}} and {{object.property}} syntax for context-aware prompt templating
 * Handles complex objects, arrays, and nested property access
 */

/**
 * Renders template variables in a string using the provided context.
 * Supports {{variable}} and {{object.property}} syntax for property access.
 *
 * @param template - The template string containing {{variable}} placeholders
 * @param context - The context object to pull values from
 * @returns The rendered string with variables replaced
 *
 * @example
 * ```typescript
 * const template = "Hello {{user.name}}, welcome to {{company.name}}!";
 * const context = {
 *   user: { name: "Alice", age: 30 },
 *   company: { name: "Acme Corp", location: "NYC" }
 * };
 * const result = renderTemplate(template, context);
 * // Result: "Hello Alice, welcome to Acme Corp!"
 *
 * // Array handling
 * const template2 = "Items: {{items}}";
 * const context2 = { items: ["apple", "banana", "cherry"] };
 * const result2 = renderTemplate(template2, context2);
 * // Result: "Items: apple, banana, cherry"
 * ```
 */
export function renderTemplate(
  template: string,
  context: Record<string, unknown> | undefined
): string {
  if (!template || !context) {
    return template;
  }

  return template.replace(
    /\{\{([^}]+)\}\}/g,
    (match: string, path: string): string => {
      const value = getValueByPath(context, path.trim());
      if (value === undefined || value === null) {
        return match; // Keep the original placeholder if value not found
      }
      return valueToString(value);
    }
  );
}

/**
 * Gets a value from an object using dot notation path.
 * Supports nested property access like "user.name" or "user.address.city".
 *
 * @param obj - The object to search in
 * @param path - The dot-separated path to the property
 * @returns The value at the path, or undefined if not found
 */
function getValueByPath(obj: Record<string, unknown>, path: string): unknown {
  const keys = path.split(".");
  let current: unknown = obj;

  for (const key of keys) {
    if (
      current === null ||
      current === undefined ||
      typeof current !== "object"
    ) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }

  return current;
}

/**
 * Converts a value to its string representation for template rendering.
 * Handles different types appropriately.
 *
 * @param value - The value to convert to string
 * @returns String representation of the value
 */
function valueToString(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }

  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (Array.isArray(value)) {
    // For arrays, join with commas by default
    // Users can override this by using JSON.stringify in their templates if needed
    return value.map((item) => valueToString(item)).join(", ");
  }

  if (typeof value === "object") {
    // For objects, convert to JSON string
    // This provides a readable representation while being safe
    try {
      return JSON.stringify(value);
    } catch {
      return "[object Object]";
    }
  }

  // Fallback for any other type
  return JSON.stringify(value);
}

/**
 * Renders template variables in an array of strings.
 *
 * @param templates - Array of template strings
 * @param context - The context object to pull values from
 * @returns Array of rendered strings
 */
export function renderTemplateArray(
  templates: string[],
  context: Record<string, unknown> | undefined
): string[] {
  return templates.map((template) => renderTemplate(template, context));
}

/**
 * Renders template variables in an object recursively.
 * Handles nested objects and arrays.
 *
 * @param obj - The object to render templates in
 * @param context - The context object to pull values from
 * @returns The object with all string templates rendered
 */
export function renderTemplateObject(
  obj: unknown,
  context: Record<string, unknown> | undefined
): unknown {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj === "string") {
    return renderTemplate(obj, context);
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => renderTemplateObject(item, context));
  }

  if (typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = renderTemplateObject(value, context);
    }
    return result;
  }

  return obj;
}
