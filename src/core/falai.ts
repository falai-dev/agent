/**
 * `falai()` carries the one explicit generic an app writes: its context type.
 * Everything else is inferred from values.
 *
 * ```ts
 * const f = falai<LeadContext>().fields({
 *   nome: { type: 'string', ask: 'Pergunte o nome de um jeito leve.' },
 * });
 * const agent = f.agent({ name: 'Ana', provider, flows: [f.flow({ ... })] });
 * const r = await agent.turn({ sessionId: 'demo', context, message: 'oi' });
 * ```
 *
 * `f.fields(...)` binds the collected-data type, so every `collect`, `ask`,
 * `clearOnStart` and action `ctx.set` downstream is checked against the
 * field slugs. Action, event and condition names inside flows stay strings:
 * they are checked when the agent is built, the same way JSON specs are.
 */

import type { AgentOptions } from "../types/agent.js";
import type {
  Action,
  ActionCtx,
  ActionResult,
  Condition,
  EventDef,
  FieldDefs,
  Flow,
  InferData,
  InferParams,
  ParamDefs,
  PredCtx,
} from "../types/flow.js";
import { Agent } from "./Agent.js";

/** The toolkit once fields are bound. `D` is the collected-data type. */
export interface Falai<C, D, F extends FieldDefs> {
  /** The field definitions, as given. */
  readonly fields: F;
  /** A host action; `params` is typed from `parameters`. */
  action<const P extends ParamDefs>(def: {
    description?: string;
    parameters: P;
    run: (params: InferParams<P>, ctx: ActionCtx<C, D>) => ActionResult | Promise<ActionResult>;
  }): Action<C, D, InferParams<P>>;
  /** A host event; `P` is its payload type. */
  event<P = undefined>(def?: { direction?: "inbound" | "outbound" }): EventDef<P>;
  /** A host condition JSON predicates may name. */
  condition<Arg>(check: (ctx: PredCtx<C, D>, arg: Arg) => boolean): Condition<C, D, Arg>;
  /** A flow; returns it unchanged, typed. */
  flow(def: Flow<C, D>): Flow<C, D>;
  /** The agent; `fields` come from the toolkit. */
  agent(options: Omit<AgentOptions<C, D>, "fields">): Agent<C, D>;
}

/** The toolkit before fields are bound: loose data, plus `fields()` to bind them. */
export interface FalaiRoot<C> extends Omit<Falai<C, InferData<FieldDefs>, FieldDefs>, "fields"> {
  fields<const F extends FieldDefs>(defs: F): Falai<C, InferData<F>, F>;
}

/** The collected-data type of a bound toolkit: `type Data = DataOf<typeof f>`. */
export type DataOf<T extends { fields: FieldDefs }> = InferData<T["fields"]>;

function toolkit<C, D, F extends FieldDefs>(fields: F): Falai<C, D, F> {
  return {
    fields,
    action: (def) => def,
    event: (def = {}) => def,
    condition: (check) => ({ check }),
    flow: (def) => def,
    agent: (options) => new Agent<C, D>({ ...options, fields }),
  };
}

/**
 * Start here. Pass the host context type; `falai()` alone means no context.
 */
export function falai<C = undefined>(): FalaiRoot<C> {
  return {
    ...toolkit<C, InferData<FieldDefs>, FieldDefs>({}),
    fields: (defs) => toolkit(defs),
  };
}
