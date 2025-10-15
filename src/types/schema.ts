/**
 * StructuredSchema - minimal JSON Schema subset used across providers
 */
export interface StructuredSchema {
  type?: string | string[];
  description?: string;
  enum?: Array<string | number | boolean | null>;
  nullable?: boolean;
  properties?: Record<string, StructuredSchema>;
  required?: string[];
  items?: StructuredSchema;
  additionalProperties?: boolean | StructuredSchema;
  // Allow provider-specific passthroughs without breaking types
  [key: string]: unknown;
}

/**
 * A small helper describing a named schema (for providers that require a name)
 */
export interface NamedSchema {
  name?: string;
  schema: StructuredSchema;
}
