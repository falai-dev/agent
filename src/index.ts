/**
 * @falai/agent — Conversational state engine for TypeScript
 *
 * The AI understands. The code is in control.
 */

// Core
export { Agent } from "./core/Agent";
export { createAgent } from "./core/createAgent";
export { Flow } from "./core/Flow";
export { Step, FlowConfigurationError } from "./core/Step";
export { flow } from "./core/flow-namespace";

export { adaptEvent, convertHistoryToEvents } from "./core/Events";
export { PersistenceManager } from "./core/PersistenceManager";
export { SessionManager } from "./core/SessionManager";
export { ToolManager, ToolCreationError, ToolExecutionError } from "./core/ToolManager";
export { NotImplementedError, SessionConflictError, ProviderError } from "./types/errors";
export type { ProviderErrorCode } from "./types/errors";


// Providers
export { GeminiProvider } from "./providers/GeminiProvider";
export type { GeminiProviderOptions } from "./providers/GeminiProvider";
export { OpenAIProvider } from "./providers/OpenAIProvider";
export type { OpenAIProviderOptions } from "./providers/OpenAIProvider";
export { OpenRouterProvider } from "./providers/OpenRouterProvider";
export type { OpenRouterProviderOptions } from "./providers/OpenRouterProvider";
export { AnthropicProvider } from "./providers/AnthropicProvider";
export type { AnthropicProviderOptions } from "./providers/AnthropicProvider";
export { DeepSeekProvider } from "./providers/DeepSeekProvider";
export type { DeepSeekProviderOptions } from "./providers/DeepSeekProvider";
// Base class for building OpenAI-compatible providers (Groq, Together, etc.)
export { OpenAICompatibleProvider } from "./providers/OpenAICompatibleProvider";
export type { StructuredOutputMode } from "./providers/OpenAICompatibleProvider";
export { createOpenAICompatibleProvider } from "./providers/GenericOpenAICompatibleProvider";
export type { OpenAICompatibleOptions } from "./providers/GenericOpenAICompatibleProvider";

// Adapters
export { PrismaAdapter } from "./adapters/PrismaAdapter";
export type {
  PrismaClient,
  FieldMappings,
  PrismaAdapterOptions,
} from "./adapters/PrismaAdapter";
export { RedisAdapter } from "./adapters/RedisAdapter";
export type { RedisClient, RedisAdapterOptions } from "./adapters/RedisAdapter";
export { MongoAdapter } from "./adapters/MongoAdapter";
export type {
  MongoClient,
  MongoDatabase,
  MongoCollection,
  MongoAdapterOptions,
} from "./adapters/MongoAdapter";
export { PostgreSQLAdapter } from "./adapters/PostgreSQLAdapter";
export type {
  PgClient,
  PgQueryResult,
  PostgreSQLAdapterOptions,
} from "./adapters/PostgreSQLAdapter";
export { SQLiteAdapter } from "./adapters/SQLiteAdapter";
export type {
  SqliteDatabase,
  SqliteStatement,
  SQLiteAdapterOptions,
} from "./adapters/SQLiteAdapter";
export { MemoryAdapter } from "./adapters/MemoryAdapter";
export { OpenSearchAdapter } from "./adapters/OpenSearchAdapter";
export type {
  OpenSearchClient,
  OpenSearchAdapterOptions,
} from "./adapters/OpenSearchAdapter";

// Utils
export { generateFlowId, generateStepId, generateToolId } from "./utils/id";
export { formatKnowledgeBase } from "./utils/template";
export {
  ConditionEvaluator,
  createConditionEvaluator,
  extractAIContextStrings,
  hasProgrammaticConditions
} from "./utils/condition";
export {
  historyItemToEvent,
  historyToEvents,
  eventToHistoryItem,
  eventsToHistory,
  userMessage,
  assistantMessage,
  toolMessage,
  systemMessage,
} from "./utils/history";

// Types
export type {
  AgentOptions,
  AgentCompactionConfig,
  AgentResponse,
  Term,
  Instruction,
  ScopedInstructions,
  AppliedInstruction,
  ContextLifecycleHooks,
  ContextProvider,
  HookContext,
  ExitReason,
  Event,
  EmittedEvent,
  MessageEventData,
  ToolEventData,
  StatusEventData,
  Participant,
  FlowRef,
  StepRef,
  FlowOptions,
  StepOptions,
  FlowLifecycleHooks,
  StepLifecycleHooks,
  SessionState,
  SignalsState,
  SignalTriggerState,
  Signal,
  SignalContext,
  SignalDirective,
  ResolvedSignalDirective,
  SignalPredicate,
  SignalPredicateContext,
  SignalFiring,
  SignalSchema,
  ToolContext,
  ToolResult,
  ToolHandler,
  Tool,

  ToolValidationResult,
  ToolPermissionResult,
  ToolCallRequest,
  ToolExecutionUpdate,

  CompactionOptions,
  CompactionResult,

  DataEnrichmentConfig,
  ValidationConfig,
  ValidationError,
  ApiCallConfig,
  ComputationConfig,
  ToolScope,
  AiProvider,
  ProviderCapabilities,
  GenerateMessageInput,
  GenerateMessageOutput,
  AgentStructuredResponse,
  ReasoningConfig,
  StructuredSchema,
  SessionData,
  MessageData,
  CollectedStateData,
  SessionStatus,
  SessionRepository,
  SessionUpdateOptions,
  MessageRepository,
  PersistenceConfig,
  CreateSessionOptions,
  SaveMessageOptions,
  AgentResponseStreamChunk,
  Role,
  HistoryItem,
  History,
  PersistenceAdapter,
  Template,
  TemplateContext,
  ConditionEvaluationResult,
  UserHistoryItem,
  AssistantHistoryItem,
  ToolHistoryItem,
  SystemHistoryItem,
  // Flow execution types
  StoppedReason,
  PrepareResult,
  Directive,
  BranchEntry,
  BranchMap,
  BranchPredicate,
  BranchPredicateContext,
  ConditionPredicate,
  ConditionIf,
  ConditionWhen,
} from "./types";
export { EventKind, MessageRole } from "./types";
export { createSession, createSessionId, createPersistedState, enterFlow, enterStep, completeCurrentFlow, isFlowCompletedThisSession, mergeCollected } from "./utils";
