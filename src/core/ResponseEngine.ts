import type {
  Event,
  StructuredSchema,
  SessionState,
  AgentOptions,
  Guideline,
  Term,
  Template,
} from "../types";
import type { Route } from "./Route";
import type { Step } from "./Step";
import { PromptComposer } from "./PromptComposer";
import { render } from "../utils/template";

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
  agentOptions?: AgentOptions<TContext>;
  // Combined properties from agent and route
  combinedGuidelines?: Guideline<TContext>[];
  combinedTerms?: Term<TContext>[];
  context?: TContext;
  session?: SessionState<TData>;
}

export interface BuildFallbackPromptParams<TContext = unknown> {
  history: Event[];
  agentOptions: AgentOptions<TContext>;
  terms: Term<TContext>[];
  guidelines: Guideline<TContext>[];
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
      agentOptions,
      combinedGuidelines,
      combinedTerms,
      context,
      session,
    } = params;
    const templateContext = { context, session, history };
    const pc = new PromptComposer(templateContext);

    // Create combined agent options with route overrides
    let effectiveAgentOptions = agentOptions;
    if (agentOptions && (route.identity || route.personality)) {
      // Route identity and personality override agent versions
      effectiveAgentOptions = {
        ...agentOptions,
        ...(route.identity && { identity: route.identity }),
        ...(route.personality && { personality: route.personality }),
      };
    }

    if (effectiveAgentOptions) {
      await pc.addAgentMeta(effectiveAgentOptions);
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
      agentOptions?.knowledgeBase,
      route.getKnowledgeBase()
    );

    // Add combined guidelines (agent + route)
    if (combinedGuidelines && combinedGuidelines.length > 0) {
      await pc.addGuidelines(combinedGuidelines);
    }

    // Add combined terms (agent + route)
    if (combinedTerms && combinedTerms.length > 0) {
      await pc.addGlossary(combinedTerms);
    }

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
    const { history, agentOptions, terms, guidelines, context, session } =
      params;
    const templateContext = { context, session, history };
    const pc = new PromptComposer(templateContext);

    await pc.addAgentMeta(agentOptions);
    await pc.addInteractionHistory(history);
    await pc.addGlossary(terms);
    await pc.addGuidelines(guidelines);
    await pc.addKnowledgeBase(agentOptions.knowledgeBase);
    return pc.build();
  }
}
