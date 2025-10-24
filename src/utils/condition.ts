import type { TemplateContext, ConditionTemplate, ConditionEvaluationResult } from "../types/template";
import { createTemplateContext } from "./template";
import { logger } from './logger'

/**
 * Utility class for evaluating ConditionTemplate instances.
 * Handles mixed string/function conditions and separates programmatic
 * evaluation from AI context collection.
 */
export class ConditionEvaluator<TContext = unknown, TData = unknown> {
  constructor(private templateContext: TemplateContext<TContext, TData>) {}

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
      result.aiContextStrings.push(condition);
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
  const contextStrings: string[] = [];

  if (!condition) {
    return contextStrings;
  }

  if (Array.isArray(condition)) {
    for (const subCondition of condition) {
      contextStrings.push(...extractAIContextStrings(subCondition));
    }
  } else if (typeof condition === 'string') {
    contextStrings.push(condition);
  }
  // Functions don't contribute to AI context

  return contextStrings;
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