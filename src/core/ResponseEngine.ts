import type { Event } from "../types/history";
import type { Route } from "./Route";
import type { Step } from "./Step";
import type { StructuredSchema } from "../types/schema";
import { PromptComposer } from "./PromptComposer";
import { render } from "../utils/template";
import type { SessionState } from "../types/session";
import type { AgentOptions, Capability, Guideline, Term } from "../types/agent";
import type { Template } from "../types/template";

export interface BuildResponsePromptParams<
  TContext = unknown,
  TData = unknown
> {
  route: Route<TContext, TData>;
  currentStep: Step<TContext, TData>;
  rules: Template<TContext, TData>[];
  prohibitions: Template<TContext, TData>[];
  directives: string[] | undefined;
  history: Event[];
  lastMessage: string;
  agentMeta?: AgentOptions<TContext>;
  context?: TContext;
  session?: SessionState<TData>;
}

export interface BuildFallbackPromptParams<TContext = unknown> {
  history: Event[];
  agentMeta: AgentOptions<TContext>;
  terms: Term<TContext>[];
  guidelines: Guideline<TContext>[];
  capabilities: Capability[];
  context?: TContext;
  session?: SessionState;
}

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
    if (currentStep?.collect && route.schema?.properties) {
      for (const field of currentStep.collect) {
        const fieldSchema = route.schema.properties[field];
        if (fieldSchema) {
          base.properties![field] = fieldSchema;
        }
      }
    }

    return base;
  }

  async buildResponsePrompt(
    params: BuildResponsePromptParams<TContext>
  ): Promise<string> {
    const {
      route,
      currentStep,
      rules,
      prohibitions,
      directives,
      history,
      lastMessage,
      agentMeta,
      context,
      session,
    } = params;
    const templateContext = { context, session, history };
    const pc = new PromptComposer(templateContext);
    if (agentMeta) {
      await pc.addAgentMeta(agentMeta);
    }
    await pc.addInstruction(
      `Route: ${route.title}${
        route.description ? ` — ${route.description}` : ""
      }`
    );
    if (currentStep.prompt) {
      await pc.addInstruction(
        `Guideline for your response (adapt to the conversation):\n${await render(
          currentStep.prompt,
          templateContext
        )}`
      );
    }
    if (rules.length)
      await pc.addInstruction(`Rules:\n- ${rules.join("\n- ")}`);
    if (prohibitions.length)
      await pc.addInstruction(`Prohibitions:\n- ${prohibitions.join("\n- ")}`);
    await pc.addDirectives(directives);
    await pc.addKnowledgeBase(
      agentMeta?.knowledgeBase,
      route.getKnowledgeBase()
    );
    await pc.addInteractionHistory(history);
    await pc.addLastMessage(lastMessage);
    await pc.addInstruction(
      "Return ONLY JSON matching the schema. The 'message' field is required."
    );
    return pc.build();
  }

  async buildFallbackPrompt(
    params: BuildFallbackPromptParams<TContext>
  ): Promise<string> {
    const {
      history,
      agentMeta,
      terms,
      guidelines,
      capabilities,
      context,
      session,
    } = params;
    const templateContext = { context, session, history };
    const pc = new PromptComposer(templateContext);

    await pc.addAgentMeta(agentMeta);
    await pc.addInteractionHistory(history);
    await pc.addGlossary(terms);
    await pc.addGuidelines(guidelines);
    await pc.addCapabilities(capabilities);
    await pc.addKnowledgeBase(agentMeta.knowledgeBase);
    return pc.build();
  }
}
