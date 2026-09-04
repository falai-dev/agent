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
} from "./id.js";

// Session management
export {
  createSession,
  createSessionId,
  boundConversationHistory,
  DEFAULT_MAX_HISTORY_MESSAGES,
  createPersistedState,
  restoreSession,
  enterFlow,
  enterStep,
  completeCurrentFlow,
  isFlowCompletedThisSession,
  mergeCollected,
  sessionStepToData,
  sessionDataToStep,
} from "./session.js";

// Template rendering
export {
  render,
  renderMany,
  formatKnowledgeBase,
  createTemplateContext,
} from "./template.js";

// Cloning utilities
export { cloneDeep } from "./clone.js";

// Event utilities
export { getLastMessageFromHistory } from "./event.js";

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
} from "./history.js";

// Logging
export { LoggerLevel, logger } from "./logger.js";

// Completion helpers
export { effectiveMessageText, assertUsableCompletion } from "./completion.js";

// Condition utilities
export {
  ConditionEvaluator,
  createConditionEvaluator,
  extractAIContextStrings,
  hasProgrammaticConditions,
} from "./condition.js";

// JSON utilities
export { parseJSONResponse, tryParseJSONResponse } from "./json.js";

// Serialization utilities
export { serializeToolResult, isToolResultLike, extractResultDirectives } from "./serialize.js";
