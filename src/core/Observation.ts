/**
 * Observation for route disambiguation
 */

import type {
  Observation as IObservation,
  ObservationOptions,
} from "@/types/observation";
import type { RouteRef } from "@/types/route";
import type { Route } from "@/core/Route";

let observationIdCounter = 0;

/**
 * An observation that can trigger disambiguation between routes
 */
export class Observation implements IObservation {
  public readonly id: string;
  public readonly description: string;
  public routes: RouteRef[] = [];

  constructor(options: ObservationOptions) {
    this.id = `observation_${++observationIdCounter}`;
    this.description = options.description;
  }

  /**
   * Set routes that this observation can disambiguate between
   */
  disambiguate(routes: (Route | RouteRef)[]): this {
    this.routes = routes.map((r) => {
      if ("getRef" in r) {
        return r.getRef();
      }
      return r;
    });
    return this;
  }

  /**
   * Get the routes this observation disambiguates
   */
  getRoutes(): RouteRef[] {
    return [...this.routes];
  }
}
