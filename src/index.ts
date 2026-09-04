/**
 * @falai/agent — Conversational state engine for TypeScript
 *
 * The AI understands. The code is in control.
 */

// Core
export { Agent } from "./core/Agent.js";
export type { RespondParams, StreamOptions, GenerateOptions } from "./core/ResponseModal.js";
export { ResponseGenerationError } from "./core/ResponseGenerationError.js";
export type { EndedFlow } from "./types/agent.js";
export { createAgent } from "./core/createAgent.js";
export { Flow } from "./core/Flow.js";
export { Step, FlowConfigurationError } from "./core/Step.js";
export { flow } from "./core/flow-namespace.js";

export { adaptEvent, convertHistoryToEvents } from "./core/Events.js";
export { PersistenceManager } from "./core/PersistenceManager.js";
export { SessionManager } from "./core/SessionManager.js";
export { ToolManager, ToolCreationError, ToolExecutionError } from "./core/ToolManager.js";
export { NotImplementedError, SessionConflictError, ProviderError } from "./types/errors.js";
export type { ErrorKind } from "./types/errors.js";


// Providers
export { GeminiProvider } from "./providers/GeminiProvider.js";
export type { GeminiProviderOptions } from "./providers/GeminiProvider.js";
export { OpenAIProvider } from "./providers/OpenAIProvider.js";
export type { OpenAIProviderOptions } from "./providers/OpenAIProvider.js";
export { OpenRouterProvider } from "./providers/OpenRouterProvider.js";
export type { OpenRouterProviderOptions } from "./providers/OpenRouterProvider.js";
export { AnthropicProvider } from "./providers/AnthropicProvider.js";
export type { AnthropicProviderOptions } from "./providers/AnthropicProvider.js";
export { DeepSeekProvider } from "./providers/DeepSeekProvider.js";
export type { DeepSeekProviderOptions } from "./providers/DeepSeekProvider.js";
// Base class for building OpenAI-compatible providers (Groq, Together, etc.)
export { OpenAICompatibleProvider } from "./providers/OpenAICompatibleProvider.js";
export type {
  OpenAICompatibleProviderInit,
  StructuredOutputMode,
} from "./providers/OpenAICompatibleProvider.js";
export { createOpenAICompatibleProvider } from "./providers/GenericOpenAICompatibleProvider.js";
export type { OpenAICompatibleOptions } from "./providers/GenericOpenAICompatibleProvider.js";
// The bridge every provider above is built on — subclass it to bind any
// `@providerkit/core` provider to this framework's seam.
export { ProviderAdapter, resolveRetryConfig } from "./providers/ProviderAdapter.js";
export type {
  ProviderAdapterInit,
  RequestConfig,
  RetryConfig,
} from "./providers/ProviderAdapter.js";

// Adapters
export { PrismaAdapter } from "./adapters/PrismaAdapter.js";
export type {
  PrismaClient,
  FieldMappings,
  PrismaAdapterOptions,
} from "./adapters/PrismaAdapter.js";
export { RedisAdapter } from "./adapters/RedisAdapter.js";
export type { RedisClient, RedisAdapterOptions } from "./adapters/RedisAdapter.js";
export { MongoAdapter } from "./adapters/MongoAdapter.js";
export type {
  MongoClient,
  MongoDatabase,
  MongoCollection,
  MongoAdapterOptions,
} from "./adapters/MongoAdapter.js";
export { PostgreSQLAdapter } from "./adapters/PostgreSQLAdapter.js";
export type {
  PgClient,
  PgQueryResult,
  PostgreSQLAdapterOptions,
} from "./adapters/PostgreSQLAdapter.js";
export { SQLiteAdapter } from "./adapters/SQLiteAdapter.js";
export type {
  SqliteDatabase,
  SqliteStatement,
  SQLiteAdapterOptions,
} from "./adapters/SQLiteAdapter.js";
export { MemoryAdapter } from "./adapters/MemoryAdapter.js";
export { OpenSearchAdapter } from "./adapters/OpenSearchAdapter.js";
export type {
  OpenSearchClient,
  OpenSearchAdapterOptions,
} from "./adapters/OpenSearchAdapter.js";

// Utils
export { generateFlowId, generateStepId, generateToolId } from "./utils/id.js";
export { formatKnowledgeBase } from "./utils/template.js";
export {
  ConditionEvaluator,
  createConditionEvaluator,
  extractAIContextStrings,
  hasProgrammaticConditions
} from "./utils/condition.js";
export {
  historyItemToEvent,
  historyToEvents,
  eventToHistoryItem,
  eventsToHistory,
  userMessage,
  assistantMessage,
  toolMessage,
  systemMessage,
} from "./utils/history.js";

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
} from "./types/index.js";
export { EventKind, MessageRole } from "./types/index.js";
export { restoreSession, createSession, createSessionId, createPersistedState, enterFlow, enterStep, completeCurrentFlow, isFlowCompletedThisSession, mergeCollected } from "./utils/index.js";
