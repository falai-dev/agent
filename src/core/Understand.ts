/**
 * Understand: the one call that judges the lead's message (design §4.3).
 *
 * Runner decides who is eligible and what is pending; this module turns that
 * into one prompt, one envelope schema and at most one provider call, then
 * hands back raw values keyed by their real ids. It never writes session
 * data: Runner validates, coerces and applies.
 *
 * Zero calls when there is nothing to judge: no candidate flow, or only the
 * floor's own, and no mention, branch or field. A lone eligible message flow
 * starts unscored only when no catch-all passes and `idle` is `'silent'`;
 * Runner decides that and sends no request. Otherwise this call scores it.
 *
 * The envelope is built for two kinds of provider at once. Gemini enforces
 * the schema, so every section is a closed object with every property
 * required and nullable. GLM follows it by prompt only, so the prompt
 * restates the shape with a skeleton and the parser tolerates missing keys,
 * wrong scalar types and stray text around the JSON.
 */

import type { AgentOptions } from "../types/agent.js";
import type { GenerateMessageOutput, TokenUsage } from "../types/ai.js";
import type { FieldDef, FieldDefs, Flow, ParamDef, ParamDefs } from "../types/flow.js";
import type { StructuredSchema } from "../types/schema.js";
import { extractEmbeddedJSONObject, isRecord } from "../utils/json.js";
import { logger } from "../utils/logger.js";
import { splitPhrases } from "../utils/phrases.js";
import { coerceField, isKnown, pendingFields, toWireSchema } from "../utils/schema.js";
import { render, type TemplateScope } from "../utils/template.js";
import { readUsage } from "../utils/usage.js";
import type { UnderstandRequest, Understanding } from "./contracts.js";
import { describeField, factsSection, joinSections, stablePrefix } from "./Prompt.js";

export const UNDERSTAND_SCHEMA_NAME = "understand";

const SECTIONS = ["flows", "mentions", "extract", "branches", "fields"] as const;

/** Gemini rejects any other character in a property name. */
const SAFE_KEY = /^[a-zA-Z0-9_-]+$/;

export class Understand<C = unknown, D = unknown> {
  constructor(private readonly options: AgentOptions<C, D>) {}

  async run(req: UnderstandRequest<C, D>): Promise<Understanding> {
    const candidates = candidateFlows(req);
    const onlyRouting =
      req.mentionFlows.length === 0 && req.branches.length === 0 && Object.keys(req.fields).length === 0;
    // Nothing to compare or extract: no candidates, or only the floor's own flow. A lone
    // candidate with nobody on the floor is here because the runner wants it scored.
    if (onlyRouting && candidates.length <= (req.floor ? 1 : 0)) return empty(0);

    const aliases = new Aliases();
    const jsonSchema = buildEnvelope(req, candidates, aliases);
    const { system, turn: prompt } = this.buildPrompt(req, candidates, aliases, jsonSchema);

    // Provider failures propagate: in this phase the turn throws and the host retries the input.
    const out = await this.options.provider.generateMessage<C, unknown>({
      prompt,
      ...(system ? { system } : {}),
      history: req.history,
      context: req.context,
      parameters: { jsonSchema, schemaName: UNDERSTAND_SCHEMA_NAME },
    });

    const reply = usable(out.structured) ? out.structured : extractEmbeddedJSONObject(out.message);
    if (!usable(reply)) {
      logger.warn(
        `[Understand] The reply had no usable structure, so nothing was judged this turn. ` +
          `Reply started with: ${out.message.slice(0, 200)}`,
      );
      return empty(1, readUsage(out.metadata));
    }
    return { ...parseReply(reply, aliases), ...usageOf(out.metadata) };
  }

  private buildPrompt(
    req: UnderstandRequest<C, D>,
    candidates: Flow<C, D>[],
    aliases: Aliases,
    schema: StructuredSchema,
  ): { system: string | null; turn: string } {
    const scope: TemplateScope = { data: req.data, context: req.context };
    const t = (text: string): string => render(text, scope);
    const data = isRecord(req.data) ? req.data : {};
    const { system, inline } = stablePrefix(this.options, scope);
    return {
      system,
      turn: joinSections(
      inline,
      taskSection(),
      floorSection(req, this.options.fields, data, t),
      factsSection(this.options.fields, data),
      flowsSection(candidates, aliases, t),
      mentionsSection(req.mentionFlows, aliases, t),
      branchesSection(req.branches, aliases, t),
      fieldsSection(req.fields, aliases),
      messageSection(req.text),
      outputSection(schema),
      ),
    };
  }
}

// ── Candidates and keys ─────────────────────────────────────────────────

/** The floor's flow first, then the eligible message flows, each id once. */
function candidateFlows<C, D>(req: UnderstandRequest<C, D>): Flow<C, D>[] {
  const seen = new Map<string, Flow<C, D>>();
  for (const flow of [...(req.floor ? [req.floor.flow] : []), ...req.messageFlows]) {
    if (!seen.has(flow.id)) seen.set(flow.id, flow);
  }
  return [...seen.values()];
}

/**
 * Envelope property names for ids the schema cannot carry. A safe id keeps
 * its own name; anything else (run ids carry `#`, `:` and `/`) gets a short
 * alias, mapped back when the reply is parsed.
 */
class Aliases {
  private readonly byReal = new Map<string, string>();
  private readonly byAlias = new Map<string, string>();
  private n = 0;

  of(real: string, prefix = "k"): string {
    const seen = this.byReal.get(real);
    if (seen) return seen;
    const alias = SAFE_KEY.test(real) && !this.byAlias.has(real) ? real : this.fresh(prefix);
    this.byAlias.set(alias, real);
    this.byReal.set(real, alias);
    return alias;
  }

  /** Unknown aliases come back as they are; Runner drops keys it does not know. */
  real(alias: string): string {
    return this.byAlias.get(alias) ?? alias;
  }

  private fresh(prefix: string): string {
    let alias: string;
    do alias = `${prefix}${++this.n}`;
    while (this.byAlias.has(alias));
    return alias;
  }
}

function branchKey(branch: { runId: string; stepId: string; index: number }): string {
  return `${branch.runId}/${branch.stepId}/${branch.index}`;
}

// ── Envelope ────────────────────────────────────────────────────────────

function buildEnvelope<C, D>(req: UnderstandRequest<C, D>, candidates: Flow<C, D>[], aliases: Aliases): StructuredSchema {
  const properties: Record<string, StructuredSchema> = {};

  if (candidates.length) {
    properties.flows = toWireSchema(
      keyed(candidates.map((f) => aliases.of(f.id, "f")), { type: "integer", description: "0-100 fit of the message to this flow" }),
      { nullable: true },
    );
  }
  if (req.mentionFlows.length) {
    properties.mentions = toWireSchema(
      keyed(req.mentionFlows.map((f) => aliases.of(f.id, "f")), { type: "boolean", description: "The customer brought this up" }),
      { nullable: true },
    );
    const extract: Record<string, StructuredSchema> = {};
    for (const flow of req.mentionFlows) {
      const defs = extractDefs(flow);
      if (defs) extract[aliases.of(flow.id, "f")] = toWireSchema(defs, { nullable: true });
    }
    if (Object.keys(extract).length) {
      properties.extract = { type: "object", properties: extract, required: Object.keys(extract), additionalProperties: false };
    }
  }
  if (req.branches.length) {
    properties.branches = toWireSchema(
      keyed(req.branches.map((b) => aliases.of(branchKey(b), "q")), { type: "boolean", description: "The answer to this question" }),
      { nullable: true },
    );
  }
  if (Object.keys(req.fields).length) {
    const defs: FieldDefs = {};
    for (const [slug, def] of Object.entries(req.fields)) defs[aliases.of(slug, "d")] = def;
    properties.fields = toWireSchema(defs, { nullable: true });
  }

  return { type: "object", properties, required: Object.keys(properties), additionalProperties: false };
}

function keyed(keys: string[], def: FieldDef): FieldDefs {
  return Object.fromEntries(keys.map((key) => [key, def]));
}

/** The mention trigger's `extract` definitions, when the flow has any. */
function extractDefs<C, D>(flow: Flow<C, D>): ParamDefs | undefined {
  for (const trigger of flow.on ?? []) {
    if ("mention" in trigger && trigger.extract && Object.keys(trigger.extract).length) return trigger.extract;
  }
  return undefined;
}

// ── Prompt sections ─────────────────────────────────────────────────────

function taskSection(): string {
  return [
    "## Task",
    "Judge the customer's latest message, quoted below, against the conversation so far. " +
      "Only the customer's own words count as evidence: never treat the assistant's questions or guesses as something the customer said. " +
      'Answer with one JSON object in the shape given under "Output".',
  ].join("\n");
}

function floorSection<C, D>(
  req: UnderstandRequest<C, D>,
  fields: FieldDefs,
  data: Record<string, unknown>,
  t: (text: string) => string,
): string | null {
  if (!req.floor) return null;
  const { run, flow } = req.floor;
  const lines = [
    "## Current flow",
    `The customer is mid-conversation in "${flow.name}" (${flow.id})${flow.description ? `: ${t(flow.description)}` : "."}`,
  ];
  const step = flow.steps.find((s) => s.id === run.stepId);
  if (step && ("collect" in step || "prompt" in step)) {
    lines.push(`Current step: ${step.id}${step.prompt ? ` — ${t(step.prompt)}` : ""}`);
    const pending = pendingFields(step, data, run.asked);
    if (pending.length) {
      lines.push("This step is waiting for:");
      lines.push(...pending.map((slug) => `- ${fields[slug] ? describeField(slug, fields[slug]) : slug}`));
    }
  }
  lines.push("The customer may continue here or switch to something else. Score the current flow below like any other.");
  return lines.join("\n");
}

function flowsSection<C, D>(candidates: Flow<C, D>[], aliases: Aliases, t: (text: string) => string): string | null {
  if (candidates.length === 0) return null;
  const lines = [
    "## Flows the customer may want",
    "Score every flow from 0 to 100 by how well the message fits it. Score all of them, the current flow included.",
  ];
  candidates.forEach((flow, i) => {
    lines.push(`${i + 1}. ${aliases.of(flow.id, "f")} — ${flow.name}${flow.description ? `: ${t(flow.description)}` : ""}`);
    const { counts, excludes } = splitPhrases(triggerPhrases(flow, "message"));
    if (counts.length) lines.push(`   The customer: ${counts.map(t).join("; ")}`);
    if (excludes.length) lines.push(`   Score 0 when: ${excludes.map(t).join("; ")}`);
  });
  lines.push(
    "",
    "Scoring rules:",
    "- 90-100: explicit keywords + clear intent",
    "- 70-89: strong contextual evidence + relevant keywords",
    "- 50-69: moderate relevance",
    "- 30-49: weak connection or ambiguous",
    "- 0-29: minimal/none",
  );
  return lines.join("\n");
}

function mentionsSection<C, D>(flows: Flow<C, D>[], aliases: Aliases, t: (text: string) => string): string | null {
  if (flows.length === 0) return null;
  const lines = [
    "## Things the customer may mention",
    "For each item, answer true when the customer's message clearly brings it up, false otherwise. " +
      "Be conservative: true needs clear, explicit evidence in the message. The phrases under an item are alternatives; one match is enough. " +
      "A 'Does not count when' line overrides a match: if one of those fits, answer false.",
  ];
  for (const flow of flows) {
    lines.push(`- ${aliases.of(flow.id, "f")} — ${flow.name}${flow.description ? `: ${t(flow.description)}` : ""}`);
    const { counts, excludes } = splitPhrases(triggerPhrases(flow, "mention"));
    if (counts.length) lines.push(`  Counts when: ${counts.map(t).join("; ")}`);
    if (excludes.length) lines.push(`  Does not count when: ${excludes.map(t).join("; ")}`);
    const defs = extractDefs(flow);
    if (defs) {
      lines.push("  When true, also extract:");
      lines.push(...Object.entries(defs).map(([name, def]) => `  - ${describeParam(name, def)}`));
    }
  }
  return lines.join("\n");
}

function branchesSection(
  branches: UnderstandRequest["branches"],
  aliases: Aliases,
  t: (text: string) => string,
): string | null {
  if (branches.length === 0) return null;
  return [
    "## Questions about this message",
    "Answer each question with true or false, judging the customer's message in the context of the conversation.",
    ...branches.map((b) => `- ${aliases.of(branchKey(b), "q")}: ${t(b.when)}`),
  ].join("\n");
}

function fieldsSection(fields: Record<string, FieldDef>, aliases: Aliases): string | null {
  const entries = Object.entries(fields);
  if (entries.length === 0) return null;
  return [
    "## Details the customer may have given",
    "Report a value only when the customer actually gave it in this message. " +
      "Never guess and never infer it from the assistant's words. Use null when the customer did not give it.",
    ...entries.map(([slug, def]) => `- ${describeField(aliases.of(slug, "d"), def)}`),
  ].join("\n");
}

function messageSection(text: string): string {
  return ["## Customer's latest message", '"""', text, '"""'].join("\n");
}

type Section = (typeof SECTIONS)[number];

const OUTPUT_LINES: Record<Section, string> = {
  flows: "- flows: one integer from 0 to 100 per flow id listed above",
  mentions: "- mentions: true or false per item id",
  extract: "- extract: per item id, an object with the values pulled from the message; null values when the item was not brought up",
  branches: "- branches: true or false per question id",
  fields: "- fields: one value per detail, null when the customer did not give it",
};

/**
 * What the skeleton shows in each section: a score of 0, a "no" answer, and
 * null for anything extracted, so a prompt-only model never reads a
 * placeholder as a default value.
 */
const PLACEHOLDER: Record<Section, unknown> = { flows: 0, mentions: false, extract: null, branches: false, fields: null };

function outputSection(schema: StructuredSchema): string {
  const present = SECTIONS.filter((s) => schema.properties?.[s] !== undefined);
  const skeleton = Object.fromEntries(present.map((s) => [s, fill(schema.properties?.[s] ?? {}, PLACEHOLDER[s])]));
  return [
    "## Output",
    "Return exactly one JSON object and nothing else: no prose before or after, no code fence. " +
      "Every key below is required; use null where you have nothing to report.",
    ...present.map((s) => OUTPUT_LINES[s]),
    "Shape, with placeholder values:",
    JSON.stringify(skeleton),
  ].join("\n");
}

/** The schema's shape with one placeholder at every leaf. */
function fill(schema: StructuredSchema, placeholder: unknown): unknown {
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  if (type !== "object") return placeholder;
  return Object.fromEntries(Object.entries(schema.properties ?? {}).map(([k, v]) => [k, fill(v, placeholder)]));
}

function triggerPhrases<C, D>(flow: Flow<C, D>, kind: "message" | "mention"): string[] {
  const phrases: string[] = [];
  for (const trigger of flow.on ?? []) {
    if (kind === "message" && "message" in trigger) phrases.push(...trigger.message);
    if (kind === "mention" && "mention" in trigger) phrases.push(...trigger.mention);
  }
  return phrases;
}

function describeParam(name: string, def: ParamDef): string {
  if (def.type === "array") return `${name} (list of ${def.items.type})${def.description ? `: ${def.description}` : ""}`;
  return describeField(name, def);
}

// ── Reply parsing ───────────────────────────────────────────────────────

function empty(llmCalls: number, usage?: TokenUsage): Understanding {
  return { flows: {}, mentions: {}, extract: {}, branches: {}, fields: {}, llmCalls, ...(usage ? { usage } : {}) };
}

/** `{ usage }` when the provider counted, `{}` when it did not — `exactOptionalPropertyTypes`. */
function usageOf(metadata: GenerateMessageOutput["metadata"]): { usage?: TokenUsage } {
  const usage = readUsage(metadata);
  return usage ? { usage } : {};
}

/** A reply is usable when it is an object carrying at least one envelope section. */
function usable(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && SECTIONS.some((s) => s in value);
}

function entries(value: unknown): [string, unknown][] {
  return isRecord(value) ? Object.entries(value) : [];
}

function parseReply(reply: Record<string, unknown>, aliases: Aliases): Understanding {
  const flows: Record<string, number> = {};
  for (const [key, raw] of entries(reply.flows)) {
    const n = score(raw);
    if (n !== undefined) flows[aliases.real(key)] = n;
  }
  const extract: Record<string, Record<string, unknown>> = {};
  for (const [key, raw] of entries(reply.extract)) {
    if (isRecord(raw)) extract[aliases.real(key)] = given(raw);
  }
  return {
    flows,
    mentions: booleans(reply.mentions, aliases),
    extract,
    branches: booleans(reply.branches, aliases),
    fields: given(Object.fromEntries(entries(reply.fields).map(([k, v]) => [aliases.real(k), v]))),
    llmCalls: 1,
  };
}

/** A finite number, or a numeric string, clamped to 0-100. Anything else is dropped. */
function score(raw: unknown): number | undefined {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw.trim()) : NaN;
  return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : undefined;
}

/** Booleans, with `sim`/`yes`/`true` strings accepted through the shared coercion table. */
function booleans(value: unknown, aliases: Aliases): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const [key, raw] of entries(value)) {
    const coerced = coerceField({ type: "boolean" }, raw);
    if (coerced.ok && typeof coerced.value === "boolean") out[aliases.real(key)] = coerced.value;
  }
  return out;
}

/** Raw values the customer gave: `null`, `undefined` and `''` mean nothing was given. */
function given(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => isKnown(v)));
}
