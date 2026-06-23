/**
 * Utility functions and helpers
 */

// ID generation
export {
  generateFlowId,
  generateStepId,
  generateToolId,
  generateInlineToolId,
  generateSignalId,
} from "./id";

// Session management
export {
  createSession,
  createSessionId,
  createPersistedState,
  enterFlow,
  enterStep,
  completeCurrentFlow,
  isFlowCompletedThisSession,
  mergeCollected,
  sessionStepToData,
  sessionDataToStep,
} from "./session";

// Template rendering
export {
  render,
  renderMany,
  formatKnowledgeBase,
  createTemplateContext,
} from "./template";

// Cloning utilities
export { cloneDeep } from "./clone";

// Event utilities
export { getLastMessageFromHistory } from "./event";

// History utilities
export {
  historyItemToEvent,
  historyToEvents,
  eventToHistoryItem,
  eventsToHistory,
  userMessage,
  assistantMessage,
  toolMessage,
  systemMessage,
} from "./history";

// Logging
export { LoggerLevel, logger } from "./logger";

// Retry utilities
export type { RetryOptions, StreamRetryOptions, RetryConfig } from "./retry";
export { retry, withTimeoutAndRetry, withStreamRetry, resolveRetryConfig, combineAbortSignals } from "./retry";

// Completion helpers
export { effectiveMessageText, assertUsableCompletion } from "./completion";

// Condition utilities
export {
  ConditionEvaluator,
  createConditionEvaluator,
  extractAIContextStrings,
  hasProgrammaticConditions,
} from "./condition";

// JSON utilities
export { parseJSONResponse, tryParseJSONResponse } from "./json";

// Serialization utilities
export { serializeToolResult } from "./serialize";
