import type { Event } from "../types/history";
import type { Route } from "./Route";
import type { StructuredSchema } from "../types/schema";
import type { RoutingDecision } from "../types/routing";
import type { SessionState } from "../types/session";
import { PromptComposer } from "./PromptComposer";

export interface RoutingDecisionOutput {
  context: string;
  routes: Record<string, number>;
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

  buildDynamicRoutingSchema(
    routes: Route<TContext>[],
    extrasSchema?: StructuredSchema
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
    session?: SessionState
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
