import type { Event } from "../types/history";
import type { Term, Guideline, Capability } from "../types/agent";
import type { Route } from "./Route";

export class PromptComposer<TContext = unknown> {
  private parts: string[] = [];

  // Specific, typed sections tailored to the framework

  addAgentMeta(agent: {
    name: string;
    goal?: string;
    description?: string;
    identity?: string;
  }): this {
    const lines: string[] = [];
    lines.push(`Agent: ${agent.name}`);
    if (agent.goal) lines.push(`Goal: ${agent.goal}`);
    if (agent.description) lines.push(`Description: ${agent.description}`);
    if (agent.identity) lines.push(`Identity: ${agent.identity}`);
    this.parts.push(lines.join("\n"));
    return this;
  }

  addPersonality(personality?: string): this {
    if (personality && personality.trim().length) {
      this.parts.push(`Personality: ${personality.trim()}`);
    }
    return this;
  }

  addIdentity(identity?: string): this {
    if (identity && identity.trim().length) {
      this.parts.push(`Identity: ${identity.trim()}`);
    }
    return this;
  }

  addRoutingOverview(routes: Route<TContext>[]): this {
    return this.addActiveRoutes(routes);
  }

  addScoringRules(): this {
    this.parts.push(
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
    return this;
  }

  addInstruction(text: string): this {
    if (text) this.parts.push(text);
    return this;
  }

  addInteractionHistory(history: Event[], note?: string): this {
    const recent = history
      .slice(-10)
      .map((e) => JSON.stringify(e))
      .join("\n");
    const header = note ? `${note}\n` : "";
    this.parts.push(`${header}Recent conversation events:\n${recent}`);
    return this;
  }

  addLastMessage(message: string): this {
    this.parts.push(`Last user message:\n${message}`);
    return this;
  }

  addGlossary(terms: Term[]): this {
    if (!terms.length) return this;
    const text = terms
      .map(
        (t, i) =>
          `${i + 1}) ${t.name}${
            t.synonyms?.length ? ` (synonyms: ${t.synonyms.join(", ")})` : ""
          }: ${t.description}`
      )
      .join("\n");
    this.parts.push(`Glossary:\n${text}`);
    return this;
  }

  addGuidelines(guidelines: Guideline[]): this {
    const enabled = guidelines.filter((g) => g.enabled !== false);
    if (!enabled.length) return this;
    const text = enabled
      .map((g, i) => {
        const cond = g.condition
          ? `When ${g.condition}, then ${g.action}`
          : g.action;
        return `Guideline #${i + 1}) ${cond}`;
      })
      .join("\n");
    this.parts.push(`Guidelines:\n${text}`);
    return this;
  }

  addCapabilities(capabilities: Capability[]): this {
    if (!capabilities.length) return this;
    const text = capabilities
      .map((c, i) => `Capability ${i + 1}: ${c.title}\n${c.description}`)
      .join("\n\n");
    this.parts.push(`Capabilities:\n${text}`);
    return this;
  }

  addActiveRoutes(routes: Route<TContext>[]): this {
    if (!routes.length) return this;
    const text = routes
      .map((r, i) => {
        const conditions = r.conditions.length
          ? `\n  Triggered when: ${r.conditions.join(" OR ")}`
          : "";
        const desc = r.description ? `\n  ${r.description}` : "";
        const rules = r.getRules();
        const prohibitions = r.getProhibitions();
        const rulesInfo = rules.length
          ? `\n  RULES: ${rules.map((x, idx) => `${idx + 1}. ${x}`).join("; ")}`
          : "";
        const prohibitionsInfo = prohibitions.length
          ? `\n  PROHIBITIONS: ${prohibitions
              .map((x, idx) => `${idx + 1}. ${x}`)
              .join("; ")}`
          : "";
        return `${i + 1}) ${
          r.title
        }${desc}${conditions}${rulesInfo}${prohibitionsInfo}`;
      })
      .join("\n\n");
    this.parts.push(`Available routes:\n${text}`);
    return this;
  }

  addDirectives(directives?: string[]): this {
    if (!directives?.length) return this;
    this.parts.push(`Address concisely:\n- ${directives.join("\n- ")}`);
    return this;
  }

  build(): string {
    return this.parts.filter(Boolean).join("\n\n").trim();
  }
}
