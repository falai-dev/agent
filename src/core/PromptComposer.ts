import type { Event, Term, Guideline, AgentOptions } from "../types";
import type { Route } from "./Route";
import { render, renderMany, formatKnowledgeBase } from "../utils/template";
import { TemplateContext } from "../types/template";

export class PromptComposer<TContext = unknown, TData = unknown> {
  private parts: string[] = [];
  private renderContext: TemplateContext<TContext, TData>;

  constructor(context: TemplateContext<TContext, TData> = {}) {
    this.renderContext = context;
  }

  // Specific, typed sections tailored to the framework

  async addAgentMeta(agent: AgentOptions<TContext>): Promise<this> {
    const lines: string[] = [];
    lines.push("## Agent");
    lines.push(`**Name:** ${agent.name}`);
    if (agent.goal) {
      lines.push(`**Goal:** ${agent.goal}`);
    }
    if (agent.description) {
      lines.push(`**Description:** ${agent.description}`);
    }
    if (agent.identity) {
      lines.push(
        `**Identity:** ${await render(agent.identity, this.renderContext)}`
      );
    }
    if (agent.personality) {
      lines.push(
        `**Personality:** ${await render(
          agent.personality,
          this.renderContext
        )}`
      );
    }
    this.parts.push(lines.join("\n"));
    return this;
  }

  async addRoutingOverview(routes: Route<TContext, TData>[]): Promise<this> {
    return this.addActiveRoutes(routes);
  }

  async addScoringRules(): Promise<this> {
    this.parts.push(
      `## Scoring Rules\n\n${[
        "- 90-100: explicit keywords + clear intent",
        "- 70-89: strong contextual evidence + relevant keywords",
        "- 50-69: moderate relevance",
        "- 30-49: weak connection or ambiguous",
        "- 0-29: minimal/none",
        "Return ONLY JSON matching the provided schema. Include scores for ALL routes.",
      ].join("\n")}`
    );
    return Promise.resolve(this);
  }

  async addInstruction(text: string): Promise<this> {
    if (text) this.parts.push(`## Instruction\n\n${text}`);
    return Promise.resolve(this);
  }

  async addInteractionHistory(history: Event[], note?: string): Promise<this> {
    const recent = history
      .slice(-10)
      .map((e) => `- ${JSON.stringify(e)}`)
      .join("\n");
    const header = note ? `${note}\n\n` : "";
    this.parts.push(
      `## Interaction History\n\n${header}Recent conversation events:\n\n${recent}`
    );
    return Promise.resolve(this);
  }

  async addLastMessage(message: string): Promise<this> {
    this.parts.push(`## Last Message\n\n${message}`);
    return Promise.resolve(this);
  }

  async addGlossary(terms: Term<TContext>[]): Promise<this> {
    if (!terms.length) return this;

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

    this.parts.push(`## Glossary\n\n${renderedTerms.join("\n")}`);
    return this;
  }

  async addGuidelines(guidelines: Guideline<TContext>[]): Promise<this> {
    const enabled = guidelines.filter((g) => g.enabled !== false);
    if (!enabled.length) return this;

    const renderedGuidelines = await Promise.all(
      enabled.map(async (g, i) => {
        const action = await render(g.action, this.renderContext);
        if (g.condition) {
          const condition = await render(g.condition, this.renderContext);
          return `- Guideline #${i + 1}: When ${condition}, then ${action}`;
        }
        return `- Guideline #${i + 1}: ${action}`;
      })
    );

    this.parts.push(`## Guidelines\n\n${renderedGuidelines.join("\n")}`);
    return this;
  }

  async addKnowledgeBase(
    agentKnowledgeBase?: Record<string, unknown>,
    routeKnowledgeBase?: Record<string, unknown>
  ): Promise<this> {
    // Merge agent and route knowledge bases (route takes precedence for conflicts)
    const mergedKnowledge = {
      ...(agentKnowledgeBase || {}),
      ...(routeKnowledgeBase || {}),
    };

    // Only add section if there's knowledge data
    if (Object.keys(mergedKnowledge).length > 0) {
      const formatted = formatKnowledgeBase(mergedKnowledge, "Knowledge Base");
      this.parts.push(formatted);
    }

    return Promise.resolve(this);
  }

  async addActiveRoutes(routes: Route<TContext, TData>[]): Promise<this> {
    if (!routes.length) return this;

    const renderedRoutes = await Promise.all(
      routes.map(async (r, i) => {
        const conditions =
          r.conditions.length > 0
            ? `\n\n  **Triggered when:** ${(
                await renderMany(r.conditions, this.renderContext)
              ).join(" OR ")}`
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
        return `### Route ${i + 1}: ${
          r.title
        }${desc}${conditions}${rulesInfo}${prohibitionsInfo}`;
      })
    );

    this.parts.push(`## Available Routes\n\n${renderedRoutes.join("\n\n")}`);
    return this;
  }

  async addDirectives(directives?: string[]): Promise<this> {
    if (!directives?.length) return this;
    this.parts.push(
      `## Directives\n\nAddress concisely:\n\n${directives
        .map((d) => `- ${d}`)
        .join("\n")}`
    );
    return Promise.resolve(this);
  }

  async build(): Promise<string> {
    const prompt = this.parts.filter(Boolean).join("\n\n").trim();
    return Promise.resolve(prompt);
  }
}
