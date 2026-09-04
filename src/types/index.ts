/**
 * Central type definitions export
 */

// Agent types
export type {
  AgentOptions,
  AgentCompactionConfig,
  Term,
  Instruction,
  ScopedInstructions,
  AppliedInstruction,
  AgentResponseStreamChunk,
  AgentResponse,
  EndedFlow,
  ContextLifecycleHooks,
  ContextProvider,
  ValidationError,
  ValidationResult,
  HookContext,
  ExitReason,
} from "./agent.js";

// History types
export type {
  Event,
  EmittedEvent,
  MessageEventData,
  ToolEventData,
  StatusEventData,
  Participant,
  ToolResult as EventToolResult,
  ToolCall,
  HistoryMessage,
  Role,
  HistoryItem,
  History,
  UserHistoryItem,
  AssistantHistoryItem,
  SystemHistoryItem,
  ToolHistoryItem,
} from "./history.js";
export { EventKind, MessageRole } from "./history.js";

// Flow types
export type {
  FlowOptions,
  FlowRef,
  StepRef,
  StepOptions,
  FlowLifecycleHooks,
  StepLifecycleHooks,
  Directive,
  BranchEntry,
  BranchMap,
  BranchPredicate,
  BranchPredicateContext,
  ConditionPredicate,
  ConditionIf,
  ConditionWhen,
  StoppedReason,
  PrepareResult,
} from "./flow.js";

// Session types
export type { SessionState } from "./session.js";

// Signals types (canonical source)
export type {
  Signal,
  SignalContext,
  SignalDirective,
  ResolvedSignalDirective,
  SignalPredicate,
  SignalPredicateContext,
  SignalFiring,
  SignalSchema,
  SignalsState,
  SignalTriggerState,
} from "./signals.js";

// Tool types
export type {
  Tool,
  ToolContext,
  ToolResult,
  ToolHandler,
  ToolExecutionResult,
  ToolValidationResult,
  ToolPermissionResult,
  ToolCallRequest,
  ToolExecutionUpdate,
  TrackedTool,
  ToolStatus,
  DataEnrichmentConfig,
  ValidationConfig,
  ApiCallConfig,
  ComputationConfig
} from "./tool.js";
export { ToolScope } from "./tool.js";

// Compaction types
export type {
  CompactionOptions,
  CompactionResult,
} from "./compaction.js";

// Prompt cache types
export type {
  PromptSectionType,
  PromptCacheConfig,
  SectionCompute,
} from "./prompt-cache.js";

// AI provider types
export type {
  AiProvider,
  GenerateMessageInput,
  GenerateMessageOutput,
  AgentStructuredResponse,
  ReasoningConfig,
  GenerateMessageStreamChunk,
  ProviderCapabilities,
} from "./ai.js";

// Schema types
export type { StructuredSchema } from "./schema.js";

// Persistence types
export type {
  SessionData,
  MessageData,
  SessionStatus,
  SessionRepository,
  MessageRepository,
  PersistenceAdapter,
  PersistenceConfig,
  CreateSessionOptions,
  CreateSessionData,
  SaveMessageOptions,
  CollectedStateData,
  SessionUpdateOptions,
} from "./persistence.js";

// Template types
export type {
  Template,
  TemplateContext,
  ConditionEvaluationResult
} from "./template.js";

// Error types
export { NotImplementedError, SessionConflictError, ProviderError } from "./errors.js";
export type { ErrorKind } from "./errors.js";

// Internal — ConditionTemplate is NOT exported from the public surface in v2.
// It remains internally for the condition evaluator utility.

export {
  ConditionEvaluator,
  createConditionEvaluator,
  extractAIContextStrings,
  hasProgrammaticConditions
} from "../utils/condition.js";
