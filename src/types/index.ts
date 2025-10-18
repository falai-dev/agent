/**
 * Central type definitions export
 */

// Agent types
export type {
  AgentOptions,
  Term,
  Guideline,
  Capability,
  GuidelineMatch,
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
} from "./history";
export { EventKind, EventSource } from "./history";

// Route types
export type {
  RouteOptions,
  RouteRef,
  StepRef,
  StepOptions,
  StepResult,
  RouteCompletionHandler,
  RouteTransitionConfig,
} from "./route";

// Tool types
export type { ToolRef, ToolContext, ToolResult } from "./tool";

// AI provider types
export type {
  AiProvider,
  GenerateMessageInput,
  GenerateMessageOutput,
} from "./ai";

// Persistence types
export type {
  SessionData,
  MessageData,
  SessionStatus,
  MessageRole,
  SessionRepository,
  MessageRepository,
  PersistenceAdapter,
  PersistenceConfig,
  CreateSessionOptions,
  SaveMessageOptions,
} from "./persistence";

// Template types
export type { Template, TemplateContext } from "./template";
