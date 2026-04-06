/**
 * Central type definitions export
 */

// Agent types
export type {
  AgentOptions,
  AgentCompactionConfig,
  Term,
  Guideline,
  GuidelineMatch,
  AgentResponseStreamChunk,
  AgentResponse,
  ContextLifecycleHooks,
  ContextProvider,
  ValidationError,
  ValidationResult,
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

// Route types
export type {
  RouteOptions,
  RouteRef,
  StepRef,
  StepOptions,
  BranchSpec,
  StepResult,
  BranchResult,
  RouteCompletionHandler,
  RouteTransitionConfig,
  RouteLifecycleHooks,
} from "./route";
export * from "./route";

// Session types
export type { SessionState, PendingTransition } from "./session";

// Tool types
export type {
  Tool,
  ToolContext,
  ToolResult,
  ToolHandler,
  ToolExecutionResult,
  EnhancedTool,
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
  ConditionTemplate,
  ConditionEvaluationResult
} from "./template";
export {
  ConditionEvaluator,
  createConditionEvaluator,
  extractAIContextStrings,
  hasProgrammaticConditions
} from "../utils/condition";
