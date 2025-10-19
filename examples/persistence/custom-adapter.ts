/**
 * Custom Persistence Adapter Example
 *
 * This example demonstrates how to create a custom persistence adapter
 * that implements the PersistenceAdapter interface. It shows a simple
 * in-memory implementation that can be extended to use any database.
 *
 * Key concepts:
 * - Implementing PersistenceAdapter interface
 * - SessionRepository and MessageRepository interfaces
 * - Custom storage backends (database, file system, etc.)
 * - Error handling and data validation
 * - Async operations and resource management
 */

import type {
  PersistenceAdapter,
  SessionRepository,
  MessageRepository,
  SessionData,
  MessageData,
  SessionStatus,
  CollectedStateData,
} from "../../src/types";
import { Agent, GeminiProvider } from "../../src";

/**
 * Simple in-memory storage for demonstration
 * In a real implementation, this would be replaced with database calls
 */
class InMemoryStorage {
  private sessions = new Map<string, SessionData>();
  private messages = new Map<string, MessageData>();
  private sessionMessages = new Map<string, string[]>(); // sessionId -> messageIds

  // Session operations
  createSession(
    data: Omit<SessionData, "createdAt" | "updatedAt"> & {
      id?: string;
    }
  ): SessionData {
    const id =
      data.id || `session_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const session: SessionData = {
      ...data,
      id,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.sessions.set(id, session);
    return session;
  }

  getSession(id: string): SessionData | null {
    return this.sessions.get(id) || null;
  }

  getSessionsByUserId(userId: string): SessionData[] {
    return Array.from(this.sessions.values()).filter(
      (s) => s.userId === userId
    );
  }

  updateSession(id: string, updates: Partial<SessionData>): SessionData | null {
    const existing = this.sessions.get(id);
    if (!existing) return null;

    const updated = {
      ...existing,
      ...updates,
      updatedAt: new Date(),
    };
    this.sessions.set(id, updated);
    return updated;
  }

  updateSessionStatus(
    id: string,
    status: SessionStatus,
    completedAt?: Date
  ): SessionData | null {
    const existing = this.sessions.get(id);
    if (!existing) return null;

    const updated = {
      ...existing,
      status,
      completedAt:
        status === "completed"
          ? completedAt || new Date()
          : existing.completedAt,
      updatedAt: new Date(),
    };
    this.sessions.set(id, updated);
    return updated;
  }

  updateCollectedData(
    id: string,
    collectedData: CollectedStateData<Record<string, unknown>>
  ): SessionData<Record<string, unknown>> | null {
    const existing = this.sessions.get(id);
    if (!existing) return null;

    const updated: SessionData<Record<string, unknown>> = {
      ...existing,
      collectedData: {
        ...(existing.collectedData || {}),
        ...collectedData,
      },
      updatedAt: new Date(),
    };
    this.sessions.set(id, updated);
    return updated;
  }

  updateRouteStep(
    id: string,
    route?: string,
    step?: string
  ): SessionData | null {
    const existing = this.sessions.get(id);
    if (!existing) return null;

    const updated = {
      ...existing,
      currentRoute: route,
      currentStep: step,
      updatedAt: new Date(),
    };
    this.sessions.set(id, updated);
    return updated;
  }

  incrementMessageCount(id: string): SessionData | null {
    const existing = this.sessions.get(id);
    if (!existing) return null;

    const updated = {
      ...existing,
      messageCount: (existing.messageCount || 0) + 1,
      lastMessageAt: new Date(),
      updatedAt: new Date(),
    };
    this.sessions.set(id, updated);
    return updated;
  }

  deleteSession(id: string): boolean {
    return this.sessions.delete(id);
  }

  // Message operations
  createMessage(data: Omit<MessageData, "id" | "createdAt">): MessageData {
    const id = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const message: MessageData = {
      ...data,
      id,
      createdAt: new Date(),
    };
    this.messages.set(id, message);

    // Track messages by session
    const sessionMessages = this.sessionMessages.get(data.sessionId) || [];
    sessionMessages.push(id);
    this.sessionMessages.set(data.sessionId, sessionMessages);

    return message;
  }

  getMessage(id: string): MessageData | null {
    return this.messages.get(id) || null;
  }

  getMessagesBySessionId(sessionId: string): MessageData[] {
    const messageIds = this.sessionMessages.get(sessionId) || [];
    return messageIds
      .map((id) => this.messages.get(id))
      .filter((msg): msg is MessageData => msg !== undefined)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  getMessagesByUserId(userId: string): MessageData[] {
    return Array.from(this.messages.values())
      .filter((msg) => msg.userId === userId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  deleteMessage(id: string): boolean {
    const message = this.messages.get(id);
    if (!message) return false;

    this.messages.delete(id);

    // Remove from session tracking
    const sessionMessages = this.sessionMessages.get(message.sessionId) || [];
    const filtered = sessionMessages.filter((msgId) => msgId !== id);
    if (filtered.length === 0) {
      this.sessionMessages.delete(message.sessionId);
    } else {
      this.sessionMessages.set(message.sessionId, filtered);
    }

    return true;
  }

  deleteMessagesBySessionId(sessionId: string): number {
    const messageIds = this.sessionMessages.get(sessionId) || [];
    let deletedCount = 0;

    for (const messageId of messageIds) {
      if (this.messages.delete(messageId)) {
        deletedCount++;
      }
    }

    this.sessionMessages.delete(sessionId);
    return deletedCount;
  }

  deleteMessagesByUserId(userId: string): number {
    const messagesToDelete = Array.from(this.messages.values()).filter(
      (msg) => msg.userId === userId
    );

    let deletedCount = 0;
    for (const message of messagesToDelete) {
      if (this.messages.delete(message.id)) {
        // Remove from session tracking
        const sessionMessages =
          this.sessionMessages.get(message.sessionId) || [];
        const filtered = sessionMessages.filter(
          (msgId) => msgId !== message.id
        );
        if (filtered.length === 0) {
          this.sessionMessages.delete(message.sessionId);
        } else {
          this.sessionMessages.set(message.sessionId, filtered);
        }
        deletedCount++;
      }
    }

    return deletedCount;
  }
}

/**
 * Custom Session Repository implementation
 */
class CustomSessionRepository<TData = Record<string, unknown>>
  implements SessionRepository<TData>
{
  constructor(private storage: InMemoryStorage) {}

  async create(
    data: Omit<SessionData<TData>, "createdAt" | "updatedAt"> & {
      id?: string;
    }
  ): Promise<SessionData<TData>> {
    return Promise.resolve(
      this.storage.createSession({
        ...data,
        id:
          data.id ||
          `session_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      }) as SessionData<TData>
    );
  }

  async findById(id: string): Promise<SessionData<TData> | null> {
    return Promise.resolve(
      this.storage.getSession(id) as SessionData<TData> | null
    );
  }

  async findActiveByUserId(userId: string): Promise<SessionData<TData> | null> {
    const sessions = this.storage.getSessionsByUserId(userId);
    return Promise.resolve(
      (sessions.find((s) => s.status === "active") as SessionData<TData>) ||
        null
    );
  }

  async findByUserId(
    userId: string,
    limit = 50
  ): Promise<SessionData<TData>[]> {
    const sessions = this.storage.getSessionsByUserId(userId);
    return Promise.resolve(
      sessions
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
        .slice(0, limit) as SessionData<TData>[]
    );
  }

  async update(
    id: string,
    data: Partial<Omit<SessionData<TData>, "id" | "createdAt">>
  ): Promise<SessionData<TData> | null> {
    return Promise.resolve(
      this.storage.updateSession(id, data) as SessionData<TData> | null
    );
  }

  async updateStatus(
    id: string,
    status: SessionStatus,
    completedAt?: Date
  ): Promise<SessionData<TData> | null> {
    return Promise.resolve(
      this.storage.updateSessionStatus(
        id,
        status,
        completedAt
      ) as SessionData<TData> | null
    );
  }

  async updateCollectedData(
    id: string,
    collectedData: CollectedStateData<TData>
  ): Promise<SessionData<TData> | null> {
    return Promise.resolve(
      this.storage.updateCollectedData(
        id,
        collectedData
      ) as SessionData<TData> | null
    );
  }

  async updateRouteStep(
    id: string,
    route?: string,
    step?: string
  ): Promise<SessionData<TData> | null> {
    return Promise.resolve(
      this.storage.updateRouteStep(id, route, step) as SessionData<TData> | null
    );
  }

  async incrementMessageCount(id: string): Promise<SessionData<TData> | null> {
    return Promise.resolve(
      this.storage.incrementMessageCount(id) as SessionData<TData> | null
    );
  }

  async delete(id: string): Promise<boolean> {
    return Promise.resolve(this.storage.deleteSession(id));
  }
}

/**
 * Custom Message Repository implementation
 */
class CustomMessageRepository implements MessageRepository {
  constructor(private storage: InMemoryStorage) {}

  async create(
    data: Omit<MessageData, "id" | "createdAt">
  ): Promise<MessageData> {
    return Promise.resolve(this.storage.createMessage(data));
  }

  async findById(id: string): Promise<MessageData | null> {
    return Promise.resolve(this.storage.getMessage(id));
  }

  async findBySessionId(
    sessionId: string,
    limit = 100
  ): Promise<MessageData[]> {
    const messages = this.storage.getMessagesBySessionId(sessionId);
    return Promise.resolve(messages.slice(-limit)); // Get most recent messages
  }

  async findByUserId(userId: string, limit = 100): Promise<MessageData[]> {
    const messages = this.storage.getMessagesByUserId(userId);
    return Promise.resolve(messages.slice(-limit)); // Get most recent messages
  }

  async delete(id: string): Promise<boolean> {
    return Promise.resolve(this.storage.deleteMessage(id));
  }

  async deleteBySessionId(sessionId: string): Promise<number> {
    return Promise.resolve(this.storage.deleteMessagesBySessionId(sessionId));
  }

  async deleteByUserId(userId: string): Promise<number> {
    return Promise.resolve(this.storage.deleteMessagesByUserId(userId));
  }
}

/**
 * Custom Persistence Adapter
 *
 * This adapter demonstrates how to implement a custom persistence layer.
 * Replace the InMemoryStorage with actual database calls for production use.
 */
export class CustomAdapter<TData = Record<string, unknown>>
  implements PersistenceAdapter<TData>
{
  private storage = new InMemoryStorage();

  readonly sessionRepository: SessionRepository<TData>;
  readonly messageRepository: MessageRepository;

  constructor() {
    this.sessionRepository = new CustomSessionRepository<TData>(this.storage);
    this.messageRepository = new CustomMessageRepository(this.storage);
  }

  /**
   * Initialize the adapter (create tables, indexes, etc.)
   */
  async initialize(): Promise<void> {
    console.log("🔧 Initializing CustomAdapter...");
    // In a real implementation, you might:
    // - Create database tables
    // - Set up indexes
    // - Run migrations
    // - Establish database connections

    // For this demo, we just log
    console.log("✅ CustomAdapter initialized");
    return Promise.resolve();
  }

  /**
   * Disconnect/cleanup resources
   */
  async disconnect(): Promise<void> {
    console.log("🔌 Disconnecting CustomAdapter...");
    // In a real implementation, you might:
    // - Close database connections
    // - Clean up resources
    // - Flush pending writes

    console.log("✅ CustomAdapter disconnected");
    return Promise.resolve();
  }
}

// ==============================================================================
// USAGE EXAMPLE
// ==============================================================================

/**
 * Example: Using Custom Adapter with Agent
 */
async function demonstrateCustomAdapter() {
  console.log("🗄️  Custom Persistence Adapter Demo");
  console.log("=".repeat(50));

  // Create custom adapter
  const adapter = new CustomAdapter();

  // Initialize adapter
  await adapter.initialize();

  // Create agent with custom persistence
  const agent = new Agent({
    name: "CustomPersistenceAgent",
    description: "Agent with custom persistence adapter",
    provider: new GeminiProvider({
      apiKey: process.env.GEMINI_API_KEY || "demo-key",
      model: "models/gemini-2.5-flash",
    }),
    persistence: {
      adapter,
      // Optional: configure auto-save behavior
      autoSave: true, // Auto-saves session step after each response
    },
  });

  // Session is automatically managed by the agent
  console.log("✨ Session ready:", agent.session.id);

  // First interaction
  console.log("\n💬 First interaction:");
  
  await agent.session.addMessage("user", "Hi, I need help booking a flight", "Alice");
  
  const response1 = await agent.respond({
    history: agent.session.getHistory(),
  });

  console.log(`Agent: ${response1.message}`);
  console.log(`Session ID: ${agent.session.id}`);

  await agent.session.addMessage("assistant", response1.message);

  // Second interaction
  console.log("\n💬 Second interaction:");
  
  await agent.session.addMessage("user", "I want to fly to Paris next week", "Alice");
  
  const response2 = await agent.respond({
    history: agent.session.getHistory(),
  });

  console.log(`Agent: ${response2.message}`);

  // Check persistence
  console.log("\n💾 Checking persistence:");
  if (response2.session?.id) {
    const savedSession = await adapter.sessionRepository.findById(
      response2.session.id
    );
    const messages = await adapter.messageRepository.findBySessionId(
      response2.session.id
    );

    console.log(`Saved session: ${savedSession?.id}`);
    console.log(`Messages in session: ${messages.length}`);
    console.log(`Session status: ${savedSession?.status}`);
  }

  // Clean up
  await adapter.disconnect();

  console.log("\n✅ Demo complete!");
}

// Run the demo
if (import.meta.url === `file://${process.argv[1]}`) {
  demonstrateCustomAdapter().catch(console.error);
}
