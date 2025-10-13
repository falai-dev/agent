/**
 * @falai/agent - Standalone AI Agent framework
 *
 * A strongly-typed, modular agent framework with route DSL and AI provider strategy
 */

// Core
export { Agent } from "./core/Agent";
export { Route } from "./core/Route";
export { State } from "./core/State";
export { Transition } from "./core/Transition";
export { Observation } from "./core/Observation";
export { defineTool } from "./core/Tool";
export { DomainRegistry } from "./core/DomainRegistry";
export { adaptEvent, createMessageEvent, createToolEvent } from "./core/Events";
export { PromptBuilder } from "./core/PromptBuilder";
export type { Customer, AgentInfo } from "./core/PromptBuilder";
export { BuiltInSection } from "./core/PromptBuilder";

// Providers
export { GeminiProvider } from "./providers/GeminiProvider";
export type { GeminiProviderOptions } from "./providers/GeminiProvider";
export { OpenAIProvider } from "./providers/OpenAIProvider";
export type { OpenAIProviderOptions } from "./providers/OpenAIProvider";
export { OpenRouterProvider } from "./providers/OpenRouterProvider";
export type { OpenRouterProviderOptions } from "./providers/OpenRouterProvider";

// Constants
export { END_ROUTE } from "./constants";

// Types
export type {
  AgentOptions,
  Term,
  Guideline,
  Capability,
  GuidelineMatch,
} from "@/types/agent";
export { CompositionMode } from "@/types/agent";

export type {
  Event,
  EmittedEvent,
  MessageEventData,
  ToolEventData,
  StatusEventData,
  Participant,
} from "@/types/history";
export { EventKind, EventSource } from "@/types/history";

export type {
  RouteRef,
  StateRef,
  RouteOptions,
  TransitionSpec,
  TransitionResult,
} from "@/types/route";

export type {
  ToolContext,
  ToolResult,
  ToolHandler,
  ToolRef,
} from "@/types/tool";

export type {
  AiProvider,
  GenerateMessageInput,
  GenerateMessageOutput,
  AgentStructuredResponse,
  ReasoningConfig,
} from "@/types/ai";

export type {
  PromptSection,
  ContextVariable,
  ContextVariableValue,
} from "@/types/prompt";
export { SectionStatus } from "@/types/prompt";

export type {
  Observation as IObservation,
  ObservationOptions,
} from "@/types/observation";
