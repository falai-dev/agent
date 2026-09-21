/**
 * Prompt sections shared by the understand and speak calls.
 *
 * Each function returns one markdown section or `null` when there is nothing
 * to say; `joinSections` drops the nulls. Templates are rendered against the
 * turn's scope. Instruction `if` predicates are judged by the caller (they
 * need the runtime); only `when` reaches the prompt, as text for the model.
 */

import type { AgentOptions } from "../types/agent.js";
import type { FieldDef, Instruction } from "../types/flow.js";
import { isKnown } from "../utils/schema.js";
import { render, type TemplateScope } from "../utils/template.js";

export function joinSections(...parts: Array<string | null | undefined>): string {
  return parts.filter((p): p is string => typeof p === "string" && p.trim() !== "").join("\n\n").trim();
}

/** Who the agent is: name, persona, goal. */
export function identitySection(
  options: Pick<AgentOptions, "name" | "persona" | "goal">,
  scope: TemplateScope,
): string {
  const lines = ["## Identity", `You are "${options.name}". Always refer to yourself by this name.`];
  if (options.persona) lines.push(render(options.persona, scope));
  if (options.goal) lines.push(`Your goal: ${render(options.goal, scope)}`);
  return lines.join("\n");
}

/**
 * Split the prompt's opening into the half that repeats every turn and the
 * half that does not.
 *
 * The stable half goes out as a system message so a provider can cache it: on
 * Anthropic that block is the one thing carrying a `cache_control` marker, and
 * a cache read is a tenth the price of the tokens it replaces. Sent as part of
 * the trailing user turn — which is where the whole prompt used to go — it sat
 * behind text that changes every turn, so nothing was ever cached and both
 * calls of every turn re-billed the identity and the knowledge base in full.
 *
 * The line is drawn at "does this text interpolate", not at "is this identity".
 * `persona` and `goal` render through the turn's scope, so a persona that
 * mentions a collected field changes the moment that field lands: cached, it
 * would pay the write every turn and never read. Those go back inline.
 */
export function stablePrefix(
  options: Pick<AgentOptions, "name" | "persona" | "goal" | "knowledgeBase">,
  scope: TemplateScope,
): { system: string | null; inline: string | null } {
  const identity = identitySection(options, scope);
  const knowledge = knowledgeSection(options.knowledgeBase);
  const varies = isTemplated(options.persona) || isTemplated(options.goal);
  if (varies) return { system: knowledge, inline: identity };
  return { system: joinSections(identity, knowledge) || null, inline: null };
}

function isTemplated(text: string | undefined): boolean {
  return typeof text === "string" && text.includes("{{");
}

/** Any JSON the agent should know, as nested bullets. */
export function knowledgeSection(knowledge: Record<string, unknown> | undefined): string | null {
  if (!knowledge || Object.keys(knowledge).length === 0) return null;
  return ["## Knowledge base", ...formatObject(knowledge, 0)].join("\n");
}

function formatObject(value: Record<string, unknown>, depth: number): string[] {
  const pad = "  ".repeat(depth);
  const lines: string[] = [];
  for (const [key, item] of Object.entries(value)) {
    if (item !== null && typeof item === "object" && !Array.isArray(item)) {
      lines.push(`${pad}- ${key}:`);
      lines.push(...formatObject(item as Record<string, unknown>, depth + 1));
    } else if (Array.isArray(item) && item.some((i) => i !== null && typeof i === "object")) {
      lines.push(`${pad}- ${key}:`);
      for (const i of item) {
        lines.push(
          ...(i !== null && typeof i === "object"
            ? formatObject(i as Record<string, unknown>, depth + 1)
            : [`${pad}  - ${scalar(i)}`]),
        );
      }
    } else {
      lines.push(`${pad}- ${key}: ${Array.isArray(item) ? item.map(scalar).join(", ") : scalar(item)}`);
    }
  }
  return lines;
}

function scalar(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

export interface InstructionGroup<C = unknown, D = unknown> {
  /** `[Always]`, `[In: Triagem]`, `[Step: quem]`. */
  caption: string;
  /** Already filtered by their `if`. */
  items: Instruction<C, D>[];
}

/** Behavioural statements with their kind and AI-judged `when`. */
export function instructionsSection<C, D>(groups: InstructionGroup<C, D>[], scope: TemplateScope): string | null {
  const lines: string[] = [];
  for (const group of groups) {
    for (const item of group.items) {
      const text = render(item.prompt, scope).trim();
      if (!text) continue;
      const when = item.when === undefined ? [] : Array.isArray(item.when) ? item.when : [item.when];
      const condition = when.length ? ` (apply only when: ${when.join(" OR ")})` : "";
      lines.push(`- [${item.kind ?? "should"}] ${group.caption} ${text}${condition}`);
    }
  }
  return lines.length ? ["## Instructions", ...lines].join("\n") : null;
}

/** Collected fields the model must treat as settled. */
export function factsSection(fields: Record<string, FieldDef>, data: Record<string, unknown>): string | null {
  const known = Object.keys(fields).filter((slug) => isKnown(data[slug]));
  if (known.length === 0) return null;
  return [
    "## Already known",
    "These are settled. Never ask for them again; acknowledge and move on.",
    ...known.map((slug) => `- ${slug}: ${JSON.stringify(data[slug])}`),
  ].join("\n");
}

/** One line describing a field for the model: slug, type, options, description. */
export function describeField(slug: string, def: FieldDef): string {
  const options = def.enum ? ` [${def.enum.map(String).join(" | ")}]` : "";
  const description = def.description ? `: ${def.description}` : "";
  return `${slug} (${def.type})${options}${description}`;
}

/**
 * The fields a talk step still needs, each with how to ask for it. `asks`
 * holds the step's own wording; the field's `ask` is the fallback.
 */
export function pendingSection(
  pending: string[],
  fields: Record<string, FieldDef>,
  asks: Partial<Record<string, string>>,
  scope: TemplateScope,
): string | null {
  if (pending.length === 0) return null;
  const lines = pending.map((slug) => {
    const def = fields[slug];
    if (!def) return `- ${slug}`;
    const ask = asks[slug] ?? def.ask;
    return `- ${describeField(slug, def)}${ask ? `\n  How to ask: ${render(ask, scope)}` : ""}`;
  });
  return [
    "## Still to collect",
    "Ask for these, in this order, at the pace the step prompt sets. When the customer's message already answers one, take the value and do not ask again.",
    ...lines,
  ].join("\n");
}
