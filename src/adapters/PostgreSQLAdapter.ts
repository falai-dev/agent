/**
 * PostgreSQL adapter for persistence
 * Raw SQL adapter for PostgreSQL with custom schemas
 */

import type {
  SessionRepository,
  MessageRepository,
  SessionData,
  MessageData,
  SessionStatus,
  PersistenceAdapter,
} from "../types/persistence";

/**
 * PostgreSQL query result interface
 */
export interface PgQueryResult<T = Record<string, unknown>> {
  rows: T[];
  rowCount: number;
}

/**
 * PostgreSQL client interface - matches pg (node-postgres)
 */
export interface PgClient {
  query<T = Record<string, unknown>>(
    sql: string,
    values?: unknown[]
  ): Promise<PgQueryResult<T>>;
  end(): Promise<void>;
}

/**
 * Options for PostgreSQL adapter
 */
export interface PostgreSQLAdapterOptions {
  /**
   * PostgreSQL client instance (from 'pg' package)
   */
  client: PgClient;

  /**
   * Table names (default: "agent_sessions" and "agent_messages")
   */
  tables?: {
    sessions?: string;
    messages?: string;
  };
}

/**
 * PostgreSQL Adapter - Provider-style API for PostgreSQL persistence
 *
 * @example
 * ```typescript
 * import { Client } from 'pg';
 * import { Agent, PostgreSQLAdapter } from '@falai/agent';
 *
 * const client = new Client({
 *   host: 'localhost',
 *   port: 5432,
 *   database: 'myapp',
 *   user: 'postgres',
 *   password: 'password',
 * });
 * await client.connect();
 *
 * const agent = new Agent({
 *   name: "My Agent",
 *   ai: provider,
 *   persistence: {
 *     adapter: new PostgreSQLAdapter({ client }),
 *     userId: "user_123",
 *   },
 * });
 * ```
 */
export class PostgreSQLAdapter implements PersistenceAdapter {
  public readonly sessionRepository: SessionRepository;
  public readonly messageRepository: MessageRepository;
  private client: PgClient;

  constructor(options: PostgreSQLAdapterOptions) {
    this.client = options.client;

    const sessionTable = options.tables?.sessions || "agent_sessions";
    const messageTable = options.tables?.messages || "agent_messages";

    this.sessionRepository = new PostgreSQLSessionRepository(
      this.client,
      sessionTable
    );

    this.messageRepository = new PostgreSQLMessageRepository(
      this.client,
      messageTable
    );
  }

  async initialize(): Promise<void> {
    // Create tables if they don't exist
    const sessionTable = "agent_sessions";
    const messageTable = "agent_messages";

    await this.client.query(`
      CREATE TABLE IF NOT EXISTS ${sessionTable} (
        id VARCHAR(255) PRIMARY KEY,
        user_id VARCHAR(255),
        agent_name VARCHAR(255),
        status VARCHAR(50) DEFAULT 'active',
        current_route VARCHAR(255),
        current_step VARCHAR(255),
        collected_data JSONB,
        message_count INTEGER DEFAULT 0,
        last_message_at TIMESTAMP,
        completed_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await this.client.query(`
      CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON ${sessionTable}(user_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_status ON ${sessionTable}(status);
    `);

    await this.client.query(`
      CREATE TABLE IF NOT EXISTS ${messageTable} (
        id VARCHAR(255) PRIMARY KEY,
        session_id VARCHAR(255) NOT NULL,
        user_id VARCHAR(255),
        role VARCHAR(50) NOT NULL,
        content TEXT NOT NULL,
        route VARCHAR(255),
        step VARCHAR(255),
        tool_calls JSONB,
        event JSONB,
        created_at TIMESTAMP DEFAULT NOW(),
        FOREIGN KEY (session_id) REFERENCES ${sessionTable}(id) ON DELETE CASCADE
      )
    `);

    await this.client.query(`
      CREATE INDEX IF NOT EXISTS idx_messages_session_id ON ${messageTable}(session_id);
      CREATE INDEX IF NOT EXISTS idx_messages_user_id ON ${messageTable}(user_id);
    `);
  }

  async disconnect(): Promise<void> {
    await this.client.end();
  }
}

/**
 * PostgreSQL Session Repository
 */
class PostgreSQLSessionRepository implements SessionRepository {
  constructor(private client: PgClient, private tableName: string) {}

  async create(
    data: Omit<SessionData, "id" | "createdAt" | "updatedAt">
  ): Promise<SessionData> {
    const id = `session_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const now = new Date();

    const result = await this.client.query<SessionData>(
      `INSERT INTO ${this.tableName} 
       (id, user_id, agent_name, status, collected_data, message_count, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        id,
        data.userId || null,
        data.agentName || null,
        data.status || "active",
        JSON.stringify(data.collectedData || {}),
        data.messageCount || 0,
        now,
        now,
      ]
    );

    return result.rows[0];
  }

  async findById(id: string): Promise<SessionData | null> {
    const result = await this.client.query<SessionData>(
      `SELECT * FROM ${this.tableName} WHERE id = $1`,
      [id]
    );

    return result.rows[0] || null;
  }

  async findActiveByUserId(userId: string): Promise<SessionData | null> {
    const result = await this.client.query<SessionData>(
      `SELECT * FROM ${this.tableName} 
       WHERE user_id = $1 AND status = 'active'
       ORDER BY created_at DESC
       LIMIT 1`,
      [userId]
    );

    return result.rows[0] || null;
  }

  async findByUserId(userId: string, limit = 100): Promise<SessionData[]> {
    const result = await this.client.query<SessionData>(
      `SELECT * FROM ${this.tableName} 
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [userId, limit]
    );

    return result.rows;
  }

  async update(
    id: string,
    data: Partial<Omit<SessionData, "id" | "createdAt">>
  ): Promise<SessionData | null> {
    const fields: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (data.status !== undefined) {
      fields.push(`status = $${paramIndex++}`);
      values.push(data.status);
    }
    if (data.collectedData !== undefined) {
      fields.push(`collected_data = $${paramIndex++}`);
      values.push(JSON.stringify(data.collectedData));
    }
    if (data.currentRoute !== undefined) {
      fields.push(`current_route = $${paramIndex++}`);
      values.push(data.currentRoute);
    }
    if (data.currentStep !== undefined) {
      fields.push(`current_step = $${paramIndex++}`);
      values.push(data.currentStep);
    }
    if (data.messageCount !== undefined) {
      fields.push(`message_count = $${paramIndex++}`);
      values.push(data.messageCount);
    }
    if (data.lastMessageAt !== undefined) {
      fields.push(`last_message_at = $${paramIndex++}`);
      values.push(data.lastMessageAt);
    }
    if (data.completedAt !== undefined) {
      fields.push(`completed_at = $${paramIndex++}`);
      values.push(data.completedAt);
    }

    fields.push(`updated_at = $${paramIndex++}`);
    values.push(new Date());

    values.push(id);

    const result = await this.client.query<SessionData>(
      `UPDATE ${this.tableName} 
       SET ${fields.join(", ")}
       WHERE id = $${paramIndex}
       RETURNING *`,
      values
    );

    return result.rows[0] || null;
  }

  async updateStatus(
    id: string,
    status: SessionStatus,
    completedAt?: Date
  ): Promise<SessionData | null> {
    return await this.update(id, { status, completedAt });
  }

  async updateCollectedData(
    id: string,
    collectedData: Record<string, unknown>
  ): Promise<SessionData | null> {
    return await this.update(id, { collectedData });
  }

  async updateRouteStep(
    id: string,
    route?: string,
    step?: string
  ): Promise<SessionData | null> {
    return await this.update(id, {
      currentRoute: route,
      currentStep: step,
    });
  }

  async incrementMessageCount(id: string): Promise<SessionData | null> {
    const result = await this.client.query<SessionData>(
      `UPDATE ${this.tableName}
       SET message_count = message_count + 1,
           last_message_at = NOW(),
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [id]
    );

    return result.rows[0] || null;
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.client.query(
      `DELETE FROM ${this.tableName} WHERE id = $1`,
      [id]
    );

    return result.rowCount > 0;
  }
}

/**
 * PostgreSQL Message Repository
 */
class PostgreSQLMessageRepository implements MessageRepository {
  constructor(private client: PgClient, private tableName: string) {}

  async create(
    data: Omit<MessageData, "id" | "createdAt">
  ): Promise<MessageData> {
    const id = `msg_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    const result = await this.client.query<MessageData>(
      `INSERT INTO ${this.tableName}
       (id, session_id, user_id, role, content, route, step, tool_calls, event, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
       RETURNING *`,
      [
        id,
        data.sessionId,
        data.userId || null,
        data.role,
        data.content,
        data.route || null,
        data.step || null,
        JSON.stringify(data.toolCalls || null),
        JSON.stringify(data.event || null),
      ]
    );

    return result.rows[0];
  }

  async findById(id: string): Promise<MessageData | null> {
    const result = await this.client.query<MessageData>(
      `SELECT * FROM ${this.tableName} WHERE id = $1`,
      [id]
    );

    return result.rows[0] || null;
  }

  async findBySessionId(
    sessionId: string,
    limit = 1000
  ): Promise<MessageData[]> {
    const result = await this.client.query<MessageData>(
      `SELECT * FROM ${this.tableName}
       WHERE session_id = $1
       ORDER BY created_at ASC
       LIMIT $2`,
      [sessionId, limit]
    );

    return result.rows;
  }

  async findByUserId(userId: string, limit = 100): Promise<MessageData[]> {
    const result = await this.client.query<MessageData>(
      `SELECT * FROM ${this.tableName}
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [userId, limit]
    );

    return result.rows;
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.client.query(
      `DELETE FROM ${this.tableName} WHERE id = $1`,
      [id]
    );

    return result.rowCount > 0;
  }

  async deleteBySessionId(sessionId: string): Promise<number> {
    const result = await this.client.query(
      `DELETE FROM ${this.tableName} WHERE session_id = $1`,
      [sessionId]
    );

    return result.rowCount;
  }

  async deleteByUserId(userId: string): Promise<number> {
    const result = await this.client.query(
      `DELETE FROM ${this.tableName} WHERE user_id = $1`,
      [userId]
    );

    return result.rowCount;
  }
}
