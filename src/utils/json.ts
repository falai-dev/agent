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
export function tryParseJSONResponse(text: string): unknown | undefined {
  try {
    return parseJSONResponse(text);
  } catch {
    return undefined;
  }
}
