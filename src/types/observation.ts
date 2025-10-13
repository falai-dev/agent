/**
 * Observation types for disambiguation
 */

import type { RouteRef } from "./route";

/**
 * An observation that can disambiguate between multiple routes
 */
export interface Observation {
  /** Unique identifier */
  id: string;
  /** The observation description */
  description: string;
  /** Routes this observation can disambiguate between */
  routes?: RouteRef[];
}

/**
 * Options for creating an observation
 */
export interface ObservationOptions {
  /** The observation description */
  description: string;
  /** Route IDs or titles to disambiguate between (can be set later with disambiguate()) */
  routeRefs?: string[];
}
