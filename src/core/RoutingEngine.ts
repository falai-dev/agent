import type {
  Event,
  AgentOptions,
  StructuredSchema,
  RoutingDecision,
  SessionState,
  AiProvider,
} from "../types";
import { enterRoute, mergeCollected } from "../utils";
import type { Route } from "./Route";
import type { Step } from "./Step";
import { PromptComposer } from "./PromptComposer";
import { getLastMessageFromHistory } from "../utils/event";
import { logger } from "../utils/logger";
import { render } from "@utils/template";
import { END_ROUTE_ID } from "../constants";

export interface CandidateStep<TContext = unknown, TData = unknown> {
  step: Step<TContext, TData>;
  isRouteComplete?: boolean;
}

export interface RoutingDecisionOutput {
  context: string;
  routes: Record<string, number>;
  selectedStepId?: string; // For active route, which step to transition to
  stepReasoning?: string; // Why this step was selected
  responseDirectives?: string[];
  extractions?: Array<{
    name: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    value: any;
    confidence?: number;
    source?: "message" | "history";
  }>;
  contextUpdate?: Record<string, unknown>;
}

export interface RoutingEngineOptions {
  allowRouteSwitch?: boolean;
  switchThreshold?: number; // 0-100
  maxCandidates?: number;
}

export interface BuildStepSelectionPromptParams<
  TContext = unknown,
  TData = unknown
> {
  route: Route<TContext, TData>;
  currentStep: Step<TContext, TData> | undefined;
  candidates: CandidateStep<TContext, TData>[];
  data: Partial<TData>;
  history: Event[];
  lastMessage: string;
  agentOptions?: AgentOptions<TContext>;
  context?: TContext;
  session?: SessionState<TData>;
}

export interface BuildRoutingPromptParams<TContext = unknown, TData = unknown> {
  history: Event[];
  routes: Route<TContext, TData>[];
  lastMessage: string;
  agentOptions?: AgentOptions<TContext>;
  session?: SessionState<TData>;
  activeRouteSteps?: Step<TContext, TData>[];
  context?: TContext;
}

export class RoutingEngine<TContext = unknown, TData = unknown> {
  constructor(private readonly options?: RoutingEngineOptions) {}

  /**
   * Optimized decision for single-route scenarios
   * Skips route scoring and only does step selection
   * @private
   */
  private async decideSingleRouteStep(params: {
    route: Route<TContext, TData>;
    session: SessionState<TData>;
    history: Event[];
    agentOptions?: AgentOptions<TContext>;
    provider: AiProvider;
    context: TContext;
    signal?: AbortSignal;
  }): Promise<{
    selectedRoute?: Route<TContext>;
    selectedStep?: Step<TContext>;
    responseDirectives?: string[];
    session: SessionState<TData>;
    isRouteComplete?: boolean;
  }> {
    const { route, session, history, agentOptions, provider, context, signal } =
      params;

    let updatedSession = session;
    const selectedRoute = route;

    // Enter route if not already in it
    if (!session.currentRoute || session.currentRoute.id !== route.id) {
      updatedSession = enterRoute(session, route.id, route.title);
      if (route.initialData) {
        updatedSession = mergeCollected(updatedSession, route.initialData);
        logger.debug(
          `[RoutingEngine] Single-route: Merged initial data:`,
          route.initialData
        );
      }
      logger.debug(
        `[RoutingEngine] Single-route: Entered route: ${route.title}`
      );
    }

    // Get candidate steps
    const currentStep = updatedSession.currentStep
      ? route.getStep(updatedSession.currentStep.id)
      : undefined;
    const candidates = this.getCandidateSteps(
      route,
      currentStep,
      updatedSession.data || {}
    );

    if (candidates.length === 0) {
      logger.warn(`[RoutingEngine] Single-route: No valid steps found`);
      return { selectedRoute, session: updatedSession };
    }

    // If only one candidate, check if route is complete
    if (candidates.length === 1) {
      const isRouteComplete = candidates[0].isRouteComplete;
      if (isRouteComplete) {
        logger.debug(
          `[RoutingEngine] Single-route: Route complete - all data collected, END_ROUTE reached`
        );
        // Don't return a selectedStep when route is complete - there's no step to enter
        return {
          selectedRoute,
          selectedStep: undefined,
          session: updatedSession,
          isRouteComplete: true,
        };
      } else {
        logger.debug(
          `[RoutingEngine] Single-route: Only one valid step: ${candidates[0].step.id}`
        );
        return {
          selectedRoute,
          selectedStep: candidates[0].step,
          session: updatedSession,
          isRouteComplete: false,
        };
      }
    }

    // Multiple candidates - use AI to select best step
    const lastUserMessage = getLastMessageFromHistory(history);
    const stepPrompt = await this.buildStepSelectionPrompt({
      route,
      currentStep,
      candidates,
      data: updatedSession.data || {},
      history,
      lastMessage: lastUserMessage,
      agentOptions,
      context,
      session: updatedSession,
    });

    const stepSchema = this.buildStepSelectionSchema(
      candidates.map((c) => c.step)
    );

    const stepResult = await provider.generateMessage<
      TContext,
      {
        reasoning: string;
        selectedStepId: string;
        responseDirectives?: string[];
      }
    >({
      prompt: stepPrompt,
      history,
      context,
      signal,
      parameters: {
        jsonSchema: stepSchema,
        schemaName: "step_selection",
      },
    });

    const selectedStepId = stepResult.structured?.selectedStepId;
    const selectedStep = candidates.find((c) => c.step.id === selectedStepId);

    if (selectedStep) {
      logger.debug(
        `[RoutingEngine] Single-route: AI selected step: ${selectedStep.step.id}`
      );
      logger.debug(
        `[RoutingEngine] Single-route: Reasoning: ${stepResult.structured?.reasoning}`
      );
    } else {
      logger.warn(
        `[RoutingEngine] Single-route: Invalid step ID returned, using first candidate`
      );
    }

    return {
      selectedRoute,
      selectedStep: selectedStep?.step || candidates[0].step,
      responseDirectives: stepResult.structured?.responseDirectives,
      session: updatedSession,
    };
  }

  /**
   * Recursively traverse step chain to find first non-skipped step or END_ROUTE
   * @private
   */
  private findFirstValidStepRecursive<TData = unknown>(
    currentStep: Step<TContext, TData>,
    data: Partial<TData>,
    visited: Set<string>
  ): {
    step?: Step<TContext, TData>;
    isRouteComplete?: boolean;
  } {
    // Prevent infinite loops
    if (visited.has(currentStep.id)) {
      return {};
    }
    visited.add(currentStep.id);

    const transitions = currentStep.getTransitions();

    for (const transition of transitions) {
      const target = transition;

      // Check for END_ROUTE transition
      if (target && target.id === END_ROUTE_ID) {
        // Found END_ROUTE - route is complete
        return {
          isRouteComplete: true,
        };
      }

      if (!target) continue;

      // If target should NOT be skipped, we found our step
      if (!target.shouldSkip(data)) {
        logger.debug(
          `[RoutingEngine] Found valid step after skipping: ${target.id}`
        );
        return {
          step: target,
          isRouteComplete: false,
        };
      }

      // Target should be skipped too - recurse deeper
      logger.debug(
        `[RoutingEngine] Skipping step ${target.id} (skipIf condition met), continuing traversal...`
      );
      const result = this.findFirstValidStepRecursive(target, data, visited);

      // If we found something (a valid step or END_ROUTE), return it
      if (result.step || result.isRouteComplete) {
        return result;
      }
    }

    // No valid steps or END_ROUTE found in this branch
    return {};
  }

  /**
   * Identify valid next candidate steps based on current step and collected data
   * Returns step with isRouteComplete flag if route is complete (all steps skipped + has END_ROUTE transition)
   */
  getCandidateSteps<TData = unknown>(
    route: Route<TContext, TData>,
    currentStep: Step<TContext, TData> | undefined,
    data: Partial<TData>
  ): CandidateStep<TContext, TData>[] {
    const candidates: CandidateStep<TContext, TData>[] = [];

    if (!currentStep) {
      const initialStep = route.initialStep;
      if (initialStep.shouldSkip(data)) {
        // Initial step should be skipped - recursively traverse to find first non-skipped step or END_ROUTE
        const result = this.findFirstValidStepRecursive(
          initialStep,
          data,
          new Set<string>()
        );

        if (result.isRouteComplete) {
          // All steps are skipped and we reached END_ROUTE
          logger.debug(
            `[RoutingEngine] Route complete on entry: all steps skipped, END_ROUTE reached`
          );
          candidates.push({
            step: initialStep,
            isRouteComplete: true,
          });
        } else if (result.step) {
          // Found a non-skipped step
          candidates.push({
            step: result.step,
            isRouteComplete: result.isRouteComplete || false,
          });
        }
        // If no step found and not complete, fall through to return empty candidates
      } else {
        candidates.push({
          step: initialStep,
          isRouteComplete: false,
        });
      }
      return candidates;
    }

    const transitions = currentStep.getTransitions();
    let hasEndRoute = false;

    for (const transition of transitions) {
      const target = transition;

      // Check for END_ROUTE transition (no target step)
      if (target && target.id === END_ROUTE_ID) {
        hasEndRoute = true;
        continue;
      }

      if (!target) continue;

      if (target.shouldSkip(data)) {
        logger.debug(
          `[RoutingEngine] Skipping step ${target.id} (skipIf condition met)`
        );

        // Recursively traverse to find next valid step or END_ROUTE
        const result = this.findFirstValidStepRecursive(
          target,
          data,
          new Set<string>([currentStep.id]) // Already visited current step
        );

        if (result.isRouteComplete) {
          hasEndRoute = true;
        } else if (result.step) {
          // Found a non-skipped step deeper in the chain
          candidates.push({
            step: result.step,
            isRouteComplete: result.isRouteComplete || false,
          });
        }
        continue;
      }

      candidates.push({
        step: target,
        isRouteComplete: hasEndRoute || false,
      });
    }

    // If no valid candidates found
    if (candidates.length === 0) {
      // If current step has END_ROUTE transition, the route is complete
      if (hasEndRoute) {
        logger.debug(
          `[RoutingEngine] Route complete: all steps processed, END_ROUTE reached`
        );
        // Return current step with completion flag
        return [
          {
            step: currentStep,
            isRouteComplete: true,
          },
        ];
      }

      // Otherwise, stay in current step if it's still valid
      if (!currentStep.shouldSkip(data)) {
        candidates.push({
          step: currentStep,
          isRouteComplete: hasEndRoute || false,
        });
      }
    }

    return candidates;
  }

  /**
   * Full routing orchestration: builds prompt and schema, calls AI, selects route/step,
   * and updates the session (including initialData merge when entering a new route).
   *
   * OPTIMIZATION: If there's only 1 route, skips route scoring and only does step selection.
   */
  async decideRouteAndStep(params: {
    routes: Route<TContext, TData>[];
    session: SessionState<TData>;
    history: Event[];
    agentOptions?: AgentOptions<TContext>;
    provider: AiProvider;
    context: TContext;
    signal?: AbortSignal;
  }): Promise<{
    selectedRoute?: Route<TContext>;
    selectedStep?: Step<TContext>;
    responseDirectives?: string[];
    session: SessionState<TData>;
    isRouteComplete?: boolean;
  }> {
    const {
      routes,
      session,
      history,
      agentOptions,
      provider,
      context,
      signal,
    } = params;

    if (routes.length === 0) {
      return { session };
    }

    // OPTIMIZATION: Single route - skip route scoring, only do step selection
    if (routes.length === 1) {
      return this.decideSingleRouteStep({
        route: routes[0],
        session,
        history,
        agentOptions,
        provider,
        context,
        signal,
      });
    }

    const lastUserMessage = getLastMessageFromHistory(history);

    let activeRouteSteps: Step<TContext, TData>[] | undefined;
    let activeRoute: Route<TContext, TData> | undefined;
    let isRouteComplete = false;

    if (session.currentRoute) {
      activeRoute = routes.find((r) => r.id === session.currentRoute?.id);
      if (activeRoute) {
        const currentStep = session.currentStep
          ? activeRoute.getStep(session.currentStep.id)
          : undefined;
        const candidates = this.getCandidateSteps(
          activeRoute,
          currentStep,
          session.data || {}
        );

        // Check if route is complete
        if (candidates.length === 1 && candidates[0].isRouteComplete) {
          isRouteComplete = true;
          logger.debug(
            `[RoutingEngine] Route ${activeRoute.title} is complete - all data collected`
          );
          // Don't include steps in routing if route is complete
          activeRouteSteps = undefined;
        } else {
          activeRouteSteps = candidates.map((c) => c.step);
          logger.debug(
            `[RoutingEngine] Found ${activeRouteSteps.length} candidate steps for active route`
          );
        }
      }
    }

    const routingSchema = this.buildDynamicRoutingSchema(
      routes,
      undefined,
      activeRouteSteps
    );

    const routingPrompt = await this.buildRoutingPrompt({
      history,
      routes,
      lastMessage: lastUserMessage,
      agentOptions,
      session,
      activeRouteSteps,
      context,
    });

    const routingResult = await provider.generateMessage<
      TContext,
      RoutingDecisionOutput
    >({
      prompt: routingPrompt,
      history,
      context,
      signal,
      parameters: {
        jsonSchema: routingSchema,
        schemaName: "routing_output",
      },
    });

    let selectedRoute: Route<TContext> | undefined;
    let selectedStep: Step<TContext> | undefined;
    let responseDirectives: string[] | undefined;
    let updatedSession = session;

    if (routingResult.structured?.routes) {
      const decision = this.decideRouteFromScores({
        context: routingResult.structured.context,
        routes: routingResult.structured.routes,
        responseDirectives: routingResult.structured.responseDirectives,
      });
      selectedRoute = routes.find((r) => r.id === decision.routeId);
      responseDirectives = routingResult.structured.responseDirectives;

      if (
        selectedRoute === activeRoute &&
        routingResult.structured.selectedStepId &&
        activeRoute
      ) {
        selectedStep = activeRoute.getStep(
          routingResult.structured.selectedStepId
        );
        if (selectedStep) {
          logger.debug(
            `[RoutingEngine] AI selected step: ${selectedStep.id} in active route`
          );
          logger.debug(
            `[RoutingEngine] Step reasoning: ${routingResult.structured.stepReasoning}`
          );
        }
      }

      if (selectedRoute) {
        logger.debug(`[RoutingEngine] Selected route: ${selectedRoute.title}`);
        if (
          !session.currentRoute ||
          session.currentRoute.id !== selectedRoute.id
        ) {
          updatedSession = enterRoute(
            session,
            selectedRoute.id,
            selectedRoute.title
          );
          if (selectedRoute.initialData) {
            updatedSession = mergeCollected(
              updatedSession,
              selectedRoute.initialData
            );
            logger.debug(
              `[RoutingEngine] Merged initial data:`,
              selectedRoute.initialData
            );
          }
          logger.debug(`[RoutingEngine] Entered route: ${selectedRoute.title}`);
        }
      }
    }

    return {
      selectedRoute,
      selectedStep,
      responseDirectives,
      session: updatedSession,
      isRouteComplete,
    };
  }

  /**
   * Build prompt for step selection within a single route
   * @private
   */
  private async buildStepSelectionPrompt<TData>(
    params: BuildStepSelectionPromptParams<TContext, TData>
  ): Promise<string> {
    const {
      route,
      currentStep,
      candidates,
      data,
      history,
      lastMessage,
      agentOptions,
      context,
      session,
    } = params;
    const templateContext = { context, session, history };
    const pc = new PromptComposer(templateContext);

    // Add agent metadata
    if (agentOptions) {
      await pc.addAgentMeta(agentOptions);
    }

    // Add route context
    await pc.addInstruction(
      `Active Route: ${route.title}\nDescription: ${route.description || "N/A"}`
    );

    // Add current step context
    if (currentStep) {
      await pc.addInstruction(
        `Current Step: ${currentStep.id}\nDescription: ${
          currentStep.description || "N/A"
        }`
      );
    } else {
      await pc.addInstruction("Current Step: None (entering route)");
    }

    // Add collected data context
    if (Object.keys(data).length > 0) {
      await pc.addInstruction(
        `Collected Data So Far:\n${JSON.stringify(data, null, 2)}`
      );
    } else {
      await pc.addInstruction("Collected Data: None yet");
    }

    // Add conversation history
    await pc.addInteractionHistory(history);
    await pc.addLastMessage(lastMessage);

    // Add candidate steps
    const stepDescriptions = [];
    for (const candidate of candidates) {
      const idx = candidates.indexOf(candidate);
      const parts = [
        `${idx + 1}. Step ID: ${candidate.step.id}`,
        `   Description: ${candidate.step.description || "N/A"}`,
      ];

      if (candidate.step.when) {
        const renderedWhen = await render(candidate.step.when, templateContext);
        parts.push(`   When this step should be completed: ${renderedWhen}`);
      }

      if (candidate.step.requires && candidate.step.requires.length > 0) {
        parts.push(`   Required Data: ${candidate.step.requires.join(", ")}`);
      }

      if (candidate.step.collect && candidate.step.collect.length > 0) {
        parts.push(`   Collects: ${candidate.step.collect.join(", ")}`);
      }

      stepDescriptions.push(parts.join("\n"));
    }

    await pc.addInstruction(
      `Available Steps to Transition To:\n${stepDescriptions.join("\n\n")}`
    );

    // Add decision prompt
    await pc.addInstruction(
      [
        "Task: Decide which step to transition to based on:",
        "1. The user's current message and intent",
        "2. The conversation history and context",
        "3. The collected data we already have",
        "4. The conditions and requirements of each step",
        "5. The logical flow of the conversation",
        "",
        "Rules:",
        "- If a step has a condition, evaluate whether it's met based on context",
        "- If a step requires data we don't have, consider if we should collect it now",
        "- Choose the step that makes the most sense for moving the conversation forward",
        "- Steps with skipIf conditions that are met have already been filtered out",
        "",
        "Return ONLY JSON matching the provided schema.",
      ].join("\n")
    );

    return pc.build();
  }

  /**
   * Build schema for step selection
   * @private
   */
  private buildStepSelectionSchema(
    validSteps: Step<TContext, TData>[]
  ): StructuredSchema {
    return {
      description:
        "Step transition decision based on conversation context and collected data",
      type: "object",
      properties: {
        reasoning: {
          type: "string",
          nullable: false,
          description: "Brief explanation of why this step was selected",
        },
        selectedStepId: {
          type: "string",
          nullable: false,
          description: "The ID of the selected step to transition to",
          enum: validSteps.map((s) => s.id),
        },
        responseDirectives: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional bullet points the response should address (concise)",
        },
      },
      required: ["reasoning", "selectedStepId"],
      additionalProperties: false,
    };
  }

  buildDynamicRoutingSchema(
    routes: Route<TContext, TData>[],
    extrasSchema?: StructuredSchema,
    activeRouteSteps?: Step<TContext, TData>[]
  ): StructuredSchema {
    const routeIds = routes.map((r) => r.id);
    const routeProperties: Record<string, StructuredSchema> = {};
    for (const id of routeIds) {
      routeProperties[id] = {
        type: "number",
        nullable: false,
        description: `Score for route ${id} based on direct evidence, context and semantic fit (0-100)`,
        minimum: 0,
        maximum: 100,
      } as StructuredSchema;
    }

    const base: StructuredSchema = {
      description:
        "Full intent analysis: score ALL available routes (0-100) using evidence and context",
      type: "object",
      properties: {
        context: {
          type: "string",
          nullable: false,
          description: "Brief summary of the user's intent/context",
        },
        routes: {
          type: "object",
          properties: routeProperties,
          required: routeIds,
          nullable: false,
          description: "Mapping of routeId to score (0-100)",
        },
        responseDirectives: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional bullet points the response should address (concise)",
        },
      },
      required: ["context", "routes"],
      additionalProperties: false,
    };

    // Add step selection fields if there's an active route with steps
    if (activeRouteSteps && activeRouteSteps.length > 0) {
      base.properties = base.properties || {};
      base.properties.selectedStepId = {
        type: "string",
        nullable: false,
        description:
          "The step ID to transition to within the active route (required if continuing in current route)",
        enum: activeRouteSteps.map((s) => s.id),
      };
      base.properties.stepReasoning = {
        type: "string",
        nullable: false,
        description: "Brief explanation of why this step was selected",
      };
      base.required = [
        ...(base.required || []),
        "selectedStepId",
        "stepReasoning",
      ];
    }

    if (extrasSchema) {
      base.properties = base.properties || {};
      base.properties.extractions = extrasSchema;
    }

    return base;
  }

  async buildRoutingPrompt(
    params: BuildRoutingPromptParams<TContext, TData>
  ): Promise<string> {
    const {
      history,
      routes,
      lastMessage,
      agentOptions,
      session,
      activeRouteSteps,
      context,
    } = params;
    const templateContext = { context, session, history };
    const pc = new PromptComposer(templateContext);
    if (agentOptions) {
      await pc.addAgentMeta(agentOptions);
    }
    await pc.addInstruction(
      "Task: Intent analysis and route scoring (0-100). Score ALL listed routes."
    );

    // Add session context if available
    if (session?.currentRoute) {
      const sessionInfo = [
        "Current conversation context:",
        `- Active route: ${session.currentRoute.title} (${session.currentRoute.id})`,
      ];
      if (session.currentStep) {
        sessionInfo.push(`- Current step: ${session.currentStep.id}`);
        if (session.currentStep.description) {
          sessionInfo.push(`  "${session.currentStep.description}"`);
        }
      }
      if (session.data && Object.keys(session.data).length > 0) {
        sessionInfo.push(`- Collected data: ${JSON.stringify(session.data)}`);
      }
      sessionInfo.push(
        "Note: User is mid-conversation. They may want to continue current route or switch to a new one based on their intent."
      );
      await pc.addInstruction(sessionInfo.join("\n"));

      // Add available steps for the active route
      if (activeRouteSteps && activeRouteSteps.length > 0) {
        const stepInfo = [
          "",
          "Available steps in active route (choose one to transition to):",
        ];
        for (const step of activeRouteSteps) {
          const idx = activeRouteSteps.indexOf(step);
          stepInfo.push(`${idx + 1}. Step: ${step.id}`);
          if (step.description) {
            stepInfo.push(`   Description: ${step.description}`);
          }
          const renderedWhen = await render(step.when, templateContext);
          if (step.when) {
            stepInfo.push(
              `   When this step should be completed: ${renderedWhen}`
            );
          }
          if (step.requires && step.requires.length > 0) {
            stepInfo.push(`   Required data: ${step.requires.join(", ")}`);
          }
          if (step.collect && step.collect.length > 0) {
            stepInfo.push(`   Will collect: ${step.collect.join(", ")}`);
          }
        }
        stepInfo.push("");
        stepInfo.push(
          "IMPORTANT: You MUST select a step to transition to. Evaluate which step makes the most sense based on:"
        );
        stepInfo.push("- The conversation flow and what's been collected");
        stepInfo.push("- What data is still needed vs already present");
        stepInfo.push("- The logical next step in the conversation");
        stepInfo.push("- Whether conditions for steps are met");
        await pc.addInstruction(stepInfo.join("\n"));
      }
    }

    await pc.addInteractionHistory(history);
    await pc.addLastMessage(lastMessage);
    // Cast to unknown to satisfy generic constraints in composer
    // This is safe because PromptComposer only reads route metadata (id, title, description)
    await pc.addRoutingOverview(routes);
    await pc.addInstruction(
      [
        "Scoring rules:",
        "- 90-100: explicit keywords + clear intent",
        "- 70-89: strong contextual evidence + relevant keywords",
        "- 50-69: moderate relevance",
        "- 30-49: weak connection or ambiguous",
        "- 0-29: minimal/none",
        "Return ONLY JSON matching the provided schema. Include scores for ALL routes.",
      ].join("\n")
    );
    return pc.build();
  }

  decideRouteFromScores(output: RoutingDecision): {
    routeId: string;
    maxScore: number;
  } {
    // Optionally limit candidates and apply switching threshold
    const entries = Object.entries(output.routes).sort((a, b) => b[1] - a[1]);
    const limited = this.options?.maxCandidates
      ? entries.slice(0, this.options.maxCandidates)
      : entries;
    const [topId, topScore] = limited[0] || ["", 0];
    // switchThreshold is enforced by caller when a current route exists
    return { routeId: topId, maxScore: topScore };
  }
}
