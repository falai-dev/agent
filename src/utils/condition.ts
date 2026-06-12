import type { TemplateContext, ConditionEvaluationResult } from "../types/template";
import { createTemplateContext } from "./template";
import { logger } from './logger'

/**
 * Condition template — kept as a private type for internal use by the evaluator.
 * Removed from the public surface in v2.
 */
type ConditionTemplate<TContext = unknown, TData = unknown> =
  | string
  | ((params: TemplateContext<TContext, TData>) => boolean | Promise<boolean>)
  | ConditionTemplate<TContext, TData>[];

export interface WhenConditionGroups {
  positive: string[];
  negative: string[];
}

function emptyWhenConditionGroups(): WhenConditionGroups {
  return { positive: [], negative: [] };
}

function pushWhenCondition(groups: WhenConditionGroups, value: string): void {
  const condition = value.trim();
  if (!condition) {
    return;
  }

  if (condition.startsWith("!")) {
    const negative = condition.slice(1).trim();
    if (negative) {
      groups.negative.push(negative);
    }
    return;
  }

  groups.positive.push(condition);
}

/**
 * Evaluate code (`if`) predicates with AND semantics and short-circuit.
 *
 * Shared by branch and signal evaluation — both define `if` as one predicate
 * or an array of predicates over their respective contexts. A predicate that
 * throws is logged at ERROR (with `label` and index) and treated as false,
 * so a failing predicate only inhibits its own entry.
 */
export async function evaluateIfPredicates<TCtx>(
  predicates:
    | ((ctx: TCtx) => boolean | Promise<boolean>)
    | Array<(ctx: TCtx) => boolean | Promise<boolean>>,
  ctx: TCtx,
  label: string,
): Promise<boolean> {
  const predicateArray = Array.isArray(predicates) ? predicates : [predicates];

  for (let i = 0; i < predicateArray.length; i++) {
    try {
      const result = await predicateArray[i](ctx);
      if (!result) {
        return false;
      }
    } catch (error) {
      logger.error(
        `[${label}] Predicate at index ${i} threw: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  return true;
}

/**
 * Split AI-evaluated `when` strings into positive alternatives and negative
 * exclusions. Positive entries are OR alternatives. `!`-prefixed entries are
 * stripped and treated as OR exclusions, where any match inhibits the condition.
 */
export function splitWhenConditions(
  when: string | string[] | undefined | null
): WhenConditionGroups {
  const groups = emptyWhenConditionGroups();
  if (when == null) {
    return groups;
  }

  const entries: unknown[] = Array.isArray(when) ? when : [when];
  for (const entry of entries) {
    if (typeof entry === "string") {
      pushWhenCondition(groups, entry);
    }
  }

  return groups;
}

function splitConditionTemplate<TContext = unknown, TData = unknown>(
  condition: ConditionTemplate<TContext, TData> | undefined | null
): WhenConditionGroups {
  const groups = emptyWhenConditionGroups();
  if (condition == null) {
    return groups;
  }

  if (Array.isArray(condition)) {
    for (const subCondition of condition) {
      const subGroups = splitConditionTemplate(subCondition);
      groups.positive.push(...subGroups.positive);
      groups.negative.push(...subGroups.negative);
    }
    return groups;
  }

  if (typeof condition === "string") {
    pushWhenCondition(groups, condition);
  }

  return groups;
}

/**
 * Utility class for evaluating ConditionTemplate instances.
 * Handles mixed string/function conditions and separates programmatic
 * evaluation from AI context collection.
 */
export class ConditionEvaluator<TContext = unknown, TData = unknown> {
  constructor(private templateContext: TemplateContext<TContext, TData>) { }

  /**
   * Evaluates a condition template and returns both programmatic results
   * and AI context strings.
   * 
   * @param condition The condition to evaluate
   * @param logic Logic to apply for arrays ('AND' for when conditions, 'OR' for skipIf)
   * @returns Evaluation result with programmatic result and AI context
   */
  async evaluateCondition(
    condition: ConditionTemplate<TContext, TData>,
    logic: 'AND' | 'OR' = 'AND'
  ): Promise<ConditionEvaluationResult> {
    const result: ConditionEvaluationResult = {
      programmaticResult: logic === 'AND' ? true : false,
      aiContextStrings: [],
      aiExclusionStrings: [],
      hasProgrammaticConditions: false,
      evaluationDetails: []
    };

    if (!condition) {
      return result;
    }

    // Handle array conditions
    if (Array.isArray(condition)) {
      return this.evaluateArrayCondition(condition, logic);
    }

    // Handle string conditions (AI context only)
    if (typeof condition === 'string') {
      const groups = splitWhenConditions(condition);
      result.aiContextStrings.push(...groups.positive);
      result.aiExclusionStrings?.push(...groups.negative);
      result.evaluationDetails?.push({
        condition: condition,
        type: 'string'
      });
      // For string conditions, programmatic result depends on logic:
      // AND logic: true (doesn't affect result)
      // OR logic: false (doesn't trigger skip)
      result.programmaticResult = logic === 'AND' ? true : false;
      return result;
    }

    // Handle function conditions (programmatic evaluation)
    if (typeof condition === 'function') {
      result.hasProgrammaticConditions = true;
      try {
        const functionResult = await condition(this.templateContext);
        result.programmaticResult = Boolean(functionResult);
        result.evaluationDetails?.push({
          condition: condition.toString(),
          result: result.programmaticResult,
          type: 'function'
        });
      } catch (error) {
        // Log error and default to false for safety
        logger.warn('Condition function evaluation failed:', error);
        result.programmaticResult = false;
        result.evaluationDetails?.push({
          condition: condition.toString(),
          result: false,
          type: 'function'
        });
      }
      return result;
    }

    // Fallback for unexpected types
    logger.warn('Unexpected condition type:', typeof condition);
    return result;
  }

  /**
   * Evaluates an array of conditions with the specified logic.
   */
  private async evaluateArrayCondition(
    conditions: ConditionTemplate<TContext, TData>[],
    logic: 'AND' | 'OR'
  ): Promise<ConditionEvaluationResult> {
    const result: ConditionEvaluationResult = {
      programmaticResult: logic === 'AND' ? true : false,
      aiContextStrings: [],
      aiExclusionStrings: [],
      hasProgrammaticConditions: false,
      evaluationDetails: [{
        condition: `Array[${conditions.length}]`,
        type: 'array'
      }]
    };

    const functionResults: boolean[] = [];

    for (const condition of conditions) {
      const conditionResult = await this.evaluateCondition(condition, logic);

      // Collect AI context strings
      result.aiContextStrings.push(...conditionResult.aiContextStrings);
      result.aiExclusionStrings?.push(...(conditionResult.aiExclusionStrings ?? []));

      // Track if we have programmatic conditions
      if (conditionResult.hasProgrammaticConditions) {
        result.hasProgrammaticConditions = true;
        functionResults.push(conditionResult.programmaticResult);
      }

      // Merge evaluation details
      if (conditionResult.evaluationDetails) {
        result.evaluationDetails?.push(...conditionResult.evaluationDetails);
      }
    }

    // Apply logic to function results only
    if (functionResults.length > 0) {
      if (logic === 'AND') {
        result.programmaticResult = functionResults.every(r => r);
      } else { // OR
        result.programmaticResult = functionResults.some(r => r);
      }
    } else {
      // No programmatic conditions, result depends on logic:
      // AND: true (no functions to fail)
      // OR: false (no functions to succeed)
      result.programmaticResult = logic === 'AND' ? true : false;
    }

    return result;
  }
}

/**
 * Utility function to create a ConditionEvaluator instance.
 * Ensures the template context has helpers included.
 */
export function createConditionEvaluator<TContext = unknown, TData = unknown>(
  templateContext: Omit<Partial<TemplateContext<TContext, TData>>, 'helpers'>
): ConditionEvaluator<TContext, TData> {
  const contextWithHelpers = createTemplateContext(templateContext);
  return new ConditionEvaluator(contextWithHelpers);
}

/**
 * Utility function to extract AI context strings from a condition without evaluation.
 * Useful for collecting context strings for prompt generation.
 */
export function extractAIContextStrings<TContext = unknown, TData = unknown>(
  condition: ConditionTemplate<TContext, TData>
): string[] {
  return splitConditionTemplate(condition).positive;
}

/**
 * Utility function to check if a condition has any programmatic components.
 */
export function hasProgrammaticConditions<TContext = unknown, TData = unknown>(
  condition: ConditionTemplate<TContext, TData>
): boolean {
  if (!condition) {
    return false;
  }

  if (Array.isArray(condition)) {
    return condition.some(subCondition => hasProgrammaticConditions(subCondition));
  }

  return typeof condition === 'function';
}
