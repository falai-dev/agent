/**
 * JSON parsing utilities
 */

/**
 * Clean and parse JSON response that might be wrapped in markdown code blocks
 * Handles cases like:
 * - ```json\n{...}\n```
 * - ```\n{...}\n```
 * - Plain JSON: {...}
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
    return JSON.parse(cleaned);
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
      const parsed = JSON.parse(text.slice(start, end + 1));
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
