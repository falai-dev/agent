/**
 * ConditionEvaluator - Handles AI-powered condition evaluation
 *
 * This class is responsible for:
 * - Evaluating guideline conditions
 * - Evaluating transition conditions
 * - Extracting tool arguments from context and history
 */

import type { Event, AiProvider, MessageEventData } from "../types/index";
import { EventKind } from "../types/history";
import type { Guideline } from "../types/agent";
import type { ToolRef } from "../types/tool";

/**
 * Result of guideline condition evaluation
 */
export interface GuidelineEvaluationResult {
  matches: boolean;
  rationale?: string;
}

/**
 * Result of transition condition evaluation
 */
export interface TransitionEvaluationResult {
  shouldFollow: boolean;
  rationale?: string;
}

/**
 * Result of tool argument extraction
 */
export interface ArgumentExtractionResult {
  arguments: unknown[];
  rationale?: string;
}

/**
 * Schema for guideline evaluation response
 */
interface GuidelineEvaluationSchema {
  matches: boolean;
  rationale: string;
}

/**
 * Schema for transition evaluation response
 */
interface TransitionEvaluationSchema {
  shouldFollow: boolean;
  rationale: string;
}

/**
 * Schema for argument extraction response
 */
interface ArgumentExtractionSchema {
  arguments: unknown[];
  rationale?: string;
}

/**
 * ConditionEvaluator - Evaluates conditions using AI
 */
export class ConditionEvaluator<TContext = unknown> {
  constructor(private readonly ai: AiProvider) {}

  /**
   * Evaluate a guideline condition against context and history
   */
  async evaluateGuidelineCondition(
    guideline: Guideline,
    context: TContext,
    history: Event[]
  ): Promise<GuidelineEvaluationResult> {
    try {
      const recentMessages = this.extractRecentMessages(history);

      const prompt = `You are evaluating whether a guideline condition is met.

Guideline Condition: ${guideline.condition}
Action: ${guideline.action}

Current Context:
${JSON.stringify(context, null, 2)}

Recent Conversation:
${recentMessages || "(No recent messages)"}

Evaluate whether the guideline condition is currently met based on the context and conversation.

Your response must be a JSON object with this exact structure:
{
  "matches": boolean (true or false),
  "rationale": string (brief explanation)
}`;

      const result = await this.ai.generateMessage<
        TContext,
        GuidelineEvaluationSchema
      >({
        prompt,
        history,
        context,
        parameters: {
          jsonMode: true,
          maxOutputTokens: 500,
        },
      });

      // Parse structured response
      if (result.structured) {
        return {
          matches: result.structured.matches === true,
          rationale: result.structured.rationale,
        };
      }

      // Fallback parsing
      return this.parseGuidelineResponse(result.message);
    } catch (error) {
      console.error(
        `[ConditionEvaluator] Failed to evaluate guideline condition: ${guideline.id}`,
        error
      );
      return {
        matches: false,
        rationale: "Failed to evaluate condition",
      };
    }
  }

  /**
   * Evaluate a transition condition
   */
  async evaluateTransitionCondition(
    condition: string,
    context: TContext,
    history: Event[]
  ): Promise<TransitionEvaluationResult> {
    try {
      const recentMessages = this.extractRecentMessages(history);

      const prompt = `You are evaluating whether a state transition condition is met.

Transition Condition: ${condition}

Current Context:
${JSON.stringify(context, null, 2)}

Recent Conversation:
${recentMessages || "(No recent messages)"}

Evaluate whether this transition should be followed based on the condition, context, and conversation.

Your response must be a JSON object with this exact structure:
{
  "shouldFollow": boolean (true or false),
  "rationale": string (brief explanation)
}`;

      const result = await this.ai.generateMessage<
        TContext,
        TransitionEvaluationSchema
      >({
        prompt,
        history,
        context,
        parameters: {
          jsonMode: true,
          maxOutputTokens: 300,
        },
      });

      // Parse structured response
      if (result.structured) {
        return {
          shouldFollow: result.structured.shouldFollow === true,
          rationale: result.structured.rationale,
        };
      }

      // Fallback parsing
      return this.parseTransitionResponse(result.message);
    } catch (error) {
      console.error(
        `[ConditionEvaluator] Failed to evaluate transition condition`,
        error
      );
      return {
        shouldFollow: false,
        rationale: "Failed to evaluate condition",
      };
    }
  }

  /**
   * Extract tool arguments from context and history
   */
  async extractToolArguments(
    tool: ToolRef<TContext, unknown[], unknown>,
    context: TContext,
    history: Event[]
  ): Promise<ArgumentExtractionResult> {
    try {
      const recentMessages = this.extractRecentMessages(history);

      const prompt = `You are extracting arguments for a tool call.

Tool: ${tool.name}
Description: ${tool.description || "No description"}
Parameters: ${JSON.stringify(tool.parameters, null, 2)}

Current Context:
${JSON.stringify(context, null, 2)}

Recent Conversation:
${recentMessages || "(No recent messages)"}

Extract the arguments needed to call this tool based on the context and conversation.
If a parameter is not available, use null or a reasonable default value.

Your response must be a JSON object with this exact structure:
{
  "arguments": [arg1, arg2, ...] (array of argument values),
  "rationale": string (optional explanation)
}`;

      const result = await this.ai.generateMessage<
        TContext,
        ArgumentExtractionSchema
      >({
        prompt,
        history,
        context,
        parameters: {
          jsonMode: true,
          maxOutputTokens: 500,
        },
      });

      // Parse structured response
      if (result.structured) {
        if (
          result.structured.arguments &&
          Array.isArray(result.structured.arguments)
        ) {
          return {
            arguments: result.structured.arguments,
            rationale: result.structured.rationale,
          };
        }
      }

      // Fallback: try to parse from message
      return this.parseArgumentResponse(result.message);
    } catch (error) {
      console.error(
        `[ConditionEvaluator] Failed to extract tool arguments: ${tool.name}`,
        error
      );
      return {
        arguments: [],
        rationale: "Failed to extract arguments",
      };
    }
  }

  /**
   * Simple argument extraction from context (fallback)
   */
  simpleArgumentExtraction(
    tool: ToolRef<TContext, unknown[], unknown>,
    context: TContext
  ): unknown[] {
    const contextObj = context as Record<string, unknown>;
    const args: unknown[] = [];

    // If parameters is an object with properties, try to match context keys
    if (
      tool.parameters &&
      typeof tool.parameters === "object" &&
      !Array.isArray(tool.parameters)
    ) {
      const params = tool.parameters as Record<string, unknown>;

      // Try to match parameter names with context keys
      for (const [paramName, paramDef] of Object.entries(params)) {
        if (contextObj[paramName] !== undefined) {
          args.push(contextObj[paramName]);
        } else if (
          typeof paramDef === "object" &&
          paramDef !== null &&
          "default" in paramDef &&
          typeof (paramDef as { default?: unknown }).default !== "undefined"
        ) {
          args.push((paramDef as { default: unknown }).default);
        }
      }
    }

    return args;
  }

  // Private helper methods

  /**
   * Extract recent messages from history
   */
  private extractRecentMessages(history: Event[], count = 5): string {
    return history
      .slice(-count)
      .map((event) => {
        if (event.kind === EventKind.MESSAGE) {
          const data = event.data as MessageEventData;
          return `${data.participant.display_name}: ${data.message}`;
        }
        return null;
      })
      .filter((msg): msg is string => msg !== null)
      .join("\n");
  }

  /**
   * Parse guideline evaluation from text response (fallback)
   */
  private parseGuidelineResponse(message: string): GuidelineEvaluationResult {
    const lowerMessage = message.toLowerCase();
    const matches =
      lowerMessage.includes("true") || lowerMessage.includes('"matches": true');

    return {
      matches,
      rationale: matches ? "Parsed from text response" : "Condition not met",
    };
  }

  /**
   * Parse transition evaluation from text response (fallback)
   */
  private parseTransitionResponse(message: string): TransitionEvaluationResult {
    const lowerMessage = message.toLowerCase();
    const shouldFollow =
      lowerMessage.includes("true") ||
      lowerMessage.includes('"shouldfollow": true');

    return {
      shouldFollow,
      rationale: shouldFollow
        ? "Parsed from text response"
        : "Condition not met",
    };
  }

  /**
   * Parse argument extraction from text response (fallback)
   */
  private parseArgumentResponse(message: string): ArgumentExtractionResult {
    try {
      // Try to extract JSON from the message
      const jsonMatch = message.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as ArgumentExtractionSchema;
        if (parsed.arguments && Array.isArray(parsed.arguments)) {
          return {
            arguments: parsed.arguments,
            rationale: parsed.rationale,
          };
        }
      }
    } catch {
      // Ignore parse errors
    }

    return {
      arguments: [],
      rationale: "Failed to parse arguments from response",
    };
  }
}
