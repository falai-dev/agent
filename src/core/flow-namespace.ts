/**
 * `flow` namespace — type guards, merge, and validation helpers for Directives.
 *
 * No builder constructors live here (no `flow.goTo(...)`, `flow.complete(...)` etc.).
 * Directives are plain object literals; this namespace provides runtime utilities only.
 */

import type { Directive } from "../types/flow";
import { FlowConfigurationError } from "./Step";

// ─── Position field metadata ─────────────────────────────────────────────────

/** Position fields in precedence order (highest first). */
const POSITION_FIELDS = ["abort", "complete", "goTo", "goToStep", "reset"] as const;
type PositionField = (typeof POSITION_FIELDS)[number];

/** Precedence map: lower number = higher priority. */
const POSITION_PRECEDENCE: Record<PositionField, number> = {
    abort: 0,
    complete: 1,
    goTo: 2,
    goToStep: 2,
    reset: 3,
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getSetPositionFields(d: Directive): PositionField[] {
    return POSITION_FIELDS.filter((f) => d[f] !== undefined && d[f] !== null);
}

/**
 * Determines whether `candidate` beats `current` by precedence.
 * Lower precedence number wins. On tie, candidate wins (last-emission-wins).
 */
function beatsCurrent(
    candidate: PositionField,
    current: PositionField | null
): boolean {
    if (current === null) return true;
    return POSITION_PRECEDENCE[candidate] <= POSITION_PRECEDENCE[current];
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Type guard: is `x` a Directive (or any subtype like PreDirective)?
 *
 * A value is considered a Directive if it is a non-null object. The Directive
 * interface has all-optional fields, so any plain object qualifies structurally.
 * This guard filters out primitives, null, undefined, arrays, and functions.
 */
function isDirective(x: unknown): x is Directive {
    return (
        x !== null &&
        x !== undefined &&
        typeof x === "object" &&
        !Array.isArray(x)
    );
}

/**
 * Merge two directives by Algorithm 4's rules:
 * - Position fields: precedence (abort > complete > goTo/goToStep > reset);
 *   ties broken by emission order (b wins over a — last wins).
 * - reply: last-wins (b.reply overrides a.reply if set).
 * - dataUpdate / contextUpdate: shallow-merge (b overrides a on key collision).
 * - appendPrompt / injectTools (PreDirective fields): concatenate then dedupe.
 * - halt: logical-OR.
 */
function merge<T extends Directive>(a: T, b: T): T {
    const result = {} as Record<string, unknown>;

    // ── Position field: winner-takes-all by precedence, b wins ties ──
    const aPos = getSetPositionFields(a as Directive);
    const bPos = getSetPositionFields(b as Directive);

    // Pick the highest-priority position field across both directives.
    // b's fields are evaluated after a's, so b wins on same precedence (last-wins).
    let winnerField: PositionField | null = null;
    let winnerSource: Directive | null = null;

    for (const field of aPos) {
        if (beatsCurrent(field, winnerField)) {
            winnerField = field;
            winnerSource = a as Directive;
        }
    }
    for (const field of bPos) {
        if (beatsCurrent(field, winnerField)) {
            winnerField = field;
            winnerSource = b as Directive;
        }
    }

    if (winnerField !== null && winnerSource !== null) {
        result[winnerField] = (winnerSource as Record<string, unknown>)[winnerField];
    }

    // ── reply: last-wins ──
    if ((b as Directive).reply !== undefined) {
        result.reply = (b as Directive).reply;
    } else if ((a as Directive).reply !== undefined) {
        result.reply = (a as Directive).reply;
    }

    // ── dataUpdate: shallow merge ──
    const aData = (a as Record<string, unknown>).dataUpdate as
        | Record<string, unknown>
        | undefined;
    const bData = (b as Record<string, unknown>).dataUpdate as
        | Record<string, unknown>
        | undefined;
    if (aData || bData) {
        result.dataUpdate = { ...aData, ...bData };
    }

    // ── contextUpdate: shallow merge ──
    const aCtx = (a as Record<string, unknown>).contextUpdate as
        | Record<string, unknown>
        | undefined;
    const bCtx = (b as Record<string, unknown>).contextUpdate as
        | Record<string, unknown>
        | undefined;
    if (aCtx || bCtx) {
        result.contextUpdate = { ...aCtx, ...bCtx };
    }

    // ── appendPrompt (PreDirective): concatenate ──
    const aPrompt = (a as Record<string, unknown>).appendPrompt as
        | string[]
        | undefined;
    const bPrompt = (b as Record<string, unknown>).appendPrompt as
        | string[]
        | undefined;
    if (aPrompt || bPrompt) {
        result.appendPrompt = [...(aPrompt ?? []), ...(bPrompt ?? [])];
    }

    // ── injectTools (PreDirective): concatenate then dedupe by id (last wins) ──
    const aTools = (a as Record<string, unknown>).injectTools as
        | Array<{ id: string;[k: string]: unknown }>
        | undefined;
    const bTools = (b as Record<string, unknown>).injectTools as
        | Array<{ id: string;[k: string]: unknown }>
        | undefined;
    if (aTools || bTools) {
        const combined = [...(aTools ?? []), ...(bTools ?? [])];
        // Dedupe by id — last definition wins
        const seen = new Map<string, (typeof combined)[number]>();
        for (const tool of combined) {
            seen.set(tool.id, tool);
        }
        result.injectTools = Array.from(seen.values());
    }

    // ── halt (PreDirective): logical OR ──
    const aHalt = (a as Record<string, unknown>).halt as boolean | undefined;
    const bHalt = (b as Record<string, unknown>).halt as boolean | undefined;
    if (aHalt || bHalt) {
        result.halt = true;
    }

    return result as T;
}

/**
 * Runtime validator. Throws FlowConfigurationError for invalid combinations:
 * - Multiple position fields set.
 * - `goTo` set as empty object `{}` (no flow target).
 * - `reply` co-existing with `abort` (abort ends the conversation; a reply is nonsensical).
 */
function validate(d: Directive): void {
    // ── Multiple position fields ──
    const setFields = getSetPositionFields(d);
    if (setFields.length > 1) {
        throw new FlowConfigurationError(
            `[FlowConfigurationError] Invalid directive: multiple position fields set (${setFields.join(", ")}). ` +
            `A directive may have at most one position field. Remove the extras.`
        );
    }

    // ── Empty goTo object ──
    if (d.goTo !== undefined && d.goTo !== null) {
        if (typeof d.goTo === "object") {
            const goToObj = d.goTo as { flow?: string; step?: string };
            if (!goToObj.flow && !goToObj.step) {
                throw new FlowConfigurationError(
                    `[FlowConfigurationError] Invalid directive: goTo is set as an empty object. ` +
                    `goTo requires a flow id or title. Provide { flow: "<id>" } or use the string shorthand.`
                );
            }
        }
    }

    // ── reply co-existing with abort ──
    if (d.reply !== undefined && d.abort !== undefined) {
        throw new FlowConfigurationError(
            `[FlowConfigurationError] Invalid directive: reply cannot co-exist with abort. ` +
            `An aborted conversation cannot deliver a reply. Remove one of the fields.`
        );
    }
}

/**
 * The `flow` namespace object. Exported as a single const for ergonomic usage:
 *
 * ```ts
 * import { flow } from '@falai/agent';
 * if (flow.isDirective(x)) { ... }
 * const merged = flow.merge(a, b);
 * flow.validate(d);
 * ```
 */
export const flow = {
    isDirective,
    merge,
    validate,
} as const;
