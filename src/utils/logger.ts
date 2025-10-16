import log from "loglevel";

export enum LoggerLevel {
  DEBUG = "debug",
  INFO = "info",
  WARN = "warn",
  ERROR = "error",
  SILENT = "silent",
}

/**
 * Default log level
 */
const DEFAULT_LOG_LEVEL = LoggerLevel.SILENT;

// Initialize logger
log.setLevel(DEFAULT_LOG_LEVEL);

export const logger = log;
