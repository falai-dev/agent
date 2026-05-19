import type { Event, Term, Instruction, AgentOptions, ScopedInstructions, AppliedInstruction } from "../types";
import type { Flow } from "./Flow";
import { render, renderMany, formatKnowledgeBase, createTemplateContext } from "../utils/template";
import { TemplateContext } from "../types/template";
import { ConditionEvaluator } from "../utils/condition";
import { PromptSectionCache } from "./PromptSectionCache";
import { logger } from "../utils";

export class PromptComposer<TContext = unknown, TData = unknown> {
  private parts: string[] = [];
  private renderContext: TemplateContext<TContext, TData>;
  private cache: PromptSectionCache | null;
  private instructionCounter = 0;

  /** Per-turn applied instructions, reset on every `addInstructions` invocation. */
  public lastAppliedInstructions: AppliedInstruction[] = [];

  constructor(
    context: TemplateContext<TContext, TData> = createTemplateContext({}),
    cache?: PromptSectionCache
  ) {
    this.renderContext = context;
    this.cache = cache ?? null;
  }

  // Specific, typed sections tailored to the framework

  async addAgentMeta(agent: Pick<AgentOptions<TContext, TData>, 'name'> & Partial<AgentOptions<TContext, TData>>): Promise<this> {
    const compute = async (): Promise<string | null> => {
      const lines: string[] = [];
      lines.push("## Agent Identity");
      lines.push(
        `You are "${agent.name}". Always refer to yourself by this name.`
      );
      if (agent.persona) {
        lines.push(await render(agent.persona, this.renderContext));
      }
      if (agent.goal) {
        lines.push(`Your primary goal: ${agent.goal}`);
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

  async addFlowOverview(flows: Flow<TContext, TData>[]): Promise<this> {
    return this.addActiveFlows(flows);
  }

  async addScoringRules(): Promise<this> {
    const compute = (): string | null => {
      return `## Scoring Rules\n\n${[
        "- 90-100: explicit keywords + clear intent",
        "- 70-89: strong contextual evidence + relevant keywords",
        "- 50-69: moderate relevance",
        "- 30-49: weak connection or ambiguous",
        "- 0-29: minimal/none",
        "Return ONLY JSON matching the provided schema. Include scores for ALL flows.",
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

  async addInstructions(scoped: ScopedInstructions<TContext, TData>): Promise<this> {
    // Reset the per-turn applied set
    this.lastAppliedInstructions = [];

    const evaluator = new ConditionEvaluator(this.renderContext);

    /**
     * Evaluate a single instruction's `if` code predicate(s).
     * Returns true if all predicates pass (AND semantics).
     * If `if` is undefined, returns true (always active).
     */
    const evaluateIf = async (ifCondition: Instruction<TContext, TData>['if']): Promise<boolean> => {
      if (ifCondition === undefined) return true;
      const predicates = Array.isArray(ifCondition) ? ifCondition : [ifCondition];
      for (const predicate of predicates) {
        try {
          const result = await predicate({
            context: (this.renderContext.context ?? {}) as TContext,
            data: (this.renderContext.data || {}),
            session: (this.renderContext.session ?? { id: '', data: {}, history: [], metadata: {} }) as import("../types/session").SessionState<TData>,
            history: this.renderContext.history || [],
          });
          if (!result) return false;
        } catch {
          // If a predicate throws, treat it as false (skip the instruction)
          return false;
        }
      }
      return true;
    };

    /**
     * Evaluate a single instruction's `when` condition.
     * Returns true if the instruction should be active.
     */
    const evaluateWhen = async (when: Instruction<TContext, TData>['when']): Promise<boolean> => {
      if (when === undefined) return true;
      const evaluation = await evaluator.evaluateCondition(when, 'AND');
      if (!evaluation.hasProgrammaticConditions) return true;
      return evaluation.programmaticResult;
    };

    /**
     * Resolve the kind prefix for rendering.
     * Default kind is 'should'.
     */
    const kindPrefix = (kind: Instruction<TContext, TData>['kind']): string => {
      const resolved = kind || 'should';
      return `[${resolved}]`;
    };

    /**
     * Process a scope bucket: filter enabled, evaluate when, collect active lines and applied records.
     */
    const processScope = async (
      items: Instruction<TContext, TData>[],
      caption: string,
      scope: AppliedInstruction['scope'],
      scopeRef?: string
    ): Promise<string[]> => {
      const lines: string[] = [];
      const enabled = items.filter(g => g.enabled !== false);

      for (const g of enabled) {
        // Evaluate `if` first (free, code-only). Skip `when` if `if` fails.
        const ifPassed = await evaluateIf(g.if);
        if (!ifPassed) continue;

        // Evaluate `when` (AI condition) only when `if` passed
        const active = await evaluateWhen(g.when);
        if (!active) continue;

        const text = await render(g.prompt, this.renderContext);
        if (!text) continue;

        lines.push(`- ${kindPrefix(g.kind)} ${caption} ${text}`);
        this.lastAppliedInstructions.push({
          id: g.id || '',
          scope,
          scopeRef,
        });
      }
      return lines;
    };

    // Compute functions for each scope
    const computeGlobal = async (): Promise<string | null> => {
      const lines = await processScope(scoped.global, '[Always]', 'global');
      return lines.length > 0 ? lines.join('\n') : null;
    };

    const computeFlow = async (): Promise<string | null> => {
      if (!scoped.flow) return null;
      const caption = `[In: ${scoped.flow.flowTitle}]`;
      const lines = await processScope(scoped.flow.items, caption, 'flow', scoped.flow.flowTitle);
      return lines.length > 0 ? lines.join('\n') : null;
    };

    const computeStep = async (): Promise<string | null> => {
      if (!scoped.step) return null;
      const caption = `[Step: ${scoped.step.stepId}]`;
      const lines = await processScope(scoped.step.items, caption, 'step', scoped.step.stepId);
      return lines.length > 0 ? lines.join('\n') : null;
    };

    if (this.cache) {
      // Granular three-key approach with header coordination
      // Register header first so it appears before content in resolveAll() output
      this.cache.register('instructionsHeader', 'static', async () => {
        const globalResult = await this.cache!.get('instructionsGlobal');
        const flowResult = scoped.flow ? await this.cache!.get('instructionsFlow') : null;
        const stepResult = scoped.step ? await this.cache!.get('instructionsStep') : null;
        if (globalResult || flowResult || stepResult) {
          return '## Instructions';
        }
        return null;
      });

      this.cache.register('instructionsGlobal', 'static', computeGlobal);

      if (scoped.flow) {
        this.cache.register('instructionsFlow', 'static', computeFlow);
      }

      if (scoped.step) {
        this.cache.register('instructionsStep', 'dynamic', computeStep);
      }
    } else {
      // No cache: compute inline and push to parts
      const globalLines = await computeGlobal();
      const flowLines = await computeFlow();
      const stepLines = await computeStep();

      const allLines = [globalLines, flowLines, stepLines].filter(Boolean).join('\n');
      if (allLines) {
        this.parts.push(`## Instructions\n\n${allLines}`);
      }
    }

    // Debug logging
    if (this.lastAppliedInstructions.length > 0) {
      const globalIds = this.lastAppliedInstructions
        .filter(g => g.scope === 'global')
        .map(g => g.id);
      const flowGroup = this.lastAppliedInstructions.filter(g => g.scope === 'flow');
      const stepGroup = this.lastAppliedInstructions.filter(g => g.scope === 'step');

      const debugPayload: Record<string, unknown> = { global: globalIds };
      if (flowGroup.length > 0) {
        debugPayload.flow = { flowTitle: scoped.flow?.flowTitle, ids: flowGroup.map(g => g.id) };
      }
      if (stepGroup.length > 0) {
        debugPayload.step = { stepId: scoped.step?.stepId, ids: stepGroup.map(g => g.id) };
      }

      logger.debug('[instructions] applied', debugPayload);
    }

    return this;
  }

  async addKnowledgeBase(
    agentKnowledgeBase?: Record<string, unknown>,
    flowKnowledgeBase?: Record<string, unknown>
  ): Promise<this> {
    const compute = (): string | null => {
      // Merge agent and flow knowledge bases (flow takes precedence for conflicts)
      const mergedKnowledge = {
        ...(agentKnowledgeBase || {}),
        ...(flowKnowledgeBase || {}),
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

  addActiveFlows(flows: Flow<TContext, TData>[]): Promise<this> {
    if (!flows.length) return Promise.resolve(this);

    const compute = (): string | null => {
      const renderedFlows = flows.map((r, i) => {
        // v2: `when` is string | string[] (AI-evaluated). Extract directly.
        const whenContextStrings: string[] = r.when
          ? (Array.isArray(r.when) ? r.when : [r.when])
          : [];
        const conditions =
          whenContextStrings.length > 0
            ? `\n\n  **Triggered when:** ${whenContextStrings.join(" OR ")}`
            : "";
        const desc = r.description
          ? `\n\n  **Description:** ${r.description}`
          : "";
        return `### Flow ${i + 1}: ${r.title} (ID: ${r.id})${desc}${conditions}`;
      });
      return `## Available Flows\n\n${renderedFlows.join("\n\n")}`;
    };

    if (this.cache) {
      this.cache.register("activeFlows", "static", compute);
    } else {
      const result = compute();
      if (result) this.parts.push(result);
    }
    return Promise.resolve(this);
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

  /**
   * Build the final prompt string.
   *
   * @param options.transientAppendage - Per-turn sentences from merged
   *   PreDirective.appendPrompt arrays (outer-to-inner: agent.onEnter →
   *   flow.onEnter → step.onEnter → step.prepare). Appended after all
   *   other sections. Fresh every turn, never cached, never persisted.
   *   **Validates: Requirements 2.2, 2.8, 2.11, 27.1, 27.2, 27.4**
   */
  async build(options?: { transientAppendage?: string[] }): Promise<string> {
    let sections: string[];

    if (this.cache) {
      const resolved = await this.cache.resolveAll();
      sections = resolved.filter((s): s is string => s != null && s !== "");
    } else {
      sections = this.parts.filter(Boolean);
    }

    // Append transient per-turn sentences (from PreDirective.appendPrompt).
    // These are never cached — they are a fresh slot built per turn.
    if (options?.transientAppendage && options.transientAppendage.length > 0) {
      const appendageBlock = options.transientAppendage.join("\n");
      sections.push(appendageBlock);
    }

    return sections.join("\n\n").trim();
  }
}
