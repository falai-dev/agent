import type { Event } from "../types/history";
import type { Term, Guideline, Capability } from "../types/agent";
import type { Route } from "./Route";
import { renderTemplate, renderTemplateArray } from "../utils/template";

export class PromptComposer<TContext = unknown> {
  private parts: string[] = [];
  private context?: Record<string, unknown>;

  constructor(context?: Record<string, unknown>) {
    this.context = context;
  }

  // Specific, typed sections tailored to the framework

  addAgentMeta(agent: {
    name: string;
    goal?: string;
    description?: string;
    identity?: string;
  }): this {
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
      lines.push(`**Identity:** ${agent.identity}`);
    }
    this.parts.push(lines.join("\n"));
    return this;
  }

  addPersonality(personality?: string): this {
    if (personality && personality.trim().length) {
      this.parts.push(`## Personality\n\n${personality.trim()}`);
    }
    return this;
  }

  addIdentity(identity?: string): this {
    if (identity && identity.trim().length) {
      this.parts.push(
        `## Identity\n\n${renderTemplate(identity.trim(), this.context)}`
      );
    }
    return this;
  }

  addRoutingOverview(routes: Route<TContext>[]): this {
    return this.addActiveRoutes(routes);
  }

  addScoringRules(): this {
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
    return this;
  }

  addInstruction(text: string): this {
    if (text) this.parts.push(`## Instruction\n\n${text}`);
    return this;
  }

  addInteractionHistory(history: Event[], note?: string): this {
    const recent = history
      .slice(-10)
      .map((e) => `- ${JSON.stringify(e)}`)
      .join("\n");
    const header = note ? `${note}\n\n` : "";
    this.parts.push(
      `## Interaction History\n\n${header}Recent conversation events:\n\n${recent}`
    );
    return this;
  }

  addLastMessage(message: string): this {
    this.parts.push(`## Last Message\n\n${message}`);
    return this;
  }

  addGlossary(terms: Term[]): this {
    if (!terms.length) return this;
    const text = terms
      .map(
        (t, _i) =>
          `- **${t.name}**${
            t.synonyms?.length ? ` (synonyms: ${t.synonyms.join(", ")})` : ""
          }: ${t.description}`
      )
      .join("\n");
    this.parts.push(`## Glossary\n\n${text}`);
    return this;
  }

  addGuidelines(guidelines: Guideline[]): this {
    const enabled = guidelines.filter((g) => g.enabled !== false);
    if (!enabled.length) return this;
    const text = enabled
      .map((g, i) => {
        const cond = g.condition
          ? `When ${renderTemplate(
              g.condition,
              this.context
            )}, then ${renderTemplate(g.action, this.context)}`
          : renderTemplate(g.action, this.context);
        return `- Guideline #${i + 1}: ${cond}`;
      })
      .join("\n");
    this.parts.push(`## Guidelines\n\n${text}`);
    return this;
  }

  addCapabilities(capabilities: Capability[]): this {
    if (!capabilities.length) return this;
    const text = capabilities
      .map((c, i) => `### Capability ${i + 1}: ${c.title}\n\n${c.description}`)
      .join("\n\n");
    this.parts.push(`## Capabilities\n\n${text}`);
    return this;
  }

  addActiveRoutes(routes: Route<TContext>[]): this {
    if (!routes.length) return this;
    const text = routes
      .map((r, i) => {
        const conditions = r.conditions.length
          ? `\n\n  **Triggered when:** ${renderTemplateArray(
              r.conditions,
              this.context
            ).join(" OR ")}`
          : "";
        const desc = r.description
          ? `\n\n  **Description:** ${r.description}`
          : "";
        const rules = r.getRules();
        const prohibitions = r.getProhibitions();
        const rulesInfo = rules.length
          ? `\n\n  **Rules:**\n  ${rules
              .map((x, _idx) => `  - ${x}`)
              .join("\n  ")}`
          : "";
        const prohibitionsInfo = prohibitions.length
          ? `\n\n  **Prohibitions:**\n  ${prohibitions
              .map((x, _idx) => `  - ${x}`)
              .join("\n  ")}`
          : "";
        return `### Route ${i + 1}: ${
          r.title
        }${desc}${conditions}${rulesInfo}${prohibitionsInfo}`;
      })
      .join("\n\n");
    this.parts.push(`## Available Routes\n\n${text}`);
    return this;
  }

  addDirectives(directives?: string[]): this {
    if (!directives?.length) return this;
    this.parts.push(
      `## Directives\n\nAddress concisely:\n\n${directives
        .map((d) => `- ${d}`)
        .join("\n")}`
    );
    return this;
  }

  build(): string {
    return this.parts.filter(Boolean).join("\n\n").trim();
  }
}
