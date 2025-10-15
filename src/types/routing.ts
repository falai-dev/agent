import type { StructuredSchema } from "./schema";

export interface RoutingDecision {
  context: string;
  routes: Record<string, number>;
  responseDirectives?: string[];
  extractions?: unknown;
  contextUpdate?: Record<string, unknown>;
}

export interface RoutingDecisionWithRoute extends RoutingDecision {
  selectedRouteId: string;
  maxScore: number;
}

export interface RoutingSchemaOptions {
  extrasSchema?: StructuredSchema;
}
