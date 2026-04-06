import type { Event, Term, Guideline, AgentOptions } from "../types";
import type { Route } from "./Route";
import { render, renderMany, formatKnowledgeBase, createTemplateContext } from "../utils/template";
import { TemplateContext } from "../types/template";
import { extractAIContextStrings, ConditionEvaluator } from "../utils/condition";
import { PromptSectionCache } from "./PromptSectionCache";

export class PromptComposer<TContext = unknown, TData = unknown> {
  private parts: string[] = [];
  private renderContext: TemplateContext<TContext, TData>;
  private cache: PromptSectionCache | null;
  private instructionCounter = 0;

  constructor(
    context: TemplateContext<TContext, TData> = createTemplateContext({}),
    cache?: PromptSectionCache
  ) {
    this.renderContext = context;
    this.cache = cache ?? null;
  }

  // Specific, typed sections tailored to the framework

  async addAgentMeta(agent: AgentOptions<TContext, TData>): Promise<this> {
    const compute = async (): Promise<string | null> => {
      const lines: string[] = [];
      lines.push("## Agent Identity");
      lines.push(
        `You are "${agent.name}". Always refer to yourself by this name.`
      );
      if (agent.identity) {
        lines.push(await render(agent.identity, this.renderContext));
      }
      if (agent.personality) {
        lines.push(
          `Communicate in the following style: ${await render(
            agent.personality,
            this.renderContext
          )}`
        );
      }
      if (agent.goal) {
        lines.push(`Your primary goal: ${agent.goal}`);
      }
      if (agent.description) {
        lines.push(`About you: ${agent.description}`);
      }
      if (agent.rules?.length) {
        const renderedRules = await renderMany(agent.rules, this.renderContext);
        lines.push(
          `You MUST always follow these rules:\n- ${renderedRules.join("\n- ")}`
        );
      }
      if (agent.prohibitions?.length) {
        const renderedProhibitions = await renderMany(
          agent.prohibitions,
          this.renderContext
        );
        lines.push(
          `You MUST NEVER do the following:\n- ${renderedProhibitions.join(
            "\n- "
          )}`
        );
      }
      return lines.join("\n");
    };

    if (this.cache) {
      this.cache.register("agentMeta", "static", compute);
    } else {
      const result = await compute();
      if (result) this.parts.push(result);
    }
    return this;
  }

  async addRoutingOverview(routes: Route<TContext, TData>[]): Promise<this> {
    return this.addActiveRoutes(routes);
  }

  async addScoringRules(): Promise<this> {
    const compute = (): string | null => {
      return `## Scoring Rules\n\n${[
        "- 90-100: explicit keywords + clear intent",
        "- 70-89: strong contextual evidence + relevant keywords",
        "- 50-69: moderate relevance",
        "- 30-49: weak connection or ambiguous",
        "- 0-29: minimal/none",
        "Return ONLY JSON matching the provided schema. Include scores for ALL routes.",
      ].join("\n")}`;
    };

    if (this.cache) {
      this.cache.register("scoringRules", "static", compute);
    } else {
      this.parts.push(compute()!);
    }
    return Promise.resolve(this);
  }

  async addInstruction(text: string): Promise<this> {
    if (!text) return Promise.resolve(this);

    const content = `## Instruction\n\n${text}`;

    if (this.cache) {
      const key = `instruction-${this.instructionCounter++}`;
      this.cache.register(key, "dynamic", () => content);
    } else {
      this.parts.push(content);
    }
    return Promise.resolve(this);
  }

  /**
   * @deprecated History should flow through `GenerateMessageInput.history` natively.
   * This method is kept for backward compatibility but will be removed in a future version.
   */
  async addInteractionHistory(history: Event[], note?: string): Promise<this> {
    const compute = (): string | null => {
      const recent = history
        .slice(-10)
        .map((e) => `- ${JSON.stringify(e)}`)
        .join("\n");
      const header = note ? `${note}\n\n` : "";
      return `## Interaction History\n\n${header}Recent conversation events:\n\n${recent}`;
    };

    if (this.cache) {
      this.cache.register("interactionHistory", "dynamic", compute);
    } else {
      this.parts.push(compute()!);
    }
    return Promise.resolve(this);
  }

  async addLastMessage(message: string): Promise<this> {
    const compute = (): string | null => {
      return `## Last Message\n\n${message}`;
    };

    if (this.cache) {
      this.cache.register("lastMessage", "dynamic", compute);
    } else {
      this.parts.push(compute()!);
    }
    return Promise.resolve(this);
  }

  async addGlossary(terms: Term<TContext>[]): Promise<this> {
    if (!terms.length) return this;

    const compute = async (): Promise<string | null> => {
      const renderedTerms = await Promise.all(
        terms.map(async (t) => {
          const name = await render(t.name, this.renderContext);
          const description = await render(t.description, this.renderContext);
          const synonyms = t.synonyms
            ? await renderMany(t.synonyms, this.renderContext)
            : [];
          const synonymText =
            synonyms.length > 0 ? ` (synonyms: ${synonyms.join(", ")})` : "";
          return `- **${name}**${synonymText}: ${description}`;
        })
      );
      return `## Glossary\n\n${renderedTerms.join("\n")}`;
    };

    if (this.cache) {
      this.cache.register("glossary", "static", compute);
    } else {
      const result = await compute();
      if (result) this.parts.push(result);
    }
    return this;
  }

  async addGuidelines(guidelines: Guideline<TContext, TData>[]): Promise<this> {
    const enabled = guidelines.filter((g) => g.enabled !== false);
    if (!enabled.length) return this;

    const compute = async (): Promise<string | null> => {
      const evaluator = new ConditionEvaluator(this.renderContext);
      const activeGuidelines: Guideline<TContext, TData>[] = [];
      const allAIContextStrings: string[] = [];

      // Evaluate guideline conditions to determine which are active
      for (const guideline of enabled) {
        if (guideline.condition) {
          const evaluation = await evaluator.evaluateCondition(guideline.condition, 'AND');

          // Collect AI context strings for prompt
          allAIContextStrings.push(...evaluation.aiContextStrings);

          // Include guideline if:
          // 1. No programmatic conditions (only strings) - always active
          // 2. Programmatic conditions evaluate to true
          if (!evaluation.hasProgrammaticConditions || evaluation.programmaticResult) {
            activeGuidelines.push(guideline);
          }
        } else {
          // No condition means always active
          activeGuidelines.push(guideline);
        }
      }

      if (!activeGuidelines.length && !allAIContextStrings.length) return null;

      const renderedGuidelines = await Promise.all(
        activeGuidelines.map(async (g, i) => {
          const action = await render(g.action, this.renderContext);
          if (g.condition) {
            // Use AI context strings if available, otherwise render the condition
            const conditionStrings = extractAIContextStrings(g.condition);
            if (conditionStrings.length > 0) {
              const conditionText = conditionStrings.join(" AND ");
              return `- Guideline #${i + 1}: When ${conditionText}, then ${action}`;
            }
          }
          return `- Guideline #${i + 1}: ${action}`;
        })
      );

      // Add any additional AI context from inactive guidelines
      if (allAIContextStrings.length > 0) {
        const uniqueContextStrings = Array.from(new Set(allAIContextStrings));
        const contextSection = `\n\n**Additional Context:** ${uniqueContextStrings.join(", ")}`;
        return `## Guidelines\n\n${renderedGuidelines.join("\n")}${contextSection}`;
      } else {
        return `## Guidelines\n\n${renderedGuidelines.join("\n")}`;
      }
    };

    if (this.cache) {
      this.cache.register("guidelines", "dynamic", compute);
    } else {
      const result = await compute();
      if (result) this.parts.push(result);
    }
    return this;
  }

  async addKnowledgeBase(
    agentKnowledgeBase?: Record<string, unknown>,
    routeKnowledgeBase?: Record<string, unknown>
  ): Promise<this> {
    const compute = (): string | null => {
      // Merge agent and route knowledge bases (route takes precedence for conflicts)
      const mergedKnowledge = {
        ...(agentKnowledgeBase || {}),
        ...(routeKnowledgeBase || {}),
      };

      // Only add section if there's knowledge data
      if (Object.keys(mergedKnowledge).length > 0) {
        return formatKnowledgeBase(mergedKnowledge, "Knowledge Base");
      }
      return null;
    };

    if (this.cache) {
      this.cache.register("knowledgeBase", "static", compute);
    } else {
      const result = compute();
      if (result) this.parts.push(result);
    }
    return Promise.resolve(this);
  }

  async addActiveRoutes(routes: Route<TContext, TData>[]): Promise<this> {
    if (!routes.length) return this;

    const compute = async (): Promise<string | null> => {
      const renderedRoutes = await Promise.all(
        routes.map(async (r, i) => {
          const whenContextStrings = r.when ? extractAIContextStrings(r.when) : [];
          const conditions =
            whenContextStrings.length > 0
              ? `\n\n  **Triggered when:** ${whenContextStrings.join(" OR ")}`
              : "";
          const desc = r.description
            ? `\n\n  **Description:** ${r.description}`
            : "";
          const rules = await renderMany(r.getRules(), this.renderContext);
          const prohibitions = await renderMany(
            r.getProhibitions(),
            this.renderContext
          );
          const rulesInfo =
            rules.length > 0
              ? `\n\n  **Rules:**\n  ${rules.map((x) => `  - ${x}`).join("\n  ")}`
              : "";
          const prohibitionsInfo =
            prohibitions.length > 0
              ? `\n\n  **Prohibitions:**\n  ${prohibitions
                .map((x) => `  - ${x}`)
                .join("\n  ")}`
              : "";
          return `### Route ${i + 1}: ${r.title
            }${desc}${conditions}${rulesInfo}${prohibitionsInfo}`;
        })
      );
      return `## Available Routes\n\n${renderedRoutes.join("\n\n")}`;
    };

    if (this.cache) {
      this.cache.register("activeRoutes", "static", compute);
    } else {
      const result = await compute();
      if (result) this.parts.push(result);
    }
    return this;
  }

  async addDirectives(directives?: string[]): Promise<this> {
    if (!directives?.length) return this;

    const compute = (): string | null => {
      return `## Directives\n\nAddress concisely:\n\n${directives
        .map((d) => `- ${d}`)
        .join("\n")}`;
    };

    if (this.cache) {
      this.cache.register("directives", "dynamic", compute);
    } else {
      this.parts.push(compute()!);
    }
    return Promise.resolve(this);
  }

  async addAvailableTools(
    tools?: Array<{
      id: string;
      name?: string;
      description?: string;
      parameters?: unknown;
    }>
  ): Promise<this> {
    if (!tools?.length) return this;

    const compute = (): string | null => {
      const renderedTools = tools.map((tool, i) => {
        const toolName = tool.name || tool.id;
        const desc = tool.description
          ? `\n    Description: ${tool.description}`
          : "";
        return `### Tool ${i + 1}: ${toolName}${desc}`;
      });
      return `## Available Tools\n\n${renderedTools.join("\n\n")}`;
    };

    if (this.cache) {
      this.cache.register("availableTools", "dynamic", compute);
    } else {
      this.parts.push(compute()!);
    }
    return Promise.resolve(this);
  }

  async build(): Promise<string> {
    if (this.cache) {
      const sections = await this.cache.resolveAll();
      const prompt = sections
        .filter((s): s is string => s != null && s !== "")
        .join("\n\n")
        .trim();
      return prompt;
    }
    const prompt = this.parts.filter(Boolean).join("\n\n").trim();
    return Promise.resolve(prompt);
  }
}
