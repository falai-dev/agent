/**
 * Utility functions and helpers
 */

// ID generation
export {
  generateRouteId,
  generateStepId,
  generateToolId,
  generateInlineToolId,
} from "./id";

// Session management
export {
  createSession,
  createSessionId,
  enterRoute,
  enterStep,
  mergeCollected,
  sessionStepToData,
  sessionDataToStep,
} from "./session";

// Template rendering
export {
  render,
  renderMany,
  renderTemplate,
  renderTemplateObject,
  formatKnowledgeBase,
} from "./template";

// Cloning utilities
export { cloneDeep } from "./clone";

// Event utilities
export { getLastMessageFromHistory } from "./event";

// History utilities
export {
  normalizeHistory,
  userMessage,
  assistantMessage,
  toolMessage,
  systemMessage,
} from "./history";

// Logging
export { LoggerLevel, logger } from "./logger";

// Retry utilities
export type { RetryOptions } from "./retry";
export { retry, withTimeoutAndRetry } from "./retry";
