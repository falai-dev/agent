/**
 * OpenSearch Persistence Adapter
 *
 * Provides persistence for sessions and messages using OpenSearch.
 * Also compatible with Elasticsearch 7.x (not tested with newer versions).
 *
 * @example
 * ```typescript
 * import { Client } from '@opensearch-project/opensearch';
 * import { OpenSearchAdapter } from '@falai/agent';
 *
 * const client = new Client({
 *   node: 'https://localhost:9200',
 *   auth: {
 *     username: 'admin',
 *     password: 'admin'
 *   }
 * });
 *
 * const adapter = new OpenSearchAdapter(client, {
 *   indices: {
 *     sessions: 'agent_sessions',
 *     messages: 'agent_messages'
 *   },
 *   autoCreateIndices: true
 * });
 *
 * const agent = new Agent({
 *   model: provider,
 *   persistence: { adapter }
 * });
 * ```
 */

import { cloneDeep } from "../utils/clone";
import type {
  PersistenceAdapter,
  SessionRepository,
  MessageRepository,
  SessionData,
  MessageData,
  CollectedStateData,
  CreateSessionData,
} from "../types";

/**
 * OpenSearch Client interface (minimal typing for the official client)
 */
export interface OpenSearchClient {
  index(params: {
    index: string;
    id?: string;
    body: Record<string, unknown>;
    refresh?: boolean | "wait_for";
  }): Promise<{ body: { _id: string; result: string } }>;

  get(params: {
    index: string;
    id: string;
  }): Promise<{ body: { _source: Record<string, unknown> } }>;

  update(params: {
    index: string;
    id: string;
    body: { doc: Record<string, unknown> };
    refresh?: boolean | "wait_for";
  }): Promise<{ body: { result: string } }>;

  delete(params: {
    index: string;
    id: string;
    refresh?: boolean | "wait_for";
  }): Promise<{ body: { result: string } }>;

  deleteByQuery(params: {
    index: string;
    body: { query: Record<string, unknown> };
    refresh?: boolean;
  }): Promise<{ body: { deleted: number } }>;

  search(params: {
    index: string;
    body: {
      query?: Record<string, unknown>;
      sort?: Array<Record<string, unknown>>;
      size?: number;
    };
  }): Promise<{
    body: {
      hits: {
        hits: Array<{
          _id: string;
          _source: Record<string, unknown>;
        }>;
      };
    };
  }>;

  indices: {
    exists(params: { index: string }): Promise<{ body: boolean }>;
    create(params: {
      index: string;
      body: { mappings?: Record<string, unknown> };
    }): Promise<{ body: { acknowledged: boolean } }>;
  };
}

/**
 * Configuration options for the OpenSearch adapter
 */
export interface OpenSearchAdapterOptions {
  /**
   * Index names for sessions and messages
   * @default { sessions: 'agent_sessions', messages: 'agent_messages' }
   */
  indices?: {
    sessions?: string;
    messages?: string;
  };

  /**
   * Automatically create indices with mappings if they don't exist
   * @default true
   */
  autoCreateIndices?: boolean;

  /**
   * Refresh strategy for write operations
   * - true: Refresh immediately (slower, good for testing)
   * - false: Refresh in background (faster, eventual consistency)
   * - 'wait_for': Wait for refresh (balanced)
   * @default false
   */
  refresh?: boolean | "wait_for";
}

/**
 * OpenSearch persistence adapter
 *
 * Stores sessions and messages as documents in OpenSearch indices.
 * Compatible with OpenSearch 1.x, 2.x and Elasticsearch 7.x.
 */
export class OpenSearchAdapter<TData = Record<string, unknown>>
  implements PersistenceAdapter<TData>
{
  readonly sessionRepository: SessionRepository<TData>;
  readonly messageRepository: MessageRepository;

  private readonly client: OpenSearchClient;
  private readonly sessionIndex: string;
  private readonly messageIndex: string;
  private readonly autoCreateIndices: boolean;
  private readonly refresh: boolean | "wait_for";

  constructor(
    client: OpenSearchClient,
    options: OpenSearchAdapterOptions = {}
  ) {
    this.client = client;
    this.sessionIndex = options.indices?.sessions || "agent_sessions";
    this.messageIndex = options.indices?.messages || "agent_messages";
    this.autoCreateIndices = options.autoCreateIndices ?? true;
    this.refresh = options.refresh ?? false;

    this.sessionRepository = new OpenSearchSessionRepository<TData>(
      this.client,
      this.sessionIndex,
      this.refresh
    );

    this.messageRepository = new OpenSearchMessageRepository(
      this.client,
      this.messageIndex,
      this.refresh
    );
  }

  async initialize(): Promise<void> {
    if (!this.autoCreateIndices) {
      return;
    }

    // Create sessions index with mappings
    const sessionExists = await this.client.indices.exists({
      index: this.sessionIndex,
    });

    if (!sessionExists.body) {
      await this.client.indices.create({
        index: this.sessionIndex,
        body: {
          mappings: {
            properties: {
              id: { type: "keyword" },
              userId: { type: "keyword" },
              agentName: { type: "keyword" },
              status: { type: "keyword" },
              currentRoute: { type: "keyword" },
              currentStep: { type: "keyword" },
              collectedData: { type: "object", enabled: false },
              messageCount: { type: "integer" },
              createdAt: { type: "date" },
              updatedAt: { type: "date" },
              lastMessageAt: { type: "date" },
              completedAt: { type: "date" },
            },
          },
        },
      });
    }

    // Create messages index with mappings
    const messageExists = await this.client.indices.exists({
      index: this.messageIndex,
    });

    if (!messageExists.body) {
      await this.client.indices.create({
        index: this.messageIndex,
        body: {
          mappings: {
            properties: {
              id: { type: "keyword" },
              sessionId: { type: "keyword" },
              userId: { type: "keyword" },
              role: { type: "keyword" },
              content: { type: "text" },
              route: { type: "keyword" },
              step: { type: "keyword" },
              toolCalls: { type: "object", enabled: false },
              event: { type: "object", enabled: false },
              createdAt: { type: "date" },
            },
          },
        },
      });
    }
  }

  async disconnect(): Promise<void> {
    // OpenSearch client doesn't have a close method like some other clients
    // Connection pooling is managed automatically
    await Promise.resolve();
  }
}

/**
 * OpenSearch-based session repository implementation
 */
class OpenSearchSessionRepository<TData = Record<string, unknown>>
  implements SessionRepository<TData>
{
  constructor(
    private client: OpenSearchClient,
    private index: string,
    private refresh: boolean | "wait_for"
  ) {}

  async create(data: CreateSessionData<TData>): Promise<SessionData<TData>> {
    const id =
      data.id || `session_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const now = new Date();

    const session: SessionData<TData> = {
      ...data,
      id,
      status: data.status || "active",
      messageCount: data.messageCount || 0,
      createdAt: now,
      updatedAt: now,
    };
    const clonedSession = cloneDeep(session);

    await this.client.index({
      index: this.index,
      id,
      body: clonedSession as unknown as Record<string, unknown>,
      refresh: true, // Refresh to make the document immediately available for search
    });

    return session;
  }

  async findById(id: string): Promise<SessionData<TData> | null> {
    try {
      const response = await this.client.get({
        index: this.index,
        id,
      });

      return this.deserializeSession(response.body._source);
    } catch (error) {
      if (this.isNotFoundError(error)) {
        return null;
      }
      throw error;
    }
  }

  async findActiveByUserId(userId: string): Promise<SessionData<TData> | null> {
    const response = await this.client.search({
      index: this.index,
      body: {
        query: {
          bool: {
            must: [{ term: { userId } }, { term: { status: "active" } }],
          },
        },
        sort: [{ createdAt: { order: "desc" } }],
        size: 1,
      },
    });

    const hits = response.body.hits.hits;
    if (hits.length === 0) {
      return null;
    }

    return this.deserializeSession(hits[0]._source);
  }

  async findByUserId(
    userId: string,
    limit = 100
  ): Promise<SessionData<TData>[]> {
    const response = await this.client.search({
      index: this.index,
      body: {
        query: {
          term: { userId },
        },
        sort: [{ createdAt: { order: "desc" } }],
        size: limit,
      },
    });

    return response.body.hits.hits.map((hit) =>
      this.deserializeSession(hit._source)
    );
  }

  async update(
    id: string,
    updates: Partial<Omit<SessionData<TData>, "id" | "createdAt">>
  ): Promise<SessionData<TData> | null> {
    const doc: Record<string, unknown> = {
      ...updates,
      updatedAt: new Date().toISOString(),
    };

    // Serialize dates
    if (updates.completedAt) {
      doc.completedAt = updates.completedAt.toISOString();
    }
    if (updates.lastMessageAt) {
      doc.lastMessageAt = updates.lastMessageAt.toISOString();
    }

    await this.client.update({
      index: this.index,
      id,
      body: { doc },
      refresh: this.refresh,
    });

    return await this.findById(id);
  }

  async updateStatus(
    id: string,
    status: SessionData<TData>["status"],
    completedAt?: Date
  ): Promise<SessionData<TData> | null> {
    const doc: Record<string, unknown> = {
      status,
      updatedAt: new Date().toISOString(),
    };

    if (completedAt) {
      doc.completedAt = completedAt.toISOString();
    }

    await this.client.update({
      index: this.index,
      id,
      body: { doc },
      refresh: this.refresh,
    });

    return await this.findById(id);
  }

  async updateCollectedData(
    id: string,
    collectedData: CollectedStateData<TData>
  ): Promise<SessionData<TData> | null> {
    await this.client.update({
      index: this.index,
      id,
      body: {
        doc: {
          collectedData,
          updatedAt: new Date().toISOString(),
        },
      },
      refresh: this.refresh,
    });

    return await this.findById(id);
  }

  async updateRouteStep(
    id: string,
    route?: string,
    step?: string
  ): Promise<SessionData<TData> | null> {
    const doc: Record<string, unknown> = {
      updatedAt: new Date().toISOString(),
    };

    if (route !== undefined) {
      doc.currentRoute = route;
    }
    if (step !== undefined) {
      doc.currentStep = step;
    }

    await this.client.update({
      index: this.index,
      id,
      body: { doc },
      refresh: this.refresh,
    });

    return await this.findById(id);
  }

  async incrementMessageCount(id: string): Promise<SessionData<TData> | null> {
    const session = await this.findById(id);
    if (!session) {
      return null;
    }

    const newCount = (session.messageCount || 0) + 1;

    await this.client.update({
      index: this.index,
      id,
      body: {
        doc: {
          messageCount: newCount,
          lastMessageAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      },
      refresh: this.refresh,
    });

    return await this.findById(id);
  }

  async delete(id: string): Promise<boolean> {
    try {
      await this.client.delete({
        index: this.index,
        id,
        refresh: this.refresh,
      });
      return true;
    } catch (error) {
      if (this.isNotFoundError(error)) {
        return false;
      }
      throw error;
    }
  }

  private deserializeSession(doc: Record<string, unknown>): SessionData<TData> {
    return {
      id: doc.id as string,
      userId: doc.userId as string | undefined,
      agentName: doc.agentName as string | undefined,
      status: doc.status as SessionData<TData>["status"],
      currentRoute: doc.currentRoute as string | undefined,
      currentStep: doc.currentStep as string | undefined,
      collectedData: doc.collectedData as CollectedStateData<TData> | undefined,
      messageCount: (doc.messageCount as number) || 0,
      createdAt: new Date(doc.createdAt as string),
      updatedAt: new Date(doc.updatedAt as string),
      lastMessageAt: doc.lastMessageAt
        ? new Date(doc.lastMessageAt as string)
        : undefined,
      completedAt: doc.completedAt
        ? new Date(doc.completedAt as string)
        : undefined,
    };
  }

  private isNotFoundError(error: unknown): boolean {
    return (
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      error.statusCode === 404
    );
  }
}

/**
 * OpenSearch-based message repository implementation
 */
class OpenSearchMessageRepository implements MessageRepository {
  constructor(
    private client: OpenSearchClient,
    private index: string,
    private refresh: boolean | "wait_for"
  ) {}

  async create(
    data: Omit<MessageData, "id" | "createdAt">
  ): Promise<MessageData> {
    const id = `msg_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const now = new Date();

    const message: MessageData = {
      id,
      ...data,
      createdAt: now,
    };

    await this.client.index({
      index: this.index,
      id,
      body: this.serializeMessage(message),
      refresh: this.refresh,
    });

    return message;
  }

  async findById(id: string): Promise<MessageData | null> {
    try {
      const response = await this.client.get({
        index: this.index,
        id,
      });

      return this.deserializeMessage(response.body._source);
    } catch (error) {
      if (this.isNotFoundError(error)) {
        return null;
      }
      throw error;
    }
  }

  async findBySessionId(
    sessionId: string,
    limit = 1000
  ): Promise<MessageData[]> {
    const response = await this.client.search({
      index: this.index,
      body: {
        query: {
          term: { sessionId },
        },
        sort: [{ createdAt: { order: "asc" } }],
        size: limit,
      },
    });

    return response.body.hits.hits.map((hit) =>
      this.deserializeMessage(hit._source)
    );
  }

  async findByUserId(userId: string, limit = 100): Promise<MessageData[]> {
    const response = await this.client.search({
      index: this.index,
      body: {
        query: {
          term: { userId },
        },
        sort: [{ createdAt: { order: "desc" } }],
        size: limit,
      },
    });

    return response.body.hits.hits.map((hit) =>
      this.deserializeMessage(hit._source)
    );
  }

  async delete(id: string): Promise<boolean> {
    try {
      await this.client.delete({
        index: this.index,
        id,
        refresh: this.refresh,
      });
      return true;
    } catch (error) {
      if (this.isNotFoundError(error)) {
        return false;
      }
      throw error;
    }
  }

  async deleteBySessionId(sessionId: string): Promise<number> {
    const response = await this.client.deleteByQuery({
      index: this.index,
      body: {
        query: {
          term: { sessionId },
        },
      },
      refresh: this.refresh === "wait_for" ? false : this.refresh,
    });

    return response.body.deleted;
  }

  async deleteByUserId(userId: string): Promise<number> {
    const response = await this.client.deleteByQuery({
      index: this.index,
      body: {
        query: {
          term: { userId },
        },
      },
      refresh: this.refresh === "wait_for" ? false : this.refresh,
    });

    return response.body.deleted;
  }

  private serializeMessage(message: MessageData): Record<string, unknown> {
    return {
      ...message,
      createdAt: message.createdAt.toISOString(),
    };
  }

  private deserializeMessage(doc: Record<string, unknown>): MessageData {
    return {
      id: doc.id as string,
      sessionId: doc.sessionId as string,
      userId: doc.userId as string | undefined,
      role: doc.role as MessageData["role"],
      content: doc.content as string,
      route: doc.route as string | undefined,
      step: doc.step as string | undefined,
      toolCalls: doc.toolCalls as
        | Array<{ toolName: string; arguments: Record<string, unknown> }>
        | undefined,
      event: doc.event as MessageData["event"] | undefined,
      createdAt: new Date(doc.createdAt as string),
    };
  }

  private isNotFoundError(error: unknown): boolean {
    return (
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      error.statusCode === 404
    );
  }
}
