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
  RouteRef,
  StateRef,
  RouteOptions,
  TransitionSpec,
  TransitionResult,
} from "./route";

// Tool types
export type { ToolContext, ToolResult, ToolHandler, ToolRef } from "./tool";

// AI provider types
export type {
  AiProvider,
  GenerateMessageInput,
  GenerateMessageOutput,
} from "./ai";

// Prompt types
export type {
  PromptSection,
  ContextVariable,
  ContextVariableValue,
} from "./prompt";
export { SectionStatus } from "./prompt";

// Observation types
export type { Observation, ObservationOptions } from "./observation";

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
