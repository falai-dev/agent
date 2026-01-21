/**
 * @falai/agent - Standalone AI Agent framework
 *
 * A strongly-typed, modular agent framework with route DSL and AI provider strategy
 */

// Core
export { Agent } from "./core/Agent";
export { Route } from "./core/Route";
export { Step } from "./core/Step";
export { ResponseModal } from "./core/ResponseModal";
export type { 
  ResponseModalOptions, 
  RespondParams, 
  StreamOptions, 
  GenerateOptions 
} from "./core/ResponseModal";
export { adaptEvent, convertHistoryToEvents } from "./core/Events";
export { PersistenceManager } from "./core/PersistenceManager";
export { SessionManager } from "./core/SessionManager";
export { ToolManager, ToolCreationError, ToolExecutionError } from "./core/ToolManager";
export { BatchExecutor, needsInput, type NeedsInputStep, type DetermineBatchParams } from "./core/BatchExecutor";
export { BatchPromptBuilder, type BuildBatchPromptParams, type BatchPromptResult } from "./core/BatchPromptBuilder";

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

// Constants
export { END_ROUTE, END_ROUTE_ID } from "./constants";

// Utils
export { generateRouteId, generateStepId, generateToolId } from "./utils/id";
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
  Term,
  Guideline,
  GuidelineMatch,
  ContextLifecycleHooks,
  ContextProvider,
  Event,
  EmittedEvent,
  MessageEventData,
  ToolEventData,
  StatusEventData,
  Participant,
  RouteRef,
  StepRef,
  RouteOptions,
  StepOptions,
  RouteTransitionConfig,
  RouteCompletionHandler,
  SessionState,
  PendingTransition,
  ToolContext,
  ToolResult,
  ToolHandler,
  Tool,

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
  ConditionTemplate,
  ConditionEvaluationResult,
  UserHistoryItem,
  AssistantHistoryItem,
  ToolHistoryItem,
  SystemHistoryItem,
} from "./types";
export { CompositionMode, EventKind, MessageRole } from "./types";
export { createSession, enterRoute, enterStep, mergeCollected } from "./utils";
