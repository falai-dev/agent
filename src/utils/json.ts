/**
 * JSON parsing utilities
 */

/** JSON's own short escapes for the control characters a model actually types. */
const CONTROL_ESCAPES: Record<string, string> = {
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
  "\b": "\\b",
  "\f": "\\f",
};

/**
 * Escape the raw control characters a model left unescaped inside a string
 * literal.
 *
 * JSON forbids a literal newline between quotes. A model whose decoder is
 * pinned to the schema cannot break that rule, but one merely ASKED for the
 * envelope in its prompt — which is how a schema rides on any call that also
 * carries tools — breaks it constantly, because it pretty-prints the reply it
 * would have sent:
 *
 *     {
 *     "message": "Boa escolha!
 *     À vista: R$ 3.149"
 *     }
 *
 * `JSON.parse` calls that an unterminated string and gives up, and the whole
 * envelope travels on as the user-visible reply. Re-escaping the control
 * characters makes it parse into exactly what the model meant.
 *
 * A string ends at the next unescaped quote, so a stray quote inside the
 * message shifts the boundary and the result fails to parse. That is the
 * intended outcome: a wrong guess must never become a reply.
 */
function escapeControlCharsInStrings(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;

  for (const ch of text) {
    if (!inString) {
      if (ch === '"') inString = true;
      out += ch;
      continue;
    }
    if (escaped) {
      escaped = false;
      out += ch;
    } else if (ch === "\\") {
      escaped = true;
      out += ch;
    } else if (ch === '"') {
      inString = false;
      out += ch;
    } else if (ch < " ") {
      out += CONTROL_ESCAPES[ch] ?? `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`;
    } else {
      out += ch;
    }
  }

  return out;
}

/**
 * Parse strictly, then once more with {@link escapeControlCharsInStrings}.
 * Throws when neither reading is valid JSON.
 */
function parseLenient(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (strictError) {
    try {
      return JSON.parse(escapeControlCharsInStrings(text));
    } catch {
      // The repair is a second reading of the same text, not a different
      // dialect — so the first violation is the one worth reporting.
      throw strictError;
    }
  }
}

/**
 * Whether text is shaped like a protocol envelope rather than a reply to a
 * person — an opening brace or a code fence. Text that fails to parse AND
 * looks like this is never user-worthy: it is a broken envelope, and showing
 * it is the leak this module exists to prevent.
 */
export function isJSONShaped(text: string): boolean {
  return /^\s*(```|\{)/.test(text);
}

/**
 * Clean and parse JSON response that might be wrapped in markdown code blocks
 * Handles cases like:
 * - ```json\n{...}\n```
 * - ```\n{...}\n```
 * - Plain JSON: {...}
 * - An object whose string values carry unescaped newlines
 */
export function parseJSONResponse(text: string): unknown {
  if (!text || typeof text !== 'string') {
    throw new Error('Invalid JSON response: empty or non-string input');
  }

  // Trim whitespace
  let cleaned = text.trim();

  // Remove markdown code block markers
  // Match: ```json or ``` at start, and ``` at end
  const codeBlockRegex = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/;
  const match = cleaned.match(codeBlockRegex);
  
  if (match) {
    cleaned = match[1].trim();
  }

  // Try to parse the cleaned JSON
  try {
    return parseLenient(cleaned);
  } catch (error) {
    throw new Error(`Failed to parse JSON response: ${error instanceof Error ? error.message : String(error)}\nContent: ${cleaned.substring(0, 200)}...`);
  }
}

/**
 * Safely parse JSON response, returning undefined on failure
 */
export function tryParseJSONResponse(text: string): unknown {
  try {
    return parseJSONResponse(text);
  } catch {
    return undefined;
  }
}

/**
 * Find a complete JSON object embedded in surrounding text.
 *
 * {@link parseJSONResponse} requires the WHOLE string to be the object. A model
 * told to answer in JSON sometimes answers twice instead — the conversational
 * text for the user, and then the protocol envelope repeating it — and such a
 * turn parses as nothing, so the envelope travels on as user-visible content.
 * This scans for the first balanced `{...}` that parses as an object, ignoring
 * braces that sit inside string literals.
 *
 * Returns `undefined` when no complete object is present (prose that merely
 * contains a brace, or an envelope truncated before its closing brace).
 */
export function extractEmbeddedJSONObject(text: string): Record<string, unknown> | undefined {
  if (!text) return undefined;

  for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
    const end = findObjectEnd(text, start);
    if (end === -1) continue;

    try {
      const parsed = parseLenient(text.slice(start, end + 1));
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Not an object after all — keep scanning for a later candidate.
    }
  }

  return undefined;
}

/**
 * Index of the `}` closing the object that opens at `start`, or -1 when the
 * text ends first. Quotes and their escapes are tracked so a brace inside a
 * string value never opens or closes a level.
 */
function findObjectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return i;
  }

  return -1;
}

/** A plain object: not null, not an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
