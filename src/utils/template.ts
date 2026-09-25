/**
 * `{{path}}` substitution for prompts, `say` texts and action parameters.
 *
 * The scope has three roots: `data` (collected fields), `context` (the host's
 * per-turn context) and `input` (the run's trigger payload). A path that
 * resolves to nothing keeps its placeholder, so a typo stays visible instead
 * of vanishing into an empty string.
 *
 * A path the host answered with nothing is a different case: it knows the
 * field and knows it is blank. Then the placeholder goes and `tidy` closes the
 * gap it left, so "Ola {{context.lead.name}}, tudo bem?" sends "Ola, tudo bem?"
 * and never "Ola , tudo bem?". Two things count as blank: an empty string, and
 * a path that walks THROUGH a null — `context.lead` being `null` means there
 * is no lead, so "the lead's name" is blank, not mistyped. A null at the end of
 * a path is still unknown: a field that collected nothing keeps its braces.
 */

export interface TemplateScope {
  data?: unknown;
  context?: unknown;
  input?: unknown;
}

const PLACEHOLDER = /\{\{\s*([^}\s]+)\s*\}\}/g;

/** The path ran into a `null` on its way down: the container the host named is absent. */
const ABSENT = Symbol("absent");

export function render(template: string, scope: TemplateScope): string {
  let emptied = false;
  const out = template.replace(PLACEHOLDER, (match, path: string) => {
    const value = lookup(scope, path.split("."));
    if (value === ABSENT) {
      emptied = true;
      return "";
    }
    if (value === undefined || value === null) return match;
    const text = stringify(value);
    if (text === "") emptied = true;
    return text;
  });
  return emptied ? tidy(out) : out;
}

/**
 * Close the hole an empty value leaves: a doubled space, a space before
 * punctuation, a comma left before the end of a sentence or before another
 * comma ("Oi, {{name}}!" gives "Oi!", not "Oi,!"; "Oi, {{name}}, tudo bem?"
 * gives "Oi, tudo bem?", not "Oi,, tudo bem?"), punctuation stranded at the
 * start of a line ("{{greeting}}, {{name}}! Tudo bem?" gives "Tudo bem?"), a
 * space at the end of a line.
 *
 * Deliberately narrow. It only runs on a string where something substituted to
 * "", and it only collapses a run of spaces that follows a visible character,
 * so indentation in a markdown list survives. A line that is only punctuation
 * keeps it, so a message never renders to nothing.
 */
function tidy(text: string): string {
  return text
    .replace(/(?<=\S)[ \t]{2,}/g, " ")
    .replace(/ +([,.;:!?\u2026])/g, "$1")
    .replace(/[,;]+(?=[,;.!?\u2026])/g, "")
    .replace(/^([ \t]*)[,;:!?]+[ \t]+(?=\S)/gm, "$1")
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
    if (current === null) return ABSENT;
    if (typeof current !== "object") return undefined;
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
