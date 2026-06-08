/**
 * SignalEvaluator — Batched AI classifier + extraction for signals.
 *
 * Handles:
 * - `evaluateIf`: code-first predicate evaluation (AND semantics, short-circuit)
 * - `evaluateSignals`: single batched provider call for detection + extraction
 * - `buildSignalClassifierPrompt` / `buildMergedSchema`: prompt & schema construction
 *
 * @module SignalEvaluator
 */

import type { AiProvider } from "../types/ai";
import type { Event } from "../types/history";
import type { SessionState } from "../types/session";
import type {
    Signal,
    SignalPredicate,
    SignalPredicateContext,
} from "../types/signals";
import { eventsToHistory, logger } from "../utils";

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

export interface SignalEvaluationResult {
    matched: boolean;
    reason?: string;
    extracted?: unknown;
}

export interface EvaluateSignalsParams<TContext = unknown, TData = unknown> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    signals: Signal<TContext, TData, any>[];
    session: SessionState<TData>;
    history: Event[];
    context: TContext;
}

// ──────────────────────────────────────────────────────────────────────────────
// Prompt builder (exported for testing)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Builds the classifier prompt for a batch of signals.
 *
 * Splits `when` entries by `!` prefix at render time:
 * - Non-`!` → "TRIGGER WHEN (ANY matches)"
 * - `!` entries → prefix stripped, "DO NOT TRIGGER WHEN (ANY inhibits)"
 *
 * Extraction schemas render under "WHEN MATCHED, EXTRACT".
 * Unconditional + extract signals render under "ALWAYS EXTRACT".
 */
export function buildSignalClassifierPrompt<TContext = unknown, TData = unknown>(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    signals: Signal<TContext, TData, any>[],
    history: Event[],
    _context: TContext,
): string {
    const header = [
        "You are evaluating signals for this conversation.",
        "",
        "For each signal, decide whether it matched based on the most recent user message AND the conversation context. Be conservative: only mark a signal matched when there is CLEAR, EXPLICIT evidence.",
        "Positive TRIGGER WHEN entries are alternatives: ANY one positive entry can trigger the signal. DO NOT TRIGGER WHEN entries are exclusions: ANY one exclusion inhibits the signal.",
    ].join("\n");

    const signalBlocks: string[] = [];

    for (const signal of signals) {
        const id = signal.id ?? "unknown";
        const title = signal.title ?? id;
        const lines: string[] = [];

        // Header
        lines.push(`- SIGNAL "${id}" | "${title}"`);

        // Description
        if (signal.description) {
            lines.push(`  DESCRIPTION: ${signal.description}`);
        }

        // Split when entries
        const whenEntries = normalizeWhen(signal.when);
        const positiveEntries = whenEntries.filter(w => !w.startsWith("!"));
        const negativeEntries = whenEntries.filter(w => w.startsWith("!")).map(w => w.slice(1));

        const isUnconditional = whenEntries.length === 0;

        if (isUnconditional && signal.extract) {
            // Unconditional + extract → ALWAYS EXTRACT
            lines.push(`  ALWAYS EXTRACT`);
        } else if (positiveEntries.length > 0) {
            lines.push(`  TRIGGER WHEN (ANY matches):`);
            for (const entry of positiveEntries) {
                lines.push(`    • ${entry}`);
            }
        }

        if (negativeEntries.length > 0) {
            lines.push(`  DO NOT TRIGGER WHEN (ANY inhibits):`);
            for (const entry of negativeEntries) {
                lines.push(`    • ${entry}`);
            }
        }

        // Extraction schema
        if (signal.extract) {
            lines.push(`  WHEN MATCHED, EXTRACT:`);
            const schemaLines = renderExtractionSchema(signal.extract);
            for (const line of schemaLines) {
                lines.push(`    • ${line}`);
            }
        }

        signalBlocks.push(lines.join("\n"));
    }

    // Render conversation history
    const historySection = renderHistoryForClassifier(history);

    const outputInstructions = [
        "# OUTPUT",
        "For each signal, return:",
        "  { id, matched, reason (required when matched=true) }",
        "  + extracted fields (when signal defines extraction and matched=true)",
    ].join("\n");

    return [
        header,
        "",
        "# SIGNALS",
        "",
        signalBlocks.join("\n\n"),
        "",
        historySection,
        "",
        outputInstructions,
    ].join("\n");
}

// ──────────────────────────────────────────────────────────────────────────────
// Schema builder (exported for testing)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Builds the merged JSON schema for the classifier response.
 *
 * Shape: `{ signals: [{ id, matched, reason?, extracted? }, ...] }`
 * where `extracted` is only present for signals with `extract` set.
 */
export function buildMergedSchema<TContext = unknown, TData = unknown>(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    signals: Signal<TContext, TData, any>[],
): Record<string, unknown> {
    const signalEntrySchemas = signals.map(signal => {
        const entry: Record<string, unknown> = {
            type: "object",
            properties: {
                id: { type: "string", description: "Signal identifier" },
                matched: { type: "boolean", description: "Whether the signal matched" },
                reason: { type: "string", description: "Reason for the match (required when matched=true)" },
            },
            required: ["id", "matched"],
            additionalProperties: false,
        };

        // Add extracted field only when signal has extract schema
        if (signal.extract) {
            (entry.properties as Record<string, unknown>).extracted = signal.extract;
            entry.additionalProperties = false;
        }

        return entry;
    });

    return {
        type: "object",
        properties: {
            signals: {
                type: "array",
                items: {
                    anyOf: signalEntrySchemas,
                },
                description: "Evaluation results for each signal",
            },
        },
        required: ["signals"],
        additionalProperties: false,
    };
}

// ──────────────────────────────────────────────────────────────────────────────
// SignalEvaluator class
// ──────────────────────────────────────────────────────────────────────────────

export class SignalEvaluator<TContext = unknown, TData = unknown> {
    constructor(private readonly provider: AiProvider) { }

    /**
     * Code-first predicate evaluation with AND semantics and short-circuit.
     *
     * Normalizes predicates to an array. Awaits each; returns false on first
     * falsy result. Catches throws/rejections, logs at ERROR with predicate
     * index, and returns false (signal treated as non-match).
     */
    async evaluateIf(
        predicates: SignalPredicate<TContext, TData> | SignalPredicate<TContext, TData>[],
        ctx: SignalPredicateContext<TContext, TData>,
    ): Promise<boolean> {
        const predicateArray = Array.isArray(predicates) ? predicates : [predicates];

        for (let i = 0; i < predicateArray.length; i++) {
            try {
                const result = await predicateArray[i](ctx);
                if (!result) {
                    return false;
                }
            } catch (error) {
                logger.error(
                    `[Signals] Predicate at index ${i} threw: ${error instanceof Error ? error.message : String(error)}`,
                );
                return false;
            }
        }

        return true;
    }

    /**
     * Batched AI classifier + extraction call (Algorithm 3).
     *
     * Builds the classifier prompt and merged schema, makes a single provider
     * call, and parses the response into an id → result map. Any signal absent
     * from the response defaults to `{ matched: false }`. Provider errors are
     * caught and logged; all signals default to non-match.
     */
    async evaluateSignals(
        params: EvaluateSignalsParams<TContext, TData>,
    ): Promise<Record<string, SignalEvaluationResult>> {
        const { signals, history, context } = params;

        // Build prompt and schema
        const prompt = buildSignalClassifierPrompt(signals, history, context);
        const jsonSchema = buildMergedSchema(signals);

        try {
            const response = await this.provider.generateMessage<TContext, { signals: Array<{ id: string; matched: boolean; reason?: string; extracted?: unknown }> }>({
                prompt,
                history: eventsToHistory(history),
                context,
                parameters: {
                    jsonSchema,
                    schemaName: "signal_evaluation",
                },
            });

            // Parse response into id → result map
            const results: Record<string, SignalEvaluationResult> = {};
            const entries = response.structured?.signals ?? [];

            for (const entry of entries) {
                results[entry.id] = {
                    matched: entry.matched,
                    reason: entry.matched ? entry.reason : undefined,
                    extracted: entry.matched ? entry.extracted : undefined,
                };
            }

            // Defensive defaults: any signal absent from the response → matched: false
            for (const signal of signals) {
                const id = signal.id ?? "unknown";
                if (!results[id]) {
                    results[id] = { matched: false };
                }
            }

            return results;
        } catch (error) {
            logger.error(
                `[Signals] Classifier call failed: ${error instanceof Error ? error.message : String(error)}`,
            );

            // On provider error, all signals default to non-match
            const results: Record<string, SignalEvaluationResult> = {};
            for (const signal of signals) {
                const id = signal.id ?? "unknown";
                results[id] = { matched: false };
            }
            return results;
        }
    }

    /**
     * Parallel batched evaluation. Splits signals into batches of `batchSize`,
     * evaluates each batch via `evaluateSignals` in parallel using `Promise.all`,
     * and merges all result maps into a single record.
     *
     * No key collisions because signal ids are unique within a phase.
     */
    async evaluateSignalsBatched(params: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        signals: Signal<TContext, TData, any>[];
        batchSize?: number;
        session: SessionState<TData>;
        history: Event[];
        context: TContext;
    }): Promise<Record<string, SignalEvaluationResult>> {
        const { signals, batchSize = 10, session, history, context } = params;

        if (signals.length === 0) return {};

        const batches = splitIntoBatches(signals, batchSize);

        const batchResults = await Promise.all(
            batches.map(batch =>
                this.evaluateSignals({ signals: batch, session, history, context }),
            ),
        );

        // Merge all batch result maps into a single record
        const merged: Record<string, SignalEvaluationResult> = {};
        for (const result of batchResults) {
            Object.assign(merged, result);
        }
        return merged;
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// Batch helper (exported for testing)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Splits an array into fixed-size chunks.
 *
 * Returns an array of sub-arrays, each of at most `batchSize` elements.
 * The last chunk may be shorter. Returns an empty array when `items` is empty.
 */
export function splitIntoBatches<T>(items: T[], batchSize: number): T[][] {
    if (items.length === 0) return [];

    const batches: T[][] = [];
    for (let i = 0; i < items.length; i += batchSize) {
        batches.push(items.slice(i, i + batchSize));
    }
    return batches;
}

// ──────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ──────────────────────────────────────────────────────────────────────────────

/** Normalize `when` to a string array. */
function normalizeWhen(when: string | string[] | undefined): string[] {
    if (!when) return [];
    return Array.isArray(when) ? when : [when];
}

/**
 * Render extraction schema properties as human-readable lines for the prompt.
 * Lists each property's name, type, and constraints (enum, min/max, format).
 */
function renderExtractionSchema(schema: Record<string, unknown>): string[] {
    const lines: string[] = [];
    const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;

    if (!properties) return lines;

    for (const [name, fieldSchema] of Object.entries(properties)) {
        if (!fieldSchema || typeof fieldSchema !== "object") continue;

        const type = (fieldSchema.type as string) ?? "unknown";
        let line = `${name} (${type})`;

        // Add constraints
        const constraints: string[] = [];

        if (fieldSchema.enum && Array.isArray(fieldSchema.enum)) {
            constraints.push((fieldSchema.enum as string[]).join("|"));
        }
        if (fieldSchema.minimum !== undefined || fieldSchema.maximum !== undefined) {
            const min = fieldSchema.minimum !== undefined ? `${fieldSchema.minimum as number}` : "";
            const max = fieldSchema.maximum !== undefined ? `${fieldSchema.maximum as number}` : "";
            constraints.push(`${min}-${max}`);
        }
        if (fieldSchema.format) {
            constraints.push(fieldSchema.format as string);
        }

        if (constraints.length > 0) {
            line += `, ${constraints.join(", ")}`;
        }

        // Add description
        if (fieldSchema.description) {
            line += `: ${fieldSchema.description as string}`;
        }

        lines.push(line);
    }

    return lines;
}

/**
 * Render conversation history into a simple text block for the classifier prompt.
 */
function renderHistoryForClassifier(history: Event[]): string {
    if (history.length === 0) return "# CONVERSATION HISTORY\n(empty)";

    const lines: string[] = ["# CONVERSATION HISTORY"];
    for (const event of history) {
        const source = event.source ?? "unknown";
        const data = event.data as { message?: string } | undefined;
        const message = data?.message ?? "";
        if (message) {
            lines.push(`${source}: ${message}`);
        }
    }
    return lines.join("\n");
}
