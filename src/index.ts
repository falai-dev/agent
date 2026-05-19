/**
 * @falai/agent - Standalone AI Agent framework
 *
 * A strongly-typed, modular agent framework with flow DSL and AI provider strategy
 */

// Core
export { Agent } from "./core/Agent";
export { createAgent } from "./core/createAgent";
export { Flow } from "./core/Flow";
export { Step, FlowConfigurationError } from "./core/Step";
export { flow } from "./core/flow-namespace";
export { DirectiveChainTracker } from "./core/DirectiveChainTracker";
export type { DirectiveChainEntry } from "./core/DirectiveChainTracker";

export { adaptEvent, convertHistoryToEvents } from "./core/Events";
export { PersistenceManager } from "./core/PersistenceManager";
export { SessionManager } from "./core/SessionManager";
export { ToolManager, ToolCreationError, ToolExecutionError } from "./core/ToolManager";
export { NotImplementedError } from "./types/errors";

export { StreamingToolExecutor } from "./core/StreamingToolExecutor";


// Providers
export { GeminiProvider } from "./providers/GeminiProvider";
export type { GeminiProviderOptions } from "./providers/GeminiProvider";
export { OpenAIProvider } from "./providers/OpenAIProvider";
export type { OpenAIProviderOptions } from "./providers/OpenAIProvider";
export { OpenRouterProvider } from "./providers/OpenRouterProvider";
export type { OpenRouterProviderOptions } from "./providers/OpenRouterProvider";
export { AnthropicProvider } from "./providers/AnthropicProvider";
export type { AnthropicProviderOptions } from "./providers/AnthropicProvider";

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
  SqliteStepment,
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
  normalizeHistory,
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
  PreDirective,
  BranchEntry,
  BranchMap,
  BranchPredicate,
  BranchPredicateContext,
  ConditionPredicate,
  ConditionIf,
  ConditionWhen,
} from "./types";
export { CompositionMode, EventKind, MessageRole } from "./types";
export { createSession, createSessionId, enterFlow, enterStep, completeCurrentFlow, isFlowCompletedThisSession, mergeCollected } from "./utils";
