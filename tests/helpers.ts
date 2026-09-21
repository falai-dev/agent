import type { StructuredSchema } from "../src/types/schema.js";

/** Every object is closed and every property required: the shape Gemini and OpenAI strict mode accept. */
export function isStrictSchema(schema: StructuredSchema): boolean {
  if (schema.type !== "object" && !(Array.isArray(schema.type) && schema.type.includes("object"))) return true;
  const keys = Object.keys(schema.properties ?? {});
  const required = new Set(schema.required ?? []);
  return (
    schema.additionalProperties === false &&
    keys.every((k) => required.has(k)) &&
    Object.values(schema.properties ?? {}).every(isStrictSchema)
  );
}
