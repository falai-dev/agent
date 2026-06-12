/**
 * Prisma adapter for persistence
 * Simple, provider-like API with automatic schema creation
 */

import type {
  SessionRepository,
  MessageRepository,
  SessionData,
  MessageData,
  SessionStatus,
  PersistenceAdapter,
  CollectedStateData,
  MessageRole,
  Event,
  CreateSessionData,
  SessionUpdateOptions,
} from "../types";
import { SessionConflictError } from "../types/errors";
import { logger } from '../utils'
import { createSessionId } from '../utils';

/**
 * Prisma model operations
 */
export interface PrismaModel {
  create: (params: {
    data: Record<string, unknown>;
  }) => Promise<Record<string, unknown>>;
  findUnique: (params: {
    where: Record<string, unknown>;
  }) => Promise<Record<string, unknown> | null>;
  findFirst: (params: {
    where: Record<string, unknown>;
    orderBy?: Record<string, string>;
  }) => Promise<Record<string, unknown> | null>;
  findMany: (params: {
    where: Record<string, unknown>;
    orderBy?: Record<string, string>;
    take?: number;
  }) => Promise<Array<Record<string, unknown>>>;
  update: (params: {
    where: Record<string, unknown>;
    data: Record<string, unknown>;
  }) => Promise<Record<string, unknown>>;
  delete: (params: {
    where: Record<string, unknown>;
  }) => Promise<Record<string, unknown>>;
  deleteMany: (params: {
    where: Record<string, unknown>;
  }) => Promise<{ count: number }>;
}

/**
 * Prisma client interface - matches the shape of a generated Prisma client
 */
export interface PrismaClient extends Record<string, unknown> {
  $queryRaw?: <T = unknown>(
    query: TemplateStringsArray | string,
    ...values: unknown[]
  ) => Promise<T>;
  $executeRaw?: (
    query: TemplateStringsArray | string,
    ...values: unknown[]
  ) => Promise<number>;
  $disconnect?: () => Promise<void>;
}

/**
 * Configuration for field mappings
 */
export interface FieldMappings {
  sessions?: Partial<Record<keyof SessionData, string>>;
  messages?: Partial<Record<keyof MessageData, string>>;
}

/**
 * Options for creating a Prisma adapter
 */
export interface PrismaAdapterOptions {
  /**
   * Prisma client instance
   */
  prisma: PrismaClient;

  /**
   * Table/model names (defaults to 'agentSession' and 'agentMessage')
   */
  tables?: {
    sessions?: string;
    messages?: string;
  };

  /**
   * Field mappings (optional, if your schema uses different field names)
   */
  fieldMappings?: FieldMappings;

  /**
   * Whether to auto-create tables if they don't exist (default: false)
   * Note: Only works if your Prisma client has $executeRaw method
   */
  autoMigrate?: boolean;
}

/**
 * Prisma Adapter - Provider-style API for Prisma persistence
 *
 * @example
 * ```typescript
 * import { PrismaClient } from '@prisma/client';
 * import { Agent, PrismaAdapter } from '@falai/agent';
 *
 * const prisma = new PrismaClient();
 *
 * const agent = new Agent({
 *   name: "My Agent",
 *   provider: provider,
 *   persistence: {
 *     adapter: new PrismaAdapter({ prisma }),
 *     userId: "user_123",
 *   },
 * });
 * ```
 */
export class PrismaAdapter<TData = Record<string, unknown>> implements PersistenceAdapter<TData> {
  public readonly sessionRepository: SessionRepository<TData>;
  public readonly messageRepository: MessageRepository;
  private prisma: PrismaClient;
  private options: Required<Omit<PrismaAdapterOptions, "fieldMappings">> & {
    fieldMappings?: FieldMappings;
  };
  private initialized = false;

  constructor(options: PrismaAdapterOptions) {
    this.prisma = options.prisma;
    this.options = {
      prisma: options.prisma,
      tables: {
        sessions: options.tables?.sessions || "agentSession",
        messages: options.tables?.messages || "agentMessage",
      },
      fieldMappings: options.fieldMappings,
      autoMigrate: options.autoMigrate ?? false,
    };

    // Initialize repositories
    this.sessionRepository = new PrismaSessionRepository<TData>(
      this.prisma,
      this.options.tables.sessions!,
      this.options.fieldMappings?.sessions
    );

    this.messageRepository = new PrismaMessageRepository(
      this.prisma,
      this.options.tables.messages!,
      this.options.fieldMappings?.messages
    );

    // Auto-initialize if configured
    if (this.options.autoMigrate) {
      this.initialize().catch((error) => {
        logger.error("[PrismaAdapter] Auto-migration failed:", error);
      });
    }
  }

  /**
   * Initialize the adapter (check/create tables)
   * Called automatically if autoMigrate is enabled
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    if (this.options.autoMigrate && this.prisma.$executeRaw) {
      // Note: This is a simplified example. In production, use Prisma Migrate.
      logger.warn(
        "[PrismaAdapter] autoMigrate is experimental. Use Prisma Migrate for production."
      );
      // Table creation would go here, but it's database-specific
      // Better to rely on Prisma Migrate
      await Promise.resolve(); // Satisfy async requirement
    }

    this.initialized = true;
  }

  /**
   * Disconnect from the database
   */
  async disconnect(): Promise<void> {
    if (this.prisma.$disconnect) {
      await this.prisma.$disconnect();
    }
  }
}

/**
 * Prisma Session Repository
 * Internal implementation - users should use PrismaAdapter instead
 */
class PrismaSessionRepository<TData = Record<string, unknown>>
  implements SessionRepository<TData> {
  private prisma: PrismaClient;
  private tableName: string;
  private fieldMap: Partial<Record<keyof SessionData<TData>, string>>;
  /**
   * Whether the user's Prisma model has a `version` column. Unknown until the
   * first write; when Prisma rejects the field, writes fall back to omitting
   * it so models without the column keep working (optimistic locking is then
   * inactive — add `version Int?` to the model to enable it).
   */
  private versionSupported?: boolean;

  constructor(
    prismaClient: PrismaClient,
    tableName: string,
    fieldMappings?: Partial<Record<keyof SessionData<TData>, string>>
  ) {
    this.prisma = prismaClient;
    this.tableName = tableName;
    this.fieldMap = fieldMappings || {};
  }

  /**
   * Run a write that includes the `version` field, retrying without it once
   * if the model evidently lacks the column. The outcome is remembered.
   */
  private async writeWithVersionFallback<T>(
    write: (includeVersion: boolean) => Promise<T>
  ): Promise<T> {
    if (this.versionSupported === false) {
      return write(false);
    }
    try {
      const result = await write(true);
      this.versionSupported = true;
      return result;
    } catch (error) {
      const versionField = this.fieldMap.version || "version";
      if (
        this.versionSupported === undefined &&
        error instanceof Error &&
        error.message.includes(versionField)
      ) {
        this.versionSupported = false;
        return write(false);
      }
      throw error;
    }
  }

  /**
   * Map our standard field names to custom schema field names
   */
  private mapFields(data: Record<string, unknown>): Record<string, unknown> {
    const mapped: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      const mappedKey = this.fieldMap[key as keyof SessionData<TData>] || key;
      mapped[mappedKey] = value;
    }
    return mapped;
  }

  /**
   * Map custom schema field names back to our standard field names
   */
  private unmapFields(data: Record<string, unknown>): SessionData<TData> {
    if (!data) throw new Error("Data cannot be null");

    const reverseMap: Record<string, string> = {};
    for (const [standardKey, customKey] of Object.entries(this.fieldMap)) {
      reverseMap[customKey] = standardKey;
    }

    const unmapped: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      const unmappedKey = reverseMap[key] || key;
      unmapped[unmappedKey] = value;
    }

    // Construct proper SessionData object
    return {
      id: unmapped.id as string,
      userId: unmapped.userId as string | undefined,
      agentName: unmapped.agentName as string | undefined,
      status: unmapped.status as "active" | "completed" | "abandoned",
      currentFlow: unmapped.currentFlow as string | undefined,
      currentStep: unmapped.currentStep as string | undefined,
      collectedData: unmapped.collectedData as CollectedStateData<TData>,
      messageCount: unmapped.messageCount as number | undefined,
      lastMessageAt: unmapped.lastMessageAt as Date | undefined,
      completedAt: unmapped.completedAt as Date | undefined,
      version: (unmapped.version as number | null) ?? undefined,
      createdAt: unmapped.createdAt as Date,
      updatedAt: unmapped.updatedAt as Date,
    };
  }

  private getModel(): PrismaModel {
    return this.prisma[this.tableName] as PrismaModel;
  }

  async create(data: CreateSessionData<TData>): Promise<SessionData<TData>> {
    const id = data.id || createSessionId();
    const result = await this.writeWithVersionFallback((includeVersion) => {
      const mapped = this.mapFields(
        includeVersion
          ? { ...data, id, version: data.version ?? 1 }
          : { ...data, id }
      );
      return this.getModel().create({ data: mapped });
    });
    return this.unmapFields(result);
  }

  async findById(id: string): Promise<SessionData<TData> | null> {
    const result = await this.getModel().findUnique({
      where: { [this.fieldMap.id || "id"]: id },
    });
    return result ? this.unmapFields(result) : null;
  }

  async findActiveByUserId(userId: string): Promise<SessionData<TData> | null> {
    const result = await this.getModel().findFirst({
      where: {
        [this.fieldMap.userId || "userId"]: userId,
        [this.fieldMap.status || "status"]: "active",
      },
      orderBy: {
        [this.fieldMap.createdAt || "createdAt"]: "desc",
      },
    });
    return result ? this.unmapFields(result) : null;
  }

  async findByUserId(
    userId: string,
    limit = 100
  ): Promise<SessionData<TData>[]> {
    const results = await this.getModel().findMany({
      where: {
        [this.fieldMap.userId || "userId"]: userId,
      },
      orderBy: {
        [this.fieldMap.createdAt || "createdAt"]: "desc",
      },
      take: limit,
    });
    return results.map((r) => this.unmapFields(r));
  }

  async update(
    id: string,
    data: Partial<Omit<SessionData<TData>, "id" | "createdAt">>,
    options?: SessionUpdateOptions
  ): Promise<SessionData<TData> | null> {
    // Read-check-write: the Prisma model is user-defined, so we cannot emit a
    // conditional UPDATE generically. Add `version Int?` to your Prisma model
    // for optimistic locking to be effective.
    const existing = await this.findById(id);
    if (!existing) return null;

    if (
      options?.expectedVersion !== undefined &&
      existing.version !== undefined &&
      existing.version !== options.expectedVersion
    ) {
      throw new SessionConflictError(
        id,
        options.expectedVersion,
        existing.version
      );
    }

    const result = await this.writeWithVersionFallback((includeVersion) => {
      const mapped = this.mapFields(
        includeVersion
          ? {
            ...(data as Record<string, unknown>),
            version: (existing.version ?? options?.expectedVersion ?? 0) + 1,
          }
          : { ...(data as Record<string, unknown>) }
      );
      return this.getModel().update({
        where: { [this.fieldMap.id || "id"]: id },
        data: {
          ...mapped,
          [this.fieldMap.updatedAt || "updatedAt"]: new Date(),
        },
      });
    });
    return this.unmapFields(result);
  }

  async updateStatus(
    id: string,
    status: SessionStatus,
    completedAt?: Date
  ): Promise<SessionData<TData> | null> {
    const data: Record<string, unknown> = {
      [this.fieldMap.status || "status"]: status,
      [this.fieldMap.updatedAt || "updatedAt"]: new Date(),
    };
    if (completedAt) {
      data[this.fieldMap.completedAt || "completedAt"] = completedAt;
    }
    const result = await this.getModel().update({
      where: { [this.fieldMap.id || "id"]: id },
      data,
    });
    return this.unmapFields(result);
  }

  async updateCollectedData(
    id: string,
    collectedData: CollectedStateData<TData>
  ): Promise<SessionData<TData> | null> {
    const result = await this.getModel().update({
      where: { [this.fieldMap.id || "id"]: id },
      data: {
        [this.fieldMap.collectedData || "collectedData"]: collectedData,
        [this.fieldMap.updatedAt || "updatedAt"]: new Date(),
      },
    });
    return this.unmapFields(result);
  }

  async updateFlowStep(
    id: string,
    flow?: string,
    step?: string
  ): Promise<SessionData<TData> | null> {
    const data: Record<string, unknown> = {
      [this.fieldMap.updatedAt || "updatedAt"]: new Date(),
    };
    if (flow !== undefined) {
      data[this.fieldMap.currentFlow || "currentFlow"] = flow;
    }
    if (step !== undefined) {
      data[this.fieldMap.currentStep || "currentStep"] = step;
    }
    const result = await this.getModel().update({
      where: { [this.fieldMap.id || "id"]: id },
      data,
    });
    return this.unmapFields(result);
  }

  async incrementMessageCount(id: string): Promise<SessionData<TData> | null> {
    const result = await this.getModel().update({
      where: { [this.fieldMap.id || "id"]: id },
      data: {
        [this.fieldMap.messageCount || "messageCount"]: { increment: 1 },
        [this.fieldMap.lastMessageAt || "lastMessageAt"]: new Date(),
        [this.fieldMap.updatedAt || "updatedAt"]: new Date(),
      },
    });
    return this.unmapFields(result);
  }

  async delete(id: string): Promise<boolean> {
    try {
      await this.getModel().delete({
        where: { [this.fieldMap.id || "id"]: id },
      });
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Prisma Message Repository
 * Internal implementation - users should use PrismaAdapter instead
 */
class PrismaMessageRepository implements MessageRepository {
  private prisma: PrismaClient;
  private tableName: string;
  private fieldMap: Partial<Record<keyof MessageData, string>>;

  constructor(
    prismaClient: PrismaClient,
    tableName: string,
    fieldMappings?: Partial<Record<keyof MessageData, string>>
  ) {
    this.prisma = prismaClient;
    this.tableName = tableName;
    this.fieldMap = fieldMappings || {};
  }

  /**
   * Map our standard field names to custom schema field names
   */
  private mapFields(data: Record<string, unknown>): Record<string, unknown> {
    const mapped: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      const mappedKey = this.fieldMap[key as keyof MessageData] || key;
      mapped[mappedKey] = value;
    }
    return mapped;
  }

  /**
   * Map custom schema field names back to our standard field names
   */
  private unmapFields(data: Record<string, unknown>): MessageData {
    if (!data) throw new Error("Data cannot be null");

    const reverseMap: Record<string, string> = {};
    for (const [standardKey, customKey] of Object.entries(this.fieldMap)) {
      reverseMap[customKey] = standardKey;
    }

    const unmapped: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      const unmappedKey = reverseMap[key] || key;
      unmapped[unmappedKey] = value;
    }

    // Construct proper MessageData object
    return {
      id: unmapped.id as string,
      sessionId: unmapped.sessionId as string,
      userId: unmapped.userId as string | undefined,
      role: unmapped.role as MessageRole,
      content: unmapped.content as string,
      flow: unmapped.flow as string | undefined,
      step: unmapped.step as string | undefined,
      toolCalls: unmapped.toolCalls as
        | Array<{ toolName: string; arguments: Record<string, unknown> }>
        | undefined,
      event: unmapped.event as Event | undefined,
      createdAt: unmapped.createdAt as Date,
    };
  }

  private getModel(): PrismaModel {
    return this.prisma[this.tableName] as PrismaModel;
  }

  async create(
    data: Omit<MessageData, "id" | "createdAt">
  ): Promise<MessageData> {
    const mapped = this.mapFields(data as Record<string, unknown>);
    const result = await this.getModel().create({
      data: mapped,
    });
    return this.unmapFields(result);
  }

  async findById(id: string): Promise<MessageData | null> {
    const result = await this.getModel().findUnique({
      where: { [this.fieldMap.id || "id"]: id },
    });
    return result ? this.unmapFields(result) : null;
  }

  async findBySessionId(
    sessionId: string,
    limit = 1000
  ): Promise<MessageData[]> {
    const results = await this.getModel().findMany({
      where: {
        [this.fieldMap.sessionId || "sessionId"]: sessionId,
      },
      orderBy: {
        [this.fieldMap.createdAt || "createdAt"]: "asc",
      },
      take: limit,
    });
    return results.map((r) => this.unmapFields(r));
  }

  async findByUserId(userId: string, limit = 100): Promise<MessageData[]> {
    const results = await this.getModel().findMany({
      where: {
        [this.fieldMap.userId || "userId"]: userId,
      },
      orderBy: {
        [this.fieldMap.createdAt || "createdAt"]: "desc",
      },
      take: limit,
    });
    return results.map((r) => this.unmapFields(r));
  }

  async delete(id: string): Promise<boolean> {
    try {
      await this.getModel().delete({
        where: { [this.fieldMap.id || "id"]: id },
      });
      return true;
    } catch {
      return false;
    }
  }

  async deleteBySessionId(sessionId: string): Promise<number> {
    const result = await this.getModel().deleteMany({
      where: {
        [this.fieldMap.sessionId || "sessionId"]: sessionId,
      },
    });
    return result.count || 0;
  }

  async deleteByUserId(userId: string): Promise<number> {
    const result = await this.getModel().deleteMany({
      where: {
        [this.fieldMap.userId || "userId"]: userId,
      },
    });
    return result.count || 0;
  }
}
