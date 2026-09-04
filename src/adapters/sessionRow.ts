/**
 * Shared row-mapping for the SQL-shaped session adapters (PostgreSQL, SQLite)
 * and date coercion for JSON-round-tripped values (Redis).
 *
 * One implementation so the adapters can't drift on what a stored session row
 * means. PostgreSQL's driver returns JSONB pre-parsed and timestamptz as Date
 * instances; SQLite returns strings — both shapes are accepted here.
 */

import type {
  CollectedStateData,
  SessionData,
  SessionStatus,
} from "../types/index.js";

/**
 * Coerce a raw stored value into a Date. Drivers variously hand back Date
 * instances (node-postgres timestamptz) or ISO strings (SQLite, JSON blobs).
 * `null`/`undefined` maps to `undefined`.
 */
export function coerceDate(value: unknown): Date | undefined {
  if (value == null) return undefined;
  return value instanceof Date ? value : new Date(value as string);
}

/**
 * Map a raw snake_case row onto the camelCase SessionData interface.
 * `collected_data` arrives JSONB-parsed on PostgreSQL and as a raw string on
 * SQLite — both are handled. Exported for the adapter mapping tests.
 */
export function deserializeSessionRow<TData = Record<string, unknown>>(
  row: Record<string, unknown>
): SessionData<TData> {
  const collected = row.collected_data;
  return {
    id: row.id as string,
    userId: (row.user_id as string) || undefined,
    agentName: (row.agent_name as string) || undefined,
    status: row.status as SessionStatus,
    currentFlow: (row.current_flow as string) || undefined,
    currentStep: (row.current_step as string) || undefined,
    collectedData:
      collected == null
        ? undefined
        : typeof collected === "string"
          ? (JSON.parse(collected) as CollectedStateData<TData>)
          : (collected as CollectedStateData<TData>),
    messageCount: (row.message_count as number) || 0,
    lastMessageAt: coerceDate(row.last_message_at),
    completedAt: coerceDate(row.completed_at),
    version: (row.version as number | null) ?? undefined,
    // created_at/updated_at are NOT NULL in every adapter's schema; the
    // fallback only covers hand-crafted rows.
    createdAt: coerceDate(row.created_at) ?? new Date(),
    updatedAt: coerceDate(row.updated_at) ?? new Date(),
  };
}
