import type { Template, TemplateContext } from "../types/template";

/**
 * Renders a template, which can be a string or a function, using the provided context.
 * This function is asynchronous to support template functions that perform async operations.
 *
 * @param template - The template to render (string or function).
 * @param params - The context object to pass to the template function.
 * @returns A promise that resolves to the rendered string.
 *
 * @example
 * ```typescript
 * // With a string template
 * const result1 = await render("Hello {{name}}", { context: { name: "Alice" } });
 * // Result: "Hello Alice"
 *
 * // With a function template
 * const fnTemplate = ({ context }) => `Hello ${context.name}`;
 * const result2 = await render(fnTemplate, { context: { name: "Bob" } });
 * // Result: "Hello Bob"
 * ```
 */
export async function render<TContext = unknown, TData = unknown>(
  template: Template<TContext, TData> | undefined,
  params: TemplateContext<TContext, TData>
): Promise<string> {
  if (typeof template === "function") {
    // Execute the function and await the result if it's a promise
    const result = await Promise.resolve(template(params));
    return result;
  }

  if (typeof template === "string") {
    // Fallback to the old renderTemplate logic for string-based templates
    return renderTemplate(template, params.context as Record<string, unknown>);
  }

  // Return empty string if template is undefined or not a supported type
  return "";
}

/**
 * Renders an array of templates.
 *
 * @param templates - An array of templates to render.
 * @param params - The context object.
 * @returns A promise that resolves to an array of rendered strings.
 */
export async function renderMany<TContext = unknown, TData = unknown>(
  templates: Template<TContext, TData>[] | undefined,
  params: TemplateContext<TContext, TData>
): Promise<string[]> {
  if (!templates) {
    return [];
  }
  return Promise.all(templates.map((t) => render(t, params)));
}

/**
 * @deprecated Use the asynchronous `render` function instead.
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
 * @deprecated This function does not support async template functions.
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
