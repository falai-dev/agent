/**
 * `{{path}}` substitution for prompts, `say` texts and action parameters.
 *
 * The scope has three roots: `data` (collected fields), `context` (the host's
 * per-turn context) and `input` (the run's trigger payload). A path that
 * resolves to nothing keeps its placeholder, so a typo stays visible instead
 * of vanishing into an empty string.
 */

export interface TemplateScope {
  data?: unknown;
  context?: unknown;
  input?: unknown;
}

const PLACEHOLDER = /\{\{\s*([^}\s]+)\s*\}\}/g;

export function render(template: string, scope: TemplateScope): string {
  return template.replace(PLACEHOLDER, (match, path: string) => {
    const value = lookup(scope, path.split("."));
    return value === undefined || value === null ? match : stringify(value);
  });
}

/** `render` over every string inside a value, recursively. Non-strings pass through. */
export function renderDeep<T>(value: T, scope: TemplateScope): T {
  if (typeof value === "string") return render(value, scope) as T;
  if (Array.isArray(value)) return value.map((item: unknown) => renderDeep(item, scope)) as T;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, renderDeep(v, scope)]),
    ) as T;
  }
  return value;
}

function lookup(root: unknown, keys: string[]): unknown {
  let current = root;
  for (const key of keys) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(stringify).join(", ");
  return JSON.stringify(value);
}
