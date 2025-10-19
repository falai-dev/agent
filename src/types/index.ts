/**
 * Central type definitions export
 */

// Agent types
export type {
  AgentOptions,
  Term,
  Guideline,
  GuidelineMatch,
  ContextLifecycleHooks,
  ContextProvider,
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
} from "./history";
export { EventKind, MessageRole } from "./history";

// Route types
export type {
  RouteOptions,
  RouteRef,
  StepRef,
  StepOptions,
  StepResult,
  BranchSpec,
  BranchResult,
  RouteCompletionHandler,
  RouteTransitionConfig,
  RouteLifecycleHooks,
} from "./route";

// Session types
export type { SessionState, PendingTransition } from "./session";

// Tool types
export type { Tool, ToolContext, ToolResult, ToolHandler } from "./tool";

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
  SaveMessageOptions,
} from "./persistence";

// Template types
export type { Template, TemplateContext } from "./template";
