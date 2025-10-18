import type { Event } from "../types/history";
import type { Route } from "./Route";
import type { Step } from "./Step";
import type { StructuredSchema } from "../types/schema";
import { PromptComposer } from "./PromptComposer";

export class ResponseEngine<TContext = unknown> {
  responseSchemaForRoute<TData = unknown>(
    route: Route<TContext, TData>,
    currentStep?: Step<TContext, TData>
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

    // Add collect fields from current step
    if (currentStep?.collectFields && route.schema?.properties) {
      for (const field of currentStep.collectFields) {
        const fieldSchema = route.schema.properties[field];
        if (fieldSchema) {
          base.properties![field] = fieldSchema;
        }
      }
    }

    return base;
  }

  buildResponsePrompt(
    route: Route<TContext>,
    currentStep: Step<TContext>,
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
      identity?: string;
    }
  ): string {
    const pc = new PromptComposer();
    if (agentMeta?.name || agentMeta?.goal || agentMeta?.description)
      pc.addAgentMeta({
        name: agentMeta?.name || "Agent",
        goal: agentMeta?.goal,
        description: agentMeta?.description,
        identity: agentMeta?.identity,
      });
    const personality =
      agentMeta?.personality || "Tone: brief, natural, 1-2 short sentences.";
    pc.addPersonality(personality);
    if (agentMeta?.identity) {
      pc.addIdentity(agentMeta.identity);
    }
    pc.addInstruction(
      `Route: ${route.title}${
        route.description ? ` — ${route.description}` : ""
      }`
    );
    if (currentStep.prompt) {
      pc.addInstruction(
        `Guideline for your response (adapt to the conversation):\n${currentStep.prompt}`
      );
    }
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
