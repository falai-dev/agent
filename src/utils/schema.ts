import type { StructuredSchema } from "../types/schema";

/**
 * Convert our StructuredSchema to the OpenAI/OpenRouter JSON schema format
 * (they already accept standard JSON Schema for responses.parse)
 */
export function convertToOpenAIJsonSchema(schema: StructuredSchema): object {
  // For now our schema aligns well with JSON Schema draft-like structure
  // Return as-is; callers should ensure correctness
  return schema as object;
}

/**
 * Convert our StructuredSchema to Gemini responseSchema (Type mapping)
 * The @google/genai expects a slightly different shape
 */
export function convertToGeminiSchema(schema: StructuredSchema): object {
  // Basic passthrough. If needed, a deeper mapping can be added later.
  // Gemini supports a similar structure (type, properties, items, enum, etc.)
  return schema as object;
}

/**
 * Convert our StructuredSchema into Anthropic system prompt constraints.
 * Since Anthropic lacks native schema parsing, we embed a concise instruction.
 */
export function convertToAnthropicConstraint(schema: StructuredSchema): string {
  // Keep it concise to avoid context bloat
  return `You must respond with valid JSON that matches this schema: ${JSON.stringify(
    schema
  )}`;
}
