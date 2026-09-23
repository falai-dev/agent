/**
 * @falai/agent — Conversational state engine for TypeScript
 *
 * The AI understands. The code is in control.
 */

// Core
export { falai } from "./core/falai.js";
export type { DataOf, Falai, FalaiRoot } from "./core/falai.js";
export { Agent } from "./core/Agent.js";
export {
  FlowConfigurationError,
  ProviderError,
  SessionConflictError,
} from "./types/errors.js";
export type { ErrorKind } from "./types/errors.js";

// Stored flows as JSON
export { flowSpecSchema, fromSpec, toSpec, validateFlow } from "./core/FlowSpec.js";
export type { BranchSpec, FlowSpec, InstructionSpec, Registries, StepKind, StepSpec, TriggerSpec } from "./core/FlowSpec.js";

// Time: a clock you control and an in-memory scheduler (tests, playground)
export { fakeClock, MemoryScheduler } from "./utils/clock.js";
export type { FakeClock } from "./utils/clock.js";
export { assertDuration, isDuration, parseDuration } from "./utils/duration.js";
export { OUTCOME_MESSAGES } from "./utils/outcomes.js";

// Sessions: reading stored blobs and the seven stores
export { assertSession, InvalidSessionError, migrateSession } from "./core/Migrate.js";
export type { MigrateOptions } from "./core/Migrate.js";
export { MemoryStore } from "./persistence/MemoryStore.js";
export { PostgresStore } from "./persistence/PostgresStore.js";
export type { PgClient, PgQueryResult, PostgresStoreOptions } from "./persistence/PostgresStore.js";
export { PrismaStore } from "./persistence/PrismaStore.js";
export type { PrismaClient, PrismaSessionField, PrismaSessionModel, PrismaStoreOptions } from "./persistence/PrismaStore.js";
export { RedisStore } from "./persistence/RedisStore.js";
export type { RedisClient, RedisStoreOptions } from "./persistence/RedisStore.js";
export { MongoStore } from "./persistence/MongoStore.js";
export type { MongoClient, MongoCollection, MongoDatabase, MongoStoreOptions } from "./persistence/MongoStore.js";
export { SQLiteStore } from "./persistence/SQLiteStore.js";
export type { SqliteDatabase, SqliteStatement, SQLiteStoreOptions } from "./persistence/SQLiteStore.js";
export { OpenSearchStore } from "./persistence/OpenSearchStore.js";
export type { OpenSearchClient, OpenSearchStoreOptions } from "./persistence/OpenSearchStore.js";

// Providers
export { GeminiProvider } from "./providers/GeminiProvider.js";
export type { GeminiProviderOptions } from "./providers/GeminiProvider.js";
export { OpenAIProvider } from "./providers/OpenAIProvider.js";
export type { OpenAIProviderOptions } from "./providers/OpenAIProvider.js";
export { OpenRouterProvider } from "./providers/OpenRouterProvider.js";
export type { OpenRouterProviderOptions } from "./providers/OpenRouterProvider.js";
export { ZaiProvider } from "./providers/ZaiProvider.js";
export type { ZaiProviderOptions } from "./providers/ZaiProvider.js";
export { AnthropicProvider } from "./providers/AnthropicProvider.js";
export type { AnthropicProviderOptions } from "./providers/AnthropicProvider.js";
export { DeepSeekProvider } from "./providers/DeepSeekProvider.js";
export type { DeepSeekProviderOptions } from "./providers/DeepSeekProvider.js";
export { FallbackAiProvider } from "./providers/FallbackAiProvider.js";
export type { FallbackAiProviderOptions } from "./providers/FallbackAiProvider.js";
// Base class for building OpenAI-compatible providers (Groq, Together, etc.)
export { OpenAICompatibleProvider } from "./providers/OpenAICompatibleProvider.js";
export type {
  JsonWithTools,
  OpenAICompatibleProviderInit,
  StructuredOutputMode,
} from "./providers/OpenAICompatibleProvider.js";
export { createOpenAICompatibleProvider } from "./providers/GenericOpenAICompatibleProvider.js";
export type { OpenAICompatibleOptions } from "./providers/GenericOpenAICompatibleProvider.js";
// The bridge every provider above is built on — subclass it to bind any
// `@providerkit/core` provider to this framework's seam.
export { ProviderAdapter, resolveRetryConfig } from "./providers/ProviderAdapter.js";
// The probe's own shapes, re-exported so a consumer reading `probeJsonWithTools`
// off a provider does not have to add `@providerkit/core` to see its result.
export type { JsonWithToolsProbe, ProbeOptions } from "@providerkit/core";
export type {
  ProviderAdapterInit,
  RequestConfig,
  RetryConfig,
} from "./providers/ProviderAdapter.js";

// History helpers
export {
  assistantMessage,
  eventsToHistory,
  eventToHistoryItem,
  historyItemToEvent,
  historyToEvents,
  systemMessage,
  toolMessage,
  userMessage,
} from "./utils/history.js";

// Types
export type {
  Action,
  ActionCtx,
  ActionMap,
  ActionResult,
  AgentCompactionConfig,
  AgentOptions,
  AgentStructuredResponse,
  AiProvider,
  AssistantHistoryItem,
  Branch,
  BusinessHours,
  Clock,
  CompactionOptions,
  CompactionResult,
  Condition,
  ConditionMap,
  ConditionSpec,
  DoStep,
  Duration,
  EmittedEvent,
  EndReason,
  Event,
  EventDef,
  EventMap,
  EventToolResult,
  FieldDef,
  FieldDefs,
  Flow,
  GenerateMessageInput,
  GenerateMessageOutput,
  TokenUsage,
  GenerateMessageStreamChunk,
  History,
  HistoryItem,
  Idle,
  IfStep,
  InferData,
  InferParams,
  Instruction,
  MessageEventData,
  Next,
  OutboundMessage,
  ParamDef,
  ParamDefs,
  Participant,
  PendingWakesInput,
  Pred,
  PredCtx,
  ProviderCapabilities,
  ReasoningConfig,
  Repeat,
  Role,
  Run,
  RunStatus,
  SayStep,
  ScalarDef,
  ScalarType,
  ScheduleEntry,
  Session,
  Silenced,
  StatusEventData,
  Step,
  StepBase,
  StepOutcome,
  StepOutcomeCode,
  StepOutcomeKind,
  StepOutcomeStatus,
  Store,
  StructuredSchema,
  SystemHistoryItem,
  TalkStep,
  Template,
  Tool,
  ToolCall,
  ToolCtx,
  ToolEventData,
  ToolHistoryItem,
  ToolPermissionResult,
  ToolResult,
  ToolValidationResult,
  Trigger,
  TriggerKind,
  TurnBase,
  TurnInput,
  TurnKind,
  TurnResult,
  TurnStreamChunk,
  UserHistoryItem,
  WaitEventStep,
  WaitStep,
} from "./types/index.js";
export { EventKind, MessageRole } from "./types/index.js";
