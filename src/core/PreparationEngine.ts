/**
 * PreparationEngine - Handles the preparation iteration loop
 *
 * This engine implements the core Parlant/Emcie architecture:
 * 1. Before generating a message, run preparation iterations
 * 2. Each iteration:
 *    - Match guidelines against current context
 *    - Walk the state machine and execute tool transitions
 *    - Execute tools when conditions are met
 *    - Update context from tool results
 *    - Check if prepared to respond
 * 3. After preparation, the AI generates the final message
 *
 * The AI NEVER sees tools - tools execute automatically based on:
 * - State machine transitions ({ toolState: tool })
 * - Guideline matching with associated tools
 */

import type { Event, StateRef, AiProvider } from "../types/index";
import type { Guideline, GuidelineMatch } from "../types/agent";
import type { ToolRef } from "../types/tool";
import type { Route } from "./Route";
import { State } from "./State";
import { ConditionEvaluator } from "./ConditionEvaluator";

/**
 * Tool execution result
 */
export interface ToolExecutionResult {
  toolName: string;
  arguments: Record<string, unknown>;
  result: unknown;
  success: boolean;
  error?: string;
}

/**
 * Preparation iteration state
 */
export interface IterationState {
  iterationNumber: number;
  matchedGuidelines: GuidelineMatch[];
  executedTools: ToolExecutionResult[];
  contextUpdates: Record<string, unknown>;
  preparedToRespond: boolean;
}

/**
 * Preparation context
 */
export interface PreparationContext<TContext = unknown> {
  history: Event[];
  currentState?: StateRef;
  context: TContext;
  routes: Route<TContext>[];
  guidelines: Guideline[];
  maxIterations: number;
}

/**
 * Preparation result
 */
export interface PreparationResult<TContext = unknown> {
  iterations: IterationState[];
  finalContext: TContext;
  toolExecutions: ToolExecutionResult[];
  preparedToRespond: boolean;
}

/**
 * PreparationEngine - Executes the preparation iteration loop
 */
export class PreparationEngine<TContext = unknown> {
  private readonly conditionEvaluator?: ConditionEvaluator<TContext>;

  constructor(ai?: AiProvider) {
    if (ai) {
      this.conditionEvaluator = new ConditionEvaluator<TContext>(ai);
    }
  }

  /**
   * Run preparation iterations before message generation
   *
   * This is the core engine that executes tools automatically
   * based on state machine transitions and guideline matching.
   */
  async prepare(
    preparationContext: PreparationContext<TContext>
  ): Promise<PreparationResult<TContext>> {
    const iterations: IterationState[] = [];
    let currentContext = { ...preparationContext.context };
    const allToolExecutions: ToolExecutionResult[] = [];
    let preparedToRespond = false;

    // Run preparation iterations
    for (
      let i = 0;
      i < preparationContext.maxIterations && !preparedToRespond;
      i++
    ) {
      const iteration = await this.runIteration({
        iterationNumber: i + 1,
        history: preparationContext.history,
        currentState: preparationContext.currentState,
        context: currentContext,
        routes: preparationContext.routes,
        guidelines: preparationContext.guidelines,
      });

      iterations.push(iteration);
      allToolExecutions.push(...iteration.executedTools);

      // Update context from tool results
      if (Object.keys(iteration.contextUpdates).length > 0) {
        currentContext = {
          ...currentContext,
          ...iteration.contextUpdates,
        } as TContext;
      }

      // Check if we're prepared to respond
      // We're prepared if:
      // 1. No tools were executed in this iteration (nothing left to do)
      // 2. OR we've reached max iterations
      // 3. OR iteration explicitly set preparedToRespond to true
      if (
        iteration.executedTools.length === 0 ||
        i === preparationContext.maxIterations - 1 ||
        iteration.preparedToRespond
      ) {
        preparedToRespond = true;
      }
    }

    return {
      iterations,
      finalContext: currentContext,
      toolExecutions: allToolExecutions,
      preparedToRespond,
    };
  }

  /**
   * Run a single preparation iteration
   */
  private async runIteration(params: {
    iterationNumber: number;
    history: Event[];
    currentState?: StateRef;
    context: TContext;
    routes: Route<TContext>[];
    guidelines: Guideline[];
  }): Promise<IterationState> {
    const executedTools: ToolExecutionResult[] = [];
    const contextUpdates: Record<string, unknown> = {};
    const matchedGuidelines: GuidelineMatch[] = [];

    // Step 1: Match guidelines against current context
    const matchedResults = await this.matchGuidelines(
      params.guidelines,
      params.context,
      params.history
    );
    matchedGuidelines.push(...matchedResults);

    // Step 2: Execute tools from matched guidelines
    // Guidelines with associated tools should execute those tools
    for (const match of matchedGuidelines) {
      if (match.guideline.tools && match.guideline.tools.length > 0) {
        for (const tool of match.guideline.tools) {
          const toolResult = await this.executeTool(
            tool as ToolRef<TContext, unknown[], unknown>,
            params.context,
            params.history
          );
          if (toolResult) {
            executedTools.push(toolResult);

            // Update context from tool result if tool provided context updates
            if (toolResult.result && typeof toolResult.result === "object") {
              const result = toolResult.result as Record<string, unknown>;
              if (result.contextUpdate) {
                Object.assign(contextUpdates, result.contextUpdate);
              }
            }
          }
        }
      }
    }

    // Step 3: Walk state machine and execute tool transitions
    // Find current route and state, then execute any toolState transitions
    if (params.currentState?.id) {
      const currentRoute = params.routes.find(
        (r) => r.id === params.currentState!.routeId
      );

      if (currentRoute) {
        const toolResults = await this.executeStateToolTransitions(
          currentRoute,
          params.currentState,
          params.context,
          params.history
        );
        executedTools.push(...toolResults);

        // Update context from state tool results
        for (const toolResult of toolResults) {
          if (toolResult.result && typeof toolResult.result === "object") {
            const result = toolResult.result as Record<string, unknown>;
            if (result.contextUpdate) {
              Object.assign(contextUpdates, result.contextUpdate);
            }
          }
        }
      }
    }

    return {
      iterationNumber: params.iterationNumber,
      matchedGuidelines,
      executedTools,
      contextUpdates,
      preparedToRespond: false, // Will be determined by caller
    };
  }

  /**
   * Match guidelines against current context
   *
   * Evaluates guideline conditions against the current context and history
   * using AI to determine relevance and priority
   */
  private async matchGuidelines(
    guidelines: Guideline[],
    context: TContext,
    history: Event[]
  ): Promise<GuidelineMatch[]> {
    const matches: GuidelineMatch[] = [];

    for (const guideline of guidelines) {
      // Skip disabled guidelines
      if (guideline.enabled === false) {
        continue;
      }

      // If guideline has no condition, it's always matched
      if (!guideline.condition) {
        matches.push({
          guideline,
          rationale: "Guideline has no condition - always active",
        });
        continue;
      }

      // Evaluate condition using AI if evaluator is available
      if (!this.conditionEvaluator) {
        // No AI available, match all enabled guidelines with conditions
        matches.push({
          guideline,
          rationale: "AI not available - defaulting to match",
        });
        continue;
      }

      const evaluation =
        await this.conditionEvaluator.evaluateGuidelineCondition(
          guideline,
          context,
          history
        );

      if (evaluation.matches) {
        matches.push({
          guideline,
          rationale: evaluation.rationale || "Condition evaluated as true",
        });
      }
    }

    return matches;
  }

  /**
   * Execute a single tool
   */
  private async executeTool(
    tool: ToolRef<TContext, unknown[], unknown>,
    context: TContext,
    history: Event[]
  ): Promise<ToolExecutionResult | null> {
    try {
      // Extract arguments from context and history
      let args: unknown[];

      if (this.conditionEvaluator && tool.parameters) {
        // Use AI-powered extraction if available
        const extraction = await this.conditionEvaluator.extractToolArguments(
          tool,
          context,
          history
        );
        args = extraction.arguments;
      } else {
        // Fallback to simple extraction
        args = this.conditionEvaluator
          ? this.conditionEvaluator.simpleArgumentExtraction(tool, context)
          : [];
      }

      // Execute the tool handler
      const result = await tool.handler(
        {
          context,
          history,
          updateContext: async (_updates: Partial<TContext>) => {
            // Context updates are handled separately in the preparation loop
            // This is a no-op placeholder
          },
        },
        ...args
      );

      return {
        toolName: tool.name,
        arguments: { args }, // Wrap array in object for logging
        result,
        success: true,
      };
    } catch (error) {
      console.error(
        `[PreparationEngine] Tool execution failed: ${tool.name}`,
        error
      );
      return {
        toolName: tool.name,
        arguments: {},
        result: null,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Execute tool transitions in the state machine
   *
   * Walks through state transitions and executes tools when
   * reaching a { toolState: tool } transition
   */
  private async executeStateToolTransitions(
    route: Route<TContext>,
    currentStateRef: StateRef,
    context: TContext,
    history: Event[]
  ): Promise<ToolExecutionResult[]> {
    const executedTools: ToolExecutionResult[] = [];

    // Get the current state from the route or use initial state
    let stateToWalk: State<TContext>;

    try {
      const foundState = route.getState(currentStateRef.id);
      if (foundState) {
        stateToWalk = foundState;
      } else {
        stateToWalk = route.initialState;
      }
    } catch {
      // If any error occurs, fallback to initial state
      stateToWalk = route.initialState;
    }

    // Walk the state machine starting from the determined state
    const toolResults = await this.walkStateChain(
      stateToWalk,
      context,
      history,
      new Set() // Track visited states to prevent loops
    );

    executedTools.push(...toolResults);

    return executedTools;
  }

  /**
   * Walk through a chain of states, executing tools along the way
   */
  private async walkStateChain(
    state: State<TContext>,
    context: TContext,
    history: Event[],
    visited: Set<string>
  ): Promise<ToolExecutionResult[]> {
    const executedTools: ToolExecutionResult[] = [];

    // Prevent infinite loops
    if (visited.has(state.id)) {
      return executedTools;
    }
    visited.add(state.id);

    // Get all transitions from this state
    const transitions = state.getTransitions();

    // Process each transition
    for (const transition of transitions) {
      // Check if transition has a condition
      if (transition.hasCondition()) {
        // Evaluate condition
        const shouldFollow = await this.evaluateTransitionCondition(
          transition,
          context,
          history
        );

        if (!shouldFollow) {
          continue; // Skip this transition
        }
      }

      // Check if this is a toolState transition
      if (transition.spec.toolState) {
        // Execute the tool
        const toolResult = await this.executeTool(
          transition.spec.toolState,
          context,
          history
        );

        if (toolResult) {
          executedTools.push(toolResult);

          // Update context with tool results for next transitions
          if (toolResult.result && typeof toolResult.result === "object") {
            const result = toolResult.result as Record<string, unknown>;
            if (result.contextUpdate) {
              context = {
                ...context,
                ...(result.contextUpdate as Partial<TContext>),
              };
            }
          }
        }
      }

      // Get the target state and recursively walk it
      const targetState = transition.getTarget();
      if (targetState && !visited.has(targetState.id)) {
        const childResults = await this.walkStateChain(
          targetState,
          context,
          history,
          visited
        );
        executedTools.push(...childResults);
      }
    }

    return executedTools;
  }

  /**
   * Evaluate a transition condition
   */
  private async evaluateTransitionCondition(
    transition: { condition?: string },
    context: TContext,
    history: Event[]
  ): Promise<boolean> {
    if (!transition.condition) {
      return true; // No condition = always follow
    }

    // If no AI evaluator available, default to true
    if (!this.conditionEvaluator) {
      return true;
    }

    try {
      const evaluation =
        await this.conditionEvaluator.evaluateTransitionCondition(
          transition.condition,
          context,
          history
        );

      return evaluation.shouldFollow;
    } catch (error) {
      console.error(
        `[PreparationEngine] Failed to evaluate transition condition`,
        error
      );
      // On error, default to false (don't follow)
      return false;
    }
  }
}
