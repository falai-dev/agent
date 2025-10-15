import type { Event } from "../types/history";
import type { Route } from "./Route";
import type { State } from "./State";
import type { StructuredSchema } from "../types/schema";
import { PromptComposer } from "./PromptComposer";

export interface ResponseOutput<TData = unknown> {
  message: string;
  data?: TData;
  contextUpdate?: Record<string, unknown>;
}

export class ResponseEngine<TContext = unknown> {
  responseSchemaForRoute<TExtracted = unknown>(
    route: Route<TContext, TExtracted>,
    currentState?: State<TContext, TExtracted>
  ): StructuredSchema {
    const base: StructuredSchema = {
      type: "object",
      properties: {
        message: { type: "string", description: "Final user-facing message" },
      },
      required: ["message"],
      additionalProperties: false,
    };

    // Add data field only if route has responseOutputSchema
    if (route.responseOutputSchema) {
      base.properties!.data = route.responseOutputSchema;
    }

    // Add gather fields from current state
    if (currentState?.gatherFields && route.extractionSchema?.properties) {
      for (const field of currentState.gatherFields) {
        const fieldSchema = route.extractionSchema.properties[field];
        if (fieldSchema) {
          base.properties![field] = fieldSchema;
        }
      }
    }

    return base;
  }

  buildResponsePrompt(
    route: Route<TContext>,
    rules: string[],
    prohibitions: string[],
    directives: string[] | undefined,
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
    if (agentMeta?.name || agentMeta?.goal || agentMeta?.description)
      pc.addAgentMeta({
        name: agentMeta?.name || "Agent",
        goal: agentMeta?.goal,
        description: agentMeta?.description,
      });
    const personality =
      agentMeta?.personality || "Tone: brief, natural, 1-2 short sentences.";
    pc.addPersonality(personality);
    pc.addInstruction(
      `Route: ${route.title}${
        route.description ? ` — ${route.description}` : ""
      }`
    );
    if (rules.length) pc.addInstruction(`Rules:\n- ${rules.join("\n- ")}`);
    if (prohibitions.length)
      pc.addInstruction(`Prohibitions:\n- ${prohibitions.join("\n- ")}`);
    pc.addDirectives(directives);
    pc.addInteractionHistory(history);
    pc.addLastMessage(lastMessage);
    pc.addInstruction(
      "Return ONLY JSON matching the schema. The 'message' field is required."
    );
    return pc.build();
  }
}
