/**
 * Utility functions and helpers
 */

export { cloneDeep } from "./clone.js";
export { assertUsableCompletion, effectiveMessageText } from "./completion.js";
export {
  assistantMessage,
  eventsToHistory,
  eventToHistoryItem,
  historyItemToEvent,
  historyToEvents,
  systemMessage,
  toolMessage,
  userMessage,
} from "./history.js";
export { extractEmbeddedJSONObject, isJSONShaped, parseJSONResponse, tryParseJSONResponse } from "./json.js";
export { logger, LoggerLevel } from "./logger.js";
