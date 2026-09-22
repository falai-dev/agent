/**
 * `{{path}}` substitution for prompts, `say` texts and action parameters.
 *
 * The scope has three roots: `data` (collected fields), `context` (the host's
 * per-turn context) and `input` (the run's trigger payload). A path that
 * resolves to nothing keeps its placeholder, so a typo stays visible instead
 * of vanishing into an empty string.
 *
 * A path that resolves to an EMPTY string is a different case: the host knows
 * the field and knows it is blank. Then the placeholder goes and `tidy` closes
 * the gap it left, so "Ola {{context.lead.name}}, tudo bem?" sends
 * "Ola, tudo bem?" and never "Ola , tudo bem?".
 */

export interface TemplateScope {
  data?: unknown;
  context?: unknown;
  input?: unknown;
}

const PLACEHOLDER = /\{\{\s*([^}\s]+)\s*\}\}/g;

export function render(template: string, scope: TemplateScope): string {
  let emptied = false;
  const out = template.replace(PLACEHOLDER, (match, path: string) => {
    const value = lookup(scope, path.split("."));
    if (value === undefined || value === null) return match;
    const text = stringify(value);
    if (text === "") emptied = true;
    return text;
  });
  return emptied ? tidy(out) : out;
}

/**
 * Close the hole an empty value leaves: a doubled space, a space before
 * punctuation, a space at the end of a line.
 *
 * Deliberately narrow. It only runs on a string where something substituted to
 * "", and it only collapses a run of spaces that follows a visible character,
 * so indentation in a markdown list survives.
 */
function tidy(text: string): string {
  return text
    .replace(/(?<=\S)[ \t]{2,}/g, " ")
    .replace(/ +([,.;:!?\u2026])/g, "$1")
    .replace(/[ \t]+$/gm, "");
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
