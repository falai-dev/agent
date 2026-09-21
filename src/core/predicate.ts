/**
 * Code predicates: a function runs as is; a `ConditionSpec` is AND over its
 * keys, with `equals`, `known` and `silenced` built in and every other key
 * looked up in the agent's conditions.
 */

import { FlowConfigurationError } from "../types/errors.js";
import type { ConditionMap, Pred, PredCtx } from "../types/flow.js";
import { isKnown } from "../utils/schema.js";

export function evaluate<C, D, P>(
  pred: Pred<C, D, P>,
  ctx: PredCtx<C, D, P>,
  conditions: ConditionMap<C, D>,
): boolean {
  if (typeof pred === "function") return pred(ctx);
  const data: Record<string, unknown> = ctx.data;
  for (const [name, arg] of Object.entries(pred)) {
    if (arg === undefined) continue;
    let holds: boolean;
    switch (name) {
      case "equals":
        holds = Object.entries(arg as Record<string, unknown>).every(([field, value]) => deepEqual(data[field], value));
        break;
      case "known":
        holds = (arg as string[]).every((field) => isKnown(data[field]));
        break;
      case "silenced":
        holds = (ctx.silenced !== undefined) === Boolean(arg);
        break;
      default: {
        const condition = conditions[name];
        if (!condition) {
          throw new FlowConfigurationError(
            `[FlowConfigurationError] unknown condition "${name}": it is not one of the agent's conditions. ` +
              `Register it under \`conditions\` or fix the name.`,
          );
        }
        holds = condition.check(ctx, arg);
      }
    }
    if (!holds) return false;
  }
  return true;
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  const bRecord = b as Record<string, unknown>;
  return ka.every((k) => k in bRecord && deepEqual((a as Record<string, unknown>)[k], bRecord[k]));
}
