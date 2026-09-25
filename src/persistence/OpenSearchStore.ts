/**
 * OpenSearch Store over the official client (Elasticsearch 7.x fits too).
 *
 * One document per session: `id`, `version`, `blob` (stored, not indexed),
 * `createdAt`, `updatedAt`. A first save is an `index` with `op_type:
 * 'create'`, and the 409 is the conflict; later saves are a scripted
 * `update` that compares `version` and becomes a `noop` when it differs,
 * so the check and the write happen together on the shard (3.x read, then
 * wrote).
 */

import { SessionConflictError } from "../types/errors.js";
import type { Session, Store } from "../types/session.js";
import { readBlob, toBlob } from "./sessionRow.js";

type Refresh = boolean | "wait_for";

/** Matches `@opensearch-project/opensearch`'s Client. */
export interface OpenSearchClient {
  index(params: {
    index: string;
    id: string;
    body: Record<string, unknown>;
    op_type?: "index" | "create";
    refresh?: Refresh;
  }): Promise<{ body: { result: string } }>;
  update(params: {
    index: string;
    id: string;
    body: Record<string, unknown>;
    retry_on_conflict?: number;
    refresh?: Refresh;
  }): Promise<{ body: { result: string } }>;
  get(params: { index: string; id: string }): Promise<{ body: { _source: Record<string, unknown> } }>;
  indices: {
    exists(params: { index: string }): Promise<{ body: boolean }>;
    create(params: { index: string; body: { mappings?: Record<string, unknown> } }): Promise<{ body: { acknowledged: boolean } }>;
  };
}

export interface OpenSearchStoreOptions {
  client: OpenSearchClient;
  /** Index name. Default `agent_sessions`. */
  indices?: { sessions?: string };
  /** Create the index with its mappings on `initialize()`. Default true. */
  autoCreateIndices?: boolean;
  /** Refresh policy on writes: `true` at once, `false` in the background, `'wait_for'` blocks. Default false. */
  refresh?: Refresh;
}

/** Writes the new version only when the stored one is the expected one; otherwise a noop. */
const CAS_SCRIPT =
  "if (ctx._source.version != params.expected) { ctx.op = 'noop' } " +
  "else { ctx._source.version = params.version; ctx._source.blob = params.blob; ctx._source.updatedAt = params.updatedAt }";

export class OpenSearchStore<D = unknown> implements Store<D> {
  private readonly client: OpenSearchClient;
  private readonly index: string;
  private readonly autoCreateIndices: boolean;
  private readonly refresh: Refresh;

  constructor(options: OpenSearchStoreOptions) {
    this.client = options.client;
    this.index = options.indices?.sessions ?? "agent_sessions";
    this.autoCreateIndices = options.autoCreateIndices ?? true;
    this.refresh = options.refresh ?? false;
  }

  /** Create the index with its mappings when it is missing and `autoCreateIndices` is on. */
  async initialize(): Promise<void> {
    if (!this.autoCreateIndices) return;
    const exists = await this.client.indices.exists({ index: this.index });
    if (exists.body) return;
    await this.client.indices.create({
      index: this.index,
      body: {
        mappings: {
          properties: {
            id: { type: "keyword" },
            version: { type: "integer" },
            blob: { type: "object", enabled: false },
            createdAt: { type: "date" },
            updatedAt: { type: "date" },
          },
        },
      },
    });
  }

  async load(id: string): Promise<Session<D> | null> {
    try {
      const response = await this.client.get({ index: this.index, id });
      return readBlob<D>(response.body._source.blob, id);
    } catch (error) {
      if (statusCodeOf(error) === 404) return null;
      throw error;
    }
  }

  async save(session: Session<D>, expectedVersion: number): Promise<Session<D>> {
    const next = expectedVersion + 1;
    const blob = toBlob(session, next);
    const now = new Date().toISOString();
    if (expectedVersion === 0) {
      try {
        await this.client.index({
          index: this.index,
          id: session.id,
          op_type: "create",
          body: { id: session.id, version: next, blob, createdAt: now, updatedAt: now },
          refresh: this.refresh,
        });
      } catch (error) {
        if (statusCodeOf(error) !== 409) throw error;
        throw new SessionConflictError(session.id, 0, await this.storedVersion(session.id));
      }
      return blob;
    }
    try {
      const response = await this.client.update({
        index: this.index,
        id: session.id,
        retry_on_conflict: 3,
        refresh: this.refresh,
        body: {
          script: { lang: "painless", source: CAS_SCRIPT, params: { expected: expectedVersion, version: next, blob, updatedAt: now } },
        },
      });
      if (response.body.result !== "noop") return blob;
    } catch (error) {
      const status = statusCodeOf(error);
      if (status !== 404 && status !== 409) throw error;
    }
    throw new SessionConflictError(session.id, expectedVersion, await this.storedVersion(session.id));
  }

  private async storedVersion(id: string): Promise<number | undefined> {
    try {
      const response = await this.client.get({ index: this.index, id });
      const version = response.body._source.version;
      return typeof version === "number" ? version : undefined;
    } catch (error) {
      if (statusCodeOf(error) === 404) return undefined;
      throw error;
    }
  }
}

/** The client's `ResponseError` carries the HTTP status as `statusCode`. */
function statusCodeOf(error: unknown): number | undefined {
  return typeof error === "object" && error !== null && "statusCode" in error && typeof error.statusCode === "number"
    ? error.statusCode
    : undefined;
}
