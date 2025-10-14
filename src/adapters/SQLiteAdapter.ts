/**
 * SQLite adapter for persistence
 * Lightweight, file-based database perfect for local development
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
 * SQLite database interface - matches better-sqlite3
 */
export interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  close(): void;
}

/**
 * SQLite statement interface
 */
export interface SqliteStatement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number };
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Array<Record<string, unknown>>;
}

/**
 * Options for SQLite adapter
 */
export interface SQLiteAdapterOptions {
  /**
   * SQLite database instance (better-sqlite3)
   */
  db: SqliteDatabase;

  /**
   * Table names (default: "agent_sessions" and "agent_messages")
   */
  tables?: {
    sessions?: string;
    messages?: string;
  };
}

/**
 * SQLite Adapter - Provider-style API for SQLite persistence
 *
 * @example
 * ```typescript
 * import Database from 'better-sqlite3';
 * import { Agent, SQLiteAdapter } from '@falai/agent';
 *
 * const db = new Database('agent.db');
 *
 * const agent = new Agent({
 *   name: "My Agent",
 *   ai: provider,
 *   persistence: {
 *     adapter: new SQLiteAdapter({ db }),
 *     userId: "user_123",
 *   },
 * });
 * ```
 */
export class SQLiteAdapter implements PersistenceAdapter {
  public readonly sessionRepository: SessionRepository;
  public readonly messageRepository: MessageRepository;
  private db: SqliteDatabase;

  constructor(options: SQLiteAdapterOptions) {
    this.db = options.db;

    const sessionTable = options.tables?.sessions || "agent_sessions";
    const messageTable = options.tables?.messages || "agent_messages";

    this.sessionRepository = new SQLiteSessionRepository(this.db, sessionTable);
    this.messageRepository = new SQLiteMessageRepository(this.db, messageTable);
  }

  async initialize(): Promise<void> {
    const sessionTable = "agent_sessions";
    const messageTable = "agent_messages";

    // Create sessions table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${sessionTable} (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        agent_name TEXT,
        status TEXT DEFAULT 'active',
        current_route TEXT,
        current_state TEXT,
        collected_data TEXT,
        message_count INTEGER DEFAULT 0,
        last_message_at TEXT,
        completed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    // Create indexes for sessions
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON ${sessionTable}(user_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_status ON ${sessionTable}(status);
    `);

    // Create messages table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${messageTable} (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        user_id TEXT,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        route TEXT,
        state TEXT,
        tool_calls TEXT,
        event TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES ${sessionTable}(id) ON DELETE CASCADE
      )
    `);

    // Create indexes for messages
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_session_id ON ${messageTable}(session_id);
      CREATE INDEX IF NOT EXISTS idx_messages_user_id ON ${messageTable}(user_id);
    `);
    await Promise.resolve();
  }

  async disconnect(): Promise<void> {
    this.db.close();
    await Promise.resolve();
  }
}

/**
 * SQLite Session Repository
 */
class SQLiteSessionRepository implements SessionRepository {
  constructor(private db: SqliteDatabase, private tableName: string) {}

  create(
    data: Omit<SessionData, "id" | "createdAt" | "updatedAt">
  ): Promise<SessionData> {
    const id = `session_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const now = new Date();

    const session: SessionData = {
      ...data,
      id,
      status: data.status || "active",
      messageCount: data.messageCount || 0,
      createdAt: now,
      updatedAt: now,
    };

    const stmt = this.db.prepare(`
      INSERT INTO ${this.tableName} 
      (id, user_id, agent_name, status, collected_data, message_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      data.userId || null,
      data.agentName || null,
      session.status,
      JSON.stringify(data.collectedData || {}),
      session.messageCount,
      now.toISOString(),
      now.toISOString()
    );

    return Promise.resolve(session);
  }

  findById(id: string): Promise<SessionData | null> {
    const stmt = this.db.prepare(
      `SELECT * FROM ${this.tableName} WHERE id = ?`
    );
    const row = stmt.get(id);
    return Promise.resolve(row ? this.deserializeSession(row) : null);
  }

  findActiveByUserId(userId: string): Promise<SessionData | null> {
    const stmt = this.db.prepare(
      `SELECT * FROM ${this.tableName} 
       WHERE user_id = ? AND status = 'active'
       ORDER BY created_at DESC
       LIMIT 1`
    );
    const row = stmt.get(userId);
    return Promise.resolve(row ? this.deserializeSession(row) : null);
  }

  findByUserId(userId: string, limit = 100): Promise<SessionData[]> {
    const stmt = this.db.prepare(
      `SELECT * FROM ${this.tableName} 
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT ?`
    );
    const rows = stmt.all(userId, limit);
    return Promise.resolve(rows.map((row) => this.deserializeSession(row)));
  }

  async update(
    id: string,
    data: Partial<Omit<SessionData, "id" | "createdAt">>
  ): Promise<SessionData | null> {
    const fields: string[] = [];
    const values: unknown[] = [];

    if (data.status !== undefined) {
      fields.push("status = ?");
      values.push(data.status);
    }
    if (data.collectedData !== undefined) {
      fields.push("collected_data = ?");
      values.push(JSON.stringify(data.collectedData));
    }
    if (data.currentRoute !== undefined) {
      fields.push("current_route = ?");
      values.push(data.currentRoute);
    }
    if (data.currentState !== undefined) {
      fields.push("current_state = ?");
      values.push(data.currentState);
    }
    if (data.messageCount !== undefined) {
      fields.push("message_count = ?");
      values.push(data.messageCount);
    }
    if (data.lastMessageAt !== undefined) {
      fields.push("last_message_at = ?");
      values.push(data.lastMessageAt.toISOString());
    }
    if (data.completedAt !== undefined) {
      fields.push("completed_at = ?");
      values.push(data.completedAt.toISOString());
    }

    fields.push("updated_at = ?");
    values.push(new Date().toISOString());

    values.push(id);

    const stmt = this.db.prepare(
      `UPDATE ${this.tableName} 
       SET ${fields.join(", ")}
       WHERE id = ?`
    );

    const result = stmt.run(...values);
    if (result.changes === 0) return null;

    return await this.findById(id);
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

  async updateRouteState(
    id: string,
    route?: string,
    state?: string
  ): Promise<SessionData | null> {
    return await this.update(id, {
      currentRoute: route,
      currentState: state,
    });
  }

  async incrementMessageCount(id: string): Promise<SessionData | null> {
    const stmt = this.db.prepare(
      `UPDATE ${this.tableName}
       SET message_count = message_count + 1,
           last_message_at = ?,
           updated_at = ?
       WHERE id = ?`
    );

    const now = new Date();
    const result = stmt.run(now.toISOString(), now.toISOString(), id);

    if (result.changes === 0) return null;
    return await this.findById(id);
  }

  delete(id: string): Promise<boolean> {
    const stmt = this.db.prepare(`DELETE FROM ${this.tableName} WHERE id = ?`);
    const result = stmt.run(id);
    return Promise.resolve(result.changes > 0);
  }

  private deserializeSession(row: Record<string, unknown>): SessionData {
    return {
      id: row.id as string,
      userId: (row.user_id as string) || undefined,
      agentName: (row.agent_name as string) || undefined,
      status: row.status as SessionStatus,
      currentRoute: (row.current_route as string) || undefined,
      currentState: (row.current_state as string) || undefined,
      collectedData: row.collected_data
        ? (JSON.parse(row.collected_data as string) as Record<string, unknown>)
        : undefined,
      messageCount: (row.message_count as number) || 0,
      lastMessageAt: row.last_message_at
        ? new Date(row.last_message_at as string)
        : undefined,
      completedAt: row.completed_at
        ? new Date(row.completed_at as string)
        : undefined,
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string),
    };
  }
}

/**
 * SQLite Message Repository
 */
class SQLiteMessageRepository implements MessageRepository {
  constructor(private db: SqliteDatabase, private tableName: string) {}

  create(data: Omit<MessageData, "id" | "createdAt">): Promise<MessageData> {
    const id = `msg_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const now = new Date();

    const message: MessageData = {
      ...data,
      id,
      createdAt: now,
    };

    const stmt = this.db.prepare(`
      INSERT INTO ${this.tableName}
      (id, session_id, user_id, role, content, route, state, tool_calls, event, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      data.sessionId,
      data.userId || null,
      data.role,
      data.content,
      data.route || null,
      data.state || null,
      JSON.stringify(data.toolCalls || null),
      JSON.stringify(data.event || null),
      now.toISOString()
    );

    return Promise.resolve(message);
  }

  findById(id: string): Promise<MessageData | null> {
    const stmt = this.db.prepare(
      `SELECT * FROM ${this.tableName} WHERE id = ?`
    );
    const row = stmt.get(id);
    return Promise.resolve(row ? this.deserializeMessage(row) : null);
  }

  findBySessionId(sessionId: string, limit = 1000): Promise<MessageData[]> {
    const stmt = this.db.prepare(
      `SELECT * FROM ${this.tableName}
       WHERE session_id = ?
       ORDER BY created_at ASC
       LIMIT ?`
    );
    const rows = stmt.all(sessionId, limit);
    return Promise.resolve(rows.map((row) => this.deserializeMessage(row)));
  }

  findByUserId(userId: string, limit = 100): Promise<MessageData[]> {
    const stmt = this.db.prepare(
      `SELECT * FROM ${this.tableName}
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT ?`
    );
    const rows = stmt.all(userId, limit);
    return Promise.resolve(rows.map((row) => this.deserializeMessage(row)));
  }

  delete(id: string): Promise<boolean> {
    const stmt = this.db.prepare(`DELETE FROM ${this.tableName} WHERE id = ?`);
    const result = stmt.run(id);
    return Promise.resolve(result.changes > 0);
  }

  deleteBySessionId(sessionId: string): Promise<number> {
    const stmt = this.db.prepare(
      `DELETE FROM ${this.tableName} WHERE session_id = ?`
    );
    const result = stmt.run(sessionId);
    return Promise.resolve(result.changes);
  }

  deleteByUserId(userId: string): Promise<number> {
    const stmt = this.db.prepare(
      `DELETE FROM ${this.tableName} WHERE user_id = ?`
    );
    const result = stmt.run(userId);
    return Promise.resolve(result.changes);
  }

  private deserializeMessage(row: Record<string, unknown>): MessageData {
    return {
      id: row.id as string,
      sessionId: row.session_id as string,
      userId: (row.user_id as string) || undefined,
      role: row.role as MessageData["role"],
      content: row.content as string,
      route: (row.route as string) || undefined,
      state: (row.state as string) || undefined,
      toolCalls: row.tool_calls
        ? (JSON.parse(row.tool_calls as string) as MessageData["toolCalls"])
        : undefined,
      event: row.event
        ? (JSON.parse(row.event as string) as MessageData["event"])
        : undefined,
      createdAt: new Date(row.created_at as string),
    };
  }
}
