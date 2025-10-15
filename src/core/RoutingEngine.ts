import type { Event } from "../types/history";
import type { Route } from "./Route";
import type { State } from "./State";
import type { StructuredSchema } from "../types/schema";
import type { RoutingDecision } from "../types/routing";
import type { SessionState } from "../types/session";
import type { AiProvider } from "../types/ai";
import { enterRoute, mergeExtracted } from "../types/session";
import { PromptComposer } from "./PromptComposer";
import { getLastMessageFromHistory } from "../utils/event";

export interface RoutingDecisionOutput {
  context: string;
  routes: Record<string, number>;
  selectedStateId?: string; // For active route, which state to transition to
  stateReasoning?: string; // Why this state was selected
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
   * Skips route scoring and only does state selection
   * @private
   */
  private async decideSingleRouteState(params: {
    route: Route<TContext, unknown>;
    session: SessionState;
    history: Event[];
    agentMeta?: {
      name?: string;
      goal?: string;
      description?: string;
      personality?: string;
    };
    ai: AiProvider;
    context: TContext;
    signal?: AbortSignal;
  }): Promise<{
    selectedRoute?: Route<TContext>;
    selectedState?: State<TContext>;
    responseDirectives?: string[];
    session: SessionState;
    isRouteComplete?: boolean;
  }> {
    const { route, session, history, agentMeta, ai, context, signal } = params;

    let updatedSession = session;
    const selectedRoute = route;

    // Enter route if not already in it
    if (!session.currentRoute || session.currentRoute.id !== route.id) {
      updatedSession = enterRoute(session, route.id, route.title);
      if (route.initialData) {
        updatedSession = mergeExtracted(updatedSession, route.initialData);
        console.log(
          `[RoutingEngine] Single-route: Merged initial data:`,
          route.initialData
        );
      }
      console.log(
        `[RoutingEngine] Single-route: Entered route: ${route.title}`
      );
    }

    // Get candidate states
    const currentState = updatedSession.currentState
      ? route.getState(updatedSession.currentState.id)
      : undefined;
    const candidates = this.getCandidateStates(
      route,
      currentState,
      updatedSession.extracted
    );

    if (candidates.length === 0) {
      console.warn(`[RoutingEngine] Single-route: No valid states found`);
      return { selectedRoute, session: updatedSession };
    }

    // If only one candidate, check if route is complete
    if (candidates.length === 1) {
      const isRouteComplete = candidates[0].isRouteComplete;
      if (isRouteComplete) {
        console.log(
          `[RoutingEngine] Single-route: Route complete - all data collected`
        );
      } else {
        console.log(
          `[RoutingEngine] Single-route: Only one valid state: ${candidates[0].state.id}`
        );
      }
      return {
        selectedRoute,
        selectedState: candidates[0].state,
        session: updatedSession,
        isRouteComplete,
      };
    }

    // Multiple candidates - use AI to select best state
    const lastUserMessage = getLastMessageFromHistory(history);
    const statePrompt = this.buildStateSelectionPrompt(
      route,
      currentState,
      candidates,
      updatedSession.extracted,
      history,
      lastUserMessage,
      agentMeta
    );

    const stateSchema = this.buildStateSelectionSchema(
      candidates.map((c) => c.state.id)
    );

    const stateResult = await ai.generateMessage<
      TContext,
      {
        reasoning: string;
        selectedStateId: string;
        responseDirectives?: string[];
      }
    >({
      prompt: statePrompt,
      history,
      context,
      signal,
      parameters: {
        jsonSchema: stateSchema,
        schemaName: "state_selection",
      },
    });

    const selectedStateId = stateResult.structured?.selectedStateId;
    const selectedState = candidates.find(
      (c) => c.state.id === selectedStateId
    )?.state;

    if (selectedState) {
      console.log(
        `[RoutingEngine] Single-route: AI selected state: ${selectedState.id}`
      );
      console.log(
        `[RoutingEngine] Single-route: Reasoning: ${stateResult.structured?.reasoning}`
      );
    } else {
      console.warn(
        `[RoutingEngine] Single-route: Invalid state ID returned, using first candidate`
      );
    }

    return {
      selectedRoute,
      selectedState: selectedState || candidates[0].state,
      responseDirectives: stateResult.structured?.responseDirectives,
      session: updatedSession,
    };
  }

  /**
   * Identify valid next candidate states based on current state and extracted data
   * Returns state with isRouteComplete flag if route is complete (all states skipped + has END_ROUTE transition)
   */
  getCandidateStates<TExtracted = unknown>(
    route: Route<TContext, TExtracted>,
    currentState: State<TContext, TExtracted> | undefined,
    extracted: Partial<TExtracted>
  ): Array<{
    state: State<TContext, TExtracted>;
    condition?: string;
    requiredData?: string[];
    gatherFields?: string[];
    isRouteComplete?: boolean;
  }> {
    const candidates: Array<{
      state: State<TContext, TExtracted>;
      condition?: string;
      requiredData?: string[];
      gatherFields?: string[];
      isRouteComplete?: boolean;
    }> = [];

    if (!currentState) {
      const initialState = route.initialState;
      if (initialState.shouldSkip(extracted)) {
        const transitions = initialState.getTransitions();
        for (const transition of transitions) {
          const target = transition.getTarget();
          if (target && !target.shouldSkip(extracted)) {
            candidates.push({
              state: target,
              condition: transition.condition,
              requiredData: target.requiredData,
              gatherFields: target.gatherFields,
            });
          }
        }
      } else {
        candidates.push({
          state: initialState,
          requiredData: initialState.requiredData,
          gatherFields: initialState.gatherFields,
        });
      }
      return candidates;
    }

    const transitions = currentState.getTransitions();
    let hasEndRoute = false;

    for (const transition of transitions) {
      const target = transition.getTarget();

      // Check for END_ROUTE transition (no target state)
      if (
        !target &&
        transition.spec.state &&
        typeof transition.spec.state === "symbol"
      ) {
        hasEndRoute = true;
        continue;
      }

      if (!target) continue;

      if (target.shouldSkip(extracted)) {
        console.log(
          `[RoutingEngine] Skipping state ${target.id} (skipIf condition met)`
        );
        continue;
      }

      candidates.push({
        state: target,
        condition: transition.condition,
        requiredData: target.requiredData,
        gatherFields: target.gatherFields,
      });
    }

    // If no valid candidates found
    if (candidates.length === 0) {
      // If current state has END_ROUTE transition, the route is complete
      if (hasEndRoute) {
        console.log(
          `[RoutingEngine] Route complete: all states processed, END_ROUTE reached`
        );
        // Return current state with completion flag
        return [
          {
            state: currentState,
            condition: "Route complete - all data collected",
            isRouteComplete: true,
          },
        ];
      }

      // Otherwise, stay in current state if it's still valid
      if (!currentState.shouldSkip(extracted)) {
        candidates.push({
          state: currentState,
          condition: "Continue in current state (no valid transitions)",
          requiredData: currentState.requiredData,
          gatherFields: currentState.gatherFields,
        });
      }
    }

    return candidates;
  }

  /**
   * Full routing orchestration: builds prompt and schema, calls AI, selects route/state,
   * and updates the session (including initialData merge when entering a new route).
   *
   * OPTIMIZATION: If there's only 1 route, skips route scoring and only does state selection.
   */
  async decideRouteAndState(params: {
    routes: Route<TContext, unknown>[];
    session: SessionState;
    history: Event[];
    agentMeta?: {
      name?: string;
      goal?: string;
      description?: string;
      personality?: string;
    };
    ai: AiProvider;
    context: TContext;
    signal?: AbortSignal;
  }): Promise<{
    selectedRoute?: Route<TContext>;
    selectedState?: State<TContext>;
    responseDirectives?: string[];
    session: SessionState;
    isRouteComplete?: boolean;
  }> {
    const { routes, session, history, agentMeta, ai, context, signal } = params;

    if (routes.length === 0) {
      return { session };
    }

    // OPTIMIZATION: Single route - skip route scoring, only do state selection
    if (routes.length === 1) {
      return this.decideSingleRouteState({
        route: routes[0],
        session,
        history,
        agentMeta,
        ai,
        context,
        signal,
      });
    }

    const lastUserMessage = getLastMessageFromHistory(history);

    let activeRouteStates:
      | Array<{
          stateId: string;
          description: string;
          condition?: string;
          requiredData?: string[];
          gatherFields?: string[];
        }>
      | undefined;
    let activeRoute: Route<TContext> | undefined;
    let isRouteComplete = false;

    if (session.currentRoute) {
      activeRoute = routes.find((r) => r.id === session.currentRoute?.id);
      if (activeRoute) {
        const currentState = session.currentState
          ? activeRoute.getState(session.currentState.id)
          : undefined;
        const candidates = this.getCandidateStates(
          activeRoute,
          currentState,
          session.extracted
        );

        // Check if route is complete
        if (candidates.length === 1 && candidates[0].isRouteComplete) {
          isRouteComplete = true;
          console.log(
            `[RoutingEngine] Route ${activeRoute.title} is complete - all data collected`
          );
          // Don't include states in routing if route is complete
          activeRouteStates = undefined;
        } else {
          activeRouteStates = candidates.map((c) => ({
            stateId: c.state.id,
            description: c.state.description || "",
            condition: c.condition,
            requiredData: c.requiredData,
            gatherFields: c.gatherFields,
          }));
          console.log(
            `[RoutingEngine] Found ${activeRouteStates.length} candidate states for active route`
          );
        }
      }
    }

    const routingSchema = this.buildDynamicRoutingSchema(
      routes,
      undefined,
      activeRouteStates
    );

    const routingPrompt = this.buildRoutingPrompt(
      history,
      routes,
      lastUserMessage,
      agentMeta,
      session,
      activeRouteStates
    );

    const routingResult = await ai.generateMessage<
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
    let selectedState: State<TContext> | undefined;
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
        routingResult.structured.selectedStateId &&
        activeRoute
      ) {
        selectedState = activeRoute.getState(
          routingResult.structured.selectedStateId
        );
        if (selectedState) {
          console.log(
            `[RoutingEngine] AI selected state: ${selectedState.id} in active route`
          );
          console.log(
            `[RoutingEngine] State reasoning: ${routingResult.structured.stateReasoning}`
          );
        }
      }

      if (selectedRoute) {
        console.log(`[RoutingEngine] Selected route: ${selectedRoute.title}`);
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
            updatedSession = mergeExtracted(
              updatedSession,
              selectedRoute.initialData
            );
            console.log(
              `[RoutingEngine] Merged initial data:`,
              selectedRoute.initialData
            );
          }
          console.log(`[RoutingEngine] Entered route: ${selectedRoute.title}`);
        }
      }
    }

    return {
      selectedRoute,
      selectedState,
      responseDirectives,
      session: updatedSession,
      isRouteComplete,
    };
  }

  /**
   * Build prompt for state selection within a single route
   * @private
   */
  private buildStateSelectionPrompt(
    route: Route<TContext>,
    currentState: State<TContext> | undefined,
    candidates: Array<{
      state: State<TContext>;
      condition?: string;
      requiredData?: string[];
      gatherFields?: string[];
    }>,
    extracted: Partial<unknown>,
    history: Event[],
    lastMessage: string,
    agentMeta?: {
      name?: string;
      goal?: string;
      description?: string;
      personality?: string;
    }
  ): string {
    const pc = new PromptComposer();

    // Add agent metadata
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

    // Add route context
    pc.addInstruction(
      `Active Route: ${route.title}\nDescription: ${route.description || "N/A"}`
    );

    // Add current state context
    if (currentState) {
      pc.addInstruction(
        `Current State: ${currentState.id}\nDescription: ${
          currentState.description || "N/A"
        }`
      );
    } else {
      pc.addInstruction("Current State: None (entering route)");
    }

    // Add extracted data context
    if (Object.keys(extracted).length > 0) {
      pc.addInstruction(
        `Extracted Data So Far:\n${JSON.stringify(extracted, null, 2)}`
      );
    } else {
      pc.addInstruction("Extracted Data: None yet");
    }

    // Add conversation history
    pc.addInteractionHistory(history);
    pc.addLastMessage(lastMessage);

    // Add candidate states
    const stateDescriptions = candidates.map((candidate, idx) => {
      const parts = [
        `${idx + 1}. State ID: ${candidate.state.id}`,
        `   Description: ${candidate.state.description || "N/A"}`,
      ];

      if (candidate.condition) {
        parts.push(`   Condition: ${candidate.condition}`);
      }

      if (candidate.requiredData && candidate.requiredData.length > 0) {
        parts.push(`   Required Data: ${candidate.requiredData.join(", ")}`);
      }

      if (candidate.gatherFields && candidate.gatherFields.length > 0) {
        parts.push(`   Gathers: ${candidate.gatherFields.join(", ")}`);
      }

      return parts.join("\n");
    });

    pc.addInstruction(
      `Available States to Transition To:\n${stateDescriptions.join("\n\n")}`
    );

    // Add decision instructions
    pc.addInstruction(
      [
        "Task: Decide which state to transition to based on:",
        "1. The user's current message and intent",
        "2. The conversation history and context",
        "3. The extracted data we already have",
        "4. The conditions and requirements of each state",
        "5. The logical flow of the conversation",
        "",
        "Rules:",
        "- If a state has a condition, evaluate whether it's met based on context",
        "- If a state requires data we don't have, consider if we should gather it now",
        "- Choose the state that makes the most sense for moving the conversation forward",
        "- States with skipIf conditions that are met have already been filtered out",
        "",
        "Return ONLY JSON matching the provided schema.",
      ].join("\n")
    );

    return pc.build();
  }

  /**
   * Build schema for state selection
   * @private
   */
  private buildStateSelectionSchema(validStateIds: string[]): StructuredSchema {
    return {
      description:
        "State transition decision based on conversation context and extracted data",
      type: "object",
      properties: {
        reasoning: {
          type: "string",
          nullable: false,
          description: "Brief explanation of why this state was selected",
        },
        selectedStateId: {
          type: "string",
          nullable: false,
          description: "The ID of the selected state to transition to",
          enum: validStateIds,
        },
        responseDirectives: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional bullet points the response should address (concise)",
        },
      },
      required: ["reasoning", "selectedStateId"],
      additionalProperties: false,
    };
  }

  buildDynamicRoutingSchema(
    routes: Route<TContext>[],
    extrasSchema?: StructuredSchema,
    activeRouteStates?: { stateId: string; description: string }[]
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

    // Add state selection fields if there's an active route with states
    if (activeRouteStates && activeRouteStates.length > 0) {
      base.properties = base.properties || {};
      base.properties.selectedStateId = {
        type: "string",
        nullable: false,
        description:
          "The state ID to transition to within the active route (required if continuing in current route)",
        enum: activeRouteStates.map((s) => s.stateId),
      };
      base.properties.stateReasoning = {
        type: "string",
        nullable: false,
        description: "Brief explanation of why this state was selected",
      };
      base.required = [
        ...(base.required || []),
        "selectedStateId",
        "stateReasoning",
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
    activeRouteStates?: Array<{
      stateId: string;
      description: string;
      condition?: string;
      requiredData?: string[];
      gatherFields?: string[];
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
      if (session.currentState) {
        sessionInfo.push(`- Current state: ${session.currentState.id}`);
        if (session.currentState.description) {
          sessionInfo.push(`  "${session.currentState.description}"`);
        }
      }
      if (Object.keys(session.extracted).length > 0) {
        sessionInfo.push(
          `- Extracted data: ${JSON.stringify(session.extracted)}`
        );
      }
      sessionInfo.push(
        "Note: User is mid-conversation. They may want to continue current route or switch to a new one based on their intent."
      );
      pc.addInstruction(sessionInfo.join("\n"));

      // Add available states for the active route
      if (activeRouteStates && activeRouteStates.length > 0) {
        const stateInfo = [
          "",
          "Available states in active route (choose one to transition to):",
        ];
        activeRouteStates.forEach((state, idx) => {
          stateInfo.push(`${idx + 1}. State: ${state.stateId}`);
          if (state.description) {
            stateInfo.push(`   Description: ${state.description}`);
          }
          if (state.condition) {
            stateInfo.push(`   Condition: ${state.condition}`);
          }
          if (state.requiredData && state.requiredData.length > 0) {
            stateInfo.push(
              `   Required data: ${state.requiredData.join(", ")}`
            );
          }
          if (state.gatherFields && state.gatherFields.length > 0) {
            stateInfo.push(`   Will gather: ${state.gatherFields.join(", ")}`);
          }
        });
        stateInfo.push("");
        stateInfo.push(
          "IMPORTANT: You MUST select a state to transition to. Evaluate which state makes the most sense based on:"
        );
        stateInfo.push("- The conversation flow and what's been collected");
        stateInfo.push("- What data is still needed vs already present");
        stateInfo.push("- The logical next step in the conversation");
        stateInfo.push("- Whether conditions for states are met");
        pc.addInstruction(stateInfo.join("\n"));
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
