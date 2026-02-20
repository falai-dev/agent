import type { StructuredSchema } from "./schema";

export interface RoutingDecision {
  context: string;
  routes: Record<string, number>;
  responseDirectives?: string[];
  extractions?: unknown;
  contextUpdate?: Record<string, unknown>;
}

export interface RoutingSchemaOptions {
  extrasSchema?: StructuredSchema;
}
