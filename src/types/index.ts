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
  ContextLifecycleHooks,
  ContextProvider,
  ValidationError,
  ValidationResult,
  HookContext,
  ExitReason,
} from "./agent";
export { CompositionMode } from "./agent";

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
} from "./history";
export { EventKind, MessageRole } from "./history";
export * from "./history";

// Flow types
export type {
  FlowOptions,
  FlowRef,
  StepRef,
  StepOptions,
  FlowLifecycleHooks,
  StepLifecycleHooks,
  Directive,
  PreDirective,
  BranchEntry,
  BranchMap,
  BranchPredicate,
  BranchPredicateContext,
  ConditionPredicate,
  ConditionIf,
  ConditionWhen,
  StoppedReason,
  PrepareResult,
} from "./flow";

// Session types
export type { SessionState } from "./session";

// Signals types (canonical source)
export type {
  Signal,
  SignalContext,
  SignalDirective,
  SignalPredicate,
  SignalPredicateContext,
  SignalFiring,
  SignalSchema,
  SignalsState,
  SignalTriggerState,
} from "./signals";

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
} from "./tool";
export { ToolScope } from "./tool";

// Compaction types
export type {
  CompactionOptions,
  CompactionResult,
} from "./compaction";

// Prompt cache types (re-exported from core)
export type {
  PromptSectionType,
  PromptCacheConfig,
  SectionCompute,
} from "../core/PromptSectionCache";

// AI provider types
export type {
  AiProvider,
  GenerateMessageInput,
  GenerateMessageOutput,
  AgentStructuredResponse,
  ReasoningConfig,
  GenerateMessageStreamChunk,
} from "./ai";

// Schema types
export type { StructuredSchema } from "./schema";

// Routing types
export type { RoutingDecision } from "./routing";
export * from "./routing";

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
} from "./persistence";
export * from "./persistence";

// Template types
export type {
  Template,
  TemplateContext,
  ConditionEvaluationResult
} from "./template";

// Error types
export { NotImplementedError } from "./errors";

// Internal — ConditionTemplate is NOT exported from the public surface in v2.
// It remains internally for the condition evaluator utility.

export {
  ConditionEvaluator,
  createConditionEvaluator,
  extractAIContextStrings,
  hasProgrammaticConditions
} from "../utils/condition";
