import type { Event } from "../types/history";
import type { Route } from "./Route";
import type { Step } from "./Step";
import type { StructuredSchema } from "../types/schema";
import type { RoutingDecision } from "../types/routing";
import type { SessionState } from "../types/session";
import type { AiProvider } from "../types/ai";
import { enterRoute, mergeCollected } from "../types/session";
import { PromptComposer } from "./PromptComposer";
import { getLastMessageFromHistory } from "../utils/event";
import { logger } from "../utils/logger";

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

export class RoutingEngine<TContext = unknown> {
  constructor(private readonly options?: RoutingEngineOptions) {}

  /**
   * Optimized decision for single-route scenarios
   * Skips route scoring and only does step selection
   * @private
   */
  private async decideSingleRouteStep(params: {
    route: Route<TContext, unknown>;
    session: SessionState;
    history: Event[];
    agentMeta?: {
      name?: string;
      goal?: string;
      description?: string;
      personality?: string;
      identity?: string;
    };
    provider: AiProvider;
    context: TContext;
    signal?: AbortSignal;
  }): Promise<{
    selectedRoute?: Route<TContext>;
    selectedStep?: Step<TContext>;
    responseDirectives?: string[];
    session: SessionState;
    isRouteComplete?: boolean;
  }> {
    const { route, session, history, agentMeta, provider, context, signal } =
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
    const stepPrompt = this.buildStepSelectionPrompt(
      route,
      currentStep,
      candidates,
      updatedSession.data || {},
      history,
      lastUserMessage,
      agentMeta
    );

    const stepSchema = this.buildStepSelectionSchema(
      candidates.map((c) => c.step.id)
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
    const selectedStep = candidates.find(
      (c) => c.step.id === selectedStepId
    )?.step;

    if (selectedStep) {
      logger.debug(
        `[RoutingEngine] Single-route: AI selected step: ${selectedStep.id}`
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
      selectedStep: selectedStep || candidates[0].step,
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
    condition?: string;
    isRouteComplete?: boolean;
  } {
    // Prevent infinite loops
    if (visited.has(currentStep.id)) {
      return {};
    }
    visited.add(currentStep.id);

    const transitions = currentStep.getTransitions();

    for (const transition of transitions) {
      const target = transition.getTarget();

      // Check for END_ROUTE transition
      if (
        !target &&
        transition.spec.step &&
        typeof transition.spec.step === "symbol"
      ) {
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
          condition: transition.condition,
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
  ): Array<{
    step: Step<TContext, TData>;
    condition?: string;
    requires?: string[];
    collectFields?: string[];
    isRouteComplete?: boolean;
  }> {
    const candidates: Array<{
      step: Step<TContext, TData>;
      condition?: string;
      requires?: string[];
      collectFields?: string[];
      isRouteComplete?: boolean;
    }> = [];

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
          return [
            {
              step: initialStep,
              condition: "Route complete - all data collected on entry",
              isRouteComplete: true,
            },
          ];
        } else if (result.step) {
          // Found a non-skipped step
          candidates.push({
            step: result.step,
            condition: result.condition,
            requires: result.step.requires,
            collectFields: result.step.collectFields,
          });
        }
        // If no step found and not complete, fall through to return empty candidates
      } else {
        candidates.push({
          step: initialStep,
          requires: initialStep.requires,
          collectFields: initialStep.collectFields,
        });
      }
      return candidates;
    }

    const transitions = currentStep.getTransitions();
    let hasEndRoute = false;

    for (const transition of transitions) {
      const target = transition.getTarget();

      // Check for END_ROUTE transition (no target step)
      if (
        !target &&
        transition.spec.step &&
        typeof transition.spec.step === "symbol"
      ) {
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
            condition: result.condition || transition.condition,
            requires: result.step.requires,
            collectFields: result.step.collectFields,
          });
        }
        continue;
      }

      candidates.push({
        step: target,
        condition: transition.condition,
        requires: target.requires,
        collectFields: target.collectFields,
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
            condition: "Route complete - all data collected",
            isRouteComplete: true,
          },
        ];
      }

      // Otherwise, stay in current step if it's still valid
      if (!currentStep.shouldSkip(data)) {
        candidates.push({
          step: currentStep,
          condition: "Continue in current step (no valid transitions)",
          requires: currentStep.requires,
          collectFields: currentStep.collectFields,
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
    routes: Route<TContext, unknown>[];
    session: SessionState;
    history: Event[];
    agentMeta?: {
      name?: string;
      goal?: string;
      description?: string;
      personality?: string;
      identity?: string;
    };
    provider: AiProvider;
    context: TContext;
    signal?: AbortSignal;
  }): Promise<{
    selectedRoute?: Route<TContext>;
    selectedStep?: Step<TContext>;
    responseDirectives?: string[];
    session: SessionState;
    isRouteComplete?: boolean;
  }> {
    const { routes, session, history, agentMeta, provider, context, signal } =
      params;

    if (routes.length === 0) {
      return { session };
    }

    // OPTIMIZATION: Single route - skip route scoring, only do step selection
    if (routes.length === 1) {
      return this.decideSingleRouteStep({
        route: routes[0],
        session,
        history,
        agentMeta,
        provider,
        context,
        signal,
      });
    }

    const lastUserMessage = getLastMessageFromHistory(history);

    let activeRouteSteps:
      | Array<{
          stepId: string;
          description: string;
          condition?: string;
          requires?: string[];
          collectFields?: string[];
        }>
      | undefined;
    let activeRoute: Route<TContext> | undefined;
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
          activeRouteSteps = candidates.map((c) => ({
            stepId: c.step.id,
            description: c.step.description || "",
            condition: c.condition,
            requires: c.requires,
            collectFields: c.collectFields,
          }));
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

    const routingPrompt = this.buildRoutingPrompt(
      history,
      routes,
      lastUserMessage,
      agentMeta,
      session,
      activeRouteSteps
    );

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
  private buildStepSelectionPrompt(
    route: Route<TContext>,
    currentStep: Step<TContext> | undefined,
    candidates: Array<{
      step: Step<TContext>;
      condition?: string;
      requires?: string[];
      collectFields?: string[];
    }>,
    data: Partial<unknown>,
    history: Event[],
    lastMessage: string,
    agentMeta?: {
      name?: string;
      goal?: string;
      description?: string;
      personality?: string;
      identity?: string;
    }
  ): string {
    const pc = new PromptComposer();

    // Add agent metadata
    if (agentMeta?.name || agentMeta?.goal || agentMeta?.description) {
      pc.addAgentMeta({
        name: agentMeta?.name || "Agent",
        description: agentMeta?.description,
        goal: agentMeta?.goal,
        identity: agentMeta?.identity,
      });
    }

    const personality =
      agentMeta?.personality || "Tone: brief, natural, 1-2 short sentences.";
    pc.addPersonality(personality);
    if (agentMeta?.identity) {
      pc.addIdentity(agentMeta.identity);
    }

    // Add route context
    pc.addInstruction(
      `Active Route: ${route.title}\nDescription: ${route.description || "N/A"}`
    );

    // Add current step context
    if (currentStep) {
      pc.addInstruction(
        `Current Step: ${currentStep.id}\nDescription: ${
          currentStep.description || "N/A"
        }`
      );
    } else {
      pc.addInstruction("Current Step: None (entering route)");
    }

    // Add collected data context
    if (Object.keys(data).length > 0) {
      pc.addInstruction(
        `Collected Data So Far:\n${JSON.stringify(data, null, 2)}`
      );
    } else {
      pc.addInstruction("Collected Data: None yet");
    }

    // Add conversation history
    pc.addInteractionHistory(history);
    pc.addLastMessage(lastMessage);

    // Add candidate steps
    const stepDescriptions = candidates.map((candidate, idx) => {
      const parts = [
        `${idx + 1}. Step ID: ${candidate.step.id}`,
        `   Description: ${candidate.step.description || "N/A"}`,
      ];

      if (candidate.condition) {
        parts.push(`   Condition: ${candidate.condition}`);
      }

      if (candidate.requires && candidate.requires.length > 0) {
        parts.push(`   Required Data: ${candidate.requires.join(", ")}`);
      }

      if (candidate.collectFields && candidate.collectFields.length > 0) {
        parts.push(`   Collects: ${candidate.collectFields.join(", ")}`);
      }

      return parts.join("\n");
    });

    pc.addInstruction(
      `Available Steps to Transition To:\n${stepDescriptions.join("\n\n")}`
    );

    // Add decision prompt
    pc.addInstruction(
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
  private buildStepSelectionSchema(validStepIds: string[]): StructuredSchema {
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
          enum: validStepIds,
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
    routes: Route<TContext>[],
    extrasSchema?: StructuredSchema,
    activeRouteSteps?: { stepId: string; description: string }[]
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
        enum: activeRouteSteps.map((s) => s.stepId),
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

  buildRoutingPrompt(
    history: Event[],
    routes: Route<TContext>[],
    lastMessage: string,
    agentMeta?: {
      name?: string;
      goal?: string;
      description?: string;
      personality?: string;
    },
    session?: SessionState,
    activeRouteSteps?: Array<{
      stepId: string;
      description: string;
      condition?: string;
      requires?: string[];
      collectFields?: string[];
    }>
  ): string {
    const pc = new PromptComposer();
    if (agentMeta?.name || agentMeta?.goal || agentMeta?.description) {
      pc.addAgentMeta({
        name: agentMeta?.name || "Agent",
        description: agentMeta?.description,
        goal: agentMeta?.goal,
      });
    }
    const personality =
      agentMeta?.personality || "Tone: brief, natural, 1-2 short sentences.";
    pc.addPersonality(personality);
    pc.addInstruction(
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
      pc.addInstruction(sessionInfo.join("\n"));

      // Add available steps for the active route
      if (activeRouteSteps && activeRouteSteps.length > 0) {
        const stepInfo = [
          "",
          "Available steps in active route (choose one to transition to):",
        ];
        activeRouteSteps.forEach((step, idx) => {
          stepInfo.push(`${idx + 1}. Step: ${step.stepId}`);
          if (step.description) {
            stepInfo.push(`   Description: ${step.description}`);
          }
          if (step.condition) {
            stepInfo.push(`   Condition: ${step.condition}`);
          }
          if (step.requires && step.requires.length > 0) {
            stepInfo.push(`   Required data: ${step.requires.join(", ")}`);
          }
          if (step.collectFields && step.collectFields.length > 0) {
            stepInfo.push(`   Will collect: ${step.collectFields.join(", ")}`);
          }
        });
        stepInfo.push("");
        stepInfo.push(
          "IMPORTANT: You MUST select a step to transition to. Evaluate which step makes the most sense based on:"
        );
        stepInfo.push("- The conversation flow and what's been collected");
        stepInfo.push("- What data is still needed vs already present");
        stepInfo.push("- The logical next step in the conversation");
        stepInfo.push("- Whether conditions for steps are met");
        pc.addInstruction(stepInfo.join("\n"));
      }
    }

    pc.addInteractionHistory(history);
    pc.addLastMessage(lastMessage);
    // Cast to unknown to satisfy generic constraints in composer
    // This is safe because PromptComposer only reads route metadata (id, title, description)
    pc.addRoutingOverview(routes as unknown as Route<unknown>[]);
    pc.addInstruction(
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
