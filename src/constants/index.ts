/**
 * Special marker to end a route/journey
 */
export const END_STATE = Symbol("END_STATE");

/**
 * String constant for END_STATE comparisons
 * Use this when checking if currentState.id has reached END_STATE
 */
export const END_STATE_ID = "END_STATE";
