/**
 * Fields: what is known, what is still pending, what the model may see, and
 * how a raw extracted value becomes a typed one.
 */

import { FlowConfigurationError } from "../types/errors.js";
import type { FieldDef, FieldDefs, ParamDef, ParamDefs, ScalarDef } from "../types/flow.js";
import type { StructuredSchema } from "../types/schema.js";

/** The default number of times a field is asked before it is skipped. */
export const DEFAULT_MAX_ASKS = 3;

/** A value counts as known unless it is `undefined`, `null` or `''`. */
export function isKnown(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

/** The step's `collect` fields that are still unknown and not yet at `maxAsks`, in order. */
export function pendingFields(
  step: { collect?: readonly string[]; maxAsks?: number },
  data: Record<string, unknown>,
  asked: Record<string, number>,
): string[] {
  const maxAsks = step.maxAsks ?? DEFAULT_MAX_ASKS;
  return (step.collect ?? []).filter((field) => !isKnown(data[field]) && (asked[field] ?? 0) < maxAsks);
}

/** How a field may be harvested when the definition does not say: booleans only when asked. */
export function extractMode(def: FieldDef): "anywhere" | "asked" {
  return def.extract ?? (def.type === "boolean" ? "asked" : "anywhere");
}

export type Coerced = { ok: true; value: string | number | boolean } | { ok: false; code: "bad-value" | "not-in-enum" };

/**
 * Turn a raw value from the model into the field's type. Strings are coerced
 * to numbers and booleans; enum membership is enforced. The `detail` is the
 * outcome line the host shows when a value is dropped.
 */
export function coerceField(def: ScalarDef, raw: unknown): Coerced {
  const value = coerceScalar(def, raw);
  if (value === undefined) return { ok: false, code: "bad-value" };
  if (def.enum && !def.enum.includes(value as string | number)) {
    return { ok: false, code: "not-in-enum" };
  }
  return { ok: true, value };
}

function coerceScalar(def: ScalarDef, raw: unknown): string | number | boolean | undefined {
  switch (def.type) {
    case "string":
      if (typeof raw === "string") return raw;
      if (typeof raw === "number" || typeof raw === "boolean") return String(raw);
      return undefined;
    case "number":
    case "integer": {
      const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw.trim().replace(",", ".")) : NaN;
      if (!Number.isFinite(n)) return undefined;
      return def.type === "integer" ? Math.trunc(n) : n;
    }
    case "boolean":
      if (typeof raw === "boolean") return raw;
      if (typeof raw === "string") {
        const s = raw.trim().toLowerCase();
        if (["true", "sim", "yes", "1"].includes(s)) return true;
        if (["false", "não", "nao", "no", "0"].includes(s)) return false;
      }
      return undefined;
  }
}

export interface WireOptions {
  /** Every property is required and accepts `null`. The envelope style. */
  nullable?: boolean;
}

/**
 * The JSON schema a provider sees: an allow-list of JSON-schema keys, with
 * `label`, `ask`, `extract` and `optional` stripped. Closed (`additionalProperties:
 * false`); every property required unless a parameter says `optional`.
 */
export function toWireSchema(defs: FieldDefs | ParamDefs, options: WireOptions = {}): StructuredSchema {
  const properties: Record<string, StructuredSchema> = {};
  const required: string[] = [];
  const entries: Array<[string, FieldDef | ParamDef]> = Object.entries(defs);
  for (const [name, def] of entries) {
    properties[name] = wireProperty(def, options.nullable ?? false);
    if (options.nullable || !("optional" in def && def.optional)) required.push(name);
  }
  return { type: "object", properties, required, additionalProperties: false };
}

function wireProperty(def: FieldDef | ParamDef, nullable: boolean): StructuredSchema {
  const out: StructuredSchema = def.type === "array"
    ? { type: "array", items: wireProperty(def.items, false) }
    : { type: def.type };
  if (def.description) out.description = def.description;
  if (def.type !== "array" && def.enum) out.enum = [...def.enum];
  if (nullable) out.type = [def.type, "null"];
  return out;
}

/**
 * Merge field rows authored per flow into the agent's one field set. Two
 * rows for one slug must agree on type and enum; the first non-empty `label`,
 * `ask` and `description` win.
 */
export function buildSchema(groups: Array<{ id: string; fields: FieldDefs }>): FieldDefs {
  const merged: FieldDefs = {};
  const owner: Record<string, string> = {};
  for (const group of groups) {
    for (const [slug, def] of Object.entries(group.fields)) {
      const seen = merged[slug];
      if (!seen) {
        merged[slug] = { ...def };
        owner[slug] = group.id;
        continue;
      }
      if (seen.type !== def.type) {
        throw new FlowConfigurationError(
          `[FlowConfigurationError] field "${slug}" has two types: "${seen.type}" in "${owner[slug]}", ` +
            `"${def.type}" in "${group.id}". Give one slug one type.`,
        );
      }
      if (seen.enum && def.enum && !sameList(seen.enum, def.enum)) {
        throw new FlowConfigurationError(
          `[FlowConfigurationError] field "${slug}" has two option lists: in "${owner[slug]}" and "${group.id}". ` +
            `Give one slug one list.`,
        );
      }
      merged[slug] = {
        ...seen,
        enum: seen.enum ?? def.enum,
        label: seen.label ?? def.label,
        ask: seen.ask ?? def.ask,
        description: seen.description ?? def.description,
        extract: seen.extract ?? def.extract,
      };
    }
  }
  return merged;
}

function sameList(a: readonly (string | number)[], b: readonly (string | number)[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
