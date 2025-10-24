import type { Template, TemplateContext } from "../types";
import type { Event, MessageEventData } from "../types/history";
import { MessageRole, EventKind } from "../types/history";

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

/**
 * Creates helper functions for working with history and context in templates.
 * These helpers make it easier to access message content and perform common operations.
 *
 * @param history - The event history array
 * @returns Object containing helper functions
 */
export function createTemplateHelpers(history?: Event[]) {
  const helpers = {
    /**
     * Get the last message from history, optionally filtered by role.
     * @param role - Optional role to filter by (user, assistant, etc.)
     * @returns The message content or undefined if not found
     */
    getLastMessage(role?: MessageRole): string | undefined {
      if (!history || history.length === 0) return undefined;

      // Search backwards through history for the most recent message
      for (let i = history.length - 1; i >= 0; i--) {
        const event = history[i];
        if (event.kind === EventKind.MESSAGE) {
          // If no role specified, return the first message found
          if (!role || event.source === role) {
            const messageData = event.data as MessageEventData;
            return messageData.message;
          }
        }
      }
      return undefined;
    },

    /**
     * Get the last user message from history.
     * @returns The user message content or undefined if not found
     */
    getLastUserMessage(): string | undefined {
      return helpers.getLastMessage(MessageRole.USER);
    },

    /**
     * Get the last assistant message from history.
     * @returns The assistant message content or undefined if not found
     */
    getLastAssistantMessage(): string | undefined {
      return helpers.getLastMessage(MessageRole.ASSISTANT);
    },

    /**
     * Get all messages from history, optionally filtered by role.
     * @param role - Optional role to filter by
     * @returns Array of message contents
     */
    getMessages(role?: MessageRole): string[] {
      if (!history || history.length === 0) return [];

      const messages: string[] = [];
      for (const event of history) {
        if (event.kind === EventKind.MESSAGE) {
          if (!role || event.source === role) {
            const messageData = event.data as MessageEventData;
            messages.push(messageData.message);
          }
        }
      }
      return messages;
    },

    /**
     * Check if the last message contains any of the given keywords.
     * @param keywords - Keywords to search for
     * @param caseSensitive - Whether to perform case-sensitive search (default: false)
     * @returns True if any keyword is found
     */
    lastMessageContains(keywords: string | string[], caseSensitive: boolean = false): boolean {
      const lastMessage = helpers.getLastMessage();
      if (!lastMessage) return false;

      const searchText = caseSensitive ? lastMessage : lastMessage.toLowerCase();
      const keywordArray = Array.isArray(keywords) ? keywords : [keywords];
      
      return keywordArray.some(keyword => {
        const searchKeyword = caseSensitive ? keyword : keyword.toLowerCase();
        return searchText.includes(searchKeyword);
      });
    },
  };

  return helpers;
}

/**
 * Creates a complete TemplateContext with helpers included.
 * This is a convenience function for creating template contexts with all the helper methods.
 *
 * @param params - The base template context parameters
 * @returns Complete TemplateContext with helpers
 */
export function createTemplateContext<TContext = unknown, TData = unknown>(
  params: Omit<Partial<TemplateContext<TContext, TData>>, 'helpers'>
): TemplateContext<TContext, TData> {
  return {
    ...params,
    data: params.data || {},
    helpers: createTemplateHelpers(params.history),
  };
}

/**
 * Formats a JSON structure into readable markdown format.
 * Handles nested objects, arrays, and primitive values.
 *
 * @param data - The JSON data to format
 * @param title - Optional title for the knowledge base section
 * @param maxDepth - Maximum nesting depth (default: 3)
 * @returns Formatted markdown string
 *
 * @example
 * ```typescript
 * const knowledge = {
 *   company: {
 *     name: "Acme Corp",
 *     products: ["Widget A", "Widget B"],
 *     locations: {
 *       headquarters: "NYC",
 *       branches: ["LA", "Chicago"]
 *     }
 *   }
 * };
 *
 * const markdown = formatKnowledgeBase(knowledge, "Company Information");
 * // Output:
 * // ## Company Information
 * //
 * // ### company
 * // - **name**: Acme Corp
 * // - **products**:
 * //   - Widget A
 * //   - Widget B
 * // - **locations**:
 * //   - **headquarters**: NYC
 * //   - **branches**:
 * //     - LA
 * //     - Chicago
 * ```
 */
export function formatKnowledgeBase(
  data: Record<string, unknown>,
  title?: string,
  maxDepth: number = 3
): string {
  const lines: string[] = [];

  if (title) {
    lines.push(`## ${title}`);
    lines.push("");
  }

  if (!data || typeof data !== "object") {
    lines.push("*No knowledge base data available*");
    return lines.join("\n");
  }

  formatObject(data, lines, 0, maxDepth);

  return lines.join("\n");
}

/**
 * Recursively formats an object into markdown format
 */
function formatObject(
  obj: Record<string, unknown>,
  lines: string[],
  depth: number,
  maxDepth: number,
  prefix: string = ""
): void {
  const entries = Object.entries(obj);

  if (entries.length === 0) {
    lines.push(`${prefix}*Empty*`);
    return;
  }

  for (const [key, value] of entries) {
    const currentPrefix = prefix ? `${prefix}  ` : "";

    if (value === null || value === undefined) {
      lines.push(`${currentPrefix}- **${key}**: *Not specified*`);
    } else if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      lines.push(`${currentPrefix}- **${key}**: ${value}`);
    } else if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${currentPrefix}- **${key}**: *Empty list*`);
      } else {
        lines.push(`${currentPrefix}- **${key}**:`);
        for (const item of value) {
          if (
            typeof item === "string" ||
            typeof item === "number" ||
            typeof item === "boolean"
          ) {
            lines.push(`${currentPrefix}  - ${item}`);
          } else if (
            depth < maxDepth &&
            typeof item === "object" &&
            item !== null
          ) {
            lines.push(`${currentPrefix}  - ${JSON.stringify(item)}`);
          } else {
            lines.push(`${currentPrefix}  - ${JSON.stringify(item)}`);
          }
        }
      }
    } else if (typeof value === "object") {
      if (depth < maxDepth) {
        lines.push(`${currentPrefix}- **${key}**:`);
        formatObject(
          value as Record<string, unknown>,
          lines,
          depth + 1,
          maxDepth,
          currentPrefix
        );
      } else {
        lines.push(`${currentPrefix}- **${key}**: ${JSON.stringify(value)}`);
      }
    } else {
      lines.push(`${currentPrefix}- **${key}**: ${JSON.stringify(value)}`);
    }
  }
}
