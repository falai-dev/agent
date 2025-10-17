/**
 * Special marker to end a route/journey
 */
export const END_ROUTE = Symbol("END_ROUTE");

/**
 * String constant for END_ROUTE comparisons
 * Use this when checking if currentStep.id has reached END_ROUTE
 */
export const END_ROUTE_ID = "END_ROUTE";
