/**
 * Level-1 factory for constructing an Agent from a single options object.
 *
 * `createAgent` is syntactic sugar over `new Agent(options)` and is the
 * recommended entry point in docs and examples. Generic inference flows
 * from `schema` through `flows[].steps[].collect` identically to `new Agent`.
 *
 * @example
 * ```typescript
 * const agent = createAgent({
 *   name: 'BookingBot',
 *   provider: new GeminiProvider({ apiKey }),
 *   schema: { type: 'object', properties: { name: { type: 'string' }, email: { type: 'string' } } },
 *   flows: [{ title: 'Onboarding', steps: [{ collect: ['name', 'email'] }] }],
 * });
 * ```
 *
 * **Validates: Requirements 14.1–14.7**
 */

import { Agent } from "./Agent";
import type { AgentOptions } from "../types";

/**
 * Create an Agent from a single options object.
 *
 * This is the recommended entry point for constructing agents in v2.
 * Accepts the same options as `new Agent(options)` — `schema`, `provider`,
 * `instructions`, `flows`, and everything else `AgentOptions` carries.
 *
 * Generic inference flows from `schema` through `flows[].steps[].collect`.
 * Invalid `collect` references throw `FlowConfigurationError` at construction time.
 *
 * Post-construction flow registration is still available via `agent.createFlow(...)`.
 */
export function createAgent<TContext = unknown, TData = unknown>(
    options: AgentOptions<TContext, TData>
): Agent<TContext, TData> {
    return new Agent<TContext, TData>(options);
}
